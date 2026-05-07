import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"

import { Redis } from "../server/infra/redis"
import { ThreadLock } from "../server/agent/thread-lock"

const createTestContext = () => {
  const store = new Map<string, string>()
  const lists = new Map<string, string[]>()

  const fakeRedisLayer = Layer.effect(Redis)(
    Effect.sync(() => ({
      get: (key: string) =>
        Effect.sync(() => (store.get(key) as string | null) ?? null),
      set: (key: string, value: string, ..._args: Array<string | number>) =>
        Effect.sync(() => {
          store.set(key, value)
          return "OK"
        }),
      setNx: (key: string, value: string, _ttlSeconds: number) =>
        Effect.sync(() => {
          if (store.has(key)) return false
          store.set(key, value)
          return true
        }),
      del: (...keys: string[]) =>
        Effect.sync(() => {
          let deleted = 0
          for (const key of keys) {
            if (store.delete(key)) deleted++
            lists.delete(key)
          }
          return deleted
        }),
      getdel: (key: string) =>
        Effect.sync(() => {
          const value = (store.get(key) as string | null) ?? null
          store.delete(key)
          return value
        }),
      rpush: (key: string, ...values: string[]) =>
        Effect.sync(() => {
          const list = lists.get(key) ?? []
          list.push(...values)
          lists.set(key, list)
          return list.length
        }),
      expire: (_key: string, _seconds: number) => Effect.succeed(1),
      lrange: (key: string, _start: number, _stop: number) =>
        Effect.sync(() => [...(lists.get(key) ?? [])]),
      ltrim: (key: string, start: number, _stop: number) =>
        Effect.sync(() => {
          const list = lists.get(key) ?? []
          lists.set(key, list.slice(start))
          return "OK" as const
        }),
      lrem: (key: string, count: number, value: string) =>
        Effect.sync(() => {
          const list = lists.get(key) ?? []
          let removed = 0
          const remaining: string[] = []
          for (const item of list) {
            if (removed < Math.abs(count) && item === value) removed++
            else remaining.push(item)
          }
          lists.set(key, remaining)
          return removed
        }),
      scan: () => Effect.succeed(["0", []] as [string, string[]]),
      pipeline: () => {
        throw new Error("pipeline not implemented in test fake")
      },
      raw: null as never,
    })),
  )

  const testLayer = ThreadLock.layer.pipe(Layer.provide(fakeRedisLayer))

  const provide = <T>(effect: Effect.Effect<T, unknown, ThreadLock>) =>
    Effect.runPromise(effect.pipe(Effect.provide(testLayer)))

  const acquire = (threadId: string) =>
    provide(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        return yield* threadLock.acquire(threadId)
      }),
    )

  const release = (threadId: string) =>
    provide(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        return yield* threadLock.release(threadId)
      }),
    )

  const enqueue = (
    threadId: string,
    channelId: string,
    followUp: { messageId: string; text: string },
  ) =>
    provide(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        return yield* threadLock.enqueueFollowUp(threadId, channelId, followUp)
      }),
    )

  const drain = (threadId: string) =>
    provide(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        return yield* threadLock.drainFollowUps(threadId)
      }),
    )

  const removeDeleted = (channelId: string, deletedTs: string) =>
    provide(
      Effect.gen(function* () {
        const threadLock = yield* ThreadLock
        return yield* threadLock.removeDeletedFollowUp(channelId, deletedTs)
      }),
    )

  return { acquire, release, enqueue, drain, removeDeleted, store, lists }
}

describe("acquire", () => {
  it("acquires the lock on first call", async () => {
    const { acquire } = createTestContext()
    const acquired = await acquire("thread-1")
    expect(acquired).toBe(true)
  })

  it("rejects a second acquisition for the same thread", async () => {
    const { acquire } = createTestContext()
    await acquire("thread-1")
    const second = await acquire("thread-1")
    expect(second).toBe(false)
  })

  it("allows acquisition for different threads", async () => {
    const { acquire } = createTestContext()
    const first = await acquire("thread-1")
    const second = await acquire("thread-2")
    expect(first).toBe(true)
    expect(second).toBe(true)
  })
})

describe("release", () => {
  it("releases the lock so a new acquisition succeeds", async () => {
    const { acquire, release } = createTestContext()
    await acquire("thread-1")
    await release("thread-1")
    const reacquired = await acquire("thread-1")
    expect(reacquired).toBe(true)
  })
})

describe("enqueueFollowUp", () => {
  it("pushes a follow-up onto the thread queue", async () => {
    const { enqueue, lists } = createTestContext()
    await enqueue("thread-1", "C123", { messageId: "msg-1", text: "hello" })
    await enqueue("thread-1", "C123", { messageId: "msg-2", text: "world" })

    const queued = lists.get("pookie:followups:thread-1") ?? []
    expect(queued).toHaveLength(2)
    expect(JSON.parse(queued[0]!)).toEqual({
      messageId: "msg-1",
      text: "hello",
    })
  })

  it("stores a reverse-mapping ref for delete lookups", async () => {
    const { enqueue, store } = createTestContext()
    await enqueue("thread-1", "C123", { messageId: "msg-1", text: "hello" })
    expect(store.get("pookie:followup-ref:C123:msg-1")).toBe("thread-1")
  })
})

describe("drainFollowUps", () => {
  it("returns all queued message texts and clears them", async () => {
    const { enqueue, drain } = createTestContext()
    await enqueue("thread-1", "C123", { messageId: "a", text: "text-a" })
    await enqueue("thread-1", "C123", { messageId: "b", text: "text-b" })
    await enqueue("thread-1", "C123", { messageId: "c", text: "text-c" })

    const drained = await drain("thread-1")
    expect(drained).toEqual(["text-a", "text-b", "text-c"])

    const second = await drain("thread-1")
    expect(second).toEqual([])
  })

  it("returns an empty array when no messages are queued", async () => {
    const { drain } = createTestContext()
    const drained = await drain("thread-1")
    expect(drained).toEqual([])
  })
})

describe("removeDeletedFollowUp", () => {
  it("removes a queued follow-up by channelId + messageTs", async () => {
    const { enqueue, drain, removeDeleted } = createTestContext()
    await enqueue("thread-1", "C123", {
      messageId: "msg-to-delete",
      text: "should be gone",
    })
    await enqueue("thread-1", "C123", {
      messageId: "msg-keep",
      text: "should stay",
    })

    await removeDeleted("C123", "msg-to-delete")

    const drained = await drain("thread-1")
    expect(drained).toEqual(["should stay"])
  })

  it("is a no-op when the message was not enqueued", async () => {
    const { enqueue, drain, removeDeleted } = createTestContext()
    await enqueue("thread-1", "C123", { messageId: "msg-1", text: "stays" })

    await removeDeleted("C123", "msg-unknown")

    const drained = await drain("thread-1")
    expect(drained).toEqual(["stays"])
  })

  it("cleans up the reverse-mapping ref key", async () => {
    const { enqueue, removeDeleted, store } = createTestContext()
    await enqueue("thread-1", "C123", { messageId: "msg-1", text: "text" })

    expect(store.has("pookie:followup-ref:C123:msg-1")).toBe(true)
    await removeDeleted("C123", "msg-1")
    expect(store.has("pookie:followup-ref:C123:msg-1")).toBe(false)
  })
})
