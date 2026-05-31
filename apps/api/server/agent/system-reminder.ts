import { MCP_PRESETS, resolvePreset } from "../mcp/presets";
import { UWU_MODE_SECTION } from "./uwu-mode";

import type { ModelMessage, UserContent } from "ai";

export interface FollowUpGuideline {
  readonly id: string;
  readonly predicate: (followUpCount: number) => boolean;
  readonly instruction: string;
}

// Order matters: predicates are evaluated top-to-bottom and the first match
// wins. Add new tiers (e.g. burst-detection, very-long-rapid-fire) by
// inserting an entry above the more general one.
const FOLLOW_UP_GUIDELINES: readonly FollowUpGuideline[] = [
  {
    id: "rapid-fire",
    predicate: (count) => count >= 2,
    instruction: "address all of them in one reply, in order.",
  },
  {
    id: "single-followup",
    predicate: (count) => count === 1,
    instruction: "fold it into your reply.",
  },
];

const matchFollowUpGuideline = (count: number): FollowUpGuideline | undefined =>
  FOLLOW_UP_GUIDELINES.find((guideline) => guideline.predicate(count));

export interface McpServerSummary {
  name: string;
  toolCount: number;
}

const describeConnectedServer = (server: McpServerSummary): string => {
  const toolLabel = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
  const preset = resolvePreset(server.name);
  const domain = preset ? preset.description : "custom server";
  return `- ${server.name}: ${domain} (${toolLabel})`;
};

const buildConnectedMcpServersSection = (
  mcpServers: McpServerSummary[] | undefined,
): string | undefined => {
  if (!mcpServers || mcpServers.length === 0) return undefined;
  const lines = mcpServers.map(describeConnectedServer).join("\n");
  return `<connected_mcp_servers>\nroute to the matching server when the user's request fits its domain. tool names are \`mcp_<server>_*\`.\n${lines}\n</connected_mcp_servers>`;
};

// Resolve each connected server through the preset registry so multi-instance
// names like `linear_personal` and `linear_work` correctly mark `linear` as
// already-connected and keep it out of the off-presets list.
const collectConnectedPresetNames = (
  connectedServers: McpServerSummary[] | undefined,
): Set<string> => {
  const names = new Set<string>();
  for (const server of connectedServers ?? []) {
    const preset = resolvePreset(server.name);
    if (preset) names.add(preset.name);
  }
  return names;
};

const presetAddInvocation = (preset: {
  name: string;
  authType?: string;
}): string =>
  preset.authType === "token"
    ? `\`/mcp-add ${preset.name} <api-key>\``
    : `\`/mcp-add ${preset.name}\``;

const describeOffPreset = (preset: {
  name: string;
  description: string;
  authType?: string;
}): string => {
  const tokenSuffix = preset.authType === "token" ? " (requires API key)" : "";
  return `- ${preset.name}: ${preset.description}${tokenSuffix} → ${presetAddInvocation(preset)}`;
};

const buildAvailableMcpPresetsSection = (
  connectedServers: McpServerSummary[] | undefined,
): string | undefined => {
  const connectedPresets = collectConnectedPresetNames(connectedServers);

  const offPresetLines = Object.values(MCP_PRESETS)
    .filter((preset) => !connectedPresets.has(preset.name))
    .map(describeOffPreset);

  if (offPresetLines.length === 0) return undefined;

  return `<available_mcp_presets>\nnot connected. if the user wants one of these capabilities, offer the matching invocation rather than faking the call. token presets need an API key inline.\n${offPresetLines.join("\n")}\n</available_mcp_presets>`;
};

export interface SystemReminderContext {
  followUpMessages?: string[];
  mcpServers?: McpServerSummary[];
  uwuMode?: boolean;
}

export const buildSystemReminder = (
  context: SystemReminderContext,
): string | undefined => {
  const { followUpMessages, mcpServers, uwuMode } = context;
  const sections: string[] = [];

  const connectedSection = buildConnectedMcpServersSection(mcpServers);
  if (connectedSection) sections.push(connectedSection);

  const availablePresetsSection = buildAvailableMcpPresetsSection(mcpServers);
  if (availablePresetsSection) sections.push(availablePresetsSection);

  if (followUpMessages && followUpMessages.length > 0) {
    const quoted = followUpMessages
      .map((followUpText) => `- "${followUpText}"`)
      .join("\n");
    const guideline = matchFollowUpGuideline(followUpMessages.length);
    const ruleSuffix = guideline ? ` ${guideline.instruction}` : "";
    sections.push(
      `<user_follow_ups>\nsent while you were responding (also above in history).${ruleSuffix}\n${quoted}\n</user_follow_ups>`,
    );
  }

  if (uwuMode) sections.push(UWU_MODE_SECTION);

  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
};

const SYSTEM_REMINDER_LEADING_BLOCK_REGEX =
  /^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;

const SYSTEM_REMINDER_FULL_TEXT_REGEX =
  /^<system-reminder>[\s\S]*?<\/system-reminder>$/;

const stripLeadingSystemReminders = (content: UserContent): UserContent => {
  if (typeof content === "string") {
    return content.replace(SYSTEM_REMINDER_LEADING_BLOCK_REGEX, "");
  }
  let firstKeptIndex = 0;
  while (firstKeptIndex < content.length) {
    const part = content[firstKeptIndex];
    if (
      part?.type === "text" &&
      SYSTEM_REMINDER_FULL_TEXT_REGEX.test(part.text)
    ) {
      firstKeptIndex++;
      continue;
    }
    break;
  }
  return firstKeptIndex > 0 ? content.slice(firstKeptIndex) : content;
};

// Inject the per-turn reminder into the LAST user message wrapped in
// <system-reminder> tags. Placement matters: the reminder includes
// follow-ups and other per-turn-changing data, so putting it earlier
// in the prompt would invalidate the cache prefix for the whole
// conversation history every turn. Last-user-message keeps every
// older message cache-hittable; only the latest message recomputes.
//
// IMPORTANT: this function is idempotent. Any pre-existing
// <system-reminder>...</system-reminder> wrapper(s) at the start of the
// last user message are stripped before the new reminder is prepended.
// Without this, repeated injection across follow-up rounds (or against
// thread state that earlier code paths persisted in injected form) would
// stack reminder blocks and inflate context every turn. Callers should
// ALSO avoid persisting the returned messages — see runAgentRound for the
// canonical pattern of injecting only at the streamText boundary.
export const injectSystemReminderIntoLastUserMessage = (
  history: ModelMessage[],
  reminder: string,
): ModelMessage[] => {
  let lastUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return history;

  const target = history[lastUserIndex];
  if (!target || target.role !== "user") return history;

  const wrapped = `<system-reminder>\n${reminder}\n</system-reminder>`;
  const stripped = stripLeadingSystemReminders(target.content);

  const nextContent: UserContent =
    typeof stripped === "string"
      ? stripped.length > 0
        ? `${wrapped}\n\n${stripped}`
        : wrapped
      : [{ type: "text", text: wrapped }, ...stripped];

  const updated: ModelMessage = { ...target, content: nextContent };

  const next = [...history];
  next[lastUserIndex] = updated;
  return next;
};
