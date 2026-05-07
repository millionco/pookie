import { Effect, Layer, ServiceMap } from "effect"
import IORedis from "ioredis"

import { env } from "@/env"

import { RedisError } from "../errors"

const wrap = <T>(method: string, fn: () => Promise<T>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new RedisError({ method, cause }),
  })

export class Redis extends ServiceMap.Service<Redis>()("@pookie/Redis", {
  make: Effect.sync(() => {
    const client = new IORedis(env.REDIS_URL, {
      ...(env.REDIS_URL.startsWith("rediss://") ? { tls: {} } : {}),
      // Don't open the TCP connection until the first command — the module is
      // imported during `next build` and from tests that mock redis, neither of
      // which want a real connection attempt at import time.
      lazyConnect: true,
    })

    return {
      get: (key: string) => wrap("get", () => client.get(key)),
      set: (key: string, value: string, ...args: Array<string | number>) =>
        wrap("set", () => client.set(key, value, ...(args as [any]))),
      setNx: (key: string, value: string, ttlSeconds: number) =>
        wrap("setNx", () => client.set(key, value, "EX", ttlSeconds, "NX").then((result) => result === "OK")),
      del: (...keys: Array<string>) => wrap("del", () => client.del(...keys)),
      getdel: (key: string) => wrap("getdel", () => client.getdel(key)),
      rpush: (key: string, ...values: Array<string>) => wrap("rpush", () => client.rpush(key, ...values)),
      expire: (key: string, seconds: number) => wrap("expire", () => client.expire(key, seconds)),
      lrange: (key: string, start: number, stop: number) => wrap("lrange", () => client.lrange(key, start, stop)),
      lrem: (key: string, count: number, value: string) => wrap("lrem", () => client.lrem(key, count, value)),
      ltrim: (key: string, start: number, stop: number) => wrap("ltrim", () => client.ltrim(key, start, stop)),
      scan: (cursor: string | number, ...args: Array<string | number>) =>
        wrap("scan", () => client.scan(cursor as number, ...(args as [any]))),
      pipeline: () => client.pipeline(),
      raw: client,
    }
  }),
}) {
  static layer = Layer.effect(this)(this.make)
}
