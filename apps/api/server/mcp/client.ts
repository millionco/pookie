import { Effect } from "effect"
import { auth, createMCPClient } from "@ai-sdk/mcp"

import { McpAuthError, McpConnectionError } from "../errors"
import { appRuntime } from "../runtime"
import { createMcpAuthProvider, McpOAuthRedirectError } from "./auth-provider"
import { MCP_TOOL_NAME_SEPARATOR } from "./constants"
import {
  clearPendingAuthUrl,
  consumeOAuthState,
  getServerConfig,
  listVisibleServers,
  loadOAuthTokens,
  loadPendingAuthUrl,
  oauthOwnerId,
} from "./store"

import type {
  MCPClient,
  MCPClientConfig,
  OAuthClientProvider,
} from "@ai-sdk/mcp"
import type * as AI from "ai"

import type { McpScope, McpServerConfig } from "./store"

interface McpTransportAuth {
  authProvider?: OAuthClientProvider
  headers?: Record<string, string>
}

const channelIdFromScope = (scope: McpScope): string | undefined =>
  scope.kind === "channel" ? scope.channelId : undefined

const buildBearerHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
})

const connectWithTransportFallback = async (
  url: string,
  transportAuth: McpTransportAuth,
): Promise<MCPClient> => {
  const transportConfig = (type: "http" | "sse"): MCPClientConfig => ({
    transport: { type, url, ...transportAuth },
  })

  try {
    return await createMCPClient(transportConfig("http"))
  } catch (httpError) {
    const isMethodNotAllowed =
      httpError instanceof Error && httpError.message.includes("405")
    if (!isMethodNotAllowed) throw httpError
    return createMCPClient(transportConfig("sse"))
  }
}

export interface McpRegistrationResult {
  connected: boolean
  authorizationUrl?: string
  toolCount?: number
}

export interface McpServerAuthNeeded {
  name: string
  authorizationUrl: string
}

export interface McpServerError {
  name: string
  message: string
}

export interface McpToolsResult {
  tools: Record<string, AI.Tool>
  close: () => Promise<void>
  servers: Array<{ name: string; toolCount: number }>
  authNeeded: McpServerAuthNeeded[]
  errors: McpServerError[]
}

const resolveTransportAuth = (
  userId: string,
  config: McpServerConfig,
  teamId: string,
): McpTransportAuth => {
  if (config.token) {
    return { headers: buildBearerHeaders(config.token) }
  }
  return {
    authProvider: createMcpAuthProvider({
      userId,
      tokenOwnerId: oauthOwnerId(config.scope, userId),
      serverName: config.name,
      serverUrl: config.url,
      channelId: channelIdFromScope(config.scope),
      teamId,
    }),
  }
}

// Pre-authenticate with a single sequential auth() call before creating the
// MCP client. The HTTP transport fires openInboundSse concurrently with send,
// each triggering independent auth() calls that race on client registration
// and PKCE state. By resolving auth first, the transport sees valid tokens
// and skips its own auth flow entirely.
//
// If a previous call already started an auth flow (saved a pending URL),
// reuse that URL instead of calling auth() again — a second auth() would
// generate a fresh PKCE pair and overwrite the verifier the user is
// currently trying to use.
//
// When tokens exist without a refresh_token, skip auth() entirely.
// The @ai-sdk/mcp auth() function unconditionally starts a new
// authorization flow in that case (even if the access_token is still
// valid), creating an infinite re-auth loop for providers like Mercury
// and Cloudflare that don't issue refresh tokens.
//
// When tokens DO have a refresh_token, call auth() to proactively
// refresh — but catch any redirect that occurs anyway (e.g. the
// refresh endpoint returned a transient 5xx / ServerError, which
// @ai-sdk/mcp silently swallows before falling through to re-auth).
// In that case, fall back to the existing tokens and let the transport
// handle 401s if the access_token is actually expired.
const loadOAuthTokensWithFallback = (
  ownerId: string,
  userId: string,
  serverName: string,
  teamId: string,
) =>
  Effect.gen(function* () {
    const tokens = yield* loadOAuthTokens(ownerId, serverName, teamId)
    if (tokens) return tokens
    if (ownerId !== userId)
      return yield* loadOAuthTokens(userId, serverName, teamId)
    return undefined
  })

const ensureOAuth = (
  userId: string,
  config: McpServerConfig,
  teamId: string,
) =>
  Effect.gen(function* () {
    if (config.token) return

    const pendingAuthUrl = yield* loadPendingAuthUrl(
      userId,
      config.name,
      teamId,
    )
    if (pendingAuthUrl) {
      return yield* Effect.fail(
        new McpOAuthRedirectError(pendingAuthUrl, config.url),
      )
    }

    const ownerId = oauthOwnerId(config.scope, userId)
    const existingTokens = yield* loadOAuthTokensWithFallback(
      ownerId,
      userId,
      config.name,
      teamId,
    )
    if (existingTokens && !existingTokens.refresh_token) return

    const authProvider = createMcpAuthProvider({
      userId,
      tokenOwnerId: ownerId,
      serverName: config.name,
      serverUrl: config.url,
      channelId: channelIdFromScope(config.scope),
      teamId,
    })

    yield* Effect.tryPromise({
      try: () => auth(authProvider, { serverUrl: config.url }),
      catch: (cause) =>
        cause instanceof McpOAuthRedirectError
          ? cause
          : new McpAuthError({
              server: config.name,
              reason:
                cause instanceof Error ? cause.message : String(cause),
            }),
    }).pipe(
      Effect.catchCause((error) =>
        Effect.gen(function* () {
          if (!(error instanceof McpOAuthRedirectError)) {
            return yield* Effect.fail(error)
          }
          // auth() wanted to redirect despite us having tokens. Re-check Redis
          // (auth may have called invalidateCredentials("all"), clearing them).
          const currentTokens = yield* loadOAuthTokensWithFallback(
            ownerId,
            userId,
            config.name,
            teamId,
          )
          if (currentTokens) {
            yield* clearPendingAuthUrl(userId, config.name, teamId)
            return
          }
          return yield* Effect.fail(error)
        }),
      ),
    )
  })

const findConfigByName = (
  userId: string,
  serverName: string,
  channelId: string | undefined,
  teamId: string,
) =>
  Effect.gen(function* () {
    const scopes: McpScope[] = [
      { kind: "user", userId, teamId },
      { kind: "global", teamId },
    ]

    if (channelId) {
      scopes.push({ kind: "channel", channelId, teamId })
    }

    for (const scope of scopes) {
      const config = yield* getServerConfig(scope, serverName)
      if (config) return config
    }

    return null
  })

export const tryRegister = Effect.fn("McpClient.tryRegister")(
  (userId: string, config: McpServerConfig, teamId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ensureOAuth(userId, config, teamId)
        const transportAuth = resolveTransportAuth(userId, config, teamId)

        const client = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              connectWithTransportFallback(config.url, transportAuth),
            catch: (cause) =>
              new McpConnectionError({ server: config.name, cause }),
          }),
          (innerClient) =>
            Effect.promise(() => innerClient.close().catch(() => {})),
        )

        const toolSet = yield* Effect.tryPromise({
          try: () => client.tools(),
          catch: (cause) =>
            new McpConnectionError({ server: config.name, cause }),
        })
        const toolCount = Object.keys(toolSet).length
        return { connected: true, toolCount } as McpRegistrationResult
      }),
    ).pipe(
      Effect.catchCause((error) =>
        error instanceof McpOAuthRedirectError
          ? Effect.succeed({
              connected: false,
              authorizationUrl: error.authorizationUrl,
            } as McpRegistrationResult)
          : Effect.fail(error),
      ),
    ),
)

export const finishOAuth = Effect.fn("McpClient.finishOAuth")(
  ({ code, state }: { code: string; state: string }) =>
    Effect.gen(function* () {
      const payload = yield* consumeOAuthState(state)
      if (!payload) {
        return yield* Effect.fail(
          new McpAuthError({
            server: "unknown",
            reason: "Invalid or expired OAuth state token",
          }),
        )
      }

      const { userId, serverName, channelId, teamId } = payload

      if (!teamId) {
        return yield* Effect.fail(
          new McpAuthError({
            server: serverName,
            reason:
              "OAuth state missing teamId — re-run /mcp-add to start a fresh flow",
          }),
        )
      }

      const config = yield* findConfigByName(
        userId,
        serverName,
        channelId,
        teamId,
      )
      if (!config) {
        return yield* Effect.fail(
          new McpAuthError({
            server: serverName,
            reason: `MCP server "${serverName}" not found`,
          }),
        )
      }

      const authProvider = createMcpAuthProvider({
        userId,
        tokenOwnerId: oauthOwnerId(config.scope, userId),
        serverName,
        serverUrl: config.url,
        channelId: channelIdFromScope(config.scope),
        teamId,
      })

      yield* Effect.tryPromise({
        try: () =>
          auth(authProvider, {
            serverUrl: config.url,
            authorizationCode: code,
          }),
        catch: (cause) =>
          new McpAuthError({
            server: serverName,
            reason:
              cause instanceof Error ? cause.message : String(cause),
          }),
      })

      yield* clearPendingAuthUrl(userId, serverName, teamId)

      return { userId, serverName, channelId, teamId }
    }),
)

export const openMcpTools = Effect.fn("McpClient.openMcpTools")(
  (userId: string, channelId: string | undefined, teamId: string) =>
    Effect.gen(function* () {
      const configs = yield* listVisibleServers(userId, channelId, teamId)

      const emptyResult: McpToolsResult = {
        tools: {},
        close: async () => {},
        servers: [],
        authNeeded: [],
        errors: [],
      }

      if (configs.length === 0) return emptyResult

      const allTools: Record<string, AI.Tool> = {}
      const serverSummaries: Array<{ name: string; toolCount: number }> = []
      const authNeeded: McpServerAuthNeeded[] = []
      const serverErrors: McpServerError[] = []
      const connectedClients: MCPClient[] = []

      const classifyError = (config: McpServerConfig, error: unknown) => {
        if (error instanceof McpOAuthRedirectError) {
          authNeeded.push({
            name: config.name,
            authorizationUrl: error.authorizationUrl,
          })
        } else {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          console.warn(`[mcp] failed for ${config.name}:`, error)
          serverErrors.push({ name: config.name, message: errorMessage })
        }
      }

      yield* Effect.forEach(
        configs,
        (config) =>
          Effect.gen(function* () {
            yield* ensureOAuth(userId, config, teamId)
            const transportAuth = resolveTransportAuth(
              userId,
              config,
              teamId,
            )

            const client = yield* Effect.tryPromise({
              try: () =>
                connectWithTransportFallback(
                  config.url,
                  transportAuth,
                ),
              catch: (cause) =>
                new McpConnectionError({
                  server: config.name,
                  cause,
                }),
            })
            connectedClients.push(client)

            const toolSet = yield* Effect.tryPromise({
              try: () => client.tools(),
              catch: (cause) =>
                new McpConnectionError({
                  server: config.name,
                  cause,
                }),
            })

            let toolCount = 0
            for (const [toolName, tool] of Object.entries(toolSet)) {
              const prefixedName = `mcp${MCP_TOOL_NAME_SEPARATOR}${config.name}${MCP_TOOL_NAME_SEPARATOR}${toolName}`
              allTools[prefixedName] = tool as AI.Tool
              toolCount++
            }
            serverSummaries.push({ name: config.name, toolCount })
          }).pipe(
            Effect.catchCause((error) => {
              classifyError(config, error)
              return Effect.void
            }),
          ),
        { concurrency: "unbounded" },
      )

      return {
        tools: allTools,
        close: async () => {
          await Promise.allSettled(
            connectedClients.map((innerClient) => innerClient.close().catch(() => {})),
          )
        },
        servers: serverSummaries,
        authNeeded,
        errors: serverErrors,
      } satisfies McpToolsResult
    }),
)

export const openMcpToolsAsync = (...args: Parameters<typeof openMcpTools>) =>
  appRuntime.runPromise(openMcpTools(...args))

export const tryRegisterAsync = (...args: Parameters<typeof tryRegister>) =>
  appRuntime.runPromise(tryRegister(...args))

export const finishOAuthAsync = (...args: Parameters<typeof finishOAuth>) =>
  appRuntime.runPromise(finishOAuth(...args))
