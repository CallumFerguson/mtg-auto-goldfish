import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptStreamEvent,
} from "./index.js"

export const CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
const CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS = 8192
const CLAUDE_PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const CLAUDE_API_VERSION = "2023-06-01"
const CLAUDE_MCP_BETA_HEADER = "mcp-client-2025-04-04"
const CLAUDE_ADAPTIVE_EFFORT_VALUES = ["low", "medium", "high", "max"] as const

type ClaudeReasoningEffort = (typeof CLAUDE_ADAPTIVE_EFFORT_VALUES)[number]

type ClaudeMcpServer = {
  type: "url"
  name: string
  url: string
}

type ClaudeAdaptiveThinkingConfig = {
  type: "adaptive"
  effort: ClaudeReasoningEffort
}

type ClaudeMessageResponse = {
  content?: ClaudeContentBlock[]
}

type ClaudeContentBlock = {
  type?: string
  id?: string
  tool_use_id?: string
  name?: string
  server_name?: string
  input?: unknown
  content?: unknown
  text?: string
  is_error?: boolean
}

export function createClaudePromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? CLAUDE_DEFAULT_BASE_URL)
  const apiKey = options.apiKey?.trim()
  const modelName = options.model?.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  const mcpServerUrl = options.mcpServerUrl?.trim()
  const mcpServerLabel = options.mcpServerLabel?.trim() || "mtg-auto-goldfish"
  const maxOutputTokens =
    options.maxOutputTokens ?? CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS
  const reasoningEffort = options.reasoningEffort?.trim()
  const thinking = modelName
    ? buildAdaptiveThinkingConfig(modelName, reasoningEffort)
    : undefined

  async function runPrompt(
    prompt: string,
    onEvent?: (event: PromptStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<PromptProcessingResult> {
    if (!apiKey) {
      throw new Error("CLAUDE_API_KEY is required when LLM_PROVIDER=claude.")
    }

    if (!modelName) {
      throw new Error("CLAUDE_MODEL is required when LLM_PROVIDER=claude.")
    }

    const selectedModel = createConfiguredModel("claude", modelName)

    onEvent?.({
      type: "start",
      model: selectedModel,
    })

    const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
      signal,
      CLAUDE_PROMPT_TIMEOUT_MS
    )

    try {
      const response = await requestJson<ClaudeMessageResponse>(
        fetchImpl,
        `${baseUrl}/messages`,
        {
          method: "POST",
          headers: buildHeaders(apiKey),
          signal: timeoutSignal,
          body: JSON.stringify({
            model: modelName,
            max_tokens: maxOutputTokens,
            thinking,
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
            mcp_servers: buildMcpServers({
              mcpServerLabel,
              mcpServerUrl,
            }),
          }),
        }
      )

      const messageText = extractClaudeMessageText(response.content)

      emitClaudeStreamEvents(response.content, onEvent)

      if (!messageText) {
        throw new Error("Claude returned no message content for this prompt.")
      }

      onEvent?.({
        type: "done",
        result: messageText,
        reasoning: "",
        model: selectedModel,
      })

      return {
        result: messageText,
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

function buildAdaptiveThinkingConfig(
  _modelName: string,
  reasoningEffort: string | undefined
): ClaudeAdaptiveThinkingConfig | undefined {
  if (!reasoningEffort) {
    return undefined
  }

  const normalizedEffort = reasoningEffort.trim().toLowerCase()

  if (!isClaudeReasoningEffort(normalizedEffort)) {
    throw new Error(
      `Unsupported CLAUDE_REASONING_EFFORT value: ${reasoningEffort}. Expected low, medium, high, or max.`
    )
  }

  return {
    type: "adaptive",
    effort: normalizedEffort,
  }
}

function isClaudeReasoningEffort(value: string): value is ClaudeReasoningEffort {
  return (CLAUDE_ADAPTIVE_EFFORT_VALUES as readonly string[]).includes(value)
}

function buildMcpServers(options: {
  mcpServerLabel: string
  mcpServerUrl?: string
}): ClaudeMcpServer[] | undefined {
  if (!options.mcpServerUrl) {
    return undefined
  }

  return [
    {
      type: "url",
      name: options.mcpServerLabel,
      url: options.mcpServerUrl,
    },
  ]
}

function emitClaudeStreamEvents(
  content: ClaudeContentBlock[] | undefined,
  onEvent?: (event: PromptStreamEvent) => void
) {
  if (!onEvent) {
    return
  }

  const toolUseState = new Map<
    string,
    {
      tool?: string
      provider?: string
      argumentsText?: string
    }
  >()
  let hasStartedMessage = false

  for (const block of content ?? []) {
    if (block.type === "mcp_tool_use") {
      const tool = asString(block.name)
      const provider = asString(block.server_name)
      const argumentsText = safeJsonStringify(block.input)

      if (block.id) {
        toolUseState.set(block.id, {
          tool,
          provider,
          argumentsText,
        })
      }

      onEvent({
        type: "tool",
        event: "tool_call.start",
        tool,
        provider,
      })

      if (argumentsText) {
        onEvent({
          type: "tool",
          event: "tool_call.arguments",
          tool,
          provider,
          argumentsText,
        })
      }

      continue
    }

    if (block.type === "mcp_tool_result") {
      const knownToolUse = block.tool_use_id
        ? toolUseState.get(block.tool_use_id)
        : undefined
      const outputText = stringifyClaudeToolResult(block)
      const errorText = block.is_error
        ? outputText ?? "Claude tool call failed."
        : undefined

      onEvent({
        type: "tool",
        event: block.is_error ? "tool_call.failure" : "tool_call.success",
        tool: knownToolUse?.tool,
        provider: knownToolUse?.provider,
        argumentsText: knownToolUse?.argumentsText,
        output: outputText,
        error: errorText,
      })

      continue
    }

    if (block.type === "text" && block.text?.trim()) {
      if (!hasStartedMessage) {
        hasStartedMessage = true
        onEvent({
          type: "status",
          event: "message.start",
        })
      }

      onEvent({
        type: "message",
        delta: block.text,
      })
    }
  }

  if (hasStartedMessage) {
    onEvent({
      type: "status",
      event: "message.end",
    })
  }
}

function extractClaudeMessageText(content: ClaudeContentBlock[] | undefined) {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("")
}

function stringifyClaudeToolResult(block: ClaudeContentBlock) {
  if (typeof block.content === "string") {
    return block.content
  }

  if (Array.isArray(block.content)) {
    const textContent = block.content
      .map((item) => {
        const record = asObjectRecord(item)

        if (record.type === "text") {
          return asString(record.text) ?? ""
        }

        return safeJsonStringify(item) ?? ""
      })
      .filter(Boolean)
      .join("\n")

    if (textContent) {
      return textContent
    }
  }

  return safeJsonStringify(block.content)
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
    "x-api-key": apiKey,
    "anthropic-version": CLAUDE_API_VERSION,
    "anthropic-beta": CLAUDE_MCP_BETA_HEADER,
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
    `Claude prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
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
      return createPromptTimeoutError(CLAUDE_PROMPT_TIMEOUT_MS)
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
    throw new Error(await buildErrorMessage(response, "Claude"))
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



