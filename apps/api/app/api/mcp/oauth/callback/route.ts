import { after } from "next/server";

import { finishOAuthAsync } from "@/server/mcp/client";
import { notifyMcpAuthSuccess } from "@/server/mcp/notify-auth-success";
import { applyOnboardingConnection } from "@/server/slack/onboarding/orchestrator";

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(renderHtml("Missing code or state parameter", false), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    const { userId, serverName, channelId, teamId } = await finishOAuthAsync({
      code,
      state,
    });

    notifyMcpAuthSuccess({ userId, channelId, serverName, teamId });

    after(() =>
      applyOnboardingConnection(userId, serverName).catch((error: unknown) =>
        console.error("[onboarding] connection apply failed", error),
      ),
    );

    return new Response(
      renderHtml(
        `Connected to <strong>${escapeHtml(serverName)}</strong>! You can close this tab and return to Slack.`,
        true,
      ),
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error during OAuth";
    console.error("[mcp-oauth-callback]", error);

    return new Response(renderHtml(escapeHtml(message), false), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderHtml = (
  message: string,
  isSuccess: boolean,
): string => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP ${isSuccess ? "Connected" : "Error"}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fafafa; color: #333; }
    .card { background: white; border-radius: 12px; padding: 2rem; max-width: 400px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isSuccess ? "✅" : "❌"}</div>
    <p>${message}</p>
  </div>
</body>
</html>`;
