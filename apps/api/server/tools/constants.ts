const MEMORY_KEY_PREFIX = "pookie:memory";

export const memoryKeyGlobal = (teamId: string): string =>
  `${MEMORY_KEY_PREFIX}:${teamId}:global`;

export const memoryKeyUser = (teamId: string, userId: string): string =>
  `${MEMORY_KEY_PREFIX}:${teamId}:user:${userId}`;

export const memoryKeyChannel = (teamId: string, channelId: string): string =>
  `${MEMORY_KEY_PREFIX}:${teamId}:channel:${channelId}`;

export const MAX_NOTES_PER_USER = 50;
export const MAX_NOTES_PER_CHANNEL = 100;
export const MAX_NOTES_GLOBAL = 100;

export const INJECT_RECENT_COUNT = 10;
export const INJECT_MAX_CHARS = 1500;
export const INJECT_GLOBAL_RECENT_COUNT = 15;
export const INJECT_GLOBAL_MAX_CHARS = 2000;

export const DUPLICATE_LOOKBACK_COUNT = 20;
export const RECALL_DEFAULT_LIMIT = 20;
export const RECALL_MAX_LIMIT = 50;

export const SLACK_SEARCH_DEFAULT_LIMIT = 5;
export const SLACK_SEARCH_MAX_CALLS_PER_QUERY_COUNT = 2;
export const SLACK_SEARCH_SUBAGENT_MAX_STEPS_COUNT = 12;
export const SLACK_SEARCH_SNIPPET_MAX_CHARS = 240;
export const SLACK_SEARCH_WEB_CLIENT_MAX_CONCURRENCY_COUNT = 1;
export const SLACK_SEARCH_WEB_CLIENT_RETRY_COUNT = 0;

export const SLACK_CHANNEL_HISTORY_DEFAULT_LIMIT = 30;
export const SLACK_THREAD_DEFAULT_LIMIT = 100;
export const SLACK_CHANNEL_LIST_DEFAULT_LIMIT = 50;
// Slack's documented per-page max for cursor-paginated methods like
// conversations.list / conversations.history / conversations.replies.
// Mirrors the JSDoc on `CursorPaginationEnabled.limit` in @slack/web-api
// (`dist/types/request/common.d.ts`): "max value of 999. Default is 100".
// Used internally when paginating the full visible-channel list; not
// user-facing. Not exported by the SDK as a runtime constant — if Slack
// ever raises the cap, update this here.
export const SLACK_CHANNEL_LIST_PAGE_SIZE = 999;
export const SLACK_CHANNEL_ACCESS_CHECK_LIMIT = 1;
export const SLACK_CHANNEL_RESOLVE_MAX_PAGES = 10;
export const SLACK_MESSAGE_SNIPPET_MAX_CHARS = 500;
export const SLACK_FILE_CONTENT_MAX_BYTES = 1_000_000;
export const SLACK_FILE_CONTENT_MAX_CHARS = 12_000;

export const SLACK_CANVAS_MARKDOWN_MAX_CHARS = 50_000;

export const MAX_HTML_BYTES = 262_144;
export const HTML_APP_TTL_S = 60 * 60 * 24 * 30;
// Iframe sandbox is the load-bearing isolation. This allowlist is informational
// for now — it documents which CDNs the system prompt encourages the model to
// use (so apps render predictably) and seeds the meta-CSP we may inject into
// stored HTML in a future hardening pass. Keep `https:` in mind: the sandbox
// already blocks credentialed cross-origin access, so loose CDN access is an
// acceptable starting posture.
export const HTML_APP_CDN_ALLOWLIST: readonly string[] = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];
export const HTML_APP_LOCAL_DEV_BASE_URL = "http://localhost:3000";
export const HTML_APP_TOKEN_TTL_S = HTML_APP_TTL_S;
