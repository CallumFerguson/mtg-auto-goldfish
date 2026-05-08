import type { SimulationDebugLlmRunChunk } from "./deck-types"
export {
  formatSimulationRunChunksClipboardText,
  formatSimulationRunClipboardText,
} from "../../mtg-auto-goldfish-server/simulation-run-text.js"

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

export type SimulationRunActivityBlock =
  | {
      id: string
      type: "reasoning"
      text: string
      chunks: SimulationDebugLlmRunChunk[]
    }
  | {
      id: string
      type: "tool_call"
      toolName: string
      chunks: SimulationDebugLlmRunChunk[]
    }

const THINKING_PREVIEW_MAX_DELTA_CHUNKS = 100

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

export function hasSimulationRunFinalParsedOutputChunk(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  return chunks.some((chunk) => chunk.kind === "final_parsed_output")
}

export function getSimulationRunThinkingPreview(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const preview = [...chunks]
    .sort((firstChunk, secondChunk) => firstChunk.sequence - secondChunk.sequence)
    .filter(isDeltaChunk)
    .slice(-THINKING_PREVIEW_MAX_DELTA_CHUNKS)
    .map(getDeltaText)
    .join("")
    .replace(/\s+/g, " ")
    .trim()

  return preview.length > 0 ? preview : null
}

export function getSimulationRunActiveToolCallName(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  return getActiveToolStartChunk(chunks)?.mcpFunctionName ?? null
}

export function getSimulationRunActivityBlocks(
  chunks: readonly SimulationDebugLlmRunChunk[]
): SimulationRunActivityBlock[] {
  const sortedChunks = [...chunks].sort(
    (firstChunk, secondChunk) => firstChunk.sequence - secondChunk.sequence
  )
  const completedToolCallPairs = getCompletedToolCallPairs(sortedChunks)
  const completedToolCallByStartChunk = new Map(
    completedToolCallPairs.map((pair) => [pair.startChunk, pair.completeChunk])
  )
  const completedToolCallCompleteChunks = new Set(
    completedToolCallPairs.map((pair) => pair.completeChunk)
  )
  const blocks: SimulationRunActivityBlock[] = []
  let activeDeltaBlock: Extract<
    SimulationRunActivityBlock,
    { type: "reasoning" }
  > | null = null

  function closeActiveDeltaBlock() {
    activeDeltaBlock = null
  }

  function startReasoningBlock(chunk: SimulationDebugLlmRunChunk) {
    const block: Extract<SimulationRunActivityBlock, { type: "reasoning" }> = {
      id: `reasoning-${getResultChunkId(chunk)}`,
      type: "reasoning",
      text: "",
      chunks: [chunk],
    }

    blocks.push(block)
    activeDeltaBlock = block

    return block
  }

  function appendReasoningDeltaChunk(chunk: SimulationDebugLlmRunChunk) {
    const deltaText = getDeltaText(chunk)
    const block = activeDeltaBlock ?? startReasoningBlock(chunk)

    if (block.chunks[block.chunks.length - 1] !== chunk) {
      block.chunks.push(chunk)
    }

    block.text += deltaText
  }

  function appendReasoningLifecycleChunk(
    chunk: SimulationDebugLlmRunChunk,
    state: "start" | "done"
  ) {
    if (state === "start") {
      startReasoningBlock(chunk)
      return
    }

    if (activeDeltaBlock === null) {
      return
    }

    activeDeltaBlock.chunks.push(chunk)
    closeActiveDeltaBlock()
  }

  function appendToolCallBlock(chunks: SimulationDebugLlmRunChunk[]) {
    closeActiveDeltaBlock()

    const firstChunk = chunks[0]
    const lastChunk = chunks[chunks.length - 1]

    blocks.push({
      id:
        firstChunk === lastChunk
          ? `tool-call-${getResultChunkId(firstChunk)}`
          : `tool-call-${getResultChunkId(firstChunk)}-${getResultChunkId(
              lastChunk
            )}`,
      type: "tool_call",
      toolName: getToolCallActivityName(chunks),
      chunks,
    })
  }

  for (const chunk of sortedChunks) {
    if (chunk.kind === "reasoning_start") {
      appendReasoningLifecycleChunk(chunk, "start")
      continue
    }

    if (chunk.kind === "reasoning_done") {
      appendReasoningLifecycleChunk(chunk, "done")
      continue
    }

    if (chunk.kind === "output_start") {
      closeActiveDeltaBlock()
      continue
    }

    if (chunk.kind === "output_done") {
      closeActiveDeltaBlock()
      continue
    }

    if (chunk.kind === "reasoning_delta") {
      appendReasoningDeltaChunk(chunk)
      continue
    }

    if (chunk.kind === "message_delta") {
      closeActiveDeltaBlock()
      continue
    }

    if (chunk.kind === "mcp_call_start") {
      const completeChunk = completedToolCallByStartChunk.get(chunk)
      appendToolCallBlock(completeChunk ? [chunk, completeChunk] : [chunk])
      continue
    }

    if (chunk.kind === "mcp_call_complete") {
      if (completedToolCallCompleteChunks.has(chunk)) {
        continue
      }

      appendToolCallBlock([chunk])
      continue
    }

    closeActiveDeltaBlock()
  }

  return blocks.filter(
    (block) => block.type === "tool_call" || block.text.trim().length > 0
  )
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
  return new Set(
    getCompletedToolCallPairs(chunks).map((pair) => pair.startChunk)
  )
}

function getCompletedToolCallPairs(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const pendingToolStartChunks: SimulationDebugLlmRunChunk[] = []
  const completedToolCallPairs: {
    startChunk: SimulationDebugLlmRunChunk
    completeChunk: SimulationDebugLlmRunChunk
  }[] = []

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
    completedToolCallPairs.push({
      startChunk,
      completeChunk: chunk,
    })
  }

  return completedToolCallPairs
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
    for (
      let index = pendingToolStartChunks.length - 1;
      index >= 0;
      index -= 1
    ) {
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

function getToolCallActivityName(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const toolName = chunks[index].mcpFunctionName?.trim()

    if (toolName) {
      return toolName
    }
  }

  return "Unknown tool"
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

        if (
          typeof parsedTextPayload === "object" &&
          parsedTextPayload !== null
        ) {
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
