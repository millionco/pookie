import Cryptr from "cryptr"
import { Effect, Layer, ServiceMap } from "effect"

import { env } from "@/env"

import { EncryptionError } from "../errors"

export class SecureStore extends ServiceMap.Service<SecureStore>()("@pookie/SecureStore", {
  make: Effect.sync(() => {
    const getCryptr = (): Cryptr | null => {
      const key = env.SLACK_ENCRYPTION_KEY
      if (!key) return null
      return new Cryptr(key)
    }

    return {
      encrypt: (plaintext: string) =>
        Effect.try({
          try: () => {
            const cryptr = getCryptr()
            if (!cryptr) throw new Error("SLACK_ENCRYPTION_KEY is not set")
            return cryptr.encrypt(plaintext)
          },
          catch: (cause) => new EncryptionError({ operation: "encrypt", cause }),
        }),

      decrypt: (storedValue: unknown) =>
        Effect.try({
          try: () => {
            const cryptr = getCryptr()
            if (!cryptr) throw new Error("SLACK_ENCRYPTION_KEY is not set")
            if (storedValue === null) return null
            const stringValue = typeof storedValue === "string" ? storedValue : JSON.stringify(storedValue)
            try {
              return cryptr.decrypt(stringValue)
            } catch {
              return null
            }
          },
          catch: (cause) => new EncryptionError({ operation: "decrypt", cause }),
        }),

      encryptJson: (value: unknown) =>
        Effect.try({
          try: () => {
            const cryptr = getCryptr()
            if (!cryptr) throw new Error("SLACK_ENCRYPTION_KEY is not set")
            return cryptr.encrypt(JSON.stringify(value))
          },
          catch: (cause) => new EncryptionError({ operation: "encrypt", cause }),
        }),

      // Gracefully handles both encrypted (string) and legacy unencrypted values
      // so existing plaintext state in Redis keeps working after deployment.
      decryptJson: <T>(stored: unknown): Effect.Effect<T, EncryptionError> =>
        Effect.try({
          try: () => {
            if (typeof stored !== "string") return stored as T
            const cryptr = getCryptr()
            if (!cryptr) throw new Error("SLACK_ENCRYPTION_KEY is not set")
            try {
              return JSON.parse(cryptr.decrypt(stored)) as T
            } catch {
              return stored as unknown as T
            }
          },
          catch: (cause) => new EncryptionError({ operation: "decrypt", cause }),
        }),
    }
  }),
}) {
  static layer = Layer.effect(this)(this.make)
}
