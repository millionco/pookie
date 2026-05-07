import { Layer } from "effect"

import * as Observability from "./observability"
import { OpenAIProvider } from "./openai-provider"
import { Redis } from "./redis"
import { SecureStore } from "./secure-store"

export { OpenAIProvider } from "./openai-provider"
export { Redis } from "./redis"
export { SecureStore } from "./secure-store"

export const InfraLayer = Layer.mergeAll(
  Redis.layer,
  SecureStore.layer,
  Observability.layer,
  OpenAIProvider.layer,
)
