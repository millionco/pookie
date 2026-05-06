# Phase 2: bidirectional postMessage bridge / MCP Apps host

Status: needs-triage

## Context

Phase 1 of HTML Apps shipped (see `../PRD.md`). The iframe is an island — it cannot call back into Pookie. This issue tracks the follow-up work to add a `postMessage` bridge so HTML apps can request tool calls, push context updates back to the Slack thread, and (as a side effect) make Pookie a host for the spec-compliant [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) protocol.

## Acceptance criteria

- HTML apps can send `{ type: "pookie/tool_call", id, name, args }` via `postMessage`. Parent validates against a per-app `allowedTools` allowlist (stored on the row at create time, defaults to `[]`), invokes the existing Pookie tool registry, and replies with `{ type: "pookie/tool_result", id, result | error }`.
- Apps can send `{ type: "pookie/context_update", summary }`. The summary is appended to the thread's conversation context (not necessarily as a visible Slack message) so the agent's next turn knows what happened inside the app.
- The protocol uses MCP Apps' `ui/` JSON-RPC method names where they exist, so the same runtime can later accept third-party `ui://` resources from connected MCP servers without reimplementation.
- Token gating: revisit Phase 1's "URL-is-the-secret" model. Bridge-enabled apps probably warrant a Slack-OAuth gate on `/a/<token>`.
- Origin isolation: host `/a/*` on `apps.pookie.app` (or equivalent) so a sandbox regression cannot reach Pookie cookies.

## Non-goals

- Multiplayer / shared state.
- Edit-in-thread iteration on existing apps.
- Slack unfurl preview screenshots.
- Streaming tool inputs (separate sub-issue once synchronous bridge works).

## Pointers

- Phase 1 entry points: `apps/api/server/tools/html-app.ts`, `apps/api/app/a/[token]/page.tsx`.
- Spec: <https://modelcontextprotocol.io/extensions/apps/overview> and the linked specification page.
- Reference host implementations called out by the spec: `@mcp-ui/client`, `AppBridge` in the official SDK.

## Comments
