import assert from "node:assert/strict"
import test from "node:test"
import { getSimulationFinalParsedOutput } from "../src/lib/simulation-final-output.js"
import { formatDebugChunkBlocks } from "../src/lib/simulation-debug-chunks.js"
import {
  formatSimulationRunClipboardText,
  getSimulationRunActivityBlocks,
  getSimulationRunActiveToolCallName,
  getLoggedTurnAction,
  getSimulationResultEntries,
  getSimulationResultChunks,
  getSimulationRunThinkingPreview,
  hasSimulationRunFinalParsedOutputChunk,
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
    updatedResults?.openingHandLlmRuns[0].chunks.map((chunk) => chunk.sequence),
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

test("streams report runs and keeps report attempts sorted", () => {
  let results: SimulationResultsInfo | null = createResults()

  results = applySimulationResultsStreamEvent(results, {
    type: "llm_run_started",
    run: createRun({
      llmRunId: "report-run-2",
      phase: "report",
      attemptNumber: 2,
    }),
  })

  results = applySimulationResultsStreamEvent(results, {
    type: "llm_run_started",
    run: createRun({
      llmRunId: "report-run-1",
      phase: "report",
      attemptNumber: 1,
    }),
  })

  assert.equal(results?.reportLlmRunCount, 2)
  assert.deepEqual(
    results?.reportLlmRuns.map((run) => run.attemptNumber),
    [1, 2]
  )

  results = applySimulationResultsStreamEvent(results, {
    type: "chunk",
    llmRunId: "report-run-2",
    chunk: createChunk({ id: null, sequence: 1, outputDelta: "# Report" }),
  })

  assert.equal(results?.reportLlmRuns[1].chunks[0].outputDelta, "# Report")

  results = applySimulationResultsStreamEvent(results, {
    type: "llm_run_updated",
    run: createRun({
      llmRunId: "report-run-2",
      phase: "report",
      attemptNumber: 2,
      report: "# Report\n\nLooks good.",
      status: "completed",
    }),
  })

  assert.equal(results?.reportLlmRuns[1].status, "completed")
  assert.equal(results?.reportLlmRuns[1].report, "# Report\n\nLooks good.")
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

test("reads report final output from final parsed output chunks", () => {
  const parsedOutput = getSimulationFinalParsedOutput(
    createRun({
      llmRunId: "report-run",
      phase: "report",
      chunks: [
        createChunk({
          id: 1,
          sequence: 1,
          kind: "final_parsed_output",
          payload: {
            report: "# Simulation report\n\nThe opener converted cleanly.",
          },
        }),
      ],
    })
  )

  assert.deepEqual(parsedOutput, {
    type: "report",
    report: "# Simulation report\n\nThe opener converted cleanly.",
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

test("formats clipboard text from reasoning output lifecycle and tools", () => {
  const text = formatSimulationRunClipboardText(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      chunks: [
        createChunk({
          id: 1,
          kind: "reasoning_start",
          sequence: 1,
        }),
        createChunk({
          id: 2,
          kind: "reasoning_delta",
          reasoningDelta: "Evaluate opener.",
          sequence: 2,
        }),
        createChunk({
          id: 3,
          kind: "reasoning_done",
          sequence: 3,
        }),
        createChunk({
          id: 4,
          kind: "output_start",
          sequence: 4,
        }),
        createChunk({
          id: 5,
          outputDelta: "Keeping.",
          sequence: 5,
        }),
        createChunk({
          id: 6,
          kind: "output_done",
          sequence: 6,
        }),
        createChunk({
          id: 7,
          kind: "mcp_call_start",
          mcpFunctionName: "draw_starting_hand",
          payload: {
            item: {
              id: "call_1",
            },
          },
          sequence: 7,
        }),
        createChunk({
          id: 8,
          kind: "mcp_call_complete",
          mcpFunctionName: "draw_starting_hand",
          mcpFunctionOutput: {
            data: {
              cards: ["Forest"],
            },
          },
          payload: {
            item: {
              id: "call_1",
            },
          },
          sequence: 8,
        }),
      ],
    })
  )

  assert.equal(
    text,
    [
      "Evaluate opener.",
      "Keeping.",
      "[called draw_starting_hand]",
      `[result of draw_starting_hand]\n${JSON.stringify(
        {
          data: {
            cards: ["Forest"],
          },
        },
        null,
        2
      )}`,
    ].join("\n\n")
  )
})

test("prepends full prompt in clipboard text without labels", () => {
  const text = formatSimulationRunClipboardText(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      chunks: [
        createChunk({
          id: 1,
          outputDelta: "Run text",
          sequence: 1,
        }),
      ],
    }),
    { fullPrompt: "Prompt text" }
  )

  assert.equal(text, "Prompt text\n\nRun text")
})

test("keeps clipboard text chunks in sequence order", () => {
  const text = formatSimulationRunClipboardText(
    createRun({
      llmRunId: "opening-run",
      phase: "opening_hand",
      chunks: [
        createChunk({
          id: 2,
          outputDelta: "second",
          sequence: 2,
        }),
        createChunk({
          id: 1,
          outputDelta: "first ",
          sequence: 1,
        }),
      ],
    })
  )

  assert.equal(text, "first second")
})

test("adds tool name for unpaired completed tool clipboard text", () => {
  const text = formatSimulationRunClipboardText(
    createRun({
      llmRunId: "turn-run",
      phase: "turn",
      chunks: [
        createChunk({
          id: 1,
          kind: "mcp_call_complete",
          mcpFunctionName: "shuffle_library",
          mcpFunctionOutput: {
            ok: true,
          },
          sequence: 1,
        }),
      ],
    })
  )

  assert.equal(
    text,
    [
      "[called shuffle_library]",
      `[result of shuffle_library]\n${JSON.stringify({ ok: true }, null, 2)}`,
    ].join("\n\n")
  )
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

test("combines adjacent completed regular turn action log entries after hiding tool starts", () => {
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
        latestAction: {
          action: "Tap Command Tower for one mana.",
          phaseChange: null,
        },
        actions: ["Tap Command Tower for one mana."],
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
        latestAction: {
          action: "Cast Sol Ring using one mana.",
          phaseChange: null,
        },
        actions: [
          "Tap Command Tower for one mana.",
          "Cast Sol Ring using one mana.",
        ],
      },
      sequence: 4,
    }),
  ])

  assert.equal(resultEntries.length, 1)
  assert.equal(resultEntries[0]?.type, "turn_action_log")
  assert.deepEqual(
    resultEntries[0]?.type === "turn_action_log"
      ? resultEntries[0].actions.map((action) => action.action)
      : [],
    ["Tap Command Tower for one mana.", "Cast Sol Ring using one mana."]
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
        latestAction: {
          action: "Draw a card.",
          phaseChange: null,
        },
        actions: ["Draw a card."],
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
        latestAction: {
          action: "Play a land.",
          phaseChange: null,
        },
        actions: ["Draw a card.", "Play a land."],
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
      entry.type === "turn_action_log"
        ? entry.actions.map((action) => action.action)
        : []
    ),
    ["Draw a card.", "Play a land."]
  )
})

test("keeps phase change logs separate from regular turn action groups", () => {
  const resultEntries = getSimulationResultEntries([
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Tap Command Tower for one mana.",
          phaseChange: null,
        },
        actions: ["Tap Command Tower for one mana."],
      },
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Cast Sol Ring using one mana.",
          phaseChange: null,
        },
        actions: [
          "Tap Command Tower for one mana.",
          "Cast Sol Ring using one mana.",
        ],
      },
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Move to combat.",
          phaseChange: "combat",
        },
        actions: [
          "Tap Command Tower for one mana.",
          "Cast Sol Ring using one mana.",
          "Move to combat.",
        ],
      },
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Attack opponent 1 with the commander.",
          phaseChange: null,
        },
        actions: [
          "Tap Command Tower for one mana.",
          "Cast Sol Ring using one mana.",
          "Move to combat.",
          "Attack opponent 1 with the commander.",
        ],
      },
      sequence: 4,
    }),
  ])

  assert.equal(resultEntries.length, 3)
  assert.deepEqual(
    resultEntries.map((entry) =>
      entry.type === "turn_action_log"
        ? entry.actions.map((action) => action.action)
        : []
    ),
    [
      ["Tap Command Tower for one mana.", "Cast Sol Ring using one mana."],
      ["Move to combat."],
      ["Attack opponent 1 with the commander."],
    ]
  )
  assert.deepEqual(
    resultEntries.map((entry) =>
      entry.type === "turn_action_log"
        ? entry.actions.map((action) => action.phaseChange)
        : []
    ),
    [[null, null], ["combat"], [null]]
  )
})

test("keeps consecutive phase change logs as standalone entries", () => {
  const resultEntries = getSimulationResultEntries([
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Move to untap.",
          phaseChange: "untap",
        },
        actions: ["Move to untap."],
      },
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Move to upkeep.",
          phaseChange: "upkeep",
        },
        actions: ["Move to untap.", "Move to upkeep."],
      },
      sequence: 2,
    }),
  ])

  assert.equal(resultEntries.length, 2)
  assert.deepEqual(
    resultEntries.map((entry) =>
      entry.type === "turn_action_log"
        ? entry.actions.map((action) => action.phaseChange)
        : []
    ),
    [["untap"], ["upkeep"]]
  )
  assert.deepEqual(
    resultEntries.map((entry) =>
      entry.type === "turn_action_log"
        ? entry.chunks.map((chunk) => chunk.sequence)
        : []
    ),
    [[1], [2]]
  )
})

test("parses structured turn action log output", () => {
  const loggedAction = getLoggedTurnAction(
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: "log_turn_action",
      mcpFunctionOutput: {
        latestAction: {
          action: "Move to postcombat main.",
          phaseChange: "postcombat_main",
        },
        actions: ["Move to postcombat main."],
      },
      sequence: 1,
    })
  )

  assert.deepEqual(loggedAction, {
    action: "Move to postcombat main.",
    phaseChange: "postcombat_main",
  })
})

test("omits reasoning and output lifecycle chunks and deltas from result chunks", () => {
  const resultChunks = getSimulationResultChunks([
    createChunk({
      id: 1,
      kind: "reasoning_start",
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
      kind: "reasoning_done",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "output_start",
      sequence: 4,
    }),
    createChunk({
      id: 5,
      outputDelta: "Checking hand.",
      sequence: 5,
    }),
    createChunk({
      id: 6,
      kind: "output_done",
      sequence: 6,
    }),
    createChunk({
      id: 7,
      kind: "final_parsed_output",
      payload: {
        keptHand: ["Sol Ring", "Forest"],
        summary: "Kept a stable opener.",
      },
      sequence: 7,
    }),
  ])

  assert.deepEqual(
    resultChunks.map((chunk) => chunk.sequence),
    [7]
  )
})

test("builds a one-line thinking preview from reasoning and output deltas", () => {
  const preview = getSimulationRunThinkingPreview([
    createChunk({
      id: 1,
      kind: "reasoning_start",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "reasoning_delta",
      reasoningDelta: "Evaluating\nmana",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "reasoning_done",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "output_start",
      sequence: 4,
    }),
    createChunk({
      id: 5,
      outputDelta: " and\r\nkeeping.",
      sequence: 5,
    }),
    createChunk({
      id: 6,
      kind: "output_done",
      sequence: 6,
    }),
    createChunk({
      id: 7,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      sequence: 7,
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

test("omits output lifecycle text from activity blocks", () => {
  const blocks = getSimulationRunActivityBlocks([
    createChunk({
      id: 1,
      kind: "reasoning_start",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "reasoning_delta",
      reasoningDelta: "**Keep** ",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "reasoning_delta",
      reasoningDelta: "a two-land hand.",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "reasoning_done",
      sequence: 4,
    }),
    createChunk({
      id: 5,
      kind: "output_start",
      sequence: 5,
    }),
    createChunk({
      id: 6,
      outputDelta: "Keeping this opener.",
      sequence: 6,
    }),
    createChunk({
      id: 7,
      kind: "output_done",
      sequence: 7,
    }),
  ])

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["reasoning"]
  )
  assert.equal(
    blocks[0]?.type === "reasoning" ? blocks[0].text : "",
    "**Keep** a two-land hand."
  )
})

test("separates activity reasoning blocks by summary part index", () => {
  const blocks = getSimulationRunActivityBlocks([
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "I am checking mana for the signet.",
      payload: createReasoningSummaryDeltaPayload(0),
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "reasoning_delta",
      reasoningDelta: "Calculating available mana\n\nSol Ring can pay for it.",
      payload: createReasoningSummaryDeltaPayload(1),
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "reasoning_delta",
      reasoningDelta: "Reviewing mana options\n\nThe signet can make red.",
      payload: createReasoningSummaryDeltaPayload(2),
      sequence: 3,
    }),
  ])

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["reasoning", "reasoning", "reasoning"]
  )
  assert.deepEqual(
    blocks.map((block) => (block.type === "reasoning" ? block.text : "")),
    [
      "I am checking mana for the signet.",
      "Calculating available mana\n\nSol Ring can pay for it.",
      "Reviewing mana options\n\nThe signet can make red.",
    ]
  )
})

test("separates clipboard reasoning blocks by summary part index", () => {
  const text = formatSimulationRunClipboardText(
    createRun({
      llmRunId: "turn-run",
      phase: "turn",
      chunks: [
        createChunk({
          id: 1,
          kind: "reasoning_delta",
          reasoningDelta: "I am checking mana for the signet.",
          payload: createReasoningSummaryDeltaPayload(0),
          sequence: 1,
        }),
        createChunk({
          id: 2,
          kind: "reasoning_delta",
          reasoningDelta: "Calculating available mana",
          payload: createReasoningSummaryDeltaPayload(1),
          sequence: 2,
        }),
        createChunk({
          id: 3,
          kind: "reasoning_delta",
          reasoningDelta: " after Sol Ring.",
          payload: createReasoningSummaryDeltaPayload(1),
          sequence: 3,
        }),
      ],
    })
  )

  assert.equal(
    text,
    [
      "I am checking mana for the signet.",
      "Calculating available mana after Sol Ring.",
    ].join("\n\n")
  )
})

test("omits output deltas and keeps them as activity block boundaries", () => {
  const blocks = getSimulationRunActivityBlocks([
    createChunk({
      id: 1,
      kind: "reasoning_delta",
      reasoningDelta: "First ",
      sequence: 1,
    }),
    createChunk({
      id: 2,
      kind: "reasoning_delta",
      reasoningDelta: "thought.",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      outputDelta: "Visible output.",
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "reasoning_delta",
      reasoningDelta: "Second thought.",
      sequence: 4,
    }),
  ])

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["reasoning", "reasoning"]
  )
  assert.equal(
    blocks[0]?.type === "reasoning" ? blocks[0].text : "",
    "First thought."
  )
  assert.equal(
    blocks[1]?.type === "reasoning" ? blocks[1].text : "",
    "Second thought."
  )
})

test("formats activity tool calls once with only tool names", () => {
  const blocks = getSimulationRunActivityBlocks([
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
      reasoningDelta: "Checking the hand.",
      sequence: 2,
    }),
    createChunk({
      id: 3,
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      payload: {
        item: {
          id: "call_1",
        },
      },
      sequence: 3,
    }),
    createChunk({
      id: 4,
      kind: "mcp_call_start",
      mcpFunctionName: "mulligan",
      sequence: 4,
    }),
  ])

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["tool_call", "reasoning", "tool_call"]
  )
  assert.deepEqual(
    blocks.flatMap((block) =>
      block.type === "tool_call" ? [block.toolName] : []
    ),
    ["draw_starting_hand", "mulligan"]
  )
})

test("formats unnamed activity tool calls as unknown tools", () => {
  const blocks = getSimulationRunActivityBlocks([
    createChunk({
      id: 1,
      kind: "mcp_call_complete",
      mcpFunctionName: null,
      sequence: 1,
    }),
  ])

  assert.equal(blocks[0]?.type, "tool_call")
  assert.equal(
    blocks[0]?.type === "tool_call" ? blocks[0].toolName : "",
    "Unknown tool"
  )
})

test("detects final parsed output chunks for active-run thinking visibility", () => {
  assert.equal(
    hasSimulationRunFinalParsedOutputChunk([
      createChunk({
        id: 1,
        kind: "reasoning_delta",
        reasoningDelta: "Evaluating hand.",
        sequence: 1,
      }),
      createChunk({
        id: 2,
        kind: "final_parsed_output",
        payload: {
          keptHand: ["Sol Ring", "Forest"],
          summary: "Kept a stable opener.",
        },
        sequence: 2,
      }),
    ]),
    true
  )

  assert.equal(
    hasSimulationRunFinalParsedOutputChunk([
      createChunk({
        id: 1,
        kind: "reasoning_delta",
        reasoningDelta: "Evaluating hand.",
        sequence: 1,
      }),
    ]),
    false
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
  reportLlmRuns = [],
  turnLlmRuns = [],
}: {
  openingHandLlmRuns?: SimulationDebugLlmRun[]
  reportLlmRuns?: SimulationDebugLlmRun[]
  turnLlmRuns?: SimulationDebugLlmRun[]
} = {}): SimulationResultsInfo {
  return {
    simulationId: "simulation-id",
    openingHandLlmRunCount: openingHandLlmRuns.length,
    reportLlmRunCount: reportLlmRuns.length,
    turnLlmRunCount: turnLlmRuns.length,
    openingHandLlmRuns,
    reportLlmRuns,
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
  report?: string
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
    report: overrides.report,
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

function createReasoningSummaryDeltaPayload(summaryIndex: number) {
  return {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_1",
    output_index: 0,
    summary_index: summaryIndex,
  }
}
