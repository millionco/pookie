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
