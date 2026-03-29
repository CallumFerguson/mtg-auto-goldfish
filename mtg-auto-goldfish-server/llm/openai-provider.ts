import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptStreamEvent,
} from "./index.js"

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
const OPENAI_DEFAULT_MODEL = "gpt-5"
const OPENAI_PROMPT_TIMEOUT_MS = 10 * 60 * 1000

type OpenAiToolDefinition = {
  type: "mcp"
  server_label: string
  server_url: string
  require_approval: "never"
}

type OpenAiResponse = {
  output?: OpenAiOutputItem[]
  output_text?: string
}

type OpenAiOutputItem = {
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

export function createOpenAiPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? OPENAI_DEFAULT_BASE_URL)
  const apiKey = options.apiKey?.trim()
  const modelName = options.model?.trim() || OPENAI_DEFAULT_MODEL
  const fetchImpl = options.fetchImpl ?? fetch
  const mcpServerUrl = options.mcpServerUrl?.trim()
  const mcpServerLabel = options.mcpServerLabel?.trim() || "mtg-auto-goldfish"
  const maxOutputTokens = options.maxOutputTokens
  const reasoningEffort = options.reasoningEffort?.trim()

  async function runPrompt(
    prompt: string,
    onEvent?: (event: PromptStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<PromptProcessingResult> {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai.")
    }

    const selectedModel = createConfiguredModel("openai", modelName)

    onEvent?.({
      type: "start",
      model: selectedModel,
    })

    const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
      signal,
      OPENAI_PROMPT_TIMEOUT_MS
    )

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
            reasoning: reasoningEffort
              ? {
                  effort: reasoningEffort,
                }
              : undefined,
            store: false,
            tools: buildTools({
              mcpServerLabel,
              mcpServerUrl,
            }),
          }),
        }
      )

      const extractedReasoning = extractOpenAiReasoningText(response.output)
      const extractedMessage = extractOpenAiMessageText(
        response.output,
        response.output_text
      )

      emitOpenAiStreamEvents(response.output, extractedMessage, onEvent)

      if (!extractedMessage) {
        throw new Error("OpenAI returned no message content for this prompt.")
      }

      onEvent?.({
        type: "done",
        result: extractedMessage,
        reasoning: extractedReasoning,
        model: selectedModel,
      })

      return {
        result: extractedMessage,
        model: selectedModel,
      }
    } catch (error) {
      throw normalizePromptAbortError(error)
    } finally {
      cleanup()
    }
  }

  return {
    processPrompt(prompt) {
      return runPrompt(prompt)
    },

    processPromptStream(prompt, onEvent, signal) {
      return runPrompt(prompt, onEvent, signal)
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

function emitOpenAiStreamEvents(
  output: OpenAiOutputItem[] | undefined,
  fallbackMessageText: string,
  onEvent?: (event: PromptStreamEvent) => void
) {
  if (!onEvent) {
    return
  }

  let emittedMessage = false

  for (const item of output ?? []) {
    if (item.type === "reasoning") {
      const reasoningText = extractReasoningFromItem(item)

      if (reasoningText) {
        onEvent({
          type: "status",
          event: "reasoning.start",
        })
        onEvent({
          type: "reasoning",
          delta: reasoningText,
        })
        onEvent({
          type: "status",
          event: "reasoning.end",
        })
      }

      continue
    }

    if (item.type === "mcp_call") {
      const toolName = extractToolName(item)
      const provider = asString(item.server_label)
      const argumentsText = normalizeArgumentsText(item.arguments)
      const errorText = stringifyUnknown(item.error)
      const outputText = stringifyUnknown(item.output)

      onEvent({
        type: "tool",
        event: "tool_call.start",
        tool: toolName,
        provider,
      })

      if (argumentsText) {
        onEvent({
          type: "tool",
          event: "tool_call.arguments",
          tool: toolName,
          provider,
          argumentsText,
        })
      }

      onEvent({
        type: "tool",
        event: errorText ? "tool_call.failure" : "tool_call.success",
        tool: toolName,
        provider,
        argumentsText,
        output: outputText,
        error: errorText,
      })

      continue
    }

    if (item.type === "message") {
      const messageText = extractMessageFromItem(item)

      if (!messageText) {
        continue
      }

      emittedMessage = true
      onEvent({
        type: "status",
        event: "message.start",
      })
      onEvent({
        type: "message",
        delta: messageText,
      })
      onEvent({
        type: "status",
        event: "message.end",
      })
    }
  }

  if (!emittedMessage && fallbackMessageText) {
    onEvent({
      type: "status",
      event: "message.start",
    })
    onEvent({
      type: "message",
      delta: fallbackMessageText,
    })
    onEvent({
      type: "status",
      event: "message.end",
    })
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

function normalizeArgumentsText(value: unknown) {
  if (typeof value === "string") {
    return value
  }

  return safeJsonStringify(value)
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
    Authorization: `Bearer ${apiKey}`,
  })
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
  if (value === undefined) {
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

  return safeJsonStringify(value)
}
