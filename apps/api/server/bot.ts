import { Effect } from "effect"

import { handleSlackMessage } from "./agent"
import { ActiveRuns } from "./agent/active-runs"
import { ThreadLock } from "./agent/thread-lock"
import { resolveConfig } from "./config"
import { handlePookieConfigCommand } from "./config/handlers"
import {
  handleMcpAddCommand,
  handleMcpCommand,
  handleMcpListCommand,
  handleMcpPresetsCommand,
  handleMcpRemoveCommand,
  handleMcpStatusCommand,
} from "./mcp/handlers"
import { MCP_PRESETS } from "./mcp/presets"
import { appRuntime } from "./runtime"
import { slackBot } from "./slack-bot"
import {
  hasBotParticipatedInThread,
  hasSlackBotMention,
  isTopLevelSlackMessage,
} from "./slack/message-routing"
import {
  handleOnboardingConnectAction,
  onboardingConnectActionIds,
} from "./slack/onboarding/connect-action"
import { handleOnboardingCommand } from "./slack/onboarding/handler"
import { autoStartOnboardingIfFirstInvite } from "./slack/onboarding/orchestrator"
import { extractSlackEventContext } from "./slack/schemas"
import { FULL_HELP_TEXT, welcomeOnBotChannelJoin } from "./slack/welcome"

import type { SlackAdapter } from "@chat-adapter/slack"
import type { Message, Thread } from "chat"

import type { SlackMessageRaw } from "./slack/message-routing"

export { slackBot }

const reactToNewThread = async (
  thread: Thread,
  message: Message,
): Promise<void> => {
  try {
    const slack: SlackAdapter = slackBot.getAdapter("slack")
    const { userId, channelId, teamId } = extractSlackEventContext(message.raw)
    const { config } = await appRuntime.runPromise(
      resolveConfig({ teamId, userId, channelId }),
    )
    await slack.addReaction(thread.id, message.id, config.reactionEmoji)
  } catch (reactionError) {
    console.warn("[new-thread-reaction] failed", reactionError)
  }
}

const subscribeForFallback = async (
  thread: Thread,
  logPrefix: string,
): Promise<void> => {
  await thread
    .subscribe()
    .catch((subscribeError: unknown) =>
      console.warn(`${logPrefix} subscribe failed`, subscribeError),
    )
}

const MCP_SLASH_COMMANDS = [
  { command: "/mcp", handler: handleMcpCommand },
  { command: "/mcp-add", handler: handleMcpAddCommand },
  { command: "/mcp-list", handler: handleMcpListCommand },
  { command: "/mcp-presets", handler: handleMcpPresetsCommand },
  { command: "/mcp-remove", handler: handleMcpRemoveCommand },
  { command: "/mcp-status", handler: handleMcpStatusCommand },
] as const

for (const { command, handler } of MCP_SLASH_COMMANDS) {
  slackBot.onSlashCommand(command, async (event) => {
    try {
      await handler(event)
    } catch (error) {
      console.error(`[${command}]`, error)
      await event.channel.postEphemeral(
        event.user,
        `something went wrong running ${command}. give it another try, or email founders@million.dev if it keeps failing.`,
        { fallbackToDM: true },
      )
    }
  })
}

slackBot.onSlashCommand("/help", async (event) => {
  try {
    await event.channel.postEphemeral(event.user, FULL_HELP_TEXT, {
      fallbackToDM: true,
    })
  } catch (error) {
    console.error("[help-command]", error)
  }
})

slackBot.onSlashCommand("/onboarding", async (event) => {
  try {
    await handleOnboardingCommand(event)
  } catch (error) {
    console.error("[onboarding-command]", error)
    await event.channel.postEphemeral(
      event.user,
      "something went wrong starting onboarding. check the logs.",
      { fallbackToDM: true },
    )
  }
})

const visiblePresetNames = Object.values(MCP_PRESETS)
  .filter((preset) => !preset.hiddenByDefault && preset.authType !== "token")
  .map((preset) => preset.name)

slackBot.onAction(
  onboardingConnectActionIds(visiblePresetNames),
  async (event) => {
    try {
      await handleOnboardingConnectAction(event)
    } catch (error) {
      console.error("[onboarding-connect-action]", error)
    }
  },
)

slackBot.onSlashCommand("/pookie-config", async (event) => {
  try {
    await handlePookieConfigCommand(event)
  } catch (error) {
    console.error("[pookie-config]", error)
    await event.channel.postEphemeral(
      event.user,
      "something went wrong running the /pookie-config command. check the logs.",
      { fallbackToDM: true },
    )
  }
})

slackBot.onAssistantThreadStarted(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack")
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    {
      title: "Summarize this channel",
      message: "Can you summarize the recent activity in this channel?",
    },
    {
      title: "Search the workspace",
      message: "Search the workspace for recent discussions about ...",
    },
  ])
})

slackBot.onAssistantContextChanged(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack")
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    {
      title: "Summarize this channel",
      message: "Can you summarize the recent activity in this channel?",
    },
    {
      title: "Search the workspace",
      message: "Search the workspace for recent discussions about ...",
    },
  ])
})

slackBot.onMemberJoinedChannel(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack")
  if (event.userId !== slack.botUserId) return

  const { channel } = slack.decodeThreadId(event.channelId)
  const teamId = event.teamId
  if (!teamId) return

  void appRuntime
    .runPromise(welcomeOnBotChannelJoin(teamId, channel))
    .catch((error: unknown) => console.error("[welcome] failed", error))

  if (event.inviterId) {
    void autoStartOnboardingIfFirstInvite(
      teamId,
      event.inviterId,
      channel,
    ).catch((error: unknown) =>
      console.error("[onboarding] auto-trigger failed", error),
    )
  }
})

slackBot.onMessageDeleted((event) => {
  appRuntime
    .runPromise(
      Effect.gen(function* () {
        const activeRuns = yield* ActiveRuns
        yield* activeRuns.abort(event.channelId, event.deletedTs)
      }),
    )
    .catch(() => {})

  appRuntime
    .runPromise(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        yield* threadLock.removeDeletedFollowUp(
          event.channelId,
          event.deletedTs,
        )
      }),
    )
    .catch((removeError: unknown) =>
      console.warn(
        "[message-deleted] follow-up removal failed",
        removeError,
      ),
    )
})

slackBot.onDirectMessage(async (thread, message, _channel, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return

  await thread.subscribe()
  await appRuntime.runPromise(
    handleSlackMessage(thread, message, context?.skipped),
  )
})

slackBot.onNewMention(async (thread, message, context) => {
  await thread.subscribe()
  // Fire-and-forget: the reaction is decorative and does its own redis
  // lookups to resolve the configured emoji. Awaiting it adds those
  // round-trips to the critical path in front of handleSlackMessage,
  // which does its own config resolution anyway. Errors are already
  // swallowed inside reactToNewThread.
  void reactToNewThread(thread, message)
  await appRuntime.runPromise(
    handleSlackMessage(thread, message, context?.skipped),
  )
})

// Once pookie is subscribed to a thread (set by onNewMention /
// onDirectMessage / the catch-all below), the SDK routes every follow-up
// here — including non-mention replies. We answer them all: the bot only
// gets subscribed because it was explicitly engaged, so a human follow-up
// in this thread is by definition someone continuing the conversation.
// Bot/self messages are still filtered to prevent reply loops.
slackBot.onSubscribedMessage(async (thread, message, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return

  await thread.refresh()
  await appRuntime.runPromise(
    handleSlackMessage(thread, message, context?.skipped),
  )
})

// Catch-all for three cases the typed handlers miss:
//
// 1. Channel @mentions where Slack's `message` event wins the dedupe race
//    against `app_mention`. Both events share the same ts; the SDK dedupes
//    by ts so only the first one through is processed. When `message` wins,
//    isMention is false and onNewMention never fires.
//
// 2. Thread @mentions where the parent message never mentioned the bot.
//    The SDK only fires onNewMention for top-level mentions; a first-time
//    @mention inside a thread the bot hasn't joined yet needs explicit
//    handling here.
//
// 3. Thread follow-ups where subscribe() didn't persist (e.g. Redis eviction).
slackBot.onNewMessage(/.*/, async (thread, message, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return

  const raw = message?.raw as SlackMessageRaw | undefined
  const slack: SlackAdapter = slackBot.getAdapter("slack")
  const hasBotMention = hasSlackBotMention(raw?.text, slack.botUserId)

  if (isTopLevelSlackMessage(raw)) {
    if (!hasBotMention) return

    await thread.subscribe()
    void reactToNewThread(thread, message)
    await appRuntime.runPromise(
      handleSlackMessage(thread, message, context?.skipped),
    )
    return
  }

  if (hasBotMention) {
    await thread.subscribe()
    void reactToNewThread(thread, message)
    await appRuntime.runPromise(
      handleSlackMessage(thread, message, context?.skipped),
    )
    return
  }

  await thread.refresh()

  if (!hasBotParticipatedInThread(thread.recentMessages, slack.botUserId))
    return

  await subscribeForFallback(thread, "[thread-followup-fallback]")
  await appRuntime.runPromise(
    handleSlackMessage(thread, message, context?.skipped),
  )
})
