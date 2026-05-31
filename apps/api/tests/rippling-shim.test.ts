import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCP_PRESETS, resolveShimName } from "../server/mcp/presets";
import { resolveShim } from "../server/mcp/shims";
import {
  RIPPLING_API_BASE_URL,
  RIPPLING_TOKEN_HELP_URL,
} from "../server/mcp/shims/constants";
import {
  buildRipplingTools,
  validateRipplingShim,
} from "../server/mcp/shims/rippling";

import type * as AI from "ai";

interface ToolSuccess<T> {
  type: "success";
  result: T;
}

interface ToolFailure {
  type: "error";
  error: { code?: string; message: string; instructions?: string };
}

type ToolOutcome<T> = ToolSuccess<T> | ToolFailure;

const runTool = async <T = unknown>(
  tool: AI.Tool,
  input: Record<string, unknown>,
  toolCallId: string,
): Promise<ToolOutcome<T>> => {
  if (!tool.execute) throw new Error("tool has no execute fn");
  const outcome = await tool.execute(input, { toolCallId, messages: [] });
  return outcome as ToolOutcome<T>;
};

interface FetchMockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
}

const buildMockResponse = (response: FetchMockResponse) => ({
  ok: response.ok,
  status: response.status,
  statusText: response.statusText,
  json: () => Promise.resolve(response.body),
  clone() {
    return buildMockResponse(response);
  },
});

const stubFetchOnce = (response: FetchMockResponse) => {
  const fetchSpy = vi.fn().mockResolvedValue(buildMockResponse(response));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rippling preset wiring", () => {
  it("registers rippling as a token-based shim preset", () => {
    const preset = MCP_PRESETS.rippling;
    expect(preset).toBeDefined();
    expect(preset.authType).toBe("token");
    expect(preset.shim).toBe("rippling");
    expect(resolveShimName("rippling")).toBe("rippling");
  });

  it("exposes a shim entry for rippling", () => {
    const shim = resolveShim("rippling");
    expect(shim).toBeDefined();
    expect(typeof shim?.buildTools).toBe("function");
    expect(typeof shim?.validate).toBe("function");
  });

  it("resolves aliased instances (rippling_finance) to the same shim", () => {
    expect(resolveShimName("rippling_finance")).toBe("rippling");
    expect(resolveShimName("rippling_personal")).toBe("rippling");
    expect(resolveShimName("RIPPLING")).toBe("rippling");
  });

  it("does not resolve unrelated names to the rippling shim", () => {
    expect(resolveShimName("linear")).toBeUndefined();
    expect(resolveShimName("rippling-no")).toBeUndefined();
    expect(resolveShimName("rip")).toBeUndefined();
  });

  it("excludes the heaviest paginated tools from search subagent visibility", () => {
    const searchTools = MCP_PRESETS.rippling.searchTools ?? [];
    expect(searchTools).not.toContain("list_employees_including_terminated");
    expect(searchTools).not.toContain("list_leave_balances");
    expect(searchTools).not.toContain("get_leave_balance");
    expect(searchTools).toContain("list_employees");
    expect(searchTools).toContain("list_leave_requests");
  });
});

describe("buildRipplingTools", () => {
  it("returns the full HR/leave toolset", () => {
    const tools = buildRipplingTools("test-token");
    const expectedTools = [
      "get_current_company",
      "get_current_user",
      "get_departments",
      "get_work_locations",
      "get_teams",
      "get_levels",
      "get_company_leave_types",
      "get_custom_fields",
      "list_employees",
      "list_employees_including_terminated",
      "get_employee",
      "get_leave_balance",
      "list_leave_balances",
      "list_leave_requests",
    ];
    for (const toolName of expectedTools) {
      expect(tools[toolName], `missing tool ${toolName}`).toBeDefined();
    }
    expect(Object.keys(tools)).toHaveLength(expectedTools.length);
  });

  it("hits the correct Rippling endpoint with bearer auth and pagination", async () => {
    const employees = [
      { id: "role_123", workEmail: "alice@example.com", roleState: "ACTIVE" },
    ];
    const fetchSpy = stubFetchOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: employees,
    });

    const tools = buildRipplingTools("rippling-key");
    const result = await runTool(
      tools.list_employees,
      { limit: 25, offset: 50 },
      "call_1",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${RIPPLING_API_BASE_URL}/employees?limit=25&offset=50`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer rippling-key");

    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.result).toEqual(employees);
  });

  it("maps a 401 from Rippling to a validation error with regen instructions", async () => {
    stubFetchOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { message: "Invalid API key" },
    });

    const tools = buildRipplingTools("bad-key");
    const result = await runTool(tools.get_current_company, {}, "call_2");
    expect(result.type).toBe("error");
    if (result.type !== "error") return;
    expect(result.error.code).toBe("rippling_unauthorized");
    expect(result.error.instructions).toContain(RIPPLING_TOKEN_HELP_URL);
  });

  it("maps an AbortError-driven timeout to a friendly tool error", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const abortError = new Error("This operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const tools = buildRipplingTools("rippling-key");
    const promise = runTool(tools.get_current_company, {}, "call_timeout");
    await vi.advanceTimersByTimeAsync(20000);
    const result = await promise;

    expect(result.type).toBe("error");
    if (result.type !== "error") return;
    expect(result.error.code).toBe("rippling_timeout");
    expect(result.error.message).toContain("timed out");

    vi.useRealTimers();
  });

  it("strips heavy fields from list_employees output projection", async () => {
    const heavyEmployee = {
      id: "role_1",
      name: "Alice",
      workEmail: "alice@example.com",
      roleState: "ACTIVE",
      photo: "data:image/png;base64,AAAAAAAAA".repeat(1000),
      smallPhoto: "data:image/png;base64,BBBB".repeat(100),
      workSchedule: { MONDAY: { hours: 8 }, TUESDAY: { hours: 8 } },
      customFields: { Marital_Status: "Married", Tshirt: "L" },
    };
    stubFetchOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: [heavyEmployee],
    });

    const tools = buildRipplingTools("rippling-key");
    const tool = tools.list_employees;
    const outcome = await runTool(tool, { limit: 1 }, "call_proj");
    expect(outcome.type).toBe("success");

    if (!tool.toModelOutput) throw new Error("tool missing toModelOutput");
    const modelOutput = tool.toModelOutput({
      toolCallId: "call_proj",
      input: { limit: 1 },
      output: outcome,
    });
    const rendered =
      typeof modelOutput === "string"
        ? modelOutput
        : (modelOutput as { value: string }).value;

    expect(rendered).toContain("alice@example.com");
    expect(rendered).toContain("1 employee(s)");
    // Heavy fields must NOT be in the model-facing output
    expect(rendered).not.toContain("photo");
    expect(rendered).not.toContain("workSchedule");
    expect(rendered).not.toContain("customFields");
    // But the raw success result still has the original payload
    if (outcome.type === "success") {
      expect(outcome.result).toEqual([heavyEmployee]);
    }
  });

  it("forwards leave-request filters as query params", async () => {
    const fetchSpy = stubFetchOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: [],
    });

    const tools = buildRipplingTools("rippling-key");
    await runTool(
      tools.list_leave_requests,
      {
        status: "APPROVED",
        from: "2026-05-01",
        to: "2026-05-31",
        limit: 10,
      },
      "call_3",
    );

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/platform/api/leave_requests");
    expect(parsed.searchParams.get("status")).toBe("APPROVED");
    expect(parsed.searchParams.get("from")).toBe("2026-05-01");
    expect(parsed.searchParams.get("to")).toBe("2026-05-31");
    expect(parsed.searchParams.get("limit")).toBe("10");
    // omitted filters must NOT appear as the literal string "undefined"
    expect(parsed.searchParams.has("role")).toBe(false);
    expect(parsed.searchParams.has("offset")).toBe(false);
  });
});

describe("validateRipplingShim", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok with the tool count on a successful probe", async () => {
    stubFetchOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { id: "company_123", name: "Acme" },
    });

    const result = await validateRipplingShim("good-token");
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBeGreaterThan(0);
  });

  it("returns a regen-instruction message on 401", async () => {
    stubFetchOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { detail: "API key revoked" },
    });

    const result = await validateRipplingShim("bad-token");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("rejected the API key");
    expect(result.message).toContain(RIPPLING_TOKEN_HELP_URL);
  });
});
