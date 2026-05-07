import { loadOAuthAuthorizationLinkAsync } from "@/server/mcp/store";

import { AuthorizationStartExpiredView, AuthorizationStartView } from "./view";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MCP Authorization · Pookie",
  robots: { index: false, follow: false },
};

interface AuthorizationStartPageProps {
  searchParams: Promise<{ token?: string }>;
}

const AuthorizationStartPage = async ({
  searchParams,
}: AuthorizationStartPageProps) => {
  const { token } = await searchParams;

  if (!token) {
    return (
      <AuthorizationStartExpiredView message="Missing authorization link token. Return to Slack and run `/mcp status` to get a fresh link." />
    );
  }

  const payload = await loadOAuthAuthorizationLinkAsync(token);
  if (!payload) {
    return (
      <AuthorizationStartExpiredView message="This authorization link expired. Return to Slack and run `/mcp status` to get a fresh link." />
    );
  }

  return (
    <AuthorizationStartView
      serverName={payload.serverName}
      authorizationUrl={payload.authorizationUrl}
    />
  );
};

export default AuthorizationStartPage;
