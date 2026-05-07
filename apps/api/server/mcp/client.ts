import { auth, createMCPClient } from "@ai-sdk/mcp";

import { createMcpAuthProvider, McpOAuthRedirectError } from "./auth-provider";
import { MCP_TOOL_NAME_SEPARATOR } from "./constants";
import { resolveShimName } from "./presets";
import { resolveShim } from "./shims";
import {
  clearPendingAuthUrl,
  consumeOAuthState,
  getServerConfig,
  listVisibleServers,
  loadOAuthTokens,
  loadPendingAuthUrl,
  oauthOwnerId,
} from "./store";

import type {
  MCPClient,
  MCPClientConfig,
  OAuthClientProvider,
} from "@ai-sdk/mcp";
import type * as AI from "ai";

import type { McpScope, McpServerConfig } from "./store";

interface McpTransportAuth {
  authProvider?: OAuthClientProvider;
  headers?: Record<string, string>;
}

const channelIdFromScope = (scope: McpScope): string | undefined =>
  scope.kind === "channel" ? scope.channelId : undefined;

const buildBearerHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const connectWithTransportFallback = async (
  url: string,
  transportAuth: McpTransportAuth,
): Promise<MCPClient> => {
  const transportConfig = (type: "http" | "sse"): MCPClientConfig => ({
    transport: { type, url, ...transportAuth },
  });

  try {
    return await createMCPClient(transportConfig("http"));
  } catch (httpError) {
    const isMethodNotAllowed =
      httpError instanceof Error && httpError.message.includes("405");
    if (!isMethodNotAllowed) throw httpError;
    return createMCPClient(transportConfig("sse"));
  }
};

export interface McpRegistrationResult {
  connected: boolean;
  authorizationUrl?: string;
  toolCount?: number;
}

export interface McpServerAuthNeeded {
  name: string;
  authorizationUrl: string;
}

export interface McpServerError {
  name: string;
  message: string;
}

export interface McpToolsResult {
  tools: Record<string, AI.Tool>;
  close: () => Promise<void>;
  servers: Array<{ name: string; toolCount: number }>;
  authNeeded: McpServerAuthNeeded[];
  errors: McpServerError[];
}

const resolveTransportAuth = (
  userId: string,
  config: McpServerConfig,
  teamId: string,
): McpTransportAuth => {
  if (config.token) {
    return { headers: buildBearerHeaders(config.token) };
  }
  return {
    authProvider: createMcpAuthProvider({
      userId,
      tokenOwnerId: oauthOwnerId(config.scope, userId),
      serverName: config.name,
      serverUrl: config.url,
      channelId: channelIdFromScope(config.scope),
      teamId,
    }),
  };
};

// Pre-authenticate with a single sequential auth() call before creating the
// MCP client. The HTTP transport fires openInboundSse concurrently with send,
// each triggering independent auth() calls that race on client registration
// and PKCE state. By resolving auth first, the transport sees valid tokens
// and skips its own auth flow entirely.
//
// If a previous call already started an auth flow (saved a pending URL),
// reuse that URL instead of calling auth() again — a second auth() would
// generate a fresh PKCE pair and overwrite the verifier the user is
// currently trying to use.
//
// When tokens exist without a refresh_token, skip auth() entirely.
// The @ai-sdk/mcp auth() function unconditionally starts a new
// authorization flow in that case (even if the access_token is still
// valid), creating an infinite re-auth loop for providers like Mercury
// and Cloudflare that don't issue refresh tokens.
//
// When tokens DO have a refresh_token, call auth() to proactively
// refresh — but catch any redirect that occurs anyway (e.g. the
// refresh endpoint returned a transient 5xx / ServerError, which
// @ai-sdk/mcp silently swallows before falling through to re-auth).
// In that case, fall back to the existing tokens and let the transport
// handle 401s if the access_token is actually expired.
const loadOAuthTokensWithFallback = async (
  ownerId: string,
  userId: string,
  serverName: string,
  teamId: string,
) => {
  const tokens = await loadOAuthTokens(ownerId, serverName, teamId);
  if (tokens) return tokens;
  if (ownerId !== userId) return loadOAuthTokens(userId, serverName, teamId);
  return undefined;
};

const ensureOAuth = async (
  userId: string,
  config: McpServerConfig,
  teamId: string,
): Promise<void> => {
  if (config.token) return;

  const pendingAuthUrl = await loadPendingAuthUrl(userId, config.name, teamId);
  if (pendingAuthUrl) {
    throw new McpOAuthRedirectError(pendingAuthUrl, config.url);
  }

  const ownerId = oauthOwnerId(config.scope, userId);
  const existingTokens = await loadOAuthTokensWithFallback(
    ownerId,
    userId,
    config.name,
    teamId,
  );
  if (existingTokens && !existingTokens.refresh_token) return;

  const authProvider = createMcpAuthProvider({
    userId,
    tokenOwnerId: ownerId,
    serverName: config.name,
    serverUrl: config.url,
    channelId: channelIdFromScope(config.scope),
    teamId,
  });

  try {
    await auth(authProvider, { serverUrl: config.url });
  } catch (error) {
    if (error instanceof McpOAuthRedirectError) {
      // auth() wanted to redirect despite us having tokens. Re-check Redis
      // (auth may have called invalidateCredentials("all"), clearing them).
      const currentTokens = await loadOAuthTokensWithFallback(
        ownerId,
        userId,
        config.name,
        teamId,
      );
      if (currentTokens) {
        await clearPendingAuthUrl(userId, config.name, teamId);
        return;
      }
    }
    throw error;
  }
};

// Shimmed integrations (e.g. Rippling) are exposed to the agent as if they
// were MCP servers, but Pookie hosts the tools locally and skips the MCP
// transport entirely. Register/open paths short-circuit to the shim's
// `buildTools` so the same `mcp_<server>_<tool>` naming and prompt routing
// apply uniformly.
const tryRegisterShim = async (
  config: McpServerConfig,
): Promise<McpRegistrationResult | null> => {
  const shimName = resolveShimName(config.name);
  if (!shimName) return null;

  const shim = resolveShim(shimName);
  if (!shim) return null;

  if (!config.token) {
    throw new Error(
      `${config.name} requires an API key. re-run \`/mcp-add ${config.name} <key>\``,
    );
  }

  const validation = await shim.validate(config.token);
  if (!validation.ok) {
    throw new Error(validation.message ?? `${config.name} validation failed`);
  }

  return { connected: true, toolCount: validation.toolCount };
};

export const tryRegister = async (
  userId: string,
  config: McpServerConfig,
  teamId: string,
): Promise<McpRegistrationResult> => {
  const shimResult = await tryRegisterShim(config);
  if (shimResult) return shimResult;

  try {
    await ensureOAuth(userId, config, teamId);
  } catch (error) {
    if (error instanceof McpOAuthRedirectError) {
      return {
        connected: false,
        authorizationUrl: error.authorizationUrl,
      };
    }
    throw error;
  }

  const transportAuth = resolveTransportAuth(userId, config, teamId);
  const client = await connectWithTransportFallback(config.url, transportAuth);
  const toolSet = await client.tools();
  const toolCount = Object.keys(toolSet).length;
  await client.close();

  return { connected: true, toolCount };
};

export const finishOAuth = async ({
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
  const payload = await consumeOAuthState(state);
  if (!payload) {
    throw new Error("Invalid or expired OAuth state token");
  }

  const { userId, serverName, channelId, teamId } = payload;

  if (!teamId) {
    throw new Error(
      "OAuth state missing teamId — re-run /mcp-add to start a fresh flow",
    );
  }

  const config = await findConfigByName(userId, serverName, channelId, teamId);
  if (!config) {
    throw new Error(`MCP server "${serverName}" not found`);
  }

  const authProvider = createMcpAuthProvider({
    userId,
    tokenOwnerId: oauthOwnerId(config.scope, userId),
    serverName,
    serverUrl: config.url,
    channelId: channelIdFromScope(config.scope),
    teamId,
  });

  await auth(authProvider, {
    serverUrl: config.url,
    authorizationCode: code,
  });

  await clearPendingAuthUrl(userId, serverName, teamId);

  return { userId, serverName, channelId, teamId };
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
    const config = await getServerConfig(scope, serverName);
    if (config) return config;
  }

  return null;
};

export const openMcpTools = async (
  userId: string,
  channelId: string | undefined,
  teamId: string,
): Promise<McpToolsResult> => {
  const configs = await listVisibleServers(userId, channelId, teamId);
  const emptyResult: McpToolsResult = {
    tools: {},
    close: async () => {},
    servers: [],
    authNeeded: [],
    errors: [],
  };

  if (configs.length === 0) {
    return emptyResult;
  }

  const clients: MCPClient[] = [];
  const allTools: Record<string, AI.Tool> = {};
  const serverSummaries: Array<{ name: string; toolCount: number }> = [];
  const authNeeded: McpServerAuthNeeded[] = [];
  const errors: McpServerError[] = [];

  const classifyError = (config: McpServerConfig, error: unknown) => {
    if (error instanceof McpOAuthRedirectError) {
      authNeeded.push({
        name: config.name,
        authorizationUrl: error.authorizationUrl,
      });
    } else {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(`[mcp] failed for ${config.name}:`, error);
      errors.push({ name: config.name, message: errorMessage });
    }
  };

  const registerToolSet = (
    config: McpServerConfig,
    toolSet: Record<string, AI.Tool>,
  ): void => {
    let toolCount = 0;
    for (const [toolName, tool] of Object.entries(toolSet)) {
      const prefixedName = `mcp${MCP_TOOL_NAME_SEPARATOR}${config.name}${MCP_TOOL_NAME_SEPARATOR}${toolName}`;
      allTools[prefixedName] = tool;
      toolCount++;
    }
    serverSummaries.push({ name: config.name, toolCount });
  };

  const ingestShimConfig = (config: McpServerConfig): boolean => {
    const shimName = resolveShimName(config.name);
    if (!shimName) return false;
    const shim = resolveShim(shimName);
    if (!shim) return false;
    if (!config.token) {
      errors.push({
        name: config.name,
        message: `${config.name} requires an API key. re-run \`/mcp-add ${config.name} <key>\``,
      });
      return true;
    }
    try {
      registerToolSet(config, shim.buildTools(config.token));
    } catch (error) {
      classifyError(config, error);
    }
    return true;
  };

  const transportConfigs = configs.filter(
    (config) => !ingestShimConfig(config),
  );

  const connectionResults = await Promise.allSettled(
    transportConfigs.map(async (config) => {
      try {
        await ensureOAuth(userId, config, teamId);
      } catch (authError) {
        classifyError(config, authError);
        return null;
      }

      const transportAuth = resolveTransportAuth(userId, config, teamId);

      try {
        const client = await connectWithTransportFallback(
          config.url,
          transportAuth,
        );
        return { config, client };
      } catch (connectError) {
        classifyError(config, connectError);
        return null;
      }
    }),
  );

  for (const result of connectionResults) {
    if (result.status === "rejected" || !result.value) continue;

    const { config, client } = result.value;
    clients.push(client);

    try {
      const toolSet = await client.tools();
      registerToolSet(config, toolSet as Record<string, AI.Tool>);
    } catch (toolError) {
      classifyError(config, toolError);
    }
  }

  const close = async () => {
    await Promise.allSettled(clients.map((innerClient) => innerClient.close()));
  };

  return {
    tools: allTools,
    close,
    servers: serverSummaries,
    authNeeded,
    errors,
  };
};
