export interface McpPreset {
  name: string;
  url: string;
  description: string;
  authType?: "oauth" | "token" | "github-oauth";
  tokenHelpUrl?: string;
  searchTools?: string[];
  exampleQueries: string[];
  // `name` stays lowercase because it's an identifier used in action IDs,
  // slash command args, redis keys, and OAuth state. `displayName` carries
  // the brand-correct casing (e.g. "PostHog", "PlanetScale") for UI surfaces.
  displayName?: string;
  // Hide from the default onboarding grid (keeps the most-used tools
  // surfaced first without removing the preset from `/mcp-add` or other
  // entry points).
  hiddenByDefault?: boolean;
  // Identifier into MCP_SHIMS. When set, Pookie does NOT open an MCP
  // transport against `url`; instead it builds tools locally from the
  // shim's REST wrappers. The agent still sees them as `mcp_<name>_*`
  // tools so prompts, search routing, and system reminders treat the
  // integration uniformly with real MCP servers.
  shim?: string;
}

export const MCP_PRESETS: Record<string, McpPreset> = {
  linear: {
    name: "linear",
    displayName: "Linear",
    url: "https://mcp.linear.app/mcp",
    description: "project management",
    searchTools: [
      "list_issues",
      "get_issue",
      "list_comments",
      "get_comment",
      "list_projects",
      "get_project",
      "list_documents",
      "get_document",
      "list_teams",
      "get_team",
      "list_users",
      "get_user",
    ],
    exampleQueries: [
      "what linear issues are assigned to me right now?",
      "summarize the open issues in the current sprint",
    ],
  },
  github: {
    name: "github",
    displayName: "GitHub",
    url: "https://api.githubcopilot.com/mcp",
    description: "repos, issues, prs",
    authType: "github-oauth",
    tokenHelpUrl: "https://github.com/settings/personal-access-tokens/new",
    searchTools: [
      "search_issues",
      "search_pull_requests",
      "search_repositories",
      "search_code",
      "search_users",
      "search_orgs",
      "get_issue",
      "get_issue_comments",
      "get_pull_request",
      "get_pull_request_comments",
      "get_pull_request_files",
      "list_issues",
      "list_pull_requests",
      "list_commits",
      "get_commit",
      "get_file_contents",
    ],
    exampleQueries: [
      "find open github issues mentioning 'flaky test' in our org",
      "show me my open pull requests across all repos",
    ],
  },
  axiom: {
    name: "axiom",
    displayName: "Axiom",
    url: "https://mcp.axiom.co/mcp",
    description: "logs + observability",
    searchTools: ["queryApl", "listDatasets", "getDatasetSchema"],
    exampleQueries: [
      "query axiom for 5xx errors in the last hour",
      "what datasets do we have in axiom?",
    ],
  },
  sentry: {
    name: "sentry",
    displayName: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    description: "error tracking",
    exampleQueries: [
      "what are the top unresolved sentry issues from the last 24h?",
      "summarize the most recent sentry errors in production",
    ],
  },
  stripe: {
    name: "stripe",
    displayName: "Stripe",
    url: "https://mcp.stripe.com",
    description: "payments + billing",
    exampleQueries: [
      "look up the latest stripe customer by email",
      "what subscription plans do we have in stripe?",
    ],
  },
  vercel: {
    name: "vercel",
    displayName: "Vercel",
    url: "https://mcp.vercel.com",
    description: "deployments",
    exampleQueries: [
      "which vercel deployments failed in the last week?",
      "list my vercel projects",
    ],
  },
  posthog: {
    name: "posthog",
    displayName: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    description: "product analytics",
    searchTools: [
      "insights-get-all",
      "insight-get",
      "insight-get-sql",
      "dashboards-get-all",
      "dashboard-get",
      "feature-flag-get-all",
      "feature-flag-get-definition",
      "error-tracking-list",
      "error-tracking-details",
      "query-run",
      "list-projects",
      "list-organizations",
      "docs-search",
    ],
    exampleQueries: [
      "what posthog feature flags are enabled in production?",
      "show me the top 10 events by volume from the last week",
    ],
  },
  mercury: {
    name: "mercury",
    displayName: "Mercury",
    url: "https://mcp.mercury.com/mcp",
    description: "banking",
    hiddenByDefault: true,
    exampleQueries: [
      "what's our current mercury account balance?",
      "show me mercury transactions from the last 7 days",
    ],
  },
  repogrep: {
    name: "repogrep",
    displayName: "Repogrep",
    url: "https://repogrep.com/api/mcp/mcp",
    description: "search public github repos",
    hiddenByDefault: true,
    exampleQueries: [
      "find public repos that combine zustand and trpc",
      "search github for examples of writing a slack bot in rust",
    ],
  },
  cloudflare: {
    name: "cloudflare",
    displayName: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    description: "workers, dns, api",
    exampleQueries: [
      "list my cloudflare workers",
      "what dns records do we have for our root domain?",
    ],
  },
  supabase: {
    name: "supabase",
    displayName: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    description: "postgres + projects",
    hiddenByDefault: true,
    exampleQueries: [
      "list my supabase projects",
      "what tables are in our main supabase database?",
    ],
  },
  neon: {
    name: "neon",
    displayName: "Neon",
    url: "https://mcp.neon.tech/mcp",
    description: "postgres branches",
    hiddenByDefault: true,
    exampleQueries: [
      "list my neon postgres branches",
      "what databases do we have on neon?",
    ],
  },
  planetscale: {
    name: "planetscale",
    displayName: "PlanetScale",
    url: "https://mcp.pscale.dev/mcp/planetscale",
    description: "mysql",
    hiddenByDefault: true,
    exampleQueries: [
      "list my planetscale databases",
      "what branches exist on our main planetscale db?",
    ],
  },
  pagerduty: {
    name: "pagerduty",
    displayName: "PagerDuty",
    url: "https://mcp.pagerduty.com/mcp",
    description: "incident management",
    hiddenByDefault: true,
    exampleQueries: [
      "who's on call right now?",
      "list unresolved pagerduty incidents from the last 24h",
    ],
  },
  render: {
    name: "render",
    displayName: "Render",
    url: "https://mcp.render.com/mcp",
    description: "deployments + services",
    hiddenByDefault: true,
    exampleQueries: [
      "list my render services",
      "which render deployments failed recently?",
    ],
  },
  exa: {
    name: "exa",
    displayName: "Exa",
    url: "https://mcp.exa.ai/mcp",
    description: "ai web search",
    hiddenByDefault: true,
    exampleQueries: [
      "find recent articles about model context protocol",
      "search the web for best practices on slack bot onboarding",
    ],
  },
  rippling: {
    name: "rippling",
    displayName: "Rippling",
    url: "https://api.rippling.com",
    description: "hr, employees, leave",
    authType: "token",
    tokenHelpUrl: "https://developer.rippling.com/",
    shim: "rippling",
    // Subset deliberately excludes the three heaviest paginated calls
    // (list_employees_including_terminated, list_leave_balances,
    // get_leave_balance). The search subagent runs sequential
    // explorations and these endpoints can return tens of thousands of
    // tokens of JSON — the main agent can still call them when the
    // user explicitly asks about former employees or PTO balances.
    searchTools: [
      "list_employees",
      "get_employee",
      "list_leave_requests",
      "get_current_company",
      "get_departments",
      "get_teams",
      "get_levels",
      "get_company_leave_types",
      "get_current_user",
    ],
    exampleQueries: [
      "who's out on leave this week according to rippling?",
      "list everyone in the engineering department in rippling",
    ],
  },
};

const resolveByPrefix = <T>(
  registry: Record<string, T>,
  name: string,
): T | undefined => {
  const lower = name.toLowerCase();

  const exactMatch = registry[lower];
  if (exactMatch) return exactMatch;

  const separatorIndex = lower.indexOf("_");
  if (separatorIndex > 0) {
    const prefix = lower.slice(0, separatorIndex);
    return registry[prefix];
  }

  return undefined;
};

export const resolvePreset = (name: string): McpPreset | undefined =>
  resolveByPrefix(MCP_PRESETS, name);

export const getPresetDisplayName = (preset: McpPreset): string =>
  preset.displayName ?? preset.name;

export const resolveShimName = (serverName: string): string | undefined =>
  resolvePreset(serverName)?.shim;
