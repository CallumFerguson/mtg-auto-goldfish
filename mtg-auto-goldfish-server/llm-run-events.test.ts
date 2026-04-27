import assert from "node:assert/strict"
import test from "node:test"
import {
  ProviderTerminalEventError,
  createCancellationChunk,
  normalizeOpenAiStreamEvent,
  parseOpeningHandFromResponseText,
} from "./llm-run-events.js"
import {
  SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
  isValidCompletedOpeningHand,
} from "./simulations-postgres.js"

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

test("normal results exclude only raw and completed chunks", () => {
  assert.deepEqual(SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS, [
    "raw_event",
    "completed",
  ])
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
