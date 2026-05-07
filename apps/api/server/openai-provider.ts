import { createOpenAI } from "@ai-sdk/openai"
import { createWebSocketFetch } from "ai-sdk-openai-websocket-fetch"

// Each call gets its own WebSocket connection. A shared singleton causes a
// race condition: two concurrent streamText calls both see `busy = false`
// across the await in getConnection, attach onMessage handlers to the same
// socket, and receive each other's streamed tokens — swapping responses.
export const createProvider = () =>
  createOpenAI({ fetch: createWebSocketFetch() })
