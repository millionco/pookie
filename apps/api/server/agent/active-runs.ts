import { Effect, Layer, ServiceMap } from "effect"

const runKey = (channelId: string, messageTs: string): string =>
  `${channelId}:${messageTs}`

export class ActiveRuns extends ServiceMap.Service<ActiveRuns>()(
  "@pookie/ActiveRuns",
  {
    make: Effect.sync(() => {
      const activeRuns = new Map<string, AbortController>()

      return {
        register: (channelId: string, messageTs: string) =>
          Effect.sync(() => {
            const key = runKey(channelId, messageTs)
            const existing = activeRuns.get(key)
            if (existing) {
              existing.abort()
            }

            const controller = new AbortController()
            activeRuns.set(key, controller)
            return controller
          }),

        abort: (channelId: string, messageTs: string) =>
          Effect.gen(function* () {
            const key = runKey(channelId, messageTs)
            const controller = activeRuns.get(key)
            if (!controller) return false

            yield* Effect.logInfo(
              "[active-runs] aborting run for deleted message",
            ).pipe(Effect.annotateLogs({ channelId, messageTs }))

            controller.abort()
            activeRuns.delete(key)
            return true
          }),

        cleanup: (channelId: string, messageTs: string) =>
          Effect.sync(() => {
            activeRuns.delete(runKey(channelId, messageTs))
          }),
      }
    }),
  },
) {
  static layer = Layer.effect(this)(this.make)
}
