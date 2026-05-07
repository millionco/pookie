import { buildRipplingTools, validateRipplingShim } from "./rippling";

import type { McpShim } from "./types";

export type { McpShim, McpShimValidation } from "./types";

const SHIMS: Record<string, McpShim> = {
  rippling: {
    buildTools: buildRipplingTools,
    validate: validateRipplingShim,
  },
};

export const resolveShim = (shimName: string): McpShim | undefined =>
  SHIMS[shimName];
