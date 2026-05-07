import {
  RIPPLING_API_BASE_URL,
  RIPPLING_REQUEST_TIMEOUT_MS,
  RIPPLING_USER_AGENT,
} from "./constants";

export interface RipplingRequestError {
  status: number;
  message: string;
}

export class RipplingApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RipplingApiError";
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

export const ripplingRequest = async <Result>(
  token: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<Result> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    RIPPLING_REQUEST_TIMEOUT_MS,
  );

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
  } finally {
    clearTimeout(timeoutHandle);
  }
};

export const probeRipplingToken = async (
  token: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
  try {
    await ripplingRequest<unknown>(token, "/companies/current");
    return { ok: true };
  } catch (error) {
    if (error instanceof RipplingApiError) {
      return { ok: false, status: error.status, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message };
  }
};
