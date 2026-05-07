import { Schema } from "effect"

export class RedisError extends Schema.ErrorClass<RedisError>("RedisError")({
  _tag: Schema.tag("RedisError"),
  method: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SlackApiError extends Schema.ErrorClass<SlackApiError>("SlackApiError")({
  _tag: Schema.tag("SlackApiError"),
  method: Schema.String,
  code: Schema.optional(Schema.String),
}) {
  get message() {
    return `Slack API error: ${this.method}${this.code ? ` (${this.code})` : ""}`
  }
}

export class SlackAccessError extends Schema.ErrorClass<SlackAccessError>("SlackAccessError")({
  _tag: Schema.tag("SlackAccessError"),
  reason: Schema.String,
}) {}

export class McpConnectionError extends Schema.ErrorClass<McpConnectionError>("McpConnectionError")({
  _tag: Schema.tag("McpConnectionError"),
  server: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class McpAuthError extends Schema.ErrorClass<McpAuthError>("McpAuthError")({
  _tag: Schema.tag("McpAuthError"),
  server: Schema.String,
  reason: Schema.String,
}) {}

export class ConfigError extends Schema.ErrorClass<ConfigError>("ConfigError")({
  _tag: Schema.tag("ConfigError"),
  key: Schema.String,
}) {}

export class ThreadBusyError extends Schema.ErrorClass<ThreadBusyError>("ThreadBusyError")({
  _tag: Schema.tag("ThreadBusyError"),
  threadId: Schema.String,
}) {}

export class AgentStreamError extends Schema.ErrorClass<AgentStreamError>("AgentStreamError")({
  _tag: Schema.tag("AgentStreamError"),
  cause: Schema.optional(Schema.Defect),
}) {}

export class EncryptionError extends Schema.ErrorClass<EncryptionError>("EncryptionError")({
  _tag: Schema.tag("EncryptionError"),
  operation: Schema.Literals(["encrypt", "decrypt"]),
  cause: Schema.optional(Schema.Defect),
}) {}

export class ToolExecutionError extends Schema.ErrorClass<ToolExecutionError>("ToolExecutionError")({
  _tag: Schema.tag("ToolExecutionError"),
  tool: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class ValidationError extends Schema.ErrorClass<ValidationError>("ValidationError")({
  _tag: Schema.tag("ValidationError"),
  field: Schema.String,
  reason: Schema.String,
}) {}
