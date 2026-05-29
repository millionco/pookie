import { handleSlackMessage } from "./agent";
import { abortActiveRun } from "./agent/active-runs";
import { removeDeletedFollowUp } from "./agent/thread-lock";
import { resolveConfig } from "./config";
import { handlePookieConfigCommand } from "./config/handlers";
import {
  handleMcpAddCommand,
  handleMcpCommand,
  handleMcpListCommand,
  handleMcpPresetsCommand,
  handleMcpRemoveCommand,
  handleMcpStatusCommand,
} from "./mcp/handlers";
import { MCP_PRESETS } from "./mcp/presets";
import { redis } from "./mcp/redis";
import { slackBot } from "./slack-bot";
import { isSlackBotAddressed } from "./slack/message-routing";
import {
  handleOnboardingConnectAction,
  onboardingConnectActionIds,
} from "./slack/onboarding/connect-action";
import { handleOnboardingCommand } from "./slack/onboarding/handler";
import { autoStartOnboardingIfFirstInvite } from "./slack/onboarding/orchestrator";
import { extractSlackEventContext } from "./slack/schemas";
import { FULL_HELP_TEXT, welcomeOnBotChannelJoin } from "./slack/welcome";

import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message, Thread } from "chat";

export { slackBot };

const reactToNewThread = async (
  thread: Thread,
  message: Message,
): Promise<void> => {
  try {
    const slack: SlackAdapter = slackBot.getAdapter("slack");
    const { userId, channelId, teamId } = extractSlackEventContext(message.raw);
    const { config } = await resolveConfig({ teamId, userId, channelId });
    await slack.addReaction(thread.id, message.id, config.reactionEmoji);
  } catch (reactionError) {
    console.warn("[new-thread-reaction] failed", reactionError);
  }
};

const MCP_SLASH_COMMANDS = [
  { command: "/mcp", handler: handleMcpCommand },
  { command: "/mcp-add", handler: handleMcpAddCommand },
  { command: "/mcp-list", handler: handleMcpListCommand },
  { command: "/mcp-presets", handler: handleMcpPresetsCommand },
  { command: "/mcp-remove", handler: handleMcpRemoveCommand },
  { command: "/mcp-status", handler: handleMcpStatusCommand },
] as const;

for (const { command, handler } of MCP_SLASH_COMMANDS) {
  slackBot.onSlashCommand(command, async (event) => {
    try {
      await handler(event);
    } catch (error) {
      console.error(`[${command}]`, error);
      await event.channel.postEphemeral(
        event.user,
        `something went wrong running ${command}. give it another try, or email founders@million.dev if it keeps failing.`,
        { fallbackToDM: true },
      );
    }
  });
}

slackBot.onSlashCommand("/help", async (event) => {
  try {
    await event.channel.postEphemeral(event.user, FULL_HELP_TEXT, {
      fallbackToDM: true,
    });
  } catch (error) {
    console.error("[help-command]", error);
  }
});

slackBot.onSlashCommand("/onboarding", async (event) => {
  try {
    await handleOnboardingCommand(event);
  } catch (error) {
    console.error("[onboarding-command]", error);
    await event.channel.postEphemeral(
      event.user,
      "something went wrong starting onboarding. check the logs.",
      { fallbackToDM: true },
    );
  }
});

const visiblePresetNames = Object.values(MCP_PRESETS)
  .filter((preset) => !preset.hiddenByDefault && preset.authType !== "token")
  .map((preset) => preset.name);

slackBot.onAction(
  onboardingConnectActionIds(visiblePresetNames),
  async (event) => {
    try {
      await handleOnboardingConnectAction(event);
    } catch (error) {
      console.error("[onboarding-connect-action]", error);
    }
  },
);

slackBot.onSlashCommand("/pookie-config", async (event) => {
  try {
    await handlePookieConfigCommand(event);
  } catch (error) {
    console.error("[pookie-config]", error);
    await event.channel.postEphemeral(
      event.user,
      "something went wrong running the /pookie-config command. check the logs.",
      { fallbackToDM: true },
    );
  }
});

slackBot.onAssistantThreadStarted(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    {
      title: "Summarize this channel",
      message: "Can you summarize the recent activity in this channel?",
    },
    {
      title: "Search the workspace",
      message: "Search the workspace for recent discussions about ...",
    },
  ]);
});

slackBot.onAssistantContextChanged(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    {
      title: "Summarize this channel",
      message: "Can you summarize the recent activity in this channel?",
    },
    {
      title: "Search the workspace",
      message: "Search the workspace for recent discussions about ...",
    },
  ]);
});

slackBot.onMemberJoinedChannel(async (event) => {
  const slack: SlackAdapter = slackBot.getAdapter("slack");
  if (event.userId !== slack.botUserId) return;

  const { channel } = slack.decodeThreadId(event.channelId);
  const teamId = event.teamId;
  if (!teamId) return;

  void welcomeOnBotChannelJoin(teamId, channel).catch((error: unknown) =>
    console.error("[welcome] failed", error),
  );

  if (event.inviterId) {
    void autoStartOnboardingIfFirstInvite(
      teamId,
      event.inviterId,
      channel,
    ).catch((error: unknown) =>
      console.error("[onboarding] auto-trigger failed", error),
    );
  }
});

slackBot.onMessageDeleted((event) => {
  abortActiveRun(event.channelId, event.deletedTs);
  removeDeletedFollowUp(redis, event.channelId, event.deletedTs).catch(
    (removeError: unknown) =>
      console.warn("[message-deleted] follow-up removal failed", removeError),
  );
});

slackBot.onDirectMessage(async (thread, message, _channel, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return;

  await thread.subscribe();
  await handleSlackMessage(thread, message, context?.skipped);
});

slackBot.onNewMention(async (thread, message, context) => {
  await thread.subscribe();
  // Fire-and-forget: the reaction is decorative and does its own redis
  // lookups to resolve the configured emoji. Awaiting it adds those
  // round-trips to the critical path in front of handleSlackMessage,
  // which does its own config resolution anyway. Errors are already
  // swallowed inside reactToNewThread.
  void reactToNewThread(thread, message);
  await handleSlackMessage(thread, message, context?.skipped);
});

// Once pookie is subscribed to a thread (set by onNewMention /
// onDirectMessage / the catch-all below), the SDK routes every follow-up
// here — including non-mention replies. We deliberately ignore non-mention
// follow-ups: pookie only speaks when it is explicitly @-mentioned, so a
// plain reply in a subscribed thread is two humans talking, not a request
// for pookie. The thread stays subscribed so the next @-mention still lands
// here. Bot/self messages are filtered to prevent reply loops.
slackBot.onSubscribedMessage(async (thread, message, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return;

  const slack: SlackAdapter = slackBot.getAdapter("slack");
  if (!isSlackBotAddressed(message, slack.botUserId)) return;

  await thread.refresh();
  await handleSlackMessage(thread, message, context?.skipped);
});

// Catch-all for @mentions the typed handlers miss:
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
// Non-mention messages are ignored — pookie requires an explicit @-mention.
slackBot.onNewMessage(/.*/, async (thread, message, context) => {
  if (message?.author?.isMe || message?.author?.isBot === true) return;

  const slack: SlackAdapter = slackBot.getAdapter("slack");
  if (!isSlackBotAddressed(message, slack.botUserId)) return;

  await thread.subscribe();
  void reactToNewThread(thread, message);
  await handleSlackMessage(thread, message, context?.skipped);
});
