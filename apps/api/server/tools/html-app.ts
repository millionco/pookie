import { z } from "zod";

import { defineTool } from "../agent/define-tool";
import { toolErr, toolResult } from "../agent/tool-result";
import { buildHtmlAppUrl } from "../html-apps/build-url";
import { signHtmlAppToken } from "../html-apps/sign-token";
import { createHtmlApp } from "../html-apps/store";
import { HTML_APP_TOKEN_TTL_S, MAX_HTML_BYTES } from "./constants";

import type { StateAdapter } from "chat";

interface CreateHtmlAppToolDeps {
  state: StateAdapter;
  teamId: string;
  userId?: string;
  channelId?: string;
  threadTs?: string;
}

const HTML_DOC_PREFIX_PATTERN = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

const createHtmlAppInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short human-readable name for the app (shown to the user, used as the page title).",
    ),
  description: z
    .string()
    .min(1)
    .max(280)
    .describe(
      "One-sentence summary of what the app does. Surfaced in the Slack card subtitle.",
    ),
  html: z
    .string()
    .min(1)
    .describe(
      "A complete, self-contained HTML document starting with <!doctype html> or <html>. " +
        "Inline all CSS and JS (or load from common CDNs like cdn.tailwindcss.com / cdn.jsdelivr.net). " +
        "The document renders inside a sandboxed iframe with no access to the parent page, cookies, or storage. " +
        "Forms, popups, and top-level navigation are blocked — wire interactions with JS event handlers instead.",
    ),
});

const createHtmlAppResultSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
});

export const createHtmlAppTool = ({
  state,
  teamId,
  userId,
  channelId,
  threadTs,
}: CreateHtmlAppToolDeps) =>
  defineTool({
    description:
      "Create a small interactive HTML app and return a URL the user can open. " +
      "Use when the answer is better as an interactive UI than as text — calculators, " +
      "configurators, mini dashboards, charts the user can play with, embedded viewers (PDF/3D), " +
      "form-style picks, or any 'let me poke at this' tool. " +
      "Pass a complete self-contained HTML document. The app renders inside a sandboxed iframe " +
      "and cannot call back into Pookie or Slack — design it as an island that takes inputs and " +
      "shows outputs locally. After calling this, surface the result by emitting one card whose " +
      '`footerAction` is { label: "Open app ↗", url } using the returned url. Do not paste raw HTML in chat.',
    inputSchema: createHtmlAppInputSchema,
    resultSchema: createHtmlAppResultSchema,
    errorFallback: "failed to create html app",
    execute: async ({ title, description, html }) => {
      const byteLength = Buffer.byteLength(html, "utf8");
      if (byteLength > MAX_HTML_BYTES) {
        return toolErr(
          "validation",
          `html exceeds ${MAX_HTML_BYTES} bytes (got ${byteLength}). trim inline assets or load them from a CDN.`,
        );
      }

      if (!HTML_DOC_PREFIX_PATTERN.test(html)) {
        return toolErr(
          "validation",
          "html must be a complete document starting with <!doctype html> or <html>.",
        );
      }

      const secret = process.env.SLACK_ENCRYPTION_KEY;
      if (!secret) {
        return toolErr(
          "unknown",
          "SLACK_ENCRYPTION_KEY is not configured; cannot mint an html app token.",
        );
      }

      const { id } = await createHtmlApp(state, teamId, {
        title,
        description,
        html,
        ...(userId ? { createdBy: userId } : {}),
        ...(channelId ? { channelId } : {}),
        ...(threadTs ? { threadTs } : {}),
      });

      const expiresAt = new Date(Date.now() + HTML_APP_TOKEN_TTL_S * 1000);
      const token = signHtmlAppToken({ teamId, id, expiresAt, secret });

      return toolResult({
        id,
        url: buildHtmlAppUrl(token),
        title,
      });
    },
    toModelOutput: (output) => {
      if (output.type === "error") return output.error.message;
      const { url, title } = output.result;
      return `created html app "${title}" at ${url}. surface it via a card footerAction labeled "Open app ↗" pointing at this url.`;
    },
  });
