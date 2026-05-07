import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Layer } from "effect"
import * as Otlp from "effect/unstable/observability/Otlp"

import { env } from "@/env"

const parseOtelHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {}
  return Object.fromEntries(
    raw.split(",").map((pair) => {
      const separatorIndex = pair.indexOf("=")
      if (separatorIndex === -1) return [pair.trim(), ""]
      return [pair.slice(0, separatorIndex).trim(), pair.slice(separatorIndex + 1).trim()]
    }),
  )
}

export const layer = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? Otlp.layerJson({
      baseUrl: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      resource: { serviceName: env.OTEL_SERVICE_NAME ?? "pookie" },
      headers: parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  : Layer.empty
