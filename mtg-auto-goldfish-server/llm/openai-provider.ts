import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptTokenUsage,
} from "./index.js"

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
const OPENAI_PROMPT_TIMEOUT_MS = 10 * 60 * 1000

type OpenAiToolDefinition = {
  type: "mcp"
  server_label: string
  server_url: string
  require_approval: "never"
}

type OpenAiReasoningConfig = {
  effort?: string
  summary?: string
}

type OpenAiResponse = {
  output?: OpenAiOutputItem[]
  output_text?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    output_tokens_details?: {
      reasoning_tokens?: number
    }
    total_tokens?: number
  }
}

type OpenAiOutputItem = {
  id?: string
  status?: string
  type?: string
  name?: string
  tool_name?: string
  server_label?: string
  arguments?: unknown
  output?: unknown
  error?: unknown
  summary?: unknown
  content?: unknown
}

type OpenAiStreamEvent = {
  type: string
  item?: OpenAiOutputItem
  item_id?: string
  delta?: string
  arguments?: string
  text?: string
  message?: string
  error?: unknown
  response?: OpenAiResponse | { error?: unknown }
}

type ToolCallState = {
  tool?: string
  provider?: string
  argumentsText?: string
}

export function createOpenAiPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? OPENAI_DEFAULT_BASE_URL)
  const apiKey = options.apiKey?.trim()
  const modelName = options.model?.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  const mcpServerUrl = options.mcpServerUrl?.trim()
  const mcpServerLabel = options.mcpServerLabel?.trim() || "mtg-auto-goldfish"
  const maxOutputTokens = options.maxOutputTokens
  const reasoningEffort = options.reasoningEffort?.trim()
  const reasoningSummary = options.reasoningSummary?.trim()

  async function processPrompt(prompt: string): Promise<PromptProcessingResult> {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai.")
    }

    if (!modelName) {
      throw new Error("OPENAI_MODEL is required when LLM_PROVIDER=openai.")
    }

    const selectedModel = createConfiguredModel("openai", modelName)
    const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
      undefined,
      OPENAI_PROMPT_TIMEOUT_MS
    )

    const startedAt = Date.now()

    try {
      const response = await requestJson<OpenAiResponse>(
        fetchImpl,
        `${baseUrl}/responses`,
        {
          method: "POST",
          headers: buildHeaders(apiKey),
          signal: timeoutSignal,
          body: JSON.stringify({
            model: modelName,
            input: prompt,
            max_output_tokens: maxOutputTokens,
            reasoning: buildReasoningConfig(reasoningEffort, reasoningSummary),
            store: false,
            tools: buildTools({
              mcpServerLabel,
              mcpServerUrl,
            }),
          }),
        }
      )

      const extractedMessage = extractOpenAiMessageText(
        response.output,
        response.output_text
      )

      if (!extractedMessage) {
        throw new Error("OpenAI returned no message content for this prompt.")
      }

      return {
        result: extractedMessage,
        provider: "openai",
        model: selectedModel,
        usage: extractOpenAiUsage(response.usage),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      throw normalizePromptAbortError(error)
    } finally {
      cleanup()
    }
  }

  return {
    processPrompt,

    async processPromptStream(prompt, onEvent, signal) {
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai.")
      }

      if (!modelName) {
        throw new Error("OPENAI_MODEL is required when LLM_PROVIDER=openai.")
      }

      const selectedModel = createConfiguredModel("openai", modelName)

      onEvent({
        type: "start",
        model: selectedModel,
      })

      const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
        signal,
        OPENAI_PROMPT_TIMEOUT_MS
      )

      const startedAt = Date.now()
      let finalResponse: OpenAiResponse | undefined
      let streamedMessage = ""
      let hasStartedMessage = false
      const toolCalls = new Map<string, ToolCallState>()
      const activeReasoningItems = new Set<string>()

      try {
        const response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: buildHeaders(apiKey),
          signal: timeoutSignal,
          body: JSON.stringify({
            model: modelName,
            input: prompt,
            max_output_tokens: maxOutputTokens,
            reasoning: buildReasoningConfig(reasoningEffort, reasoningSummary),
            store: false,
            stream: true,
            tools: buildTools({
              mcpServerLabel,
              mcpServerUrl,
            }),
          }),
        })

        if (!response.ok) {
          throw new Error(await buildErrorMessage(response, "OpenAI"))
        }

        if (!response.body) {
          throw new Error("OpenAI returned no stream body for this prompt.")
        }

        await consumeSseStream(
          response,
          (event) => {
            switch (event.type) {
              case "response.created":
              case "response.in_progress":
                onEvent({
                  type: "status",
                  event: event.type,
                })
                break

              case "response.output_item.added": {
                const item = event.item
                const itemId = item?.id

                if (item?.type === "mcp_call" && itemId) {
                  const tool = extractToolName(item)
                  const provider = asString(item.server_label)

                  toolCalls.set(itemId, {
                    tool,
                    provider,
                    argumentsText: normalizeArgumentsText(item.arguments),
                  })

                  onEvent({
                    type: "tool",
                    event: "tool_call.start",
                    tool,
                    provider,
                  })
                }

                break
              }

              case "response.mcp_call.in_progress":
                break

              case "response.mcp_call_arguments.delta": {
                if (!event.item_id || !event.delta) {
                  break
                }

                const existingToolCall = toolCalls.get(event.item_id)
                const argumentsText =
                  (existingToolCall?.argumentsText ?? "") + event.delta

                toolCalls.set(event.item_id, {
                  ...existingToolCall,
                  argumentsText,
                })
                break
              }

              case "response.mcp_call_arguments.done": {
                if (!event.item_id) {
                  break
                }

                const existingToolCall = toolCalls.get(event.item_id)
                const argumentsText =
                  event.arguments ?? existingToolCall?.argumentsText

                toolCalls.set(event.item_id, {
                  ...existingToolCall,
                  argumentsText,
                })

                if (argumentsText) {
                  onEvent({
                    type: "tool",
                    event: "tool_call.arguments",
                    tool: existingToolCall?.tool,
                    provider: existingToolCall?.provider,
                    argumentsText,
                  })
                }
                break
              }

              case "response.reasoning_summary_text.delta": {
                const delta = event.delta ?? ""
                const reasoningItemId = event.item_id ?? "openai-reasoning-summary"

                if (!delta) {
                  break
                }

                if (!activeReasoningItems.has(reasoningItemId)) {
                  activeReasoningItems.add(reasoningItemId)
                  onEvent({
                    type: "status",
                    event: "reasoning.start",
                  })
                }

                onEvent({
                  type: "reasoning",
                  delta,
                })
                break
              }

              case "response.output_text.delta": {
                const delta = event.delta ?? ""

                if (!delta) {
                  break
                }

                if (!hasStartedMessage) {
                  hasStartedMessage = true
                  onEvent({
                    type: "status",
                    event: "message.start",
                  })
                }

                streamedMessage += delta
                onEvent({
                  type: "message",
                  delta,
                })
                break
              }

              case "response.output_text.done":
                if (hasStartedMessage) {
                  onEvent({
                    type: "status",
                    event: "message.end",
                  })
                  hasStartedMessage = false
                }
                break

              case "response.output_item.done": {
                const item = event.item
                const itemId = item?.id

                if (item?.type === "mcp_call" && itemId) {
                  const knownToolCall = toolCalls.get(itemId)
                  const tool = extractToolName(item) ?? knownToolCall?.tool
                  const provider =
                    asString(item.server_label) ?? knownToolCall?.provider
                  const argumentsText =
                    normalizeArgumentsText(item.arguments) ??
                    knownToolCall?.argumentsText
                  const output = stringifyUnknown(item.output)
                  const error = stringifyUnknown(item.error)
                  const isFailure = item.status === "failed" || Boolean(error)

                  toolCalls.set(itemId, {
                    tool,
                    provider,
                    argumentsText,
                  })

                  onEvent({
                    type: "tool",
                    event: isFailure ? "tool_call.failure" : "tool_call.success",
                    tool,
                    provider,
                    argumentsText,
                    output,
                    error,
                  })
                }

                if (item?.type === "reasoning" && itemId && activeReasoningItems.has(itemId)) {
                  activeReasoningItems.delete(itemId)
                  onEvent({
                    type: "status",
                    event: "reasoning.end",
                  })
                }

                break
              }

              case "response.mcp_call.completed":
              case "response.mcp_call.failed":
                break

              case "response.completed":
                for (const reasoningItemId of activeReasoningItems) {
                  void reasoningItemId
                  onEvent({
                    type: "status",
                    event: "reasoning.end",
                  })
                }
                activeReasoningItems.clear()
                finalResponse = isOpenAiResponse(event.response)
                  ? event.response
                  : undefined
                break

              case "response.failed": {
                const message =
                  stringifyUnknown(asObjectRecord(event.response).error) ??
                  "OpenAI streaming request failed."
                onEvent({
                  type: "error",
                  error: message,
                })
                throw new Error(message)
              }

              case "error": {
                const message =
                  stringifyUnknown(event.error) ??
                  event.message ??
                  "OpenAI streaming request failed."
                onEvent({
                  type: "error",
                  error: message,
                })
                throw new Error(message)
              }

              default:
                break
            }
          },
          timeoutSignal
        )
      } catch (error) {
        throw normalizePromptAbortError(error)
      } finally {
        cleanup()
      }

      const extractedReasoning = extractOpenAiReasoningText(finalResponse?.output)
      const extractedMessage =
        extractOpenAiMessageText(finalResponse?.output, finalResponse?.output_text) ||
        streamedMessage.trim()

      if (!extractedMessage) {
        throw new Error("OpenAI returned no message content for this prompt.")
      }

      onEvent({
        type: "done",
        result: extractedMessage,
        reasoning: extractedReasoning,
        model: selectedModel,
      })

      return {
        result: extractedMessage,
        provider: "openai",
        model: selectedModel,
        usage: extractOpenAiUsage(finalResponse?.usage),
        durationMs: Date.now() - startedAt,
      }
    },
  }
}

function buildTools(options: {
  mcpServerLabel: string
  mcpServerUrl?: string
}): OpenAiToolDefinition[] | undefined {
  if (!options.mcpServerUrl) {
    return undefined
  }

  return [
    {
      type: "mcp",
      server_label: options.mcpServerLabel,
      server_url: options.mcpServerUrl,
      require_approval: "never",
    },
  ]
}

function buildReasoningConfig(
  reasoningEffort: string | undefined,
  reasoningSummary: string | undefined
): OpenAiReasoningConfig | undefined {
  if (!reasoningEffort && !reasoningSummary) {
    return undefined
  }

  return {
    effort: reasoningEffort,
    summary: reasoningSummary,
  }
}

function extractOpenAiMessageText(
  output: OpenAiOutputItem[] | undefined,
  fallbackText: string | undefined
) {
  const joinedOutputText = (output ?? [])
    .filter((item) => item.type === "message")
    .map(extractMessageFromItem)
    .filter(Boolean)
    .join("")
    .trim()

  if (joinedOutputText) {
    return joinedOutputText
  }

  return fallbackText?.trim() ?? ""
}

function extractOpenAiReasoningText(output: OpenAiOutputItem[] | undefined) {
  return (output ?? [])
    .filter((item) => item.type === "reasoning")
    .map(extractReasoningFromItem)
    .filter(Boolean)
    .join("\n\n")
}

function extractMessageFromItem(item: OpenAiOutputItem) {
  if (!Array.isArray(item.content)) {
    return ""
  }

  return item.content
    .map((contentItem) => {
      const record = asObjectRecord(contentItem)

      if (record.type === "output_text") {
        return asString(record.text) ?? ""
      }

      return ""
    })
    .join("")
    .trim()
}

function extractReasoningFromItem(item: OpenAiOutputItem) {
  if (!Array.isArray(item.summary)) {
    return ""
  }

  return item.summary
    .map((summaryItem) => {
      const record = asObjectRecord(summaryItem)

      return asString(record.text) ?? ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function extractToolName(item: OpenAiOutputItem) {
  return asString(item.name) ?? asString(item.tool_name)
}

function extractOpenAiUsage(usage: OpenAiResponse["usage"]): PromptTokenUsage | undefined {
  if (!usage) {
    return undefined
  }

  const normalizedUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens,
  }

  return Object.values(normalizedUsage).some((value) => typeof value === "number")
    ? normalizedUsage
    : undefined
}

function normalizeArgumentsText(value: unknown) {
  if (typeof value === "string") {
    return value
  }

  return safeJsonStringify(value)
}

function isOpenAiResponse(value: unknown): value is OpenAiResponse {
  return !!value && typeof value === "object"
}

function createConfiguredModel(
  provider: string,
  modelName: string
): LoadedTextModel {
  return {
    key: modelName,
    displayName: `${provider}: ${modelName}`,
    sizeBytes: 0,
    instanceIds: [],
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "")
}

function buildHeaders(apiKey: string) {
  return new Headers({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
  })
}

async function consumeSseStream(
  response: Response,
  onEvent: (event: OpenAiStreamEvent) => void,
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

function emitSseEvent(
  rawEvent: string,
  onEvent: (event: OpenAiStreamEvent) => void
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

  if (payloadText === "[DONE]") {
    return
  }

  const payload = asObjectRecord(JSON.parse(payloadText))

  onEvent({
    ...payload,
    type: asString(payload.type) ?? eventName,
    item: isOpenAiOutputItem(payload.item) ? payload.item : undefined,
    item_id: asString(payload.item_id),
    delta: asString(payload.delta),
    arguments: asString(payload.arguments),
    text: asString(payload.text),
    message: asString(payload.message),
    error: payload.error,
    response: payload.response ? asObjectRecord(payload.response) : undefined,
  })
}

function isOpenAiOutputItem(value: unknown): value is OpenAiOutputItem {
  return !!value && typeof value === "object"
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
    cleanup() {
      clearTimeout(timeoutId)

      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent)
      }
    },
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

function createPromptTimeoutError(timeoutMs: number) {
  return new Error(
    `OpenAI prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
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
      return createPromptTimeoutError(OPENAI_PROMPT_TIMEOUT_MS)
    }
  }

  return error
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(input, init)

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response, "OpenAI"))
  }

  return (await response.json()) as T
}

async function buildErrorMessage(response: Response, providerLabel: string) {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as {
      error?:
        | string
        | {
            message?: string
          }
      message?: string
    }

    if (typeof payload.error === "string") {
      return payload.error
    }

    if (payload.error?.message || payload.message) {
      return (
        payload.error?.message ??
        payload.message ??
        `${providerLabel} request failed with ${response.status}.`
      )
    }
  }

  const bodyText = (await response.text()).trim()

  if (bodyText) {
    return bodyText
  }

  return `${providerLabel} request failed with ${response.status}.`
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object") {
    return {}
  }

  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function safeJsonStringify(value: unknown) {
  if (value === undefined || value === null) {
    return undefined
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") {
    return value
  }

  if (value === undefined || value === null) {
    return undefined
  }

  return safeJsonStringify(value)
}

