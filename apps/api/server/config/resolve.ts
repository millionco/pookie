import { Effect } from "effect"

import { POOKIE_CONFIG_DEFAULTS } from "./defaults"
import { loadConfigForScope } from "./store"

import type {
  PookieConfig,
  PookieConfigKey,
  PookieConfigPartial,
  PookieConfigScopeKind,
} from "./schema"

export interface ResolvedPookieConfig {
  config: PookieConfig
  sources: Record<PookieConfigKey, PookieConfigScopeKind | "default">
  layers: {
    user: PookieConfigPartial
    channel: PookieConfigPartial
    global: PookieConfigPartial
  }
}

const configKeys = Object.keys(POOKIE_CONFIG_DEFAULTS) as PookieConfigKey[]

const pickLayered = (
  key: PookieConfigKey,
  layers: ResolvedPookieConfig["layers"],
): {
  value: PookieConfig[PookieConfigKey]
  source: PookieConfigScopeKind | "default"
} => {
  if (layers.user[key] !== undefined) {
    return { value: layers.user[key]!, source: "user" }
  }
  if (layers.channel[key] !== undefined) {
    return { value: layers.channel[key]!, source: "channel" }
  }
  if (layers.global[key] !== undefined) {
    return { value: layers.global[key]!, source: "global" }
  }
  return { value: POOKIE_CONFIG_DEFAULTS[key], source: "default" }
}

export const mergeLayers = (
  layers: ResolvedPookieConfig["layers"],
): ResolvedPookieConfig => {
  const config = { ...POOKIE_CONFIG_DEFAULTS }
  const sources = {} as Record<
    PookieConfigKey,
    PookieConfigScopeKind | "default"
  >

  for (const key of configKeys) {
    const { value, source } = pickLayered(key, layers)
    // Index signature on PookieConfig is uniform-by-key; the type system
    // can't narrow value back to the per-key type, so this assignment is the
    // one place we accept a broader cast.
    ;(config as Record<PookieConfigKey, PookieConfig[PookieConfigKey]>)[key] =
      value
    sources[key] = source
  }

  return { config, sources, layers }
}

export const resolveConfig = Effect.fn("Config.resolveConfig")(
  function* (input: {
    teamId: string
    userId?: string
    channelId?: string
  }) {
    const [global, channel, user] = yield* Effect.all([
      loadConfigForScope({ kind: "global", teamId: input.teamId }),
      input.channelId && input.channelId !== "unknown"
        ? loadConfigForScope({
            kind: "channel",
            channelId: input.channelId,
            teamId: input.teamId,
          })
        : Effect.succeed<PookieConfigPartial>({}),
      input.userId && input.userId !== "unknown"
        ? loadConfigForScope({
            kind: "user",
            userId: input.userId,
            teamId: input.teamId,
          })
        : Effect.succeed<PookieConfigPartial>({}),
    ], { concurrency: "unbounded" })

    return mergeLayers({ user, channel, global })
  },
)
