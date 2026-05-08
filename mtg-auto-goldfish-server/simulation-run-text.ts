type SimulationRunTextChunk = {
  id: number | null
  sequence: number
  kind: string
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
}

export function formatSimulationRunClipboardText(
  run: { chunks: readonly SimulationRunTextChunk[] },
  {
    fullPrompt = null,
  }: {
    fullPrompt?: string | null
  } = {}
) {
  const runText = formatSimulationRunChunksClipboardText(run.chunks)

  if (fullPrompt === null || fullPrompt.length === 0) {
    return runText
  }

  if (runText.length === 0) {
    return fullPrompt
  }

  return `${fullPrompt}\n\n${runText}`
}

export function formatSimulationRunChunksClipboardText(
  chunks: readonly SimulationRunTextChunk[]
) {
  const sortedChunks = [...chunks].sort(
    (firstChunk, secondChunk) => firstChunk.sequence - secondChunk.sequence
  )
  const completedToolCallPairs = getCompletedToolCallPairs(sortedChunks)
  const completedToolCallStartByCompleteChunk = new Map(
    completedToolCallPairs.map((pair) => [pair.completeChunk, pair.startChunk])
  )
  const blocks: string[] = []
  let activeDeltaBlockType: "reasoning" | "output" | null = null
  let activeDeltaBlockText = ""

  function flushActiveDeltaBlock() {
    if (activeDeltaBlockText.length > 0) {
      blocks.push(activeDeltaBlockText)
    }

    activeDeltaBlockType = null
    activeDeltaBlockText = ""
  }

  function startDeltaBlock(type: "reasoning" | "output") {
    flushActiveDeltaBlock()
    activeDeltaBlockType = type
  }

  function appendDeltaBlockText(type: "reasoning" | "output", text: string) {
    if (activeDeltaBlockType !== type) {
      flushActiveDeltaBlock()
      activeDeltaBlockType = type
    }

    activeDeltaBlockText += text
  }

  function appendBlock(text: string) {
    flushActiveDeltaBlock()

    if (text.length > 0) {
      blocks.push(text)
    }
  }

  for (const chunk of sortedChunks) {
    if (chunk.kind === "reasoning_start") {
      startDeltaBlock("reasoning")
      continue
    }

    if (chunk.kind === "output_start") {
      startDeltaBlock("output")
      continue
    }

    if (chunk.kind === "reasoning_done" || chunk.kind === "output_done") {
      flushActiveDeltaBlock()
      continue
    }

    if (chunk.kind === "reasoning_delta") {
      appendDeltaBlockText("reasoning", chunk.reasoningDelta ?? "")
      continue
    }

    if (chunk.kind === "message_delta") {
      appendDeltaBlockText("output", chunk.outputDelta ?? "")
      continue
    }

    if (chunk.kind === "mcp_call_start") {
      appendBlock(formatToolCallClipboardText([chunk]))
      continue
    }

    if (chunk.kind === "mcp_call_complete") {
      const startChunk = completedToolCallStartByCompleteChunk.get(chunk)
      const toolCallChunks = startChunk ? [startChunk, chunk] : [chunk]

      if (!startChunk) {
        appendBlock(formatToolCallClipboardText([chunk]))
      }

      appendBlock(
        `${formatToolResultClipboardText(toolCallChunks)}\n${formatMcpFunctionOutputJson(
          chunk.mcpFunctionOutput
        )}`
      )
    }
  }

  flushActiveDeltaBlock()

  return blocks.join("\n\n")
}

function getCompletedToolCallPairs(chunks: readonly SimulationRunTextChunk[]) {
  const pendingToolStartChunks: SimulationRunTextChunk[] = []
  const completedToolCallPairs: {
    startChunk: SimulationRunTextChunk
    completeChunk: SimulationRunTextChunk
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

function findMatchingToolStartChunkIndex(
  pendingToolStartChunks: readonly SimulationRunTextChunk[],
  completeChunk: SimulationRunTextChunk
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

function getToolCallActivityName(chunks: readonly SimulationRunTextChunk[]) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const toolName = chunks[index].mcpFunctionName?.trim()

    if (toolName) {
      return toolName
    }
  }

  return "Unknown tool"
}

function formatToolCallClipboardText(chunks: readonly SimulationRunTextChunk[]) {
  return `[called ${getToolCallActivityName(chunks)}]`
}

function formatToolResultClipboardText(
  chunks: readonly SimulationRunTextChunk[]
) {
  return `[result of ${getToolCallActivityName(chunks)}]`
}

function formatMcpFunctionOutputJson(output: unknown) {
  return JSON.stringify(output, null, 2) ?? "undefined"
}

function getMcpCallKey(chunk: SimulationRunTextChunk) {
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

function getPayloadString(value: unknown, property: string) {
  const propertyValue = asPayloadRecord(value)[property]

  return typeof propertyValue === "string" ? propertyValue : null
}
