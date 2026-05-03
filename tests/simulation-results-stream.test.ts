import assert from "node:assert/strict"
import test from "node:test"
import { parseSimulationFinalOutput } from "../src/lib/simulation-final-output.js"
import { formatDebugChunkBlocks } from "../src/lib/simulation-debug-chunks.js"
import { getSimulationResultChunks } from "../src/lib/simulation-result-chunks.js"
import { applySimulationResultsStreamEvent } from "../src/lib/simulation-results-stream.js"
import type {
  SimulationDebugLlmRun,
  SimulationDebugLlmRunChunk,
  SimulationResultsInfo,
} from "../src/lib/deck-types.js"

test("appends streamed chunks without duplicating existing sequences", () => {
  const results = createResults({
    openingHandLlmRuns: [
      createRun({
        llmRunId: "opening-run",
        phase: "opening_hand",
        chunks: [createChunk({ id: 10, sequence: 1, outputDelta: "A" })],
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "chunk",
    llmRunId: "opening-run",
    chunk: createChunk({ id: null, sequence: 1, outputDelta: "A" }),
  })

  assert.equal(updatedResults?.openingHandLlmRuns[0].chunks.length, 1)
  assert.equal(updatedResults?.openingHandLlmRuns[0].chunks[0].id, 10)
})

test("keeps streamed chunks ordered by sequence", () => {
  const results = createResults({
    openingHandLlmRuns: [
      createRun({
        llmRunId: "opening-run",
        phase: "opening_hand",
        chunks: [createChunk({ id: null, sequence: 3, outputDelta: "C" })],
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "chunk",
    llmRunId: "opening-run",
    chunk: createChunk({ id: null, sequence: 2, outputDelta: "B" }),
  })

  assert.deepEqual(
    updatedResults?.openingHandLlmRuns[0].chunks.map(
      (chunk) => chunk.sequence
    ),
    [2, 3]
  )
})

test("replaces synthetic chunks when a persisted run update arrives", () => {
  const results = createResults({
    turnLlmRuns: [
      createRun({
        llmRunId: "turn-run",
        phase: "turn",
        turnNumber: 1,
        chunks: [createChunk({ id: null, sequence: 1, outputDelta: "A" })],
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "llm_run_updated",
    run: createRun({
      llmRunId: "turn-run",
      phase: "turn",
      status: "completed",
      turnNumber: 1,
      chunks: [createChunk({ id: 20, sequence: 1, outputDelta: "A" })],
    }),
  })

  assert.equal(updatedResults?.turnLlmRuns[0].chunks[0].id, 20)
  assert.equal(updatedResults?.turnLlmRuns[0].status, "completed")
})

test("merges OpenRouter generations from persisted run updates", () => {
  const results = createResults({
    turnLlmRuns: [
      createRun({
        llmRunId: "turn-run",
        phase: "turn",
        provider: "openrouter",
        turnNumber: 1,
        openrouterGenerations: [
          {
            openrouterTurnIndex: 0,
            generationId: "gen-initial",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "llm_run_updated",
    run: createRun({
      llmRunId: "turn-run",
      phase: "turn",
      provider: "openrouter",
      status: "completed",
      turnNumber: 1,
      openrouterGenerations: [
        {
          openrouterTurnIndex: 1,
          generationId: "gen-follow-up",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    }),
  })

  assert.deepEqual(
    updatedResults?.turnLlmRuns[0].openrouterGenerations.map(
      (generation) => generation.generationId
    ),
    ["gen-initial", "gen-follow-up"]
  )
})

test("adds auto-advanced turn runs", () => {
  const results = createResults()

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "llm_run_started",
    run: createRun({
      llmRunId: "turn-run",
      phase: "turn",
      turnNumber: 1,
    }),
  })

  assert.equal(updatedResults?.turnLlmRunCount, 1)
  assert.equal(updatedResults?.turnLlmRuns[0].llmRunId, "turn-run")
})

test("parses completed opening hand final output", () => {
  const parsedOutput = parseSimulationFinalOutput(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      status: "completed",
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          outputDelta: '{"keptHand":["Forest",',
        }),
        createChunk({
          id: 2,
          sequence: 2,
          outputDelta: '"Sol Ring"],"summary":"Kept a stable opener."}',
        }),
      ],
    })
  )

  assert.deepEqual(parsedOutput, {
    type: "opening_hand",
    keptHand: ["Forest", "Sol Ring"],
    summary: "Kept a stable opener.",
  })
})

test("parses completed final output after leading LLM text", () => {
  const parsedOutput = parseSimulationFinalOutput(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      status: "completed",
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          outputDelta: 'I would "keep this hand.\n',
        }),
        createChunk({
          id: 2,
          sequence: 2,
          outputDelta:
            '{"keptHand":["Forest","Sol Ring"],"summary":"Kept a stable opener."}',
        }),
      ],
    })
  )

  assert.deepEqual(parsedOutput, {
    type: "opening_hand",
    keptHand: ["Forest", "Sol Ring"],
    summary: "Kept a stable opener.",
  })
})

test("parses completed turn final output", () => {
  const parsedOutput = parseSimulationFinalOutput(
    createRun({
      llmRunId: "turn-run",
      phase: "turn",
      status: "completed",
      turnNumber: 1,
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          outputDelta: '{"gameState":"Hand: Forest\\nBattlefield: Island",',
        }),
        createChunk({
          id: 2,
          sequence: 2,
          outputDelta: '"summary":"Played Island and passed."}',
        }),
      ],
    })
  )

  assert.deepEqual(parsedOutput, {
    type: "turn",
    gameState: "Hand: Forest\nBattlefield: Island",
    summary: "Played Island and passed.",
  })
})

test("does not parse final output before completion", () => {
  const parsedOutput = parseSimulationFinalOutput(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      status: "streaming",
      chunks: [
        createChunk({
          id: null,
          sequence: 1,
          outputDelta: '{"keptHand":["Forest"],"summary":"Still streaming."}',
        }),
      ],
    })
  )

  assert.equal(parsedOutput, null)
})

test("omits whitespace-only formatted reasoning and output blocks", () => {
  const blocks = formatDebugChunkBlocks(
    [
      createChunk({
        id: 1,
        kind: "reasoning_delta",
        reasoningDelta: " \n\t",
        sequence: 1,
      }),
      createChunk({
        id: 2,
        outputDelta: "\n ",
        sequence: 2,
      }),
      createChunk({
        id: 3,
        kind: "mcp_call_start",
        sequence: 3,
      }),
      createChunk({
        id: 4,
        kind: "reasoning_delta",
        reasoningDelta: "Keep a two-land hand.",
        sequence: 4,
      }),
    ],
    { omitWhitespaceOnlyDeltaBlocks: true }
  )

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["event", "reasoning"]
  )
  assert.equal(
    blocks[1]?.type === "reasoning" ? blocks[1].text : "",
    "Keep a two-land hand."
  )
})

test("keeps whitespace-only formatted blocks by default for debug views", () => {
  const blocks = formatDebugChunkBlocks([
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: " \n\t",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      outputDelta: "\n ",
      sequence: 2,
    }),
  ])

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["reasoning", "output"]
  )
})

test("hides completed tool starts across intervening chunks", () => {
  const resultChunks = getSimulationResultChunks([
    createChunk({
      id: 1,
      kind: "mcp_call_start",
      mcpFunctionName: "draw_starting_hand",
      payload: {
        item: {
          id: "call_1",
        },
      },
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "reasoning_delta",
      reasoningDelta: "Need to inspect the opener.",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      outputDelta: "Checking hand.",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      payload: {
        item: {
          id: "call_1",
        },
      },
      sequence: 4,
    }),
  ])

  assert.deepEqual(
    resultChunks.map((chunk) => chunk.sequence),
    [2, 3, 4]
  )
})

function createResults({
  openingHandLlmRuns = [],
  turnLlmRuns = [],
}: {
  openingHandLlmRuns?: SimulationDebugLlmRun[]
  turnLlmRuns?: SimulationDebugLlmRun[]
} = {}): SimulationResultsInfo {
  return {
    simulationId: "simulation-id",
    openingHandLlmRunCount: openingHandLlmRuns.length,
    turnLlmRunCount: turnLlmRuns.length,
    openingHandLlmRuns,
    turnLlmRuns,
  }
}

function createRun(overrides: {
  llmRunId: string
  phase: string
  attemptNumber?: number
  chunks?: ReturnType<typeof createChunk>[]
  openrouterGenerations?: SimulationDebugLlmRun["openrouterGenerations"]
  provider?: string
  status?: string
  turnNumber?: number
}): SimulationDebugLlmRun {
  return {
    llmRunId: overrides.llmRunId,
    phase: overrides.phase,
    provider: overrides.provider ?? "openai",
    model: "gpt-test",
    estimatedPriceCents: null,
    reasoningEffort: "low",
    status: overrides.status ?? "streaming",
    runtimeStreamKey: null,
    attemptNumber: overrides.attemptNumber ?? 1,
    turnNumber: overrides.turnNumber,
    openrouterGenerations: overrides.openrouterGenerations ?? [],
    chunks: overrides.chunks ?? [],
  }
}

function createChunk(overrides: {
  id: number | null
  kind?: string
  mcpFunctionName?: string | null
  mcpFunctionOutput?: unknown | null
  outputDelta?: string
  payload?: unknown
  reasoningDelta?: string
  sequence: number
}): SimulationDebugLlmRunChunk {
  return {
    id: overrides.id,
    sequence: overrides.sequence,
    kind: overrides.kind ?? "message_delta",
    mcpFunctionName: overrides.mcpFunctionName ?? null,
    mcpFunctionOutput: overrides.mcpFunctionOutput ?? null,
    reasoningDelta: overrides.reasoningDelta ?? null,
    outputDelta: overrides.outputDelta ?? null,
    payload: overrides.payload ?? {},
    receivedAt: "2026-01-01T00:00:00.000Z",
  }
}
