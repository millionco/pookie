import { Layer, ManagedRuntime } from "effect"

import { ActiveRuns } from "./agent/active-runs"
import { ThreadLock } from "./agent/thread-lock"
import { InfraLayer } from "./infra"

const DomainLayer = Layer.mergeAll(
  ThreadLock.layer,
  ActiveRuns.layer,
)

export const AppLayer = DomainLayer.pipe(
  Layer.provideMerge(InfraLayer),
)

export const appRuntime = ManagedRuntime.make(AppLayer)
