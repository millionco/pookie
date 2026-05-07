import { resolvePreset } from "../mcp/presets";
import { createProvider } from "../openai-provider";
import { sanitizeMcpToolArgs } from "../utils/sanitize-mcp-tool-args";
import { createHtmlAppTool } from "./html-app";
import { forget, recall, remember } from "./memory";
import { search } from "./search";
import { slackChannelTools } from "./slack-channel";

import type { SlackAdapter } from "@chat-adapter/slack";
import type * as AI from "ai";
import type * as ChatSDK from "chat";

import type { McpSearchToolSource } from "./subagent";

export interface AgentContext {
  channelId?: string;
  currentMessage?: ChatSDK.Message;
  slack: SlackAdapter;
  state: ChatSDK.StateAdapter;
  teamId: string;
  thread: ChatSDK.Thread;
  userId?: string;
}

// Below this MCP tool count, the tool_search round-trip costs more than
// loading every tool eagerly. Above it, deferring keeps the model's working
// set small as users wire up many MCP servers (linear/github/sentry/...).
const DEFER_MCP_TOOLS_THRESHOLD = 8;

const deferMcpTools = (
  mcpTools: Record<string, AI.Tool>,
): Record<string, AI.Tool> => {
  const deferred: Record<string, AI.Tool> = {};
  for (const [toolName, mcpTool] of Object.entries(mcpTools)) {
    deferred[toolName] = {
      ...mcpTool,
      providerOptions: {
        ...mcpTool.providerOptions,
        openai: {
          ...mcpTool.providerOptions?.openai,
          deferLoading: true,
        },
      },
    };
  }
  return deferred;
};

// Return type is widened to Record<string, AI.Tool> on purpose. With the
// conditional tool_search spread, the inferred return type becomes a union
// that breaks streamText's TypedToolResult inference downstream (toolResults
// elements get typed as possibly undefined). Widening trades narrow result
// typing for a working build; the agent already narrows by toolName at the
// callsite anyway.
export const buildToolset = (
  context: AgentContext,
  mcpTools?: Record<string, AI.Tool>,
  mcpServers?: Array<{ name: string }>,
): Record<string, AI.Tool> => {
  const openai = createProvider();

  // SLOPPY: strip hallucinated pagination cursors from Mercury MCP tool args
  const sanitizedMcpTools = mcpTools
    ? sanitizeMcpToolArgs(mcpTools)
    : undefined;
  const mcpToolCount = sanitizedMcpTools
    ? Object.keys(sanitizedMcpTools).length
    : 0;
  const shouldDefer = mcpToolCount >= DEFER_MCP_TOOLS_THRESHOLD;
  const finalMcpTools =
    shouldDefer && sanitizedMcpTools
      ? deferMcpTools(sanitizedMcpTools)
      : sanitizedMcpTools;

  const nonMcpMainTools: Record<string, AI.Tool> = {
    web_search: openai.tools.webSearch({ searchContextSize: "high" }),
    image_generation: openai.tools.imageGeneration({ outputFormat: "png" }),
    code_interpreter: openai.tools.codeInterpreter(),
    // OpenAI's Responses API rejects requests that include tool_search but
    // have no deferred tools ("tools.tool_search requires at least one
    // deferred tool"). Only include it when MCP tools are actually deferred.
    ...(shouldDefer ? { tool_search: openai.tools.toolSearch() } : {}),
    ...slackChannelTools({
      slack: context.slack,
      thread: context.thread,
      currentMessage: context.currentMessage,
    }),
    remember: remember(context.state, context.teamId),
    recall: recall(context.state, context.teamId),
    forget: forget(context.state, context.teamId),
    create_html_app: createHtmlAppTool({
      state: context.state,
      teamId: context.teamId,
      userId: context.userId,
      channelId: context.channelId,
    }),
  };

  const mcpSearchToolSources: McpSearchToolSource[] = (
    mcpServers ?? []
  ).flatMap((connectedServer) => {
    const preset = resolvePreset(connectedServer.name);
    return preset ? [{ preset, serverName: connectedServer.name }] : [];
  });

  return {
    ...nonMcpMainTools,
    ...finalMcpTools,
    search: search({
      channelId: context.channelId,
      currentMessage: context.currentMessage,
      mainToolset: nonMcpMainTools,
      mcpTools: sanitizedMcpTools,
      mcpSearchToolSources,
      slack: context.slack,
      teamId: context.teamId,
      thread: context.thread,
      userId: context.userId,
    }),
  };
};

export { cacheSlackSearchContext } from "./slack-search";
export {
  loadChannelMemories,
  loadGlobalMemories,
  loadPersonalMemories as loadMemories,
} from "./memory";
