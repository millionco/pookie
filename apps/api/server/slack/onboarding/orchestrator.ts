import {
  MCP_PRESETS,
  getPresetDisplayName,
  resolvePreset,
} from "../../mcp/presets"
import { listVisibleServersAsync, loadOAuthTokensAsync } from "../../mcp/store"
import { slackBot } from "../../slack-bot"
import { resolveSlackWebClient } from "../web-client"
import { buildOnboardingCards } from "./cards-builder"
import {
  isWithinOnboardingWindow,
  loadOnboardingState,
  saveOnboardingState,
} from "./state"
import { appRuntime } from "../../runtime"

// Derives the set of preset names the user has already connected by checking
// every MCP config visible to them (global + user-scoped + channel-scoped,
// same surface as `/mcp-list`). A config alone isn't enough — we verify the
// server has auth credentials (a PAT on the config, or OAuth tokens for this
// user) so servers stuck in "needs reauthorization" don't show a false ✅.
const resolveConnectedPresetNames = async (
  userId: string,
  channelId: string,
  teamId: string,
): Promise<string[]> => {
  const visibleServers = await listVisibleServersAsync(userId, channelId, teamId)
  const names = new Set<string>()
  for (const server of visibleServers) {
    const preset = resolvePreset(server.name)
    if (!preset) continue

    const hasDirectToken = Boolean(server.token)
    const oauthTokens = await loadOAuthTokensAsync(userId, server.name, teamId)
    if (hasDirectToken || oauthTokens) {
      names.add(preset.name)
    }
  }
  return [...names]
}

const onboardingPresets = () =>
  Object.values(MCP_PRESETS).filter(
    (preset) => !preset.hiddenByDefault && preset.authType !== "token",
  )

export const startOnboarding = async (
  teamId: string,
  userId: string,
  channelId: string,
): Promise<void> => {
  await slackBot.initialize()

  const client = await resolveSlackWebClient(teamId)
  if (!client) {
    console.warn("[onboarding] no bot token available for team", teamId)
    return
  }

  const connectedPresets = await resolveConnectedPresetNames(
    userId,
    channelId,
    teamId,
  )

  const cards = buildOnboardingCards({
    presets: onboardingPresets(),
    connectedPresets,
  })

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: cards.text,
    blocks: cards.blocks,
  })

  await appRuntime.runPromise(
    saveOnboardingState(userId, {
      startedAt: Date.now(),
      teamId,
      channelId,
      connectedPresets,
    }),
  )
}

export const autoStartOnboardingIfFirstInvite = async (
  teamId: string,
  userId: string,
  channelId: string,
): Promise<void> => {
  const existing = await appRuntime.runPromise(loadOnboardingState(userId))
  if (existing) return
  await startOnboarding(teamId, userId, channelId)
}

// Fired from the MCP OAuth callback. Inside the onboarding window, we post
// a fresh ephemeral confirmation in the user's onboarding channel so they
// see the connect succeeded without us having to update the original
// ephemeral (we can't — the grid uses mrkdwn link clicks, not block buttons,
// so Slack never gives us a response_url to replace_original with). Outside
// the window — or if no onboarding state exists — this is a no-op so OAuth
// callbacks unrelated to onboarding behave exactly as they did pre-feature.
export const applyOnboardingConnection = async (
  userId: string,
  serverName: string,
): Promise<void> => {
  const state = await appRuntime.runPromise(loadOnboardingState(userId))
  if (!state) return
  if (!isWithinOnboardingWindow(state, Date.now())) return

  const preset = resolvePreset(serverName)
  if (!preset) return

  const connectedPresets = state.connectedPresets.includes(preset.name)
    ? state.connectedPresets
    : [...state.connectedPresets, preset.name]

  await appRuntime.runPromise(
    saveOnboardingState(userId, { ...state, connectedPresets }),
  )

  const client = await resolveSlackWebClient(state.teamId)
  if (!client) {
    console.warn("[onboarding] no bot token available for team", state.teamId)
    return
  }

  const displayName = getPresetDisplayName(preset)
  // Surfaces the freshly-connected preset's example queries inline so users
  // see concrete things they can ask the second OAuth completes, not a bare
  // "connected" confirmation.
  const exampleQueryLines = preset.exampleQueries.map(
    (exampleQuery) => `• _${exampleQuery}_`,
  )
  const followUpLines = [
    `:white_check_mark: *${displayName}* connected.`,
    ...(exampleQueryLines.length > 0 ? ["", "try:", ...exampleQueryLines] : []),
    "",
    "run `/onboarding` to add more.",
  ]
  await client.chat.postEphemeral({
    channel: state.channelId,
    user: userId,
    text: `${displayName} connected`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: followUpLines.join("\n"),
        },
      },
    ],
  })
}
