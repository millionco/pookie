import { Actions, LinkButton } from "chat";

import { env } from "@/env";

import { isSlackAdmin } from "../utils/is-slack-admin";
import {
  parseOptions,
  parseSubcommandArgs,
} from "../utils/parse-slash-command-args";
import { tryRegisterAsync } from "./client";
import { SERVER_NAME_REGEX } from "./constants";
import { initiateGitHubOAuth, isGitHubOAuthConfigured } from "./github-oauth";
import { getPresetDisplayName, MCP_PRESETS, resolvePreset } from "./presets";
import {
  clearOAuthArtifactsAsync,
  listVisibleServersAsync,
  oauthOwnerId,
  removeServerConfigAsync,
  saveOAuthAuthorizationLinkAsync,
  saveServerConfigAsync,
} from "./store";
import { validateAuthorizationUrl } from "./validate-authorization-url";
import { validateMcpServerUrl } from "./validate-server-url";

import type {
  AdapterPostableMessage,
  CardElement,
  SlashCommandEvent,
} from "chat";

import type { ParsedArgs } from "../utils/parse-slash-command-args";
import type { McpScope, McpServerConfig } from "./store";

const extractRawField = (
  raw: unknown,
  field: "channel_id" | "team_id",
): string | undefined => {
  if (typeof raw === "object" && raw !== null && field in raw) {
    return (raw as Record<string, unknown>)[field] as string | undefined;
  }
  return undefined;
};

const extractChannelId = (raw: unknown): string | undefined =>
  extractRawField(raw, "channel_id");

const extractTeamId = (raw: unknown): string | undefined =>
  extractRawField(raw, "team_id");

const resolveScope = (
  userId: string,
  channelId: string | undefined,
  teamId: string,
  isChannel: boolean,
  isGlobal: boolean,
): McpScope => {
  if (isGlobal) return { kind: "global", teamId };
  if (isChannel) {
    if (!channelId) throw new Error("Cannot use --channel outside a channel");
    return { kind: "channel", channelId, teamId };
  }
  return { kind: "user", userId, teamId };
};

// When invoked via the combined `/mcp <subcommand>` entry point, echo that
// form in help text; when invoked via a dedicated `/mcp-<subcommand>` command,
// echo that form instead. Keeps usage output consistent with what the user typed.
const invocationFor = (
  event: SlashCommandEvent,
  subcommand: string,
): string => {
  const invokedCommand = event.command;
  return invokedCommand === "/mcp"
    ? `/mcp ${subcommand}`
    : `/mcp-${subcommand}`;
};

const addCommandInvocation = (event: SlashCommandEvent): string =>
  invocationFor(event, "add");

const removeCommandInvocation = (event: SlashCommandEvent): string =>
  invocationFor(event, "remove");

const scopeLabel = (scope: McpScope): string => {
  switch (scope.kind) {
    case "global":
      return "global";
    case "channel":
      return `channel`;
    case "user":
      return "personal";
  }
};

const reply = async (
  event: SlashCommandEvent,
  message: AdapterPostableMessage,
) => {
  await event.channel.postEphemeral(event.user, message, {
    fallbackToDM: true,
  });
};

export const createAuthorizationStartUrl = async (
  serverName: string,
  authorizationUrl: string,
): Promise<string> => {
  const validation = validateAuthorizationUrl(authorizationUrl);
  if (!validation.valid) {
    throw new Error(
      `Refusing to create auth link for ${serverName}: ${validation.reason}`,
    );
  }

  const linkToken = crypto.randomUUID();
  await saveOAuthAuthorizationLinkAsync(linkToken, { serverName, authorizationUrl });

  const startUrl = new URL("/mcp/oauth/start", env.BASE_URL);
  startUrl.searchParams.set("token", linkToken);
  return startUrl.toString();
};

const buildAuthCard = (
  serverName: string,
  authorizationUrl: string,
): CardElement => ({
  type: "card",
  children: [
    {
      type: "text",
      content: `*${serverName}* requires authorization to connect. Open this in your regular browser if Slack opens an in-app window.`,
    },
    Actions([
      LinkButton({
        url: authorizationUrl,
        label: `Authorize ${serverName}`,
        style: "primary",
      }),
    ]),
  ],
});

export const buildReauthCard = (
  servers: Array<{ name: string; authorizationUrl: string }>,
): CardElement => ({
  type: "card",
  title: "MCP servers need reauthorization",
  children: [
    {
      type: "text",
      content:
        "The following servers need to be reconnected. Their tools won't be available until you reauthorize. Open these in your regular browser if Slack opens an in-app window.",
    },
    Actions(
      servers.map((server) =>
        LinkButton({
          url: server.authorizationUrl,
          label: `Authorize ${server.name}`,
          style: "primary",
        }),
      ),
    ),
  ],
});

const handleAdd = async (
  event: SlashCommandEvent,
  args: ParsedArgs,
): Promise<void> => {
  const addInvocation = addCommandInvocation(event);
  const [nameOrPreset, secondArg] = args.positional;

  if (!nameOrPreset) {
    const presetNames = Object.keys(MCP_PRESETS).join(", ");
    await reply(
      event,
      `usage: \`${addInvocation} <name> [url]\` [--channel | --global]\n\navailable presets: ${presetNames}`,
    );
    return;
  }

  const preset = resolvePreset(nameOrPreset);
  const serverName = nameOrPreset;
  const isTokenPreset = preset?.authType === "token";
  const isGitHubOAuthPreset = preset?.authType === "github-oauth";

  const serverUrl =
    isTokenPreset || isGitHubOAuthPreset
      ? preset.url
      : (secondArg ?? preset?.url);
  const token = isTokenPreset ? secondArg : undefined;
  const isGitHubOAuthWithPat = isGitHubOAuthPreset && Boolean(secondArg);

  if (isTokenPreset && !token) {
    const tokenHelpSuffix = preset?.tokenHelpUrl
      ? `\n\ngenerate one at ${preset.tokenHelpUrl}`
      : "";
    await reply(
      event,
      `*${serverName}* requires a personal access token.\nusage: \`${addInvocation} ${serverName} <token>\`${tokenHelpSuffix}`,
    );
    return;
  }

  if (isGitHubOAuthPreset && !secondArg && !isGitHubOAuthConfigured()) {
    const tokenHelpSuffix = preset?.tokenHelpUrl
      ? `\ngenerate one at ${preset.tokenHelpUrl}`
      : "";
    await reply(
      event,
      `GitHub OAuth is not configured on this instance.\n\nto connect GitHub, provide a personal access token:\n\`${addInvocation} ${serverName} <token>\`${tokenHelpSuffix}\n\nto enable OAuth, ask your admin to set \`GITHUB_CLIENT_ID\` and \`GITHUB_CLIENT_SECRET\` environment variables.`,
    );
    return;
  }

  if (!serverUrl) {
    await reply(
      event,
      `no preset found for "${nameOrPreset}". provide a url: \`${addInvocation} ${nameOrPreset} <url>\``,
    );
    return;
  }

  if (!SERVER_NAME_REGEX.test(serverName)) {
    await reply(
      event,
      `invalid server name "${serverName}". use lowercase letters, numbers, hyphens, and underscores (max 63 chars).`,
    );
    return;
  }

  const urlValidation = await validateMcpServerUrl(serverUrl);
  if (!urlValidation.valid) {
    await reply(event, urlValidation.reason!);
    return;
  }

  const channelId = extractChannelId(event.raw);
  const teamId = extractTeamId(event.raw);
  if (!teamId) {
    await reply(event, "could not determine workspace. try again.");
    return;
  }

  if (args.isGlobal && !(await isSlackAdmin(event.user.userId, teamId))) {
    await reply(event, "only admins can connect global MCP servers.");
    return;
  }

  const scope = resolveScope(
    event.user.userId,
    channelId,
    teamId,
    args.isChannel,
    args.isGlobal,
  );

  const effectiveToken = isGitHubOAuthWithPat ? secondArg : token;

  const config: McpServerConfig = {
    name: serverName,
    url: serverUrl,
    scope,
    createdBy: event.user.userId,
    createdAt: Date.now(),
    ...(effectiveToken ? { token: effectiveToken } : {}),
  };

  await saveServerConfigAsync(config);
  await clearOAuthArtifactsAsync(
    event.user.userId,
    serverName,
    teamId,
    oauthOwnerId(scope, event.user.userId),
  );

  if (isGitHubOAuthPreset && !isGitHubOAuthWithPat) {
    try {
      const { authorizationUrl } = await initiateGitHubOAuth(
        event.user.userId,
        serverName,
        channelId ?? undefined,
        teamId,
      );
      const authorizationStartUrl = await createAuthorizationStartUrl(
        serverName,
        authorizationUrl,
      );
      await reply(event, {
        card: buildAuthCard(serverName, authorizationStartUrl),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await reply(
        event,
        `saved *${serverName}* config (${scopeLabel(scope)}), but failed to start GitHub OAuth: ${errorMessage}`,
      );
    }
    return;
  }

  await reply(event, `connecting to ${serverName}...`);

  try {
    const result = await tryRegisterAsync(event.user.userId, config, teamId);

    if (result.connected) {
      await reply(
        event,
        `connected to *${serverName}* (${scopeLabel(scope)}) — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
      );
    } else if (result.authorizationUrl) {
      const authorizationStartUrl = await createAuthorizationStartUrl(
        serverName,
        result.authorizationUrl,
      );
      await reply(event, {
        card: buildAuthCard(serverName, authorizationStartUrl),
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await reply(
      event,
      `saved *${serverName}* config (${scopeLabel(scope)}), but failed to connect: ${errorMessage}. the bot will retry when you next message it.`,
    );
  }
};

interface ServerStatusContext {
  server: McpServerConfig;
  result?: Awaited<ReturnType<typeof tryRegisterAsync>>;
  errorMessage?: string;
}

interface CollectedServerStatuses {
  contexts: ServerStatusContext[];
  pendingAuth: Array<{ name: string; authorizationUrl: string }>;
}

const collectServerStatuses = async (
  event: SlashCommandEvent,
  servers: McpServerConfig[],
  teamId: string,
): Promise<CollectedServerStatuses> => {
  await reply(
    event,
    `checking ${servers.map((server) => `*${server.name}*`).join(", ")}…`,
  );

  const contexts: ServerStatusContext[] = [];
  const pendingAuth: Array<{ name: string; authorizationUrl: string }> = [];

  for (const server of servers) {
    try {
      const result = await tryRegisterAsync(event.user.userId, server, teamId);
      contexts.push({ server, result });
      if (!result.connected && result.authorizationUrl) {
        pendingAuth.push({
          name: server.name,
          authorizationUrl: result.authorizationUrl,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      contexts.push({ server, errorMessage });
    }
  }

  return { contexts, pendingAuth };
};

const postPendingAuthCard = async (
  event: SlashCommandEvent,
  pendingAuth: Array<{ name: string; authorizationUrl: string }>,
): Promise<void> => {
  if (pendingAuth.length === 0) return;
  // Build per-server start URLs independently — a single bad authorizationUrl
  // (e.g. a non-https URL surfaced by a malicious/misconfigured MCP server)
  // must not break the entire `/mcp status` listing.
  const settled = await Promise.allSettled(
    pendingAuth.map(async (server) => ({
      name: server.name,
      authorizationUrl: await createAuthorizationStartUrl(
        server.name,
        server.authorizationUrl,
      ),
    })),
  );
  const pendingAuthStartUrls: Array<{
    name: string;
    authorizationUrl: string;
  }> = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      pendingAuthStartUrls.push(outcome.value);
    } else {
      console.error("[mcp] skipping bad pending-auth url", outcome.reason);
    }
  }
  if (pendingAuthStartUrls.length === 0) return;
  await reply(event, { card: buildReauthCard(pendingAuthStartUrls) });
};

interface ServerListResult {
  servers: McpServerConfig[];
  teamId: string;
}

const listServersOrReplyEmpty = async (
  event: SlashCommandEvent,
  emptyMessage: string,
): Promise<ServerListResult | null> => {
  const channelId = extractChannelId(event.raw);
  const teamId = extractTeamId(event.raw);
  if (!teamId) {
    await reply(event, "could not determine workspace. try again.");
    return null;
  }
  const servers = await listVisibleServersAsync(
    event.user.userId,
    channelId,
    teamId,
  );
  if (servers.length === 0) {
    await reply(event, emptyMessage);
    return null;
  }
  return { servers, teamId };
};

const availablePresetsHint = (
  connectedServers: McpServerConfig[],
  event: SlashCommandEvent,
): string => {
  const connectedPresetNames = new Set(
    connectedServers
      .map((server) => resolvePreset(server.name)?.name)
      .filter((name): name is string => Boolean(name)),
  );

  const missingPresets = Object.values(MCP_PRESETS).filter(
    (preset) => !connectedPresetNames.has(preset.name),
  );

  if (missingPresets.length === 0) return "";

  const names = missingPresets
    .map((preset) => getPresetDisplayName(preset))
    .join(", ");
  return `\n\navailable presets: ${names} — add with \`${addCommandInvocation(event)} <name>\``;
};

const handleList = async (event: SlashCommandEvent): Promise<void> => {
  const addInvocation = addCommandInvocation(event);
  const channelId = extractChannelId(event.raw);
  const teamId = extractTeamId(event.raw);
  if (!teamId) {
    await reply(event, "could not determine workspace. try again.");
    return;
  }

  const servers = await listVisibleServersAsync(
    event.user.userId,
    channelId,
    teamId,
  );

  if (servers.length === 0) {
    const allPresetNames = Object.values(MCP_PRESETS)
      .map((preset) => getPresetDisplayName(preset))
      .join(", ");
    await reply(
      event,
      `no MCP servers connected. use \`${addInvocation} <name> <url>\` to add one.\n\navailable presets: ${allPresetNames}`,
    );
    return;
  }

  const { contexts, pendingAuth } = await collectServerStatuses(
    event,
    servers,
    teamId,
  );

  const lines = contexts.map(({ server, result, errorMessage }) => {
    let statusIndicator: string;
    if (errorMessage) {
      statusIndicator = `❌ ${errorMessage}`;
    } else if (result?.connected) {
      statusIndicator = `✅ ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}`;
    } else if (result?.authorizationUrl) {
      statusIndicator = "🔐 needs reauthorization";
    } else {
      statusIndicator = "⚠️ unknown status";
    }
    const addedBy =
      server.createdBy === event.user.userId ? "you" : `<@${server.createdBy}>`;
    return `• *${server.name}* — ${server.url}\n   ${statusIndicator} · ${scopeLabel(server.scope)} · added by ${addedBy}`;
  });

  const presetsHint = availablePresetsHint(servers, event);
  await reply(event, `*MCP servers:*\n${lines.join("\n")}${presetsHint}`);
  await postPendingAuthCard(event, pendingAuth);
};

const handleRemove = async (
  event: SlashCommandEvent,
  args: ParsedArgs,
): Promise<void> => {
  const [serverName] = args.positional;

  if (!serverName) {
    await reply(
      event,
      `usage: \`${removeCommandInvocation(event)} <name>\` [--channel | --global]`,
    );
    return;
  }

  const channelId = extractChannelId(event.raw);
  const teamId = extractTeamId(event.raw);
  if (!teamId) {
    await reply(event, "could not determine workspace. try again.");
    return;
  }

  if (args.isGlobal && !(await isSlackAdmin(event.user.userId, teamId))) {
    await reply(event, "only admins can remove global MCP servers.");
    return;
  }

  const scope = resolveScope(
    event.user.userId,
    channelId,
    teamId,
    args.isChannel,
    args.isGlobal,
  );

  const didRemove = await removeServerConfigAsync(scope, serverName);

  if (didRemove) {
    await clearOAuthArtifactsAsync(
      event.user.userId,
      serverName,
      teamId,
      oauthOwnerId(scope, event.user.userId),
    );
    await reply(event, `removed *${serverName}* (${scopeLabel(scope)}).`);
  } else {
    await reply(
      event,
      `no ${scopeLabel(scope)} server named "${serverName}" found.`,
    );
  }
};

const handleStatus = async (event: SlashCommandEvent): Promise<void> => {
  const result = await listServersOrReplyEmpty(
    event,
    "no MCP servers connected.",
  );
  if (!result) return;

  const { contexts, pendingAuth } = await collectServerStatuses(
    event,
    result.servers,
    result.teamId,
  );

  const statusLines = contexts
    .map(({ server, result, errorMessage }) => {
      if (errorMessage) return `❌ *${server.name}* — ${errorMessage}`;
      if (result?.connected) {
        return `✅ *${server.name}* — ${result.toolCount} tools`;
      }
      if (result?.authorizationUrl) {
        return `🔐 *${server.name}* — needs reauthorization`;
      }
      return undefined;
    })
    .filter((line): line is string => Boolean(line));

  await reply(event, `*MCP server status:*\n${statusLines.join("\n")}`);
  await postPendingAuthCard(event, pendingAuth);
};

const handlePresets = async (event: SlashCommandEvent): Promise<void> => {
  const addInvocation = addCommandInvocation(event);
  const lines = Object.values(MCP_PRESETS).map(
    (preset) => `• *${preset.name}* — ${preset.description}`,
  );

  await reply(
    event,
    `*available MCP presets:*\nadd with \`${addInvocation} <name>\`\nfor multiple accounts, use \`${addInvocation} <preset>_<alias>\` (e.g. \`linear_million\`)\n\n${lines.join("\n")}`,
  );
};

const USAGE = `usage:
\`/mcp-add <name> [url]\` [--channel | --global]
\`/mcp-list\`
\`/mcp-presets\`
\`/mcp-remove <name>\` [--channel | --global]
\`/mcp-status\`

(or use the combined form: \`/mcp add <name> [url]\`, \`/mcp list\`, etc.)`;

const handleDefault = async (event: SlashCommandEvent): Promise<void> => {
  const result = await listServersOrReplyEmpty(
    event,
    `no MCP servers connected.\n\n${USAGE}`,
  );
  if (!result) return;

  const { contexts, pendingAuth } = await collectServerStatuses(
    event,
    result.servers,
    result.teamId,
  );

  const statusLines = contexts
    .map(({ server, result, errorMessage }) => {
      const scopeSuffix = ` (${scopeLabel(server.scope)})`;
      if (errorMessage) {
        return `❌ *${server.name}* — ${errorMessage}${scopeSuffix}`;
      }
      if (result?.connected) {
        return `✅ *${server.name}* — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${scopeSuffix}`;
      }
      if (result?.authorizationUrl) {
        return `🔐 *${server.name}* — needs reauthorization${scopeSuffix}`;
      }
      return undefined;
    })
    .filter((line): line is string => Boolean(line));

  await reply(event, `*MCP servers:*\n${statusLines.join("\n")}\n\n${USAGE}`);
  await postPendingAuthCard(event, pendingAuth);
};

export const handleMcpCommand = async (
  event: SlashCommandEvent,
): Promise<void> => {
  const args = parseSubcommandArgs(event.text);

  switch (args.subcommand) {
    case "add":
    // Legacy alias retained so existing users who learned `/mcp connect` still work.
    case "connect":
      return handleAdd(event, args);
    case "list":
      return handleList(event);
    case "presets":
      return handlePresets(event);
    case "remove":
      return handleRemove(event, args);
    case "status":
      return handleStatus(event);
    default:
      return handleDefault(event);
  }
};

export const handleMcpAddCommand = async (
  event: SlashCommandEvent,
): Promise<void> => handleAdd(event, parseOptions(event.text));

export const handleMcpListCommand = async (
  event: SlashCommandEvent,
): Promise<void> => handleList(event);

export const handleMcpPresetsCommand = async (
  event: SlashCommandEvent,
): Promise<void> => handlePresets(event);

export const handleMcpRemoveCommand = async (
  event: SlashCommandEvent,
): Promise<void> => handleRemove(event, parseOptions(event.text));

export const handleMcpStatusCommand = async (
  event: SlashCommandEvent,
): Promise<void> => handleStatus(event);
