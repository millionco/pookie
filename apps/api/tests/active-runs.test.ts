import { Effect, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"

import { ActiveRuns } from "../server/agent/active-runs"

const testRuntime = ManagedRuntime.make(ActiveRuns.layer)

const register = (channelId: string, messageTs: string) =>
  testRuntime.runPromise(
    Effect.gen(function* () {
      const activeRuns = yield* ActiveRuns
      return yield* activeRuns.register(channelId, messageTs)
    }),
  )

const abort = (channelId: string, messageTs: string) =>
  testRuntime.runPromise(
    Effect.gen(function* () {
      const activeRuns = yield* ActiveRuns
      return yield* activeRuns.abort(channelId, messageTs)
    }),
  )

const cleanup = (channelId: string, messageTs: string) =>
  testRuntime.runPromise(
    Effect.gen(function* () {
      const activeRuns = yield* ActiveRuns
      return yield* activeRuns.cleanup(channelId, messageTs)
    }),
  )

describe("registerActiveRun", () => {
  it("returns an AbortController whose signal starts un-aborted", async () => {
    const controller = await register("C001", "1700000000.000001")
    expect(controller.signal.aborted).toBe(false)
    await cleanup("C001", "1700000000.000001")
  })

  it("aborts a previously registered run for the same key", async () => {
    const first = await register("C002", "1700000000.000002")
    const second = await register("C002", "1700000000.000002")

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)

    await cleanup("C002", "1700000000.000002")
  })
})

describe("abortActiveRun", () => {
  it("aborts a registered run and returns true", async () => {
    const controller = await register("C003", "1700000000.000003")
    const didAbort = await abort("C003", "1700000000.000003")

    expect(didAbort).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it("returns false when no run is registered for the key", async () => {
    const didAbort = await abort("C999", "9999999999.999999")
    expect(didAbort).toBe(false)
  })

  it("returns false on a second abort for the same key", async () => {
    await register("C004", "1700000000.000004")
    await abort("C004", "1700000000.000004")

    const secondAbort = await abort("C004", "1700000000.000004")
    expect(secondAbort).toBe(false)
  })
})

describe("cleanupActiveRun", () => {
  it("removes the run so a subsequent abort returns false", async () => {
    await register("C005", "1700000000.000005")
    await cleanup("C005", "1700000000.000005")

    const didAbort = await abort("C005", "1700000000.000005")
    expect(didAbort).toBe(false)
  })

  it("is a no-op for keys that were never registered", async () => {
    await expect(cleanup("C999", "9999999999.999999")).resolves.not.toThrow()
  })
})

describe("isolation across different keys", () => {
  it("does not cross-abort runs in different channels", async () => {
    const runA = await register("C010", "1700000000.000010")
    const runB = await register("C011", "1700000000.000010")

    await abort("C010", "1700000000.000010")

    expect(runA.signal.aborted).toBe(true)
    expect(runB.signal.aborted).toBe(false)

    await cleanup("C011", "1700000000.000010")
  })

  it("does not cross-abort runs with different message timestamps", async () => {
    const runA = await register("C012", "1700000000.000001")
    const runB = await register("C012", "1700000000.000002")

    await abort("C012", "1700000000.000001")

    expect(runA.signal.aborted).toBe(true)
    expect(runB.signal.aborted).toBe(false)

    await cleanup("C012", "1700000000.000002")
  })
})
