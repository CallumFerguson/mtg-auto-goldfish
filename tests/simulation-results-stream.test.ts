import assert from "node:assert/strict"
import test from "node:test"
import { getSimulationFinalParsedOutput } from "../src/lib/simulation-final-output.js"
import { formatDebugChunkBlocks } from "../src/lib/simulation-debug-chunks.js"
import {
  getSimulationRunActiveToolCallName,
  getSimulationResultEntries,
  getSimulationResultChunks,
  getSimulationRunThinkingPreview,
} from "../src/lib/simulation-result-chunks.js"
import {
  getKnownSimulationResultToolLabel,
  getKnownSimulationResultToolLabelForChunk,
} from "../src/lib/simulation-result-tool-labels.js"
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

test("keeps card mentions from first streamed persisted chunks", () => {
  const results = createResults({
    openingHandLlmRuns: [
      createRun({
        llmRunId: "opening-run",
        phase: "opening_hand",
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "chunk",
    llmRunId: "opening-run",
    chunk: createChunk({
      id: 20,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      mcpFunctionOutput: {
        data: {
          cards: ["Sol Ring", "Mega Fake Lotus"],
        },
      },
      sequence: 1,
      cardMentions: [
        {
          requestedName: "Sol Ring",
          resolutionStatus: "exact",
          resolvedName: "Sol Ring",
          scryfallUri: "https://scryfall.com/card/test/1/sol-ring",
          defaultImageUrl: "https://cards.example/sol-ring.jpg",
        },
        {
          requestedName: "Mega Fake Lotus",
          resolutionStatus: "missing",
          resolvedName: null,
          scryfallUri: null,
          defaultImageUrl: null,
        },
      ],
    }),
  })

  assert.deepEqual(
    updatedResults?.openingHandLlmRuns[0].chunks[0].cardMentions,
    [
      {
        requestedName: "Sol Ring",
        resolutionStatus: "exact",
        resolvedName: "Sol Ring",
        scryfallUri: "https://scryfall.com/card/test/1/sol-ring",
        defaultImageUrl: "https://cards.example/sol-ring.jpg",
      },
      {
        requestedName: "Mega Fake Lotus",
        resolutionStatus: "missing",
        resolvedName: null,
        scryfallUri: null,
        defaultImageUrl: null,
      },
    ]
  )
})

test("keeps card mentions from final parsed output chunks", () => {
  const results = createResults({
    openingHandLlmRuns: [
      createRun({
        llmRunId: "opening-run",
        phase: "opening_hand",
      }),
    ],
  })

  const updatedResults = applySimulationResultsStreamEvent(results, {
    type: "chunk",
    llmRunId: "opening-run",
    chunk: createChunk({
      id: 21,
      kind: "final_parsed_output",
      sequence: 1,
      payload: {
        keptHand: ["Sol Ring", "Mega Fake Lotus"],
        summary: "Kept a hand.",
      },
      cardMentions: [
        {
          requestedName: "Sol Ring",
          resolutionStatus: "exact",
          resolvedName: "Sol Ring",
          scryfallUri: "https://scryfall.com/card/test/1/sol-ring",
          defaultImageUrl: "https://cards.example/sol-ring.jpg",
        },
        {
          requestedName: "Mega Fake Lotus",
          resolutionStatus: "missing",
          resolvedName: null,
          scryfallUri: null,
          defaultImageUrl: null,
        },
      ],
    }),
  })

  assert.deepEqual(
    updatedResults?.openingHandLlmRuns[0].chunks[0].cardMentions,
    [
      {
        requestedName: "Sol Ring",
        resolutionStatus: "exact",
        resolvedName: "Sol Ring",
        scryfallUri: "https://scryfall.com/card/test/1/sol-ring",
        defaultImageUrl: "https://cards.example/sol-ring.jpg",
      },
      {
        requestedName: "Mega Fake Lotus",
        resolutionStatus: "missing",
        resolvedName: null,
        scryfallUri: null,
        defaultImageUrl: null,
      },
    ]
  )
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

test("reads opening hand final output from final parsed output chunks", () => {
  const parsedOutput = getSimulationFinalParsedOutput(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          kind: "final_parsed_output",
          payload: {
            keptHand: ["Forest", "Sol Ring"],
            summary: "Kept a stable opener.",
          },
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

test("does not parse raw output deltas as final output", () => {
  const parsedOutput = getSimulationFinalParsedOutput(
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

  assert.equal(parsedOutput, null)
})

test("reads turn final output from final parsed output chunks", () => {
  const parsedOutput = getSimulationFinalParsedOutput(
    createRun({
      llmRunId: "turn-run",
      phase: "turn",
      turnNumber: 1,
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          kind: "final_parsed_output",
          payload: {
            gameState: "Hand: Forest\nBattlefield: Island",
            summary: "Played Island and passed.",
          },
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

test("ignores invalid final parsed output payloads", () => {
  const parsedOutput = getSimulationFinalParsedOutput(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      chunks: [
        createChunk({
          id: null,
          sequence: 1,
          kind: "final_parsed_output",
          payload: {
            keptHand: ["Forest"],
          },
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
    [4]
  )
})

test("hides the latest active tool start from result chunks", () => {
  const resultChunks = getSimulationResultChunks([
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_start",
      mcpFunctionName: "mulligan",
      sequence: 2,
    }),
  ])

  assert.deepEqual(
    resultChunks.map((chunk) => chunk.sequence),
    [1]
  )
})

test("reads active tool call name from the latest tool start chunk", () => {
  const activeToolCallName = getSimulationRunActiveToolCallName([
    createChunk({
      id: 2,
      kind: "mcp_call_start",
      mcpFunctionName: "draw_starting_hand",
      sequence: 2,
    }),
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "Need a hand.",
      sequence: 1,
    }),
  ])

  assert.equal(activeToolCallName, "draw_starting_hand")
})

test("clears active tool call name once a newer chunk arrives", () => {
  const activeToolCallName = getSimulationRunActiveToolCallName([
    createChunk({
      id: 1,
      kind: "mcp_call_start",
      mcpFunctionName: "draw_starting_hand",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      sequence: 2,
    }),
  ])

  assert.equal(activeToolCallName, null)
})

test("combines adjacent completed turn action log entries after hiding tool starts", () => {
  const resultEntries = getSimulationResultEntries([
    createChunk({
      id: 1,
      kind: "mcp_call_start",
      mcpFunctionName: "log_turn_action",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        data: {
          loggedActions: ["Move to precombat main phase."],
        },
      },
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "mcp_call_start",
      mcpFunctionName: "log_turn_action",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        data: {
          loggedActions: [
            "Move to precombat main phase.",
            "Cast Sol Ring.",
          ],
        },
      },
      sequence: 4,
    }),
  ])

  assert.equal(resultEntries.length, 1)
  assert.equal(resultEntries[0]?.type, "turn_action_log")
  assert.deepEqual(
    resultEntries[0]?.type === "turn_action_log"
      ? resultEntries[0].actions
      : [],
    ["Move to precombat main phase.", "Cast Sol Ring."]
  )
  assert.deepEqual(
    resultEntries[0]?.type === "turn_action_log"
      ? resultEntries[0].chunks.map((chunk) => chunk.sequence)
      : [],
    [2, 4]
  )
})

test("keeps turn action log groups separated by other visible events", () => {
  const resultEntries = getSimulationResultEntries([
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        message: "Logged action: Move to draw step.",
      },
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_card_from_top",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: JSON.stringify({
        data: {
          loggedActions: ["Move to draw step.", "Draw a card."],
        },
      }),
      sequence: 3,
    }),
  ])

  assert.deepEqual(
    resultEntries.map((entry) => entry.type),
    ["turn_action_log", "chunk", "turn_action_log"]
  )
  assert.deepEqual(
    resultEntries.flatMap((entry) =>
      entry.type === "turn_action_log" ? entry.actions : []
    ),
    ["Move to draw step.", "Draw a card."]
  )
})

test("omits reasoning and output deltas from result chunks", () => {
  const resultChunks = getSimulationResultChunks([
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "Need to inspect the opener.",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      outputDelta: "Checking hand.",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "final_parsed_output",
      payload: {
        keptHand: ["Sol Ring", "Forest"],
        summary: "Kept a stable opener.",
      },
      sequence: 3,
    }),
  ])

  assert.deepEqual(
    resultChunks.map((chunk) => chunk.sequence),
    [3]
  )
})

test("builds a one-line thinking preview from reasoning and output deltas", () => {
  const preview = getSimulationRunThinkingPreview([
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "Evaluating\nmana",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      outputDelta: " and\r\nkeeping.",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      sequence: 3,
    }),
  ])

  assert.equal(preview, "Evaluating mana and keeping.")
})

test("keeps thinking preview deltas in sequence order", () => {
  const preview = getSimulationRunThinkingPreview([
    createChunk({
      id: 2,
      outputDelta: "second",
      sequence: 2,
    }),
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "first ",
      sequence: 1,
    }),
  ])

  assert.equal(preview, "first second")
})

test("limits thinking preview to the latest 100 delta chunks", () => {
  const chunks = Array.from({ length: 101 }, (_, index) =>
    createChunk({
      id: index + 1,
      outputDelta: `${index + 1},`,
      sequence: index + 1,
    })
  )

  const preview = getSimulationRunThinkingPreview(chunks)

  assert.ok(preview?.startsWith("2,"))
  assert.ok(preview?.endsWith("101,"))
})

test("returns null for empty thinking previews", () => {
  assert.equal(
    getSimulationRunThinkingPreview([
      createChunk({
        id: 1,
        kind: "reasoning_delta",
        reasoningDelta: " \n\t",
        sequence: 1,
      }),
      createChunk({
        id: 2,
        kind: "mcp_call_complete",
        mcpFunctionName: "draw_starting_hand",
        sequence: 2,
      }),
    ]),
    null
  )
})

test("formats known active and started tool events as deck actions", () => {
  assert.equal(
    getKnownSimulationResultToolLabel({
      mcpFunctionName: "draw_card_from_top",
      state: "active",
    }),
    "Drawing card from top of deck"
  )
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 1,
        kind: "mcp_call_start",
        mcpFunctionName: "shuffle_library",
        sequence: 1,
      }),
      state: "started",
    }),
    "Shuffling deck"
  )
})

test("formats known completed draw and return events with result details", () => {
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 1,
        kind: "mcp_call_complete",
        mcpFunctionName: "draw_card_from_bottom",
        mcpFunctionOutput: {
          data: {
            cards: ["Forest", "Island"],
          },
        },
        sequence: 1,
      }),
      state: "completed",
    }),
    "Drew 2 cards from bottom of deck"
  )
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 2,
        kind: "mcp_call_complete",
        mcpFunctionName: "return_cards_to_library",
        mcpFunctionOutput: {
          data: {
            cards: ["Forest", "Island"],
            randomizeOrder: false,
            side: "bottom",
          },
        },
        sequence: 2,
      }),
      state: "completed",
    }),
    "Returned 2 cards to bottom of deck"
  )
})

test("formats known completed single return, search, mulligan, and shuffle events", () => {
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 1,
        kind: "mcp_call_complete",
        mcpFunctionName: "return_card_to_library",
        mcpFunctionOutput: {
          data: {
            card: "Sol Ring",
            position: 2,
            side: "top",
          },
        },
        sequence: 1,
      }),
      state: "completed",
    }),
    "Returned Sol Ring to deck with 2 cards above it"
  )
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 2,
        kind: "mcp_call_complete",
        mcpFunctionName: "take_cards_from_library",
        mcpFunctionOutput: {
          data: {
            foundCards: ["Sol Ring"],
            requestedCards: ["Sol Ring", "Mana Crypt"],
          },
        },
        sequence: 2,
      }),
      state: "completed",
    }),
    "Found 1 of 2 requested cards in deck"
  )
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 3,
        kind: "mcp_call_complete",
        mcpFunctionName: "mulligan",
        mcpFunctionOutput: {
          data: {
            mulliganCount: 2,
          },
        },
        sequence: 3,
      }),
      state: "completed",
    }),
    "Took mulligan 2 and drew a replacement hand"
  )
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 4,
        kind: "mcp_call_complete",
        mcpFunctionName: "shuffle_library",
        sequence: 4,
      }),
      state: "completed",
    }),
    "Shuffled deck"
  )
})

test("formats known failed tool events without raw tool names", () => {
  assert.equal(
    getKnownSimulationResultToolLabelForChunk({
      chunk: createChunk({
        id: 1,
        kind: "mcp_call_complete",
        mcpFunctionName: "draw_card_from_top",
        sequence: 1,
      }),
      state: "failed",
    }),
    "Could not draw card from top of deck"
  )
})

test("keeps unknown tool events available for diagnostic fallback", () => {
  assert.equal(
    getKnownSimulationResultToolLabel({
      mcpFunctionName: "unknown_tool",
      state: "completed",
    }),
    null
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
  cancelledAt?: string | null
  chunks?: ReturnType<typeof createChunk>[]
  completedAt?: string | null
  createdAt?: string
  failedAt?: string | null
  openrouterGenerations?: SimulationDebugLlmRun["openrouterGenerations"]
  provider?: string
  startedAt?: string | null
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
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    startedAt: overrides.startedAt ?? "2026-01-01T00:00:01.000Z",
    completedAt: overrides.completedAt ?? null,
    failedAt: overrides.failedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    turnNumber: overrides.turnNumber,
    openrouterGenerations: overrides.openrouterGenerations ?? [],
    chunks: overrides.chunks ?? [],
  }
}

function createChunk(overrides: {
  cardMentions?: SimulationDebugLlmRunChunk["cardMentions"]
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
    cardMentions: overrides.cardMentions ?? [],
    receivedAt: "2026-01-01T00:00:00.000Z",
  }
}
