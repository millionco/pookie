import { createOpenAI } from "@ai-sdk/openai"
import { Effect, Layer, ServiceMap } from "effect"
import { createWebSocketFetch } from "ai-sdk-openai-websocket-fetch"

export class OpenAIProvider extends ServiceMap.Service<OpenAIProvider>()("@pookie/OpenAIProvider", {
  make: Effect.sync(() => ({
    // Each call gets its own WebSocket connection. A shared singleton causes a
    // race condition: two concurrent streamText calls both see `busy = false`
    // across the await in getConnection, attach onMessage handlers to the same
    // socket, and receive each other's streamed tokens — swapping responses.
    create: () => Effect.sync(() => createOpenAI({ fetch: createWebSocketFetch() })),
  })),
}) {
  static layer = Layer.effect(this)(this.make)
}
