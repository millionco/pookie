import { Schema } from "effect"

export const PersonalityOptionSchema = Schema.Literals(["cute", "balanced", "professional"])
export type PersonalityOption = typeof PersonalityOptionSchema.Type

export const ReasoningEffortOptionSchema = Schema.Literals(["minimal", "medium", "high"])
export type ReasoningEffortOption = typeof ReasoningEffortOptionSchema.Type

const EMOJI_SHORTCODE_PATTERN = /^[a-z0-9_+-]+$/

const ReactionEmojiSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(EMOJI_SHORTCODE_PATTERN),
)

export const PookieConfigSchema = Schema.Struct({
  personality: PersonalityOptionSchema,
  reactionEmoji: ReactionEmojiSchema,
  cards: Schema.Boolean,
  tracesFooter: Schema.Boolean,
  reasoningEffort: ReasoningEffortOptionSchema,
})

export type PookieConfig = typeof PookieConfigSchema.Type

export const PookieConfigPartialSchema = Schema.Struct({
  personality: Schema.optional(PersonalityOptionSchema),
  reactionEmoji: Schema.optional(ReactionEmojiSchema),
  cards: Schema.optional(Schema.Boolean),
  tracesFooter: Schema.optional(Schema.Boolean),
  reasoningEffort: Schema.optional(ReasoningEffortOptionSchema),
})

export type PookieConfigPartial = typeof PookieConfigPartialSchema.Type

export type PookieConfigKey = keyof PookieConfig

export interface PookieConfigScopeGlobal {
  kind: "global"
  teamId: string
}

export interface PookieConfigScopeChannel {
  kind: "channel"
  channelId: string
  teamId: string
}

export interface PookieConfigScopeUser {
  kind: "user"
  userId: string
  teamId: string
}

export type PookieConfigScope =
  | PookieConfigScopeGlobal
  | PookieConfigScopeChannel
  | PookieConfigScopeUser

export type PookieConfigScopeKind = PookieConfigScope["kind"]
