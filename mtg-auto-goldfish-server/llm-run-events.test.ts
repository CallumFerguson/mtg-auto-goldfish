import assert from "node:assert/strict"
import test from "node:test"
import {
  ProviderTerminalEventError,
  createCancellationChunk,
  normalizeOpenAiStreamEvent,
  parseOpeningHandFromResponseText,
  parseTurnSimulationFromResponseText,
} from "./llm-run-events.js"
import {
  INVALID_OPENING_HAND_SIMULATION_FAILURE_MESSAGE,
  SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
  STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE,
  STALE_RUNNING_SIMULATION_CANCELLATION_MESSAGE,
  getOpeningHandCompletionDecision,
  getSimulationCreationDecision,
  getTurnCompletionDecision,
  isValidCompletedOpeningHand,
} from "./simulations-postgres.js"
import {
  SimulationStopTimeoutError,
  waitForSimulationStopCompletions,
} from "./simulation-stop.js"
import { estimateOpenAiTokenPriceCents } from "./openai-pricing.js"

test("normalizes valid MCP output JSON", () => {
  const chunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "mcp_call",
      name: "draw_starting_hand",
      output: '{"cards":["Sol Ring"]}',
    },
  })

  assert.equal(chunk.kind, "mcp_call_complete")
  assert.equal(chunk.mcpFunctionName, "draw_starting_hand")
  assert.deepEqual(chunk.mcpFunctionOutput, {
    cards: ["Sol Ring"],
  })
})

test("keeps malformed MCP output as raw text instead of throwing", () => {
  const chunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "mcp_call",
      name: "draw_starting_hand",
      output: '{"cards":',
    },
  })

  assert.equal(chunk.kind, "mcp_call_complete")
  assert.equal(chunk.mcpFunctionOutput, '{"cards":')
})

test("estimates supported OpenAI model price in cents", () => {
  const estimate = estimateOpenAiTokenPriceCents({
    model: "gpt-5.4-mini",
    usage: {
      input_tokens: 100_000,
      input_tokens_details: {
        cached_tokens: 20_000,
      },
      output_tokens: 10_000,
    },
  })

  assert.equal(estimate?.formattedCents, "10.7")
})

test("formats tiny OpenAI model price estimates below one tenth of a cent", () => {
  const estimate = estimateOpenAiTokenPriceCents({
    model: "gpt-5.4-nano",
    usage: {
      input_tokens: 100,
      output_tokens: 100,
    },
  })

  assert.equal(estimate?.formattedCents, "<0.1")
})

test("does not estimate unsupported OpenAI model prices", () => {
  const estimate = estimateOpenAiTokenPriceCents({
    model: "gpt-5",
    usage: {
      input_tokens: 100_000,
      output_tokens: 10_000,
    },
  })

  assert.equal(estimate, null)
})

test("normalizes MCP tool errors from completed output items", () => {
  const chunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "mcp_call",
      name: "draw_card_from_top",
      output: null,
      status: "failed",
      error: {
        type: "mcp_tool_execution_error",
        content: [
          {
            text: "Provided simulationId does not match the simulation associated with llmRunId.",
            type: "text",
          },
        ],
      },
    },
  })

  assert.equal(chunk.kind, "mcp_call_complete")
  assert.equal(chunk.mcpFunctionName, "draw_card_from_top")
  assert.equal(
    chunk.mcpFunctionOutput,
    "Provided simulationId does not match the simulation associated with llmRunId."
  )
})

test("creates a first-class cancellation chunk", () => {
  const chunk = createCancellationChunk("Stopped by user.")

  assert.equal(chunk.kind, "cancelled")
  assert.equal(chunk.providerEventType, "server.cancelled")
  assert.deepEqual(chunk.payload, {
    message: "Stopped by user.",
  })
})

test("recognizes provider terminal events as error chunks", () => {
  const event = {
    type: "response.failed",
    response: {
      error: {
        message: "provider is unavailable",
      },
    },
  }
  const chunk = normalizeOpenAiStreamEvent(event)
  const error = new ProviderTerminalEventError(event.type, event)

  assert.equal(chunk.kind, "error")
  assert.equal(chunk.providerEventType, "response.failed")
  assert.equal(
    error.message,
    "OpenAI stream ended with response.failed: provider is unavailable"
  )
})

test("reports invalid completed JSON with an explicit message", () => {
  assert.throws(
    () => parseOpeningHandFromResponseText("{"),
    /Opening-hand LLM completed response was not valid JSON\./
  )
})

test("parses completed turn game state JSON", () => {
  assert.deepEqual(
    parseTurnSimulationFromResponseText(
      JSON.stringify({
        gameState: "Hand:\nSol Ring\n\nBattlefield:\nCommand Tower",
        summary: "Played Command Tower.",
      })
    ),
    {
      gameState: "Hand:\nSol Ring\n\nBattlefield:\nCommand Tower",
    }
  )
})

test("rejects completed turn JSON without game state", () => {
  assert.throws(
    () => parseTurnSimulationFromResponseText('{"summary":"No state."}'),
    /Turn LLM response did not include gameState\./
  )
})

test("reports invalid completed turn JSON with an explicit message", () => {
  assert.throws(
    () => parseTurnSimulationFromResponseText("{"),
    /Turn LLM completed response was not valid JSON\./
  )
})

test("normal results exclude only raw and completed chunks", () => {
  assert.deepEqual(SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS, [
    "raw_event",
    "completed",
  ])
})

test("startup stale-run cancellation message is explicit", () => {
  const chunk = createCancellationChunk(
    STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE
  )

  assert.equal(chunk.kind, "cancelled")
  assert.deepEqual(chunk.payload, {
    message:
      "LLM run was cancelled because the server restarted before the in-flight API stream completed.",
  })
})

test("startup stale running simulation cancellation message is explicit", () => {
  assert.equal(
    STALE_RUNNING_SIMULATION_CANCELLATION_MESSAGE,
    "Simulation was cancelled because the server restarted before it finished."
  )
})

test("new simulations choose the correct initial step", () => {
  assert.deepEqual(
    getSimulationCreationDecision({
      hasPresetStartingHand: false,
      turnsToSimulate: 3,
    }),
    {
      simulationStatus: "running",
      nextStep: {
        type: "opening_hand",
      },
    }
  )
  assert.deepEqual(
    getSimulationCreationDecision({
      hasPresetStartingHand: true,
      turnsToSimulate: 0,
    }),
    {
      simulationStatus: "completed",
      nextStep: null,
    }
  )
  assert.deepEqual(
    getSimulationCreationDecision({
      hasPresetStartingHand: true,
      turnsToSimulate: 2,
    }),
    {
      simulationStatus: "running",
      nextStep: {
        type: "turn",
        turnNumber: 1,
      },
    }
  )
})

test("opening-hand completion advances, completes, or fails by simulation state", () => {
  assert.deepEqual(
    getOpeningHandCompletionDecision({
      autoSimulateNextStep: true,
      openingHandIsValid: true,
      turnsToSimulate: 0,
    }),
    {
      simulationStatus: "completed",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
  assert.deepEqual(
    getOpeningHandCompletionDecision({
      autoSimulateNextStep: true,
      openingHandIsValid: true,
      turnsToSimulate: 2,
    }),
    {
      simulationStatus: "running",
      nextStep: {
        type: "turn",
        turnNumber: 1,
      },
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
  assert.deepEqual(
    getOpeningHandCompletionDecision({
      autoSimulateNextStep: false,
      openingHandIsValid: true,
      turnsToSimulate: 2,
    }),
    {
      simulationStatus: "running",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
  assert.deepEqual(
    getOpeningHandCompletionDecision({
      autoSimulateNextStep: true,
      openingHandIsValid: false,
      turnsToSimulate: 2,
    }),
    {
      simulationStatus: "failed",
      nextStep: null,
      disableAutoSimulateNextStep: true,
      failureMessage: INVALID_OPENING_HAND_SIMULATION_FAILURE_MESSAGE,
    }
  )
})

test("turn completion advances until the target turn then completes", () => {
  assert.deepEqual(
    getTurnCompletionDecision({
      autoSimulateNextStep: true,
      turnNumber: 1,
      turnsToSimulate: 3,
    }),
    {
      simulationStatus: "running",
      nextStep: {
        type: "turn",
        turnNumber: 2,
      },
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
  assert.deepEqual(
    getTurnCompletionDecision({
      autoSimulateNextStep: false,
      turnNumber: 1,
      turnsToSimulate: 3,
    }),
    {
      simulationStatus: "running",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
  assert.deepEqual(
    getTurnCompletionDecision({
      autoSimulateNextStep: true,
      turnNumber: 3,
      turnsToSimulate: 3,
    }),
    {
      simulationStatus: "completed",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  )
})

test("validates completed opening hand size after commander mulligans", () => {
  assert.equal(
    isValidCompletedOpeningHand({
      deckLibraryCardCount: 99,
      librarySnapshot: Array.from(
        { length: 92 },
        (_, index) => `Card ${index}`
      ),
      mulliganCount: 0,
      openingHand: Array.from({ length: 7 }, (_, index) => `Hand ${index}`),
    }),
    true
  )
  assert.equal(
    isValidCompletedOpeningHand({
      deckLibraryCardCount: 99,
      librarySnapshot: Array.from(
        { length: 92 },
        (_, index) => `Card ${index}`
      ),
      mulliganCount: 1,
      openingHand: Array.from({ length: 7 }, (_, index) => `Hand ${index}`),
    }),
    true
  )
  assert.equal(
    isValidCompletedOpeningHand({
      deckLibraryCardCount: 99,
      librarySnapshot: Array.from(
        { length: 93 },
        (_, index) => `Card ${index}`
      ),
      mulliganCount: 2,
      openingHand: Array.from({ length: 6 }, (_, index) => `Hand ${index}`),
    }),
    true
  )
})

test("rejects completed opening hands with wrong hand or deck totals", () => {
  assert.equal(
    isValidCompletedOpeningHand({
      deckLibraryCardCount: 99,
      librarySnapshot: Array.from(
        { length: 92 },
        (_, index) => `Card ${index}`
      ),
      mulliganCount: 2,
      openingHand: Array.from({ length: 7 }, (_, index) => `Hand ${index}`),
    }),
    false
  )
  assert.equal(
    isValidCompletedOpeningHand({
      deckLibraryCardCount: 99,
      librarySnapshot: Array.from(
        { length: 92 },
        (_, index) => `Card ${index}`
      ),
      mulliganCount: 3,
      openingHand: Array.from({ length: 5 }, (_, index) => `Hand ${index}`),
    }),
    false
  )
})

test("simulation stop wait resolves after all runtime completions resolve", async () => {
  let resolveCompletion: () => void = () => {}
  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  setTimeout(resolveCompletion, 1)

  await waitForSimulationStopCompletions([completionPromise], 50)
})

test("simulation stop wait times out if a runtime completion does not resolve", async () => {
  await assert.rejects(
    waitForSimulationStopCompletions([new Promise<void>(() => {})], 1),
    SimulationStopTimeoutError
  )
})

test("simulation stop wait returns immediately with no runtime completions", async () => {
  await waitForSimulationStopCompletions([], 1)
})
