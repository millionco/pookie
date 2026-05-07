import { afterEach, describe, expect, it, vi } from "vitest";

import { partitionShimConfigs, tryRegisterShim } from "../server/mcp/client";

import type { McpServerConfig } from "../server/mcp/store";

const buildMockResponse = (response: {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
}) => ({
  ok: response.ok,
  status: response.status,
  statusText: response.statusText,
  json: () => Promise.resolve(response.body),
  clone() {
    return buildMockResponse(response);
  },
});

const stubFetchOk = (body: unknown) => {
  const fetchSpy = vi
    .fn()
    .mockResolvedValue(
      buildMockResponse({ ok: true, status: 200, statusText: "OK", body }),
    );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const userScope: McpServerConfig["scope"] = {
  kind: "user",
  userId: "U_TEST",
  teamId: "T_TEST",
};

const ripplingConfig = (
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig => ({
  name: "rippling",
  url: "https://api.rippling.com",
  scope: userScope,
  createdBy: "U_TEST",
  createdAt: 0,
  token: "rip_test_token",
  ...overrides,
});

const customConfig = (name: string): McpServerConfig => ({
  name,
  url: "https://example.invalid/mcp",
  scope: userScope,
  createdBy: "U_TEST",
  createdAt: 0,
});

describe("partitionShimConfigs", () => {
  it("routes shim configs to a separate ingestion bucket", () => {
    const configs = [
      ripplingConfig(),
      customConfig("custom-mcp"),
      customConfig("another-custom"),
    ];

    const result = partitionShimConfigs(configs);

    expect(result.shimEntries).toHaveLength(1);
    expect(result.shimEntries[0]?.config.name).toBe("rippling");
    expect(result.shimEntries[0]?.tools).toBeDefined();
    expect(result.transportConfigs.map((c) => c.name)).toEqual([
      "custom-mcp",
      "another-custom",
    ]);
  });

  it("treats aliased shim instances (rippling_finance) as shim configs too", () => {
    const aliased = ripplingConfig({ name: "rippling_finance" });
    const result = partitionShimConfigs([aliased]);
    expect(result.shimEntries).toHaveLength(1);
    expect(result.transportConfigs).toHaveLength(0);

    const tools = result.shimEntries[0]?.tools ?? {};
    expect(Object.keys(tools)).toContain("list_employees");
    expect(Object.keys(tools)).toContain("get_employee");
  });

  it("returns an error entry (not transport fallback) when a shim config is missing its token", () => {
    const noToken = ripplingConfig({ token: undefined });
    const result = partitionShimConfigs([noToken]);

    expect(result.transportConfigs).toHaveLength(0);
    expect(result.shimEntries).toHaveLength(1);
    expect(result.shimEntries[0]?.tools).toBeNull();
    expect(result.shimEntries[0]?.error?.message).toContain(
      "requires an API key",
    );
    expect(result.shimEntries[0]?.error?.message).toContain(
      "/mcp-add rippling <key>",
    );
  });

  it("never opens an MCP transport for shim configs", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    partitionShimConfigs([ripplingConfig()]);

    // `partitionShimConfigs` builds tools eagerly but tools are lazy; no
    // network call should happen on partition.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("tryRegisterShim", () => {
  it("returns null for non-shim configs (so the caller falls through to MCP transport)", async () => {
    const result = await tryRegisterShim(customConfig("not-a-shim"));
    expect(result).toBeNull();
  });

  it("short-circuits to a connected result without touching @ai-sdk/mcp on a successful probe", async () => {
    stubFetchOk({ id: "company_1", name: "Acme" });

    const result = await tryRegisterShim(ripplingConfig());

    expect(result).toBeDefined();
    expect(result?.connected).toBe(true);
    expect(result?.toolCount).toBeGreaterThan(0);
    expect(result?.authorizationUrl).toBeUndefined();
  });

  it("throws with the missing-token hint when a shim config has no token", async () => {
    await expect(
      tryRegisterShim(ripplingConfig({ token: undefined })),
    ).rejects.toThrow(/requires an API key/);
  });

  it("throws the validation message when Rippling rejects the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        buildMockResponse({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          body: { message: "bad token" },
        }),
      ),
    );

    await expect(
      tryRegisterShim(ripplingConfig({ token: "bad" })),
    ).rejects.toThrow(/rejected the API key/);
  });
});
