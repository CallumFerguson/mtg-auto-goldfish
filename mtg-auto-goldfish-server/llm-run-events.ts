import type { LlmChunkKind, LlmRunChunkInput } from "./simulations-postgres.js"

export class ProviderTerminalEventError extends Error {
  readonly eventType: string | null
  readonly payload: unknown

  constructor(eventType: string | null, payload: unknown) {
    super(getProviderTerminalFailureMessage(eventType, payload))
    this.name = "ProviderTerminalEventError"
    this.eventType = eventType
    this.payload = payload
  }
}

export function normalizeOpenAiStreamEvent(
  event: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  const eventRecord = asRecord(event)
  const eventType = getStringProperty(eventRecord, "type")
  const itemType = getNestedStringProperty(eventRecord, "item", "type")
  const payload = event ?? {}

  if (eventType === "response.output_text.delta") {
    const delta = getStringProperty(eventRecord, "delta")

    return createChunk("message_delta", eventType, itemType, {
      outputDelta: delta,
      payload,
    })
  }

  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = getStringProperty(eventRecord, "delta")

    return createChunk("reasoning_delta", eventType, itemType, {
      reasoningDelta: delta,
      payload,
    })
  }

  if (eventType === "response.completed") {
    return createChunk("completed", eventType, itemType, {
      payload,
    })
  }

  if (eventType === "response.output_item.added" && itemType === "mcp_call") {
    const mcpFunctionName = getNestedStringProperty(eventRecord, "item", "name")

    return createChunk("mcp_call_start", eventType, itemType, {
      mcpFunctionName,
      payload,
    })
  }

  if (eventType === "response.output_item.done" && itemType === "mcp_call") {
    const mcpFunctionName = getNestedStringProperty(eventRecord, "item", "name")
    const mcpFunctionOutput = getNestedStringProperty(
      eventRecord,
      "item",
      "output"
    )

    return createChunk("mcp_call_complete", eventType, itemType, {
      mcpFunctionName,
      mcpFunctionOutput: parseMcpFunctionOutput(mcpFunctionOutput),
      payload,
    })
  }

  if (isProviderTerminalEvent(eventType)) {
    return createChunk("error", eventType, itemType, {
      payload,
    })
  }

  return createChunk("raw_event", eventType ?? null, itemType, {
    payload,
  })
}

export function isProviderTerminalEvent(eventType: string | null) {
  return (
    eventType === "response.failed" ||
    eventType === "response.incomplete" ||
    Boolean(eventType?.endsWith(".failed"))
  )
}

export function createServerErrorChunk(
  error: unknown
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("error", "server.error", null, {
    payload: {
      message: getErrorMessage(error),
      name: error instanceof Error ? error.name : null,
    },
  })
}

export function createCancellationChunk(
  message = "Opening-hand LLM run was cancelled."
): Omit<LlmRunChunkInput, "sequence"> {
  return createChunk("cancelled", "server.cancelled", null, {
    payload: {
      message,
    },
  })
}

export function parseOpeningHandFromResponseText(responseText: string) {
  if (!responseText.trim()) {
    throw new Error("Opening-hand LLM completed response was empty.")
  }

  let parsedResponse: unknown

  try {
    parsedResponse = JSON.parse(responseText) as unknown
  } catch (error) {
    throw new Error(
      "Opening-hand LLM completed response was not valid JSON.",
      {
        cause: error,
      }
    )
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
  }
}

export function getCompletedResponseOutputText(response: unknown) {
  const responseRecord = asRecord(response)
  const topLevelOutputText = getStringProperty(responseRecord, "output_text")

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
    (error.name === "APIUserAbortError" || error.name === "AbortError")
  )
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createChunk(
  kind: LlmChunkKind,
  providerEventType: string | null,
  itemType: string | null,
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
    providerEventType,
    itemType,
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

function getProviderTerminalFailureMessage(
  eventType: string | null,
  payload: unknown
) {
  const payloadRecord = asRecord(payload)
  const errorRecord = asRecord(payloadRecord.error)
  const responseRecord = asRecord(payloadRecord.response)
  const responseErrorRecord = asRecord(responseRecord.error)
  const incompleteDetailsRecord = asRecord(responseRecord.incomplete_details)
  const message =
    getStringProperty(errorRecord, "message") ??
    getStringProperty(responseErrorRecord, "message") ??
    getStringProperty(incompleteDetailsRecord, "reason")

  if (message) {
    return `OpenAI stream ended with ${eventType ?? "a provider failure"}: ${message}`
  }

  return `OpenAI stream ended with ${eventType ?? "a provider failure"}.`
}
