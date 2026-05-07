import { Effect, Layer, ServiceMap } from "effect"

import {
  REAUTH_NOTICE_TTL_SECONDS,
  THREAD_LOCK_TTL_SECONDS,
} from "./constants"

import { Redis } from "../infra/redis"

export interface QueuedFollowUp {
  messageId: string
  text: string
}

const lockKey = (threadId: string): string => `pookie:gen-lock:${threadId}`

const queueKey = (threadId: string): string => `pookie:followups:${threadId}`

// Reverse-mapping so onMessageDeleted can locate which thread queue a
// message was enqueued into, given only channelId + messageTs.
const followUpRefKey = (channelId: string, messageTs: string): string =>
  `pookie:followup-ref:${channelId}:${messageTs}`

const reauthNoticeKey = (threadId: string, userId: string): string =>
  `pookie:reauth-notice:${threadId}:${userId}`

const parseFollowUp = (raw: unknown): QueuedFollowUp | null => {
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.messageId === "string" &&
      typeof parsed.text === "string"
    ) {
      return { messageId: parsed.messageId, text: parsed.text }
    }
    return null
  } catch {
    return null
  }
}

export class ThreadLock extends ServiceMap.Service<ThreadLock>()(
  "@pookie/ThreadLock",
  {
    make: Effect.gen(function* () {
      const redis = yield* Redis

      const removeFollowUpByMessageId = (
        threadId: string,
        messageId: string,
      ) =>
        Effect.gen(function* () {
          const key = queueKey(threadId)
          const items = yield* redis.lrange(key, 0, -1)
          for (const rawItem of items) {
            try {
              const parsed = parseFollowUp(rawItem)
              if (parsed && parsed.messageId === messageId) {
                // LREM removes the first occurrence of the exact serialized value
                yield* redis.lrem(key, 1, rawItem)
                return
              }
            } catch {
              // Skip unparseable items
            }
          }
        })

      return {
        acquire: Effect.fn("ThreadLock.acquire")(
          (threadId: string) =>
            redis.setNx(lockKey(threadId), "1", THREAD_LOCK_TTL_SECONDS),
        ),

        release: Effect.fn("ThreadLock.release")((threadId: string) =>
          Effect.gen(function* () {
            yield* redis.del(lockKey(threadId))
          }),
        ),

        enqueueFollowUp: Effect.fn("ThreadLock.enqueueFollowUp")(
          (
            threadId: string,
            channelId: string,
            followUp: QueuedFollowUp,
          ) =>
            Effect.gen(function* () {
              const key = queueKey(threadId)
              yield* redis.rpush(key, JSON.stringify(followUp))
              yield* redis.expire(key, THREAD_LOCK_TTL_SECONDS)
              yield* redis.set(
                followUpRefKey(channelId, followUp.messageId),
                threadId,
                "EX",
                THREAD_LOCK_TTL_SECONDS,
              )
            }),
        ),

        removeDeletedFollowUp: Effect.fn("ThreadLock.removeDeletedFollowUp")(
          (channelId: string, deletedTs: string) =>
            Effect.gen(function* () {
              const refKey = followUpRefKey(channelId, deletedTs)
              const threadId = yield* redis.get(refKey)
              if (!threadId) return
              yield* removeFollowUpByMessageId(threadId, deletedTs)
              yield* redis.del(refKey)
            }),
        ),

        // Uses LTRIM instead of DEL so a message RPUSHed between the LRANGE
        // and the trim is preserved rather than silently dropped.
        drainFollowUps: Effect.fn("ThreadLock.drainFollowUps")(
          (threadId: string) =>
            Effect.gen(function* () {
              const key = queueKey(threadId)
              const items = yield* redis.lrange(key, 0, -1)
              if (items.length > 0) yield* redis.ltrim(key, items.length, -1)

              return items
                .map((rawItem) => {
                  const parsed = parseFollowUp(rawItem)
                  return parsed?.text
                })
                .filter(
                  (text): text is string =>
                    typeof text === "string" && text.length > 0,
                )
            }),
        ),

        tryMarkReauthNoticeSent: Effect.fn("ThreadLock.tryMarkReauthNoticeSent")(
          (threadId: string, userId: string) =>
            redis.setNx(
              reauthNoticeKey(threadId, userId),
              "1",
              REAUTH_NOTICE_TTL_SECONDS,
            ),
        ),
      }
    }),
  },
) {
  static layer = Layer.effect(this)(this.make)
}
