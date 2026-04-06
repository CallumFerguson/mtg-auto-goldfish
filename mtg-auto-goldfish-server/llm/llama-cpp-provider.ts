import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptStreamEvent,
  PromptTokenUsage,
} from "./index.js"

export const LLAMA_CPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1"
const LLAMA_CPP_PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const LLAMA_CPP_MAX_TOOL_ROUNDS = 100
const UNSUPPORTED_TOOL_SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "unevaluatedProperties",
  "propertyNames",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
])

type LlamaCppToolDefinition = {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: {
      type: "object"
      properties?: Record<string, object>
      required?: string[]
    }
  }
}

type LlamaCppMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_calls?: LlamaCppToolCall[]
  tool_call_id?: string
}

type LlamaCppToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type LlamaCppChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

type LlamaCppModelsResponse = {
  data?: Array<{
    id?: string
  }>
}

type LlamaCppPropsResponse = {
  model_path?: string
  model_alias?: string
}

type LlamaCppRoundResult = {
  assistantMessage: LlamaCppMessage
  toolCalls: Array<{
    id: string
    name: string
    args: Record<string, unknown>
    argumentsText: string
  }>
  reasoningText: string
  usage?: PromptTokenUsage
}

type NormalizedToolResult = {
  content: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
}

export function createLlamaCppPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? LLAMA_CPP_DEFAULT_BASE_URL)
  const apiKey = options.apiKey?.trim() || options.apiToken?.trim() || undefined
  const fetchImpl = options.fetchImpl ?? fetch
  const mcpServerUrl = options.mcpServerUrl?.trim()
  const maxOutputTokens = options.maxOutputTokens

  async function runPrompt(
    prompt: string,
    onEvent?: (event: PromptStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<PromptProcessingResult> {
    const selectedModel = await discoverLoadedModel({
      baseUrl,
      apiKey,
      fetchImpl,
      signal,
    })

    onEvent?.({
      type: "start",
      model: selectedModel,
    })

    const startedAt = Date.now()
    const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
      signal,
      LLAMA_CPP_PROMPT_TIMEOUT_MS
    )

    const mcpClient = mcpServerUrl
      ? await createMcpClient(mcpServerUrl, fetchImpl)
      : undefined

    try {
      const tools = mcpClient ? await loadToolDefinitions(mcpClient) : undefined
      const messages: LlamaCppMessage[] = [
        {
          role: "user",
          content: prompt,
        },
      ]

      let finalText = ""
      let finalReasoning = ""
      let usage: PromptTokenUsage | undefined
      let completed = false
      let reasoningStarted = false
      let messageStarted = false

      for (let roundIndex = 0; roundIndex < LLAMA_CPP_MAX_TOOL_ROUNDS; roundIndex += 1) {
        const roundResult = await streamLlamaCppRound({
          apiKey,
          baseUrl,
          fetchImpl,
          modelName: selectedModel.key,
          messages,
          tools,
          maxOutputTokens,
          signal: timeoutSignal,
          onReasoningDelta(delta) {
            if (!reasoningStarted) {
              reasoningStarted = true
              onEvent?.({
                type: "status",
                event: "reasoning.start",
              })
            }

            finalReasoning += delta
            onEvent?.({
              type: "reasoning",
              delta,
            })
          },
          onTextDelta(delta) {
            if (!messageStarted) {
              messageStarted = true
              onEvent?.({
                type: "status",
                event: "message.start",
              })
            }

            finalText += delta
            onEvent?.({
              type: "message",
              delta,
            })
          },
        })

        usage = roundResult.usage ?? usage
        messages.push(roundResult.assistantMessage)
        finalReasoning = finalReasoning || roundResult.reasoningText

        if (roundResult.toolCalls.length === 0) {
          completed = true
          break
        }

        if (!mcpClient) {
          throw new Error(
            "llama.cpp requested tool calls, but no MCP server URL was configured."
          )
        }

        for (const toolCall of roundResult.toolCalls) {
          onEvent?.({
            type: "tool",
            event: "tool_call.start",
            tool: toolCall.name,
            provider: "mcp",
          })

          onEvent?.({
            type: "tool",
            event: "tool_call.arguments",
            tool: toolCall.name,
            provider: "mcp",
            argumentsText: toolCall.argumentsText,
          })

          try {
            const toolResult = await mcpClient.callTool({
              name: toolCall.name,
              arguments: toolCall.args,
            })

            const normalizedToolResult = normalizeMcpToolResult(toolResult)
            const output = stringifyToolResult(normalizedToolResult)

            onEvent?.({
              type: "tool",
              event: "tool_call.success",
              tool: toolCall.name,
              provider: "mcp",
              argumentsText: toolCall.argumentsText,
              output,
            })

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: output ?? "",
            })
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "llama.cpp tool call failed."

            onEvent?.({
              type: "tool",
              event: "tool_call.failure",
              tool: toolCall.name,
              provider: "mcp",
              argumentsText: toolCall.argumentsText,
              error: message,
            })

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: safeJsonStringify({
                isError: true,
                error: message,
              }),
            })
          }
        }
      }

      if (!completed) {
        throw new Error("llama.cpp did not finish after the maximum number of tool rounds.")
      }

      const trimmedResult = finalText.trim()

      if (!trimmedResult) {
        throw new Error("llama.cpp returned no message content for this prompt.")
      }

      if (reasoningStarted) {
        onEvent?.({
          type: "status",
          event: "reasoning.end",
        })
      }

      if (messageStarted) {
        onEvent?.({
          type: "status",
          event: "message.end",
        })
      }

      onEvent?.({
        type: "done",
        result: trimmedResult,
        reasoning: finalReasoning.trim(),
        model: selectedModel,
      })

      return {
        result: trimmedResult,
        provider: "llama.cpp",
        model: selectedModel,
        usage,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      throw normalizePromptAbortError(error)
    } finally {
      cleanup()

      if (mcpClient) {
        await mcpClient.close()
      }
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

async function discoverLoadedModel(options: {
  baseUrl: string
  apiKey?: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}): Promise<LoadedTextModel> {
  const modelFromProps = await getModelFromProps(options)

  if (modelFromProps) {
    return createConfiguredModel("llama.cpp", modelFromProps)
  }

  const modelFromModelsEndpoint = await getModelFromModelsEndpoint(options)

  if (modelFromModelsEndpoint) {
    return createConfiguredModel("llama.cpp", modelFromModelsEndpoint)
  }

  throw new Error(
    "Unable to determine the loaded llama.cpp model from /props or /v1/models."
  )
}

async function getModelFromProps(options: {
  baseUrl: string
  apiKey?: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}) {
  const serverBaseUrl = getServerBaseUrl(options.baseUrl)
  const response = await requestJson<LlamaCppPropsResponse>(
    options.fetchImpl,
    `${serverBaseUrl}/props`,
    {
      method: "GET",
      headers: buildHeaders(options.apiKey, false),
      signal: options.signal,
    }
  ).catch(() => undefined)

  if (!response) {
    return undefined
  }

  const alias = response.model_alias?.trim()

  if (alias) {
    return alias
  }

  const modelPath = response.model_path?.trim()

  if (!modelPath) {
    return undefined
  }

  return extractFileName(modelPath)
}

async function getModelFromModelsEndpoint(options: {
  baseUrl: string
  apiKey?: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}) {
  const response = await requestJson<LlamaCppModelsResponse>(
    options.fetchImpl,
    `${options.baseUrl}/models`,
    {
      method: "GET",
      headers: buildHeaders(options.apiKey, false),
      signal: options.signal,
    }
  ).catch(() => undefined)

  const firstModelId = response?.data?.find((model) => typeof model.id === "string")?.id?.trim()

  return firstModelId || undefined
}

async function streamLlamaCppRound(options: {
  apiKey?: string
  baseUrl: string
  fetchImpl: typeof fetch
  modelName: string
  messages: LlamaCppMessage[]
  tools?: LlamaCppToolDefinition[]
  maxOutputTokens?: number
  signal?: AbortSignal
  onReasoningDelta?: (delta: string) => void
  onTextDelta?: (delta: string) => void
}): Promise<LlamaCppRoundResult> {
  const response = await options.fetchImpl(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(options.apiKey),
    signal: options.signal,
    body: JSON.stringify({
      model: options.modelName,
      messages: options.messages,
      tools: options.tools?.length ? options.tools : undefined,
      tool_choice: options.tools?.length ? "auto" : undefined,
      max_tokens: options.maxOutputTokens,
      stream: true,
    }),
  })

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response, "llama.cpp"))
  }

  if (!response.body) {
    throw new Error("llama.cpp returned no stream body for this prompt.")
  }

  const toolCallsByIndex = new Map<number, LlamaCppToolCall>()
  let messageText = ""
  let reasoningText = ""
  let usage: PromptTokenUsage | undefined

  await consumeSseStream(
    response,
    (chunk) => {
      usage = extractUsage(chunk.usage) ?? usage

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        if (!delta) {
          continue
        }

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          reasoningText += delta.reasoning_content
          options.onReasoningDelta?.(delta.reasoning_content)
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          messageText += delta.content
          options.onTextDelta?.(delta.content)
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          const index = toolCallDelta.index ?? 0
          const existingToolCall = toolCallsByIndex.get(index) ?? {
            id: toolCallDelta.id?.trim() || `llama-cpp-tool-${index}`,
            type: "function" as const,
            function: {
              name: "",
              arguments: "",
            },
          }

          if (toolCallDelta.id?.trim()) {
            existingToolCall.id = toolCallDelta.id.trim()
          }

          if (typeof toolCallDelta.function?.name === "string") {
            existingToolCall.function.name += toolCallDelta.function.name
          }

          if (typeof toolCallDelta.function?.arguments === "string") {
            existingToolCall.function.arguments += toolCallDelta.function.arguments
          }

          toolCallsByIndex.set(index, existingToolCall)
        }
      }
    },
    options.signal
  )

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall]) => normalizeToolCall(toolCall))
    .filter((toolCall): toolCall is NonNullable<typeof toolCall> => Boolean(toolCall))

  return {
    assistantMessage: {
      role: "assistant",
      content: messageText || null,
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsText,
        },
      })),
    },
    toolCalls,
    reasoningText,
    usage,
  }
}

function normalizeToolCall(toolCall: LlamaCppToolCall) {
  const name = toolCall.function.name.trim()
  const argumentsText = toolCall.function.arguments.trim()

  if (!name) {
    return undefined
  }

  return {
    id: toolCall.id,
    name,
    args: parseToolArguments(argumentsText),
    argumentsText,
  }
}

function parseToolArguments(argumentsText: string) {
  if (!argumentsText) {
    return {}
  }

  try {
    const parsedValue = JSON.parse(argumentsText)
    return asObjectRecord(parsedValue)
  } catch (error) {
    const suffix = error instanceof Error ? ` ${error.message}` : ""
    throw new Error(`llama.cpp returned invalid tool arguments for a tool call.${suffix}`)
  }
}

async function createMcpClient(mcpServerUrl: string, fetchImpl: typeof fetch) {
  const client = new Client({
    name: "mtg-auto-goldfish-llama-cpp-bridge",
    version: "0.0.1",
  })
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl), {
    fetch: fetchImpl,
  })

  await client.connect(transport)

  return client
}

async function loadToolDefinitions(client: Client) {
  const response = await client.listTools()

  return response.tools.map(
    (tool): LlamaCppToolDefinition => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeToolSchema({
          type: "object",
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        }),
      },
    })
  )
}

function sanitizeToolSchema(value: unknown): LlamaCppToolDefinition["function"]["parameters"] {
  const sanitizedValue = sanitizeToolSchemaValue(value)
  const schema = asObjectRecord(sanitizedValue)

  return {
    type: "object",
    properties: isPlainObject(schema.properties)
      ? (schema.properties as Record<string, object>)
      : undefined,
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : undefined,
  }
}

function sanitizeToolSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolSchemaValue(item))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !UNSUPPORTED_TOOL_SCHEMA_KEYS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeToolSchemaValue(nestedValue)])
  )
}

function normalizeMcpToolResult(toolResult: unknown): NormalizedToolResult {
  const record = asObjectRecord(toolResult)
  const compatibilityRecord = asObjectRecord(record.toolResult)
  const resultRecord = Array.isArray(record.content) ? record : compatibilityRecord

  return {
    content: Array.isArray(resultRecord.content)
      ? resultRecord.content.map((item) => asObjectRecord(item))
      : [],
    structuredContent: resultRecord.structuredContent,
    isError:
      typeof resultRecord.isError === "boolean"
        ? resultRecord.isError
        : undefined,
  }
}

function stringifyToolResult(toolResult: NormalizedToolResult) {
  const textContent = toolResult.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n\n")
    .trim()

  if (textContent) {
    return textContent
  }

  return safeJsonStringify({
    isError: Boolean(toolResult.isError),
    structuredContent: normalizeJsonValue(toolResult.structuredContent),
    content: toolResult.content.map((item) => normalizeJsonValue(item)),
  })
}

function extractUsage(
  usage: LlamaCppChatCompletionChunk["usage"]
): PromptTokenUsage | undefined {
  if (!usage) {
    return undefined
  }

  const normalizedUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }

  return Object.values(normalizedUsage).some((value) => typeof value === "number")
    ? normalizedUsage
    : undefined
}

function createConfiguredModel(provider: string, modelName: string): LoadedTextModel {
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

function getServerBaseUrl(baseUrl: string) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "")
}

function extractFileName(path: string) {
  const normalizedPath = path.replace(/\\/g, "/")
  const segments = normalizedPath.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function buildHeaders(apiKey: string | undefined, acceptSse = true) {
  const headers = new Headers({
    "Content-Type": "application/json",
  })

  if (acceptSse) {
    headers.set("Accept", "text/event-stream")
  }

  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`)
  }

  return headers
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(input, init)

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response, "llama.cpp"))
  }

  return (await response.json()) as T
}

async function consumeSseStream(
  response: Response,
  onChunk: (chunk: LlamaCppChatCompletionChunk) => void,
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
      emitSseEvent(rawEvent, onChunk)
      boundaryIndex = buffer.indexOf("\n\n")
    }
  }

  buffer += decoder.decode()

  if (buffer.trim()) {
    emitSseEvent(buffer, onChunk)
  }
}

function emitSseEvent(
  rawEvent: string,
  onChunk: (chunk: LlamaCppChatCompletionChunk) => void
) {
  const dataLines = rawEvent
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())

  if (!dataLines.length) {
    return
  }

  const payloadText = dataLines.join("\n")

  if (payloadText === "[DONE]") {
    return
  }

  onChunk(JSON.parse(payloadText) as LlamaCppChatCompletionChunk)
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
    `llama.cpp prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
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
      return createPromptTimeoutError(LLAMA_CPP_PROMPT_TIMEOUT_MS)
    }
  }

  return error
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

function isPlainObject(value: unknown) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record).map(([key, nestedValue]) => [key, normalizeJsonValue(nestedValue)])
  )
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
