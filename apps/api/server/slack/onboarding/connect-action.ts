import { tryRegisterAsync } from "../../mcp/client";
import {
  initiateGitHubOAuth,
  isGitHubOAuthConfigured,
} from "../../mcp/github-oauth";
import { createAuthorizationStartUrl } from "../../mcp/handlers";
import { getPresetDisplayName, resolvePreset } from "../../mcp/presets";
import {
  clearOAuthArtifactsAsync,
  oauthOwnerId,
  saveServerConfigAsync,
} from "../../mcp/store";
import { resolveSlackWebClient } from "../web-client";
import { ONBOARDING_CONNECT_ACTION_ID } from "./cards-builder";

import type { ActionEvent } from "chat";

import type { McpServerConfig } from "../../mcp/store";

interface SlackBlockActionRaw {
  team?: { id?: string };
  channel?: { id?: string };
  user?: { id?: string; team_id?: string };
}

const extractTeamId = (raw: unknown): string | undefined => {
  const payload = raw as SlackBlockActionRaw | undefined;
  return payload?.team?.id ?? payload?.user?.team_id;
};

const extractChannelId = (raw: unknown): string | undefined => {
  const payload = raw as SlackBlockActionRaw | undefined;
  return payload?.channel?.id;
};

const replyEphemeral = async (
  teamId: string,
  channelId: string,
  userId: string,
  text: string,
): Promise<void> => {
  const client = await resolveSlackWebClient(teamId);
  if (!client) return;
  await client.chat.postEphemeral({ channel: channelId, user: userId, text });
};

export const handleOnboardingConnectAction = async (
  event: ActionEvent,
): Promise<void> => {
  const presetName = event.value;
  if (!presetName) return;

  const teamId = extractTeamId(event.raw);
  const channelId = extractChannelId(event.raw);
  const userId = event.user.userId;

  if (!teamId || !channelId) {
    console.warn("[onboarding-connect-action] missing teamId or channelId");
    return;
  }

  const preset = resolvePreset(presetName);
  if (!preset) {
    await replyEphemeral(
      teamId,
      channelId,
      userId,
      `unknown preset "${presetName}".`,
    );
    return;
  }

  const displayName = getPresetDisplayName(preset);
  const isGitHubOAuth =
    preset.authType === "github-oauth" && isGitHubOAuthConfigured();

  if (preset.authType === "github-oauth" && !isGitHubOAuthConfigured()) {
    await replyEphemeral(
      teamId,
      channelId,
      userId,
      `GitHub OAuth isn't configured on this instance. run \`/mcp add github <token>\` with a personal access token instead.\n\ngenerate one at ${preset.tokenHelpUrl ?? "https://github.com/settings/tokens"}`,
    );
    return;
  }

  const config: McpServerConfig = {
    name: preset.name,
    url: preset.url,
    scope: { kind: "user", userId, teamId },
    createdBy: userId,
    createdAt: Date.now(),
  };

  await saveServerConfigAsync(config);
  await clearOAuthArtifactsAsync(
    userId,
    preset.name,
    teamId,
    oauthOwnerId(config.scope, userId),
  );

  if (isGitHubOAuth) {
    try {
      const { authorizationUrl } = await initiateGitHubOAuth(
        userId,
        preset.name,
        channelId,
        teamId,
      );
      const startUrl = await createAuthorizationStartUrl(
        preset.name,
        authorizationUrl,
      );
      await replyEphemeral(
        teamId,
        channelId,
        userId,
        `<${startUrl}|authorize ${displayName} →>`,
      );
    } catch (error) {
      console.error("[onboarding-connect-action] GitHub OAuth failed", error);
      await replyEphemeral(
        teamId,
        channelId,
        userId,
        `failed to start GitHub OAuth. try \`/mcp add github\` instead.`,
      );
    }
    return;
  }

  await replyEphemeral(
    teamId,
    channelId,
    userId,
    `connecting to ${displayName}...`,
  );

  try {
    const result = await tryRegisterAsync(userId, config, teamId);

    if (result.connected) {
      await replyEphemeral(
        teamId,
        channelId,
        userId,
        `connected to *${displayName}* — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
      );
    } else if (result.authorizationUrl) {
      const startUrl = await createAuthorizationStartUrl(
        preset.name,
        result.authorizationUrl,
      );
      await replyEphemeral(
        teamId,
        channelId,
        userId,
        `<${startUrl}|authorize ${displayName} →>`,
      );
    }
  } catch (error) {
    console.error("[onboarding-connect-action] tryRegisterAsync failed", error);
    await replyEphemeral(
      teamId,
      channelId,
      userId,
      `failed to connect ${displayName}. try \`/mcp add ${preset.name}\` instead.`,
    );
  }
};

export const onboardingConnectActionIds = (presetNames: string[]): string[] =>
  presetNames.map((name) => `${ONBOARDING_CONNECT_ACTION_ID}:${name}`);
