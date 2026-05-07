import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHtmlApp, getHtmlApp } from "../server/html-apps/store";

import type { StateAdapter } from "chat";

interface MockStateEntry {
  value: unknown;
  ttlMs?: number;
}

const buildMockState = (): {
  state: StateAdapter;
  store: Map<string, MockStateEntry>;
} => {
  const store = new Map<string, MockStateEntry>();

  const state = {
    set: vi.fn(async (key: string, value: unknown, ttlMs?: number) => {
      store.set(key, { value, ttlMs });
    }),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
  } as unknown as StateAdapter;

  return { state, store };
};

const TEAM_ID = "T-test";

describe("html-apps store", () => {
  beforeEach(() => {
    process.env.SLACK_ENCRYPTION_KEY = "test-encryption-key-for-store-tests";
  });

  afterEach(() => {
    delete process.env.SLACK_ENCRYPTION_KEY;
  });

  it("round-trips an html app via the state adapter", async () => {
    const { state } = buildMockState();
    const { id } = await createHtmlApp(state, TEAM_ID, {
      title: "Calculator",
      description: "Vesting calculator",
      html: "<!doctype html><html><body>hi</body></html>",
      createdBy: "U-creator",
      channelId: "C-channel",
    });

    const fetched = await getHtmlApp(state, TEAM_ID, id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(id);
    expect(fetched?.teamId).toBe(TEAM_ID);
    expect(fetched?.title).toBe("Calculator");
    expect(fetched?.description).toBe("Vesting calculator");
    expect(fetched?.html).toBe("<!doctype html><html><body>hi</body></html>");
    expect(fetched?.createdBy).toBe("U-creator");
    expect(fetched?.channelId).toBe("C-channel");
    expect(typeof fetched?.createdAt).toBe("string");
  });

  it("encrypts the stored value (raw stored value should not contain plaintext html)", async () => {
    const { state, store } = buildMockState();
    const { id } = await createHtmlApp(state, TEAM_ID, {
      title: "Sensitive",
      description: "should not appear in the raw store",
      html: "<!doctype html><html><body>SECRET-MARKER-XYZ</body></html>",
    });

    const rawEntry = store.get(`pookie:htmlApp:${TEAM_ID}:${id}`);
    expect(rawEntry).toBeDefined();
    expect(JSON.stringify(rawEntry?.value)).not.toContain("SECRET-MARKER-XYZ");
  });

  it("sets a TTL on the stored entry", async () => {
    const { state, store } = buildMockState();
    const { id } = await createHtmlApp(state, TEAM_ID, {
      title: "TTL test",
      description: "",
      html: "<!doctype html><html></html>",
    });

    const rawEntry = store.get(`pookie:htmlApp:${TEAM_ID}:${id}`);
    expect(rawEntry?.ttlMs).toBeGreaterThan(0);
  });

  it("returns null for missing apps", async () => {
    const { state } = buildMockState();
    expect(await getHtmlApp(state, TEAM_ID, "does-not-exist")).toBeNull();
  });

  it("isolates apps by teamId", async () => {
    const { state } = buildMockState();
    const { id } = await createHtmlApp(state, TEAM_ID, {
      title: "Tenant A",
      description: "",
      html: "<!doctype html><html></html>",
    });

    expect(await getHtmlApp(state, "T-other", id)).toBeNull();
    expect(await getHtmlApp(state, TEAM_ID, id)).not.toBeNull();
  });
});
