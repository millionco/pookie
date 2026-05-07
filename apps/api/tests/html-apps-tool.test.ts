import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyHtmlAppToken } from "../server/html-apps/sign-token";
import { MAX_HTML_BYTES } from "../server/tools/constants";
import { createHtmlAppTool } from "../server/tools/html-app";

import type * as AI from "ai";
import type { StateAdapter } from "chat";

import type { PookieToolResult } from "../server/agent/tool-result";

interface ToolResultShape {
  id: string;
  url: string;
  title: string;
}

const buildMockState = (): StateAdapter => {
  const inMemory = new Map<string, unknown>();
  return {
    set: vi.fn(async (key: string, value: unknown) => {
      inMemory.set(key, value);
    }),
    get: vi.fn(async (key: string) => inMemory.get(key) ?? null),
  } as unknown as StateAdapter;
};

const TOOL_CALL_OPTIONS = {
  toolCallId: "tc-test",
  messages: [],
} as unknown as AI.ToolCallOptions;

const validHtml = "<!doctype html><html><body>hi</body></html>";

const callExecute = async (
  tool: ReturnType<typeof createHtmlAppTool>,
  input: { title: string; description: string; html: string },
): Promise<PookieToolResult<ToolResultShape>> => {
  if (typeof tool.execute !== "function") {
    throw new Error("tool.execute is missing");
  }
  const raw = await tool.execute(input, TOOL_CALL_OPTIONS);
  return raw as PookieToolResult<ToolResultShape>;
};

describe("create_html_app tool", () => {
  beforeEach(() => {
    process.env.SLACK_ENCRYPTION_KEY = "test-encryption-key-for-tool-tests-x";
    process.env.BASE_URL = "https://pookie.example.com";
  });

  afterEach(() => {
    delete process.env.SLACK_ENCRYPTION_KEY;
    delete process.env.BASE_URL;
  });

  it("creates an app, returns a verifiable signed url, and persists the row", async () => {
    const state = buildMockState();
    const tool = createHtmlAppTool({
      state,
      teamId: "T-test",
      userId: "U-creator",
      channelId: "C-channel",
    });

    const output = await callExecute(tool, {
      title: "Vesting Calculator",
      description: "Configure 4-year vest with 1-year cliff",
      html: validHtml,
    });

    expect(output.type).toBe("success");
    if (output.type !== "success") return;

    expect(output.result.title).toBe("Vesting Calculator");
    expect(output.result.url).toMatch(/^https:\/\/pookie\.example\.com\/a\//);

    const token = output.result.url.split("/a/")[1];
    const verified = verifyHtmlAppToken({
      token,
      secret: process.env.SLACK_ENCRYPTION_KEY!,
    });
    expect(verified).toEqual({ teamId: "T-test", id: output.result.id });
  });

  it("rejects oversized html with a validation error", async () => {
    const state = buildMockState();
    const tool = createHtmlAppTool({ state, teamId: "T-test" });
    const giant = `<!doctype html><html><body>${"x".repeat(MAX_HTML_BYTES + 100)}</body></html>`;

    const output = await callExecute(tool, {
      title: "Too big",
      description: "Should fail",
      html: giant,
    });

    expect(output.type).toBe("error");
    if (output.type !== "error") return;
    expect(output.error.kind).toBe("validation");
    expect(output.error.message).toContain("exceeds");
  });

  it("rejects html that does not look like a complete document", async () => {
    const state = buildMockState();
    const tool = createHtmlAppTool({ state, teamId: "T-test" });

    const output = await callExecute(tool, {
      title: "Fragment",
      description: "Not a doc",
      html: "<div>just a fragment</div>",
    });

    expect(output.type).toBe("error");
    if (output.type !== "error") return;
    expect(output.error.kind).toBe("validation");
    expect(output.error.message).toContain("complete document");
  });

  it("errors when SLACK_ENCRYPTION_KEY is unset", async () => {
    delete process.env.SLACK_ENCRYPTION_KEY;
    const state = buildMockState();
    const tool = createHtmlAppTool({ state, teamId: "T-test" });

    const output = await callExecute(tool, {
      title: "x",
      description: "x",
      html: validHtml,
    });

    expect(output.type).toBe("error");
  });
});
