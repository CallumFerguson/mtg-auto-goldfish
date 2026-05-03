import assert from "node:assert/strict"
import test from "node:test"
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions"
import { z } from "zod/v4"
import { isAbortError } from "./llm-run-events.js"
import {
  collectLlamaCppChatCompletion,
  createLlamaCppChatCompletionTools,
  getLlamaCppChatCompletionToolCalls,
  type LlamaCppChatCompletionRequestPayload,
  type LlamaCppToolDefinition,
} from "./llamacpp-chat.js"
import type { LlmRunChunkInput } from "./simulations-postgres.js"

const openingHandToolDefinitions: LlamaCppToolDefinition[] = [
  {
    name: "draw_starting_hand",
    description: "Draw the starting hand.",
    inputSchema: z.object({
      llmRunId: z.string().trim().min(1),
    }),
  },
]

const turnToolDefinitions: LlamaCppToolDefinition[] = [
  {
    name: "draw_card_from_top",
    description: "Draw cards from the top.",
    inputSchema: z.object({
      llmRunId: z.string().trim().min(1),
      count: z.number().int().positive(),
    }),
  },
]

test("collects a llama.cpp opening-hand tool loop", async () => {
  const chatRequests: ChatCompletionCreateParamsStreaming[] = []
  const chunks: Array<Omit<LlmRunChunkInput, "sequence">> = []
  const toolCalls: Array<{ args: Record<string, unknown>; name: string }> = []
  const responses = [
    createChatCompletionStream([
      createChatCompletionChunk({
        finishReason: "tool_calls",
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: {
              name: "draw_starting_hand",
              arguments: '{"llmRunId":"run_1"}',
            },
          },
        ],
      }),
    ]),
    createChatCompletionStream([
      createChatCompletionChunk({
        content: '{"keptHand":',
      }),
      createChatCompletionChunk({
        content: '["Sol Ring"]}',
        finishReason: "stop",
      }),
      createChatCompletionChunk({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
        },
      }),
    ]),
  ]

  const result = await collectLlamaCppChatCompletion({
    appendChunk: (chunk) => chunks.push(chunk),
    callTool: async (name, args) => {
      toolCalls.push({ name, args })
      return { cards: ["Sol Ring"] }
    },
    createChatCompletion: async (body) => {
      chatRequests.push(body)
      const response = responses.shift()

      assert.ok(response)
      return response
    },
    requestPayload: createRequestPayload(openingHandToolDefinitions),
    signal: new AbortController().signal,
    toolDefinitions: openingHandToolDefinitions,
  })

  assert.deepEqual(toolCalls, [
    {
      name: "draw_starting_hand",
      args: {
        llmRunId: "run_1",
      },
    },
  ])
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    [
      "mcp_call_start",
      "mcp_call_complete",
      "message_delta",
      "message_delta",
      "completed",
    ]
  )
  assert.equal(result.outputText, '{"keptHand":["Sol Ring"]}')
  assert.deepEqual(result.usage, {
    prompt_tokens: 100,
    completion_tokens: 25,
    total_tokens: 125,
  })
  assert.equal(chatRequests.length, 2)
  assert.equal(chatRequests[1]?.messages.length, 3)
})

test("collects a llama.cpp turn tool loop with shorthand tool calls", async () => {
  const chunks: Array<Omit<LlmRunChunkInput, "sequence">> = []
  const responses = [
    createChatCompletionStream([
      createChatCompletionChunk({
        finishReason: "tool_calls",
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            name: "draw_card_from_top",
            arguments: '{"llmRunId":"run_1","count":1}',
          },
        ],
      }),
    ]),
    createChatCompletionStream([
      createChatCompletionChunk({
        content: '{"gameState":"Hand:\\nSol Ring"}',
        finishReason: "stop",
      }),
    ]),
  ]

  const result = await collectLlamaCppChatCompletion({
    appendChunk: (chunk) => chunks.push(chunk),
    callTool: async () => ({ cards: ["Sol Ring"] }),
    createChatCompletion: async () => {
      const response = responses.shift()

      assert.ok(response)
      return response
    },
    requestPayload: createRequestPayload(turnToolDefinitions),
    signal: new AbortController().signal,
    toolDefinitions: turnToolDefinitions,
  })

  assert.equal(result.outputText, '{"gameState":"Hand:\\nSol Ring"}')
  assert.deepEqual(
    chunks.map((chunk) => chunk.mcpFunctionName).filter(Boolean),
    ["draw_card_from_top", "draw_card_from_top"]
  )
})

test("streams llama.cpp reasoning deltas separately from output", async () => {
  const chunks: Array<Omit<LlmRunChunkInput, "sequence">> = []
  const result = await collectLlamaCppChatCompletion({
    appendChunk: (chunk) => chunks.push(chunk),
    callTool: async () => ({ cards: ["Sol Ring"] }),
    createChatCompletion: async () =>
      createChatCompletionStream([
        createChatCompletionChunk({
          reasoningContent: "Evaluating mana.",
        }),
        createChatCompletionChunk({
          content: '{"keptHand":["Sol Ring"]}',
          finishReason: "stop",
        }),
      ]),
    requestPayload: createRequestPayload(openingHandToolDefinitions),
    signal: new AbortController().signal,
    toolDefinitions: openingHandToolDefinitions,
  })

  assert.equal(result.outputText, '{"keptHand":["Sol Ring"]}')
  assert.deepEqual(
    chunks.map((chunk) => ({
      kind: chunk.kind,
      outputDelta: chunk.outputDelta,
      reasoningDelta: chunk.reasoningDelta,
    })),
    [
      {
        kind: "reasoning_delta",
        outputDelta: null,
        reasoningDelta: "Evaluating mana.",
      },
      {
        kind: "message_delta",
        outputDelta: '{"keptHand":["Sol Ring"]}',
        reasoningDelta: null,
      },
      {
        kind: "completed",
        outputDelta: null,
        reasoningDelta: null,
      },
    ]
  )
})

test("rejects malformed llama.cpp tool arguments", async () => {
  await assert.rejects(
    collectLlamaCppChatCompletion({
      appendChunk: () => {},
      callTool: async () => {
        throw new Error("Tool should not be called.")
      },
      createChatCompletion: async () =>
        createChatCompletionStream([
          createChatCompletionChunk({
            finishReason: "tool_calls",
            toolCalls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "draw_starting_hand",
                  arguments: '{"llmRunId":',
                },
              },
            ],
          }),
        ]),
      requestPayload: createRequestPayload(openingHandToolDefinitions),
      signal: new AbortController().signal,
      toolDefinitions: openingHandToolDefinitions,
    }),
    /llama\.cpp tool draw_starting_hand arguments were not valid JSON\./
  )
})

test("stops runaway llama.cpp tool loops at the step limit", async () => {
  await assert.rejects(
    collectLlamaCppChatCompletion({
      appendChunk: () => {},
      callTool: async () => ({ cards: ["Sol Ring"] }),
      createChatCompletion: async () =>
        createChatCompletionStream([
          createChatCompletionChunk({
            finishReason: "tool_calls",
            toolCalls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "draw_starting_hand",
                  arguments: '{"llmRunId":"run_1"}',
                },
              },
            ],
          }),
        ]),
      requestPayload: {
        ...createRequestPayload(openingHandToolDefinitions),
        stopWhenStepCount: 1,
      },
      signal: new AbortController().signal,
      toolDefinitions: openingHandToolDefinitions,
    }),
    /LLAMACPP_STOP_WHEN_STEP_COUNT \(1\)/
  )
})

test("does not start llama.cpp requests after cancellation", async () => {
  const abortController = new AbortController()
  let requestCount = 0

  abortController.abort()

  await assert.rejects(
    collectLlamaCppChatCompletion({
      appendChunk: () => {},
      callTool: async () => ({ cards: ["Sol Ring"] }),
      createChatCompletion: async () => {
        requestCount += 1
        return createChatCompletionStream([
          createChatCompletionChunk({
            content: '{"keptHand":["Sol Ring"]}',
            finishReason: "stop",
          }),
        ])
      },
      requestPayload: createRequestPayload(openingHandToolDefinitions),
      signal: abortController.signal,
      toolDefinitions: openingHandToolDefinitions,
    }),
    (error: unknown) => isAbortError(error)
  )

  assert.equal(requestCount, 0)
})

test("surfaces llama.cpp chat completion request failures", async () => {
  await assert.rejects(
    collectLlamaCppChatCompletion({
      appendChunk: () => {},
      callTool: async () => ({ cards: ["Sol Ring"] }),
      createChatCompletion: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080")
      },
      requestPayload: createRequestPayload(openingHandToolDefinitions),
      signal: new AbortController().signal,
      toolDefinitions: openingHandToolDefinitions,
    }),
    /connect ECONNREFUSED/
  )
})

test("normalizes OpenAI-style and shorthand llama.cpp tool calls", () => {
  assert.deepEqual(
    getLlamaCppChatCompletionToolCalls(
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "draw_starting_hand",
              arguments: '{"llmRunId":"run_1"}',
            },
          },
          {
            name: "draw_card_from_top",
            arguments: '{"llmRunId":"run_1","count":1}',
          },
        ],
      },
      2
    ).map(({ argumentsText, id, name }) => ({ argumentsText, id, name })),
    [
      {
        argumentsText: '{"llmRunId":"run_1"}',
        id: "call_1",
        name: "draw_starting_hand",
      },
      {
        argumentsText: '{"llmRunId":"run_1","count":1}',
        id: "llamacpp_call_2_2",
        name: "draw_card_from_top",
      },
    ]
  )
})

function createRequestPayload(
  toolDefinitions: readonly LlamaCppToolDefinition[]
): LlamaCppChatCompletionRequestPayload {
  return {
    providerType: "llamacpp",
    model: "local-model",
    messages: [
      {
        role: "user",
        content: "prompt",
      },
    ],
    metadata: {
      phase: "opening_hand",
      simulationId: "simulation_1",
    },
    parallel_tool_calls: false,
    reasoning_effort: "medium",
    tools: createLlamaCppChatCompletionTools(toolDefinitions),
    stopWhenStepCount: 5,
  }
}

async function* createChatCompletionStream(chunks: ChatCompletionChunk[]) {
  for (const chunk of chunks) {
    yield chunk
  }
}

function createChatCompletionChunk({
  choices,
  content = null,
  finishReason = null,
  reasoningContent = null,
  toolCalls,
  usage = null,
}: {
  choices?: ChatCompletionChunk["choices"]
  content?: string | null
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  reasoningContent?: string | null
  toolCalls?: unknown[]
  usage?: unknown
}): ChatCompletionChunk {
  return {
    id: "chatcmpl_1",
    choices:
      choices ??
      [
        {
          finish_reason: finishReason,
          index: 0,
          logprobs: null,
          delta: {
            content,
            reasoning_content: reasoningContent,
            tool_calls: toolCalls,
          },
        },
      ],
    created: 0,
    model: "local-model",
    object: "chat.completion.chunk",
    usage,
  } as ChatCompletionChunk
}
