import { Effect } from "effect"

import { Redis } from "../../infra/redis"

const ONBOARDING_KEY_PREFIX = "pookie:onboarding:user"

export const ONBOARDING_WINDOW_MS = 24 * 60 * 60 * 1000

// Floor of 1s so we never accidentally pass `ex: 0` (which Upstash treats
// as a no-op TTL on some clients) when a write lands at the very edge of
// the window.
const MIN_TTL_SECONDS = 1

export interface OnboardingState {
  startedAt: number
  teamId: string
  channelId: string
  connectedPresets: string[]
}

const onboardingKey = (userId: string): string =>
  `${ONBOARDING_KEY_PREFIX}:${userId}`

export const loadOnboardingState = (
  userId: string,
) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    const data = yield* redis.get(onboardingKey(userId))
    if (!data) return undefined
    return JSON.parse(data) as OnboardingState
  }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )

export const saveOnboardingState = (
  userId: string,
  state: OnboardingState,
) =>
  Effect.gen(function* () {
    const redis = yield* Redis
    // Anchor the TTL to `startedAt` (not to "now") so per-connection
    // updates inside the window don't keep extending the key's lifetime.
    // Without this, every OAuth callback inside the window resets the TTL
    // to a fresh 24h, which keeps `autoStartOnboardingIfFirstInvite`
    // suppressed indefinitely after the *original* window has elapsed.
    const expiresAtMs = state.startedAt + ONBOARDING_WINDOW_MS
    const remainingSeconds = Math.max(
      MIN_TTL_SECONDS,
      Math.floor((expiresAtMs - Date.now()) / 1000),
    )
    yield* redis.set(
      onboardingKey(userId),
      JSON.stringify(state),
      "EX",
      remainingSeconds,
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("[onboarding] failed to save state").pipe(
        Effect.annotateLogs({ error: String(cause) }),
      ),
    ),
  )

export const isWithinOnboardingWindow = (
  state: OnboardingState,
  now: number,
): boolean => now - state.startedAt < ONBOARDING_WINDOW_MS
