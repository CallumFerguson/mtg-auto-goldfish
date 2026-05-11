import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import { z } from "zod/v4"
import {
  asRecord,
  createLlamaCppCompletedChunk,
  createLlamaCppMessageDeltaChunk,
  createLlamaCppOutputDoneChunk,
  createLlamaCppOutputStartChunk,
  createLlamaCppReasoningDoneChunk,
  createLlamaCppReasoningDeltaChunk,
  createLlamaCppReasoningStartChunk,
  createLlamaCppToolCallCompleteChunk,
  createLlamaCppToolCallStartChunk,
  getStringProperty,
} from "./llm-run-events.js"
import { throwIfRuntimeAborted } from "./llm-runtime-cancellation.js"
import type { LlmRunChunkInput } from "./simulations-postgres.js"

export type LlamaCppToolDefinition = {
  name: string
  description: string
  inputSchema: z.ZodObject
}

export type LlamaCppChatCompletionRequestPayload = {
  providerType: "llamacpp"
  model: string
  max_tokens: number
  messages: ChatCompletionMessageParam[]
  metadata: Record<string, string>
  parallel_tool_calls: false
  tools: ChatCompletionTool[]
  stopWhenStepCount: number
}

export type LlamaCppChatCompletionCreate = (
  body: ChatCompletionCreateParamsStreaming,
  options: { signal: AbortSignal }
) => Promise<AsyncIterable<ChatCompletionChunk>>

export type LlamaCppChatCompletionToolCall = {
  argumentsText: string
  id: string
  name: string
  rawToolCall: unknown
}

export type LlamaCppChatCompletionResult = {
  outputText: string
  responseMetadata: unknown
  usage: unknown
}

type LlamaCppChatCompletionStepResult = {
  finishReason: string | null
  outputText: string
  responseMetadata: unknown
  toolCalls: LlamaCppChatCompletionToolCall[]
  usage: unknown
}

type LlamaCppStreamingToolCallAccumulator = {
  argumentsText: string
  id: string | null
  index: number
  name: string
}

type LlamaCppStreamSegment = "reasoning" | "output"

export function createLlamaCppChatCompletionTools(
  toolDefinitions: readonly LlamaCppToolDefinition[]
): ChatCompletionTool[] {
  return toolDefinitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: createJsonSchemaParameters(definition.inputSchema),
    },
  }))
}

export function getLlamaCppServerModelName(modelListResponse: unknown) {
  const models = asRecord(modelListResponse).data

  if (!Array.isArray(models)) {
    throw new Error(
      "llama.cpp /v1/models response did not include a data array."
    )
  }

  const modelNames = models
    .map((model) => getStringProperty(asRecord(model), "id")?.trim() ?? "")
    .filter(Boolean)

  if (modelNames.length === 0) {
    throw new Error("llama.cpp /v1/models did not include a model id.")
  }

  return modelNames[0]
}

export async function collectLlamaCppChatCompletion({
  appendChunk,
  callTool,
  createChatCompletion,
  requestPayload,
  signal,
  toolDefinitions,
}: {
  appendChunk: (
    chunk: Omit<LlmRunChunkInput, "sequence">
  ) => void | Promise<void>
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<unknown>
  createChatCompletion: LlamaCppChatCompletionCreate
  requestPayload: LlamaCppChatCompletionRequestPayload
  signal: AbortSignal
  toolDefinitions: readonly LlamaCppToolDefinition[]
}): Promise<LlamaCppChatCompletionResult> {
  const messages = requestPayload.messages.slice()
  const toolDefinitionsByName = new Map(
    toolDefinitions.map((definition) => [definition.name, definition])
  )

  for (let stepNumber = 1; stepNumber <= requestPayload.stopWhenStepCount; stepNumber += 1) {
    throwIfRuntimeAborted(signal)

    const stream = await createChatCompletion(
      createChatCompletionApiPayload(requestPayload, messages),
      { signal }
    )
    const stepResult = await collectLlamaCppChatCompletionStep({
      appendChunk,
      signal,
      stepNumber,
      stream,
    })
    const { toolCalls } = stepResult

    if (toolCalls.length === 0) {
      const { outputText } = stepResult

      if (!outputText.trim()) {
        throw new Error(
          "llama.cpp chat completion did not include final assistant content."
        )
      }

      await appendChunk(
        createLlamaCppCompletedChunk(stepResult.responseMetadata)
      )

      return {
        outputText,
        responseMetadata: stepResult.responseMetadata,
        usage: stepResult.usage,
      }
    }

    messages.push(createAssistantToolCallMessage(stepResult.outputText, toolCalls))

    for (const toolCall of toolCalls) {
      const toolDefinition = toolDefinitionsByName.get(toolCall.name)

      if (!toolDefinition) {
        throw new Error(`llama.cpp requested unknown tool: ${toolCall.name}.`)
      }

      await appendChunk(
        createLlamaCppToolCallStartChunk(toolCall.name, toolCall.rawToolCall)
      )

      const toolInput = parseAndValidateToolArguments(toolCall, toolDefinition)
      const toolOutput = await callTool(toolCall.name, toolInput, signal)

      await appendChunk(
        createLlamaCppToolCallCompleteChunk(toolCall.name, toolOutput, {
          result: toolOutput,
          toolCall: toolCall.rawToolCall,
        })
      )
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: formatToolOutputForMessage(toolOutput),
      })
    }
  }

  throw new Error(
    `llama.cpp LLM run reached LLAMACPP_STOP_WHEN_STEP_COUNT (${requestPayload.stopWhenStepCount}) before producing final output.`
  )
}

export function getLlamaCppChatCompletionToolCalls(
  message: unknown,
  stepNumber: number
): LlamaCppChatCompletionToolCall[] {
  const toolCalls = asRecord(message).tool_calls

  if (!Array.isArray(toolCalls)) {
    return []
  }

  return toolCalls.map((toolCall, index) =>
    normalizeLlamaCppToolCall(toolCall, stepNumber, index)
  )
}

async function collectLlamaCppChatCompletionStep({
  appendChunk,
  signal,
  stepNumber,
  stream,
}: {
  appendChunk: (
    chunk: Omit<LlmRunChunkInput, "sequence">
  ) => void | Promise<void>
  signal: AbortSignal
  stepNumber: number
  stream: AsyncIterable<ChatCompletionChunk>
}): Promise<LlamaCppChatCompletionStepResult> {
  const toolCallAccumulators = new Map<
    number,
    LlamaCppStreamingToolCallAccumulator
  >()
  let outputText = ""
  let usage: unknown = {}
  let finishReason: string | null = null
  let finalChunk: unknown = null
  let streamedChunkCount = 0
  let activeStreamSegment: LlamaCppStreamSegment | null = null

  async function closeActiveStreamSegment(payload: unknown) {
    if (activeStreamSegment === "reasoning") {
      await appendChunk(createLlamaCppReasoningDoneChunk(payload))
    }

    if (activeStreamSegment === "output") {
      await appendChunk(createLlamaCppOutputDoneChunk(payload))
    }

    activeStreamSegment = null
  }

  async function startStreamSegment(
    segment: LlamaCppStreamSegment,
    payload: unknown
  ) {
    if (activeStreamSegment === segment) {
      return
    }

    await closeActiveStreamSegment(payload)

    if (segment === "reasoning") {
      await appendChunk(createLlamaCppReasoningStartChunk(payload))
    } else {
      await appendChunk(createLlamaCppOutputStartChunk(payload))
    }

    activeStreamSegment = segment
  }

  for await (const chunk of stream) {
    throwIfRuntimeAborted(signal)
    streamedChunkCount += 1
    finalChunk = chunk

    if (chunk.usage) {
      usage = chunk.usage
    }

    for (const choice of chunk.choices) {
      const deltaRecord = asRecord(choice.delta)
      const reasoningDelta = getLlamaCppReasoningDelta(deltaRecord)
      const outputDelta = getStringProperty(deltaRecord, "content")

      if (reasoningDelta) {
        await startStreamSegment("reasoning", chunk)
        await appendChunk(
          createLlamaCppReasoningDeltaChunk(reasoningDelta, chunk)
        )
      }

      if (outputDelta) {
        await startStreamSegment("output", chunk)
        outputText += outputDelta
        await appendChunk(createLlamaCppMessageDeltaChunk(outputDelta, chunk))
      }

      rememberLlamaCppStreamingToolCallDeltas(
        toolCallAccumulators,
        deltaRecord,
        stepNumber
      )

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }
  }

  throwIfRuntimeAborted(signal)
  await closeActiveStreamSegment(finalChunk ?? {})

  return {
    finishReason,
    outputText,
    responseMetadata: {
      finalChunk,
      finishReason,
      streamedChunkCount,
      usage,
    },
    toolCalls: Array.from(toolCallAccumulators.values())
      .sort((left, right) => left.index - right.index)
      .map((toolCall) => createToolCallFromAccumulator(toolCall, stepNumber)),
    usage,
  }
}

function createJsonSchemaParameters(inputSchema: z.ZodObject) {
  const schema = z.toJSONSchema(inputSchema, {
    target: "draft-07",
  }) as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "~standard")
  )
}

function createChatCompletionApiPayload(
  requestPayload: LlamaCppChatCompletionRequestPayload,
  messages: ChatCompletionMessageParam[]
): ChatCompletionCreateParamsStreaming {
  const payload: ChatCompletionCreateParamsStreaming = {
    model: requestPayload.model,
    max_tokens: requestPayload.max_tokens,
    messages,
    metadata: requestPayload.metadata,
    parallel_tool_calls: requestPayload.parallel_tool_calls,
    tools: requestPayload.tools,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  }

  return payload
}

function normalizeLlamaCppToolCall(
  toolCall: unknown,
  stepNumber: number,
  index: number
): LlamaCppChatCompletionToolCall {
  const toolCallRecord = asRecord(toolCall)
  const functionRecord = asRecord(toolCallRecord.function)
  const customRecord = asRecord(toolCallRecord.custom)
  const name =
    getStringProperty(functionRecord, "name") ??
    getStringProperty(toolCallRecord, "name") ??
    getStringProperty(customRecord, "name")

  if (!name) {
    throw new Error("llama.cpp returned a tool call without a function name.")
  }

  return {
    argumentsText:
      getStringProperty(functionRecord, "arguments") ??
      getStringProperty(toolCallRecord, "arguments") ??
      getStringProperty(customRecord, "input") ??
      "{}",
    id:
      getStringProperty(toolCallRecord, "id") ??
      `llamacpp_call_${stepNumber}_${index + 1}`,
    name,
    rawToolCall: toolCall,
  }
}

function createAssistantToolCallMessage(
  outputText: string,
  toolCalls: readonly LlamaCppChatCompletionToolCall[]
): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: outputText || null,
    tool_calls: toolCalls.map(createOpenAiToolCall),
  }
}

function createOpenAiToolCall(
  toolCall: LlamaCppChatCompletionToolCall
): ChatCompletionMessageToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsText,
    },
  }
}

function getLlamaCppReasoningDelta(deltaRecord: Record<string, unknown>) {
  return (
    getStringProperty(deltaRecord, "reasoning_content") ??
    getStringProperty(deltaRecord, "reasoning") ??
    getStringProperty(deltaRecord, "reasoning_delta") ??
    getStringProperty(deltaRecord, "reasoningDelta")
  )
}

function rememberLlamaCppStreamingToolCallDeltas(
  toolCallAccumulators: Map<number, LlamaCppStreamingToolCallAccumulator>,
  deltaRecord: Record<string, unknown>,
  stepNumber: number
) {
  const toolCalls = deltaRecord.tool_calls

  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      rememberLlamaCppStreamingToolCallDelta(
        toolCallAccumulators,
        toolCall,
        stepNumber
      )
    }
  }

  const functionCallRecord = asRecord(deltaRecord.function_call)

  if (Object.keys(functionCallRecord).length > 0) {
    rememberLlamaCppStreamingToolCallDelta(
      toolCallAccumulators,
      {
        index: 0,
        function: functionCallRecord,
      },
      stepNumber
    )
  }
}

function rememberLlamaCppStreamingToolCallDelta(
  toolCallAccumulators: Map<number, LlamaCppStreamingToolCallAccumulator>,
  toolCall: unknown,
  stepNumber: number
) {
  const toolCallRecord = asRecord(toolCall)
  const functionRecord = asRecord(toolCallRecord.function)
  const customRecord = asRecord(toolCallRecord.custom)
  const index =
    typeof toolCallRecord.index === "number" ? toolCallRecord.index : 0
  const accumulator =
    toolCallAccumulators.get(index) ??
    createStreamingToolCallAccumulator(index, stepNumber)
  const id = getStringProperty(toolCallRecord, "id")
  const nameDelta =
    getStringProperty(functionRecord, "name") ??
    getStringProperty(toolCallRecord, "name") ??
    getStringProperty(customRecord, "name")
  const argumentsDelta =
    getStringProperty(functionRecord, "arguments") ??
    getStringProperty(toolCallRecord, "arguments") ??
    getStringProperty(customRecord, "input")

  if (id) {
    accumulator.id = id
  }

  if (nameDelta) {
    accumulator.name += nameDelta
  }

  if (argumentsDelta) {
    accumulator.argumentsText += argumentsDelta
  }

  toolCallAccumulators.set(index, accumulator)
}

function createStreamingToolCallAccumulator(
  index: number,
  stepNumber: number
): LlamaCppStreamingToolCallAccumulator {
  return {
    argumentsText: "",
    id: `llamacpp_call_${stepNumber}_${index + 1}`,
    index,
    name: "",
  }
}

function createToolCallFromAccumulator(
  toolCall: LlamaCppStreamingToolCallAccumulator,
  stepNumber: number
): LlamaCppChatCompletionToolCall {
  const rawToolCall = {
    id: toolCall.id ?? `llamacpp_call_${stepNumber}_${toolCall.index + 1}`,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsText,
    },
  }

  return normalizeLlamaCppToolCall(rawToolCall, stepNumber, toolCall.index)
}

function parseAndValidateToolArguments(
  toolCall: LlamaCppChatCompletionToolCall,
  toolDefinition: LlamaCppToolDefinition
) {
  let parsedArguments: unknown

  try {
    parsedArguments = toolCall.argumentsText.trim()
      ? JSON.parse(toolCall.argumentsText)
      : {}
  } catch (error) {
    throw new Error(
      `llama.cpp tool ${toolCall.name} arguments were not valid JSON.`,
      {
        cause: error,
      }
    )
  }

  if (
    typeof parsedArguments !== "object" ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    throw new Error(
      `llama.cpp tool ${toolCall.name} arguments must be a JSON object.`
    )
  }

  const parsedInput = toolDefinition.inputSchema.safeParse(parsedArguments)

  if (!parsedInput.success) {
    throw new Error(
      `llama.cpp tool ${toolCall.name} arguments did not match schema: ${parsedInput.error.message}`
    )
  }

  return parsedInput.data as Record<string, unknown>
}

function formatToolOutputForMessage(toolOutput: unknown) {
  if (typeof toolOutput === "string") {
    return toolOutput
  }

  return JSON.stringify(toolOutput) ?? "null"
}
