import type { SlackIncomingMessageEvent } from "./types";

export interface SlackMessageRaw extends Pick<
  SlackIncomingMessageEvent,
  "text" | "thread_ts" | "ts"
> {}

export interface SlackAddressableMessage {
  isMention?: boolean;
  raw?: unknown;
}

export const hasSlackBotMention = (
  text: string | undefined,
  botUserId: string | undefined,
): boolean => Boolean(botUserId && text?.includes(`<@${botUserId}>`));

// The SDK only sets message.isMention=true for events whose literal type is
// "app_mention". Slack fans out both `app_mention` and `message` for every
// @-mention and the SDK dedupes by ts, so when the `message` event wins the
// race isMention stays falsy. Fall back to scanning the raw text so a mention
// is detected regardless of which event the SDK surfaced.
export const isSlackBotAddressed = (
  message: SlackAddressableMessage | undefined,
  botUserId: string | undefined,
): boolean => {
  if (message?.isMention) return true;
  const raw = message?.raw as SlackMessageRaw | undefined;
  return hasSlackBotMention(raw?.text, botUserId);
};
