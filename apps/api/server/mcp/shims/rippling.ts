import { z } from "zod";

import { defineTool } from "../../agent/define-tool";
import { toolErr, toolResult } from "../../agent/tool-result";
import {
  RIPPLING_DEFAULT_PAGE_LIMIT,
  RIPPLING_MAX_PAGE_LIMIT,
  RIPPLING_TOKEN_HELP_URL,
} from "./constants";
import {
  probeRipplingToken,
  RipplingApiError,
  ripplingRequest,
  RipplingTimeoutError,
} from "./rippling-client";

import type * as AI from "ai";

import type { PookieToolError } from "../../agent/tool-result";

interface RipplingToolContext {
  token: string;
}

// Stripped from list responses before we hand them to the model. These
// fields are either heavy (workSchedule, customFields, photo blobs)
// or rarely useful at list level (drill in via get_employee for the
// full record). Without this, a single list_employees call with a 50-
// employee page can be 50–80k characters of JSON.
const COMPACT_EMPLOYEE_DROP_FIELDS = [
  "photo",
  "smallPhoto",
  "workSchedule",
  "customFields",
  "preferredFirstName",
  "preferredLastName",
  "spokeId",
  "identifiedGender",
  "isInternational",
] as const;

const COMPACT_LEAVE_REQUEST_DROP_FIELDS = [
  "dates",
  "partialDays",
  "createdAt",
  "updatedAt",
  "startDateStartTime",
  "endDateEndTime",
  "startDateCustomHours",
  "endDateCustomHours",
] as const;

const stripFields = <T extends Record<string, unknown>>(
  record: T,
  drop: ReadonlyArray<string>,
): Record<string, unknown> => {
  const compact: Record<string, unknown> = { ...record };
  for (const field of drop) delete compact[field];
  return compact;
};

const compactRecord =
  (drop: ReadonlyArray<string>) =>
  (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return stripFields(item as Record<string, unknown>, drop);
  };

const compactEmployee = compactRecord(COMPACT_EMPLOYEE_DROP_FIELDS);
const compactLeaveRequest = compactRecord(COMPACT_LEAVE_REQUEST_DROP_FIELDS);

const paginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(RIPPLING_MAX_PAGE_LIMIT)
    .optional()
    .default(RIPPLING_DEFAULT_PAGE_LIMIT)
    .describe(
      `Page size. Max ${RIPPLING_MAX_PAGE_LIMIT}. Defaults to ${RIPPLING_DEFAULT_PAGE_LIMIT}.`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of records to skip — use for paging beyond the limit."),
};

const ripplingErrorToToolError = (caughtError: unknown): PookieToolError => {
  if (caughtError instanceof RipplingTimeoutError) {
    return toolErr(
      "validation",
      `Rippling request timed out after ${caughtError.timeoutMs}ms — try a smaller limit or narrower filter`,
      { code: "rippling_timeout" },
    );
  }
  if (caughtError instanceof RipplingApiError) {
    if (caughtError.status === 401 || caughtError.status === 403) {
      return toolErr(
        "validation",
        `Rippling rejected the API key (${caughtError.status}). ${caughtError.message}`.trim(),
        {
          code: "rippling_unauthorized",
          instructions: `ask the user to regenerate the key (${RIPPLING_TOKEN_HELP_URL}) and re-run \`/mcp-add rippling <key>\`.`,
        },
      );
    }
    if (caughtError.status === 429) {
      return toolErr("validation", "Rippling rate limited the request", {
        code: "rippling_rate_limited",
      });
    }
    return toolErr(
      "unknown",
      `Rippling API error (${caughtError.status}): ${caughtError.message}`,
      { code: `rippling_${caughtError.status}` },
    );
  }
  const message =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  return toolErr("unknown", `Rippling request failed: ${message}`);
};

const RIPPLING_RESULT_SCHEMA = z.unknown();

type ToolOutcome = { type: "success"; result: unknown } | PookieToolError;

const formatArrayOutput = (
  output: ToolOutcome,
  recordLabel: string,
  project?: (record: unknown) => unknown,
): string => {
  if (output.type === "error") return output.error.message;
  const data = output.result;
  if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
  const projected = project ? data.map(project) : data;
  return `${data.length} ${recordLabel}\n\n${JSON.stringify(projected, null, 2)}`;
};

const formatObjectOutput = (output: ToolOutcome): string => {
  if (output.type === "error") return output.error.message;
  return JSON.stringify(output.result, null, 2);
};

const arrayModelOutput = (recordLabel: string) => (output: ToolOutcome) =>
  formatArrayOutput(output, recordLabel);

const arrayModelOutputWithProjection =
  (recordLabel: string, project: (record: unknown) => unknown) =>
  (output: ToolOutcome) =>
    formatArrayOutput(output, recordLabel, project);

const callRippling = async <Result>(
  context: RipplingToolContext,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
) => {
  try {
    const data = await ripplingRequest<Result>(context.token, path, query);
    return toolResult(data);
  } catch (caughtError) {
    return ripplingErrorToToolError(caughtError);
  }
};

const getCurrentCompanyTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "Returns the Rippling company tied to this API key — name, domain, leave-policy ownership, etc. Cheap call; use as a sanity check before deeper queries.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch current company",
    execute: async () => callRippling(context, "/companies/current"),
    toModelOutput: formatObjectOutput,
  });

const getCurrentUserTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "Returns the user identity associated with this API key. Use to confirm whose context Pookie is acting under in Rippling.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch current user",
    execute: async () => callRippling(context, "/me"),
    toModelOutput: formatObjectOutput,
  });

const getDepartmentsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List all departments in Rippling. Returns id + name pairs you can match against an employee's `department` field.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch departments",
    execute: async () => callRippling(context, "/companies/departments"),
    toModelOutput: arrayModelOutput("department(s)"),
  });

const getWorkLocationsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List the company's work locations (offices + remote). Use to map an employee's work location nickname to a full address.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch work locations",
    execute: async () => callRippling(context, "/companies/work_locations"),
    toModelOutput: arrayModelOutput("location(s)"),
  });

const getTeamsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List all teams (sub-org groupings, distinct from departments). Returns id/name pairs.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch teams",
    execute: async () => callRippling(context, "/companies/teams"),
    toModelOutput: arrayModelOutput("team(s)"),
  });

const getLevelsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List company levels (e.g. Manager, Senior, Executive). Useful for headcount-by-level questions.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch levels",
    execute: async () => callRippling(context, "/companies/levels"),
    toModelOutput: arrayModelOutput("level(s)"),
  });

const getCompanyLeaveTypesTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List the leave types configured for the company (vacation, sick, jury duty, custom policies).",
    inputSchema: z.object({
      managedBy: z
        .enum(["PTO", "LEAVES", "TILT"])
        .optional()
        .describe(
          "Filter to a specific Rippling leave subsystem. Omit for all.",
        ),
    }),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch leave types",
    execute: async ({ managedBy }) =>
      callRippling(context, "/companies/leave_types", { managedBy }),
    toModelOutput: arrayModelOutput("leave type(s)"),
  });

const getCustomFieldsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List the company's custom employee fields and their types. Use to interpret the `customFields` blob on employee records.",
    inputSchema: z.object({}),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch custom fields",
    execute: async () => callRippling(context, "/companies/custom_fields"),
    toModelOutput: arrayModelOutput("custom field(s)"),
  });

const listEmployeesTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List ACTIVE employees. Paginated — pass `limit`/`offset` to walk results. Returned fields depend on the API key scopes; only id, personalEmail, and roleState are guaranteed. Heavy fields (workSchedule, customFields, photos) are stripped from the list view; use get_employee for the full record.",
    inputSchema: z.object(paginationSchema),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to list employees",
    execute: async ({ limit, offset }) =>
      callRippling(context, "/employees", { limit, offset }),
    toModelOutput: arrayModelOutputWithProjection(
      "employee(s)",
      compactEmployee,
    ),
  });

const listEmployeesIncludingTerminatedTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List employees including TERMINATED ones. Use only when the question explicitly involves former employees — list_employees is cheaper otherwise. Same field stripping as list_employees applies.",
    inputSchema: z.object(paginationSchema),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to list employees including terminated",
    execute: async ({ limit, offset }) =>
      callRippling(context, "/employees/include_terminated", { limit, offset }),
    toModelOutput: arrayModelOutputWithProjection(
      "employee(s)",
      compactEmployee,
    ),
  });

const getEmployeeTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "Fetch a single employee by Rippling role ID. Get role IDs from list_employees results — DO NOT pass a Slack ID, email, or full name here. Returns the full record (including custom fields and work schedule).",
    inputSchema: z.object({
      employeeId: z
        .string()
        .min(1)
        .describe("Rippling employee role ID (the `id` field on Employee)."),
    }),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch employee",
    execute: async ({ employeeId }) =>
      callRippling(context, `/employees/${encodeURIComponent(employeeId)}`),
    toModelOutput: formatObjectOutput,
  });

const getLeaveBalanceTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "Get leave balances for ONE employee (role). For all employees in one call, use list_leave_balances instead.",
    inputSchema: z.object({
      role: z
        .string()
        .min(1)
        .describe("Rippling role ID (employee.id) to fetch balances for."),
    }),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to fetch leave balance",
    execute: async ({ role }) =>
      callRippling(context, `/leave_balances/${encodeURIComponent(role)}`),
    toModelOutput: formatObjectOutput,
  });

const listLeaveBalancesTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List leave balances across employees. Heavy call — paginate aggressively.",
    inputSchema: z.object(paginationSchema),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to list leave balances",
    execute: async ({ limit, offset }) =>
      callRippling(context, "/leave_balances", { limit, offset }),
    toModelOutput: arrayModelOutput("leave balance(s)"),
  });

const listLeaveRequestsTool = (context: RipplingToolContext) =>
  defineTool({
    description:
      "List leave requests with optional filters. The from/to filters check OVERLAP with the request's range — useful for 'who is out next week' style questions. Per-day breakdowns and timestamp metadata are stripped from list view.",
    inputSchema: z.object({
      role: z
        .string()
        .optional()
        .describe(
          "Filter to a specific employee's role ID (their `id` from list_employees).",
        ),
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "CANCELED"])
        .optional()
        .describe("Filter by leave request status."),
      startDate: z
        .string()
        .optional()
        .describe(
          "Match requests starting on this date (YYYY-MM-DD). Use `from`/`to` for ranges.",
        ),
      endDate: z
        .string()
        .optional()
        .describe(
          "Match requests ending on this date (YYYY-MM-DD). Use `from`/`to` for ranges.",
        ),
      from: z
        .string()
        .optional()
        .describe(
          "Range start (YYYY-MM-DD). Returns requests overlapping [from, to].",
        ),
      to: z
        .string()
        .optional()
        .describe(
          "Range end (YYYY-MM-DD). Returns requests overlapping [from, to].",
        ),
      leavePolicy: z
        .string()
        .optional()
        .describe("Filter to a specific leave policy ID."),
      ...paginationSchema,
    }),
    resultSchema: RIPPLING_RESULT_SCHEMA,
    errorFallback: "failed to list leave requests",
    execute: async ({
      role,
      status,
      startDate,
      endDate,
      from,
      to,
      leavePolicy,
      limit,
      offset,
    }) =>
      callRippling(context, "/leave_requests", {
        role,
        status,
        startDate,
        endDate,
        from,
        to,
        leavePolicy,
        limit,
        offset,
      }),
    toModelOutput: arrayModelOutputWithProjection(
      "leave request(s)",
      compactLeaveRequest,
    ),
  });

export const buildRipplingTools = (token: string): Record<string, AI.Tool> => {
  const context: RipplingToolContext = { token };
  return {
    get_current_company: getCurrentCompanyTool(context),
    get_current_user: getCurrentUserTool(context),
    get_departments: getDepartmentsTool(context),
    get_work_locations: getWorkLocationsTool(context),
    get_teams: getTeamsTool(context),
    get_levels: getLevelsTool(context),
    get_company_leave_types: getCompanyLeaveTypesTool(context),
    get_custom_fields: getCustomFieldsTool(context),
    list_employees: listEmployeesTool(context),
    list_employees_including_terminated:
      listEmployeesIncludingTerminatedTool(context),
    get_employee: getEmployeeTool(context),
    get_leave_balance: getLeaveBalanceTool(context),
    list_leave_balances: listLeaveBalancesTool(context),
    list_leave_requests: listLeaveRequestsTool(context),
  };
};

export interface RipplingShimValidationResult {
  ok: boolean;
  toolCount: number;
  message?: string;
}

export const validateRipplingShim = async (
  token: string,
): Promise<RipplingShimValidationResult> => {
  const probe = await probeRipplingToken(token);
  const toolCount = Object.keys(buildRipplingTools(token)).length;

  if (probe.ok) return { ok: true, toolCount };

  if (probe.timedOut) {
    return {
      ok: false,
      toolCount,
      message: `${probe.message} — Rippling didn't respond in time. retry, or check ${RIPPLING_TOKEN_HELP_URL} if the issue persists.`,
    };
  }

  if (probe.status === 401 || probe.status === 403) {
    return {
      ok: false,
      toolCount,
      message: `Rippling rejected the API key (${probe.status}): ${probe.message}. regenerate at ${RIPPLING_TOKEN_HELP_URL}.`,
    };
  }

  return {
    ok: false,
    toolCount,
    message: `Rippling probe failed (${probe.status || "network"}): ${probe.message}`,
  };
};
