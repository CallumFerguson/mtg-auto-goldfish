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

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const GEMINI_PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const GEMINI_MAX_TOOL_ROUNDS = 100
const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const
const UNSUPPORTED_GEMINI_SCHEMA_KEYS = new Set([
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

type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number]

type GeminiContent = {
  role?: string
  parts?: GeminiPart[]
}

type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: {
    name?: string
    args?: unknown
  }
  functionResponse?: {
    name?: string
    response?: unknown
  }
  [key: string]: unknown
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: GeminiContent
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parameters?: {
    type: "object"
    properties?: Record<string, object>
    required?: string[]
  }
}

type GeminiToolCall = {
  name: string
  args: Record<string, unknown>
}

type GeminiRoundResult = {
  modelContent: GeminiContent
  toolCalls: GeminiToolCall[]
  usage?: PromptTokenUsage
  messageText: string
  reasoningText: string
  sawReasoning: boolean
  sawMessage: boolean
}

type NormalizedToolResult = {
  content: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
}

export function createGeminiPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? GEMINI_DEFAULT_BASE_URL)
  const apiKey = options.apiKey?.trim()
  const modelName = options.model?.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  const mcpServerUrl = options.mcpServerUrl?.trim()
  const maxOutputTokens = options.maxOutputTokens
  const thinkingLevel = normalizeThinkingLevel(options.reasoningEffort)

  async function runPrompt(
    prompt: string,
    onEvent?: (event: PromptStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<PromptProcessingResult> {
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini.")
    }

    if (!modelName) {
      throw new Error("GEMINI_MODEL is required when LLM_PROVIDER=gemini.")
    }

    const selectedModel = createConfiguredModel("gemini", modelName)

    onEvent?.({
      type: "start",
      model: selectedModel,
    })

    const startedAt = Date.now()
    const { signal: timeoutSignal, cleanup } = createTimeoutSignal(
      signal,
      GEMINI_PROMPT_TIMEOUT_MS
    )

    const mcpClient = mcpServerUrl
      ? await createMcpClient(mcpServerUrl, fetchImpl)
      : undefined

    try {
      const toolDeclarations = mcpClient
        ? await loadToolDeclarations(mcpClient)
        : undefined

      const contents: GeminiContent[] = [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ]

      let finalText = ""
      let finalReasoning = ""
      let usage: PromptTokenUsage | undefined
      let messageStarted = false
      let reasoningStarted = false

      for (let roundIndex = 0; roundIndex < GEMINI_MAX_TOOL_ROUNDS; roundIndex += 1) {
        const roundResult = await streamGeminiRound({
          apiKey,
          baseUrl,
          fetchImpl,
          modelName,
          contents,
          toolDeclarations,
          maxOutputTokens,
          thinkingLevel,
          signal: timeoutSignal,
          onPart(part) {
            if (!part.text) {
              return
            }

            if (part.thought) {
              if (!reasoningStarted) {
                reasoningStarted = true
                onEvent?.({
                  type: "status",
                  event: "reasoning.start",
                })
              }

              finalReasoning += part.text
              onEvent?.({
                type: "reasoning",
                delta: part.text,
              })
              return
            }

            if (!messageStarted) {
              messageStarted = true
              onEvent?.({
                type: "status",
                event: "message.start",
              })
            }

            finalText += part.text
            onEvent?.({
              type: "message",
              delta: part.text,
            })
          },
        })

        usage = roundResult.usage ?? usage
        contents.push(roundResult.modelContent)

        if (roundResult.toolCalls.length === 0) {
          break
        }

        if (!mcpClient) {
          throw new Error(
            "Gemini requested tool calls, but no MCP server URL was configured."
          )
        }

        const functionResponses: GeminiPart[] = []

        for (const toolCall of roundResult.toolCalls) {
          onEvent?.({
            type: "tool",
            event: "tool_call.start",
            tool: toolCall.name,
            provider: "mcp",
          })

          const argumentsText = safeJsonStringify(toolCall.args)

          if (argumentsText) {
            onEvent?.({
              type: "tool",
              event: "tool_call.arguments",
              tool: toolCall.name,
              provider: "mcp",
              argumentsText,
            })
          }

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
              argumentsText,
              output,
            })

            functionResponses.push({
              functionResponse: {
                name: toolCall.name,
                response: buildFunctionResponse(normalizedToolResult),
              },
            })
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Gemini tool call failed."

            onEvent?.({
              type: "tool",
              event: "tool_call.failure",
              tool: toolCall.name,
              provider: "mcp",
              argumentsText,
              error: message,
            })

            functionResponses.push({
              functionResponse: {
                name: toolCall.name,
                response: {
                  isError: true,
                  error: message,
                },
              },
            })
          }
        }

        contents.push({
          role: "user",
          parts: functionResponses,
        })
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

      if (!finalText.trim()) {
        throw new Error("Gemini returned no message content for this prompt.")
      }

      onEvent?.({
        type: "done",
        result: finalText.trim(),
        reasoning: finalReasoning.trim(),
        model: selectedModel,
      })

      return {
        result: finalText.trim(),
        provider: "gemini",
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

async function streamGeminiRound(options: {
  apiKey: string
  baseUrl: string
  fetchImpl: typeof fetch
  modelName: string
  contents: GeminiContent[]
  toolDeclarations?: GeminiFunctionDeclaration[]
  maxOutputTokens?: number
  thinkingLevel?: GeminiThinkingLevel
  signal?: AbortSignal
  onPart?: (part: GeminiPart) => void
}): Promise<GeminiRoundResult> {
  const response = await options.fetchImpl(
    `${options.baseUrl}/models/${encodeURIComponent(options.modelName)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: buildHeaders(options.apiKey),
      signal: options.signal,
      body: JSON.stringify({
        contents: options.contents,
        tools:
          options.toolDeclarations && options.toolDeclarations.length > 0
            ? [
                {
                  functionDeclarations: options.toolDeclarations,
                },
              ]
            : undefined,
        generationConfig: {
          maxOutputTokens: options.maxOutputTokens,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: options.thinkingLevel,
          },
        },
      }),
    }
  )

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response))
  }

  if (!response.body) {
    throw new Error("Gemini returned no stream body for this prompt.")
  }

  const modelParts: GeminiPart[] = []
  let usage: PromptTokenUsage | undefined

  await consumeSseStream(response, (chunk) => {
    usage = extractGeminiUsage(chunk.usageMetadata) ?? usage

    const parts = chunk.candidates?.[0]?.content?.parts ?? []

    for (const rawPart of parts) {
      const part = normalizeGeminiPart(rawPart)
      modelParts.push(part)
      options.onPart?.(part)
    }
  }, options.signal)

  const modelContent: GeminiContent = {
    role: "model",
    parts: modelParts,
  }

  return {
    modelContent,
    toolCalls: extractToolCalls(modelParts),
    usage,
    messageText: extractVisibleMessageText(modelParts),
    reasoningText: extractReasoningText(modelParts),
    sawReasoning: modelParts.some((part) => Boolean(part.thought) && Boolean(part.text)),
    sawMessage: modelParts.some((part) => !part.thought && Boolean(part.text)),
  }
}

async function createMcpClient(mcpServerUrl: string, fetchImpl: typeof fetch) {
  const client = new Client({
    name: "mtg-auto-goldfish-gemini-bridge",
    version: "0.0.1",
  })
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl), {
    fetch: fetchImpl,
  })

  await client.connect(transport)

  return client
}

async function loadToolDeclarations(client: Client) {
  const response = await client.listTools()

  return response.tools.map(
    (tool): GeminiFunctionDeclaration => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiSchema({
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      }),
    })
  )
}

function sanitizeGeminiSchema(value: unknown): GeminiFunctionDeclaration["parameters"] {
  const sanitizedValue = sanitizeGeminiSchemaValue(value)
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

function sanitizeGeminiSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchemaValue(item))
  }

  if (!isPlainObject(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSUPPORTED_GEMINI_SCHEMA_KEYS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeGeminiSchemaValue(nestedValue)])
  )
}
function normalizeThinkingLevel(value: string | undefined): GeminiThinkingLevel | undefined {
  if (!value?.trim()) {
    return undefined
  }

  const normalizedValue = value.trim().toLowerCase()

  if (isGeminiThinkingLevel(normalizedValue)) {
    return normalizedValue
  }

  throw new Error(
    `Unsupported GEMINI_THINKING_LEVEL value: ${value}. Expected minimal, low, medium, or high.`
  )
}

function isGeminiThinkingLevel(value: string): value is GeminiThinkingLevel {
  return (GEMINI_THINKING_LEVELS as readonly string[]).includes(value)
}

function normalizeGeminiPart(value: unknown): GeminiPart {
  const record = asObjectRecord(value)

  return {
    ...record,
    text: typeof record.text === "string" ? record.text : undefined,
    thought: typeof record.thought === "boolean" ? record.thought : undefined,
    thoughtSignature:
      typeof record.thoughtSignature === "string"
        ? record.thoughtSignature
        : undefined,
    functionCall: record.functionCall
      ? {
          ...asObjectRecord(record.functionCall),
          name:
            typeof asObjectRecord(record.functionCall).name === "string"
              ? (asObjectRecord(record.functionCall).name as string)
              : undefined,
          args: asObjectRecord(record.functionCall).args,
        }
      : undefined,
    functionResponse: record.functionResponse
      ? {
          ...asObjectRecord(record.functionResponse),
          name:
            typeof asObjectRecord(record.functionResponse).name === "string"
              ? (asObjectRecord(record.functionResponse).name as string)
              : undefined,
          response: asObjectRecord(record.functionResponse).response,
        }
      : undefined,
  }
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

function buildFunctionResponse(toolResult: NormalizedToolResult) {
  return {
    isError: Boolean(toolResult.isError),
    structuredContent: normalizeJsonValue(toolResult.structuredContent),
    content: toolResult.content.map((item) => normalizeJsonValue(item)),
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

  return safeJsonStringify(buildFunctionResponse(toolResult))
}

function extractToolCalls(parts: GeminiPart[]): GeminiToolCall[] {
  return parts
    .map((part) => part.functionCall)
    .filter(Boolean)
    .flatMap((functionCall) => {
      const name = functionCall?.name?.trim()

      if (!name) {
        return []
      }

      return [
        {
          name,
          args: asObjectRecord(functionCall?.args),
        },
      ]
    })
}

function extractVisibleMessageText(parts: GeminiPart[]) {
  return parts
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

function extractReasoningText(parts: GeminiPart[]) {
  return parts
    .filter((part) => part.thought && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

function extractGeminiUsage(
  usage: GeminiGenerateContentResponse["usageMetadata"]
): PromptTokenUsage | undefined {
  if (!usage) {
    return undefined
  }

  const normalizedUsage = {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    totalTokens: usage.totalTokenCount,
  }

  return Object.values(normalizedUsage).some((value) => typeof value === "number")
    ? normalizedUsage
    : undefined
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
    "x-goog-api-key": apiKey,
  })
}

async function consumeSseStream(
  response: Response,
  onChunk: (chunk: GeminiGenerateContentResponse) => void,
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
  onChunk: (chunk: GeminiGenerateContentResponse) => void
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

  onChunk(JSON.parse(payloadText) as GeminiGenerateContentResponse)
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
    `Gemini prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
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
      return createPromptTimeoutError(GEMINI_PROMPT_TIMEOUT_MS)
    }
  }

  return error
}

async function buildErrorMessage(response: Response) {
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
        `Gemini request failed with ${response.status}.`
      )
    }
  }

  const bodyText = (await response.text()).trim()

  if (bodyText) {
    return bodyText
  }

  return `Gemini request failed with ${response.status}.`
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        normalizeJsonValue(nestedValue),
      ])
    )
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }

  return safeJsonStringify(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
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





