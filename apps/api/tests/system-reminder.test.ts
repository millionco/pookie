import { describe, expect, it } from "vitest";

import {
  buildSystemReminder,
  injectSystemReminderIntoLastUserMessage,
} from "../server/agent/system-reminder";
import { MCP_PRESETS } from "../server/mcp/presets";

import type { ModelMessage } from "ai";

describe("buildSystemReminder", () => {
  it("returns the available-presets section when there are no follow-ups and no connected servers", () => {
    // Even with zero connected MCPs, the preset catalog ships with several
    // built-in integrations, so the reminder should still surface them as
    // "off" suggestions for the agent to offer the user.
    const result = buildSystemReminder({});
    expect(result).toBeDefined();
    expect(result).toContain("<available_mcp_presets>");
    expect(result).not.toContain("<connected_mcp_servers>");
    expect(result).not.toContain("<user_follow_ups>");
  });

  it("renders a single follow-up with the single-message rule", () => {
    const result = buildSystemReminder({
      followUpMessages: ["actually, also check Y"],
    });
    expect(result).toContain("<user_follow_ups>");
    expect(result).toContain('"actually, also check Y"');
    expect(result).toContain("fold it into your reply.");
    expect(result).not.toContain("address all of them");
  });

  it("renders multiple follow-ups with the rapid-fire rule", () => {
    const result = buildSystemReminder({
      followUpMessages: ["first", "second", "third"],
    });
    expect(result).toContain("<user_follow_ups>");
    expect(result).toContain('"first"');
    expect(result).toContain('"second"');
    expect(result).toContain('"third"');
    expect(result).toContain("address all of them in one reply, in order.");
  });

  it("treats two follow-ups as rapid-fire", () => {
    const result = buildSystemReminder({
      followUpMessages: ["a", "b"],
    });
    expect(result).toContain("address all of them in one reply, in order.");
    expect(result).not.toContain("fold it into your reply.");
  });

  it("renders connected MCP servers with their preset domain and tool count", () => {
    const result = buildSystemReminder({
      mcpServers: [
        { name: "mercury", toolCount: 14 },
        { name: "linear", toolCount: 8 },
        { name: "sentry", toolCount: 1 },
      ],
    });

    expect(result).toContain("<connected_mcp_servers>");
    expect(result).toContain("- mercury: banking (14 tools)");
    expect(result).toContain("- linear: project management (8 tools)");
    expect(result).toContain("- sentry: error tracking (1 tool)");
  });

  it("labels non-preset (custom URL) MCP servers as `custom server`", () => {
    const result = buildSystemReminder({
      mcpServers: [{ name: "internal-tool", toolCount: 3 }],
    });

    expect(result).toContain("- internal-tool: custom server (3 tools)");
  });

  it("emits both the MCP block and the follow-up block when both apply", () => {
    const result = buildSystemReminder({
      followUpMessages: ["also do Y"],
      mcpServers: [{ name: "mercury", toolCount: 14 }],
    });

    expect(result).toContain("<connected_mcp_servers>");
    expect(result).toContain("<user_follow_ups>");
    expect(result).toContain("- mercury: banking (14 tools)");
    expect(result).toContain('"also do Y"');
  });

  it("lists off presets without re-listing connected ones", () => {
    const result = buildSystemReminder({
      mcpServers: [{ name: "mercury", toolCount: 14 }],
    });

    expect(result).toContain("<connected_mcp_servers>");
    expect(result).toContain("- mercury: banking (14 tools)");

    expect(result).toContain("<available_mcp_presets>");
    expect(result).toContain("`/mcp-add linear`");
    expect(result).toContain("- linear: project management");
    expect(result).toContain("- sentry: error tracking");

    const availableSection = result?.match(
      /<available_mcp_presets>[\s\S]*?<\/available_mcp_presets>/,
    )?.[0];
    expect(availableSection).toBeDefined();
    expect(availableSection).not.toContain("- mercury:");
  });

  it("flags token-only presets with the API-key invocation hint", () => {
    const result = buildSystemReminder({});
    expect(result).toContain(
      "rippling: hr, employees, leave (requires API key)",
    );
    expect(result).toContain("`/mcp-add rippling <api-key>`");
    // OAuth presets keep the bare invocation
    expect(result).toContain("`/mcp-add linear`");
  });

  it("dedupes off presets across multi-instance connections (e.g. linear_personal)", () => {
    const result = buildSystemReminder({
      mcpServers: [
        { name: "linear_personal", toolCount: 8 },
        { name: "linear_work", toolCount: 8 },
      ],
    });

    const availableSection = result?.match(
      /<available_mcp_presets>[\s\S]*?<\/available_mcp_presets>/,
    )?.[0];
    expect(availableSection).toBeDefined();
    expect(availableSection).not.toContain("- linear:");
  });

  it("renders the available-presets section even with no connected servers", () => {
    const result = buildSystemReminder({ mcpServers: [] });
    expect(result).toContain("<available_mcp_presets>");
    expect(result).toContain("- mercury: banking");
    expect(result).toContain("- linear: project management");
  });

  it("omits the available-presets section when every preset is already connected", () => {
    const everyPresetConnected = Object.keys(MCP_PRESETS).map((name) => ({
      name,
      toolCount: 1,
    }));
    const result = buildSystemReminder({ mcpServers: everyPresetConnected });

    expect(result).toContain("<connected_mcp_servers>");
    expect(result).not.toContain("<available_mcp_presets>");
  });

  it("appends the <uwu_mode> section when uwuMode is true", () => {
    const result = buildSystemReminder({ uwuMode: true });
    expect(result).toContain("<uwu_mode>");
    expect(result).toMatch(/pet mode/i);
  });

  it("does not include a <uwu_mode> section when uwuMode is false or absent", () => {
    expect(buildSystemReminder({ uwuMode: false })).not.toContain("<uwu_mode>");
    expect(buildSystemReminder({})).not.toContain("<uwu_mode>");
  });

  it("emits both follow-up and uwu sections together when both apply", () => {
    const result = buildSystemReminder({
      followUpMessages: ["also do Y"],
      uwuMode: true,
    });
    expect(result).toContain("<user_follow_ups>");
    expect(result).toContain("<uwu_mode>");
  });
});

describe("injectSystemReminderIntoLastUserMessage", () => {
  it("prepends a <system-reminder> block to the last user message (string content)", () => {
    const history: ModelMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
    ];

    const result = injectSystemReminderIntoLastUserMessage(
      history,
      "test reminder",
    );

    expect(result).toHaveLength(4);
    expect(result[3]?.role).toBe("user");
    const content = result[3]?.content as string;
    expect(content).toContain("<system-reminder>");
    expect(content).toContain("test reminder");
    expect(content).toContain("do something");
  });

  it("prepends a text part to array content", () => {
    const history: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text" as const, text: "what is this" }],
      },
    ];

    const result = injectSystemReminderIntoLastUserMessage(
      history,
      "reminder text",
    );

    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content[0]).toEqual({
      type: "text",
      text: "<system-reminder>\nreminder text\n</system-reminder>",
    });
    expect(content[1]).toEqual({ type: "text", text: "what is this" });
  });

  it("returns the history unchanged when there are no user messages", () => {
    const history: ModelMessage[] = [
      { role: "system", content: "persona" },
      { role: "assistant", content: "hello" },
    ];

    const result = injectSystemReminderIntoLastUserMessage(history, "reminder");

    expect(result).toEqual(history);
  });

  it("does not mutate the original array", () => {
    const history: ModelMessage[] = [{ role: "user", content: "original" }];
    const original = [...history];

    injectSystemReminderIntoLastUserMessage(history, "test");

    expect(history[0]?.content).toBe("original");
    expect(history).toEqual(original);
  });

  it("is idempotent on string content: re-injecting the same reminder does not stack", () => {
    const history: ModelMessage[] = [{ role: "user", content: "do something" }];

    const once = injectSystemReminderIntoLastUserMessage(history, "reminder A");
    const twice = injectSystemReminderIntoLastUserMessage(once, "reminder A");

    expect(twice).toEqual(once);
    const content = twice[0]?.content as string;
    const reminderMatches = content.match(/<system-reminder>/g) ?? [];
    expect(reminderMatches).toHaveLength(1);
  });

  it("replaces (not stacks) an existing reminder when re-injecting with new body", () => {
    const history: ModelMessage[] = [{ role: "user", content: "do something" }];

    const first = injectSystemReminderIntoLastUserMessage(history, "old");
    const second = injectSystemReminderIntoLastUserMessage(first, "new");

    const content = second[0]?.content as string;
    const reminderMatches = content.match(/<system-reminder>/g) ?? [];
    expect(reminderMatches).toHaveLength(1);
    expect(content).toContain("new");
    expect(content).not.toContain("old");
    expect(content).toContain("do something");
  });

  it("strips multiple stacked reminder blocks left by earlier broken runs", () => {
    const corruptedContent =
      "<system-reminder>\nstale 1\n</system-reminder>\n\n" +
      "<system-reminder>\nstale 2\n</system-reminder>\n\n" +
      "actual user text";
    const history: ModelMessage[] = [
      { role: "user", content: corruptedContent },
    ];

    const result = injectSystemReminderIntoLastUserMessage(history, "fresh");
    const content = result[0]?.content as string;
    const reminderMatches = content.match(/<system-reminder>/g) ?? [];
    expect(reminderMatches).toHaveLength(1);
    expect(content).toContain("fresh");
    expect(content).not.toContain("stale 1");
    expect(content).not.toContain("stale 2");
    expect(content).toContain("actual user text");
  });

  it("strips a leading reminder text part from array content before re-injecting", () => {
    const history: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nstale\n</system-reminder>",
          },
          { type: "text", text: "actual user text" },
        ],
      },
    ];

    const result = injectSystemReminderIntoLastUserMessage(history, "fresh");
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: "<system-reminder>\nfresh\n</system-reminder>",
    });
    expect(content[1]).toEqual({ type: "text", text: "actual user text" });
  });

  it("re-injects on string content even when the original message is empty", () => {
    const history: ModelMessage[] = [{ role: "user", content: "" }];
    const once = injectSystemReminderIntoLastUserMessage(history, "reminder");
    const twice = injectSystemReminderIntoLastUserMessage(once, "reminder");

    expect(twice).toEqual(once);
    const content = twice[0]?.content as string;
    const reminderMatches = content.match(/<system-reminder>/g) ?? [];
    expect(reminderMatches).toHaveLength(1);
  });
});
