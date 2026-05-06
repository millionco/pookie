import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat } from "chat";

import { env } from "@/env";
import { isSlackConfigured } from "@/lib/deployment";

import { sharedRedisState } from "./state";

// Slack adapter throws at construction time if SLACK_SIGNING_SECRET is missing.
// Pass placeholder values when env isn't populated yet so module-load doesn't
// crash the whole server — Slack-facing routes guard on isSlackConfigured.
const slackAdapterConfig = isSlackConfigured()
  ? {
      encryptionKey: process.env.SLACK_ENCRYPTION_KEY,
    }
  : {
      signingSecret: "pookie-not-configured",
      clientId: "pookie-not-configured",
      clientSecret: "pookie-not-configured",
    };

export const slackBot = new Chat({
  userName: env.SLACK_BOT_NAME || "pookie",
  adapters: {
    slack: createSlackAdapter(slackAdapterConfig),
  },
  state: sharedRedisState,
  concurrency: "concurrent",
}).registerSingleton();
