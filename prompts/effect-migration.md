# Effect Migration — Full Rewrite of `apps/api/server/`

Rewrite the entire `apps/api/server/` directory to use Effect (4.x beta). This is a full rewrite, not an incremental migration. The goal is a clean Effect architecture with proper service layers, typed errors, and composable dependency injection.

Work through the phases below in order. Each phase must build successfully before moving to the next. Run `pnpm build` after each phase to verify.

## Reference repos (cloned to /tmp)

- `/tmp/opencode` — Effect service patterns, `effect-zod.ts` bridge (Schema → JSON Schema for AI SDK), `ManagedRuntime`, error handling
- `/tmp/expect` — `ServiceMap.Service` pattern (the one we're using), Axiom/OTLP observability, `Schema.ErrorClass`, layer composition

Study these repos when unsure about an Effect pattern. Prefer their idioms over inventing new ones.

## Key decisions

- **Effect version**: 4.x beta (match `/tmp/expect` versions — `effect` + `@effect/platform-node`)
- **Service pattern**: `ServiceMap.Service` (expect style) — each service is a class with static `layer` and `make` Effect
- **Schemas**: Replace all Zod in `server/` with Effect Schema. Use `toJsonSchema()` bridge (from `/tmp/opencode/packages/opencode/src/util/effect-zod.ts`) for AI SDK tool definitions via `jsonSchema()` wrapper
- **Errors**: `Schema.ErrorClass` per domain (e.g., `RedisError`, `SlackApiError`, `McpConnectionError`). Tagged, serializable, pattern-matchable with `Effect.catchTag`/`Effect.catchTags`
- **Runtime**: Per-request runtime with shared infrastructure layers. `InfraLayer` (Redis, SecureStore, Observability) lives at module scope as a singleton. Request-scoped services compose on top via `Layer.provide(InfraLayer)`
- **AI SDK streaming**: Wrap `streamText` in `Effect.tryPromise`, convert `fullStream` async iterable to `Stream.fromAsyncIterable`, process with `Stream.mapEffect` pipeline
- **Chat SDK**: Stays at the edge. `bot.ts` registers event handlers that call `runtime.runPromise()` to enter the Effect world. Chat SDK objects (`Thread`, `Message`, `SlackAdapter`) are passed as plain arguments into Effect programs
- **Tools**: Keep the `defineTool`/`buildToolset` pattern. Tool `execute` callbacks call into Effect via the request runtime. Replace Zod schemas in tool parameters with Effect Schema + `toJsonSchema()` bridge
- **MCP lifecycle**: `Effect.acquireRelease` for MCP client connections — automatic cleanup on errors
- **Thread lock**: Redis-backed (`SET NX`), wrapped in Effect `acquireRelease`
- **OpenAI provider**: Effect service (`OpenAIProvider`), creates fresh provider per agent round (avoids WebSocket race conditions)
- **Observability**: Effect Logger + `Otlp.layerJson` for Axiom (see `/tmp/expect/packages/shared/src/observability/Tracing.ts` for the exact pattern). Replace custom `logger.ts`, `slack-tracer.ts`, `get-current-trace-id.ts`, `record-span-error.ts`
- **Env**: `apps/api/env.ts` stays exactly as-is (keeps `@t3-oss/env-nextjs` + Zod). Effect services import `env` directly — it's the one exception to "replace all Zod"
- **File layout**: Keep existing folder structure (`agent/`, `tools/`, `mcp/`, `config/`, `slack/`, `utils/`). Add `infra/` for Redis, SecureStore, Observability, OpenAI provider
- **Tests**: Not in scope — focus on getting the architecture right. Verify via `pnpm build` + `pnpm typecheck`
- **Scope**: `apps/api/server/` only. Don't touch `packages/video/`, frontend components, marketing pages, or `lib/`
- **Comments**: Preserve all existing "why" comments (workarounds, quirks, design decisions) in their new locations. Required by AGENTS.md

## Phase 1: Setup

### 1a. Install dependencies

Add to `apps/api/package.json`:

```
effect (match /tmp/expect version)
@effect/platform-node (match /tmp/expect version)
```

Remove from `apps/api/package.json` (only if no longer imported anywhere in scope):

- `zod` will still be needed by `env.ts` and AI SDK, so keep it

Run `pnpm install` after.

### 1b. Create the Effect-Zod bridge

Create `apps/api/server/util/effect-zod.ts` — port the `toJsonSchema()` and `zod()` functions from `/tmp/opencode/packages/opencode/src/util/effect-zod.ts`. This converts Effect Schema → Zod → JSON Schema for AI SDK tool parameter definitions.

Only port what's needed: `zod()`, `toJsonSchema()`, `walk()`, and the AST walker. Skip anything related to `zodObject()` or opencode-specific annotations unless required by the walker.

### 1c. Create shared error types

Create `apps/api/server/errors.ts` with domain-specific error classes:

```typescript
import { Schema } from "effect";

export class RedisError extends Schema.ErrorClass<RedisError>("RedisError")({
  _tag: Schema.tag("RedisError"),
  method: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SlackApiError extends Schema.ErrorClass<SlackApiError>(
  "SlackApiError",
)({
  _tag: Schema.tag("SlackApiError"),
  method: Schema.String,
  code: Schema.optional(Schema.String),
}) {
  get message() {
    return `Slack API error: ${this.method}${this.code ? ` (${this.code})` : ""}`;
  }
}

export class SlackAccessError extends Schema.ErrorClass<SlackAccessError>(
  "SlackAccessError",
)({
  _tag: Schema.tag("SlackAccessError"),
  reason: Schema.String,
}) {}

export class McpConnectionError extends Schema.ErrorClass<McpConnectionError>(
  "McpConnectionError",
)({
  _tag: Schema.tag("McpConnectionError"),
  server: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class McpAuthError extends Schema.ErrorClass<McpAuthError>(
  "McpAuthError",
)({
  _tag: Schema.tag("McpAuthError"),
  server: Schema.String,
  reason: Schema.String,
}) {}

export class ConfigError extends Schema.ErrorClass<ConfigError>("ConfigError")({
  _tag: Schema.tag("ConfigError"),
  key: Schema.String,
}) {}

export class ThreadBusyError extends Schema.ErrorClass<ThreadBusyError>(
  "ThreadBusyError",
)({
  _tag: Schema.tag("ThreadBusyError"),
  threadId: Schema.String,
}) {}

export class AgentStreamError extends Schema.ErrorClass<AgentStreamError>(
  "AgentStreamError",
)({
  _tag: Schema.tag("AgentStreamError"),
  cause: Schema.optional(Schema.Defect),
}) {}

export class EncryptionError extends Schema.ErrorClass<EncryptionError>(
  "EncryptionError",
)({
  _tag: Schema.tag("EncryptionError"),
  operation: Schema.Literal("encrypt", "decrypt"),
  cause: Schema.optional(Schema.Defect),
}) {}

export class ToolExecutionError extends Schema.ErrorClass<ToolExecutionError>(
  "ToolExecutionError",
)({
  _tag: Schema.tag("ToolExecutionError"),
  tool: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class ValidationError extends Schema.ErrorClass<ValidationError>(
  "ValidationError",
)({
  _tag: Schema.tag("ValidationError"),
  field: Schema.String,
  reason: Schema.String,
}) {}
```

Add more error classes as needed during later phases. Each service may add its own domain-specific errors.

## Phase 2: Infrastructure services

These have no dependencies on other pookie services. Create `apps/api/server/infra/`.

### 2a. Redis service (`infra/redis.ts`)

Wrap `ioredis` in an Effect service. Expose typed methods for the operations used across the codebase: `get`, `set`, `setNx`, `del`, `rpush`, `lpop`, `lrange`, `expire`, `keys`, `pipeline`. All methods return `Effect.Effect<T, RedisError>`.

```typescript
import { Effect, Layer, ServiceMap } from "effect";
import IORedis from "ioredis";
import { env } from "@/env";
import { RedisError } from "../errors";

export class Redis extends ServiceMap.Service<Redis>()("@pookie/Redis", {
  make: Effect.gen(function* () {
    const client = new IORedis(env.REDIS_URL);

    const wrap = <T>(method: string, fn: () => Promise<T>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new RedisError({ method, cause }),
      });

    return {
      get: (key: string) => wrap("get", () => client.get(key)),
      set: (key: string, value: string, ...args: Array<string | number>) =>
        wrap("set", () => client.set(key, value, ...(args as [any]))),
      setNx: (key: string, value: string, ttlSeconds: number) =>
        wrap("setNx", () =>
          client
            .set(key, value, "EX", ttlSeconds, "NX")
            .then((r) => r === "OK"),
        ),
      del: (...keys: string[]) => wrap("del", () => client.del(...keys)),
      // ... expose all operations actually used in the codebase
      raw: client, // escape hatch for complex pipelines
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Audit every `redis` import in the existing codebase to ensure all operations are covered.

### 2b. SecureStore service (`infra/secure-store.ts`)

Wrap the Cryptr encrypt/decrypt in an Effect service.

```typescript
export class SecureStore extends ServiceMap.Service<SecureStore>()("@pookie/SecureStore", {
  make: Effect.sync(() => {
    // ... init Cryptr from env.SLACK_ENCRYPTION_KEY
    return {
      encrypt: (data: unknown) => Effect.try({ ... }),
      decrypt: <T>(encrypted: string) => Effect.try({ ... }),
      encryptJson: (data: unknown) => Effect.try({ ... }),
      decryptJson: <T>(encrypted: string) => Effect.try({ ... }),
    }
  }),
}) {
  static layer = Layer.effect(this, this.make)
}
```

### 2c. Observability service (`infra/observability.ts`)

Effect Logger + OTLP tracing to Axiom. Follow the exact pattern from `/tmp/expect/packages/shared/src/observability/Tracing.ts`.

```typescript
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer, Logger } from "effect";
import * as Otlp from "effect/unstable/observability/Otlp";
import { env } from "@/env";

export const layer = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? Otlp.layerJson({
      baseUrl: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      resource: { serviceName: env.OTEL_SERVICE_NAME ?? "pookie" },
      headers: parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  : Layer.empty;
```

Use `Effect.fn("ServiceName.methodName")` on all service methods to get automatic spans. Use `Effect.logInfo`, `Effect.logWarning`, `Effect.logError` instead of the custom logger.

### 2d. OpenAI Provider service (`infra/openai-provider.ts`)

```typescript
export class OpenAIProvider extends ServiceMap.Service<OpenAIProvider>()(
  "@pookie/OpenAIProvider",
  {
    make: Effect.sync(() => ({
      create: () =>
        Effect.sync(() => createOpenAI({ fetch: createWebSocketFetch() })),
    })),
  },
) {
  static layer = Layer.effect(this, this.make);
}
```

### 2e. Infrastructure layer (`infra/index.ts`)

Compose all infra services into a single shared layer:

```typescript
export const InfraLayer = Layer.mergeAll(
  Redis.layer,
  SecureStore.layer,
  Observability.layer,
  OpenAIProvider.layer,
);
```

This layer is created once at module scope and shared across all requests.

## Phase 3: Domain services

These depend on infrastructure services.

### 3a. Config service (`config/service.ts`)

Rewrite config store, schema, and resolution as a single Effect service. Replace Zod schemas with Effect Schema. Keep `personality-prompts.ts` and `defaults.ts` as plain data files. Keep `constants.ts`.

The service should expose: `resolve(scope)`, `get(scope, key)`, `set(scope, key, value)`, `getPersonalityPrompt(personality)`.

### 3b. SlackClient service (`slack/client.ts`)

Thin wrapper around `@slack/web-api` that returns `Effect.Effect<T, SlackApiError>` for all API calls used in the codebase. Don't wrap the entire SDK — only the methods actually called.

### 3c. ThreadLock service (`agent/thread-lock.ts`)

Redis-backed mutex with `Effect.acquireRelease`. Expose: `acquire(threadId)`, `enqueueFollowUp(threadId, channelId, followUp)`, `drainFollowUps(threadId)`, `removeDeletedFollowUp(channelId, messageTs)`, `tryMarkReauthNoticeSent(threadId)`.

### 3d. ActiveRuns service (`agent/active-runs.ts`)

Track active agent runs for abort/deletion. Wrap existing logic in Effect.

### 3e. McpStore service (`mcp/store.ts`)

Redis + SecureStore backed MCP credential storage. Rewrite using Effect services instead of raw Redis calls.

### 3f. McpClient service (`mcp/client.ts`)

MCP connection management with `Effect.acquireRelease` for lifecycle. Transport fallback (HTTP → SSE) stays. OAuth auth provider logic stays.

## Phase 4: Agent core

### 4a. SystemPrompt service (`agent/system-prompt.ts`)

Build system prompt and system reminder. Depends on Config. Convert to Effect service.

### 4b. ToolRegistry (`tools/registry.ts`)

Replace `buildToolset()` with an Effect-aware version. Each tool's `execute` callback runs through the request runtime. Replace Zod parameter schemas with Effect Schema + `toJsonSchema()` bridge.

Keep `defineTool` as a factory but update it to:

1. Accept Effect Schema for `inputSchema` (convert via `toJsonSchema()` + `jsonSchema()` for AI SDK)
2. Tool execute callbacks can be plain async functions that call `runtime.runPromise()` to enter Effect

### 4c. Individual tools

Rewrite each tool file (`memory.ts`, `search.ts`, `slack-channel.ts`, `slack-search.ts`, `subagent.ts`) to use Effect Schema for parameters and return types. The execute functions should use Effect.gen internally, accessing services from context.

The current `PookieToolResult` discriminated union pattern should be replaced:

- Success: return the result value directly
- Errors: fail with typed Effect errors
- At the `defineTool` boundary, catch Effect errors and convert back to the format the AI SDK/model expects (success/error discriminated union for model output)

### 4d. Agent service (`agent/service.ts`)

This is the core orchestration. Rewrite `handleSlackMessage` and `runAgentRound` as Effect programs.

- `streamText` call wrapped in `Effect.tryPromise`
- Stream processing via `Stream.fromAsyncIterable(result.fullStream).pipe(Stream.mapEffect(handleStreamPart), Stream.runDrain)`
- Card parsing, text buffering, image generation output — all stay as logic within the stream handler
- Follow-up round loop stays, using ThreadLock and Redis
- Error recovery: catch `AgentStreamError` and post `GENERIC_ERROR_MARKDOWN` to thread

Preserve all existing comments about quirks, workarounds, and design decisions.

### 4e. Onboarding (`slack/onboarding/`)

Convert onboarding orchestrator, handler, state, and connect-action to use Effect. These are event-driven flows that interact with Slack + Redis.

### 4f. Memory tools (`tools/memory.ts`)

Remember/recall/forget backed by Redis state. Convert to Effect, accessing Redis from context.

## Phase 5: Integration

### 5a. Runtime (`server/runtime.ts`)

Compose all layers and create the request runtime factory:

```typescript
import { ManagedRuntime, Layer } from "effect";
import { InfraLayer } from "./infra";
// ... import all service layers

const AppLayer = Layer.mergeAll(
  Config.layer,
  SlackClient.layer,
  ThreadLock.layer,
  ActiveRuns.layer,
  McpStore.layer,
  McpClient.layer,
  SystemPrompt.layer,
  ToolRegistry.layer,
  Agent.layer,
  Onboarding.layer,
).pipe(Layer.provide(InfraLayer));

export const makeRequestRuntime = () =>
  ManagedRuntime.make(AppLayer.pipe(Layer.provide(InfraLayer)));

// For the shared infra singleton (Redis pool, etc.)
export const infraRuntime = ManagedRuntime.make(InfraLayer);
```

### 5b. Bot entry point (`server/bot.ts`)

Keep Chat SDK at the edge. Event handlers create a request runtime, run the Effect program, and dispose the runtime after:

```typescript
slackBot.on("newMention", async (thread, message) => {
  const runtime = makeRequestRuntime();
  try {
    await runtime.runPromise(
      Agent.handleSlackMessage({
        thread,
        message,
        slack: slackBot.getAdapter("slack"),
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
```

Slash command handlers follow the same pattern.

### 5c. MCP handlers (`mcp/handlers.ts`)

Convert MCP slash command handlers to Effect programs run via the request runtime.

### 5d. Config handlers (`config/handlers.ts`)

Convert `/pookie-config` slash command handler to Effect.

### 5e. API routes (`app/api/`)

API routes stay thin. The webhook route continues to delegate to `slackBot.webhooks`. Other routes (health, install, oauth, manifest) may not need Effect at all — only convert if they touch server services.

### 5f. Clean up

- Delete `server/utils/logger.ts` (replaced by Effect Logger)
- Delete `server/utils/slack-tracer.ts` (replaced by Effect.fn spans)
- Delete `server/utils/get-current-trace-id.ts` (replaced by Effect span context)
- Delete `server/utils/record-span-error.ts` (replaced by Effect error channel)
- Delete `server/agent/tool-result.ts` (PookieToolResult pattern replaced by Effect errors)
- Delete `server/utils/normalize-tool-error.ts` (error normalization handled by Effect catchAll at boundary)
- Keep `server/utils/sanitize-slack-mrkdwn.ts`, `server/utils/sanitize-stored-messages.ts`, `server/utils/ensure-attachment-text.ts`, `server/utils/truncate-snippet.ts`, `server/utils/slack-timestamp.ts`, `server/utils/pick-defined.ts`, `server/utils/parse-slash-command-args.ts`, `server/utils/is-slack-admin.ts`, `server/utils/sanitize-mcp-tool-args.ts` — these are pure utility functions, just update imports if needed
- Keep `server/utils/post-trace-footer.ts` — convert to use Effect observability internally
- Delete `server/openai-provider.ts` (replaced by `infra/openai-provider.ts`)
- Delete `server/mcp/redis.ts` (replaced by Redis service)
- Update `server/slack-bot.ts` if needed (Chat SDK initialization)

## Phase 6: Verify

1. `pnpm build` — must succeed
2. `pnpm typecheck` — must succeed
3. Manually review that all existing server/ functionality is preserved:
   - Webhook handling flow
   - Agent round execution with streaming
   - Tool execution (search, memory, slack-channel tools, MCP tools)
   - Thread locking and follow-up queue
   - MCP connection lifecycle
   - Config resolution (user > channel > team > default)
   - Onboarding flows
   - Slash commands (/pookie-config, /mcp-add, etc.)

## Style rules

- Follow all rules from `AGENTS.md` (interfaces over types, arrow functions, kebab-case filenames, no `as` casting, etc.)
- Use `Effect.gen(function* () { ... })` for all effectful composition
- Use `Effect.fn("ServiceName.methodName")` for named operations (automatic tracing spans)
- Use `yield*` to access services: `const redis = yield* Redis`
- Use `Effect.tryPromise` to wrap external async calls
- Use `Effect.try` to wrap synchronous calls that may throw
- Use `Schema.ErrorClass` for all custom errors
- Use `Effect.catchTag` / `Effect.catchTags` for error recovery
- Use `Effect.acquireRelease` for resource lifecycle
- Use `Stream` for async iterable processing
- Namespace: `@pookie/ServiceName` for all service tags
- Keep all "why" comments from the existing code in their new locations
