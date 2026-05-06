import { createHmac, timingSafeEqual } from "node:crypto";

interface HtmlAppTokenPayload {
  teamId: string;
  id: string;
  exp: number;
}

interface SignHtmlAppTokenInput {
  teamId: string;
  id: string;
  expiresAt: Date;
  secret: string;
}

interface VerifyHtmlAppTokenInput {
  token: string;
  secret: string;
  now?: Date;
}

const toBase64Url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (input: string): Buffer => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
};

const computeSignature = (payloadSegment: string, secret: string): string => {
  const hmac = createHmac("sha256", secret);
  hmac.update(payloadSegment);
  return toBase64Url(hmac.digest());
};

export const signHtmlAppToken = ({
  teamId,
  id,
  expiresAt,
  secret,
}: SignHtmlAppTokenInput): string => {
  const payload: HtmlAppTokenPayload = {
    teamId,
    id,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signature = computeSignature(payloadSegment, secret);
  return `${payloadSegment}.${signature}`;
};

export const verifyHtmlAppToken = ({
  token,
  secret,
  now = new Date(),
}: VerifyHtmlAppTokenInput): { teamId: string; id: string } | null => {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null;

  const payloadSegment = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);
  const expectedSignature = computeSignature(payloadSegment, secret);

  const providedBuffer = fromBase64Url(providedSignature);
  const expectedBuffer = fromBase64Url(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  let payload: HtmlAppTokenPayload;
  try {
    payload = JSON.parse(fromBase64Url(payloadSegment).toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof payload.teamId !== "string" ||
    typeof payload.id !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }

  if (payload.exp * 1000 <= now.getTime()) return null;

  return { teamId: payload.teamId, id: payload.id };
};
