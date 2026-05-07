import { Effect, Schema } from "effect"

import { ConfigError, RedisError } from "../errors"
import { Redis } from "../infra/redis"
import { POOKIE_CONFIG_PREFIX } from "./constants"
import { PookieConfigPartialSchema } from "./schema"

import type { PookieConfigPartial, PookieConfigScope } from "./schema"

const configKey = (scope: PookieConfigScope): string => {
  switch (scope.kind) {
    case "global":
      return `${POOKIE_CONFIG_PREFIX}:${scope.teamId}:global`
    case "channel":
      return `${POOKIE_CONFIG_PREFIX}:${scope.teamId}:channel:${scope.channelId}`
    case "user":
      return `${POOKIE_CONFIG_PREFIX}:${scope.teamId}:user:${scope.userId}`
  }
}

const decodePartialConfig = Schema.decodeUnknownEffect(PookieConfigPartialSchema)

const parseStoredConfig = (
  raw: string | null,
  key: string,
): Effect.Effect<PookieConfigPartial, ConfigError> =>
  Effect.gen(function* () {
    if (!raw) return {}

    const deserialized = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (parseError) => {
        console.warn("[pookie-config] failed to parse stored config", {
          key,
          error: parseError,
        })
        return new ConfigError({ key })
      },
    }).pipe(Effect.catchTag("ConfigError", () => Effect.succeed(null)))

    if (deserialized === null) return {}

    const decoded = yield* decodePartialConfig(deserialized).pipe(
      Effect.catchTag("SchemaError", (decodeError) => {
        // Stored value didn't match the current schema — possibly a schema
        // migration, a hand-edited redis value, or a corrupted write. Log
        // enough to diagnose without leaking a huge blob, and fall back to
        // defaults rather than failing the whole turn.
        const preview = raw.slice(0, 120)
        console.warn("[pookie-config] stored config failed schema validation", {
          key,
          preview,
          issues: decodeError.message.slice(0, 200),
        })
        return Effect.succeed({} as PookieConfigPartial)
      }),
    )

    return decoded
  })

export const loadConfigForScope = Effect.fn("Config.loadConfigForScope")(
  function* (scope: PookieConfigScope) {
    const redis = yield* Redis
    const key = configKey(scope)
    const raw = yield* redis.get(key)
    return yield* parseStoredConfig(raw, key)
  },
)

export const saveConfigForScope = Effect.fn("Config.saveConfigForScope")(
  function* (scope: PookieConfigScope, partial: PookieConfigPartial) {
    const redis = yield* Redis
    const key = configKey(scope)
    if (Object.keys(partial).length === 0) {
      yield* redis.del(key)
      return
    }
    yield* redis.set(key, JSON.stringify(partial))
  },
)

export const clearConfigForScope = Effect.fn("Config.clearConfigForScope")(
  function* (scope: PookieConfigScope) {
    const redis = yield* Redis
    const deleted = yield* redis.del(configKey(scope))
    return deleted > 0
  },
)
