import type { LlmChunkKind, LlmRunChunkInput } from "./simulations-postgres.js"

export class ProviderTerminalEventError extends Error {
  readonly eventType: string | null
  readonly payload: unknown

  constructor(
    eventType: string | null,
    payload: unknown,
    providerName = "OpenAI"
  ) {
    super(getProviderTerminalFailureMessage(eventType, payload, providerName))
    this.name = "ProviderTerminalEventError"
    this.eventType = eventType
    this.payload = payload
  }
}

export type OpenRouterToolCallNameMap = Map<string, string>

export function normalizeOpenAiStreamEvent(
  event: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  const eventRecord = asRecord(event)
  const eventType = getStringProperty(eventRecord, "type")
  const rawOutputItemKind = getNestedStringProperty(eventRecord, "item", "type")
  const payload = event ?? {}

  if (eventType === "response.output_text.delta") {
    const delta = getStringProperty(eventRecord, "delta")

    return createChunk("message_delta", {
      outputDelta: delta,
      payload,
    })
  }

  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = getStringProperty(eventRecord, "delta")

    return createChunk("reasoning_delta", {
      reasoningDelta: delta,
      payload,
    })
  }

  if (eventType === "response.completed") {
    return createChunk("completed", {
      payload,
    })
  }

  const lifecycleChunkKind = getOutputItemLifecycleChunkKind(
    eventType,
    rawOutputItemKind
  )

  if (lifecycleChunkKind) {
    return createChunk(lifecycleChunkKind, {
      payload,
    })
  }

  if (
    eventType === "response.output_item.added" &&
    rawOutputItemKind === "mcp_call"
  ) {
    const mcpFunctionName = getNestedStringProperty(eventRecord, "item", "name")

    return createChunk("mcp_call_start", {
      mcpFunctionName,
      payload,
    })
  }

  if (
    eventType === "response.output_item.done" &&
    rawOutputItemKind === "mcp_call"
  ) {
    const mcpFunctionName = getNestedStringProperty(eventRecord, "item", "name")
    const mcpFunctionOutput = getMcpFunctionOutput(eventRecord)

    return createChunk("mcp_call_complete", {
      mcpFunctionName,
      mcpFunctionOutput,
      payload,
    })
  }

  if (isProviderTerminalEvent(eventType)) {
    return createChunk("error", {
      payload,
    })
  }

  return createChunk("raw_event", {
    payload,
  })
}

export function isProviderTerminalEvent(eventType: string | null) {
  return (
    eventType === "error" ||
    eventType === "response.failed" ||
    eventType === "response.incomplete" ||
    Boolean(eventType?.endsWith(".failed"))
  )
}

export function normalizeOpenRouterStreamEvent(
  event: unknown,
  toolCallNamesById: OpenRouterToolCallNameMap = new Map()
): Omit<LlmRunChunkInput, "sequence"> {
  const eventRecord = asRecord(event)
  const eventType = getStringProperty(eventRecord, "type")
  const rawOutputItemKind = getNestedStringProperty(eventRecord, "item", "type")
  const payload = event ?? {}

  if (eventType === "response.output_text.delta") {
    return createChunk("message_delta", {
      outputDelta: getStringProperty(eventRecord, "delta"),
      payload,
    })
  }

  if (
    eventType === "response.reasoning_summary_text.delta" ||
    eventType === "response.reasoning_text.delta"
  ) {
    return createChunk("reasoning_delta", {
      reasoningDelta: getStringProperty(eventRecord, "delta"),
      payload,
    })
  }

  if (eventType === "response.completed") {
    return createChunk("completed", {
      payload,
    })
  }

  const lifecycleChunkKind = getOutputItemLifecycleChunkKind(
    eventType,
    rawOutputItemKind
  )

  if (lifecycleChunkKind) {
    return createChunk(lifecycleChunkKind, {
      payload,
    })
  }

  if (
    eventType === "response.output_item.added" &&
    rawOutputItemKind === "function_call"
  ) {
    const itemRecord = asRecord(eventRecord.item)
    const functionName = rememberOpenRouterToolCallName(
      toolCallNamesById,
      itemRecord
    )

    return createChunk("mcp_call_start", {
      mcpFunctionName: functionName,
      payload,
    })
  }

  if (eventType === "response.function_call_arguments.done") {
    const itemId = getStringProperty(eventRecord, "itemId")
    const functionName = getStringProperty(eventRecord, "name")

    if (itemId && functionName) {
      toolCallNamesById.set(itemId, functionName)
    }

    return createChunk("raw_event", {
      payload,
    })
  }

  if (eventType === "tool.result") {
    const toolCallId = getStringProperty(eventRecord, "toolCallId")
    const functionName =
      (toolCallId ? toolCallNamesById.get(toolCallId) : null) ?? null

    return createChunk("mcp_call_complete", {
      mcpFunctionName: functionName,
      mcpFunctionOutput: eventRecord.result ?? null,
      payload,
    })
  }

  if (isProviderTerminalEvent(eventType)) {
    return createChunk("error", {
      payload,
    })
  }

  return createChunk("raw_event", {
    payload,
  })
}

export function getOpenRouterGenerationIdFromCompletedEvent(event: unknown) {
  const eventRecord = asRecord(event)

  if (getStringProperty(eventRecord, "type") !== "response.completed") {
    return null
  }

  const generationId = getStringProperty(asRecord(eventRecord.response), "id")

  return generationId?.trim() || null
}

export function createServerErrorChunk(
  error: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("error", {
    payload: {
      message: getErrorMessage(error),
      name: error instanceof Error ? error.name : null,
    },
  })
}

export function createCancellationChunk(
  message = "Opening-hand LLM run was cancelled."
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("cancelled", {
    payload: {
      message,
    },
  })
}

export function createLlamaCppMessageDeltaChunk(
  outputDelta: string,
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("message_delta", {
    outputDelta,
    payload,
  })
}

export function createLlamaCppOutputStartChunk(
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("output_start", {
    payload,
  })
}

export function createLlamaCppOutputDoneChunk(
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("output_done", {
    payload,
  })
}

export function createLlamaCppReasoningStartChunk(
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("reasoning_start", {
    payload,
  })
}

export function createLlamaCppReasoningDoneChunk(
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("reasoning_done", {
    payload,
  })
}

export function createLlamaCppReasoningDeltaChunk(
  reasoningDelta: string,
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("reasoning_delta", {
    reasoningDelta,
    payload,
  })
}

export function createLlamaCppCompletedChunk(
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("completed", {
    payload,
  })
}

export function createFinalParsedOutputChunk(
  parsedOutput: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("final_parsed_output", {
    payload: parsedOutput,
  })
}

export function createLlamaCppToolCallStartChunk(
  mcpFunctionName: string | null,
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("mcp_call_start", {
    mcpFunctionName,
    payload,
  })
}

export function createLlamaCppToolCallCompleteChunk(
  mcpFunctionName: string | null,
  mcpFunctionOutput: unknown,
  payload: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("mcp_call_complete", {
    mcpFunctionName,
    mcpFunctionOutput,
    payload,
  })
}

export function parseOpeningHandFromResponseText(responseText: string) {
  const parsedCompletion =
    parseOpeningHandCompletionFromResponseText(responseText)

  return {
    keptHand: parsedCompletion.keptHand,
  }
}

export function parseOpeningHandCompletionFromResponseText(
  responseText: string
) {
  if (!responseText.trim()) {
    throw new Error("Opening-hand LLM completed response was empty.")
  }

  let parsedResponse: unknown

  try {
    parsedResponse = parseJsonWithLastObjectFallback(responseText)
  } catch (error) {
    throw new Error("Opening-hand LLM completed response was not valid JSON.", {
      cause: error,
    })
  }

  const responseRecord = asRecord(parsedResponse)
  const keptHand = responseRecord.keptHand

  if (
    !Array.isArray(keptHand) ||
    keptHand.some((card) => typeof card !== "string")
  ) {
    throw new Error("Opening-hand LLM response did not include keptHand.")
  }

  return {
    keptHand,
    parsedOutput: responseRecord,
  }
}

export function parseTurnSimulationFromResponseText(responseText: string) {
  const parsedCompletion =
    parseTurnSimulationCompletionFromResponseText(responseText)

  return {
    gameState: parsedCompletion.gameState,
  }
}

export function parseTurnSimulationCompletionFromResponseText(
  responseText: string
) {
  if (!responseText.trim()) {
    throw new Error("Turn LLM completed response was empty.")
  }

  let parsedResponse: unknown

  try {
    parsedResponse = parseJsonWithLastObjectFallback(responseText)
  } catch (error) {
    throw new Error("Turn LLM completed response was not valid JSON.", {
      cause: error,
    })
  }

  const responseRecord = asRecord(parsedResponse)
  const gameState = getStringProperty(responseRecord, "gameState")?.trim()

  if (!gameState) {
    throw new Error("Turn LLM response did not include gameState.")
  }

  return {
    gameState,
    parsedOutput: responseRecord,
  }
}

function parseJsonWithLastObjectFallback(responseText: string) {
  const trimmedResponseText = responseText.trim()

  try {
    return JSON.parse(trimmedResponseText) as unknown
  } catch (error) {
    const parsedObject = parseLastJsonObject(trimmedResponseText)

    if (parsedObject.found) {
      return parsedObject.value
    }

    throw error
  }
}

function parseLastJsonObject(
  text: string
): { found: true; value: unknown } | { found: false } {
  let lastParsedObject:
    | { end: number; start: number; value: unknown }
    | undefined

  for (
    let start = text.indexOf("{");
    start !== -1;
    start = text.indexOf("{", start + 1)
  ) {
    const end = findJsonObjectEnd(text, start)

    if (end === null) {
      continue
    }

    try {
      const value = JSON.parse(text.slice(start, end)) as unknown

      if (
        lastParsedObject === undefined ||
        end > lastParsedObject.end ||
        (end === lastParsedObject.end && start < lastParsedObject.start)
      ) {
        lastParsedObject = { end, start, value }
      }
    } catch {
      // Keep looking for another balanced object.
    }
  }

  return lastParsedObject === undefined
    ? { found: false }
    : { found: true, value: lastParsedObject.value }
}

function findJsonObjectEnd(text: string, start: number) {
  let objectDepth = 0
  let isInString = false
  let isEscaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (isInString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }

      if (char === "\\") {
        isEscaped = true
        continue
      }

      if (char === '"') {
        isInString = false
      }

      continue
    }

    if (char === '"') {
      isInString = true
      continue
    }

    if (char === "{") {
      objectDepth += 1
      continue
    }

    if (char === "}") {
      objectDepth -= 1

      if (objectDepth === 0) {
        return index + 1
      }
    }
  }

  return null
}

export function getCompletedResponseOutputText(response: unknown) {
  const responseRecord = asRecord(response)
  const topLevelOutputText =
    getStringProperty(responseRecord, "output_text") ??
    getStringProperty(responseRecord, "outputText")

  if (topLevelOutputText) {
    return topLevelOutputText
  }

  const output = responseRecord.output

  if (!Array.isArray(output)) {
    return ""
  }

  const finalAnswerTextParts = output.flatMap((item) => {
    const itemRecord = asRecord(item)

    if (
      itemRecord.type !== "message" ||
      itemRecord.phase !== "final_answer" ||
      !Array.isArray(itemRecord.content)
    ) {
      return []
    }

    return getOutputTextParts(itemRecord.content)
  })

  if (finalAnswerTextParts.length > 0) {
    return finalAnswerTextParts.join("")
  }

  return output
    .flatMap((item) => {
      const itemRecord = asRecord(item)

      if (itemRecord.type !== "message" || !Array.isArray(itemRecord.content)) {
        return []
      }

      return getOutputTextParts(itemRecord.content)
    })
    .join("")
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

export function getStringProperty(
  record: Record<string, unknown>,
  property: string
) {
  const value = record[property]

  return typeof value === "string" ? value : null
}

export function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "APIUserAbortError" ||
      error.name === "AbortError" ||
      error.name === "RequestAbortedError")
  )
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createChunk(
  kind: LlmChunkKind,
  values: {
    mcpFunctionName?: string | null
    mcpFunctionOutput?: unknown | null
    reasoningDelta?: string | null
    outputDelta?: string | null
    payload: unknown
  }
): Omit<LlmRunChunkInput, "sequence"> {
  return {
    kind,
    mcpFunctionName: values.mcpFunctionName ?? null,
    mcpFunctionOutput: values.mcpFunctionOutput ?? null,
    reasoningDelta: values.reasoningDelta ?? null,
    outputDelta: values.outputDelta ?? null,
    payload: values.payload,
  }
}

function getNestedStringProperty(
  record: Record<string, unknown>,
  parentProperty: string,
  childProperty: string
) {
  return getStringProperty(asRecord(record[parentProperty]), childProperty)
}

function getOutputItemLifecycleChunkKind(
  eventType: string | null,
  itemType: string | null
) {
  if (eventType === "response.output_item.added") {
    if (itemType === "reasoning") {
      return "reasoning_start"
    }

    if (itemType === "message") {
      return "output_start"
    }
  }

  if (eventType === "response.output_item.done") {
    if (itemType === "reasoning") {
      return "reasoning_done"
    }

    if (itemType === "message") {
      return "output_done"
    }
  }

  return null
}

function getOutputTextParts(content: unknown[]) {
  return content.flatMap((part) => {
    const partRecord = asRecord(part)

    if (partRecord.type !== "output_text") {
      return []
    }

    const text = getStringProperty(partRecord, "text")

    return text === null ? [] : [text]
  })
}

function parseMcpFunctionOutput(output: string | null) {
  if (output === null || !output.trim()) {
    return output
  }

  try {
    return JSON.parse(output) as unknown
  } catch {
    return output
  }
}

function getMcpFunctionOutput(eventRecord: Record<string, unknown>) {
  const rawOutput = getNestedStringProperty(eventRecord, "item", "output")

  if (rawOutput !== null && rawOutput.trim()) {
    return parseMcpFunctionOutput(rawOutput)
  }

  return getMcpFunctionErrorOutput(asRecord(eventRecord.item)) ?? rawOutput
}

function getMcpFunctionErrorOutput(itemRecord: Record<string, unknown>) {
  const errorRecord = asRecord(itemRecord.error)
  const content = errorRecord.content

  if (!Array.isArray(content)) {
    return Object.keys(errorRecord).length > 0 ? errorRecord : null
  }

  const textParts = content.flatMap((part) => {
    const partRecord = asRecord(part)
    const text = getStringProperty(partRecord, "text")

    return text === null ? [] : [text]
  })

  if (textParts.length === 0) {
    return errorRecord
  }

  return textParts.join("\n")
}

function getProviderTerminalFailureMessage(
  eventType: string | null,
  payload: unknown,
  providerName: string
) {
  const payloadRecord = asRecord(payload)
  const errorRecord = asRecord(payloadRecord.error)
  const responseRecord = asRecord(payloadRecord.response)
  const responseErrorRecord = asRecord(responseRecord.error)
  const incompleteDetailsRecord = asRecord(responseRecord.incomplete_details)
  const message =
    getStringProperty(payloadRecord, "message") ??
    getStringProperty(errorRecord, "message") ??
    getStringProperty(responseErrorRecord, "message") ??
    getStringProperty(incompleteDetailsRecord, "reason")

  if (message) {
    return `${providerName} stream ended with ${eventType ?? "a provider failure"}: ${message}`
  }

  return `${providerName} stream ended with ${eventType ?? "a provider failure"}.`
}

function rememberOpenRouterToolCallName(
  toolCallNamesById: OpenRouterToolCallNameMap,
  itemRecord: Record<string, unknown>
) {
  const functionName = getStringProperty(itemRecord, "name")

  if (!functionName) {
    return null
  }

  for (const identifierProperty of ["callId", "id"]) {
    const identifier = getStringProperty(itemRecord, identifierProperty)

    if (identifier) {
      toolCallNamesById.set(identifier, functionName)
    }
  }

  return functionName
}
