import { env } from "@/env";

import {
  GITHUB_OAUTH_AUTHORIZE_URL,
  GITHUB_OAUTH_CALLBACK_PATH,
  GITHUB_OAUTH_SCOPES,
  GITHUB_OAUTH_TOKEN_URL,
} from "./constants";
import {
  consumeOAuthStateAsync,
  getServerConfigAsync,
  loadCodeVerifierAsync,
  saveCodeVerifierAsync,
  saveOAuthStateAsync,
  saveServerConfigAsync,
} from "./store";

import type { McpScope, McpServerConfig } from "./store";

export const isGitHubOAuthConfigured = (): boolean =>
  Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

const generateCodeVerifier = (): string => {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
};

const base64UrlEncode = (buffer: Uint8Array): string =>
  Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const computeCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
};

export const buildGitHubAuthorizationUrl = (
  state: string,
  codeChallenge: string,
): string => {
  const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", githubCallbackUrl());
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

const githubCallbackUrl = (): string =>
  new URL(GITHUB_OAUTH_CALLBACK_PATH, env.BASE_URL).toString();

export const exchangeGitHubCode = async (
  code: string,
  codeVerifier: string,
): Promise<string> => {
  const response = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: githubCallbackUrl(),
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? "No access_token in response",
    );
  }

  return data.access_token;
};

export interface InitiateGitHubOAuthResult {
  authorizationUrl: string;
}

export const initiateGitHubOAuth = async (
  userId: string,
  serverName: string,
  channelId: string | undefined,
  teamId: string,
): Promise<InitiateGitHubOAuthResult> => {
  const stateToken = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  await Promise.all([
    saveOAuthStateAsync(stateToken, { userId, serverName, channelId, teamId }),
    saveCodeVerifierAsync(userId, serverName, codeVerifier, teamId),
  ]);

  const authorizationUrl = buildGitHubAuthorizationUrl(
    stateToken,
    codeChallenge,
  );
  return { authorizationUrl };
};

const findConfigByName = async (
  userId: string,
  serverName: string,
  channelId: string | undefined,
  teamId: string,
): Promise<McpServerConfig | null> => {
  const scopes: McpScope[] = [
    { kind: "user", userId, teamId },
    { kind: "global", teamId },
  ];

  if (channelId) {
    scopes.push({ kind: "channel", channelId, teamId });
  }

  for (const scope of scopes) {
    const config = await getServerConfigAsync(scope, serverName);
    if (config) return config;
  }

  return null;
};

export const finishGitHubOAuth = async ({
  code,
  state,
}: {
  code: string;
  state: string;
}): Promise<{
  userId: string;
  serverName: string;
  channelId?: string;
  teamId: string;
}> => {
  const payload = await consumeOAuthStateAsync(state);
  if (!payload) {
    throw new Error("Invalid or expired OAuth state token");
  }

  const { userId, serverName, channelId, teamId } = payload;

  if (!teamId) {
    throw new Error(
      "OAuth state missing teamId — re-run /mcp-add to start a fresh flow",
    );
  }

  const codeVerifier = await loadCodeVerifierAsync(userId, serverName, teamId);
  if (!codeVerifier) {
    throw new Error("PKCE code verifier not found or expired");
  }

  const accessToken = await exchangeGitHubCode(code, codeVerifier);

  const config = await findConfigByName(userId, serverName, channelId, teamId);
  if (!config) {
    throw new Error(`MCP server "${serverName}" not found`);
  }

  config.token = accessToken;
  await saveServerConfigAsync(config);

  return { userId, serverName, channelId, teamId };
};
