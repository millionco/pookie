import path from "node:path";

import type { NextConfig } from "next";
import "./env";

// Standalone output is for Docker / Railway / Fly / Cloud Run / VPS only —
// it produces .next/standalone with a server.js entry the Dockerfile copies.
// On Vercel, leave `output` unset so Vercel's adapter packages routes into
// Lambda/Edge functions natively. The Dockerfile sets BUILD_STANDALONE=1.

const nextConfig: NextConfig = {
  ...(process.env.BUILD_STANDALONE ? { output: "standalone" as const } : {}),
  outputFileTracingRoot: path.join(__dirname, "../.."),
  allowedDevOrigins: ["reusable-parrot-swipe.ngrok-free.dev"],
  outputFileTracingIncludes: {
    "/install.md": ["./docs/install.md"],
    "/install": ["./docs/install.md"],
    "/docs/[slug]": [
      "./docs/quickstart-managed.md",
      "./docs/quickstart-self-hosted.md",
    ],
    "/docs/[slug]/raw": [
      "./docs/quickstart-managed.md",
      "./docs/quickstart-self-hosted.md",
    ],
  },
  headers: async () => {
    const varyAccept = ["/", "/install", "/docs/:slug"];
    return [
      // so the agent can read it as markdown (text/markdown header)
      ...varyAccept.map((source) => ({
        source,
        headers: [{ key: "Vary", value: "Accept" }],
      })),
      {
        source: "/mcp/oauth/start/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The /a/:token route renders untrusted, model-generated HTML inside a
      // sandboxed iframe (sandbox="allow-scripts" only — no allow-same-origin).
      // The outer page itself stays minimal: just an iframe wrapper. Prevent
      // other origins from framing the wrapper so a clickjacker can't trick a
      // signed-in user into interacting with the embedded app.
      {
        source: "/a/:token",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
  rewrites: async () => {
    const markdownNegotiable = [
      { source: "/", destination: "/llms.txt" },
      { source: "/install", destination: "/install.md" },
      { source: "/docs/:slug", destination: "/docs/:slug/raw" },
    ];
    return {
      beforeFiles: [
        ...markdownNegotiable.map(({ source, destination }) => ({
          source,
          destination,
          has: [
            {
              type: "header" as const,
              key: "accept",
              value: "(.*)text/markdown(.*)",
            },
          ],
        })),
        {
          source: "/llm.txt",
          destination: "/llms.txt",
        },
      ],
    };
  },
};

export default nextConfig;
