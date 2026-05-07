import { env } from "@/env";

import {
  clearOAuthArtifactsAsync,
  loadCodeVerifierAsync,
  loadOAuthClientAsync,
  loadOAuthTokensAsync,
  saveCodeVerifierAsync,
  saveOAuthClientAsync,
  saveOAuthStateAsync,
  saveOAuthTokensAsync,
  savePendingAuthUrlAsync,
} from "./store";

import type {
  OAuthClientInformation,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";

export interface McpAuthProviderOptions {
  userId: string;
  tokenOwnerId: string;
  serverName: string;
  serverUrl: string;
  channelId?: string;
  teamId: string;
}

const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export const createMcpAuthProvider = ({
  userId,
  tokenOwnerId,
  serverName,
  serverUrl,
  channelId,
  teamId,
}: McpAuthProviderOptions): OAuthClientProvider => {
  let cachedTokens: OAuthTokens | undefined;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return new URL(MCP_OAUTH_CALLBACK_PATH, env.BASE_URL).toString();
    },

    get clientMetadata() {
      return {
        redirect_uris: [
          typeof provider.redirectUrl === "string"
            ? provider.redirectUrl
            : provider.redirectUrl.toString(),
        ],
        client_name: `pookie-mcp-${serverName}`,
        client_uri: new URL("/", env.BASE_URL).toString(),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },

    async tokens() {
      if (cachedTokens) return cachedTokens;
      cachedTokens = await loadOAuthTokensAsync(tokenOwnerId, serverName, teamId);
      return cachedTokens;
    },

    async saveTokens(tokens: OAuthTokens) {
      cachedTokens = tokens;
      await saveOAuthTokensAsync(tokenOwnerId, serverName, tokens, teamId);
    },

    async clientInformation() {
      return loadOAuthClientAsync(tokenOwnerId, serverName, teamId);
    },

    async saveClientInformation(clientInfo: OAuthClientInformation) {
      await saveOAuthClientAsync(tokenOwnerId, serverName, clientInfo, teamId);
    },

    async codeVerifier() {
      const verifier = await loadCodeVerifierAsync(userId, serverName, teamId);
      if (!verifier) throw new Error("No PKCE code verifier found");
      return verifier;
    },

    async saveCodeVerifier(verifier: string) {
      await saveCodeVerifierAsync(userId, serverName, verifier, teamId);
    },

    async redirectToAuthorization(authorizationUrl: URL) {
      const stateToken = crypto.randomUUID();
      authorizationUrl.searchParams.set("state", stateToken);

      const finalUrl = authorizationUrl.toString();
      await Promise.all([
        saveOAuthStateAsync(stateToken, { userId, serverName, channelId, teamId }),
        savePendingAuthUrlAsync(userId, serverName, finalUrl, teamId),
      ]);

      throw new McpOAuthRedirectError(finalUrl, serverUrl);
    },

    async invalidateCredentials(scope) {
      cachedTokens = undefined;
      if (scope === "all") {
        await clearOAuthArtifactsAsync(userId, serverName, teamId, tokenOwnerId);
      }
    },
  };

  return provider;
};

export class McpOAuthRedirectError extends Error {
  readonly authorizationUrl: string;
  readonly serverUrl: string;

  constructor(authorizationUrl: string, serverUrl: string) {
    super("MCP OAuth redirect required");
    this.name = "McpOAuthRedirectError";
    this.authorizationUrl = authorizationUrl;
    this.serverUrl = serverUrl;
  }
}
