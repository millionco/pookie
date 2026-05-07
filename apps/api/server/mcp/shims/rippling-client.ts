import {
  RIPPLING_API_BASE_URL,
  RIPPLING_REQUEST_TIMEOUT_MS,
  RIPPLING_USER_AGENT,
} from "./constants";

export class RipplingApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RipplingApiError";
  }
}

export class RipplingTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Rippling request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.name = "RipplingTimeoutError";
  }
}

const buildAuthHeader = (token: string): Record<string, string> => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  "User-Agent": RIPPLING_USER_AGENT,
});

const stringifyQuery = (
  query: Record<string, string | number | boolean | undefined>,
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
};

// Rippling embeds error details in `{ message }` or `{ detail }` JSON
// bodies depending on which subsystem rejected the request. Drain the
// response body once and surface whichever shape exists.
const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const cloned = response.clone();
    const data = (await cloned.json()) as
      | { message?: string; detail?: string; error?: string }
      | undefined;
    return data?.message ?? data?.detail ?? data?.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
};

// Distinguish a timeout-driven AbortError from any other AbortError the
// runtime might surface, so callers can map it to a friendly tool error
// instead of the cryptic "This operation was aborted" default. We use a
// shared flag instead of `signal.reason` because Node's undici fetch was
// inconsistent about plumbing reason through prior to v20.
const isTimeoutAbort = (error: unknown, didTimeout: boolean): boolean =>
  didTimeout &&
  ((error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" && error instanceof DOMException));

export const ripplingRequest = async <Result>(
  token: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<Result> => {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutHandle = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, RIPPLING_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${RIPPLING_API_BASE_URL}${path}${stringifyQuery(query)}`,
      {
        method: "GET",
        headers: buildAuthHeader(token),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new RipplingApiError(response.status, message);
    }

    return (await response.json()) as Result;
  } catch (caughtError) {
    if (isTimeoutAbort(caughtError, didTimeout)) {
      throw new RipplingTimeoutError(RIPPLING_REQUEST_TIMEOUT_MS);
    }
    throw caughtError;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

export type RipplingProbeResult =
  | { ok: true }
  | { ok: false; status: number; message: string; timedOut?: boolean };

export const probeRipplingToken = async (
  token: string,
): Promise<RipplingProbeResult> => {
  try {
    await ripplingRequest<unknown>(token, "/companies/current");
    return { ok: true };
  } catch (error) {
    if (error instanceof RipplingApiError) {
      return { ok: false, status: error.status, message: error.message };
    }
    if (error instanceof RipplingTimeoutError) {
      return {
        ok: false,
        status: 0,
        message: error.message,
        timedOut: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message };
  }
};
