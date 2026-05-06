# PRD: HTML Apps for Pookie

Status: phase-1-shipped

## Background

Pookie answers in Slack via text, images, and code-interpreter results. Some answers are better as a small interactive UI (calculators, configurators, mini dashboards, embedded viewers, form-style pickers). Slack's surfaces (Block Kit, Canvas, modals) cannot render arbitrary HTML/JS or iframes inline, so any "interactive" answer must live on a Pookie web surface that we link to from Slack.

This PRD captures the work that shipped in Phase 1 and the deferred Phase 2 (bidirectional / MCP Apps host) work.

## Phase 1 (shipped)

`create_html_app` tool emits a self-contained HTML doc, Pookie persists it in Redis (encrypted, 30-day TTL), and surfaces a Slack card with an "Open app" button linking to `${BASE_URL}/a/<token>`. The route renders the HTML inside `iframe srcDoc=... sandbox="allow-scripts"` (no `allow-same-origin`, so the iframe runs in an opaque origin and cannot reach Pookie cookies, parent DOM, top-level navigation, popups, or form submission).

Files:

- `apps/api/server/html-apps/{store,sign-token,build-url}.ts`
- `apps/api/server/tools/html-app.ts`
- `apps/api/app/a/[token]/{page,not-found}.tsx`
- CSP / `frame-ancestors 'self'` configured in `apps/api/next.config.ts`
- Tests in `apps/api/tests/html-apps-{sign-token,store,tool}.test.ts`

Tokens are HMAC-SHA256 over `{ teamId, id, exp }` using `SLACK_ENCRYPTION_KEY`. Anyone with the token URL can view the app — the URL is the secret. Multi-user threads can share the link freely; Pookie does not gate by Slack identity in Phase 1.

## Phase 2 — bidirectional / MCP Apps host (deferred)

### Motivation

A truly useful app often wants to call back into Pookie: "search for X across my Slack," "render this image variant," "save these picks to memory," "run this calculation in code interpreter." Phase 1 apps are islands — once the iframe is open, it can't ask Pookie for anything.

Phase 2 adds a `postMessage`-based bridge so the iframe can request tool calls. Once the bridge exists, accepting third-party apps that follow the [MCP Apps spec](https://modelcontextprotocol.io/extensions/apps/overview) is structurally the same protocol — Pookie can become an MCP Apps host as well as an emitter, with no second protocol to maintain.

### Scope

1. **Bridge protocol**: parent page (`/a/[token]`) listens for `message` events from the iframe matching `{ type: "pookie/tool_call", id, name, args }`. Validates against a per-app allowlist embedded in the stored row, calls Pookie's existing tool registry, posts back `{ type: "pookie/tool_result", id, result | error }`. Mirror MCP Apps' `ui/` JSON-RPC method names so the same parent runtime works for spec-compliant servers' apps later.
2. **Tool allowlist**: when the model calls `create_html_app`, accept an optional `allowedTools: string[]`. Default empty (Phase 1 behavior — read-only island). The model picks the minimum surface; the host enforces it.
3. **Context updates back to Slack**: when the iframe sends `{ type: "pookie/context_update", summary }`, append a compact note to the thread's recent-message context so the model knows what the user did inside the app on the next Slack turn. Without this the conversation feels disjointed.
4. **MCP Apps server-side ingest**: detect `_meta.ui.resourceUri` on tool results from connected MCP servers, fetch the `ui://` resource, persist as an html-app row (with the server's declared `csp`/`permissions`), and surface the same "Open app" card. Same render route, same bridge.
5. **Streaming inputs**: per the MCP Apps spec, hosts can stream tool inputs to the app while the tool is executing. Implement once the synchronous flow works.

### Out of scope

- Multiplayer / shared state across users (separate problem; needs websockets or CRDT).
- Edit-in-thread iteration on existing apps (separate, smaller PRD).
- Slack unfurl screenshot previews (visual nicety; Playwright headless render).
- Public discoverability slash command (`/pookie-apps list`).

### Open questions

- Token gating: should `/a/<token>` stay public-with-unguessable-URL, or move to Slack-OAuth-gated? Phase 2 makes apps strictly more powerful (callable tools), which raises the impact of a leaked URL. Probably worth gating in Phase 2 even if we keep Phase 1 ungated.
- Separate origin for `apps.pookie.app` so a sandbox regression cannot reach Pookie cookies. Worth doing before Phase 2 ships.
- Per-app rate limit on bridge tool calls (a runaway app could fan out 10k tools/sec).

### Issues to file when work begins

1.  bridge-protocol — postMessage round-trip + tool allowlist enforcement
2.  context-bridge-back-to-slack — `pookie/context_update` → thread state
3.  mcp-apps-ingest — accept `_meta.ui.resourceUri` from connected servers
4.  apps-subdomain — host `/a/*` on `apps.pookie.app` for origin isolation
5.  token-gating — Slack-OAuth gate on the render route (decide before bridge ships)
