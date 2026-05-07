import { describe, expect, it } from "vitest";

import {
  signHtmlAppToken,
  verifyHtmlAppToken,
} from "../server/html-apps/sign-token";

const SECRET = "test-secret-key-do-not-use-in-prod-32";
const ALT_SECRET = "different-secret-also-do-not-use-yes!";

describe("signHtmlAppToken / verifyHtmlAppToken", () => {
  it("round-trips a valid token", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const token = signHtmlAppToken({
      teamId: "T123",
      id: "abc-123",
      expiresAt,
      secret: SECRET,
    });
    const verified = verifyHtmlAppToken({ token, secret: SECRET });
    expect(verified).toEqual({ teamId: "T123", id: "abc-123" });
  });

  it("returns null when the token has expired", () => {
    const expiredAt = new Date(Date.now() - 1_000);
    const token = signHtmlAppToken({
      teamId: "T123",
      id: "abc-123",
      expiresAt: expiredAt,
      secret: SECRET,
    });
    expect(verifyHtmlAppToken({ token, secret: SECRET })).toBeNull();
  });

  it("returns null when the secret does not match", () => {
    const token = signHtmlAppToken({
      teamId: "T123",
      id: "abc-123",
      expiresAt: new Date(Date.now() + 60_000),
      secret: SECRET,
    });
    expect(verifyHtmlAppToken({ token, secret: ALT_SECRET })).toBeNull();
  });

  it("returns null when the payload has been tampered with", () => {
    const token = signHtmlAppToken({
      teamId: "T123",
      id: "abc-123",
      expiresAt: new Date(Date.now() + 60_000),
      secret: SECRET,
    });
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        teamId: "T-EVIL",
        id: "abc-123",
        exp: Math.floor((Date.now() + 60_000) / 1000),
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const tampered = `${tamperedPayload}.${signature}`;
    expect(verifyHtmlAppToken({ token: tampered, secret: SECRET })).toBeNull();
  });

  it("returns null for malformed tokens", () => {
    for (const malformed of [
      "",
      ".",
      "no-dot",
      ".no-payload",
      "no-signature.",
      "totally-not-base64.totally-not-base64",
    ]) {
      expect(
        verifyHtmlAppToken({ token: malformed, secret: SECRET }),
      ).toBeNull();
    }
  });
});
