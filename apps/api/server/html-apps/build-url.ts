import { HTML_APP_LOCAL_DEV_BASE_URL } from "../tools/constants";

// Read `process.env` directly instead of routing through @/env: t3-env
// snapshots `runtimeEnv` once at module load, so values that depend on
// VERCEL_URL/RAILWAY_PUBLIC_DOMAIN/BASE_URL set later (or in tests) wouldn't
// be visible. The BASE_URL schema entry is optional anyway, so we don't lose
// validation by reading the raw env here.
const resolveBaseUrlFromEnv = (): string | undefined => {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return process.env.BASE_URL || undefined;
};

export const resolveHtmlAppBaseUrl = (): string => {
  const fromEnv = resolveBaseUrlFromEnv();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "BASE_URL must be configured in production to build HTML app URLs.",
    );
  }
  return HTML_APP_LOCAL_DEV_BASE_URL;
};

export const buildHtmlAppUrl = (token: string): string =>
  `${resolveHtmlAppBaseUrl()}/a/${token}`;
