import { extractSlackEventContext } from "../slack/schemas";
import { isSlackAdmin } from "../utils/is-slack-admin";
import { parseSubcommandArgs } from "../utils/parse-slash-command-args";
import { appRuntime } from "../runtime";
import { CONFIG_KEYS } from "./constants";
import { mergeLayers } from "./resolve";
import {
  clearConfigForScope,
  loadConfigForScope,
  saveConfigForScope,
} from "./store";

import type { SlashCommandEvent } from "chat";

import type { ParsedArgs } from "../utils/parse-slash-command-args";
import type {
  PookieConfig,
  PookieConfigKey,
  PookieConfigPartial,
  PookieConfigScope,
  PookieConfigScopeKind,
} from "./schema";

const PERSONALITY_OPTIONS = ["cute", "balanced", "professional"] as const;
const REASONING_EFFORT_OPTIONS = ["minimal", "medium", "high"] as const;

const resolveScope = (
  teamId: string,
  userId: string,
  channelId: string | undefined,
  isChannel: boolean,
  isGlobal: boolean,
): PookieConfigScope | { error: string } => {
  if (isGlobal) return { kind: "global", teamId };
  if (isChannel) {
    if (!channelId) return { error: "cannot use --channel outside a channel" };
    return { kind: "channel", channelId, teamId };
  }
  return { kind: "user", userId, teamId };
};

const reply = async (
  event: SlashCommandEvent,
  message: string,
): Promise<void> => {
  await event.channel.postEphemeral(event.user, message, {
    fallbackToDM: true,
  });
};

const scopeLabel = (scope: PookieConfigScope): string => {
  switch (scope.kind) {
    case "global":
      return "global";
    case "channel":
      return "channel";
    case "user":
      return "personal";
  }
};

const formatValue = (value: PookieConfig[PookieConfigKey]): string => {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
};

const parseBoolean = (input: string): boolean | undefined => {
  const normalized = input.toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) {
    return false;
  }
  return undefined;
};

type ValueCoercer = (
  raw: string,
) =>
  | { ok: true; value: PookieConfig[PookieConfigKey] }
  | { ok: false; error: string };

const VALUE_COERCERS: Record<PookieConfigKey, ValueCoercer> = {
  personality: (raw) => {
    if (PERSONALITY_OPTIONS.includes(raw as (typeof PERSONALITY_OPTIONS)[number]))
      return { ok: true, value: raw };
    return {
      ok: false,
      error: `invalid value "${raw}". allowed: cute | balanced | professional`,
    };
  },
  reasoningEffort: (raw) => {
    if (
      REASONING_EFFORT_OPTIONS.includes(
        raw as (typeof REASONING_EFFORT_OPTIONS)[number],
      )
    )
      return { ok: true, value: raw };
    return {
      ok: false,
      error: `invalid value "${raw}". allowed: minimal | medium | high`,
    };
  },
  reactionEmoji: (raw) => {
    const trimmed = raw.replace(/^:|:$/g, "");
    if (
      trimmed.length === 0 ||
      trimmed.length > 64 ||
      !/^[a-z0-9_+-]+$/.test(trimmed)
    ) {
      return {
        ok: false,
        error: `invalid emoji "${raw}". use a slack shortcode like sparkling_heart or :white_check_mark:`,
      };
    }
    return { ok: true, value: trimmed };
  },
  cards: (raw) => {
    const bool = parseBoolean(raw);
    if (bool === undefined) {
      return { ok: false, error: `invalid value "${raw}". use on or off` };
    }
    return { ok: true, value: bool };
  },
  tracesFooter: (raw) => {
    const bool = parseBoolean(raw);
    if (bool === undefined) {
      return { ok: false, error: `invalid value "${raw}". use on or off` };
    }
    return { ok: true, value: bool };
  },
};

const KEY_DESCRIPTIONS: Record<PookieConfigKey, string> = {
  personality: "cute | balanced | professional (tone of voice)",
  reactionEmoji: "slack emoji shortcode used on new threads (no colons)",
  cards: "on | off (block kit cards vs. prose-only)",
  tracesFooter: "on | off (posts the trace id/latency footer after replies)",
  reasoningEffort: "minimal | medium | high (model reasoning depth)",
};

const normalizeKey = (raw: string): PookieConfigKey | undefined => {
  const lower = raw.toLowerCase();
  const match = CONFIG_KEYS.find(
    (knownKey) => knownKey.toLowerCase() === lower,
  );
  return match;
};

const USAGE = `usage:
\`/pookie-config\` — show the effective config
\`/pookie-config set <key> <value>\` [--channel | --global]
\`/pookie-config unset <key>\` [--channel | --global]
\`/pookie-config reset\` [--channel | --global]

keys:
${CONFIG_KEYS.map((configKey) => `• \`${configKey}\` — ${KEY_DESCRIPTIONS[configKey]}`).join("\n")}

scopes (in precedence order): personal > channel > global > built-in default.`;

const formatLayer = (
  label: PookieConfigScopeKind,
  partial: PookieConfigPartial,
): string => {
  const entries = Object.entries(partial) as Array<
    [PookieConfigKey, PookieConfig[PookieConfigKey]]
  >;
  if (entries.length === 0) return `${label}: _(none)_`;
  const lines = entries.map(
    ([innerKey, innerValue]) =>
      `  • \`${innerKey}\` = \`${formatValue(innerValue)}\``,
  );
  return `${label}:\n${lines.join("\n")}`;
};

const formatEffective = (
  config: PookieConfig,
  sources: Record<PookieConfigKey, PookieConfigScopeKind | "default">,
): string => {
  const lines = CONFIG_KEYS.map((configKey) => {
    const value = formatValue(config[configKey]);
    return `  • \`${configKey}\` = \`${value}\` _(${sources[configKey]})_`;
  });
  return `effective config:\n${lines.join("\n")}`;
};

const handleShow = async (event: SlashCommandEvent): Promise<void> => {
  const { userId, channelId, teamId } = extractSlackEventContext(event.raw);
  const effectiveUserId = userId ?? event.user.userId;
  const [userLayer, channelLayer, globalLayer] = await Promise.all([
    appRuntime.runPromise(
      loadConfigForScope({ kind: "user", userId: effectiveUserId, teamId }),
    ),
    channelId
      ? appRuntime.runPromise(
          loadConfigForScope({ kind: "channel", channelId, teamId }),
        )
      : Promise.resolve<PookieConfigPartial>({}),
    appRuntime.runPromise(loadConfigForScope({ kind: "global", teamId })),
  ]);

  const resolved = mergeLayers({
    user: userLayer,
    channel: channelLayer,
    global: globalLayer,
  });

  const sections = [
    formatEffective(resolved.config, resolved.sources),
    "",
    "overrides by scope:",
    formatLayer("user", userLayer),
    formatLayer("channel", channelLayer),
    formatLayer("global", globalLayer),
    "",
    USAGE,
  ];

  await reply(event, sections.join("\n"));
};

const handleSet = async (
  event: SlashCommandEvent,
  args: ParsedArgs,
): Promise<void> => {
  const [rawKey, ...rawValueParts] = args.positional;
  const rawValue = rawValueParts.join(" ");

  if (!rawKey || !rawValue) {
    await reply(
      event,
      `usage: \`/pookie-config set <key> <value>\` [--channel | --global]\n\n${USAGE}`,
    );
    return;
  }

  const configKey = normalizeKey(rawKey);
  if (!configKey) {
    await reply(
      event,
      `unknown key "${rawKey}". valid keys: ${CONFIG_KEYS.join(", ")}`,
    );
    return;
  }

  const coerce = VALUE_COERCERS[configKey];
  const coerced = coerce(rawValue);
  if (!coerced.ok) {
    await reply(event, coerced.error);
    return;
  }

  const { channelId, teamId } = extractSlackEventContext(event.raw);

  if (args.isGlobal && !(await isSlackAdmin(event.user.userId, teamId))) {
    await reply(event, "only admins can change the global pookie config.");
    return;
  }

  const scope = resolveScope(
    teamId,
    event.user.userId,
    channelId,
    args.isChannel,
    args.isGlobal,
  );
  if ("error" in scope) {
    await reply(event, scope.error);
    return;
  }

  const existing = await appRuntime.runPromise(loadConfigForScope(scope));
  const next: PookieConfigPartial = { ...existing, [configKey]: coerced.value };
  await appRuntime.runPromise(saveConfigForScope(scope, next));

  await reply(
    event,
    `set \`${configKey}\` = \`${formatValue(coerced.value)}\` at ${scopeLabel(scope)} scope.`,
  );
};

const handleUnset = async (
  event: SlashCommandEvent,
  args: ParsedArgs,
): Promise<void> => {
  const [rawKey] = args.positional;
  if (!rawKey) {
    await reply(
      event,
      `usage: \`/pookie-config unset <key>\` [--channel | --global]`,
    );
    return;
  }

  const configKey = normalizeKey(rawKey);
  if (!configKey) {
    await reply(
      event,
      `unknown key "${rawKey}". valid keys: ${CONFIG_KEYS.join(", ")}`,
    );
    return;
  }

  const { channelId, teamId } = extractSlackEventContext(event.raw);

  if (args.isGlobal && !(await isSlackAdmin(event.user.userId, teamId))) {
    await reply(event, "only admins can change the global pookie config.");
    return;
  }
  const scope = resolveScope(
    teamId,
    event.user.userId,
    channelId,
    args.isChannel,
    args.isGlobal,
  );
  if ("error" in scope) {
    await reply(event, scope.error);
    return;
  }

  // Load all three layers up front so we can (a) check whether the target
  // layer actually has this override to remove, and (b) compute the real
  // post-unset effective value across the remaining layers. Reporting
  // POOKIE_CONFIG_DEFAULTS as the fallback is wrong when a lower-priority
  // layer has its own override for the same key.
  const [userLayer, channelLayer, globalLayer] = await Promise.all([
    appRuntime.runPromise(
      loadConfigForScope({ kind: "user", userId: event.user.userId, teamId }),
    ),
    channelId
      ? appRuntime.runPromise(
          loadConfigForScope({ kind: "channel", channelId, teamId }),
        )
      : Promise.resolve<PookieConfigPartial>({}),
    appRuntime.runPromise(loadConfigForScope({ kind: "global", teamId })),
  ]);

  const targetLayer =
    scope.kind === "user"
      ? userLayer
      : scope.kind === "channel"
        ? channelLayer
        : globalLayer;

  if (!(configKey in targetLayer)) {
    await reply(
      event,
      `no override for \`${configKey}\` at ${scopeLabel(scope)} scope.`,
    );
    return;
  }

  const nextTargetLayer: PookieConfigPartial = { ...targetLayer };
  delete nextTargetLayer[configKey];
  await appRuntime.runPromise(saveConfigForScope(scope, nextTargetLayer));

  const resolvedAfterUnset = mergeLayers({
    user: scope.kind === "user" ? nextTargetLayer : userLayer,
    channel: scope.kind === "channel" ? nextTargetLayer : channelLayer,
    global: scope.kind === "global" ? nextTargetLayer : globalLayer,
  });
  const effectiveValue = resolvedAfterUnset.config[configKey];
  const effectiveSource = resolvedAfterUnset.sources[configKey];

  await reply(
    event,
    `unset \`${configKey}\` at ${scopeLabel(scope)} scope. effective now: \`${formatValue(effectiveValue)}\` _(from ${effectiveSource})_.`,
  );
};

const handleReset = async (
  event: SlashCommandEvent,
  args: ParsedArgs,
): Promise<void> => {
  const { channelId, teamId } = extractSlackEventContext(event.raw);

  if (args.isGlobal && !(await isSlackAdmin(event.user.userId, teamId))) {
    await reply(event, "only admins can reset the global pookie config.");
    return;
  }
  const scope = resolveScope(
    teamId,
    event.user.userId,
    channelId,
    args.isChannel,
    args.isGlobal,
  );
  if ("error" in scope) {
    await reply(event, scope.error);
    return;
  }

  const didClear = await appRuntime.runPromise(clearConfigForScope(scope));
  if (didClear) {
    await reply(event, `reset ${scopeLabel(scope)} pookie config.`);
  } else {
    await reply(event, `no ${scopeLabel(scope)} overrides to reset.`);
  }
};

export const handlePookieConfigCommand = async (
  event: SlashCommandEvent,
): Promise<void> => {
  const args = parseSubcommandArgs(event.text);

  switch (args.subcommand) {
    case "":
    case "show":
    case "list":
    case "get":
      return handleShow(event);
    case "set":
      return handleSet(event, args);
    case "unset":
    case "clear":
      return handleUnset(event, args);
    case "reset":
      return handleReset(event, args);
    default:
      await reply(
        event,
        `unknown subcommand "${args.subcommand}".\n\n${USAGE}`,
      );
  }
};
