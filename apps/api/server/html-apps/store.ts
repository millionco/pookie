import { randomUUID } from "node:crypto";

import { HTML_APP_TTL_S } from "../tools/constants";
import { decryptJson, encryptJson } from "../utils/secure-store";

import type { StateAdapter } from "chat";

export interface HtmlAppRow {
  id: string;
  teamId: string;
  title: string;
  description: string;
  html: string;
  createdBy?: string;
  channelId?: string;
  threadTs?: string;
  createdAt: string;
}

export interface CreateHtmlAppInput {
  title: string;
  description: string;
  html: string;
  createdBy?: string;
  channelId?: string;
  threadTs?: string;
}

const HTML_APP_KEY_PREFIX = "pookie:htmlApp";

const htmlAppKey = (teamId: string, id: string): string =>
  `${HTML_APP_KEY_PREFIX}:${teamId}:${id}`;

export const createHtmlApp = async (
  state: StateAdapter,
  teamId: string,
  input: CreateHtmlAppInput,
): Promise<{ id: string; row: HtmlAppRow }> => {
  const id = randomUUID();
  const row: HtmlAppRow = {
    id,
    teamId,
    title: input.title,
    description: input.description,
    html: input.html,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    createdAt: new Date().toISOString(),
  };

  await state.set(
    htmlAppKey(teamId, id),
    encryptJson(row),
    HTML_APP_TTL_S * 1000,
  );

  return { id, row };
};

export const getHtmlApp = async (
  state: StateAdapter,
  teamId: string,
  id: string,
): Promise<HtmlAppRow | null> => {
  const stored = await state.get<unknown>(htmlAppKey(teamId, id));
  if (stored === null || stored === undefined) return null;
  try {
    return decryptJson<HtmlAppRow>(stored);
  } catch {
    return null;
  }
};
