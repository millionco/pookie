import { Cause, Effect } from "effect";
import * as AI from "ai";
import * as ChatSDK from "chat";
import { z } from "zod";

import { openMcpToolsAsync } from "../mcp/client";
import { buildReauthCard, createAuthorizationStartUrl } from "../mcp/handlers";
import { OpenAIProvider } from "../infra/openai-provider";
import { SecureStore } from "../infra/secure-store";
import { slackBot } from "../slack-bot";
import { extractSlackEventContext } from "../slack/schemas";
import { buildToolset, cacheSlackSearchContext } from "../tools";
import { ensureAttachmentText } from "../utils/ensure-attachment-text";
import {
  sanitizeAssistantTextInMessages,
  sanitizeForMarkdown,
} from "../utils/sanitize-slack-mrkdwn";
import { sanitizeStoredMessages } from "../utils/sanitize-stored-messages";
import { ActiveRuns } from "./active-runs";
import {
  MAX_BUILTIN_TOOL_CALLS_PER_RESPONSE,
  MAX_FOLLOW_UP_ROUNDS,
  TRACE_FOOTER_CHANNEL_NAME,
  TRACING_ALLOWED_WORKSPACE_IDS,
} from "./constants";
import { createCardStreamParser } from "./parse-card-stream";
import { postCardAsBlocks } from "./post-card-as-blocks";
import { renderCardAsBlocks } from "./render-card-blocks";
import { buildSystemMessages } from "./system-prompt";
import {
  buildSystemReminder,
  injectSystemReminderIntoLastUserMessage,
} from "./system-reminder";
import { ThreadLock } from "./thread-lock";
import { AgentStreamError } from "../errors";
import { postTraceFooter } from "../utils/post-trace-footer";
import { getCurrentTraceId, printTraceInfo } from "../utils/get-current-trace-id";

import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { ModelMessage } from "ai";

import type { McpToolsResult } from "../mcp/client";
import type { CardStreamSegment } from "./parse-card-stream";
import type { AgentCard } from "./response-schema";
import type { McpServerSummary } from "./system-reminder";

const GENERIC_ERROR_MARKDOWN =
  "sorry, something broke on my end before i could finish replying. give it another try in a minute — if it keeps happening, email founders@million.dev with the channel name and roughly when this happened.";

const deriveCardFallback = (card: AgentCard): string => {
  if (card.title) return card.title;
  if (card.subtitle) return card.subtitle;
  for (const child of card.children) {
    if (child.type === "header") return child.text;
  }
  const itemCount = card.children.length;
  return `card with ${itemCount} item${itemCount === 1 ? "" : "s"}`;
};

const flushTextBuffer = async (
  textBuffer: { value: string },
  thread: ChatSDK.Thread,
): Promise<boolean> => {
  const trimmed = textBuffer.value.trim();
  textBuffer.value = "";
  if (!trimmed) return false;
  await thread.post({ markdown: sanitizeForMarkdown(trimmed) });
  return true;
};

const handleSegment = async (
  segment: CardStreamSegment,
  textBuffer: { value: string },
  context: {
    thread: ChatSDK.Thread;
    slack: SlackAdapter;
    currentMessage?: ChatSDK.Message;
  },
): Promise<boolean> => {
  if (segment.kind === "text") {
    textBuffer.value += segment.text;
    return false;
  }
  if (segment.kind === "flush") {
    // Explicit prose break: model used <br /> to ask for a new Slack message.
    // Posts the buffered text on its own so each unfurling URL gets its own
    // message (Slack stacks unfurls under the message that contains them).
    return flushTextBuffer(textBuffer, context.thread);
  }
  // Card or malformed card — flush any pending text first so ordering is
  // preserved (text-before-card stays text-before-card).
  const didFlush = await flushTextBuffer(textBuffer, context.thread);
  if (segment.kind === "card") {
    const rendered = renderCardAsBlocks(segment.card);
    await postCardAsBlocks({
      thread: context.thread,
      slack: context.slack,
      fallbackText: deriveCardFallback(segment.card),
      card: rendered,
      currentMessage: context.currentMessage,
    });
    return true;
  }
  // malformedCard. Log goes to Vercel; we also stamp the active span so the
  // drop is visible in Axiom traces — the only reliable way to investigate
  // these from outside the deployment. Without span attributes the parent
  // streamText span looks healthy and the drop is invisible to APL queries.
  console.warn(
    "[agent] dropping malformed <card> block:",
    segment.error,
    segment.raw.slice(0, 200),
  );
  return didFlush;
};

const threadStateSchema = z.object({
  messages: z.array(AI.modelMessageSchema).optional(),
});

const imageGenerationOutputSchema = z.object({
  result: z.string().min(1),
});

const postImageGenerationOutput = async (
  thread: ChatSDK.Thread,
  toolCallId: string,
  output: unknown,
): Promise<boolean> => {
  const parsedOutput = imageGenerationOutputSchema.safeParse(output);
  if (!parsedOutput.success) return false;

  return thread
    .post({
      markdown: "",
      files: [
        {
          data: Buffer.from(parsedOutput.data.result, "base64"),
          filename: `image-${toolCallId}.png`,
          mimeType: "image/png",
        },
      ],
    })
    .then(() => true)
    .catch((postError: unknown) => {
      console.warn("[agent] image upload failed:", postError);
      return false;
    });
};

const runAgentRound = Effect.fn("Agent.runAgentRound")(
  (options: {
    thread: ChatSDK.Thread;
    slack: SlackAdapter;
    state: ChatSDK.StateAdapter;
    currentMessage: ChatSDK.Message | undefined;
    conversationMessages: Array<ModelMessage>;
    systemMessages: Array<ModelMessage>;
    resolvedConfig: {
      config: { reasoningEffort: string; tracesFooter: boolean };
    };
    tools: Record<string, AI.Tool>;
    abortController: AbortController | undefined;
    followUpMessages: string[] | undefined;
    mcpServers: McpServerSummary[] | undefined;
    isTracingEnabled: boolean;
  }) =>
    Effect.gen(function* () {
      const openaiProvider = yield* OpenAIProvider;
      const secureStore = yield* SecureStore;

      const {
        thread,
        slack,
        currentMessage,
        resolvedConfig,
        tools,
        abortController,
        followUpMessages,
        mcpServers,
        isTracingEnabled,
        conversationMessages,
        systemMessages,
      } = options;

      // The reminder is injected into the LAST user message AND persisted in
      // that injected form. This is intentional for prompt-cache stability:
      // the reminder content frozen at the message's creation turn stays put
      // forever after, so subsequent turns load the exact same bytes the
      // model saw in earlier turns and the cache prefix matches everything
      // before the new last-user-message.
      //
      // What this does NOT cause is stacking: injectSystemReminderIntoLastUserMessage
      // is idempotent — it strips any leading <system-reminder> blocks from
      // the last user message before prepending the current one. So across
      // follow-up rounds within a turn, the last user message always carries
      // exactly one (the current round's) reminder. Older user messages keep
      // whichever reminder they were assigned in their original turn; that's
      // stale but stable, which is what cache wants.
      const provider = yield* openaiProvider.create();

      const reminderBody = buildSystemReminder({
        followUpMessages,
        mcpServers,
      });
      const messagesForModel = reminderBody
        ? injectSystemReminderIntoLastUserMessage(
            conversationMessages,
            reminderBody,
          )
        : conversationMessages;

      // Some provider failure modes fire onError mid-stream but let the
      // stream end cleanly, so the for-await loop completes "successfully"
      // and the user gets silence. Capture the error here and re-throw after
      // the loop so the catch posts GENERIC_ERROR_MARKDOWN instead.
      let capturedStreamError: unknown = null;

      // streamText is synchronous — returns a handle whose .fullStream is
      // an AsyncIterable consumed in the tryPromise below.
      const result = AI.streamText({
        model: provider("gpt-5.5"),
        messages: [...systemMessages, ...messagesForModel],
        allowSystemInMessages: true,
        tools,
        abortSignal: abortController?.signal,
        experimental_telemetry: { isEnabled: isTracingEnabled },
        stopWhen: AI.stepCountIs(100),
        onStepFinish: async ({ toolResults }) => {
          console.log(
            "step finish",
            toolResults
              .map((stepResult) => stepResult.toolName)
              .join(", "),
          );
        },
        onError: async (streamError) => {
          console.error("[agent] streamText error:", streamError);
          capturedStreamError = streamError;
        },
        providerOptions: {
          openai: {
            parallelToolCalls: true,
            reasoningEffort: resolvedConfig.config.reasoningEffort,
            serviceTier: "priority",
            truncation: "auto",
            maxToolCalls: MAX_BUILTIN_TOOL_CALLS_PER_RESPONSE,
            // // Required, NOT a privacy setting — do not flip to false. The toolset
            // // marks MCP tools `deferLoading: true` whenever ≥8 are wired up
            // // (see buildToolset), so they aren't shipped in every request and
            // // the model loads what it needs via tool_search. With store: true
            // // OpenAI persists each response's tool namespace; the next request
            // // resolves the prior round's function_calls against it. With
            // // store: false that namespace is dropped between requests and the
            // // very next turn after any MCP tool call fails server-side with
            // // "Missing namespace for function_call '<tool>'". The agent surfaces
            // // that as GENERIC_ERROR_MARKDOWN and the user sees "sorry, something
            // // broke". If you need OpenAI-side data retention guarantees, set
            // // them at the org level (Zero Data Retention agreement), not here.
            // store: true,
          } satisfies OpenAILanguageModelResponsesOptions,
        },
      });

      const streamOutcome = yield* Effect.tryPromise({
        try: async () => {
          const parser = createCardStreamParser();
          const textBuffer = { value: "" };
          let postFailed = false;
          let didPostMessage = false;

          try {
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                const segments = parser.ingest(part.text);
                for (const segment of segments) {
                  if (
                    await handleSegment(segment, textBuffer, {
                      thread,
                      slack,
                      currentMessage,
                    })
                  )
                    didPostMessage = true;
                }
                continue;
              }

              if (
                part.type === "tool-result" &&
                part.toolName === "image_generation" &&
                !part.preliminary
              ) {
                if (
                  await postImageGenerationOutput(
                    thread,
                    part.toolCallId,
                    part.output,
                  )
                ) {
                  didPostMessage = true;
                }
              }
            }
            const tail = parser.flushTail();
            for (const segment of tail) {
              if (
                await handleSegment(segment, textBuffer, {
                  thread,
                  slack,
                  currentMessage,
                })
              )
                didPostMessage = true;
            }
            if (await flushTextBuffer(textBuffer, thread))
              didPostMessage = true;
            // Stream ended without throwing, but onError may have fired earlier
            // (e.g., provider error mid-response). Promote it so the catch below
            // posts the error message rather than leaving the user in silence.
            if (capturedStreamError) throw capturedStreamError;
          } catch (streamConsumeError) {
            if (abortController?.signal.aborted) {
              console.log("[agent] run cancelled (message deleted)");
              return { aborted: true, didPostMessage, postFailed: false };
            }
            console.error(
              "[agent] failed while streaming response:",
              streamConsumeError,
            );
            postFailed = true;
            // Best-effort flush of whatever text we already had buffered before
            // the error. Without this, when the stream errors mid-text-segment
            // the user sees nothing — neither the partial answer nor an error.
            await flushTextBuffer(textBuffer, thread).catch(
              (flushError: unknown) =>
                console.warn(
                  "[agent] failed to flush buffered text after stream error:",
                  flushError,
                ),
            );
          }

          return { aborted: false, didPostMessage, postFailed };
        },
        catch: (cause) => new AgentStreamError({ cause }),
      });

      if (streamOutcome.aborted) {
        return {
          conversationMessages,
          didPostMessage: streamOutcome.didPostMessage,
        };
      }

      let { didPostMessage } = streamOutcome;

      if (streamOutcome.postFailed) {
        didPostMessage = true;
        yield* Effect.tryPromise({
          try: () => thread.post({ markdown: GENERIC_ERROR_MARKDOWN }),
          catch: (cause) => new AgentStreamError({ cause }),
        }).pipe(
          Effect.catchCause((postCause) =>
            Effect.logWarning("[agent] failed to post error message").pipe(
              Effect.annotateLogs({ error: Cause.pretty(postCause) }),
            ),
          ),
        );
      }

      const responseMessages = yield* Effect.tryPromise({
        try: async () => {
          const { messages: responseMessages } = await result.response;
          return responseMessages;
        },
        catch: (cause) => new AgentStreamError({ cause }),
      }).pipe(
        Effect.catchCause((responseCause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "[agent] failed to get response messages",
            ).pipe(Effect.annotateLogs({ error: Cause.pretty(responseCause) }));
            return null;
          }),
        ),
      );

      if (!responseMessages) {
        return { conversationMessages: messagesForModel, didPostMessage };
      }

      // Strip 3-pipe malformed slack mrkdwn links from assistant text BEFORE
      // persisting. Otherwise the model's own past bad output sits in
      // conversation history and primes it to keep producing the same shape.
      const cleanedResponseMessages =
        sanitizeAssistantTextInMessages(responseMessages);
      // Persist messagesForModel (the reminder-injected view) — see the long
      // comment above where messagesForModel is built. The injected version
      // is what the model just saw in this round, and freezing it into
      // history keeps the prompt-cache prefix stable for later turns.
      const updatedMessages = [
        ...messagesForModel,
        ...cleanedResponseMessages,
      ];

      const encryptedState = yield* secureStore
        .encryptJson(updatedMessages)
        .pipe(
          Effect.catchCause((encryptCause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                "[agent] failed to encrypt thread state",
              ).pipe(Effect.annotateLogs({ error: Cause.pretty(encryptCause) }));
              return null;
            }),
          ),
        );

      if (encryptedState !== null) {
        yield* Effect.tryPromise({
          try: () => thread.setState({ messages: encryptedState }),
          catch: (cause) => new AgentStreamError({ cause }),
        }).pipe(
          Effect.catchCause((stateCause) =>
            Effect.logWarning("[agent] failed to persist thread state").pipe(
              Effect.annotateLogs({ error: Cause.pretty(stateCause) }),
            ),
          ),
        );
      }

      return { conversationMessages: updatedMessages, didPostMessage };
    }),
);

export const handleSlackMessage = (
  thread: ChatSDK.Thread,
  currentMessage?: ChatSDK.Message,
  skippedMessages?: ChatSDK.Message[],
) =>
  Effect.gen(function* () {
    const threadLock = yield* ThreadLock;
    const activeRuns = yield* ActiveRuns;
    const secureStore = yield* SecureStore;

    const { userId, channelId, teamId } = extractSlackEventContext(
      currentMessage?.raw,
    );
    const isTracingEnabled = TRACING_ALLOWED_WORKSPACE_IDS.includes(teamId);

    yield* Effect.logInfo("handleSlackMessage").pipe(
      Effect.annotateLogs({
        messageText: currentMessage?.text ?? "(none)",
      }),
    );

    const slack: SlackAdapter = slackBot.getAdapter("slack");

    const lockAcquired = yield* threadLock.acquire(thread.id);
    if (!lockAcquired) {
      const trimmedText = currentMessage?.text?.trim();
      const hasAttachments = Boolean(currentMessage?.attachments?.length);
      const followUpText =
        trimmedText && trimmedText.length > 0
          ? trimmedText
          : hasAttachments
            ? "(user sent an attachment with no text)"
            : null;
      if (followUpText && currentMessage?.id && channelId) {
        yield* threadLock.enqueueFollowUp(thread.id, channelId, {
          messageId: currentMessage.id,
          text: followUpText,
        });
      }
      yield* Effect.logInfo("[agent] lock busy, enqueued follow-up").pipe(
        Effect.annotateLogs({
          followUpPreview: followUpText?.slice(0, 80) ?? "(none)",
        }),
      );
      return;
    }

    yield* Effect.tryPromise({
      try: () => thread.startTyping(),
      catch: (cause) => new AgentStreamError({ cause }),
    });

    const traceId = isTracingEnabled ? getCurrentTraceId() : undefined;
    if (isTracingEnabled) {
      printTraceInfo();
    }
    const startedAt = Date.now();
    const state = slackBot.getState();

    const messageTs = currentMessage?.id;
    const abortController =
      channelId && messageTs
        ? yield* activeRuns.register(channelId, messageTs)
        : undefined;

    // Run independent async work in parallel: search context caching, MCP tool
    // loading, and thread state retrieval don't depend on each other.
    const [, mcpSettled, stateSettled] = yield* Effect.tryPromise({
      try: () =>
        Promise.allSettled([
          cacheSlackSearchContext(thread, currentMessage),
          userId
            ? openMcpToolsAsync(userId, channelId, teamId)
            : Promise.resolve(undefined as McpToolsResult | undefined),
          thread.state as Promise<unknown>,
        ]),
      catch: (cause) => new AgentStreamError({ cause }),
    });

    let mcpHandle: McpToolsResult | undefined;
    if (mcpSettled.status === "fulfilled" && mcpSettled.value) {
      mcpHandle = mcpSettled.value;
    } else if (mcpSettled.status === "rejected") {
      yield* Effect.logWarning("[mcp] failed to load MCP tools").pipe(
        Effect.annotateLogs({ reason: String(mcpSettled.reason) }),
      );
    }

    if (mcpHandle && mcpHandle.authNeeded.length > 0 && userId) {
      const isFirstNotice = yield* threadLock.tryMarkReauthNoticeSent(
        thread.id,
        userId,
      );
      if (isFirstNotice) {
        const pendingAuthStartUrls = yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              mcpHandle!.authNeeded.map(async (server) => ({
                name: server.name,
                authorizationUrl: await createAuthorizationStartUrl(
                  server.name,
                  server.authorizationUrl,
                ),
              })),
            ),
          catch: (cause) => new AgentStreamError({ cause }),
        });
        slack
          .postEphemeral(thread.id, userId, {
            card: buildReauthCard(pendingAuthStartUrls),
          })
          .catch((ephemeralError: unknown) =>
            console.warn("[mcp] ephemeral auth notice failed:", ephemeralError),
          );
      }
    }

    yield* Effect.gen(function* () {
      const rawThreadState =
        stateSettled.status === "fulfilled" ? stateSettled.value : undefined;
      const rawState = (rawThreadState ?? {}) as Record<string, unknown>;
      if (typeof rawState.messages === "string") {
        rawState.messages = yield* secureStore.decryptJson<Array<ModelMessage>>(
          rawState.messages,
        );
      }
      const parsedState = threadStateSchema.safeParse(rawState);
      const storedMessages: Array<ModelMessage> = parsedState.success
        ? (parsedState.data.messages ?? [])
        : [];

      ensureAttachmentText(thread.recentMessages);

      const tools = buildToolset(
        { thread, slack, state, currentMessage, userId, channelId, teamId },
        mcpHandle?.tools,
        mcpHandle?.servers,
      );
      const validToolNames = new Set(Object.keys(tools));
      const cleanStoredMessages = sanitizeStoredMessages(
        storedMessages,
        validToolNames,
      );

      const newMessages: ChatSDK.Message[] = [
        ...(skippedMessages ?? []),
        ...(currentMessage ? [currentMessage] : []),
      ];

      const [systemBuild, newAiMessages] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            buildSystemMessages(state, teamId, userId, channelId),
            ChatSDK.toAiMessages(newMessages, { includeNames: true }),
          ]),
        catch: (cause) => new AgentStreamError({ cause }),
      });
      const { messages: systemMessages, resolvedConfig } = systemBuild;

      let conversationMessages: Array<ModelMessage>;
      if (cleanStoredMessages.length > 0) {
        conversationMessages = [...cleanStoredMessages, ...newAiMessages];
      } else {
        // No prior turn persisted — pull thread history from the adapter so the
        // model has the participants' prior context. Dedupe against the new
        // messages so we don't double-count the trigger.
        const newIds = new Set(newMessages.map((message) => message.id));
        const historyMessages = thread.recentMessages.filter(
          (message) => !newIds.has(message.id),
        );
        const historyAiMessages = yield* Effect.tryPromise({
          try: () =>
            ChatSDK.toAiMessages(historyMessages, { includeNames: true }),
          catch: (cause) => new AgentStreamError({ cause }),
        });
        conversationMessages = [...historyAiMessages, ...newAiMessages];
      }

      // Convert any SDK-level skipped messages into follow-up text so they
      // get the same system-reminder treatment as Redis-queued follow-ups.
      const skippedFollowUps: string[] = (skippedMessages ?? [])
        .map((skippedMessage) => skippedMessage.text?.trim())
        .filter((text): text is string => Boolean(text));

      let didPostAnyMessage = false;
      let followUpMessages: string[] | undefined =
        skippedFollowUps.length > 0 ? skippedFollowUps : undefined;

      for (let round = 0; round < MAX_FOLLOW_UP_ROUNDS + 1; round++) {
        if (round > 0) {
          yield* Effect.tryPromise({
            try: async () => {
              await thread.refresh();
              await thread.startTyping();
            },
            catch: (cause) => new AgentStreamError({ cause }),
          });
        }

        const roundResult = yield* runAgentRound({
          thread,
          slack,
          state,
          currentMessage,
          conversationMessages,
          systemMessages,
          resolvedConfig,
          tools,
          abortController,
          followUpMessages,
          mcpServers: mcpHandle?.servers,
          isTracingEnabled,
        });

        conversationMessages = roundResult.conversationMessages;
        if (roundResult.didPostMessage) didPostAnyMessage = true;

        if (round >= MAX_FOLLOW_UP_ROUNDS) break;
        const drained = yield* threadLock.drainFollowUps(thread.id);
        if (drained.length === 0) break;

        yield* Effect.logInfo(
          `[agent] drained ${drained.length} follow-up(s), starting round ${round + 2}`,
        );
        followUpMessages = drained;
      }

      if (
        isTracingEnabled &&
        resolvedConfig.config.tracesFooter &&
        didPostAnyMessage &&
        channelId
      ) {
        const isDebugChannel = yield* Effect.tryPromise({
          try: () =>
            slack
              .fetchChannelInfo(`slack:${channelId}`)
              .then(
                (channelInfo) =>
                  channelInfo.name === TRACE_FOOTER_CHANNEL_NAME,
              )
              .catch(() => false),
          catch: () => new AgentStreamError({}),
        });

        if (isDebugChannel) {
          yield* Effect.tryPromise({
            try: () =>
              postTraceFooter(thread, traceId, Date.now() - startedAt),
            catch: (cause) => new AgentStreamError({ cause }),
          }).pipe(
            Effect.catchCause((traceCause) =>
              Effect.logWarning("[agent] failed to post trace footer").pipe(
                Effect.annotateLogs({ error: Cause.pretty(traceCause) }),
              ),
            ),
          );
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (channelId && messageTs) {
            yield* activeRuns.cleanup(channelId, messageTs);
          }
          if (mcpHandle) {
            yield* Effect.tryPromise({
              try: () => mcpHandle!.close(),
              catch: (cause) => new AgentStreamError({ cause }),
            }).pipe(
              Effect.catchCause((closeCause) =>
                Effect.logWarning("[mcp] close error").pipe(
                  Effect.annotateLogs({ error: Cause.pretty(closeCause) }),
                ),
              ),
            );
          }
          yield* threadLock.release(thread.id).pipe(
            Effect.catchCause((lockCause) =>
              Effect.logWarning("[agent] failed to release thread lock").pipe(
                Effect.annotateLogs({ error: Cause.pretty(lockCause) }),
              ),
            ),
          );
        }),
      ),
    );
  });
