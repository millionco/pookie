export const RIPPLING_API_BASE_URL = "https://api.rippling.com/platform/api";

export const RIPPLING_DEFAULT_PAGE_LIMIT = 50;
export const RIPPLING_MAX_PAGE_LIMIT = 100;

export const RIPPLING_REQUEST_TIMEOUT_MS = 15000;

export const RIPPLING_USER_AGENT = "pookie-rippling-shim/1.0";

// Single source of truth for the help link. Points at Rippling's
// developer docs hub, which is a stable Help Center URL that walks
// users to the right "Create an API key" surface for their tenant.
// Avoids hard-coding `app.rippling.com/...` paths whose UI may change.
export const RIPPLING_TOKEN_HELP_URL = "https://developer.rippling.com/";
