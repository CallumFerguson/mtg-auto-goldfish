import assert from "node:assert/strict"
import test from "node:test"
import {
  ModelReportedSimulationError,
  ProviderTerminalEventError,
  createCancellationChunk,
  createFinalParsedOutputChunk,
  createLlamaCppCompletedChunk,
  createLlamaCppMessageDeltaChunk,
  createLlamaCppToolCallCompleteChunk,
  createLlamaCppToolCallStartChunk,
  getCompletedResponseOutputText,
  getOpenRouterGenerationIdFromCompletedEvent,
  isAbortError,
  normalizeOpenAiStreamEvent,
  normalizeOpenRouterStreamEvent,
  parseOpeningHandCompletionFromResponseText,
  parseOpeningHandFromResponseText,
  parseTurnSimulationCompletionFromResponseText,
  parseTurnSimulationFromResponseText,
} from "./llm-run-events.js"
import {
  INVALID_OPENING_HAND_SIMULATION_FAILURE_MESSAGE,
  LLM_CHUNK_KINDS,
  OPENING_HAND_EVALUATION_UPSERT_SQL,
  SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
  STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE,
  STALE_RUNNING_SIMULATION_CANCELLATION_MESSAGE,
  TURN_EVALUATION_UPSERT_SQL,
  buildAppendLlmRunChunksQuery,
  canApplyLateLlmRunTerminalUpdate,
  extractLlmRunChunkCardMentionRequests,
  getOpeningHandCompletionDecision,
  getSimulationCreationDecision,
  getTurnCompletionDecision,
  isValidCompletedOpeningHand,
} from "./simulations-postgres.js"
import {
  SimulationStopTimeoutError,
  waitForSimulationStopCompletions,
} from "./simulation-stop.js"
import {
  callWithRuntimeAbortSignal,
  forEachRuntimeAbortableAsync,
  registerRuntimeAbortHandler,
  throwIfRuntimeAborted,
} from "./llm-runtime-cancellation.js"
import {
  aggregateOpenRouterUsage,
  estimateLlmTokenPriceCents,
  estimateOpenAiTokenPriceCents,
} from "./openai-pricing.js"
import {
  LlmConfigurationError,
  getEvaluationLlmRunConfig,
  getLlmRunQueueConfig,
  getOpeningHandLlmRunConfig,
  getTurnSimulationLlmRunConfig,
} from "./llm-config.js"
import { canClaimQueuedLlmRunWithCapacity } from "./llm-run-queue.js"
import {
  buildOpeningHandEvaluationInputText,
  buildTurnEvaluationInputText,
  getOpeningHandEvaluationIneligibilityMessage,
  getTurnEvaluationIneligibilityMessage,
  parseOpeningHandEvaluationResponseText,
  parseTurnEvaluationResponseText,
} from "./turn-evaluations.js"

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
  assert.equal(chunk.mcpFunctionReason, null)
})

test("normalizes MCP output reason from nested tool result data", () => {
  const chunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "mcp_call",
      name: "draw_starting_hand",
      output: JSON.stringify({
        message: "Drew the starting hand.",
        data: {
          cards: ["Sol Ring"],
          reason: " Opening 7 ",
        },
      }),
    },
  })

  assert.equal(chunk.kind, "mcp_call_complete")
  assert.equal(chunk.mcpFunctionReason, "Opening 7")
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
  assert.equal(chunk.mcpFunctionReason, null)
})

test("builds chunk inserts with extracted MCP function reason", () => {
  const query = buildAppendLlmRunChunksQuery(
    "00000000-0000-0000-0000-000000000001",
    [
      {
        sequence: 1,
        kind: "mcp_call_complete",
        mcpFunctionName: "return_cards_to_library",
        mcpFunctionOutput: {
          message: "Returned cards.",
          data: {
            cards: ["Sol Ring"],
            reason: " Bottoming after mulligan ",
          },
        },
        mcpFunctionReason: null,
        reasoningDelta: null,
        outputDelta: null,
        payload: {},
      },
    ]
  )

  assert.match(query.text, /mcp_function_reason/)
  assert.equal(query.values[5], "Bottoming after mulligan")
})

test("normalizes OpenAI reasoning and output item lifecycle events", () => {
  const reasoningStartChunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.added",
    item: {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      status: "in_progress",
    },
  })
  const reasoningDoneChunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      status: "completed",
    },
  })
  const outputStartChunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.added",
    item: {
      type: "message",
      id: "msg_1",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  })
  const outputDoneChunk = normalizeOpenAiStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [],
    },
  })

  assert.equal(reasoningStartChunk.kind, "reasoning_start")
  assert.equal(reasoningDoneChunk.kind, "reasoning_done")
  assert.equal(outputStartChunk.kind, "output_start")
  assert.equal(outputDoneChunk.kind, "output_done")
})

test("normalizes OpenAI reasoning summary part lifecycle events", () => {
  const summaryStartChunk = normalizeOpenAiStreamEvent({
    type: "response.reasoning_summary_part.added",
    item_id: "rs_1",
    output_index: 0,
    part: {
      text: "",
      type: "summary_text",
    },
    sequence_number: 1,
    summary_index: 0,
  })
  const summaryDoneChunk = normalizeOpenAiStreamEvent({
    type: "response.reasoning_summary_part.done",
    item_id: "rs_1",
    output_index: 0,
    part: {
      text: "Checking mana.",
      type: "summary_text",
    },
    sequence_number: 2,
    summary_index: 0,
  })

  assert.equal(summaryStartChunk.kind, "reasoning_start")
  assert.equal(summaryDoneChunk.kind, "reasoning_done")
})

test("extracts card mentions from draw tool output data", () => {
  assert.deepEqual(
    extractLlmRunChunkCardMentionRequests({
      kind: "mcp_call_complete",
      mcpFunctionName: "draw_starting_hand",
      mcpFunctionOutput: {
        data: {
          cards: ["Sol Ring", "Mega Fake Lotus", "Sol Ring"],
        },
      },
      payload: {},
    }),
    [
      {
        sourcePath: "data.cards",
        position: 0,
        requestedName: "Sol Ring",
      },
      {
        sourcePath: "data.cards",
        position: 1,
        requestedName: "Mega Fake Lotus",
      },
      {
        sourcePath: "data.cards",
        position: 2,
        requestedName: "Sol Ring",
      },
    ]
  )
})

test("extracts one card mention per library search match", () => {
  assert.deepEqual(
    extractLlmRunChunkCardMentionRequests({
      kind: "mcp_call_complete",
      mcpFunctionName: "take_cards_from_library",
      mcpFunctionOutput: {
        data: {
          foundCards: ["Sol Ring"],
          matches: [
            {
              requestedCard: "Sool Ring",
              foundCard: "Sol Ring",
            },
            {
              requestedCard: "Imaginary Tutor",
              foundCard: null,
            },
          ],
        },
      },
      payload: {},
    }),
    [
      {
        sourcePath: "data.matches[*].foundCard",
        position: 0,
        requestedName: "Sol Ring",
      },
      {
        sourcePath: "data.matches[*].requestedCard",
        position: 1,
        requestedName: "Imaginary Tutor",
      },
    ]
  )
})

test("does not duplicate exact library search mentions across output fields", () => {
  assert.deepEqual(
    extractLlmRunChunkCardMentionRequests({
      kind: "mcp_call_complete",
      mcpFunctionName: "take_cards_from_library",
      mcpFunctionOutput: {
        data: {
          foundCards: ["Forest"],
          requestedCards: ["Forest"],
          matches: [
            {
              requestedCard: "Forest",
              foundCard: "Forest",
            },
          ],
        },
      },
      payload: {},
    }),
    [
      {
        sourcePath: "data.matches[*].foundCard",
        position: 0,
        requestedName: "Forest",
      },
    ]
  )
})

test("keeps repeated library search mentions when multiple copies are taken", () => {
  assert.deepEqual(
    extractLlmRunChunkCardMentionRequests({
      kind: "mcp_call_complete",
      mcpFunctionName: "take_cards_from_library",
      mcpFunctionOutput: {
        data: {
          foundCards: ["Forest", "Forest"],
          requestedCards: ["Forest", "Forest"],
          matches: [
            {
              requestedCard: "Forest",
              foundCard: "Forest",
            },
            {
              requestedCard: "Forest",
              foundCard: "Forest",
            },
          ],
        },
      },
      payload: {},
    }),
    [
      {
        sourcePath: "data.matches[*].foundCard",
        position: 0,
        requestedName: "Forest",
      },
      {
        sourcePath: "data.matches[*].foundCard",
        position: 1,
        requestedName: "Forest",
      },
    ]
  )
})

test("extracts card mentions from opening-hand final parsed output", () => {
  assert.deepEqual(
    extractLlmRunChunkCardMentionRequests({
      kind: "final_parsed_output",
      mcpFunctionName: null,
      mcpFunctionOutput: null,
      payload: {
        keptHand: ["Sol Ring", "Command Tower", "Mega Fake Lotus"],
        summary: "Kept a hand.",
      },
    }),
    [
      {
        sourcePath: "payload.keptHand",
        position: 0,
        requestedName: "Sol Ring",
      },
      {
        sourcePath: "payload.keptHand",
        position: 1,
        requestedName: "Command Tower",
      },
      {
        sourcePath: "payload.keptHand",
        position: 2,
        requestedName: "Mega Fake Lotus",
      },
    ]
  )
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

test("uses OpenRouter reported usage cost when estimating LLM price", () => {
  const estimate = estimateLlmTokenPriceCents({
    provider: "openrouter",
    model: "openai/gpt-5-nano",
    usage: {
      cost: 0.00125,
    },
  })

  assert.equal(estimate?.formattedCents, "0.1")
})

test("does not estimate local llama.cpp inference prices", () => {
  const estimate = estimateLlmTokenPriceCents({
    provider: "llamacpp",
    model: "local-model",
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
    },
  })

  assert.equal(estimate, null)
})

test("aggregates OpenRouter usage across agent turns", () => {
  const usage = aggregateOpenRouterUsage([
    {
      inputTokens: 100,
      inputTokensDetails: {
        cachedTokens: 25,
      },
      outputTokens: 40,
      outputTokensDetails: {
        reasoningTokens: 10,
      },
      totalTokens: 140,
      cost: 0.125,
      costDetails: {
        upstreamInferenceCost: 0.0625,
        upstreamInferenceInputCost: 0.03125,
        upstreamInferenceOutputCost: 0.03125,
      },
    },
    {
      input_tokens: 200,
      input_tokens_details: {
        cached_tokens: 50,
      },
      output_tokens: 80,
      output_tokens_details: {
        reasoning_tokens: 20,
      },
      total_tokens: 280,
      cost: 0.25,
      cost_details: {
        upstream_inference_cost: 0.125,
        upstream_inference_input_cost: 0.0625,
        upstream_inference_output_cost: 0.0625,
      },
    },
  ])

  assert.deepEqual(usage, {
    inputTokens: 300,
    inputTokensDetails: {
      cachedTokens: 75,
    },
    outputTokens: 120,
    outputTokensDetails: {
      reasoningTokens: 30,
    },
    totalTokens: 420,
    cost: 0.375,
    costDetails: {
      upstreamInferenceCost: 0.1875,
      upstreamInferenceInputCost: 0.09375,
      upstreamInferenceOutputCost: 0.09375,
    },
  })
  assert.equal(
    estimateLlmTokenPriceCents({
      provider: "openrouter",
      model: "openai/gpt-5-nano",
      usage,
    })?.formattedCents,
    "37.5"
  )
})

test("requires LLM_PROVIDER for LLM config", () => {
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        OPENAI_API_KEY: "key",
        OPENAI_MODEL: "gpt-5.4-mini",
        OPENAI_REASONING_EFFORT: "medium",
        OPENING_HAND_MCP_PUBLIC_URL: "https://example.com/mcp",
      }),
    LlmConfigurationError
  )
})

test("requires a positive integer OpenRouter stop step count", () => {
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "openrouter",
        LLM_MAX_OUTPUT_TOKENS: "12000",
        OPENROUTER_STOP_WHEN_STEP_COUNT: "0",
        OPENROUTER_API_KEY: "key",
        OPENROUTER_MODEL: "openai/gpt-5-nano",
        OPENROUTER_REASONING_EFFORT: "medium",
      }),
    /OPENROUTER_STOP_WHEN_STEP_COUNT must be a positive integer\./
  )
})

test("requires a positive shared max output token count", () => {
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        OPENAI_MODEL: "gpt-5.4-mini",
        OPENAI_REASONING_EFFORT: "medium",
        OPENING_HAND_MCP_PUBLIC_URL: "https://example.com/mcp",
      }),
    /LLM_MAX_OUTPUT_TOKENS/
  )
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "openai",
        LLM_MAX_OUTPUT_TOKENS: "0",
        OPENAI_API_KEY: "key",
        OPENAI_MODEL: "gpt-5.4-mini",
        OPENAI_REASONING_EFFORT: "medium",
        OPENING_HAND_MCP_PUBLIC_URL: "https://example.com/mcp",
      }),
    /LLM_MAX_OUTPUT_TOKENS must be a positive integer\./
  )
})

test("requires positive LLM run queue concurrency limits", () => {
  assert.throws(
    () => getLlmRunQueueConfig({}),
    /LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS/
  )
  assert.throws(
    () =>
      getLlmRunQueueConfig({
        LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS: "50",
        LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS_PER_USER: "0",
      }),
    /LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS_PER_USER must be a positive integer\./
  )

  assert.deepEqual(
    getLlmRunQueueConfig({
      LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS: "50",
      LLM_RUN_QUEUE_MAX_CONCURRENT_RUNS_PER_USER: "5",
    }),
    {
      maxConcurrentRuns: 50,
      maxConcurrentRunsPerUser: 5,
    }
  )
})

test("checks LLM run queue capacity before claiming", () => {
  assert.equal(
    canClaimQueuedLlmRunWithCapacity({
      activeOwnerUserIds: ["user-1", "user-2"],
      candidateOwnerUserId: "user-1",
      candidateQueuedAt: "2026-01-01T00:00:00.000Z",
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerUser: 5,
    }),
    false
  )
  assert.equal(
    canClaimQueuedLlmRunWithCapacity({
      activeOwnerUserIds: ["user-1", "user-1"],
      candidateOwnerUserId: "user-1",
      candidateQueuedAt: "2026-01-01T00:00:00.000Z",
      maxConcurrentRuns: 50,
      maxConcurrentRunsPerUser: 2,
    }),
    false
  )
  assert.equal(
    canClaimQueuedLlmRunWithCapacity({
      activeOwnerUserIds: [null, null],
      candidateOwnerUserId: null,
      candidateQueuedAt: "2026-01-01T00:00:00.000Z",
      maxConcurrentRuns: 50,
      maxConcurrentRunsPerUser: 2,
    }),
    false
  )
  assert.equal(
    canClaimQueuedLlmRunWithCapacity({
      activeOwnerUserIds: ["user-1", "user-1"],
      candidateOwnerUserId: "user-2",
      candidateQueuedAt: "2026-01-01T00:00:00.000Z",
      maxConcurrentRuns: 50,
      maxConcurrentRunsPerUser: 2,
    }),
    true
  )
  assert.equal(
    canClaimQueuedLlmRunWithCapacity({
      activeOwnerUserIds: [],
      candidateOwnerUserId: "user-1",
      candidateQueuedAt: null,
      maxConcurrentRuns: 50,
      maxConcurrentRunsPerUser: 5,
    }),
    false
  )
})

test("rejects invalid provider and reasoning effort config", () => {
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "anthropic",
      }),
    /LLM_PROVIDER must be one of: openai, openrouter, llamacpp\./
  )
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "openrouter",
        LLM_MAX_OUTPUT_TOKENS: "12000",
        OPENROUTER_STOP_WHEN_STEP_COUNT: "3",
        OPENROUTER_API_KEY: "key",
        OPENROUTER_MODEL: "openai/gpt-5-nano",
        OPENROUTER_REASONING_EFFORT: "maximum",
      }),
    /OPENROUTER_REASONING_EFFORT must be one of: none, minimal, low, medium, high, xhigh\./
  )
})

test("validates provider-specific LLM config requirements", () => {
  assert.throws(
    () =>
      getTurnSimulationLlmRunConfig({
        LLM_PROVIDER: "openai",
        LLM_MAX_OUTPUT_TOKENS: "12000",
        OPENAI_API_KEY: "key",
        OPENAI_MODEL: "gpt-5.4-mini",
        OPENAI_REASONING_EFFORT: "medium",
      }),
    /TURN_SIMULATION_MCP_PUBLIC_URL/
  )

  const config = getOpeningHandLlmRunConfig({
    LLM_PROVIDER: "openrouter",
    LLM_MAX_OUTPUT_TOKENS: "12000",
    OPENROUTER_STOP_WHEN_STEP_COUNT: "7",
    OPENROUTER_API_KEY: "key",
    OPENROUTER_MODEL: "openai/gpt-5-nano",
    OPENROUTER_REASONING_EFFORT: "high",
  })

  assert.equal(config.provider, "openrouter")
  assert.equal(config.model, "openai/gpt-5-nano")
  assert.equal(config.maxOutputTokens, 12000)
  assert.equal(config.modelProvider, null)
  assert.equal(config.reasoningEffort, "high")
  assert.equal(config.stopWhenStepCount, 7)
})

test("evaluation config reuses OpenAI model settings without requiring MCP URLs", () => {
  const config = getEvaluationLlmRunConfig({
    LLM_PROVIDER: "openai",
    LLM_MAX_OUTPUT_TOKENS: "12000",
    OPENAI_API_KEY: "key",
    OPENAI_MODEL: "gpt-5.4-mini",
    OPENAI_REASONING_EFFORT: "medium",
  })

  assert.equal(config.provider, "openai")
  assert.equal(config.model, "gpt-5.4-mini")
  assert.equal(config.maxOutputTokens, 12000)
})

test("validates llama.cpp LLM config requirements", () => {
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "llamacpp",
        LLM_MAX_OUTPUT_TOKENS: "12000",
        LLAMACPP_BASE_URL: "http://127.0.0.1:8080/v1",
        LLAMACPP_STOP_WHEN_STEP_COUNT: "0",
      }),
    /LLAMACPP_STOP_WHEN_STEP_COUNT must be a positive integer\./
  )
  assert.throws(
    () =>
      getOpeningHandLlmRunConfig({
        LLM_PROVIDER: "llamacpp",
        LLM_MAX_OUTPUT_TOKENS: "12000",
        LLAMACPP_STOP_WHEN_STEP_COUNT: "7",
      }),
    /LLAMACPP_BASE_URL/
  )

  const config = getTurnSimulationLlmRunConfig({
    LLM_PROVIDER: "llamacpp",
    LLM_MAX_OUTPUT_TOKENS: "12000",
    LLAMACPP_BASE_URL: "http://127.0.0.1:8080/v1",
    LLAMACPP_STOP_WHEN_STEP_COUNT: "7",
  })

  assert.equal(config.provider, "llamacpp")
  assert.equal(config.apiKey, "not-needed")
  assert.equal(config.baseUrl, "http://127.0.0.1:8080/v1")
  assert.equal(config.maxOutputTokens, 12000)
  assert.equal(config.model, null)
  assert.equal(config.reasoningEffort, null)
  assert.equal(config.stopWhenStepCount, 7)
})

test("reads optional llama.cpp API key config", () => {
  const config = getOpeningHandLlmRunConfig({
    LLM_PROVIDER: "llamacpp",
    LLM_MAX_OUTPUT_TOKENS: "12000",
    LLAMACPP_API_KEY: "local-secret",
    LLAMACPP_BASE_URL: "http://127.0.0.1:8080/v1",
    LLAMACPP_STOP_WHEN_STEP_COUNT: "7",
  })

  assert.equal(config.provider, "llamacpp")
  assert.equal(config.apiKey, "local-secret")
})

test("reads optional OpenRouter model provider config", () => {
  const config = getOpeningHandLlmRunConfig({
    LLM_PROVIDER: "openrouter",
    LLM_MAX_OUTPUT_TOKENS: "12000",
    OPENROUTER_API_KEY: "key",
    OPENROUTER_MODEL: "openai/gpt-5-nano",
    OPENROUTER_MODEL_PROVIDER: "openai",
    OPENROUTER_REASONING_EFFORT: "high",
    OPENROUTER_STOP_WHEN_STEP_COUNT: "7",
  })

  assert.equal(config.provider, "openrouter")
  assert.equal(config.modelProvider, "openai")
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
  assert.deepEqual(chunk.payload, {
    message: "Stopped by user.",
  })
})

test("creates llama.cpp text, tool, and completion chunks", () => {
  const startChunk = createLlamaCppToolCallStartChunk("draw_starting_hand", {
    id: "call_1",
  })
  const completeChunk = createLlamaCppToolCallCompleteChunk(
    "draw_starting_hand",
    { cards: ["Sol Ring"] },
    { id: "call_1" }
  )
  const textChunk = createLlamaCppMessageDeltaChunk(
    '{"keptHand":["Sol Ring"]}',
    { id: "chatcmpl_1" }
  )
  const completedChunk = createLlamaCppCompletedChunk({ id: "chatcmpl_1" })

  assert.equal(startChunk.kind, "mcp_call_start")
  assert.equal(startChunk.mcpFunctionName, "draw_starting_hand")
  assert.equal(completeChunk.kind, "mcp_call_complete")
  assert.deepEqual(completeChunk.mcpFunctionOutput, {
    cards: ["Sol Ring"],
  })
  assert.equal(textChunk.kind, "message_delta")
  assert.equal(textChunk.outputDelta, '{"keptHand":["Sol Ring"]}')
  assert.equal(completedChunk.kind, "completed")
})

test("runtime abort helper throws a recognized abort error", () => {
  const abortController = new AbortController()
  abortController.abort()

  assert.throws(
    () => throwIfRuntimeAborted(abortController.signal),
    (error: unknown) => isAbortError(error)
  )
})

test("runtime abort handler runs once when cancellation is requested", () => {
  const abortController = new AbortController()
  let abortCallCount = 0
  const cleanup = registerRuntimeAbortHandler(abortController.signal, () => {
    abortCallCount += 1
  })

  abortController.abort()
  abortController.abort()
  cleanup()

  assert.equal(abortCallCount, 1)
})

test("runtime abortable stream treats silent abort completion as cancellation", async () => {
  const abortController = new AbortController()

  async function* createSilentlyClosedStream() {
    abortController.abort()
    yield* []
  }

  await assert.rejects(
    forEachRuntimeAbortableAsync(
      createSilentlyClosedStream(),
      abortController.signal,
      () => {}
    ),
    (error: unknown) => isAbortError(error)
  )
})

test("runtime abort call helper forwards the abort signal", async () => {
  const abortController = new AbortController()
  let receivedSignal: AbortSignal | null = null

  await assert.rejects(
    callWithRuntimeAbortSignal(abortController.signal, async ({ signal }) => {
      receivedSignal = signal
      abortController.abort()
      return "late result"
    }),
    (error: unknown) => isAbortError(error)
  )

  assert.equal(receivedSignal, abortController.signal)
})

test("late LLM terminal updates do not apply after cancellation starts", () => {
  assert.equal(canApplyLateLlmRunTerminalUpdate("pending"), true)
  assert.equal(canApplyLateLlmRunTerminalUpdate("streaming"), true)
  assert.equal(canApplyLateLlmRunTerminalUpdate("cancel_requested"), false)
  assert.equal(canApplyLateLlmRunTerminalUpdate("cancelled"), false)
  assert.equal(canApplyLateLlmRunTerminalUpdate("completed"), false)
  assert.equal(canApplyLateLlmRunTerminalUpdate("failed"), false)
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
  assert.equal(chunk.payload, event)
  assert.equal(
    error.message,
    "OpenAI stream ended with response.failed: provider is unavailable"
  )
})

test("normalizes OpenRouter text and reasoning stream deltas", () => {
  const textChunk = normalizeOpenRouterStreamEvent({
    type: "response.output_text.delta",
    delta: "Keep the seven.",
  })
  const summaryChunk = normalizeOpenRouterStreamEvent({
    type: "response.reasoning_summary_text.delta",
    delta: "Hand has ramp.",
  })
  const reasoningChunk = normalizeOpenRouterStreamEvent({
    type: "response.reasoning_text.delta",
    delta: "Evaluating mana.",
  })

  assert.equal(textChunk.kind, "message_delta")
  assert.equal(textChunk.outputDelta, "Keep the seven.")
  assert.equal(summaryChunk.kind, "reasoning_delta")
  assert.equal(summaryChunk.reasoningDelta, "Hand has ramp.")
  assert.equal(reasoningChunk.kind, "reasoning_delta")
  assert.equal(reasoningChunk.reasoningDelta, "Evaluating mana.")
})

test("normalizes OpenRouter reasoning and output item lifecycle events", () => {
  const reasoningStartChunk = normalizeOpenRouterStreamEvent({
    type: "response.output_item.added",
    item: {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      status: "in_progress",
    },
  })
  const reasoningDoneChunk = normalizeOpenRouterStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      status: "completed",
    },
  })
  const outputStartChunk = normalizeOpenRouterStreamEvent({
    type: "response.output_item.added",
    item: {
      type: "message",
      id: "msg_1",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  })
  const outputDoneChunk = normalizeOpenRouterStreamEvent({
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [],
    },
  })

  assert.equal(reasoningStartChunk.kind, "reasoning_start")
  assert.equal(reasoningDoneChunk.kind, "reasoning_done")
  assert.equal(outputStartChunk.kind, "output_start")
  assert.equal(outputDoneChunk.kind, "output_done")
})

test("normalizes OpenRouter reasoning summary part lifecycle events", () => {
  const summaryStartChunk = normalizeOpenRouterStreamEvent({
    type: "response.reasoning_summary_part.added",
    itemId: "rs_1",
    outputIndex: 0,
    part: {
      text: "",
      type: "summary_text",
    },
    sequenceNumber: 1,
    summaryIndex: 0,
  })
  const summaryTextDoneChunk = normalizeOpenRouterStreamEvent({
    type: "response.reasoning_summary_text.done",
    itemId: "rs_1",
    outputIndex: 0,
    sequenceNumber: 2,
    summaryIndex: 0,
    text: "Checking mana.",
  })

  assert.equal(summaryStartChunk.kind, "reasoning_start")
  assert.equal(summaryTextDoneChunk.kind, "reasoning_done")
})

test("normalizes OpenRouter function calls and tool results", () => {
  const toolCallNamesById = new Map<string, string>()
  const startChunk = normalizeOpenRouterStreamEvent(
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "item_1",
        callId: "call_1",
        name: "draw_starting_hand",
      },
    },
    toolCallNamesById
  )
  const resultChunk = normalizeOpenRouterStreamEvent(
    {
      type: "tool.result",
      toolCallId: "call_1",
      result: {
        message: "Drew the starting hand.",
      },
    },
    toolCallNamesById
  )

  assert.equal(startChunk.kind, "mcp_call_start")
  assert.equal(startChunk.mcpFunctionName, "draw_starting_hand")
  assert.equal(resultChunk.kind, "mcp_call_complete")
  assert.equal(resultChunk.mcpFunctionName, "draw_starting_hand")
  assert.deepEqual(resultChunk.mcpFunctionOutput, {
    message: "Drew the starting hand.",
  })
})

test("normalizes OpenRouter completed and failure events", () => {
  const completedEvent = {
    type: "response.completed",
    response: {
      id: "gen-openrouter-test",
      outputText: '{"keptHand":["Sol Ring"]}',
    },
  }
  const completedChunk = normalizeOpenRouterStreamEvent(completedEvent)
  const failureEvent = {
    type: "error",
    message: "provider is unavailable",
  }
  const failureChunk = normalizeOpenRouterStreamEvent(failureEvent)
  const error = new ProviderTerminalEventError(
    failureEvent.type,
    failureEvent,
    "OpenRouter"
  )

  assert.equal(completedChunk.kind, "completed")
  assert.equal(completedChunk.payload, completedEvent)
  assert.equal(
    getCompletedResponseOutputText(completedEvent.response),
    '{"keptHand":["Sol Ring"]}'
  )
  assert.equal(
    getOpenRouterGenerationIdFromCompletedEvent(completedEvent),
    "gen-openrouter-test"
  )
  assert.equal(failureChunk.kind, "error")
  assert.equal(
    error.message,
    "OpenRouter stream ended with error: provider is unavailable"
  )
})

test("reports invalid completed JSON with an explicit message", () => {
  assert.throws(
    () => parseOpeningHandFromResponseText("{"),
    /Opening-hand LLM completed response was not valid JSON\./
  )
})

test("reports opening-hand model error JSON as an unrecoverable simulation error", () => {
  assertThrowsModelReportedSimulationError(
    () =>
      parseOpeningHandFromResponseText(
        JSON.stringify({
          error: "Drew opening hand twice.",
        })
      ),
    "Drew opening hand twice."
  )
})

test("parses opening-hand JSON after leading LLM text", () => {
  assert.deepEqual(
    parseOpeningHandFromResponseText(
      [
        'I inspected the hand and said "keep.',
        JSON.stringify({
          keptHand: ["Sol Ring", "Command Tower"],
          summary: "Kept a fast mana hand.",
        }),
      ].join("\n")
    ),
    {
      keptHand: ["Sol Ring", "Command Tower"],
    }
  )
})

test("keeps parsed opening-hand JSON for final parsed output chunks", () => {
  const parsedCompletion = parseOpeningHandCompletionFromResponseText(
    JSON.stringify({
      keptHand: ["Sol Ring", "Command Tower"],
      summary: "Kept a fast mana hand.",
    })
  )
  const chunk = createFinalParsedOutputChunk(parsedCompletion.parsedOutput)

  assert.equal(chunk.kind, "final_parsed_output")
  assert.deepEqual(chunk.payload, {
    keptHand: ["Sol Ring", "Command Tower"],
    summary: "Kept a fast mana hand.",
  })
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

test("keeps parsed turn JSON for final parsed output chunks", () => {
  const parsedCompletion = parseTurnSimulationCompletionFromResponseText(
    JSON.stringify({
      gameState: "Hand:\nSol Ring\n\nBattlefield:\nCommand Tower",
      summary: "Played Command Tower.",
    })
  )
  const chunk = createFinalParsedOutputChunk(parsedCompletion.parsedOutput)

  assert.equal(chunk.kind, "final_parsed_output")
  assert.deepEqual(chunk.payload, {
    gameState: "Hand:\nSol Ring\n\nBattlefield:\nCommand Tower",
    summary: "Played Command Tower.",
  })
})

test("parses the last valid turn JSON object from noisy output", () => {
  assert.deepEqual(
    parseTurnSimulationFromResponseText(
      [
        "Earlier draft:",
        JSON.stringify({
          gameState: "Hand:\nIsland",
          summary: "This should be ignored.",
        }),
        "Final answer:",
        "```json",
        JSON.stringify({
          gameState: "Hand:\nSol Ring\n\nBattlefield:\n{Command Tower}",
          summary: "Played Command Tower.",
        }),
        "```",
      ].join("\n")
    ),
    {
      gameState: "Hand:\nSol Ring\n\nBattlefield:\n{Command Tower}",
    }
  )
})

test("falls back to an earlier valid JSON object when later braces are malformed", () => {
  assert.deepEqual(
    parseTurnSimulationFromResponseText(
      [
        JSON.stringify({
          gameState: "Hand:\nSol Ring",
          summary: "Parsed successfully.",
        }),
        "Trailing malformed attempt: {not json}",
      ].join("\n")
    ),
    {
      gameState: "Hand:\nSol Ring",
    }
  )
})

test("rejects completed turn JSON without game state", () => {
  assert.throws(
    () => parseTurnSimulationFromResponseText('{"summary":"No state."}'),
    /Turn LLM response did not include gameState\./
  )
})

test("reports turn model error JSON as an unrecoverable simulation error", () => {
  assertThrowsModelReportedSimulationError(
    () =>
      parseTurnSimulationFromResponseText(
        JSON.stringify({
          error: "Played a second land after logging the first land play.",
        })
      ),
    "Played a second land after logging the first land play."
  )
})

test("reports the final noisy model error JSON as an unrecoverable simulation error", () => {
  assertThrowsModelReportedSimulationError(
    () =>
      parseTurnSimulationFromResponseText(
        [
          "Earlier draft:",
          JSON.stringify({
            gameState: "Hand:\nSol Ring",
            summary: "This should be ignored.",
          }),
          "Final answer:",
          JSON.stringify({
            error: "Logged an impossible mana payment.",
          }),
        ].join("\n")
      ),
    "Logged an impossible mana payment."
  )
})

test("reports invalid completed turn JSON with an explicit message", () => {
  assert.throws(
    () => parseTurnSimulationFromResponseText("{"),
    /Turn LLM completed response was not valid JSON\./
  )
})

test("parses opening-hand evaluation JSON", () => {
  assert.deepEqual(
    parseOpeningHandEvaluationResponseText(
      JSON.stringify({
        legalSimulationPass: true,
        reasoningPass: false,
        simulationQualityScore: 8.25,
        illegalActions: [],
        reasoningMistakes: ["Assumed a land made green mana."],
        strategicMistakes: ["Should have bottomed the expensive spell."],
      })
    ),
    {
      legalSimulationPass: true,
      reasoningPass: false,
      simulationQualityScore: 8.25,
      illegalActions: [],
      reasoningMistakes: ["Assumed a land made green mana."],
      strategicMistakes: ["Should have bottomed the expensive spell."],
    }
  )
})

test("rejects invalid opening-hand evaluation JSON", () => {
  assert.throws(
    () => parseOpeningHandEvaluationResponseText("{"),
    /Opening-hand evaluation response was not valid JSON\./
  )
  assert.throws(
    () =>
      parseOpeningHandEvaluationResponseText(
        JSON.stringify({
          legalSimulationPass: true,
          reasoningPass: true,
          simulationQualityScore: 11,
          illegalActions: [],
          reasoningMistakes: [],
          strategicMistakes: [],
        })
      ),
    /Opening-hand evaluation response did not match the expected JSON\./
  )
  assert.throws(
    () =>
      parseOpeningHandEvaluationResponseText(
        JSON.stringify({
          reasoningPass: true,
          simulationQualityScore: 8,
          illegalActions: [],
          reasoningMistakes: [],
          strategicMistakes: [],
        })
      ),
    /Opening-hand evaluation response did not match the expected JSON\./
  )
})

test("builds opening-hand evaluation input like copy activity with prompt", () => {
  const inputText = buildOpeningHandEvaluationInputText({
    fullPrompt: "Full opening-hand prompt",
    chunks: [
      {
        id: 1,
        sequence: 1,
        kind: "reasoning_delta",
        mcpFunctionName: null,
        mcpFunctionOutput: null,
        mcpFunctionReason: null,
        reasoningDelta: "Reason about the opener.",
        outputDelta: null,
        payload: {},
        cardMentions: [],
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        sequence: 2,
        kind: "mcp_call_complete",
        mcpFunctionName: "draw_starting_hand",
        mcpFunctionOutput: {
          cards: ["Sol Ring", "Command Tower"],
        },
        mcpFunctionReason: null,
        reasoningDelta: null,
        outputDelta: null,
        payload: {},
        cardMentions: [],
        receivedAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  })

  assert.equal(
    inputText,
    [
      "Full opening-hand prompt",
      "Reason about the opener.",
      "[called draw_starting_hand]",
      `[result of draw_starting_hand]\n${JSON.stringify(
        {
          cards: ["Sol Ring", "Command Tower"],
        },
        null,
        2
      )}`,
    ].join("\n\n")
  )
})

test("validates opening-hand evaluation run eligibility", () => {
  assert.equal(
    getOpeningHandEvaluationIneligibilityMessage({
      phase: "opening_hand",
      status: "completed",
      openingHandIsValid: true,
      chunks: [],
    }),
    null
  )
  assert.equal(
    getOpeningHandEvaluationIneligibilityMessage({
      phase: "turn",
      status: "completed",
      openingHandIsValid: true,
      chunks: [],
    }),
    "Only opening-hand LLM runs can be evaluated."
  )
  assert.equal(
    getOpeningHandEvaluationIneligibilityMessage({
      phase: "opening_hand",
      status: "streaming",
      openingHandIsValid: true,
      chunks: [],
    }),
    "Only completed opening-hand LLM runs can be evaluated."
  )
  assert.equal(
    getOpeningHandEvaluationIneligibilityMessage({
      phase: "opening_hand",
      status: "completed",
      openingHandIsValid: false,
      chunks: [],
    }),
    "Only valid opening-hand LLM runs can be evaluated."
  )
  assert.equal(
    getOpeningHandEvaluationIneligibilityMessage({
      phase: "opening_hand",
      status: "completed",
      openingHandIsValid: true,
      chunks: [
        {
          kind: "error",
        },
      ],
    }),
    "Opening-hand LLM runs with errors cannot be evaluated."
  )
})

test("opening-hand evaluation upsert overwrites existing evaluation columns", () => {
  const normalizedSql = OPENING_HAND_EVALUATION_UPSERT_SQL.replace(
    /\s+/g,
    " "
  ).trim()

  assert.match(
    normalizedSql,
    /ON CONFLICT \(opening_hand_llm_run_id\) DO UPDATE/
  )

  for (const column of [
    "legal_simulation_pass",
    "reasoning_pass",
    "simulation_quality_score",
    "evaluation_json",
  ]) {
    assert.match(normalizedSql, new RegExp(`${column} = EXCLUDED\\.${column}`))
  }

  assert.match(normalizedSql, /updated_at = now\(\)/)
})

test("parses turn evaluation JSON", () => {
  assert.deepEqual(
    parseTurnEvaluationResponseText(
      JSON.stringify({
        legalTurnPass: true,
        reasoningPass: false,
        simulationQualityScore: 7.5,
        illegalActions: [],
        reasoningMistakes: ["Assumed Sol Ring taps for colored mana."],
        strategicMistakes: ["Should have played the untapped land first."],
      })
    ),
    {
      legalTurnPass: true,
      reasoningPass: false,
      simulationQualityScore: 7.5,
      illegalActions: [],
      reasoningMistakes: ["Assumed Sol Ring taps for colored mana."],
      strategicMistakes: ["Should have played the untapped land first."],
    }
  )
})

test("parses turn evaluation JSON after leading text", () => {
  const parsedEvaluation = parseTurnEvaluationResponseText(
    [
      "Here is the evaluation:",
      JSON.stringify({
        legalTurnPass: false,
        reasoningPass: true,
        simulationQualityScore: 4,
        illegalActions: ["Played two lands in one turn."],
        reasoningMistakes: [],
        strategicMistakes: [],
      }),
    ].join("\n")
  )

  assert.equal(parsedEvaluation.legalTurnPass, false)
  assert.equal(parsedEvaluation.simulationQualityScore, 4)
})

test("rejects invalid turn evaluation JSON", () => {
  assert.throws(
    () =>
      parseTurnEvaluationResponseText(
        JSON.stringify({
          legalTurnPass: true,
          reasoningPass: true,
          simulationQualityScore: 11,
          illegalActions: [],
          reasoningMistakes: [],
          strategicMistakes: [],
        })
      ),
    /Turn evaluation response did not match the expected JSON\./
  )
})

test("builds turn evaluation input like copy activity with prompt", () => {
  const inputText = buildTurnEvaluationInputText({
    fullPrompt: "Full turn prompt",
    chunks: [
      {
        id: 1,
        sequence: 1,
        kind: "reasoning_delta",
        mcpFunctionName: null,
        mcpFunctionOutput: null,
        mcpFunctionReason: null,
        reasoningDelta: "Reason about the turn.",
        outputDelta: null,
        payload: {},
        cardMentions: [],
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        sequence: 2,
        kind: "mcp_call_complete",
        mcpFunctionName: "log_turn_action",
        mcpFunctionOutput: {
          latestAction: {
            action: "Play Command Tower.",
            phaseChange: null,
          },
          actions: ["Play Command Tower."],
        },
        mcpFunctionReason: null,
        reasoningDelta: null,
        outputDelta: null,
        payload: {},
        cardMentions: [],
        receivedAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  })

  assert.equal(
    inputText,
    [
      "Full turn prompt",
      "Reason about the turn.",
      "[called log_turn_action]",
      `[result of log_turn_action]\n${JSON.stringify(
        {
          latestAction: {
            action: "Play Command Tower.",
            phaseChange: null,
          },
          actions: ["Play Command Tower."],
        },
        null,
        2
      )}`,
    ].join("\n\n")
  )
})

test("validates turn evaluation run eligibility", () => {
  assert.equal(
    getTurnEvaluationIneligibilityMessage({
      phase: "turn",
      status: "completed",
      chunks: [],
    }),
    null
  )
  assert.equal(
    getTurnEvaluationIneligibilityMessage({
      phase: "report",
      status: "completed",
      chunks: [],
    }),
    "Only turn LLM runs can be evaluated."
  )
  assert.equal(
    getTurnEvaluationIneligibilityMessage({
      phase: "turn",
      status: "streaming",
      chunks: [],
    }),
    "Only completed turn LLM runs can be evaluated."
  )
  assert.equal(
    getTurnEvaluationIneligibilityMessage({
      phase: "turn",
      status: "completed",
      chunks: [
        {
          kind: "error",
        },
      ],
    }),
    "Turn LLM runs with errors cannot be evaluated."
  )
})

test("turn evaluation upsert overwrites existing evaluation columns", () => {
  const normalizedSql = TURN_EVALUATION_UPSERT_SQL.replace(/\s+/g, " ").trim()

  assert.match(normalizedSql, /ON CONFLICT \(turn_llm_run_id\) DO UPDATE/)

  for (const column of [
    "legal_turn_pass",
    "reasoning_pass",
    "simulation_quality_score",
    "evaluation_json",
  ]) {
    assert.match(normalizedSql, new RegExp(`${column} = EXCLUDED\\.${column}`))
  }

  assert.match(normalizedSql, /updated_at = now\(\)/)
})

test("normal results exclude only raw and completed chunks", () => {
  assert.equal(LLM_CHUNK_KINDS.includes("reasoning_start"), true)
  assert.equal(LLM_CHUNK_KINDS.includes("reasoning_done"), true)
  assert.equal(LLM_CHUNK_KINDS.includes("output_start"), true)
  assert.equal(LLM_CHUNK_KINDS.includes("output_done"), true)
  assert.equal(LLM_CHUNK_KINDS.includes("final_parsed_output"), true)
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
      autoGenerateReport: false,
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
      autoGenerateReport: false,
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
      autoGenerateReport: false,
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
  assert.deepEqual(
    getTurnCompletionDecision({
      autoSimulateNextStep: true,
      autoGenerateReport: true,
      turnNumber: 3,
      turnsToSimulate: 3,
    }),
    {
      simulationStatus: "completed",
      nextStep: {
        type: "report",
      },
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

function assertThrowsModelReportedSimulationError(
  action: () => unknown,
  modelError: string
) {
  assert.throws(action, (error: unknown) => {
    assert.equal(error instanceof ModelReportedSimulationError, true)

    if (!(error instanceof ModelReportedSimulationError)) {
      return false
    }

    assert.equal(error.modelError, modelError)
    assert.equal(
      error.message,
      `Model reported unrecoverable simulation error: ${modelError}`
    )

    return true
  })
}
