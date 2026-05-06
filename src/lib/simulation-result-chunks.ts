import type { SimulationDebugLlmRunChunk } from "./deck-types"

export type SimulationResultEntry =
  | {
      id: string
      type: "chunk"
      chunk: SimulationDebugLlmRunChunk
    }
  | {
      id: string
      type: "turn_action_log"
      actions: string[]
      chunks: SimulationDebugLlmRunChunk[]
    }

export function getSimulationResultChunks(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const visibleChunks = chunks.filter(
    (chunk, index) => !isRedundantMcpCallFailedEvent(chunk, chunks[index + 1])
  )
  const hiddenToolStartChunks = getCompletedToolStartChunks(visibleChunks)
  const activeToolStartChunk = getActiveToolStartChunk(visibleChunks)

  return visibleChunks.filter(
    (chunk) =>
      !hiddenToolStartChunks.has(chunk) &&
      chunk !== activeToolStartChunk &&
      !isDeltaChunk(chunk) &&
      !isLifecycleChunk(chunk)
  )
}

export function getSimulationResultEntries(
  chunks: readonly SimulationDebugLlmRunChunk[]
): SimulationResultEntry[] {
  const entries: SimulationResultEntry[] = []
  let pendingTurnActionChunks: SimulationDebugLlmRunChunk[] = []

  function flushPendingTurnActionChunks() {
    if (pendingTurnActionChunks.length === 0) {
      return
    }

    entries.push({
      id: getTurnActionLogEntryId(pendingTurnActionChunks),
      type: "turn_action_log",
      actions: pendingTurnActionChunks.flatMap((chunk) => {
        const action = getLoggedTurnAction(chunk)

        return action === null ? [] : [action]
      }),
      chunks: pendingTurnActionChunks,
    })
    pendingTurnActionChunks = []
  }

  for (const chunk of getSimulationResultChunks(chunks)) {
    if (isCompletedLogTurnActionChunk(chunk)) {
      pendingTurnActionChunks.push(chunk)
      continue
    }

    flushPendingTurnActionChunks()
    entries.push({
      id: `chunk-${getResultChunkId(chunk)}`,
      type: "chunk",
      chunk,
    })
  }

  flushPendingTurnActionChunks()

  return entries
}

export function getSimulationRunThinkingPreview(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const previewText = chunks
    .filter(isDeltaChunk)
    .sort(
      (firstChunk, secondChunk) => firstChunk.sequence - secondChunk.sequence
    )
    .slice(-100)
    .map(getDeltaText)
    .join("")
    .replace(/\r\n?|\n/g, " ")
    .trim()

  return previewText.length > 0 ? previewText : null
}

export function hasSimulationRunFinalParsedOutputChunk(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  return chunks.some((chunk) => chunk.kind === "final_parsed_output")
}

export function getSimulationRunActiveToolCallName(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  return getActiveToolStartChunk(chunks)?.mcpFunctionName ?? null
}

export function getLoggedTurnAction(chunk: SimulationDebugLlmRunChunk) {
  if (!isCompletedLogTurnActionChunk(chunk)) {
    return null
  }

  const resolvedPayload = parseJsonObjectPayload(chunk.mcpFunctionOutput)
  const loggedActions = asPayloadRecord(resolvedPayload).data
  const loggedActionsList = asPayloadRecord(loggedActions).loggedActions

  if (Array.isArray(loggedActionsList)) {
    const lastLoggedAction = loggedActionsList.at(-1)

    if (typeof lastLoggedAction === "string" && lastLoggedAction.trim()) {
      return lastLoggedAction
    }
  }

  const message = getPayloadString(resolvedPayload, "message")
  const messagePrefix = "Logged action:"

  if (message?.startsWith(messagePrefix)) {
    const messageAction = message.slice(messagePrefix.length).trim()

    return messageAction.length > 0 ? messageAction : null
  }

  return null
}

function isCompletedLogTurnActionChunk(chunk: SimulationDebugLlmRunChunk) {
  return (
    chunk.kind === "mcp_call_complete" &&
    chunk.mcpFunctionName === "log_turn_action"
  )
}

function getTurnActionLogEntryId(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const firstChunk = chunks[0]
  const lastChunk = chunks[chunks.length - 1]

  return `turn-action-log-${getResultChunkId(firstChunk)}-${getResultChunkId(
    lastChunk
  )}`
}

function getResultChunkId(chunk: SimulationDebugLlmRunChunk) {
  return chunk.id === null ? `live-${chunk.sequence}` : String(chunk.id)
}

function getCompletedToolStartChunks(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const pendingToolStartChunks: SimulationDebugLlmRunChunk[] = []
  const completedToolStartChunks = new Set<SimulationDebugLlmRunChunk>()

  for (const chunk of chunks) {
    if (chunk.kind === "mcp_call_start") {
      pendingToolStartChunks.push(chunk)
      continue
    }

    if (chunk.kind !== "mcp_call_complete") {
      continue
    }

    const startChunkIndex = findMatchingToolStartChunkIndex(
      pendingToolStartChunks,
      chunk
    )

    if (startChunkIndex === -1) {
      continue
    }

    const [startChunk] = pendingToolStartChunks.splice(startChunkIndex, 1)
    completedToolStartChunks.add(startChunk)
  }

  return completedToolStartChunks
}

function getActiveToolStartChunk(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const latestChunk = chunks.reduce<SimulationDebugLlmRunChunk | null>(
    (latestChunk, chunk) =>
      latestChunk === null || chunk.sequence > latestChunk.sequence
        ? chunk
        : latestChunk,
    null
  )

  return latestChunk?.kind === "mcp_call_start" ? latestChunk : null
}

function findMatchingToolStartChunkIndex(
  pendingToolStartChunks: readonly SimulationDebugLlmRunChunk[],
  completeChunk: SimulationDebugLlmRunChunk
) {
  const completeCallKey = getMcpCallKey(completeChunk)

  if (completeCallKey !== null) {
    for (let index = pendingToolStartChunks.length - 1; index >= 0; index -= 1) {
      if (getMcpCallKey(pendingToolStartChunks[index]) === completeCallKey) {
        return index
      }
    }
  }

  if (completeChunk.mcpFunctionName === null) {
    return -1
  }

  for (let index = pendingToolStartChunks.length - 1; index >= 0; index -= 1) {
    if (
      pendingToolStartChunks[index].mcpFunctionName ===
      completeChunk.mcpFunctionName
    ) {
      return index
    }
  }

  return -1
}

function isRedundantMcpCallFailedEvent(
  chunk: SimulationDebugLlmRunChunk,
  nextChunk: SimulationDebugLlmRunChunk | undefined
) {
  return (
    chunk.kind === "error" &&
    nextChunk?.kind === "mcp_call_complete" &&
    getPayloadString(chunk.payload, "item_id") !== null &&
    getPayloadString(chunk.payload, "item_id") === getMcpCallItemId(nextChunk)
  )
}

function isDeltaChunk(chunk: SimulationDebugLlmRunChunk) {
  return chunk.kind === "reasoning_delta" || chunk.kind === "message_delta"
}

function isLifecycleChunk(chunk: SimulationDebugLlmRunChunk) {
  return (
    chunk.kind === "reasoning_start" ||
    chunk.kind === "reasoning_done" ||
    chunk.kind === "output_start" ||
    chunk.kind === "output_done"
  )
}

function getDeltaText(chunk: SimulationDebugLlmRunChunk) {
  if (chunk.kind === "reasoning_delta") {
    return chunk.reasoningDelta ?? ""
  }

  if (chunk.kind === "message_delta") {
    return chunk.outputDelta ?? ""
  }

  return ""
}

function getMcpCallItemId(chunk: SimulationDebugLlmRunChunk) {
  return getPayloadString(asPayloadRecord(chunk.payload).item, "id")
}

function getMcpCallKey(chunk: SimulationDebugLlmRunChunk) {
  const payloadRecord = asPayloadRecord(chunk.payload)
  const itemRecord = asPayloadRecord(payloadRecord.item)

  return (
    getPayloadString(itemRecord, "id") ??
    getPayloadString(itemRecord, "callId") ??
    getPayloadString(itemRecord, "call_id") ??
    getPayloadString(payloadRecord, "toolCallId") ??
    getPayloadString(payloadRecord, "tool_call_id") ??
    getPayloadString(payloadRecord, "itemId") ??
    getPayloadString(payloadRecord, "item_id") ??
    getPayloadString(payloadRecord, "id")
  )
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function parseJsonObjectPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    for (const part of payload) {
      const text = getPayloadString(part, "text")

      if (text === null) {
        continue
      }

      const parsedTextPayload = parseJsonObjectPayload(text)

      if (typeof parsedTextPayload === "object" && parsedTextPayload !== null) {
        return parsedTextPayload
      }
    }

    return null
  }

  if (typeof payload === "object" && payload !== null) {
    const content = asPayloadRecord(payload).content

    if (Array.isArray(content)) {
      for (const part of content) {
        const text = getPayloadString(part, "text")

        if (text === null) {
          continue
        }

        const parsedTextPayload = parseJsonObjectPayload(text)

        if (typeof parsedTextPayload === "object" && parsedTextPayload !== null) {
          return parsedTextPayload
        }
      }
    }

    return payload
  }

  if (typeof payload !== "string") {
    return null
  }

  try {
    const parsedPayload = JSON.parse(payload) as unknown

    return typeof parsedPayload === "object" && parsedPayload !== null
      ? parsedPayload
      : null
  } catch {
    return null
  }
}

function getPayloadString(value: unknown, property: string) {
  const propertyValue = asPayloadRecord(value)[property]

  return typeof propertyValue === "string" ? propertyValue : null
}
