import { createRedisState } from "@chat-adapter/state-redis";

import type { StateAdapter } from "chat";

// createRedisState reads process.env.REDIS_URL at call time. During Next.js
// build, modules are evaluated for static analysis before runtime env vars
// exist. Wrapping in a Proxy defers construction to the first method call so
// importing this module is always safe — including from server components
// rendered at build time.
const buildLazyRedisState = (): StateAdapter => {
  let instance: StateAdapter | undefined;
  return new Proxy({} as StateAdapter, {
    get(_target, prop, receiver) {
      instance ??= createRedisState({
        url: process.env.REDIS_URL || process.env.KV_URL,
      });
      const value = Reflect.get(instance, prop, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
};

export const sharedRedisState: StateAdapter = buildLazyRedisState();
