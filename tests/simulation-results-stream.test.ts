import assert from "node:assert/strict"
import test from "node:test"
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
  status?: string
  turnNumber?: number
}): SimulationDebugLlmRun {
  return {
    llmRunId: overrides.llmRunId,
    phase: overrides.phase,
    provider: "openai",
    model: "gpt-test",
    estimatedPriceCents: null,
    reasoningEffort: "low",
    status: overrides.status ?? "streaming",
    runtimeStreamKey: null,
    attemptNumber: overrides.attemptNumber ?? 1,
    turnNumber: overrides.turnNumber,
    chunks: overrides.chunks ?? [],
  }
}

function createChunk(overrides: {
  id: number | null
  outputDelta: string
  sequence: number
}): SimulationDebugLlmRunChunk {
  return {
    id: overrides.id,
    sequence: overrides.sequence,
    kind: "message_delta",
    providerEventType: "response.output_text.delta",
    itemType: null,
    mcpFunctionName: null,
    mcpFunctionOutput: null,
    reasoningDelta: null,
    outputDelta: overrides.outputDelta,
    payload: {},
    receivedAt: "2026-01-01T00:00:00.000Z",
  }
}
