import { describe, expect, it } from "vitest";

import {
  hasSlackBotMention,
  isSlackBotAddressed,
} from "../server/slack/message-routing";

describe("hasSlackBotMention", () => {
  it("detects Slack bot user mentions", () => {
    expect(hasSlackBotMention("<@UBOT> what do you think", "UBOT")).toBe(true);
  });

  it("ignores messages without the bot mention", () => {
    expect(hasSlackBotMention("<@UOTHER> what do you think", "UBOT")).toBe(
      false,
    );
  });

  it("requires a complete Slack mention token", () => {
    expect(hasSlackBotMention("<@UBOTEXTRA> hi", "UBOT")).toBe(false);
  });
});

describe("isSlackBotAddressed", () => {
  it("treats SDK isMention as addressed", () => {
    expect(isSlackBotAddressed({ isMention: true }, "UBOT")).toBe(true);
  });

  it("ignores plain follow-ups with no mention", () => {
    expect(
      isSlackBotAddressed(
        { isMention: false, raw: { text: "thanks, that helps" } },
        "UBOT",
      ),
    ).toBe(false);
  });

  // Regression for "no reply on thread follow-up @-mention". The slack
  // adapter only sets message.isMention=true for events whose literal type
  // is "app_mention". Slack fans out both `app_mention` and `message` for
  // every @-mention; the SDK dedupes by ts, and when the `message` event
  // wins the race isMention stays falsy. isSlackBotAddressed must fall back
  // to the raw text scan so subscribed-thread mentions still trigger.
  it("recovers a mention when the SDK isMention flag is missing", () => {
    expect(
      isSlackBotAddressed(
        {
          isMention: undefined,
          raw: { text: "<@UBOT> what tools did u call" },
        },
        "UBOT",
      ),
    ).toBe(true);
  });

  it("ignores a follow-up that mentions someone else", () => {
    expect(
      isSlackBotAddressed(
        { isMention: false, raw: { text: "<@UOTHER> ping" } },
        "UBOT",
      ),
    ).toBe(false);
  });
});
