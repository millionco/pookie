import { buildRipplingTools, validateRipplingShim } from "./rippling";

import type * as AI from "ai";

export interface McpShimValidation {
  ok: boolean;
  toolCount: number;
  message?: string;
}

export interface McpShim {
  buildTools: (token: string) => Record<string, AI.Tool>;
  validate: (token: string) => Promise<McpShimValidation>;
}

const SHIMS: Record<string, McpShim> = {
  rippling: {
    buildTools: buildRipplingTools,
    validate: validateRipplingShim,
  },
};

export const resolveShim = (shimName: string): McpShim | undefined =>
  SHIMS[shimName];
