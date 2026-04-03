import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptStreamEvent,
} from "./index.js"

export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234"
export const LM_STUDIO_PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const STREAM_LOOP_SEQUENCE_LENGTH = 250
const STREAM_LOOP_ANALYSIS_LENGTH = 5000
const STREAM_LOOP_CHECK_INTERVAL_CHARS = 1000
const STREAM_LOOP_ERROR_MESSAGE = "The LLM got stuck in a loop."

type LmStudioModelsResponse = {
  models: Array<{
    type: "llm" | "embedding"

    key: string

    display_name: string

    size_bytes: number

    loaded_instances: Array<{
      id: string
    }>
  }>
}

type LmStudioOutputItem =
  | {
    type: "message"

    content: string
  }
  | {
    type: "reasoning"

    content: string
  }
  | {
    type: string

    content?: string
  }

type LmStudioChatResponse = {
  output?: LmStudioOutputItem[]
  error?: unknown
  message?: string
}

type LmStudioChatStreamEndEvent = {
  type: "chat.end"

  result?: LmStudioChatResponse
  error?: unknown
  message?: string
}

export function createLmStudioPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? LM_STUDIO_DEFAULT_BASE_URL
  )

  const apiToken = options.apiToken?.trim() || options.apiKey?.trim() || undefined
  const requestedModel = options.model?.trim() || undefined

  const fetchImpl = options.fetchImpl ?? fetch

  const mcpServerUrl = options.mcpServerUrl?.trim()

  const mcpServerLabel = options.mcpServerLabel?.trim() || "mtg-auto-goldfish"

  return {
    async processPrompt(prompt: string): Promise<PromptProcessingResult> {
      const loadedModels = await listLoadedTextModels({
        apiToken,

        baseUrl,

        fetchImpl,
      })

      const selectedModel = pickLoadedModel(loadedModels, requestedModel)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      const startedAt = Date.now()

      const { signal, cleanup } = createTimeoutSignal(
        undefined,
        LM_STUDIO_PROMPT_TIMEOUT_MS
      )

      try {
        const chatResponse = await requestJson<LmStudioChatResponse>(
          fetchImpl,

          `${baseUrl}/api/v1/chat`,

          {
            method: "POST",

            headers: buildHeaders(apiToken),

            signal,

            body: JSON.stringify({
              model: selectedModel.key,

              input: prompt,

              integrations: buildIntegrations({
                mcpServerLabel,

                mcpServerUrl,
              }),


              stream: false,

              store: false,
            }),
          }
        )

        const result = extractMessageText(chatResponse)

        if (!result) {
          throw new Error(
            buildMissingMessageContentError(
              extractLmStudioErrorMessage(chatResponse)
            )
          )
        }

        return {
          result,

          provider: "lm-studio" as const,
          model: selectedModel,
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        throw normalizePromptAbortError(error)
      } finally {
        cleanup()
      }
    },

    async processPromptStream(
      prompt: string,

      onEvent: (event: PromptStreamEvent) => void,
      signal?: AbortSignal
    ): Promise<PromptProcessingResult> {
      const loadedModels = await listLoadedTextModels({
        apiToken,

        baseUrl,

        fetchImpl,
      })

      const selectedModel = pickLoadedModel(loadedModels, requestedModel)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      onEvent({
        type: "start",

        model: selectedModel,
      })

      const startedAt = Date.now()

      const {
        signal: timeoutSignal,
        abort: abortPrompt,
        cleanup,
      } = createTimeoutSignal(signal, LM_STUDIO_PROMPT_TIMEOUT_MS)

      let finalResult = ""
      let finalReasoning = ""
      let streamedText = ""
      let nextLoopCheckLength = STREAM_LOOP_CHECK_INTERVAL_CHARS
      let pendingMessageStartPayload: Record<
        string,
        string | undefined
      > | null = null
      let hasFlushedMessageBlock = false
      let latestStreamErrorMessage: string | undefined

      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/chat`, {
          method: "POST",

          headers: buildHeaders(apiToken),

          signal: timeoutSignal,

          body: JSON.stringify({
            model: selectedModel.key,

            input: prompt,

            integrations: buildIntegrations({
              mcpServerLabel,

              mcpServerUrl,
            }),


            stream: true,

            store: false,
          }),
        })

        if (!response.ok) {
          throw new Error(await buildErrorMessage(response))
        }

        if (!response.body) {
          throw new Error("LM Studio returned no stream body for this prompt.")
        }

        await consumeSseStream(response, (eventName, payload) => {
          switch (eventName) {
            case "chat.start":

            case "model_load.start":

            case "model_load.end":

            case "prompt_processing.start":

            case "prompt_processing.end":

            case "reasoning.start":

            case "reasoning.end":
              onEvent({
                type: "status",

                event: eventName,

                modelInstanceId: asStringRecord(payload).model_instance_id,
              })

              break

            case "message.start":
              pendingMessageStartPayload = asStringRecord(payload)
              hasFlushedMessageBlock = false
              break
            case "message.end":
              if (hasFlushedMessageBlock) {
                onEvent({
                  type: "status",
                  event: eventName,
                  modelInstanceId: asStringRecord(payload).model_instance_id,
                })
              }
              pendingMessageStartPayload = null
              hasFlushedMessageBlock = false
              break
            case "model_load.progress":

            case "prompt_processing.progress":
              onEvent({
                type: "status",

                event: eventName,

                progress: asNumberRecord(payload).progress,

                modelInstanceId: asStringRecord(payload).model_instance_id,
              })

              break

            case "reasoning.delta": {
              const content = asContentRecord(payload).content

              if (typeof content === "string") {
                ({
                  streamedText,
                  nextLoopCheckLength,
                } = appendStreamTextOrThrow(
                  streamedText,
                  content,
                  nextLoopCheckLength,
                  abortPrompt
                ))

                onEvent({
                  type: "reasoning",

                  delta: content,
                })
              }

              break
            }

            case "message.delta": {
              const content = asContentRecord(payload).content

              if (typeof content === "string") {
                let emittedContent = content

                if (!hasFlushedMessageBlock) {
                  const trimmedLeadingContent = content.replace(/^\s+/, "")

                  if (!trimmedLeadingContent) {
                    break
                  }

                  onEvent({
                    type: "status",
                    event: "message.start",
                    modelInstanceId:
                      pendingMessageStartPayload?.model_instance_id ??
                      asStringRecord(payload).model_instance_id,
                  })

                  hasFlushedMessageBlock = true
                  emittedContent = trimmedLeadingContent
                }

                ({
                  streamedText,
                  nextLoopCheckLength,
                } = appendStreamTextOrThrow(
                  streamedText,
                  emittedContent,
                  nextLoopCheckLength,
                  abortPrompt
                ))

                onEvent({
                  type: "message",
                  delta: emittedContent,
                })
              }
              break
            }
            case "tool_call.start":
              ({
                streamedText,
                nextLoopCheckLength,
              } = appendStreamTextOrThrow(
                streamedText,
                `${eventName}:${extractToolName(payload) ?? ""}`,
                nextLoopCheckLength,
                abortPrompt
              ))
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),
              })

              break

            case "tool_call.arguments":
              ({
                streamedText,
                nextLoopCheckLength,
              } = appendStreamTextOrThrow(
                streamedText,
                safeJsonStringify(asObjectRecord(payload).arguments),
                nextLoopCheckLength,
                abortPrompt
              ))
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),

                argumentsText: safeJsonStringify(
                  asObjectRecord(payload).arguments
                ),
              })

              break

            case "tool_call.success":
              ({
                streamedText,
                nextLoopCheckLength,
              } = appendStreamTextOrThrow(
                streamedText,
                `${safeJsonStringify(asObjectRecord(payload).arguments) ?? ""}${asStringRecord(payload).output ?? ""}`,
                nextLoopCheckLength,
                abortPrompt
              ))
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),

                argumentsText: safeJsonStringify(
                  asObjectRecord(payload).arguments
                ),

                output: asStringRecord(payload).output,
              })

              break

            case "tool_call.failure":
              latestStreamErrorMessage =
                asStringRecord(payload).reason ??
                asStringRecord(asObjectRecord(payload).error).message ??
                latestStreamErrorMessage;
              ({
                streamedText,
                nextLoopCheckLength,
              } = appendStreamTextOrThrow(
                streamedText,
                latestStreamErrorMessage,
                nextLoopCheckLength,
                abortPrompt
              ))
              onEvent({
                type: "tool",

                event: eventName,

                error: latestStreamErrorMessage,
              })

              break

            case "error":
              latestStreamErrorMessage =
                extractLmStudioErrorMessage(payload) ?? latestStreamErrorMessage;
              ({
                streamedText,
                nextLoopCheckLength,
              } = appendStreamTextOrThrow(
                streamedText,
                latestStreamErrorMessage,
                nextLoopCheckLength,
                abortPrompt
              ))
              onEvent({
                type: "error",

                error:
                  latestStreamErrorMessage ??
                  "LM Studio reported a streaming error.",
              })

              break

            case "chat.end": {
              const endPayload = payload as LmStudioChatStreamEndEvent

              latestStreamErrorMessage =
                extractLmStudioErrorMessage(endPayload) ??
                extractLmStudioErrorMessage(endPayload.result) ??
                latestStreamErrorMessage

              finalResult = extractMessageText(endPayload.result ?? {})

              finalReasoning = extractReasoningText(endPayload.result ?? {})

              break
            }

            default:
              onEvent({
                type: "status",

                event: eventName,
              })

              break
          }
        }, timeoutSignal)
      } catch (error) {
        throw normalizePromptAbortError(error)
      } finally {
        cleanup()
      }

      if (!finalResult) {
        throw new Error(buildMissingMessageContentError(latestStreamErrorMessage))
      }

      const result = {
        result: finalResult,

        provider: "lm-studio" as const,
        model: selectedModel,
        durationMs: Date.now() - startedAt,
      }

      onEvent({
        type: "done",

        result: finalResult,

        reasoning: finalReasoning,

        model: selectedModel,
      })

      return result
    },
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "")
}

function buildHeaders(apiToken: string | undefined) {
  const headers = new Headers({
    "Content-Type": "application/json",
  })

  if (apiToken) {
    headers.set("Authorization", `Bearer ${apiToken}`)
  }

  return headers
}

function buildIntegrations(options: {
  mcpServerLabel: string

  mcpServerUrl?: string
}) {
  if (!options.mcpServerUrl) {
    return undefined
  }

  return [
    {
      type: "ephemeral_mcp" as const,

      server_label: options.mcpServerLabel,

      server_url: options.mcpServerUrl,
    },
  ]
}

async function listLoadedTextModels(options: {
  baseUrl: string

  apiToken?: string

  fetchImpl: typeof fetch
}): Promise<LoadedTextModel[]> {
  const response = await requestJson<LmStudioModelsResponse>(
    options.fetchImpl,

    `${options.baseUrl}/api/v1/models`,

    {
      method: "GET",

      headers: buildHeaders(options.apiToken),
    }
  )

  return response.models

    .filter(
      (model) => model.type === "llm" && model.loaded_instances.length > 0
    )

    .map((model) => ({
      key: model.key,

      displayName: model.display_name,

      sizeBytes: model.size_bytes,

      instanceIds: model.loaded_instances.map((instance) => instance.id),
    }))
}

function pickLoadedModel(models: LoadedTextModel[], requestedModel?: string) {
  if (!requestedModel) {
    return [...models].sort((left, right) => right.sizeBytes - left.sizeBytes)[0]
  }

  const normalizedRequestedModel = requestedModel.toLowerCase()
  const matchedModel = models.find(
    (model) =>
      model.key.toLowerCase() === normalizedRequestedModel ||
      model.displayName.toLowerCase() === normalizedRequestedModel
  )

  if (!matchedModel) {
    const availableModels = models
      .map((model) => model.key)
      .sort((left, right) => left.localeCompare(right))
      .join(", ")

    throw new Error(
      `LM Studio model ${JSON.stringify(requestedModel)} is not currently loaded. Loaded models: ${availableModels || "none"}.`
    )
  }

  return matchedModel
}

function extractMessageText(response: LmStudioChatResponse) {
  return (response.output ?? [])

    .filter(isMessageOutput)

    .map((item) => item.content.trim())

    .filter(Boolean)

    .join("\n\n")
}

function extractReasoningText(response: LmStudioChatResponse) {
  return (response.output ?? [])

    .filter(isReasoningOutput)

    .map((item) => item.content.trim())

    .filter(Boolean)

    .join("\n\n")
}

function isMessageOutput(
  item: LmStudioOutputItem
): item is Extract<LmStudioOutputItem, { type: "message" }> {
  return item.type === "message" && typeof item.content === "string"
}

function isReasoningOutput(
  item: LmStudioOutputItem
): item is Extract<LmStudioOutputItem, { type: "reasoning" }> {
  return item.type === "reasoning" && typeof item.content === "string"
}

async function consumeSseStream(
  response: Response,

  onEvent: (eventName: string, payload: unknown) => void,
  signal?: AbortSignal
) {
  const decoder = new TextDecoder()

  let buffer = ""

  if (signal?.aborted) {
    throw getAbortReason(signal)
  }

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) {
      throw getAbortReason(signal)
    }
    buffer += decoder.decode(chunk, { stream: true })

    buffer = buffer.replace(/\r\n/g, "\n")

    let boundaryIndex = buffer.indexOf("\n\n")

    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex)

      buffer = buffer.slice(boundaryIndex + 2)

      emitSseEvent(rawEvent, onEvent)

      boundaryIndex = buffer.indexOf("\n\n")
    }
  }

  buffer += decoder.decode()

  if (buffer.trim()) {
    emitSseEvent(buffer, onEvent)
  }
}

function createAbortError() {
  return new DOMException("The prompt request was cancelled.", "AbortError")
}

function getAbortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) {
    return signal.reason
  }

  return createAbortError()
}

function createTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
) {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort(createPromptTimeoutError(timeoutMs))
  }, timeoutMs)

  const abortFromParent = () => {
    timeoutController.abort(parentSignal?.reason ?? createAbortError())
  }

  if (parentSignal?.aborted) {
    abortFromParent()
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", abortFromParent, { once: true })
  }

  return {
    signal: timeoutController.signal,
    abort(reason?: unknown) {
      timeoutController.abort(reason ?? createAbortError())
    },
    cleanup() {
      clearTimeout(timeoutId)

      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent)
      }
    },
  }
}


function longestSubstringLengthRepeatingAtLeast3Times(s: string): number {
  const n = s.length

  if (n < 3) {
    return 0
  }

  const sa = buildSuffixArray(s)
  const lcp = buildLcpArray(s, sa)

  let bestLen = 0

  for (let i = 1; i + 1 < n; i++) {
    const sharedLen = Math.min(lcp[i], lcp[i + 1])

    if (sharedLen > bestLen) {
      bestLen = sharedLen
    }
  }

  return bestLen
}

function buildSuffixArray(s: string): number[] {
  const n = s.length
  const sa = Array.from({ length: n }, (_, i) => i)
  let rank = Array.from({ length: n }, (_, i) => s.charCodeAt(i))
  const tmp = new Array<number>(n)

  for (let k = 1; k < n; k <<= 1) {
    sa.sort((a, b) => {
      if (rank[a] !== rank[b]) {
        return rank[a] - rank[b]
      }

      const ra = a + k < n ? rank[a + k] : -1
      const rb = b + k < n ? rank[b + k] : -1

      return ra - rb
    })

    tmp[sa[0]] = 0

    for (let i = 1; i < n; i++) {
      const a = sa[i - 1]
      const b = sa[i]

      const different =
        rank[a] !== rank[b] ||
        (a + k < n ? rank[a + k] : -1) !== (b + k < n ? rank[b + k] : -1)

      tmp[b] = tmp[a] + (different ? 1 : 0)
    }

    rank = tmp.slice()

    if (rank[sa[n - 1]] === n - 1) {
      break
    }
  }

  return sa
}

function buildLcpArray(s: string, sa: number[]): number[] {
  const n = s.length
  const rank = new Array<number>(n)

  for (let i = 0; i < n; i++) {
    rank[sa[i]] = i
  }

  const lcp = new Array<number>(n).fill(0)
  let h = 0

  for (let i = 0; i < n; i++) {
    const r = rank[i]

    if (r === 0) {
      continue
    }

    const j = sa[r - 1]

    while (
      i + h < n &&
      j + h < n &&
      s.charCodeAt(i + h) === s.charCodeAt(j + h)
    ) {
      h++
    }

    lcp[r] = h

    if (h > 0) {
      h--
    }
  }

  return lcp
}

function appendStreamTextOrThrow(
  streamedText: string,
  chunk: string | undefined,
  nextLoopCheckLength: number,
  abortPrompt: (reason?: unknown) => void
): { streamedText: string; nextLoopCheckLength: number } {
  if (!chunk) {
    return {
      streamedText,
      nextLoopCheckLength,
    }
  }

  const nextStreamedText = streamedText + chunk

  if (nextStreamedText.length < nextLoopCheckLength) {
    return {
      streamedText: nextStreamedText,
      nextLoopCheckLength,
    }
  }

  const analyzedText = nextStreamedText.slice(-STREAM_LOOP_ANALYSIS_LENGTH)
  const longestRepeatedSubstringLength =
    longestSubstringLengthRepeatingAtLeast3Times(analyzedText)
  const isLooping =
    longestRepeatedSubstringLength > STREAM_LOOP_SEQUENCE_LENGTH
  if (isLooping) {
    abortPrompt(new Error(STREAM_LOOP_ERROR_MESSAGE))
    throw new Error(STREAM_LOOP_ERROR_MESSAGE)
  }

  return {
    streamedText: nextStreamedText,
    nextLoopCheckLength:
      Math.floor(nextStreamedText.length / STREAM_LOOP_CHECK_INTERVAL_CHARS) *
      STREAM_LOOP_CHECK_INTERVAL_CHARS +
      STREAM_LOOP_CHECK_INTERVAL_CHARS,
  }
}

function createPromptTimeoutError(timeoutMs: number) {
  return new Error(
    `LM Studio prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
  )
}

function normalizePromptAbortError(error: unknown) {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" &&
      error.message === "The prompt request was cancelled."
    ) {
      return error
    }

    if (
      error.name === "TimeoutError" ||
      error.message.includes("timed out after")
    ) {
      return createPromptTimeoutError(LM_STUDIO_PROMPT_TIMEOUT_MS)
    }
  }

  return error
}

function emitSseEvent(
  rawEvent: string,

  onEvent: (eventName: string, payload: unknown) => void
) {
  const lines = rawEvent

    .split("\n")

    .map((line) => line.trimEnd())

    .filter(Boolean)

  let eventName = "message"

  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()

      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }

  if (!dataLines.length) {
    return
  }

  const payloadText = dataLines.join("\n")

  const payload = JSON.parse(payloadText) as unknown

  onEvent(eventName, payload)
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object") {
    return {}
  }

  return value as Record<string, unknown>
}


function asStringRecord(value: unknown) {
  return asObjectRecord(value) as Record<string, string | undefined>
}

function asNumberRecord(value: unknown) {
  return asObjectRecord(value) as Record<string, number | undefined>
}

function asContentRecord(value: unknown) {
  return asObjectRecord(value) as { content?: string }
}

function extractProviderLabel(value: unknown) {
  const providerInfo = asObjectRecord(asObjectRecord(value).provider_info)

  if (typeof providerInfo.server_label === "string") {
    return providerInfo.server_label
  }

  if (typeof providerInfo.plugin_id === "string") {
    return providerInfo.plugin_id
  }

  return undefined
}

function extractToolName(value: unknown) {
  const payload = asObjectRecord(value)

  const functionRecord = asObjectRecord(payload.function)

  if (typeof payload.tool === "string") {
    return payload.tool
  }

  if (typeof payload.tool_name === "string") {
    return payload.tool_name
  }

  if (typeof payload.name === "string") {
    return payload.name
  }

  if (typeof functionRecord.name === "string") {
    return functionRecord.name
  }

  return undefined
}

function safeJsonStringify(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

function extractLmStudioErrorMessage(value: unknown): string | undefined {
  const payload = asObjectRecord(value)
  const nestedError = asObjectRecord(payload.error)
  const nestedDetails = asObjectRecord(payload.details)
  const candidates = [
    payload.error,
    payload.message,
    payload.reason,
    payload.details,
    nestedError.message,
    nestedError.error,
    nestedError.reason,
    nestedDetails.message,
    nestedDetails.error,
    nestedDetails.reason,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  return undefined
}

async function requestJson<T>(
  fetchImpl: typeof fetch,

  input: string,

  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(input, init)

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response))
  }

  return (await response.json()) as T
}

async function buildErrorMessage(response: Response) {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as unknown
    const extractedMessage = extractLmStudioErrorMessage(payload)

    if (extractedMessage) {
      return extractedMessage
    }
  }

  const bodyText = (await response.text()).trim()

  if (bodyText) {
    return bodyText
  }

  return `LM Studio request failed with ${response.status}.`
}

function buildMissingMessageContentError(upstreamError?: string) {
  const trimmedUpstreamError = upstreamError?.trim()

  if (trimmedUpstreamError) {
    return `${trimmedUpstreamError}${buildContextWindowHint(trimmedUpstreamError)}`
  }

  return "LM Studio returned no message content for this prompt. The loaded model may not have enough context window for this prompt."
}

function buildContextWindowHint(message: string) {
  if (!looksLikeContextWindowError(message)) {
    return ""
  }

  return " The loaded model may not have enough context window for this prompt. Try a model with a larger context window or shorten the prompt."
}

function looksLikeContextWindowError(message: string) {
  return /(context window|maximum context|max context|context length|prompt too long|too many tokens|token limit|input too long|exceeds?(?: the)? (?:context|token)|longer than (?:the )?context|more than.*tokens|context overflow)/i.test(
    message
  )
}














