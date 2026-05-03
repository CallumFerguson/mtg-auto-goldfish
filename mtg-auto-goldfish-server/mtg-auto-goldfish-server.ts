import "dotenv/config"
import express, { type Request, type Response } from "express"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { OpenRouter, stepCountIs, tool, type Tool } from "@openrouter/agent"
import { randomUUID } from "node:crypto"
import OpenAI from "openai"
import { z } from "zod/v4"
import { closeDatabasePool, verifyDatabaseConnection } from "./db.js"
import {
  DRAW_STARTING_HAND_PROMPT,
  GENERIC_GAME_RULES_REFERENCE,
  SIMULATE_TURN_PROMPT,
} from "./llm/prompt-constants.js"
import {
  createDeck,
  deleteDeck,
  ensureDecksSchema,
  getDeck,
  listDecks,
  updateDeckDetails,
} from "./decks-postgres.js"
import { ensureFreshScryfallOracleCards } from "./scryfall-cache.js"
import {
  appendLlmRunChunkAtNextSequence,
  appendLlmRunChunks,
  cancelLlmRun,
  cancelStaleInFlightLlmRuns,
  completeOpeningHandLlmRun,
  completeTurnLlmRun,
  createOpeningHandLlmRun,
  createSimulation,
  createTurnLlmRun,
  deleteSimulation,
  drawCardsFromBottom,
  drawCardsFromTop,
  drawStartingHand,
  ensureSimulationsSchema,
  failLlmRun,
  getSimulationCreationDecision,
  getSimulationDebugInfo,
  getSimulationResultsInfo,
  getSimulationSummary,
  getStartingHandSimulationPromptData,
  getTurnSimulationPromptData,
  listActiveSimulationLlmRuns,
  listSimulationsForDeck,
  logTurnAction,
  markLlmRunStreaming,
  markSimulationCancelled,
  markSimulationCompleted,
  markSimulationFailed,
  mulliganSimulation,
  requestCancelSimulationLlmRuns,
  resetSimulationForOpeningHandLlmRun,
  returnCardToSimulationLibrary,
  returnCardsToSimulationLibrary,
  resolveSimulationIdentifier,
  shuffleSimulationLibrary,
  SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE,
  SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE,
  SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
  SimulationValidationError,
  takeCardsFromSimulationLibrary,
  updateLlmRunRequestData,
} from "./simulations-postgres.js"
import type {
  LlmRunChunkInput,
  LlmRunPhase,
  LlmRunStatus,
  SimulationDebugLlmRun,
  SimulationLlmCompletionResult,
  SimulationPromptCard,
  SimulationResultsInfo,
  SimulationSummary,
  StartingHandSimulationPromptData,
  TurnSimulationPromptData,
} from "./simulations-postgres.js"
import {
  createStartingHand,
  ensureStartingHandsSchema,
  listStartingHandsForDeck,
  StartingHandValidationError,
} from "./starting-hands-postgres.js"
import {
  createSavedSeed,
  ensureSavedSeedsSchema,
  listSavedSeedsForDeck,
  SavedSeedValidationError,
} from "./saved-seeds-postgres.js"
import {
  ProviderTerminalEventError,
  asRecord,
  createCancellationChunk,
  createServerErrorChunk,
  getCompletedResponseOutputText,
  getErrorMessage,
  getStringProperty,
  isAbortError,
  isProviderTerminalEvent,
  normalizeOpenAiStreamEvent,
  normalizeOpenRouterStreamEvent,
  parseOpeningHandFromResponseText,
  parseTurnSimulationFromResponseText,
  type OpenRouterToolCallNameMap,
} from "./llm-run-events.js"
import {
  collectLlamaCppChatCompletion,
  createLlamaCppChatCompletionTools,
  getLlamaCppServerModelName,
  type LlamaCppChatCompletionRequestPayload,
  type LlamaCppToolDefinition,
} from "./llamacpp-chat.js"
import {
  callWithRuntimeAbortSignal,
  createRuntimeAbortError,
  forEachRuntimeAbortableAsync,
  registerRuntimeAbortHandler,
  throwIfRuntimeAborted,
} from "./llm-runtime-cancellation.js"
import {
  LlmConfigurationError,
  getOpeningHandLlmRunConfig,
  getTurnSimulationLlmRunConfig,
  type OpenAiRunConfig,
  type OpenRouterRunConfig,
  type OpeningHandLlmRunConfig,
  type OpeningHandOpenAiRunConfig,
  type ResolvedLlamaCppRunConfig,
  type ResolvedOpeningHandLlmRunConfig,
  type ResolvedTurnSimulationLlmRunConfig,
  type TurnSimulationLlmRunConfig,
  type TurnSimulationOpenAiRunConfig,
} from "./llm-config.js"
import {
  SimulationStopTimeoutError,
  waitForSimulationStopCompletions,
} from "./simulation-stop.js"
import {
  SimulationResultsBroadcaster,
  formatSseComment,
  formatSseEvent,
  type SimulationResultsStreamChunk,
  type SimulationResultsStreamEvent,
  type SimulationResultsStreamInfo,
  type SimulationResultsStreamRun,
} from "./simulation-results-stream.js"
import {
  aggregateOpenRouterUsage,
  estimateLlmTokenPriceCents,
} from "./openai-pricing.js"
import {
  createExactScryfallOracleCardMatchMap,
  normalizeScryfallCardNameForExactMatch,
  resolveExactScryfallOracleCards,
} from "./scryfall-postgres.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3001
const SERVER_NAME = "mtg-auto-goldfish-server"
const OPENING_HAND_SERVER_NAME = "opening-hand-server"
const TURN_SIMULATION_SERVER_NAME = "turn-simulation-server"
const SIMULATION_SERVER_NAME = "simulation-server"
const OPENING_HAND_MCP_PATH = "/mcp/opening-hand"
const TURN_SIMULATION_MCP_PATH = "/mcp/turn-simulation"
const SIMULATION_MCP_PATH = "/mcp/simulation"
const OPENING_HAND_MCP_SERVER_LABEL = "opening_hand"
const TURN_SIMULATION_MCP_SERVER_LABEL = "turn_simulation"
const STREAM_FLUSH_INTERVAL_MS = 1000
const STREAM_RECENT_CHUNK_LIMIT = 500
const SSE_KEEPALIVE_INTERVAL_MS = 15000
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]
const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Last-Event-ID",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
]

const llmRunIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The LLM Run ID from the prompt.")
const llmRunIdentifierSchema = {
  llmRunId: llmRunIdSchema,
}
const simulationIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The Simulation ID returned by create_simulation.")
const simulationIdentifierSchema = {
  simulationId: simulationIdSchema,
}
const createDeckSchema = z.object({
  name: z.string().trim().min(1),
  desc: z.string(),
  commanders: z.array(z.string().trim().min(1)).min(1).max(2),
  cards: z.array(
    z.object({
      name: z.string().trim().min(1),
      quantity: z.number().int().positive(),
    })
  ),
})
const updateDeckDetailsSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
})
const createStartingHandSchema = z.object({
  name: z.string().trim().min(1),
  cards: z
    .array(
      z.object({
        deckCardId: z.number().int().positive(),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
})
const createSavedSeedSchema = z.object({
  name: z.string().trim().min(1),
  seed: z.string().trim().min(1),
})
const createSimulationSchema = z.object({
  seed: z.string().trim().min(1),
  turnsToSimulate: z.number().int().nonnegative(),
  startingHandId: z.uuid().nullable(),
})
const createTurnLlmRunSchema = z.object({
  turnNumber: z.number().int().positive(),
})

type ActiveLlmRunRuntime = {
  abortController: AbortController
  attemptNumber: number
  chunkBuffer: LlmRunChunkInput[]
  completionPromise: Promise<void>
  deckId: string
  flushTimer: NodeJS.Timeout | null
  flushPromise: Promise<void> | null
  llmRunId: string
  model: string
  nextSequence: number
  phase: LlmRunPhase
  provider: string
  reasoningEffort: string
  recentChunks: SimulationResultsStreamChunk[]
  resolveCompletion: () => void
  runtimeStreamKey: string
  simulationId: string
  status: LlmRunStatus
  turnNumber?: number
}

const activeLlmRunRuntimes = new Map<string, ActiveLlmRunRuntime>()
const simulationResultsBroadcaster = new SimulationResultsBroadcaster()

function createRuntimeCompletion() {
  let resolveCompletion: () => void = () => {}
  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  return {
    completionPromise,
    resolveCompletion,
  }
}

function isTerminalSimulationStatus(status: SimulationSummary["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function shouldStreamSimulationResultsChunk(chunk: LlmRunChunkInput) {
  return !SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS.includes(chunk.kind)
}

function createRuntimeStreamChunk(
  chunk: LlmRunChunkInput
): SimulationResultsStreamChunk {
  return {
    id: null,
    sequence: chunk.sequence,
    kind: chunk.kind,
    mcpFunctionName: chunk.mcpFunctionName,
    mcpFunctionOutput: chunk.mcpFunctionOutput,
    reasoningDelta: chunk.reasoningDelta,
    outputDelta: chunk.outputDelta,
    payload: chunk.payload,
    receivedAt: new Date().toISOString(),
  }
}

function rememberRuntimeStreamChunk(
  runtime: ActiveLlmRunRuntime,
  chunk: SimulationResultsStreamChunk
) {
  runtime.recentChunks.push(chunk)

  if (runtime.recentChunks.length > STREAM_RECENT_CHUNK_LIMIT) {
    runtime.recentChunks.splice(
      0,
      runtime.recentChunks.length - STREAM_RECENT_CHUNK_LIMIT
    )
  }
}

function createStreamRunFromRuntime(
  runtime: ActiveLlmRunRuntime,
  chunks = runtime.recentChunks
): SimulationResultsStreamRun {
  return {
    llmRunId: runtime.llmRunId,
    phase: runtime.phase,
    provider: runtime.provider,
    model: runtime.model,
    estimatedPriceCents: null,
    reasoningEffort: runtime.reasoningEffort,
    status: runtime.status,
    runtimeStreamKey: runtime.runtimeStreamKey,
    attemptNumber: runtime.attemptNumber,
    turnNumber: runtime.turnNumber,
    chunks,
  }
}

function createStreamRunFromPersistedRun(
  run: SimulationDebugLlmRun
): SimulationResultsStreamRun {
  return {
    ...run,
    chunks: run.chunks.map((chunk) => ({
      ...chunk,
      id: chunk.id,
    })),
  }
}

function createStreamResultsInfo(
  results: SimulationResultsInfo
): SimulationResultsStreamInfo {
  return {
    ...results,
    openingHandLlmRuns: results.openingHandLlmRuns.map(
      createStreamRunFromPersistedRun
    ),
    turnLlmRuns: results.turnLlmRuns.map(createStreamRunFromPersistedRun),
  }
}

function mergeActiveRuntimeChunksIntoResults(
  results: SimulationResultsStreamInfo,
  simulationId: string
): SimulationResultsStreamInfo {
  let mergedResults = results

  for (const runtime of activeLlmRunRuntimes.values()) {
    if (runtime.simulationId !== simulationId) {
      continue
    }

    mergedResults = upsertStreamRun(
      mergedResults,
      createStreamRunFromRuntime(runtime)
    )
  }

  return mergedResults
}

function upsertStreamRun(
  results: SimulationResultsStreamInfo,
  incomingRun: SimulationResultsStreamRun
): SimulationResultsStreamInfo {
  if (incomingRun.phase === "opening_hand") {
    const openingHandLlmRuns = upsertStreamRunInList(
      results.openingHandLlmRuns,
      incomingRun
    ).sort(compareOpeningHandStreamRuns)

    return {
      ...results,
      openingHandLlmRunCount: openingHandLlmRuns.length,
      openingHandLlmRuns,
    }
  }

  if (incomingRun.phase === "turn") {
    const turnLlmRuns = upsertStreamRunInList(
      results.turnLlmRuns,
      incomingRun
    ).sort(compareTurnStreamRuns)

    return {
      ...results,
      turnLlmRunCount: turnLlmRuns.length,
      turnLlmRuns,
    }
  }

  return results
}

function upsertStreamRunInList(
  runs: readonly SimulationResultsStreamRun[],
  incomingRun: SimulationResultsStreamRun
) {
  const existingRun = runs.find((run) => run.llmRunId === incomingRun.llmRunId)

  if (!existingRun) {
    return [
      ...runs,
      {
        ...incomingRun,
        chunks: [...incomingRun.chunks].sort(compareStreamChunks),
      },
    ]
  }

  const mergedRun = {
    ...incomingRun,
    ...existingRun,
    status: incomingRun.status,
    chunks: mergeStreamChunks(existingRun.chunks, incomingRun.chunks),
  }

  return runs.map((run) =>
    run.llmRunId === incomingRun.llmRunId ? mergedRun : run
  )
}

function mergeStreamChunks(
  existingChunks: readonly SimulationResultsStreamChunk[],
  incomingChunks: readonly SimulationResultsStreamChunk[]
) {
  const chunksBySequence = new Map<number, SimulationResultsStreamChunk>()

  for (const chunk of existingChunks) {
    chunksBySequence.set(chunk.sequence, chunk)
  }

  for (const chunk of incomingChunks) {
    const existingChunk = chunksBySequence.get(chunk.sequence)

    if (!existingChunk || existingChunk.id === null || chunk.id !== null) {
      chunksBySequence.set(chunk.sequence, chunk)
    }
  }

  return Array.from(chunksBySequence.values()).sort(compareStreamChunks)
}

function compareStreamChunks(
  firstChunk: SimulationResultsStreamChunk,
  secondChunk: SimulationResultsStreamChunk
) {
  return firstChunk.sequence - secondChunk.sequence
}

function compareOpeningHandStreamRuns(
  firstRun: SimulationResultsStreamRun,
  secondRun: SimulationResultsStreamRun
) {
  return firstRun.attemptNumber - secondRun.attemptNumber
}

function compareTurnStreamRuns(
  firstRun: SimulationResultsStreamRun,
  secondRun: SimulationResultsStreamRun
) {
  return (
    (firstRun.turnNumber ?? 0) - (secondRun.turnNumber ?? 0) ||
    firstRun.attemptNumber - secondRun.attemptNumber
  )
}

function findStreamRun(results: SimulationResultsStreamInfo, llmRunId: string) {
  return (
    results.openingHandLlmRuns.find((run) => run.llmRunId === llmRunId) ??
    results.turnLlmRuns.find((run) => run.llmRunId === llmRunId) ??
    null
  )
}

async function getSimulationResultsStreamSnapshot(
  deckId: string,
  simulationId: string
) {
  const simulation = await getSimulationSummary(deckId, simulationId)

  if (!simulation) {
    throw new SimulationValidationError("Simulation not found.")
  }

  const results = mergeActiveRuntimeChunksIntoResults(
    createStreamResultsInfo(
      await getSimulationResultsInfo(deckId, simulationId)
    ),
    simulationId
  )

  return {
    simulation,
    results,
  }
}

function publishRuntimeStarted(runtime: ActiveLlmRunRuntime) {
  simulationResultsBroadcaster.publish(runtime.simulationId, {
    type: "llm_run_started",
    run: createStreamRunFromRuntime(runtime, []),
  })
}

function publishRuntimeChunk(
  runtime: ActiveLlmRunRuntime,
  chunk: LlmRunChunkInput
) {
  if (!shouldStreamSimulationResultsChunk(chunk)) {
    return
  }

  const streamChunk = createRuntimeStreamChunk(chunk)

  rememberRuntimeStreamChunk(runtime, streamChunk)
  simulationResultsBroadcaster.publish(runtime.simulationId, {
    type: "chunk",
    llmRunId: runtime.llmRunId,
    chunk: streamChunk,
  })
}

async function publishSimulationResultsState({
  deckId,
  llmRunId,
  simulationId,
}: {
  deckId: string
  simulationId: string
  llmRunId?: string
}) {
  try {
    const snapshot = await getSimulationResultsStreamSnapshot(
      deckId,
      simulationId
    )

    if (llmRunId) {
      const run = findStreamRun(snapshot.results, llmRunId)

      if (run) {
        simulationResultsBroadcaster.publish(simulationId, {
          type: "llm_run_updated",
          run,
        })
      }
    }

    simulationResultsBroadcaster.publish(simulationId, {
      type: "simulation_updated",
      simulation: snapshot.simulation,
    })

    if (isTerminalSimulationStatus(snapshot.simulation.status)) {
      simulationResultsBroadcaster.publish(simulationId, {
        type: "done",
        simulation: snapshot.simulation,
        results: snapshot.results,
      })
      simulationResultsBroadcaster.closeSimulation(simulationId)
    }
  } catch (error) {
    console.error("Failed to publish simulation results stream state:", error)
  }
}

function logLlmApiCallStarted({
  llmRunId,
  model,
  phase,
  provider,
}: {
  llmRunId: string
  model: string
  phase: LlmRunPhase
  provider: string
}) {
  console.log(
    `${formatProviderName(provider)} API call started: phase=${phase} llmRunId=${llmRunId} model=${model}`
  )
}

function logLlmApiCallFinished({
  llmRunId,
  model,
  phase,
  provider,
  usage,
}: {
  llmRunId: string
  model: string
  phase: LlmRunPhase
  provider: string
  usage: unknown
}) {
  const tokenUsage = getLlmTokenUsageSummary(usage)
  const priceEstimate = estimateLlmTokenPriceCents({ model, provider, usage })
  const priceEstimateText = priceEstimate
    ? `${priceEstimate.formattedCents}c`
    : "unsupported"

  console.log(
    `${formatProviderName(provider)} API call finished: phase=${phase} llmRunId=${llmRunId} totalTokens=${tokenUsage.total} inputTokens=${tokenUsage.input} cachedInputTokens=${tokenUsage.cachedInput} reasoningTokens=${tokenUsage.reasoning} outputTokens=${tokenUsage.output} estimatedPrice=${priceEstimateText}`
  )
}

function logLlmApiCallCancelled({
  llmRunId,
  phase,
  provider,
}: {
  llmRunId: string
  phase: LlmRunPhase
  provider: string
}) {
  console.log(
    `${formatProviderName(provider)} API call cancelled: phase=${phase} llmRunId=${llmRunId}`
  )
}

function logLlmApiCallStoppedWithError({
  error,
  llmRunId,
  phase,
  provider,
}: {
  error: unknown
  llmRunId: string
  phase: LlmRunPhase
  provider: string
}) {
  console.error(
    `${formatProviderName(provider)} API call stopped with error: phase=${phase} llmRunId=${llmRunId} error=${getErrorMessage(error)}`,
    error
  )
}

function getLlmTokenUsageSummary(usage: unknown) {
  const usageRecord = asRecord(usage)
  const inputTokens = getNumberProperty(
    usageRecord,
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens"
  )
  const inputDetails = asRecord(
    usageRecord.input_tokens_details ??
      usageRecord.inputTokensDetails ??
      usageRecord.prompt_tokens_details ??
      usageRecord.promptTokensDetails
  )
  const cachedInputTokens =
    inputTokens === null
      ? null
      : Math.min(
          getNumberProperty(inputDetails, "cached_tokens", "cachedTokens") ?? 0,
          inputTokens
        )
  const outputTokens = getNumberProperty(
    usageRecord,
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens"
  )
  const outputDetails = asRecord(
    usageRecord.output_tokens_details ??
      usageRecord.outputTokensDetails ??
      usageRecord.completion_tokens_details ??
      usageRecord.completionTokensDetails
  )
  const reasoningTokens =
    getNumberProperty(outputDetails, "reasoning_tokens", "reasoningTokens") ?? 0
  const visibleOutputTokens =
    outputTokens === null ? null : Math.max(outputTokens - reasoningTokens, 0)
  const totalTokens =
    getNumberProperty(usageRecord, "total_tokens", "totalTokens") ??
    sumTokenCounts([
      getNumberProperty(
        usageRecord,
        "input_tokens",
        "inputTokens",
        "prompt_tokens",
        "promptTokens"
      ),
      reasoningTokens,
      visibleOutputTokens,
    ])

  return {
    input: formatTokenCount(inputTokens),
    cachedInput: formatTokenCount(cachedInputTokens),
    output: formatTokenCount(visibleOutputTokens),
    reasoning: formatTokenCount(reasoningTokens),
    total: formatTokenCount(totalTokens),
  }
}

function getNumberProperty(
  record: Record<string, unknown>,
  ...properties: string[]
) {
  for (const property of properties) {
    const value = record[property]

    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return null
}

function formatProviderName(provider: string) {
  if (provider === "openai") {
    return "OpenAI"
  }

  if (provider === "openrouter") {
    return "OpenRouter"
  }

  if (provider === "llamacpp") {
    return "llama.cpp"
  }

  return provider
}

function sumTokenCounts(tokenCounts: Array<number | null>) {
  if (tokenCounts.some((tokenCount) => tokenCount === null)) {
    return null
  }

  return tokenCounts.reduce<number>(
    (sum, tokenCount) => sum + (tokenCount ?? 0),
    0
  )
}

function formatTokenCount(tokenCount: number | null) {
  return tokenCount === null ? "unknown" : String(tokenCount)
}

function createServer(
  name: string,
  registerTools: (server: McpServer) => void
) {
  const server = new McpServer(
    {
      name,
      version: "0.0.1",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  )

  registerTools(server)

  return server
}

function createToolResultContent(message: string, data: unknown) {
  return [
    {
      type: "text" as const,
      text: JSON.stringify(
        {
          message,
          data,
        },
        null,
        2
      ),
    },
  ]
}

function createCompactToolResultContent(data: unknown) {
  return [
    {
      type: "text" as const,
      text: JSON.stringify(data),
    },
  ]
}

type LlmRunIdentifier = {
  llmRunId: string
}

type McpSimulationIdentifierInput = {
  llmRunId?: string
  simulationId?: string
}
type McpDrawCardsInput = McpSimulationIdentifierInput & {
  count: number
}
type McpMulliganInput = McpSimulationIdentifierInput & {
  reason: string
}
type McpReturnCardInput = McpSimulationIdentifierInput & {
  card: string
  side: "top" | "bottom"
  position: number
}
type McpReturnCardsInput = McpSimulationIdentifierInput & {
  cards: string[]
  side: "top" | "bottom"
  randomizeOrder: boolean
}
type McpTakeCardsInput = McpSimulationIdentifierInput & {
  cards: string[]
}
type McpLogTurnActionInput = McpSimulationIdentifierInput & {
  action: string
}

type McpSimulationIdentifierConfig = {
  inputSchema: typeof llmRunIdentifierSchema | typeof simulationIdentifierSchema
}

const llmRunMcpIdentifier: McpSimulationIdentifierConfig = {
  inputSchema: llmRunIdentifierSchema,
}
const simulationMcpIdentifier: McpSimulationIdentifierConfig = {
  inputSchema: simulationIdentifierSchema,
}

async function resolveMcpSimulationId(input: McpSimulationIdentifierInput) {
  return resolveSimulationIdentifier(input)
}

function createOpeningHandServer() {
  return createServer(OPENING_HAND_SERVER_NAME, (server) => {
    registerDrawStartingHandTool(server, llmRunMcpIdentifier)
    registerMulliganTool(server, llmRunMcpIdentifier)
    registerReturnCardsToLibraryTool(server, llmRunMcpIdentifier)
  })
}

function createTurnSimulationServer() {
  return createServer(TURN_SIMULATION_SERVER_NAME, (server) => {
    registerLogTurnActionTool(server, llmRunMcpIdentifier)
    registerDrawCardFromTopTool(server, llmRunMcpIdentifier)
    registerDrawCardFromBottomTool(server, llmRunMcpIdentifier)
    registerTakeCardsFromLibraryTool(server, llmRunMcpIdentifier)
    registerReturnCardToLibraryTool(server, llmRunMcpIdentifier)
    registerReturnCardsToLibraryTool(server, llmRunMcpIdentifier)
    registerShuffleLibraryTool(server, llmRunMcpIdentifier)
  })
}

function createSimulationServer() {
  return createServer(SIMULATION_SERVER_NAME, (server) => {
    registerCreateSimulationTool(server)
    registerDrawStartingHandTool(server, simulationMcpIdentifier)
    registerMulliganTool(server, simulationMcpIdentifier)
    registerDrawCardFromTopTool(server, simulationMcpIdentifier)
    registerDrawCardFromBottomTool(server, simulationMcpIdentifier)
    registerTakeCardsFromLibraryTool(server, simulationMcpIdentifier)
    registerReturnCardToLibraryTool(server, simulationMcpIdentifier)
    registerReturnCardsToLibraryTool(server, simulationMcpIdentifier)
    registerShuffleLibraryTool(server, simulationMcpIdentifier)
  })
}

function registerCreateSimulationTool(server: McpServer) {
  server.registerTool(
    "create_simulation",
    {
      title: "Create Simulation",
      description:
        "Create a new simulation for a deck and return the simulation ID for future tool calls.",
      inputSchema: {
        deckId: z
          .string()
          .trim()
          .min(1)
          .describe("The deck ID to create a simulation for."),
      },
    },
    async ({ deckId }) => {
      const simulation = await createSimulation(deckId, {
        seed: randomUUID(),
        turnsToSimulate: 0,
        startingHandId: null,
        createdVia: "external_mcp",
      })

      return {
        content: createToolResultContent(
          `Created simulation ${simulation.id}. Use this simulationId for future tool calls.`,
          simulation
        ),
      }
    }
  )
}

function registerDrawCardFromTopTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "draw_card_from_top",
    {
      title: "Draw Card From Top",
      description:
        "Draw one or more cards from the top of the stored library for an existing simulation.",
      inputSchema: {
        ...identifier.inputSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async (input: McpDrawCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { count } = input
      const response = await drawCardsFromTop(resolvedSimulationId, count)

      return {
        content: createToolResultContent(
          `Drew ${response.cards.length} card(s) from the top. ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerDrawCardFromBottomTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "draw_card_from_bottom",
    {
      title: "Draw Card From Bottom",
      description:
        "Draw one or more cards from the bottom of the stored library for an existing simulation.",
      inputSchema: {
        ...identifier.inputSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async (input: McpDrawCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { count } = input
      const response = await drawCardsFromBottom(resolvedSimulationId, count)

      return {
        content: createToolResultContent(
          `Drew ${response.cards.length} card(s) from the bottom. ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerDrawStartingHandTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "draw_starting_hand",
    {
      title: "Draw Starting Hand",
      description:
        "Draw the very first opening seven-card hand from the stored library for an existing simulation. Call this exactly once per simulation, before any mulligans. Never call this after mulligan, because mulligan already shuffles and draws the replacement seven-card hand.",
      inputSchema: {
        ...identifier.inputSchema,
      },
    },
    async (input: McpSimulationIdentifierInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const response = await drawStartingHand(resolvedSimulationId)

      return {
        content: createToolResultContent(
          `Drew the starting hand. ${response.cardsRemaining} card(s) remain in the library.`,
          response
        ),
      }
    }
  )
}

function registerMulliganTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "mulligan",
    {
      title: "Mulligan",
      description:
        "Return the current opening hand to the library, shuffle, and draw a fresh seven-card hand. This can only be called after the starting hand has been drawn. Important: this tool already draws and returns the replacement hand, so do not call draw_starting_hand after using this tool.",
      inputSchema: {
        ...identifier.inputSchema,
        reason: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A short explanation of why this hand is being mulliganed."
          ),
      },
    },
    async (input: McpMulliganInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { reason } = input
      const response = await mulliganSimulation(resolvedSimulationId, reason)

      return {
        content: createToolResultContent(
          `Mulligan ${response.mulliganCount}: drew a replacement seven-card hand. ${response.cardsRemaining} card(s) remain. ${response.reminder}`,
          response
        ),
      }
    }
  )
}

function registerReturnCardToLibraryTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "return_card_to_library",
    {
      title: "Return Card To Library",
      description:
        "Return a card to the library for an existing simulation, placing it a specific number of cards from the top or bottom.",
      inputSchema: {
        ...identifier.inputSchema,
        card: z
          .string()
          .trim()
          .min(1)
          .describe("The card name to put back into the library."),
        side: z
          .enum(["top", "bottom"])
          .describe(
            "Whether the position is measured from the top or the bottom of the library."
          ),
        position: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "How many cards should remain above the card if using top, or below the card if using bottom. Position 0 puts it directly on that end. For example, if you want the card 3rd from the top, use side top, position 2."
          ),
      },
    },
    async (input: McpReturnCardInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { card, position, side } = input
      const response = await returnCardToSimulationLibrary({
        simulationId: resolvedSimulationId,
        card,
        side,
        position,
      })

      return {
        content: createToolResultContent(
          `Returned ${JSON.stringify(response.card)} to the ${side} of the library. ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerReturnCardsToLibraryTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "return_cards_to_library",
    {
      title: "Return Cards To Library",
      description:
        "Return multiple cards to the top or bottom of the library for an existing simulation, optionally randomizing the order they are returned in.",
      inputSchema: {
        ...identifier.inputSchema,
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The cards to put back into the library. If randomizeOrder is false, they are inserted in list order, so the last card becomes the outermost card on the chosen side."
          ),
        side: z
          .enum(["top", "bottom"])
          .describe("Which end of the library to return the cards to."),
        randomizeOrder: z
          .boolean()
          .describe(
            "Whether to shuffle the returned cards before putting them back."
          ),
      },
    },
    async (input: McpReturnCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { cards, randomizeOrder, side } = input
      const response = await returnCardsToSimulationLibrary({
        simulationId: resolvedSimulationId,
        cards,
        side,
        randomizeOrder,
      })

      return {
        content: createToolResultContent(
          `Returned ${response.cards.length} card(s) to the ${side} of the library. ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerTakeCardsFromLibraryTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "take_cards_from_library",
    {
      title: "Take Cards From Library",
      description:
        "Take one or more specific cards out of the stored library for tutor and search effects. Each requested name uses the best reasonably close fuzzy match, ignoring case and punctuation. If no close enough match exists, that request returns no card.",
      inputSchema: {
        ...identifier.inputSchema,
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The card names to remove from the library. Each request is matched independently against the current remaining library."
          ),
      },
    },
    async (input: McpTakeCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { cards } = input
      const response = await takeCardsFromSimulationLibrary(
        resolvedSimulationId,
        cards
      )

      return {
        content: createToolResultContent(
          `Found and removed ${response.foundCards.length} requested card(s). ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerShuffleLibraryTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "shuffle_library",
    {
      title: "Shuffle Library",
      description: "Shuffle the stored library for an existing simulation.",
      inputSchema: {
        ...identifier.inputSchema,
      },
    },
    async (input: McpSimulationIdentifierInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const response = await shuffleSimulationLibrary(resolvedSimulationId)

      return {
        content: createToolResultContent(
          `Shuffled the library. ${response.cardsRemaining} card(s) remain.`,
          response
        ),
      }
    }
  )
}

function registerLogTurnActionTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "log_turn_action",
    {
      title: "Log Turn Action",
      description:
        "Append an irreversible action note to the active turn log for this simulation. Use this as the authoritative turn history while resolving the turn. The response returns the full logged action list for the active turn.",
      inputSchema: {
        ...identifier.inputSchema,
        action: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A concise description of the action being committed, such as a phase change, land play, spell cast, attack, or other turn progression."
          ),
      },
    },
    async (input: McpLogTurnActionInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(input)
      const { action } = input
      const response = await logTurnAction(resolvedSimulationId, action)

      return {
        content: createCompactToolResultContent({
          data: {
            loggedActions: response.actions.map(
              (loggedAction) => loggedAction.action
            ),
          },
          message: `Logged action: ${response.latestAction.action}`,
        }),
      }
    }
  )
}

const openingHandLlmToolDefinitions: LlamaCppToolDefinition[] = [
  {
    name: "draw_starting_hand",
    description:
      "Draw the very first opening seven-card hand from the stored library for an existing simulation. Call this exactly once per simulation, before any mulligans. Never call this after mulligan, because mulligan already shuffles and draws the replacement seven-card hand.",
    inputSchema: z.object(llmRunIdentifierSchema),
  },
  {
    name: "mulligan",
    description:
      "Return the current opening hand to the library, shuffle, and draw a fresh seven-card hand. This can only be called after the starting hand has been drawn. Important: this tool already draws and returns the replacement hand, so do not call draw_starting_hand after using this tool.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: z
        .string()
        .trim()
        .min(1)
        .describe("A short explanation of why this hand is being mulliganed."),
    }),
  },
  {
    name: "return_cards_to_library",
    description:
      "Return multiple cards to the top or bottom of the library for an existing simulation, optionally randomizing the order they are returned in.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      cards: z
        .array(z.string().trim().min(1))
        .min(1)
        .describe(
          "The cards to put back into the library. If randomizeOrder is false, they are inserted in list order, so the last card becomes the outermost card on the chosen side."
        ),
      side: z
        .enum(["top", "bottom"])
        .describe("Which end of the library to return the cards to."),
      randomizeOrder: z
        .boolean()
        .describe("Whether to shuffle the returned cards before putting them back."),
    }),
  },
]

const turnSimulationLlmToolDefinitions: LlamaCppToolDefinition[] = [
  {
    name: "log_turn_action",
    description:
      "Append an irreversible action note to the active turn log for this simulation. Use this as the authoritative turn history while resolving the turn. The response returns the full logged action list for the active turn.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      action: z
        .string()
        .trim()
        .min(1)
        .describe(
          "A concise description of the action being committed, such as a phase change, land play, spell cast, attack, or other turn progression."
        ),
    }),
  },
  {
    name: "draw_card_from_top",
    description:
      "Draw one or more cards from the top of the stored library for an existing simulation.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      count: z.number().int().positive().describe("How many cards to draw."),
    }),
  },
  {
    name: "draw_card_from_bottom",
    description:
      "Draw one or more cards from the bottom of the stored library for an existing simulation.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      count: z.number().int().positive().describe("How many cards to draw."),
    }),
  },
  {
    name: "take_cards_from_library",
    description:
      "Take one or more specific cards out of the stored library for tutor and search effects. Each requested name uses the best reasonably close fuzzy match, ignoring case and punctuation. If no close enough match exists, that request returns no card.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      cards: z
        .array(z.string().trim().min(1))
        .min(1)
        .describe(
          "The card names to remove from the library. Each request is matched independently against the current remaining library."
        ),
    }),
  },
  {
    name: "return_card_to_library",
    description:
      "Return a card to the library for an existing simulation, placing it a specific number of cards from the top or bottom.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      card: z
        .string()
        .trim()
        .min(1)
        .describe("The card name to put back into the library."),
      side: z
        .enum(["top", "bottom"])
        .describe(
          "Whether the position is measured from the top or the bottom of the library."
        ),
      position: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "How many cards should remain above the card if using top, or below the card if using bottom. Position 0 puts it directly on that end. For example, if you want the card 3rd from the top, use side top, position 2."
        ),
    }),
  },
  {
    name: "return_cards_to_library",
    description:
      "Return multiple cards to the top or bottom of the library for an existing simulation, optionally randomizing the order they are returned in.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      cards: z
        .array(z.string().trim().min(1))
        .min(1)
        .describe(
          "The cards to put back into the library. If randomizeOrder is false, they are inserted in list order, so the last card becomes the outermost card on the chosen side."
        ),
      side: z
        .enum(["top", "bottom"])
        .describe("Which end of the library to return the cards to."),
      randomizeOrder: z
        .boolean()
        .describe("Whether to shuffle the returned cards before putting them back."),
    }),
  },
  {
    name: "shuffle_library",
    description: "Shuffle the stored library for an existing simulation.",
    inputSchema: z.object(llmRunIdentifierSchema),
  },
]

function createOpeningHandOpenRouterTools(
  mcpClient: Client,
  signal: AbortSignal
): Tool[] {
  return createOpenRouterTools(
    openingHandLlmToolDefinitions,
    mcpClient,
    signal
  )
}

function createTurnSimulationOpenRouterTools(
  mcpClient: Client,
  signal: AbortSignal
): Tool[] {
  return createOpenRouterTools(
    turnSimulationLlmToolDefinitions,
    mcpClient,
    signal
  )
}

function createOpenRouterTools(
  toolDefinitions: readonly LlamaCppToolDefinition[],
  mcpClient: Client,
  signal: AbortSignal
): Tool[] {
  return toolDefinitions.map((definition) =>
    tool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input) =>
        callMcpToolForProvider(
          mcpClient,
          definition.name,
          input,
          signal,
          "OpenRouter"
        ),
    })
  )
}

async function callMcpToolForProvider(
  mcpClient: Client,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  providerName: string
) {
  const result = await callWithRuntimeAbortSignal(
    signal,
    (options) =>
      mcpClient.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        options
      ),
    `${providerName} MCP tool ${name} was cancelled.`
  )

  return formatMcpToolResultForProvider(result)
}

function formatMcpToolResultForProvider(result: unknown) {
  const resultRecord = asRecord(result)

  if (Object.hasOwn(resultRecord, "structuredContent")) {
    return resultRecord.structuredContent
  }

  if (Object.hasOwn(resultRecord, "toolResult")) {
    return resultRecord.toolResult
  }

  const textContent = getMcpToolResultTextContent(resultRecord)

  if (textContent !== null) {
    return parseMcpToolResultTextContent(textContent)
  }

  return Object.hasOwn(resultRecord, "content") ? resultRecord.content : result
}

function getMcpToolResultTextContent(resultRecord: Record<string, unknown>) {
  const content = resultRecord.content

  if (!Array.isArray(content)) {
    return null
  }

  const textParts = content.flatMap((part) => {
    const partRecord = asRecord(part)

    if (partRecord.type !== "text") {
      return []
    }

    const text = getStringProperty(partRecord, "text")

    return text === null ? [] : [text]
  })

  return textParts.length === 0 ? null : textParts.join("\n")
}

function parseMcpToolResultTextContent(textContent: string) {
  if (!textContent.trim()) {
    return textContent
  }

  try {
    return JSON.parse(textContent) as unknown
  } catch {
    return textContent
  }
}

async function createProviderMcpClient({
  clientName,
  path,
  signal,
}: {
  clientName: string
  path: string
  signal: AbortSignal
}) {
  throwIfRuntimeAborted(signal)

  const mcpClient = new Client({
    name: `${SERVER_NAME}-${clientName}`,
    version: "0.0.1",
  })
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${DEFAULT_HOST}:${DEFAULT_PORT}${path}`)
  )

  try {
    await callWithRuntimeAbortSignal(signal, (options) =>
      mcpClient.connect(transport, options)
    )
  } catch (error) {
    await mcpClient.close().catch((closeError: unknown) => {
      console.error(
        `Failed to close aborted ${clientName} MCP client:`,
        closeError
      )
    })

    throw error
  }

  return mcpClient
}

function buildOpeningHandOpenAiRequestPayload(
  config: OpeningHandOpenAiRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  return {
    model: config.model,
    input: fullPrompt,
    stream: true as const,
    metadata: {
      simulationId,
      phase: "opening_hand",
    },
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto" as const,
    },
    tools: [
      {
        type: "mcp" as const,
        server_label: OPENING_HAND_MCP_SERVER_LABEL,
        server_description:
          "Tools for drawing, mulliganing, and finalizing a Magic: The Gathering opening hand simulation.",
        server_url: config.openingHandMcpPublicUrl,
        require_approval: "never" as const,
      },
    ],
  }
}

function buildTurnSimulationOpenAiRequestPayload(
  config: TurnSimulationOpenAiRunConfig,
  fullPrompt: string,
  simulationId: string,
  turnNumber: number
) {
  return {
    model: config.model,
    input: fullPrompt,
    stream: true as const,
    metadata: {
      simulationId,
      phase: "turn",
      turnNumber: String(turnNumber),
    },
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto" as const,
    },
    tools: [
      {
        type: "mcp" as const,
        server_label: TURN_SIMULATION_MCP_SERVER_LABEL,
        server_description:
          "Tools for resolving one Magic: The Gathering goldfish turn, including library operations and turn action logging.",
        server_url: config.turnSimulationMcpPublicUrl,
        require_approval: "never" as const,
      },
    ],
  }
}

function buildOpeningHandOpenRouterRequestPayload(
  config: OpenRouterRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  return {
    providerType: "openrouter" as const,
    model: config.model,
    input: fullPrompt,
    metadata: {
      simulationId,
      phase: "opening_hand",
    },
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto" as const,
    },
    parallelToolCalls: false as const,
    provider: getOpenRouterProviderPreferences(config.modelProvider),
    stopWhenStepCount: config.stopWhenStepCount,
  }
}

function buildOpeningHandLlamaCppRequestPayload(
  config: ResolvedLlamaCppRunConfig,
  fullPrompt: string,
  simulationId: string
): LlamaCppChatCompletionRequestPayload {
  return {
    providerType: "llamacpp",
    model: config.model,
    messages: [
      {
        role: "user",
        content: fullPrompt,
      },
    ],
    metadata: {
      simulationId,
      phase: "opening_hand",
    },
    parallel_tool_calls: false,
    reasoning_effort: config.reasoningEffort,
    tools: createLlamaCppChatCompletionTools(openingHandLlmToolDefinitions),
    stopWhenStepCount: config.stopWhenStepCount,
  }
}

function buildTurnSimulationOpenRouterRequestPayload(
  config: OpenRouterRunConfig,
  fullPrompt: string,
  simulationId: string,
  turnNumber: number
) {
  return {
    providerType: "openrouter" as const,
    model: config.model,
    input: fullPrompt,
    metadata: {
      simulationId,
      phase: "turn",
      turnNumber: String(turnNumber),
    },
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto" as const,
    },
    parallelToolCalls: false as const,
    provider: getOpenRouterProviderPreferences(config.modelProvider),
    stopWhenStepCount: config.stopWhenStepCount,
  }
}

function buildTurnSimulationLlamaCppRequestPayload(
  config: ResolvedLlamaCppRunConfig,
  fullPrompt: string,
  simulationId: string,
  turnNumber: number
): LlamaCppChatCompletionRequestPayload {
  return {
    providerType: "llamacpp",
    model: config.model,
    messages: [
      {
        role: "user",
        content: fullPrompt,
      },
    ],
    metadata: {
      simulationId,
      phase: "turn",
      turnNumber: String(turnNumber),
    },
    parallel_tool_calls: false,
    reasoning_effort: config.reasoningEffort,
    tools: createLlamaCppChatCompletionTools(turnSimulationLlmToolDefinitions),
    stopWhenStepCount: config.stopWhenStepCount,
  }
}

function getOpenRouterProviderPreferences(modelProvider: string | null) {
  if (modelProvider === null) {
    return undefined
  }

  return {
    allowFallbacks: false,
    only: [modelProvider],
  }
}

function buildOpeningHandLlmRequestPayload(
  config: ResolvedOpeningHandLlmRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  if (config.provider === "openai") {
    return buildOpeningHandOpenAiRequestPayload(
      config,
      fullPrompt,
      simulationId
    )
  }

  if (config.provider === "llamacpp") {
    return buildOpeningHandLlamaCppRequestPayload(
      config,
      fullPrompt,
      simulationId
    )
  }

  return buildOpeningHandOpenRouterRequestPayload(
    config,
    fullPrompt,
    simulationId
  )
}

function buildTurnSimulationLlmRequestPayload(
  config: ResolvedTurnSimulationLlmRunConfig,
  fullPrompt: string,
  simulationId: string,
  turnNumber: number
) {
  if (config.provider === "openai") {
    return buildTurnSimulationOpenAiRequestPayload(
      config,
      fullPrompt,
      simulationId,
      turnNumber
    )
  }

  if (config.provider === "llamacpp") {
    return buildTurnSimulationLlamaCppRequestPayload(
      config,
      fullPrompt,
      simulationId,
      turnNumber
    )
  }

  return buildTurnSimulationOpenRouterRequestPayload(
    config,
    fullPrompt,
    simulationId,
    turnNumber
  )
}

type OpeningHandLlmRequestPayload = ReturnType<
  typeof buildOpeningHandLlmRequestPayload
>
type TurnSimulationLlmRequestPayload = ReturnType<
  typeof buildTurnSimulationLlmRequestPayload
>
type OpeningHandOpenRouterRequestPayload = ReturnType<
  typeof buildOpeningHandOpenRouterRequestPayload
>
type TurnSimulationOpenRouterRequestPayload = ReturnType<
  typeof buildTurnSimulationOpenRouterRequestPayload
>
type LlamaCppRequestPayload =
  | ReturnType<typeof buildOpeningHandLlamaCppRequestPayload>
  | ReturnType<typeof buildTurnSimulationLlamaCppRequestPayload>

function getPersistableLlmRequestPayload<
  TRequestPayload extends Record<string, unknown>,
>(requestPayload: TRequestPayload) {
  const persistableRequestPayload: Record<string, unknown> = {
    ...requestPayload,
  }

  if (Object.hasOwn(persistableRequestPayload, "input")) {
    persistableRequestPayload.input = "[stored in llm_runs.full_prompt]"
  }

  if (Array.isArray(persistableRequestPayload.messages)) {
    persistableRequestPayload.messages = "[stored in llm_runs.full_prompt]"
  }

  return persistableRequestPayload
}

function formatLlmRunPhase(phase: LlmRunPhase) {
  if (phase === "opening_hand") {
    return "Opening-hand"
  }

  if (phase === "turn") {
    return "Turn"
  }

  return "Simulation"
}

async function resolveLlmRunConfigModel(
  config: OpeningHandLlmRunConfig
): Promise<ResolvedOpeningHandLlmRunConfig>
async function resolveLlmRunConfigModel(
  config: TurnSimulationLlmRunConfig
): Promise<ResolvedTurnSimulationLlmRunConfig>
async function resolveLlmRunConfigModel(
  config: OpeningHandLlmRunConfig | TurnSimulationLlmRunConfig
): Promise<
  ResolvedOpeningHandLlmRunConfig | ResolvedTurnSimulationLlmRunConfig
> {
  if (config.provider !== "llamacpp") {
    return config
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })
  const model = getLlamaCppServerModelName(await client.models.list())

  return {
    ...config,
    model,
  }
}

async function prepareAndStartOpeningHandLlmRun({
  deckId,
  resetBeforeStart,
  simulationId,
}: {
  deckId: string
  simulationId: string
  resetBeforeStart: boolean
}) {
  let createdLlmRunId: string | null = null

  try {
    const llmConfig = await resolveLlmRunConfigModel(
      getOpeningHandLlmRunConfig()
    )

    if (resetBeforeStart) {
      await resetSimulationForOpeningHandLlmRun(deckId, simulationId)
    }

    const openingHandRun = await createOpeningHandLlmRun(deckId, {
      simulationId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      reasoningEffort: llmConfig.reasoningEffort,
      runtimeStreamKey: randomUUID(),
      fullPrompt: "",
      requestPayload: {},
    })
    createdLlmRunId = openingHandRun.llmRunId
    const fullPrompt = await buildStartingHandSimulationPrompt({
      llmRunId: openingHandRun.llmRunId,
    })
    const requestPayload = buildOpeningHandLlmRequestPayload(
      llmConfig,
      fullPrompt,
      simulationId
    )

    await updateLlmRunRequestData({
      llmRunId: openingHandRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })

    startOpeningHandLlmRun({
      config: llmConfig,
      deckId,
      fullPrompt,
      attemptNumber: openingHandRun.attemptNumber,
      llmRunId: openingHandRun.llmRunId,
      requestPayload,
      runtimeStreamKey: openingHandRun.runtimeStreamKey,
      simulationId,
    })

    return openingHandRun
  } catch (error) {
    if (createdLlmRunId !== null) {
      await failLlmRun(createdLlmRunId, getErrorMessage(error)).catch(
        (failError: unknown) => {
          console.error(
            "Failed to mark opening-hand LLM run failed:",
            failError
          )
        }
      )
    }

    throw error
  }
}

async function prepareAndStartTurnLlmRun({
  deckId,
  requireAutoSimulateNextStep = false,
  simulationId,
  turnNumber,
}: {
  deckId: string
  simulationId: string
  turnNumber: number
  requireAutoSimulateNextStep?: boolean
}) {
  let createdLlmRunId: string | null = null

  try {
    const llmConfig = await resolveLlmRunConfigModel(
      getTurnSimulationLlmRunConfig()
    )
    const turnRun = await createTurnLlmRun(deckId, {
      simulationId,
      turnNumber,
      provider: llmConfig.provider,
      model: llmConfig.model,
      reasoningEffort: llmConfig.reasoningEffort,
      runtimeStreamKey: randomUUID(),
      requireAutoSimulateNextStep,
    })
    createdLlmRunId = turnRun.llmRunId

    const fullPrompt =
      turnNumber === 1
        ? await buildTurnSimulationPrompt({ llmRunId: turnRun.llmRunId })
        : await buildTurnSimulationPrompt(
            { llmRunId: turnRun.llmRunId },
            turnRun.previousGameState ?? undefined
          )
    const requestPayload = buildTurnSimulationLlmRequestPayload(
      llmConfig,
      fullPrompt,
      simulationId,
      turnNumber
    )

    await updateLlmRunRequestData({
      llmRunId: turnRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })

    startTurnLlmRun({
      config: llmConfig,
      deckId,
      fullPrompt,
      attemptNumber: turnRun.attemptNumber,
      llmRunId: turnRun.llmRunId,
      requestPayload,
      runtimeStreamKey: turnRun.runtimeStreamKey,
      simulationId,
      turnNumber: turnRun.turnNumber,
    })

    return turnRun
  } catch (error) {
    if (createdLlmRunId !== null) {
      await failLlmRun(createdLlmRunId, getErrorMessage(error)).catch(
        (failError: unknown) => {
          console.error("Failed to mark turn LLM run failed:", failError)
        }
      )
    }

    throw error
  }
}

async function startCreatedSimulationInitialStep(
  deckId: string,
  simulation: {
    id: string
    startingHandId: string | null
    turnsToSimulate: number
  }
) {
  const decision = getSimulationCreationDecision({
    hasPresetStartingHand: simulation.startingHandId !== null,
    turnsToSimulate: simulation.turnsToSimulate,
  })

  if (decision.simulationStatus === "completed") {
    await markSimulationCompleted(simulation.id)
    return
  }

  if (decision.nextStep?.type === "opening_hand") {
    await prepareAndStartOpeningHandLlmRun({
      deckId,
      simulationId: simulation.id,
      resetBeforeStart: false,
    })
    return
  }

  if (decision.nextStep?.type === "turn") {
    await prepareAndStartTurnLlmRun({
      deckId,
      simulationId: simulation.id,
      turnNumber: decision.nextStep.turnNumber,
    })
  }
}

async function handleSimulationCompletionNextStep(
  completion: SimulationLlmCompletionResult
) {
  if (completion.nextStep?.type !== "turn") {
    return
  }

  try {
    await prepareAndStartTurnLlmRun({
      deckId: completion.deckId,
      simulationId: completion.simulationId,
      turnNumber: completion.nextStep.turnNumber,
      requireAutoSimulateNextStep: true,
    })
  } catch (error) {
    if (isBenignAutoAdvanceAbortError(error)) {
      console.log(
        `Simulation auto-advance skipped: simulationId=${completion.simulationId} reason=${getErrorMessage(error)}`
      )
      return
    }

    console.error("Failed to auto-start next simulation step:", error)
    await markSimulationFailed(completion.simulationId, getErrorMessage(error))
    await publishSimulationResultsState({
      deckId: completion.deckId,
      simulationId: completion.simulationId,
    })
  }
}

function isBenignAutoAdvanceAbortError(error: unknown) {
  return (
    error instanceof SimulationValidationError &&
    (error.message === SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE ||
      error.message === SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE)
  )
}

type CompletedLlmStreamResult = {
  outputText: string
  responseMetadata: unknown
  usage: unknown
}

type OpenAiRequestPayload =
  | ReturnType<typeof buildOpeningHandOpenAiRequestPayload>
  | ReturnType<typeof buildTurnSimulationOpenAiRequestPayload>
type OpenRouterRequestPayload =
  | OpeningHandOpenRouterRequestPayload
  | TurnSimulationOpenRouterRequestPayload

function isOpenAiRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
): requestPayload is OpenAiRequestPayload {
  return "stream" in requestPayload
}

function isOpenRouterRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
): requestPayload is OpenRouterRequestPayload {
  return asRecord(requestPayload).providerType === "openrouter"
}

function isLlamaCppRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
): requestPayload is LlamaCppRequestPayload {
  return asRecord(requestPayload).providerType === "llamacpp"
}

function requireOpenAiRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
) {
  if (!isOpenAiRequestPayload(requestPayload)) {
    throw new Error("LLM run config and request payload provider mismatch.")
  }

  return requestPayload
}

function requireOpenRouterRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
) {
  if (!isOpenRouterRequestPayload(requestPayload)) {
    throw new Error("LLM run config and request payload provider mismatch.")
  }

  return requestPayload
}

function requireLlamaCppRequestPayload(
  requestPayload: OpeningHandLlmRequestPayload | TurnSimulationLlmRequestPayload
) {
  if (!isLlamaCppRequestPayload(requestPayload)) {
    throw new Error("LLM run config and request payload provider mismatch.")
  }

  return requestPayload
}

async function collectOpenAiLlmStream({
  config,
  llmRunId,
  phase,
  requestPayload,
  runtime,
}: {
  config: OpenAiRunConfig
  llmRunId: string
  phase: LlmRunPhase
  requestPayload: OpenAiRequestPayload
  runtime: ActiveLlmRunRuntime
}): Promise<CompletedLlmStreamResult> {
  let outputText = ""
  let responseMetadata: unknown = {}
  let usage: unknown = {}
  let didReceiveCompletedResponse = false
  let providerTerminalEventError: ProviderTerminalEventError | null = null
  const client = new OpenAI({
    apiKey: config.apiKey,
  })
  const signal = runtime.abortController.signal

  logLlmApiCallStarted({
    llmRunId,
    model: requestPayload.model,
    phase,
    provider: config.provider,
  })

  throwIfRuntimeAborted(signal)

  const stream = await client.responses.create(requestPayload, {
    signal,
  })

  await forEachRuntimeAbortableAsync(stream, signal, (event) => {
    const eventRecord = asRecord(event)
    const eventType = getStringProperty(eventRecord, "type")
    const normalizedEvent = normalizeOpenAiStreamEvent(event)

    if (eventType === "response.completed") {
      const response = eventRecord.response
      const responseRecord = asRecord(response)
      didReceiveCompletedResponse = true
      outputText = getCompletedResponseOutputText(response)
      responseMetadata = response ?? {}
      usage = responseRecord.usage ?? {}
    }

    appendRuntimeChunk(runtime, normalizedEvent)

    if (isProviderTerminalEvent(eventType)) {
      providerTerminalEventError = new ProviderTerminalEventError(
        eventType,
        event
      )
    }
  })

  if (providerTerminalEventError) {
    throw providerTerminalEventError
  }

  if (!didReceiveCompletedResponse) {
    throw new Error(
      `${formatLlmRunPhase(phase)} LLM stream ended without response.completed.`
    )
  }

  logLlmApiCallFinished({
    llmRunId,
    model: requestPayload.model,
    phase,
    provider: config.provider,
    usage,
  })

  return {
    outputText,
    responseMetadata,
    usage,
  }
}

async function collectOpenRouterLlmStream({
  config,
  createTools,
  llmRunId,
  mcpPath,
  phase,
  requestPayload,
  runtime,
}: {
  config: OpenRouterRunConfig
  createTools: (mcpClient: Client, signal: AbortSignal) => Tool[]
  llmRunId: string
  mcpPath: string
  phase: LlmRunPhase
  requestPayload: OpenRouterRequestPayload
  runtime: ActiveLlmRunRuntime
}): Promise<CompletedLlmStreamResult> {
  let outputText = ""
  let responseMetadata: unknown = {}
  let usage: unknown = {}
  let didReceiveCompletedResponse = false
  let providerTerminalEventError: ProviderTerminalEventError | null = null
  const completedResponseUsageValues: unknown[] = []
  const toolCallNamesById: OpenRouterToolCallNameMap = new Map()
  const openrouter = new OpenRouter({
    apiKey: config.apiKey,
  })
  const signal = runtime.abortController.signal
  const mcpClient = await createProviderMcpClient({
    clientName: "openrouter-agent",
    path: mcpPath,
    signal,
  })
  let mcpClientClosePromise: Promise<void> | null = null

  const closeMcpClient = () => {
    mcpClientClosePromise ??= mcpClient.close().catch((error: unknown) => {
      console.error("Failed to close OpenRouter MCP client:", error)
    })

    return mcpClientClosePromise
  }

  try {
    logLlmApiCallStarted({
      llmRunId,
      model: requestPayload.model,
      phase,
      provider: config.provider,
    })

    const result = openrouter.callModel(
      {
        model: requestPayload.model,
        input: requestPayload.input,
        metadata: requestPayload.metadata,
        reasoning: requestPayload.reasoning,
        parallelToolCalls: requestPayload.parallelToolCalls,
        provider: requestPayload.provider,
        stopWhen: stepCountIs(requestPayload.stopWhenStepCount),
        tools: createTools(mcpClient, signal),
      },
      {
        signal,
      }
    )
    const removeAbortHandler = registerRuntimeAbortHandler(signal, () => {
      void result.cancel().catch(() => {})
      void closeMcpClient()
    })

    try {
      // Drain the OpenRouter agent generator so its internal tool-execution
      // promise is observed after result.cancel() closes the stream.
      for await (const event of result.getFullResponsesStream()) {
        const eventRecord = asRecord(event)
        const eventType = getStringProperty(eventRecord, "type")
        const normalizedEvent = normalizeOpenRouterStreamEvent(
          event,
          toolCallNamesById
        )

        if (eventType === "response.completed") {
          const response = eventRecord.response
          const responseRecord = asRecord(response)
          didReceiveCompletedResponse = true
          outputText = getCompletedResponseOutputText(response)
          responseMetadata = response ?? {}
          completedResponseUsageValues.push(responseRecord.usage ?? {})
          usage = aggregateOpenRouterUsage(completedResponseUsageValues)
        }

        appendRuntimeChunk(runtime, normalizedEvent)

        if (isProviderTerminalEvent(eventType)) {
          providerTerminalEventError = new ProviderTerminalEventError(
            eventType,
            event,
            "OpenRouter"
          )
        }
      }
    } catch (error) {
      if (signal.aborted) {
        await result.cancel().catch(() => {})
        throw createRuntimeAbortError()
      }

      throw error
    } finally {
      removeAbortHandler()
    }
  } finally {
    await closeMcpClient()
  }

  throwIfRuntimeAborted(signal)

  if (providerTerminalEventError) {
    throw providerTerminalEventError
  }

  if (!didReceiveCompletedResponse) {
    throw new Error(
      `${formatLlmRunPhase(phase)} LLM stream ended without response.completed.`
    )
  }

  logLlmApiCallFinished({
    llmRunId,
    model: requestPayload.model,
    phase,
    provider: config.provider,
    usage,
  })

  return {
    outputText,
    responseMetadata,
    usage,
  }
}

async function collectLlamaCppLlmStream({
  config,
  llmRunId,
  mcpPath,
  phase,
  requestPayload,
  runtime,
  toolDefinitions,
}: {
  config: ResolvedLlamaCppRunConfig
  llmRunId: string
  mcpPath: string
  phase: LlmRunPhase
  requestPayload: LlamaCppRequestPayload
  runtime: ActiveLlmRunRuntime
  toolDefinitions: readonly LlamaCppToolDefinition[]
}): Promise<CompletedLlmStreamResult> {
  const signal = runtime.abortController.signal
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })
  const mcpClient = await createProviderMcpClient({
    clientName: "llamacpp-agent",
    path: mcpPath,
    signal,
  })
  let mcpClientClosePromise: Promise<void> | null = null

  const closeMcpClient = () => {
    mcpClientClosePromise ??= mcpClient.close().catch((error: unknown) => {
      console.error("Failed to close llama.cpp MCP client:", error)
    })

    return mcpClientClosePromise
  }

  try {
    logLlmApiCallStarted({
      llmRunId,
      model: requestPayload.model,
      phase,
      provider: config.provider,
    })

    const removeAbortHandler = registerRuntimeAbortHandler(signal, () => {
      void closeMcpClient()
    })

    try {
      const result = await collectLlamaCppChatCompletion({
        appendChunk: (chunk) => appendRuntimeChunk(runtime, chunk),
        callTool: (name, args, toolSignal) =>
          callMcpToolForProvider(
            mcpClient,
            name,
            args,
            toolSignal,
            "llama.cpp"
          ),
        createChatCompletion: (body, options) =>
          client.chat.completions.create(body, options),
        requestPayload,
        signal,
        toolDefinitions,
      })

      logLlmApiCallFinished({
        llmRunId,
        model: requestPayload.model,
        phase,
        provider: config.provider,
        usage: result.usage,
      })

      return result
    } catch (error) {
      if (signal.aborted) {
        throw createRuntimeAbortError()
      }

      throw error
    } finally {
      removeAbortHandler()
    }
  } finally {
    await closeMcpClient()
  }
}

function startOpeningHandLlmRun({
  attemptNumber,
  config,
  deckId,
  fullPrompt,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
  simulationId,
}: {
  attemptNumber: number
  config: ResolvedOpeningHandLlmRunConfig
  deckId: string
  fullPrompt: string
  llmRunId: string
  requestPayload: OpeningHandLlmRequestPayload
  runtimeStreamKey: string
  simulationId: string
}) {
  void runOpeningHandLlmRun({
    attemptNumber,
    config,
    deckId,
    fullPrompt,
    llmRunId,
    requestPayload,
    runtimeStreamKey,
    simulationId,
  })
}

async function runOpeningHandLlmRun({
  attemptNumber,
  config,
  deckId,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
  simulationId,
}: {
  attemptNumber: number
  config: ResolvedOpeningHandLlmRunConfig
  deckId: string
  fullPrompt: string
  llmRunId: string
  requestPayload: OpeningHandLlmRequestPayload
  runtimeStreamKey: string
  simulationId: string
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    attemptNumber,
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    deckId,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    model: config.model,
    nextSequence: 1,
    phase: "opening_hand",
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
    recentChunks: [],
    resolveCompletion: completion.resolveCompletion,
    runtimeStreamKey,
    simulationId,
    status: "streaming",
  }

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)
  publishRuntimeStarted(runtime)

  try {
    throwIfRuntimeAborted(runtime.abortController.signal)

    if (!(await markLlmRunStreaming(llmRunId))) {
      throw createRuntimeAbortError(
        "Opening-hand LLM run was cancelled before it started streaming."
      )
    }

    throwIfRuntimeAborted(runtime.abortController.signal)

    const streamResult =
      config.provider === "openai"
        ? await collectOpenAiLlmStream({
            config,
            llmRunId,
            phase: "opening_hand",
            requestPayload: requireOpenAiRequestPayload(requestPayload),
            runtime,
          })
        : config.provider === "openrouter"
          ? await collectOpenRouterLlmStream({
              config,
              createTools: createOpeningHandOpenRouterTools,
              llmRunId,
              mcpPath: OPENING_HAND_MCP_PATH,
              phase: "opening_hand",
              requestPayload: requireOpenRouterRequestPayload(requestPayload),
              runtime,
            })
          : await collectLlamaCppLlmStream({
              config,
              llmRunId,
              mcpPath: OPENING_HAND_MCP_PATH,
              phase: "opening_hand",
              requestPayload: requireLlamaCppRequestPayload(requestPayload),
              runtime,
              toolDefinitions: openingHandLlmToolDefinitions,
            })

    throwIfRuntimeAborted(runtime.abortController.signal)
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const parsedOpeningHand = parseOpeningHandFromResponseText(
      streamResult.outputText
    )

    throwIfRuntimeAborted(runtime.abortController.signal)

    const completion = await completeOpeningHandLlmRun({
      llmRunId,
      openingHand: parsedOpeningHand.keptHand,
      responseMetadata: streamResult.responseMetadata,
      usage: streamResult.usage,
    })
    runtime.status = "completed"
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })
    await handleSimulationCompletionNextStep(completion)
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logLlmApiCallCancelled({
        llmRunId,
        phase: "opening_hand",
        provider: config.provider,
      })
      appendRuntimeChunk(runtime, createCancellationChunk())
      await tryForceFlushRuntimeChunks(runtime, "cancelled opening-hand run")
      await cancelLlmRun(llmRunId, "Opening-hand LLM run was cancelled.")
      runtime.status = "cancelled"
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
      return
    }

    if (!(error instanceof ProviderTerminalEventError)) {
      appendRuntimeChunk(runtime, createServerErrorChunk(error))
    }

    await tryForceFlushRuntimeChunks(runtime, "failed opening-hand run")
    logLlmApiCallStoppedWithError({
      error,
      llmRunId,
      phase: "opening_hand",
      provider: config.provider,
    })
    console.error("Opening-hand LLM run failed:", error)
    await failLlmRun(llmRunId, getErrorMessage(error))
    runtime.status = "failed"
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })
  } finally {
    clearRuntimeFlushTimer(runtime)
    activeLlmRunRuntimes.delete(runtimeStreamKey)
    runtime.resolveCompletion()
  }
}

function startTurnLlmRun({
  attemptNumber,
  config,
  deckId,
  fullPrompt,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
  simulationId,
  turnNumber,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  deckId: string
  fullPrompt: string
  llmRunId: string
  requestPayload: TurnSimulationLlmRequestPayload
  runtimeStreamKey: string
  simulationId: string
  turnNumber: number
}) {
  void runTurnLlmRun({
    attemptNumber,
    config,
    deckId,
    fullPrompt,
    llmRunId,
    requestPayload,
    runtimeStreamKey,
    simulationId,
    turnNumber,
  })
}

async function runTurnLlmRun({
  attemptNumber,
  config,
  deckId,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
  simulationId,
  turnNumber,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  deckId: string
  fullPrompt: string
  llmRunId: string
  requestPayload: TurnSimulationLlmRequestPayload
  runtimeStreamKey: string
  simulationId: string
  turnNumber: number
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    attemptNumber,
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    deckId,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    model: config.model,
    nextSequence: 1,
    phase: "turn",
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
    recentChunks: [],
    resolveCompletion: completion.resolveCompletion,
    runtimeStreamKey,
    simulationId,
    status: "streaming",
    turnNumber,
  }

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)
  publishRuntimeStarted(runtime)

  try {
    throwIfRuntimeAborted(runtime.abortController.signal)

    if (!(await markLlmRunStreaming(llmRunId))) {
      throw createRuntimeAbortError(
        "Turn LLM run was cancelled before it started streaming."
      )
    }

    throwIfRuntimeAborted(runtime.abortController.signal)

    const streamResult =
      config.provider === "openai"
        ? await collectOpenAiLlmStream({
            config,
            llmRunId,
            phase: "turn",
            requestPayload: requireOpenAiRequestPayload(requestPayload),
            runtime,
          })
        : config.provider === "openrouter"
          ? await collectOpenRouterLlmStream({
              config,
              createTools: createTurnSimulationOpenRouterTools,
              llmRunId,
              mcpPath: TURN_SIMULATION_MCP_PATH,
              phase: "turn",
              requestPayload: requireOpenRouterRequestPayload(requestPayload),
              runtime,
            })
          : await collectLlamaCppLlmStream({
              config,
              llmRunId,
              mcpPath: TURN_SIMULATION_MCP_PATH,
              phase: "turn",
              requestPayload: requireLlamaCppRequestPayload(requestPayload),
              runtime,
              toolDefinitions: turnSimulationLlmToolDefinitions,
            })

    throwIfRuntimeAborted(runtime.abortController.signal)
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const parsedTurn = parseTurnSimulationFromResponseText(
      streamResult.outputText
    )

    throwIfRuntimeAborted(runtime.abortController.signal)

    const completion = await completeTurnLlmRun({
      llmRunId,
      gameState: parsedTurn.gameState,
      responseMetadata: streamResult.responseMetadata,
      usage: streamResult.usage,
    })
    runtime.status = "completed"
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })
    await handleSimulationCompletionNextStep(completion)
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logLlmApiCallCancelled({
        llmRunId,
        phase: "turn",
        provider: config.provider,
      })
      appendRuntimeChunk(
        runtime,
        createCancellationChunk("Turn LLM run was cancelled.")
      )
      await tryForceFlushRuntimeChunks(runtime, "cancelled turn run")
      await cancelLlmRun(llmRunId, "Turn LLM run was cancelled.")
      runtime.status = "cancelled"
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
      return
    }

    if (!(error instanceof ProviderTerminalEventError)) {
      appendRuntimeChunk(runtime, createServerErrorChunk(error))
    }

    await tryForceFlushRuntimeChunks(runtime, "failed turn run")
    logLlmApiCallStoppedWithError({
      error,
      llmRunId,
      phase: "turn",
      provider: config.provider,
    })
    console.error("Turn LLM run failed:", error)
    await failLlmRun(llmRunId, getErrorMessage(error))
    runtime.status = "failed"
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })
  } finally {
    clearRuntimeFlushTimer(runtime)
    activeLlmRunRuntimes.delete(runtimeStreamKey)
    runtime.resolveCompletion()
  }
}

async function stopActiveSimulationLlmRuns(
  deckId: string,
  simulationId: string
) {
  const activeRuns = await requestCancelSimulationLlmRuns(deckId, simulationId)
  const stoppedRunIds: string[] = []
  const cancelRequestedRunIds: string[] = []
  const runtimeCompletionPromises: Promise<void>[] = []

  for (const run of activeRuns) {
    const runtime = activeLlmRunRuntimes.get(run.runtimeStreamKey)

    if (runtime) {
      runtime.abortController.abort()
      runtimeCompletionPromises.push(runtime.completionPromise)
      stoppedRunIds.push(run.llmRunId)
    } else {
      const cancellationMessage = `${formatLlmRunPhase(run.phase)} LLM run was cancelled before its active runtime could be found.`

      await appendLlmRunChunkAtNextSequence(
        run.llmRunId,
        createCancellationChunk(cancellationMessage)
      )
      await cancelLlmRun(run.llmRunId, cancellationMessage)
      cancelRequestedRunIds.push(run.llmRunId)
    }
  }

  await waitForSimulationStopCompletions(runtimeCompletionPromises)

  const remainingActiveRuns = await listActiveSimulationLlmRuns(
    deckId,
    simulationId
  )

  if (remainingActiveRuns.length > 0) {
    throw new SimulationStopTimeoutError()
  }

  await markSimulationCancelled(simulationId, "Simulation was stopped.")
  await publishSimulationResultsState({
    deckId,
    simulationId,
  })

  return {
    simulationId,
    stoppedLlmRunIds: stoppedRunIds,
    cancelRequestedLlmRunIds: cancelRequestedRunIds,
  }
}

function appendRuntimeChunk(
  runtime: ActiveLlmRunRuntime,
  chunk: Omit<LlmRunChunkInput, "sequence">
) {
  const sequencedChunk = {
    ...chunk,
    sequence: runtime.nextSequence,
  }

  runtime.chunkBuffer.push(sequencedChunk)
  runtime.nextSequence += 1
  publishRuntimeChunk(runtime, sequencedChunk)
  scheduleRuntimeFlush(runtime)
}

function scheduleRuntimeFlush(runtime: ActiveLlmRunRuntime) {
  if (runtime.flushTimer || runtime.flushPromise) {
    return
  }

  runtime.flushTimer = setTimeout(() => {
    runtime.flushTimer = null
    void flushRuntimeChunks(runtime).catch((error: unknown) => {
      console.error("Failed to flush LLM run chunks:", error)
    })
  }, STREAM_FLUSH_INTERVAL_MS)
}

async function flushRuntimeChunks(runtime: ActiveLlmRunRuntime) {
  if (runtime.flushPromise) {
    await runtime.flushPromise
    return
  }

  const chunks = runtime.chunkBuffer.slice()

  if (chunks.length === 0) {
    return
  }

  runtime.flushPromise = appendLlmRunChunks(runtime.llmRunId, chunks)
    .then(() => {
      runtime.chunkBuffer.splice(0, chunks.length)
    })
    .finally(() => {
      runtime.flushPromise = null

      if (runtime.chunkBuffer.length > 0) {
        scheduleRuntimeFlush(runtime)
      }
    })
  await runtime.flushPromise
}

async function forceFlushRuntimeChunks(runtime: ActiveLlmRunRuntime) {
  clearRuntimeFlushTimer(runtime)

  while (runtime.flushPromise || runtime.chunkBuffer.length > 0) {
    await flushRuntimeChunks(runtime)
  }
}

async function tryForceFlushRuntimeChunks(
  runtime: ActiveLlmRunRuntime,
  context: string
) {
  try {
    await forceFlushRuntimeChunks(runtime)
    return true
  } catch (error) {
    console.error(`Failed to flush chunks for ${context}:`, error)
    return false
  }
}

function clearRuntimeFlushTimer(runtime: ActiveLlmRunRuntime) {
  if (!runtime.flushTimer) {
    return
  }

  clearTimeout(runtime.flushTimer)
  runtime.flushTimer = null
}

async function main() {
  registerShutdownHandlers()
  await verifyDatabaseConnection()
  await ensureFreshScryfallOracleCards()
  await ensureDecksSchema()
  await ensureStartingHandsSchema()
  await ensureSavedSeedsSchema()
  await ensureSimulationsSchema()
  const staleLlmRunCleanup = await cancelStaleInFlightLlmRuns()

  if (staleLlmRunCleanup.cancelledLlmRunIds.length > 0) {
    console.error(
      `Cancelled ${staleLlmRunCleanup.cancelledLlmRunIds.length} stale in-flight LLM run(s) from a previous server process.`
    )
  }

  if (staleLlmRunCleanup.cancelledSimulationIds.length > 0) {
    console.error(
      `Cancelled ${staleLlmRunCleanup.cancelledSimulationIds.length} stale running simulation(s) from a previous server process.`
    )
  }

  const host = DEFAULT_HOST
  const port = DEFAULT_PORT
  const allowedOrigins = DEFAULT_ALLOWED_ORIGINS
  const app = createMcpExpressApp({ host })

  app.use((req: Request, res: Response, next) => {
    applyCors(req, res, allowedOrigins)

    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }

    next()
  })

  app.use((req: Request, res: Response, next) => {
    if (isMcpPath(req.path)) {
      next()
      return
    }

    express.json()(req, res, (error: unknown) => {
      if (error) {
        res.status(400).json({
          error: "Request body must be valid JSON.",
        })
        return
      }

      next()
    })
  })

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: SERVER_NAME,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    })
  })

  app.get("/decks", async (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        decks: await listDecks(),
      })
    } catch (error) {
      console.error("Failed to list decks:", error)
      res.status(500).json({
        error: "Failed to list decks.",
      })
    }
  })

  app.get("/decks/:deckId", async (req: Request, res: Response) => {
    const deckId = String(req.params.deckId)

    try {
      const deck = await getDeck(deckId)

      if (!deck) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      res.status(200).json({
        deck,
      })
    } catch (error) {
      console.error("Failed to load deck:", error)
      res.status(500).json({
        error: "Failed to load deck.",
      })
    }
  })

  app.get("/decks/:deckId/simulations", async (req: Request, res: Response) => {
    const deckId = String(req.params.deckId)

    try {
      const deck = await getDeck(deckId)

      if (!deck) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      res.status(200).json({
        simulations: await listSimulationsForDeck(deckId),
      })
    } catch (error) {
      console.error("Failed to list simulations:", error)
      res.status(500).json({
        error: "Failed to list simulations.",
      })
    }
  })

  app.post(
    "/decks/:deckId/simulations",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const parsedSimulation = createSimulationSchema.safeParse(req.body)
      let createdSimulationId: string | null = null

      if (!parsedSimulation.success) {
        res.status(400).json({
          error: "Simulation payload is not in the expected format.",
        })
        return
      }

      try {
        const simulation = await createSimulation(deckId, {
          ...parsedSimulation.data,
          createdVia: "app",
        })
        createdSimulationId = simulation.id

        await startCreatedSimulationInitialStep(deckId, simulation)

        const updatedSimulation =
          (await getSimulationSummary(deckId, simulation.id)) ?? simulation

        res.status(201).json({
          simulation: updatedSimulation,
        })
      } catch (error) {
        if (createdSimulationId !== null) {
          await markSimulationFailed(
            createdSimulationId,
            getErrorMessage(error)
          ).catch((failError: unknown) => {
            console.error("Failed to mark simulation failed:", failError)
          })
        }

        if (error instanceof SimulationValidationError) {
          const status = error.message === "Deck not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        if (error instanceof LlmConfigurationError) {
          res.status(500).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to create simulation:", error)
        res.status(500).json({
          error: "Failed to create simulation.",
        })
      }
    }
  )

  app.post(
    "/decks/:deckId/simulations/:simulationId/opening-hand-llm-runs",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        const openingHandRun = await prepareAndStartOpeningHandLlmRun({
          deckId,
          simulationId,
          resetBeforeStart: true,
        })

        res.status(202).json(openingHandRun)
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        if (error instanceof LlmConfigurationError) {
          res.status(500).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to start opening-hand LLM run:", error)
        res.status(500).json({
          error: "Failed to start opening-hand LLM run.",
        })
      }
    }
  )

  app.post(
    "/decks/:deckId/simulations/:simulationId/turn-llm-runs",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const parsedTurnRun = createTurnLlmRunSchema.safeParse(req.body)

      if (!parsedTurnRun.success) {
        res.status(400).json({
          error: "Turn LLM run payload is not in the expected format.",
        })
        return
      }

      try {
        const turnNumber = parsedTurnRun.data.turnNumber
        const turnRun = await prepareAndStartTurnLlmRun({
          deckId,
          simulationId,
          turnNumber,
        })

        res.status(202).json({
          simulationId: turnRun.simulationId,
          llmRunId: turnRun.llmRunId,
          turnNumber: turnRun.turnNumber,
          attemptNumber: turnRun.attemptNumber,
          runtimeStreamKey: turnRun.runtimeStreamKey,
          status: turnRun.status,
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        if (error instanceof LlmConfigurationError) {
          res.status(500).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to start turn LLM run:", error)
        res.status(500).json({
          error: "Failed to start turn LLM run.",
        })
      }
    }
  )

  app.post(
    "/decks/:deckId/simulations/:simulationId/stop",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        res
          .status(200)
          .json(await stopActiveSimulationLlmRuns(deckId, simulationId))
      } catch (error) {
        if (error instanceof SimulationStopTimeoutError) {
          res.status(504).json({
            error: error.message,
          })
          return
        }

        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to stop simulation:", error)
        res.status(500).json({
          error: "Failed to stop simulation.",
        })
      }
    }
  )

  app.get(
    "/decks/:deckId/simulations/:simulationId/debug",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        res.status(200).json({
          debug: await getSimulationDebugInfo(deckId, simulationId),
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to load simulation debug info:", error)
        res.status(500).json({
          error: "Failed to load simulation debug info.",
        })
      }
    }
  )

  app.get(
    "/decks/:deckId/simulations/:simulationId/results",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        res.status(200).json({
          results: await getSimulationResultsInfo(deckId, simulationId),
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to load simulation results:", error)
        res.status(500).json({
          error: "Failed to load simulation results.",
        })
      }
    }
  )

  app.get(
    "/decks/:deckId/simulations/:simulationId/results/stream",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      let streamCleanup: (() => void) | null = null

      try {
        const initialSimulation = await getSimulationSummary(
          deckId,
          simulationId
        )

        if (!initialSimulation) {
          res.status(404).json({
            error: "Simulation not found.",
          })
          return
        }

        res.status(200)
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache, no-transform")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders()
        res.write(formatSseComment("connected"))

        const queuedWrites: string[] = []
        let hasSentSnapshot = false
        let shouldEndAfterSnapshot = false
        let isStreamOpen = true
        let unsubscribe = () => {}
        const keepaliveIntervalId = setInterval(() => {
          if (isStreamOpen) {
            res.write(formatSseComment("keepalive"))
          }
        }, SSE_KEEPALIVE_INTERVAL_MS)
        const cleanup = () => {
          if (!isStreamOpen) {
            return
          }

          isStreamOpen = false
          clearInterval(keepaliveIntervalId)
          unsubscribe()
        }
        streamCleanup = cleanup
        const streamWriter = {
          write(chunk: string) {
            if (!isStreamOpen) {
              return
            }

            if (hasSentSnapshot) {
              res.write(chunk)
              return
            }

            queuedWrites.push(chunk)
          },
          end() {
            if (!isStreamOpen) {
              return
            }

            if (hasSentSnapshot) {
              cleanup()
              res.end()
              return
            }

            shouldEndAfterSnapshot = true
          },
        }

        req.on("close", cleanup)

        if (!isTerminalSimulationStatus(initialSimulation.status)) {
          unsubscribe = simulationResultsBroadcaster.subscribe(
            simulationId,
            streamWriter
          )
        }

        const snapshot = await getSimulationResultsStreamSnapshot(
          deckId,
          simulationId
        )
        const snapshotEvent: SimulationResultsStreamEvent = {
          type: "snapshot",
          simulation: snapshot.simulation,
          results: snapshot.results,
        }

        res.write(formatSseEvent(snapshotEvent))
        hasSentSnapshot = true

        for (const queuedWrite of queuedWrites) {
          res.write(queuedWrite)
        }

        queuedWrites.length = 0

        if (shouldEndAfterSnapshot) {
          cleanup()
          res.end()
          return
        }

        if (isTerminalSimulationStatus(snapshot.simulation.status)) {
          const doneEvent: SimulationResultsStreamEvent = {
            type: "done",
            simulation: snapshot.simulation,
            results: snapshot.results,
          }

          res.write(formatSseEvent(doneEvent))
          cleanup()
          res.end()
        }
      } catch (error) {
        if (res.headersSent) {
          streamCleanup?.()
          const errorEvent: SimulationResultsStreamEvent = {
            type: "error",
            message: "Simulation results stream could not be opened.",
          }

          res.write(formatSseEvent(errorEvent))
          res.end()
          return
        }

        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to open simulation results stream:", error)
        res.status(500).json({
          error: "Failed to open simulation results stream.",
        })
      }
    }
  )

  app.delete(
    "/decks/:deckId/simulations/:simulationId",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        await stopActiveSimulationLlmRuns(deckId, simulationId)

        const wasDeleted = await deleteSimulation(deckId, simulationId)

        if (!wasDeleted) {
          res.status(404).json({
            error: "Simulation not found.",
          })
          return
        }

        res.status(204).send()
      } catch (error) {
        if (error instanceof SimulationStopTimeoutError) {
          res.status(504).json({
            error: error.message,
          })
          return
        }

        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to delete simulation:", error)
        res.status(500).json({
          error: "Failed to delete simulation.",
        })
      }
    }
  )

  app.get(
    "/decks/:deckId/starting-hands",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)

      try {
        const deck = await getDeck(deckId)

        if (!deck) {
          res.status(404).json({
            error: "Deck not found.",
          })
          return
        }

        res.status(200).json({
          startingHands: await listStartingHandsForDeck(deckId),
        })
      } catch (error) {
        console.error("Failed to list starting hands:", error)
        res.status(500).json({
          error: "Failed to list starting hands.",
        })
      }
    }
  )

  app.post(
    "/decks/:deckId/starting-hands",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const parsedStartingHand = createStartingHandSchema.safeParse(req.body)

      if (!parsedStartingHand.success) {
        res.status(400).json({
          error: "Starting hand payload is not in the expected format.",
        })
        return
      }

      try {
        const startingHand = await createStartingHand(
          deckId,
          parsedStartingHand.data
        )

        res.status(201).json({
          startingHand,
        })
      } catch (error) {
        if (error instanceof StartingHandValidationError) {
          const status = error.message === "Deck not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to create starting hand:", error)
        res.status(500).json({
          error: "Failed to create starting hand.",
        })
      }
    }
  )

  app.get("/decks/:deckId/saved-seeds", async (req: Request, res: Response) => {
    const deckId = String(req.params.deckId)

    try {
      const deck = await getDeck(deckId)

      if (!deck) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      res.status(200).json({
        savedSeeds: await listSavedSeedsForDeck(deckId),
      })
    } catch (error) {
      console.error("Failed to list saved seeds:", error)
      res.status(500).json({
        error: "Failed to list saved seeds.",
      })
    }
  })

  app.post(
    "/decks/:deckId/saved-seeds",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const parsedSavedSeed = createSavedSeedSchema.safeParse(req.body)

      if (!parsedSavedSeed.success) {
        res.status(400).json({
          error: "Saved seed payload is not in the expected format.",
        })
        return
      }

      try {
        const savedSeed = await createSavedSeed(deckId, parsedSavedSeed.data)

        res.status(201).json({
          savedSeed,
        })
      } catch (error) {
        if (error instanceof SavedSeedValidationError) {
          const status = error.message === "Deck not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to create saved seed:", error)
        res.status(500).json({
          error: "Failed to create saved seed.",
        })
      }
    }
  )

  app.patch("/decks/:deckId", async (req: Request, res: Response) => {
    const deckId = String(req.params.deckId)
    const parsedDeck = updateDeckDetailsSchema.safeParse(req.body)

    if (!parsedDeck.success) {
      res.status(400).json({
        error: "Deck details payload is not in the expected format.",
      })
      return
    }

    try {
      const updatedDeck = await updateDeckDetails(deckId, parsedDeck.data)

      if (!updatedDeck) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      res.status(200).json({
        deck: updatedDeck,
      })
    } catch (error) {
      console.error("Failed to update deck details:", error)
      res.status(500).json({
        error: "Failed to update deck details.",
      })
    }
  })

  app.post("/decks", async (req: Request, res: Response) => {
    const parsedDeck = createDeckSchema.safeParse(req.body)

    if (!parsedDeck.success) {
      res.status(400).json({
        error: "Deck payload is not in the expected format.",
      })
      return
    }

    const commanderNames = new Set(
      parsedDeck.data.commanders.map((commander) =>
        commander.toLocaleLowerCase()
      )
    )

    if (commanderNames.size !== parsedDeck.data.commanders.length) {
      res.status(400).json({
        error: "Commander cards must be different.",
      })
      return
    }

    const expectedDeckSize = parsedDeck.data.commanders.length === 2 ? 98 : 99
    const actualDeckSize = parsedDeck.data.cards.reduce(
      (total, card) => total + card.quantity,
      0
    )

    if (actualDeckSize !== expectedDeckSize) {
      res.status(400).json({
        error: `Deck list must contain exactly ${expectedDeckSize} cards. Parsed ${actualDeckSize}.`,
      })
      return
    }

    try {
      const cardResolution = await resolveExactScryfallOracleCards([
        ...parsedDeck.data.commanders,
        ...parsedDeck.data.cards.map((card) => card.name),
      ])

      if (cardResolution.missingNames.length > 0) {
        res.status(400).json({
          error: `Could not find exact matches for: ${cardResolution.missingNames.join(", ")}.`,
          unmatchedCards: cardResolution.missingNames,
        })
        return
      }

      const exactMatchesByName = createExactScryfallOracleCardMatchMap(
        cardResolution.matches
      )
      const commanderOracleIds = parsedDeck.data.commanders.map((commander) =>
        getExactMatchOracleId(exactMatchesByName, commander)
      )

      if (new Set(commanderOracleIds).size !== commanderOracleIds.length) {
        res.status(400).json({
          error: "Commander cards must be different.",
        })
        return
      }

      const createdDeck = await createDeck({
        name: parsedDeck.data.name,
        desc: parsedDeck.data.desc,
        commanders: commanderOracleIds.map((oracleId) => ({
          oracleId,
          quantity: 1,
        })),
        cards: parsedDeck.data.cards.map((card) => ({
          oracleId: getExactMatchOracleId(exactMatchesByName, card.name),
          quantity: card.quantity,
        })),
      })

      res.status(201).json({
        deck: createdDeck,
      })
    } catch (error) {
      console.error("Failed to create deck:", error)
      res.status(500).json({
        error: "Failed to create deck.",
      })
    }
  })

  app.delete("/decks/:deckId", async (req: Request, res: Response) => {
    const deckId = String(req.params.deckId)

    try {
      const wasDeleted = await deleteDeck(deckId)

      if (!wasDeleted) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      res.status(204).send()
    } catch (error) {
      console.error("Failed to delete deck:", error)
      res.status(500).json({
        error: "Failed to delete deck.",
      })
    }
  })

  registerMcpEndpoint(app, OPENING_HAND_MCP_PATH, createOpeningHandServer)
  registerMcpEndpoint(app, TURN_SIMULATION_MCP_PATH, createTurnSimulationServer)
  registerMcpEndpoint(app, SIMULATION_MCP_PATH, createSimulationServer)

  app.listen(port, host, (error?: Error) => {
    if (error) {
      console.error("Failed to start server:", error)
      process.exit(1)
    }

    console.error(`${SERVER_NAME} listening at http://${host}:${port}`)
    console.error(
      `Opening-hand MCP endpoint available at http://${host}:${port}${OPENING_HAND_MCP_PATH}`
    )
    console.error(
      `Turn-simulation MCP endpoint available at http://${host}:${port}${TURN_SIMULATION_MCP_PATH}`
    )
    console.error(
      `Simulation MCP endpoint available at http://${host}:${port}${SIMULATION_MCP_PATH}`
    )
  })
}

function getExactMatchOracleId(
  matchesByName: ReturnType<typeof createExactScryfallOracleCardMatchMap>,
  cardName: string
) {
  const match = matchesByName.get(
    normalizeScryfallCardNameForExactMatch(cardName)
  )

  if (!match) {
    throw new Error(`Missing exact card match for ${JSON.stringify(cardName)}.`)
  }

  return match.oracleId
}

function registerShutdownHandlers() {
  const shutdown = (signal: NodeJS.Signals) => {
    void (async () => {
      console.error(`Received ${signal}. Closing database pool...`)
      await closeDatabasePool()
      process.exit(0)
    })()
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

function applyCors(
  req: Request,
  res: Response,
  allowedOrigins: readonly string[]
) {
  const requestOrigin = req.headers.origin

  if (requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin)
    res.setHeader("Vary", "Origin")
  }

  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true")
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
  res.setHeader(
    "Access-Control-Allow-Headers",
    getAllowedRequestHeaders(req.headers["access-control-request-headers"])
  )
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]) {
  return (
    origin === "null" ||
    allowedOrigins.includes(origin) ||
    isLoopbackOrigin(origin)
  )
}

function isLoopbackOrigin(origin: string) {
  try {
    const parsedOrigin = new URL(origin)

    return (
      parsedOrigin.protocol === "http:" &&
      (parsedOrigin.hostname === "localhost" ||
        parsedOrigin.hostname === "127.0.0.1" ||
        parsedOrigin.hostname === "::1")
    )
  } catch {
    return false
  }
}

function getAllowedRequestHeaders(
  requestedHeaders: string | string[] | undefined
) {
  const headerNames = new Set(
    DEFAULT_ALLOWED_HEADERS.map((header) => header.toLowerCase())
  )
  const requestedHeaderList = Array.isArray(requestedHeaders)
    ? requestedHeaders.join(",")
    : requestedHeaders

  if (requestedHeaderList) {
    for (const header of requestedHeaderList.split(",")) {
      const normalizedHeader = header.trim().toLowerCase()

      if (normalizedHeader) {
        headerNames.add(normalizedHeader)
      }
    }
  }

  return Array.from(headerNames).join(", ")
}

function registerMcpEndpoint(
  app: ReturnType<typeof createMcpExpressApp>,
  path: string,
  createScopedServer: () => McpServer
) {
  app.post(path, async (req: Request, res: Response) => {
    await handleMcpRequest(req, res, createScopedServer)
  })

  app.get(path, (_req: Request, res: Response) => {
    respondWithMethodNotAllowed(res)
  })

  app.delete(path, (_req: Request, res: Response) => {
    respondWithMethodNotAllowed(res)
  })
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  createScopedServer: () => McpServer
) {
  const server = createScopedServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  let didCleanup = false

  const cleanup = () => {
    if (didCleanup) {
      return
    }

    didCleanup = true
    void transport.close()
    void server.close()
  }

  res.on("close", cleanup)

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    cleanup()
    console.error("Error handling MCP request:", error)

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      })
    }
  }
}

function respondWithMethodNotAllowed(res: Response) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  })
}

function isMcpPath(path: string) {
  return (
    path === OPENING_HAND_MCP_PATH ||
    path === TURN_SIMULATION_MCP_PATH ||
    path === SIMULATION_MCP_PATH
  )
}

async function resolveSimulationPromptIdentifier(identifier: LlmRunIdentifier) {
  const llmRunId = identifier.llmRunId.trim()

  if (!llmRunId) {
    throw new SimulationValidationError(
      "Prompt construction requires an LLM run ID."
    )
  }

  return {
    llmRunId,
    simulationId: await resolveSimulationIdentifier({ llmRunId }),
  }
}

export async function buildStartingHandSimulationPrompt(
  identifier: LlmRunIdentifier
) {
  const { llmRunId, simulationId } =
    await resolveSimulationPromptIdentifier(identifier)
  const promptData = await getStartingHandSimulationPromptData(simulationId)

  if (!promptData) {
    throw new Error("Simulation not found.")
  }

  return buildStartingHandSimulationPromptFromData(promptData, llmRunId)
}

function buildStartingHandSimulationPromptFromData(
  { commanders, library }: StartingHandSimulationPromptData,
  llmRunId: string
) {
  const commanderLabel = commanders.length === 1 ? "Commander" : "Commanders"
  const commanderNames = expandCardNames(commanders)
  const cardNames = expandCardNames(library)
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...library])

  return `${DRAW_STARTING_HAND_PROMPT}

${commanderLabel}:
${commanderNames.join("\n")}

Decklist:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${formatCardText(card)}\n`).join("\n")}

LLM Run ID: ${llmRunId}
`.trim()
}

function expandCardNames(cards: readonly SimulationPromptCard[]) {
  return cards.flatMap((card) =>
    Array.from({ length: card.quantity }, () => card.name)
  )
}

function dedupeCardsByNameAndText(cards: readonly SimulationPromptCard[]) {
  const cardsByNameAndText = new Map<string, SimulationPromptCard>()

  for (const card of cards) {
    const key = `${card.name}\n${formatCardText(card)}`

    if (!cardsByNameAndText.has(key)) {
      cardsByNameAndText.set(key, card)
    }
  }

  return Array.from(cardsByNameAndText.values())
}

function formatCardText(card: SimulationPromptCard) {
  const lines = [
    formatCardLine("Mana Cost", card.manaCost),
    formatCardLine("Converted Mana Cost", card.convertedManaCost),
    formatCardLine("Type", card.typeLine),
    formatCardLine("Rules Text", card.oracleText),
    formatPowerToughness(card),
    formatCardLine("Loyalty", card.loyalty),
  ].filter((line) => line !== null)

  if (card.cardFaces.length > 0) {
    lines.push(
      "Faces:",
      ...card.cardFaces.flatMap((face) =>
        [
          face.name,
          formatCardLine("Mana Cost", face.manaCost),
          formatCardLine("Type", face.typeLine),
          formatCardLine("Rules Text", face.oracleText),
          formatPowerToughness(face),
          formatCardLine("Loyalty", face.loyalty),
        ].filter((line) => line !== null)
      )
    )
  }

  return lines.join("\n")
}

function formatCardLine(label: string, value: string | null) {
  return value ? `${label}: ${value}` : null
}

function formatPowerToughness({
  power,
  toughness,
}: {
  power: string | null
  toughness: string | null
}) {
  return power !== null && toughness !== null
    ? `Power/Toughness: ${power}/${toughness}`
    : null
}

export async function buildTurnSimulationPrompt(
  identifier: LlmRunIdentifier,
  gameState?: string
) {
  const { llmRunId, simulationId } =
    await resolveSimulationPromptIdentifier(identifier)
  const promptData = await getTurnSimulationPromptData(simulationId)

  if (!promptData) {
    throw new Error("Simulation not found.")
  }

  return buildTurnSimulationPromptFromData(promptData, llmRunId, gameState)
}

function buildTurnSimulationPromptFromData(
  { commanders, library, libraryCards, startingHand }: TurnSimulationPromptData,
  llmRunId: string,
  gameState?: string
) {
  const commanderNames = expandCardNames(commanders)
  const cardNames = [...library].sort((left, right) =>
    left.localeCompare(right)
  )
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...libraryCards])
  const resolvedGameState = gameState?.trim()
    ? gameState.trim()
    : buildInitialTurnGameState({
        commanderNames,
        startingHand,
      })

  return `${SIMULATE_TURN_PROMPT}

${GENERIC_GAME_RULES_REFERENCE}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${formatCardText(card)}\n`).join("\n")}

Cards in library. Not actual order of library. Use tools to interact with library:
${cardNames.join("\n")}

===Start Game State===

${resolvedGameState}

===End Game State===

LLM Run ID: ${llmRunId}
`.trim()
}

function buildInitialTurnGameState({
  commanderNames,
  startingHand,
}: {
  commanderNames: readonly string[]
  startingHand: readonly string[]
}) {
  return `
Hand:
${startingHand.join("\n")}

Command Zone:
${commanderNames.join("\n")}

Battlefield:
// empty

Graveyard:
// empty

Exile:
// empty

Your Life: 40
Opponent A Life: 40
Opponent B Life: 40
Opponent C Life: 40
`.trim()
}

main().catch(async (error: unknown) => {
  console.error(error)
  await closeDatabasePool()
  process.exit(1)
})
