import { Effect } from "effect"

import { MCP_PRESETS, getPresetDisplayName } from "../mcp/presets"
import { Redis } from "../infra/redis"
import { slackBot } from "../slack-bot"
import { resolveSlackWebClient } from "./web-client"

import type { WebClient } from "@slack/web-api"

const WELCOME_KEY_PREFIX = "pookie:welcome"

const welcomeKey = (teamId: string): string =>
  `${WELCOME_KEY_PREFIX}:${teamId}`

const hasSentWelcome = (teamId: string) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const value = yield* redis.get(welcomeKey(teamId))
    return Boolean(value)
  }).pipe(Effect.catchCause(() => Effect.succeed(false)))

const markWelcomeSent = (teamId: string) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    yield* redis.set(welcomeKey(teamId), "1")
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("[welcome] failed to persist welcome flag").pipe(
        Effect.annotateLogs({ error: String(cause) }),
      ),
    ),
  )

const popularPresetNames = Object.values(MCP_PRESETS)
  .filter((preset) => !preset.hiddenByDefault)
  .map((preset) => getPresetDisplayName(preset))
  .join(", ")

// First-install greeting: pookie introduces herself like a kitten poking its
// head out. No feature list, no help text wall -- per personality.md the hatch
// moment is deliberately quiet. Capabilities only surface when the user asks.
const HATCH_GREETING =
  "hi. i'm a pookie. i just moved in. try `/help` if you need me."

const SHORT_GREETING = "hey. tag me anytime. `/help` for more."

export const FULL_HELP_TEXT = [
  "hi. i'm a pookie -- a kitty that lives in your slack.",
  "",
  "@ me in any channel i'm in, or dm me directly. use `/invite @pookie` if i'm not in the channel yet.",
  "",
  "what i can do:",
  "\u2022 find threads, messages, files across slack",
  "\u2022 generate images, run code, search the web",
  `\u2022 plug into ${popularPresetNames}, and more via mcp`,
  "",
  "setup:",
  "\u2022 `/onboarding` -- connect tools",
  "\u2022 `/pookie-config` -- tweak my personality (cute | balanced | professional)",
  "\u2022 scope settings with `--channel` or `--global` (admin)",
  "",
  "privacy: i only see channels i've been invited to. no training, no cross-workspace data sharing.",
].join("\n")

const post = async (
  client: WebClient,
  channelId: string,
  text: string,
): Promise<void> => {
  await client.chat.postMessage({ channel: channelId, text })
}

export const welcomeOnBotChannelJoin = (
  teamId: string,
  channelId: string,
) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => slackBot.initialize())

    const client = yield* Effect.tryPromise(() => resolveSlackWebClient(teamId))
    if (!client) {
      yield* Effect.logWarning("[welcome] no bot token available for team", { teamId })
      return
    }

    const alreadyWelcomed = yield* hasSentWelcome(teamId)

    if (alreadyWelcomed) {
      yield* Effect.tryPromise(() => post(client, channelId, SHORT_GREETING))
      return
    }

    // Order matters: post first, mark second. If markWelcomeSent fails silently
    // (its catch swallows redis errors), the next channel-join sees no welcome
    // flag and re-posts HATCH_GREETING -- visible repeat. This is a known
    // low-probability race; resolving it properly needs an atomic SET-NX or a
    // contract change to markWelcomeSent. Flagged in launch.md.
    yield* Effect.tryPromise(() => post(client, channelId, HATCH_GREETING))
    yield* markWelcomeSent(teamId)
  })
