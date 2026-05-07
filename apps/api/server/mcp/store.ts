import { Effect } from "effect"

import {
  MCP_AUTH_LINK_PREFIX,
  MCP_CONFIG_PREFIX,
  MCP_OAUTH_PREFIX,
  MCP_STATE_PREFIX,
  OAUTH_STATE_TTL_SECONDS,
  PENDING_AUTH_URL_TTL_SECONDS,
  PKCE_VERIFIER_TTL_SECONDS,
  oauthOwnerId,
} from "./constants"

export { oauthOwnerId }

import { Redis } from "../infra/redis"
import { SecureStore } from "../infra/secure-store"
import { appRuntime } from "../runtime"

import { RedisError } from "../errors"
import type { OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp"

export interface McpScopeGlobal {
  kind: "global"
  teamId: string
}

export interface McpScopeChannel {
  kind: "channel"
  channelId: string
  teamId: string
}

export interface McpScopeUser {
  kind: "user"
  userId: string
  teamId: string
}

export type McpScope = McpScopeGlobal | McpScopeChannel | McpScopeUser

export interface McpServerConfig {
  name: string
  url: string
  scope: McpScope
  createdBy: string
  createdAt: number
  token?: string
}

export interface OAuthStatePayload {
  userId: string
  serverName: string
  channelId?: string
  teamId: string
}

export interface OAuthAuthorizationLinkPayload {
  serverName: string
  authorizationUrl: string
}

const configKey = (scope: McpScope, serverName: string): string => {
  switch (scope.kind) {
    case "global":
      return `${MCP_CONFIG_PREFIX}:global:${scope.teamId}:${serverName}`
    case "channel":
      return `${MCP_CONFIG_PREFIX}:channel:${scope.teamId}:${scope.channelId}:${serverName}`
    case "user":
      return `${MCP_CONFIG_PREFIX}:user:${scope.teamId}:${scope.userId}:${serverName}`
  }
}

const configScanPattern = (scope: McpScope): string => {
  switch (scope.kind) {
    case "global":
      return `${MCP_CONFIG_PREFIX}:global:${scope.teamId}:*`
    case "channel":
      return `${MCP_CONFIG_PREFIX}:channel:${scope.teamId}:${scope.channelId}:*`
    case "user":
      return `${MCP_CONFIG_PREFIX}:user:${scope.teamId}:${scope.userId}:*`
  }
}

const oauthTokensKey = (
  ownerId: string,
  serverName: string,
  teamId: string,
): string => `${MCP_OAUTH_PREFIX}:${teamId}:${ownerId}:${serverName}:tokens`

const oauthClientKey = (
  ownerId: string,
  serverName: string,
  teamId: string,
): string => `${MCP_OAUTH_PREFIX}:${teamId}:${ownerId}:${serverName}:client`

const pkceVerifierKey = (
  userId: string,
  serverName: string,
  teamId: string,
): string => `${MCP_OAUTH_PREFIX}:${teamId}:${userId}:${serverName}:verifier`

const pendingAuthUrlKey = (
  userId: string,
  serverName: string,
  teamId: string,
): string =>
  `${MCP_OAUTH_PREFIX}:${teamId}:${userId}:${serverName}:pending-auth`

const oauthStateKey = (stateToken: string): string =>
  `${MCP_STATE_PREFIX}:${stateToken}`

const oauthAuthorizationLinkKey = (linkToken: string): string =>
  `${MCP_AUTH_LINK_PREFIX}:${linkToken}`

const scanAll = (pattern: string) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const results: string[] = []
    let cursor: string | number = 0

    do {
      const scanResult: [string, string[]] = yield* redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      )
      cursor = Number(scanResult[0])
      results.push(...scanResult[1])
    } while (cursor !== 0)

    return results
  })

const listServerConfigs = (scope: McpScope) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const secureStore = yield* SecureStore
    const keys = yield* scanAll(configScanPattern(scope))
    if (keys.length === 0) return [] as McpServerConfig[]

    const pipeline = redis.pipeline()
    for (const key of keys) {
      pipeline.get(key)
    }
    const results = yield* Effect.tryPromise({
      try: () => pipeline.exec(),
      catch: (cause) => new RedisError({ method: "pipeline.exec", cause }),
    })

    // ioredis returns [Error | null, T][]; drop errored entries and unwrap.
    const values = (results ?? [])
      .map(([err, val]) => (err ? null : val))
      .filter(Boolean)

    const decryptedConfigs = yield* Effect.all(
      values.map((raw) =>
        secureStore.decrypt(raw).pipe(
          Effect.map((decrypted) => {
            if (!decrypted) return null
            return JSON.parse(decrypted) as McpServerConfig
          }),
        ),
      ),
    )

    return decryptedConfigs.filter(
      (config): config is McpServerConfig => config !== null,
    )
  })

export const saveServerConfig = Effect.fn("McpStore.saveServerConfig")(
  (config: McpServerConfig) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(JSON.stringify(config))
      yield* redis.set(configKey(config.scope, config.name), encrypted)
    }),
)

export const getServerConfig = Effect.fn("McpStore.getServerConfig")(
  (scope: McpScope, serverName: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const raw = yield* redis.get(configKey(scope, serverName))
      if (!raw) return null
      const decrypted = yield* secureStore.decrypt(raw)
      if (!decrypted) return null
      return JSON.parse(decrypted) as McpServerConfig
    }),
)

export const listVisibleServers = Effect.fn("McpStore.listVisibleServers")(
  (userId: string, channelId: string | undefined, teamId: string) =>
    Effect.gen(function* () {
      const scopes: McpScope[] = [
        { kind: "global", teamId },
        { kind: "user", userId, teamId },
      ]
      if (channelId) {
        scopes.push({ kind: "channel", channelId, teamId })
      }

      const configLists = yield* Effect.all(scopes.map(listServerConfigs), {
        concurrency: "unbounded",
      })
      const merged = new Map<string, McpServerConfig>()

      for (const configs of configLists) {
        for (const config of configs) {
          merged.set(config.name, config)
        }
      }

      return [...merged.values()]
    }),
)

export const removeServerConfig = Effect.fn("McpStore.removeServerConfig")(
  (scope: McpScope, serverName: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const deleted = yield* redis.del(configKey(scope, serverName))
      return deleted > 0
    }),
)

export const saveOAuthTokens = Effect.fn("McpStore.saveOAuthTokens")(
  (
    ownerId: string,
    serverName: string,
    tokens: OAuthTokens,
    teamId: string,
  ) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(JSON.stringify(tokens))
      yield* redis.set(oauthTokensKey(ownerId, serverName, teamId), encrypted)
    }),
)

export const loadOAuthTokens = Effect.fn("McpStore.loadOAuthTokens")(
  (ownerId: string, serverName: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const raw = yield* redis.get(oauthTokensKey(ownerId, serverName, teamId))
      if (!raw) return undefined
      const decrypted = yield* secureStore.decrypt(raw)
      if (!decrypted) return undefined
      return JSON.parse(decrypted) as OAuthTokens
    }),
)

export const saveOAuthClient = Effect.fn("McpStore.saveOAuthClient")(
  (
    ownerId: string,
    serverName: string,
    clientInfo: OAuthClientInformation,
    teamId: string,
  ) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(JSON.stringify(clientInfo))
      yield* redis.set(oauthClientKey(ownerId, serverName, teamId), encrypted)
    }),
)

export const loadOAuthClient = Effect.fn("McpStore.loadOAuthClient")(
  (ownerId: string, serverName: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const raw = yield* redis.get(oauthClientKey(ownerId, serverName, teamId))
      if (!raw) return undefined
      const decrypted = yield* secureStore.decrypt(raw)
      if (!decrypted) return undefined
      return JSON.parse(decrypted) as OAuthClientInformation
    }),
)

export const saveCodeVerifier = Effect.fn("McpStore.saveCodeVerifier")(
  (userId: string, serverName: string, verifier: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(verifier)
      yield* redis.set(
        pkceVerifierKey(userId, serverName, teamId),
        encrypted,
        "EX",
        PKCE_VERIFIER_TTL_SECONDS,
      )
    }),
)

export const loadCodeVerifier = Effect.fn("McpStore.loadCodeVerifier")(
  (userId: string, serverName: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const raw = yield* redis.get(pkceVerifierKey(userId, serverName, teamId))
      const decrypted = yield* secureStore.decrypt(raw)
      return decrypted ?? undefined
    }),
)

export const saveOAuthState = Effect.fn("McpStore.saveOAuthState")(
  (stateToken: string, payload: OAuthStatePayload) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(JSON.stringify(payload))
      yield* redis.set(
        oauthStateKey(stateToken),
        encrypted,
        "EX",
        OAUTH_STATE_TTL_SECONDS,
      )
    }),
)

export const consumeOAuthState = Effect.fn("McpStore.consumeOAuthState")(
  (stateToken: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const key = oauthStateKey(stateToken)
      const data = yield* redis.get(key)
      if (!data) return null
      yield* redis.del(key)
      const decrypted = yield* secureStore.decrypt(data)
      if (!decrypted) return null
      return JSON.parse(decrypted) as OAuthStatePayload
    }),
)

export const savePendingAuthUrl = Effect.fn("McpStore.savePendingAuthUrl")(
  (
    userId: string,
    serverName: string,
    authorizationUrl: string,
    teamId: string,
  ) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      // Shorter than OAUTH_STATE_TTL so this key expires before the
      // embedded state token does — prevents surfacing stale auth URLs.
      const encrypted = yield* secureStore.encrypt(authorizationUrl)
      yield* redis.set(
        pendingAuthUrlKey(userId, serverName, teamId),
        encrypted,
        "EX",
        PENDING_AUTH_URL_TTL_SECONDS,
      )
    }),
)

export const loadPendingAuthUrl = Effect.fn("McpStore.loadPendingAuthUrl")(
  (userId: string, serverName: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const raw = yield* redis.get(
        pendingAuthUrlKey(userId, serverName, teamId),
      )
      const decrypted = yield* secureStore.decrypt(raw)
      return decrypted ?? undefined
    }),
)

export const clearPendingAuthUrl = Effect.fn("McpStore.clearPendingAuthUrl")(
  (userId: string, serverName: string, teamId: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      yield* redis.del(pendingAuthUrlKey(userId, serverName, teamId))
    }),
)

export const clearOAuthArtifacts = Effect.fn("McpStore.clearOAuthArtifacts")(
  (
    userId: string,
    serverName: string,
    teamId: string,
    tokenOwnerId?: string,
  ) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const keysToDelete = [
        oauthTokensKey(userId, serverName, teamId),
        oauthClientKey(userId, serverName, teamId),
        pkceVerifierKey(userId, serverName, teamId),
        pendingAuthUrlKey(userId, serverName, teamId),
      ]

      if (tokenOwnerId && tokenOwnerId !== userId) {
        keysToDelete.push(
          oauthTokensKey(tokenOwnerId, serverName, teamId),
          oauthClientKey(tokenOwnerId, serverName, teamId),
        )
      }

      yield* redis.del(...keysToDelete)
    }),
)

export const saveOAuthAuthorizationLink = Effect.fn(
  "McpStore.saveOAuthAuthorizationLink",
)(
  (linkToken: string, payload: OAuthAuthorizationLinkPayload) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      const encrypted = yield* secureStore.encrypt(JSON.stringify(payload))
      yield* redis.set(
        oauthAuthorizationLinkKey(linkToken),
        encrypted,
        "EX",
        OAUTH_STATE_TTL_SECONDS,
      )
    }),
)

export const loadOAuthAuthorizationLink = Effect.fn(
  "McpStore.loadOAuthAuthorizationLink",
)(
  (linkToken: string) =>
    Effect.gen(function* () {
      const redis = yield* Redis
      const secureStore = yield* SecureStore
      // GETDEL — link tokens are single-use to shrink the replay window if the
      // ?token=... in the URL leaks (browser history, referrer, proxy logs).
      const raw = yield* redis.getdel(oauthAuthorizationLinkKey(linkToken))
      const decrypted = yield* secureStore.decrypt(raw)
      if (!decrypted) return null
      return JSON.parse(decrypted) as OAuthAuthorizationLinkPayload
    }),
)

const run = <T>(effect: Effect.Effect<T, any, any>): Promise<T> =>
  appRuntime.runPromise(effect)

export const saveServerConfigAsync = (...args: Parameters<typeof saveServerConfig>) => run(saveServerConfig(...args))
export const getServerConfigAsync = (...args: Parameters<typeof getServerConfig>) => run(getServerConfig(...args))
export const listVisibleServersAsync = (...args: Parameters<typeof listVisibleServers>) => run(listVisibleServers(...args))
export const removeServerConfigAsync = (...args: Parameters<typeof removeServerConfig>) => run(removeServerConfig(...args))
export const saveOAuthTokensAsync = (...args: Parameters<typeof saveOAuthTokens>) => run(saveOAuthTokens(...args))
export const loadOAuthTokensAsync = (...args: Parameters<typeof loadOAuthTokens>) => run(loadOAuthTokens(...args))
export const saveOAuthClientAsync = (...args: Parameters<typeof saveOAuthClient>) => run(saveOAuthClient(...args))
export const loadOAuthClientAsync = (...args: Parameters<typeof loadOAuthClient>) => run(loadOAuthClient(...args))
export const saveCodeVerifierAsync = (...args: Parameters<typeof saveCodeVerifier>) => run(saveCodeVerifier(...args))
export const loadCodeVerifierAsync = (...args: Parameters<typeof loadCodeVerifier>) => run(loadCodeVerifier(...args))
export const saveOAuthStateAsync = (...args: Parameters<typeof saveOAuthState>) => run(saveOAuthState(...args))
export const consumeOAuthStateAsync = (...args: Parameters<typeof consumeOAuthState>) => run(consumeOAuthState(...args))
export const savePendingAuthUrlAsync = (...args: Parameters<typeof savePendingAuthUrl>) => run(savePendingAuthUrl(...args))
export const loadPendingAuthUrlAsync = (...args: Parameters<typeof loadPendingAuthUrl>) => run(loadPendingAuthUrl(...args))
export const clearPendingAuthUrlAsync = (...args: Parameters<typeof clearPendingAuthUrl>) => run(clearPendingAuthUrl(...args))
export const clearOAuthArtifactsAsync = (...args: Parameters<typeof clearOAuthArtifacts>) => run(clearOAuthArtifacts(...args))
export const saveOAuthAuthorizationLinkAsync = (...args: Parameters<typeof saveOAuthAuthorizationLink>) => run(saveOAuthAuthorizationLink(...args))
export const loadOAuthAuthorizationLinkAsync = (...args: Parameters<typeof loadOAuthAuthorizationLink>) => run(loadOAuthAuthorizationLink(...args))
