import "./environment.js"
import express, { type Express, type Request, type Response } from "express"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { OpenRouter, stepCountIs, tool, type Tool } from "@openrouter/agent"
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import OpenAI from "openai"
import { z } from "zod/v4"
import {
  auth,
  ensureAuthSchema,
  hasValidEmailVerificationOtp,
  isPasswordResetTokenValid,
} from "./auth.js"
import {
  deleteAdminUser,
  listActiveAdminUserSimulations,
  listAdminUsers,
} from "./admin-users-postgres.js"
import {
  createLlmModelPreset,
  deleteUnusedLlmModelPreset,
  ensureLlmModelPresetsSchema,
  getEnabledLlmModelPreset,
  listAdminLlmModelPresets,
  listEnabledLlmModelPresets,
  setDefaultLlmModelPreset,
  setLlmModelPresetEnabled,
  LlmModelPresetValidationError,
  type LlmModelPreset,
} from "./llm-model-presets-postgres.js"
import {
  closeDatabasePool,
  queryDatabase,
  verifyDatabaseConnection,
} from "./db.js"
import {
  DRAW_STARTING_HAND_PROMPT,
  GENERIC_GAME_RULES_REFERENCE,
  SIMULATE_TURN_PROMPT,
} from "./llm/prompt-constants.js"
import { formatUserGuidelinesSection } from "./llm/user-guidelines.js"
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
  appendLlmRunChunkWithResolvedCardMentions,
  appendLlmRunChunks,
  cancelLlmRun,
  cancelReportLlmRun,
  cancelStaleInFlightLlmRuns,
  claimNextQueuedLlmRun,
  completeOpeningHandLlmRun,
  completeReportLlmRun,
  completeTurnLlmRun,
  createLlmRunMcpToken,
  createOpeningHandLlmRun,
  createReportLlmRun,
  createSimulation,
  createTurnLlmRun,
  deleteSimulation,
  drawCardsFromBottom,
  drawCardsFromTop,
  drawStartingHand,
  ensureSimulationsSchema,
  failLlmRun,
  failReportLlmRun,
  getActiveLlmRunMcpTokenContext,
  getDeckCardReferenceData,
  getOpeningHandLlmRunEvaluationData,
  getOpenRouterGenerationForSimulation,
  getSimulationCreationDecision,
  getSimulationDebugInfo,
  getSimulationLlmRunFullPrompt,
  getSimulationResultsInfo,
  getSimulationReportPromptData,
  getSimulationSummary,
  getStartingHandSimulationPromptData,
  getTurnLlmRunEvaluationData,
  getTurnSimulationPromptData,
  isLlmRunStreaming,
  listActiveSimulationLlmRuns,
  listSimulationsForDeck,
  logTurnAction,
  markLlmRunQueued,
  markSimulationCancelled,
  markSimulationCompleted,
  markSimulationFailed,
  mulliganSimulation,
  requestCancelSimulationLlmRuns,
  recordOpenRouterLlmRunGeneration,
  resetSimulationForOpeningHandLlmRun,
  returnCardToSimulationLibrary,
  returnCardsToSimulationLibrary,
  revokeLlmRunMcpToken,
  resolveSimulationIdentifier,
  shuffleSimulationLibrary,
  SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE,
  SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE,
  SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
  SimulationValidationError,
  takeCardsFromSimulationLibrary,
  TURN_PHASE_CHANGES,
  upsertOpeningHandEvaluation,
  upsertTurnEvaluation,
  updateLlmRunRequestData,
  updateSimulationLlmModelPreset,
} from "./simulations-postgres.js"
import type {
  LlmRunChunkInput,
  LlmRunMcpTokenContext,
  LlmRunMcpTokenPhase,
  LlmRunPhase,
  LlmRunStatus,
  ClaimedQueuedLlmRun,
  OpenRouterGeneration,
  SimulationDebugLlmRunChunk,
  SimulationDebugLlmRun,
  SimulationLlmCompletionResult,
  SimulationPromptCard,
  SimulationResultsInfo,
  SimulationSummary,
  StartingHandSimulationPromptData,
  TurnSimulationPromptData,
  SimulationReportPromptData,
  SimulationReportTurnPromptData,
  OpeningHandEvaluationJson,
  TurnPhaseChange,
  TurnEvaluationJson,
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
  createFinalParsedOutputChunk,
  createServerErrorChunk,
  getCompletedResponseOutputText,
  getErrorMessage,
  getOpenRouterGenerationIdFromCompletedEvent,
  getStringProperty,
  isAbortError,
  isProviderTerminalEvent,
  normalizeOpenAiStreamEvent,
  normalizeOpenRouterStreamEvent,
  parseOpeningHandCompletionFromResponseText,
  parseTurnSimulationCompletionFromResponseText,
  type OpenRouterToolCallNameMap,
} from "./llm-run-events.js"
import {
  collectLlamaCppChatCompletion,
  createLlamaCppChatCompletionTools,
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
  getOpenRouterApiKey,
  getEvaluationLlmRunConfig,
  getLlmRunQueueConfig,
  getOpeningHandLlmRunConfig,
  getTurnSimulationLlmRunConfig,
  llmProviderSchema,
  reasoningEffortSchema,
  type EvaluationLlmRunConfig,
  type OpenAiRunConfig,
  type OpenRouterRunConfig,
  type OpeningHandLlmRunConfig,
  type OpeningHandOpenAiRunConfig,
  type ResolvedLlamaCppRunConfig,
  type ResolvedOpeningHandLlmRunConfig,
  type ResolvedEvaluationLlmRunConfig,
  type ResolvedTurnSimulationLlmRunConfig,
  type TurnSimulationLlmRunConfig,
  type TurnSimulationOpenAiRunConfig,
  type LlmRunQueueConfig,
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
  estimatePresetTokenCostUsd,
  formatUsdCostAsCentLabel,
  getOpenRouterReportedCostUsd,
  type TokenPrice,
} from "./llm-pricing.js"
import {
  buildOpeningHandEvaluationInputText,
  buildOpeningHandEvaluationPrompt,
  buildTurnEvaluationInputText,
  buildTurnEvaluationPrompt,
  evaluationLlmRunRequestSchema,
  getOpeningHandEvaluationIneligibilityMessage,
  getTurnEvaluationIneligibilityMessage,
  parseOpeningHandEvaluationResponseText,
  parseTurnEvaluationResponseText,
} from "./turn-evaluations.js"
import {
  createExactScryfallOracleCardMatchMap,
  normalizeScryfallCardNameForExactMatch,
  resolveExactScryfallOracleCards,
} from "./scryfall-postgres.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3001
const SERVER_NAME = "mtg-auto-deck-server"
const OPENING_HAND_SERVER_NAME = "opening-hand-server"
const TURN_SIMULATION_SERVER_NAME = "turn-simulation-server"
const SIMULATION_SERVER_NAME = "simulation-server"
const OPENING_HAND_MCP_PATH = "/mcp/opening-hand"
const TURN_SIMULATION_MCP_PATH = "/mcp/turn-simulation"
const SIMULATION_MCP_PATH = "/mcp/simulation"
const AUTH_PATH_PREFIX = "/api/auth"
const APP_SIGN_UP_PATH = "/api/app-auth/sign-up"
const APP_EMAIL_VERIFICATION_CODE_PATH = "/api/app-auth/email-verification-code"
const APP_PASSWORD_RESET_TOKEN_PATH =
  "/api/app-auth/password-reset-token/:token"
const OPENING_HAND_MCP_SERVER_LABEL = "opening_hand"
const TURN_SIMULATION_MCP_SERVER_LABEL = "turn_simulation"
const STREAM_FLUSH_INTERVAL_MS = 1000
const STREAM_RECENT_CHUNK_LIMIT = 500
const SSE_KEEPALIVE_INTERVAL_MS = 15000
const LLM_RUN_QUEUE_POLL_INTERVAL_MS = 1000
const MCP_RUN_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const OPENROUTER_GENERATION_ENDPOINT = "https://openrouter.ai/api/v1/generation"
const OPENROUTER_PROVIDERS_ENDPOINT = "https://openrouter.ai/api/v1/providers"
const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions"
const QUEUED_MCP_RUN_TOKEN_PLACEHOLDER = "queued"
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
const DECK_GUIDELINES_MAX_LENGTH = 1000

const llmRunIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The LLM Run ID from the prompt.")
const llmRunIdentifierSchema = {
  llmRunId: llmRunIdSchema,
}
const deckIdSchema = z.string().trim().min(1).describe("The deck ID.")
const deckIdentifierSchema = {
  deckId: deckIdSchema,
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
  mulliganGuidelines: createDeckGuidelinesSchema(),
  strategyGuidelines: createDeckGuidelinesSchema(),
  commanders: z.array(z.string().trim().min(1)).min(1).max(2),
  cards: z.array(
    z.object({
      name: z.string().trim().min(1),
      quantity: z.number().int().positive(),
    })
  ),
})
const appSignUpSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
})
const passwordResetTokenSchema = z.string().trim().min(1).max(256)
const updateDeckDetailsSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  mulliganGuidelines: createDeckGuidelinesSchema(),
  strategyGuidelines: createDeckGuidelinesSchema(),
})

function createDeckGuidelinesSchema() {
  return z.string().max(DECK_GUIDELINES_MAX_LENGTH).default("")
}

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
  llmModelPresetId: z.uuid(),
  turnsToSimulate: z.number().int().nonnegative(),
  autoGenerateReport: z.boolean().default(false),
  startingHandId: z.uuid().nullable(),
})
const updateSimulationModelPresetSchema = z.object({
  llmModelPresetId: z.uuid(),
})
const optionalTokenCostSchema = z
  .number()
  .finite()
  .nonnegative()
  .nullable()
  .default(null)
const createLlmModelPresetSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().trim().min(1),
  reasoningEffort: reasoningEffortSchema,
  openrouterModelProvider: z.string().trim().nullable().default(null),
  inputTokenCostUsdPerMillion: optionalTokenCostSchema,
  cachedInputTokenCostUsdPerMillion: optionalTokenCostSchema,
  outputTokenCostUsdPerMillion: optionalTokenCostSchema,
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})
const updateLlmModelPresetEnabledSchema = z.object({
  isEnabled: z.boolean(),
})
const setDefaultLlmModelPresetSchema = z.object({
  presetId: z.uuid().nullable(),
})
const createTurnLlmRunSchema = z.object({
  turnNumber: z.number().int().positive(),
})
const turnPhaseChangeSchema = z
  .enum(TURN_PHASE_CHANGES)
  .nullable()
  .describe(
    "Optional phase metadata. Include this only when the action logs moving into a new turn phase or step."
  )

type ActiveLlmRunRuntime = {
  abortController: AbortController
  attemptNumber: number
  chunkBuffer: LlmRunChunkInput[]
  completionPromise: Promise<void>
  createdAt: string
  deckId: string
  flushTimer: NodeJS.Timeout | null
  flushPromise: Promise<void> | null
  llmRunId: string
  llmModelPresetId: string
  model: string
  fullPrompt: string
  nextSequence: number
  openrouterGenerations: OpenRouterGeneration[]
  phase: LlmRunPhase
  provider: string
  reasoningEffort: string | null
  recentChunks: SimulationResultsStreamChunk[]
  resolveCompletion: () => void
  runtimeStreamKey: string
  simulationId: string
  startedAt: string | null
  status: LlmRunStatus
  turnNumber?: number
}

type AuthenticatedUser = {
  email: string
  emailVerified: boolean
  id: string
  role?: string | null
}

type GeneratedMcpRunToken = {
  expiresAt: Date
  token: string
  tokenHash: string
}

const activeLlmRunRuntimes = new Map<string, ActiveLlmRunRuntime>()
const simulationResultsBroadcaster = new SimulationResultsBroadcaster()
const authenticatedUsersByRequest = new WeakMap<Request, AuthenticatedUser>()
let llmRunQueueConfig: LlmRunQueueConfig | null = null
let llmRunQueueDrainTimer: NodeJS.Timeout | null = null
let llmRunQueueDrainPromise: Promise<void> | null = null

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
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "unmanaged"
  )
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
    mcpFunctionReason: chunk.mcpFunctionReason,
    reasoningDelta: chunk.reasoningDelta,
    outputDelta: chunk.outputDelta,
    payload: chunk.payload,
    cardMentions: [],
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

function rememberRuntimeOpenRouterGeneration(
  runtime: ActiveLlmRunRuntime,
  generation: OpenRouterGeneration
) {
  const existingGenerationIndex = runtime.openrouterGenerations.findIndex(
    (existingGeneration) =>
      existingGeneration.openrouterTurnIndex === generation.openrouterTurnIndex
  )

  if (existingGenerationIndex === -1) {
    runtime.openrouterGenerations.push(generation)
  } else {
    runtime.openrouterGenerations[existingGenerationIndex] = generation
  }

  runtime.openrouterGenerations.sort(
    (firstGeneration, secondGeneration) =>
      firstGeneration.openrouterTurnIndex - secondGeneration.openrouterTurnIndex
  )
}

function createStreamRunFromRuntime(
  runtime: ActiveLlmRunRuntime,
  chunks = runtime.recentChunks
): SimulationResultsStreamRun {
  return {
    llmRunId: runtime.llmRunId,
    llmModelPresetId: runtime.llmModelPresetId,
    phase: runtime.phase,
    provider: runtime.provider,
    model: runtime.model,
    estimatedPriceCents: null,
    reasoningEffort: runtime.reasoningEffort,
    status: runtime.status,
    runtimeStreamKey: runtime.runtimeStreamKey,
    attemptNumber: runtime.attemptNumber,
    createdAt: runtime.createdAt,
    startedAt: runtime.startedAt,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    turnNumber: runtime.turnNumber,
    openrouterGenerations: runtime.openrouterGenerations,
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
    reportLlmRuns: results.reportLlmRuns.map(createStreamRunFromPersistedRun),
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

  if (incomingRun.phase === "report") {
    const reportLlmRuns = upsertStreamRunInList(
      results.reportLlmRuns,
      incomingRun
    ).sort(compareReportStreamRuns)

    return {
      ...results,
      reportLlmRunCount: reportLlmRuns.length,
      reportLlmRuns,
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
        openrouterGenerations: mergeOpenRouterGenerations(
          [],
          incomingRun.openrouterGenerations ?? []
        ),
        chunks: [...incomingRun.chunks].sort(compareStreamChunks),
      },
    ]
  }

  const mergedRun = {
    ...incomingRun,
    ...existingRun,
    status: incomingRun.status,
    openrouterGenerations: mergeOpenRouterGenerations(
      existingRun.openrouterGenerations ?? [],
      incomingRun.openrouterGenerations ?? []
    ),
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

function mergeOpenRouterGenerations(
  existingGenerations: readonly OpenRouterGeneration[] = [],
  incomingGenerations: readonly OpenRouterGeneration[] = []
) {
  const generationsByTurn = new Map<number, OpenRouterGeneration>()

  for (const generation of existingGenerations) {
    generationsByTurn.set(generation.openrouterTurnIndex, generation)
  }

  for (const generation of incomingGenerations) {
    generationsByTurn.set(generation.openrouterTurnIndex, generation)
  }

  return Array.from(generationsByTurn.values()).sort(
    (firstGeneration, secondGeneration) =>
      firstGeneration.openrouterTurnIndex - secondGeneration.openrouterTurnIndex
  )
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

function compareReportStreamRuns(
  firstRun: SimulationResultsStreamRun,
  secondRun: SimulationResultsStreamRun
) {
  return firstRun.attemptNumber - secondRun.attemptNumber
}

function findStreamRun(results: SimulationResultsStreamInfo, llmRunId: string) {
  return (
    results.openingHandLlmRuns.find((run) => run.llmRunId === llmRunId) ??
    results.turnLlmRuns.find((run) => run.llmRunId === llmRunId) ??
    results.reportLlmRuns.find((run) => run.llmRunId === llmRunId) ??
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

function publishRuntimeChunk(
  runtime: ActiveLlmRunRuntime,
  chunk: LlmRunChunkInput
) {
  if (!shouldStreamSimulationResultsChunk(chunk)) {
    return
  }

  const streamChunk = createRuntimeStreamChunk(chunk)

  publishRuntimeStreamChunk(runtime, streamChunk)
}

function publishRuntimeStreamChunk(
  runtime: ActiveLlmRunRuntime,
  streamChunk: SimulationResultsStreamChunk
) {
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

    if (
      isTerminalSimulationStatus(snapshot.simulation.status) &&
      snapshot.simulation.activeLlmRunCount === 0
    ) {
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
  tokenCosts,
  usage,
}: {
  llmRunId: string
  model: string
  phase: LlmRunPhase
  provider: string
  tokenCosts: TokenPrice
  usage: unknown
}) {
  const tokenUsage = getLlmTokenUsageSummary(usage)
  const estimatedCostUsd = estimatePresetTokenCostUsd({
    tokenCosts,
    usage,
  })
  const openrouterReportedCostUsd =
    provider === "openrouter" ? getOpenRouterReportedCostUsd(usage) : null

  console.log(
    `${formatProviderName(provider)} API call finished: phase=${phase} llmRunId=${llmRunId} model=${model} totalTokens=${tokenUsage.total} inputTokens=${tokenUsage.input} cachedInputTokens=${tokenUsage.cachedInput} reasoningTokens=${tokenUsage.reasoning} outputTokens=${tokenUsage.output} estimatedCost=${formatLlmApiCallCost(estimatedCostUsd)} openrouterCost=${formatLlmApiCallCost(openrouterReportedCostUsd)}`
  )
}

function formatLlmApiCallCost(costUsd: number | null) {
  return formatUsdCostAsCentLabel(costUsd) ?? "null"
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

type McpDeckIdentifierInput = {
  deckId: string
}
type McpTestEchoInput = {
  message: string
}
type McpSimulationIdentifierInput = {
  llmRunId?: string
  simulationId?: string
  reason?: string
}
type McpDrawCardsInput = McpSimulationIdentifierInput & {
  count: number
}
type McpFlipCoinInput = McpSimulationIdentifierInput & {
  count?: number
}
type McpRollDiceInput = McpSimulationIdentifierInput & {
  count: number
  sides: number
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
  phaseChange?: TurnPhaseChange | null
}

type McpSimulationIdentifierConfig = {
  authContext?: LlmRunMcpTokenContext
  inputSchema: typeof llmRunIdentifierSchema | typeof simulationIdentifierSchema
  requireReason: boolean
}

const llmRunMcpIdentifier: McpSimulationIdentifierConfig = {
  inputSchema: llmRunIdentifierSchema,
  requireReason: true,
}
const simulationMcpIdentifier: McpSimulationIdentifierConfig = {
  inputSchema: simulationIdentifierSchema,
  requireReason: false,
}

async function resolveMcpSimulationId(
  input: McpSimulationIdentifierInput,
  authContext?: LlmRunMcpTokenContext
) {
  if (authContext) {
    const llmRunId = input.llmRunId?.trim()
    const simulationId = input.simulationId?.trim()

    if (llmRunId && llmRunId !== authContext.llmRunId) {
      throw new Error("MCP run token does not match the requested LLM run.")
    }

    if (simulationId && simulationId !== authContext.simulationId) {
      throw new Error("MCP run token does not match the requested simulation.")
    }

    return authContext.simulationId
  }

  return resolveSimulationIdentifier(input)
}

const mcpShortReasonSchema = z
  .string()
  .trim()
  .min(1)
  .describe("A short explanation of why this tool call is being made.")
const randomizerCountSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe("How many results to generate. Must be between 1 and 100.")
const diceSidesSchema = z
  .number()
  .int()
  .min(2)
  .max(1000)
  .describe("How many sides each die has. Must be between 2 and 1000.")

function addMcpReasonToToolResult<T extends object>(
  identifier: McpSimulationIdentifierConfig,
  input: McpSimulationIdentifierInput,
  response: T
) {
  return identifier.requireReason && typeof input.reason === "string"
    ? {
      ...response,
      reason: input.reason.trim(),
    }
    : response
}

type CoinFlipResult = "win" | "lose"

function flipCoins(count: number) {
  const results: CoinFlipResult[] = []

  for (let index = 0; index < count; index += 1) {
    results.push(randomInt(2) === 0 ? "win" : "lose")
  }

  const wins = results.filter((result) => result === "win").length

  return {
    results,
    wins,
    losses: results.length - wins,
  }
}

function rollDice(count: number, sides: number) {
  const rolls: number[] = []

  for (let index = 0; index < count; index += 1) {
    rolls.push(randomInt(1, sides + 1))
  }

  return {
    rolls,
    total: rolls.reduce((sum, roll) => sum + roll, 0),
    sides,
  }
}

function createOpeningHandServer(authContext?: LlmRunMcpTokenContext) {
  const identifier = {
    ...llmRunMcpIdentifier,
    authContext,
  }

  return createServer(OPENING_HAND_SERVER_NAME, (server) => {
    registerDrawStartingHandTool(server, identifier)
    registerMulliganTool(server, identifier)
    registerReturnCardsToLibraryTool(server, identifier)
  })
}

function createTurnSimulationServer(authContext?: LlmRunMcpTokenContext) {
  const identifier = {
    ...llmRunMcpIdentifier,
    authContext,
  }

  return createServer(TURN_SIMULATION_SERVER_NAME, (server) => {
    registerLogTurnActionTool(server, identifier)
    registerDrawCardFromTopTool(server, identifier)
    registerDrawCardFromBottomTool(server, identifier)
    registerTakeCardsFromLibraryTool(server, identifier)
    registerReturnCardToLibraryTool(server, identifier)
    registerReturnCardsToLibraryTool(server, identifier)
    registerShuffleLibraryTool(server, identifier)
    registerFlipCoinTool(server, identifier)
    registerRollDiceTool(server, identifier)
  })
}

function createSimulationServer() {
  return createServer(SIMULATION_SERVER_NAME, (server) => {
    registerTestEchoTool(server)
    registerListDecksTool(server)
    registerGetDeckCardReferenceTool(server)
    registerCreateSimulationTool(server)
    registerDrawStartingHandTool(server, simulationMcpIdentifier)
    registerMulliganTool(server, simulationMcpIdentifier)
    registerDrawCardFromTopTool(server, simulationMcpIdentifier)
    registerDrawCardFromBottomTool(server, simulationMcpIdentifier)
    registerTakeCardsFromLibraryTool(server, simulationMcpIdentifier)
    registerReturnCardToLibraryTool(server, simulationMcpIdentifier)
    registerReturnCardsToLibraryTool(server, simulationMcpIdentifier)
    registerShuffleLibraryTool(server, simulationMcpIdentifier)
    registerFlipCoinTool(server, simulationMcpIdentifier)
    registerRollDiceTool(server, simulationMcpIdentifier)
  })
}

function registerTestEchoTool(server: McpServer) {
  server.registerTool(
    "test_echo",
    {
      title: "Test Echo",
      description:
        "Echo a message for testing connectivity to the simulation MCP server. This tool does not require a simulation ID.",
      inputSchema: {
        message: z.string().describe("The message to echo."),
      },
    },
    async ({ message }: McpTestEchoInput) => {
      console.log(
        `Simulation MCP test_echo called at ${new Date().toISOString()} messageLength=${message.length} message=${JSON.stringify(message)}`
      )

      return {
        content: createToolResultContent("Echoed test message.", {
          echo: message,
        }),
      }
    }
  )
}

function registerListDecksTool(server: McpServer) {
  server.registerTool(
    "list_decks",
    {
      title: "List Decks",
      description:
        "List all saved decks and their IDs. Use this before create_simulation when you do not know which deck ID to use.",
      inputSchema: {},
    },
    async () => {
      const decks = await listDecks()

      return {
        content: createToolResultContent(
          `Found ${decks.length} saved deck(s).`,
          {
            decks,
          }
        ),
      }
    }
  )
}

function registerGetDeckCardReferenceTool(server: McpServer) {
  server.registerTool(
    "get_deck_card_reference",
    {
      title: "Get Deck Card Reference",
      description:
        "Return the decklist and card oracle text reference for a saved deck.",
      inputSchema: {
        ...deckIdentifierSchema,
      },
    },
    async ({ deckId }: McpDeckIdentifierInput) => {
      const deck = await getDeckCardReferenceData(deckId)

      if (!deck) {
        throw new Error("Deck not found.")
      }

      const uniqueCards = dedupeCardsByNameAndText([
        ...deck.commanders,
        ...deck.library,
      ])

      return {
        content: createToolResultContent(
          `Loaded card reference for ${deck.name}.`,
          {
            deck: {
              id: deck.deckId,
              name: deck.name,
              description: deck.description,
              mulliganGuidelines: deck.mulliganGuidelines,
              strategyGuidelines: deck.strategyGuidelines,
              format: deck.format,
              createdAt: deck.createdAt,
              updatedAt: deck.updatedAt,
            },
            commanders: expandCardNames(deck.commanders),
            cards: expandCardNames(deck.library),
            cardReference: formatCardReference(uniqueCards),
          }
        ),
      }
    }
  )
}

function registerCreateSimulationTool(server: McpServer) {
  server.registerTool(
    "create_simulation",
    {
      title: "Create Simulation",
      description:
        "Create a new simulation for a deck and return the simulation ID for future tool calls.",
      inputSchema: {
        deckId: deckIdSchema.describe(
          "The deck ID to create a simulation for."
        ),
      },
    },
    async ({ deckId }) => {
      const simulation = await createSimulation(deckId, {
        seed: randomUUID(),
        llmModelPresetId: null,
        turnsToSimulate: 0,
        autoGenerateReport: false,
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async (input: McpDrawCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const { count } = input
      const response = await drawCardsFromTop(resolvedSimulationId, count)

      return {
        content: createToolResultContent(
          `Drew ${response.cards.length} card(s) from the top. ${response.cardsRemaining} card(s) remain.`,
          addMcpReasonToToolResult(identifier, input, response)
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async (input: McpDrawCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const { count } = input
      const response = await drawCardsFromBottom(resolvedSimulationId, count)

      return {
        content: createToolResultContent(
          `Drew ${response.cards.length} card(s) from the bottom. ${response.cardsRemaining} card(s) remain.`,
          addMcpReasonToToolResult(identifier, input, response)
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
      },
    },
    async (input: McpSimulationIdentifierInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const response = await drawStartingHand(resolvedSimulationId)

      return {
        content: createToolResultContent(
          `Drew the starting hand. ${response.cardsRemaining} card(s) remain in the library.`,
          addMcpReasonToToolResult(identifier, input, response)
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
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
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
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
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
          addMcpReasonToToolResult(identifier, input, response)
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
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
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
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
          addMcpReasonToToolResult(identifier, input, response)
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The card names to remove from the library. Each request is matched independently against the current remaining library."
          ),
      },
    },
    async (input: McpTakeCardsInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const { cards } = input
      const response = await takeCardsFromSimulationLibrary(
        resolvedSimulationId,
        cards
      )

      return {
        content: createToolResultContent(
          `Found and removed ${response.foundCards.length} requested card(s). ${response.cardsRemaining} card(s) remain.`,
          addMcpReasonToToolResult(identifier, input, response)
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
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
      },
    },
    async (input: McpSimulationIdentifierInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const response = await shuffleSimulationLibrary(resolvedSimulationId)

      return {
        content: createToolResultContent(
          `Shuffled the library. ${response.cardsRemaining} card(s) remain.`,
          addMcpReasonToToolResult(identifier, input, response)
        ),
      }
    }
  )
}

function registerFlipCoinTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "flip_coin",
    {
      title: "Flip Coin",
      description:
        'Flip one or more fair coins for Magic card effects that care about winning or losing a flip. Each result is "win" or "lose".',
      inputSchema: {
        ...identifier.inputSchema,
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
        count: randomizerCountSchema
          .default(1)
          .describe(
            "How many coins to flip. Defaults to 1. Must be between 1 and 100."
          ),
      },
    },
    async (input: McpFlipCoinInput) => {
      await resolveMcpSimulationId(input, identifier.authContext)
      const response = flipCoins(input.count ?? 1)

      return {
        content: createToolResultContent(
          `Flipped ${response.results.length} coin(s): ${response.wins} win(s), ${response.losses} loss(es).`,
          addMcpReasonToToolResult(identifier, input, response)
        ),
      }
    }
  )
}

function registerRollDiceTool(
  server: McpServer,
  identifier: McpSimulationIdentifierConfig
) {
  server.registerTool(
    "roll_dice",
    {
      title: "Roll Dice",
      description:
        "Roll one or more fair dice with a configurable number of sides for Magic card effects that instruct you to roll dice.",
      inputSchema: {
        ...identifier.inputSchema,
        ...(identifier.requireReason ? { reason: mcpShortReasonSchema } : {}),
        count: randomizerCountSchema,
        sides: diceSidesSchema,
      },
    },
    async (input: McpRollDiceInput) => {
      await resolveMcpSimulationId(input, identifier.authContext)
      const response = rollDice(input.count, input.sides)

      return {
        content: createToolResultContent(
          `Rolled ${response.rolls.length} d${response.sides}: total ${response.total}.`,
          addMcpReasonToToolResult(identifier, input, response)
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
        phaseChange: turnPhaseChangeSchema.optional(),
      },
    },
    async (input: McpLogTurnActionInput) => {
      const resolvedSimulationId = await resolveMcpSimulationId(
        input,
        identifier.authContext
      )
      const { action, phaseChange } = input
      const response = await logTurnAction(
        resolvedSimulationId,
        action,
        phaseChange ?? null
      )

      return {
        content: createCompactToolResultContent({
          actions: response.actions.map((loggedAction) => loggedAction.action),
          latestAction: {
            action: response.latestAction.action,
            phaseChange: response.latestAction.phaseChange,
          },
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
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
    }),
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
      reason: mcpShortReasonSchema,
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
      phaseChange: turnPhaseChangeSchema.optional(),
    }),
  },
  {
    name: "draw_card_from_top",
    description:
      "Draw one or more cards from the top of the stored library for an existing simulation.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
      count: z.number().int().positive().describe("How many cards to draw."),
    }),
  },
  {
    name: "draw_card_from_bottom",
    description:
      "Draw one or more cards from the bottom of the stored library for an existing simulation.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
      count: z.number().int().positive().describe("How many cards to draw."),
    }),
  },
  {
    name: "take_cards_from_library",
    description:
      "Take one or more specific cards out of the stored library for tutor and search effects. Each requested name uses the best reasonably close fuzzy match, ignoring case and punctuation. If no close enough match exists, that request returns no card.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
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
      reason: mcpShortReasonSchema,
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
      reason: mcpShortReasonSchema,
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
    }),
  },
  {
    name: "shuffle_library",
    description: "Shuffle the stored library for an existing simulation.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
    }),
  },
  {
    name: "flip_coin",
    description:
      'Flip one or more fair coins for Magic card effects that care about winning or losing a flip. Each result is "win" or "lose".',
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
      count: randomizerCountSchema
        .default(1)
        .describe(
          "How many coins to flip. Defaults to 1. Must be between 1 and 100."
        ),
    }),
  },
  {
    name: "roll_dice",
    description:
      "Roll one or more fair dice with a configurable number of sides for Magic card effects that instruct you to roll dice.",
    inputSchema: z.object({
      ...llmRunIdentifierSchema,
      reason: mcpShortReasonSchema,
      count: randomizerCountSchema,
      sides: diceSidesSchema,
    }),
  },
]

function createOpeningHandOpenRouterTools(
  mcpClient: Client,
  signal: AbortSignal
): Tool[] {
  return createOpenRouterTools(openingHandLlmToolDefinitions, mcpClient, signal)
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
  mcpRunToken: string,
  simulationId: string
) {
  return {
    model: config.model,
    input: fullPrompt,
    max_output_tokens: config.maxOutputTokens,
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
        server_url: appendMcpRunTokenToUrl(
          config.openingHandMcpPublicUrl,
          mcpRunToken
        ),
        require_approval: "never" as const,
      },
    ],
  }
}

function buildTurnSimulationOpenAiRequestPayload(
  config: TurnSimulationOpenAiRunConfig,
  fullPrompt: string,
  mcpRunToken: string,
  simulationId: string,
  turnNumber: number
) {
  return {
    model: config.model,
    input: fullPrompt,
    max_output_tokens: config.maxOutputTokens,
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
          "Tools for resolving one Magic: The Gathering goldfish turn, including library operations, random coin/dice results, and turn action logging.",
        server_url: appendMcpRunTokenToUrl(
          config.turnSimulationMcpPublicUrl,
          mcpRunToken
        ),
        require_approval: "never" as const,
      },
    ],
  }
}

function buildReportOpenAiRequestPayload(
  config: OpenAiRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  return {
    model: config.model,
    input: fullPrompt,
    max_output_tokens: config.maxOutputTokens,
    stream: true as const,
    metadata: {
      simulationId,
      phase: "report",
    },
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto" as const,
    },
  }
}

function generateMcpRunToken(): GeneratedMcpRunToken {
  const token = randomBytes(32).toString("base64url")

  return {
    token,
    tokenHash: hashMcpRunToken(token),
    expiresAt: new Date(Date.now() + MCP_RUN_TOKEN_TTL_MS),
  }
}

function hashMcpRunToken(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

function appendMcpRunTokenToUrl(url: string, token: string) {
  const parsedUrl = new URL(url)

  parsedUrl.searchParams.set("mcpRunToken", token)

  return parsedUrl.toString()
}

function appendMcpRunTokenToPath(path: string, token: string) {
  const parsedUrl = new URL(path, `http://${DEFAULT_HOST}:${DEFAULT_PORT}`)

  parsedUrl.searchParams.set("mcpRunToken", token)

  return `${parsedUrl.pathname}${parsedUrl.search}`
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
    maxOutputTokens: config.maxOutputTokens,
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

function buildReportOpenRouterRequestPayload(
  config: OpenRouterRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  return {
    providerType: "openrouter" as const,
    model: config.model,
    input: fullPrompt,
    maxOutputTokens: config.maxOutputTokens,
    metadata: {
      simulationId,
      phase: "report",
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
    max_tokens: config.maxOutputTokens,
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
    tools: createLlamaCppChatCompletionTools(openingHandLlmToolDefinitions),
    stopWhenStepCount: config.stopWhenStepCount,
  }
}

function buildReportLlamaCppRequestPayload(
  config: ResolvedLlamaCppRunConfig,
  fullPrompt: string,
  simulationId: string
): LlamaCppChatCompletionRequestPayload {
  return {
    providerType: "llamacpp",
    model: config.model,
    max_tokens: config.maxOutputTokens,
    messages: [
      {
        role: "user",
        content: fullPrompt,
      },
    ],
    metadata: {
      simulationId,
      phase: "report",
    },
    parallel_tool_calls: false,
    tools: [],
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
    maxOutputTokens: config.maxOutputTokens,
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
    max_tokens: config.maxOutputTokens,
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

function getLlmRunOpenRouterModelProvider(
  config: ResolvedOpeningHandLlmRunConfig | ResolvedTurnSimulationLlmRunConfig
) {
  return config.provider === "openrouter" ? config.modelProvider : null
}

function buildOpeningHandLlmRequestPayload(
  config: ResolvedOpeningHandLlmRunConfig,
  fullPrompt: string,
  mcpRunToken: string,
  simulationId: string
) {
  if (config.provider === "openai") {
    return buildOpeningHandOpenAiRequestPayload(
      config,
      fullPrompt,
      mcpRunToken,
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
  mcpRunToken: string,
  simulationId: string,
  turnNumber: number
) {
  if (config.provider === "openai") {
    return buildTurnSimulationOpenAiRequestPayload(
      config,
      fullPrompt,
      mcpRunToken,
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

function buildReportLlmRequestPayload(
  config: ResolvedTurnSimulationLlmRunConfig,
  fullPrompt: string,
  simulationId: string
) {
  if (config.provider === "openai") {
    return buildReportOpenAiRequestPayload(config, fullPrompt, simulationId)
  }

  if (config.provider === "llamacpp") {
    return buildReportLlamaCppRequestPayload(config, fullPrompt, simulationId)
  }

  return buildReportOpenRouterRequestPayload(config, fullPrompt, simulationId)
}

type OpeningHandLlmRequestPayload = ReturnType<
  typeof buildOpeningHandLlmRequestPayload
>
type TurnSimulationLlmRequestPayload = ReturnType<
  typeof buildTurnSimulationLlmRequestPayload
>
type ReportLlmRequestPayload = ReturnType<typeof buildReportLlmRequestPayload>
type OpeningHandOpenRouterRequestPayload = ReturnType<
  typeof buildOpeningHandOpenRouterRequestPayload
>
type TurnSimulationOpenRouterRequestPayload = ReturnType<
  typeof buildTurnSimulationOpenRouterRequestPayload
>
type ReportOpenRouterRequestPayload = ReturnType<
  typeof buildReportOpenRouterRequestPayload
>
type LlamaCppRequestPayload =
  | ReturnType<typeof buildOpeningHandLlamaCppRequestPayload>
  | ReturnType<typeof buildTurnSimulationLlamaCppRequestPayload>
  | ReturnType<typeof buildReportLlamaCppRequestPayload>

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

  return redactMcpRunTokens(persistableRequestPayload)
}

function redactMcpRunTokens(value: unknown): unknown {
  if (typeof value === "string") {
    return redactMcpRunTokenFromString(value)
  }

  if (Array.isArray(value)) {
    return value.map(redactMcpRunTokens)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, propertyValue]) => [
        key,
        key === "mcpRunToken" ? "[redacted]" : redactMcpRunTokens(propertyValue),
      ])
    )
  }

  return value
}

function redactMcpRunTokenFromString(value: string) {
  try {
    const parsedUrl = new URL(value)

    if (parsedUrl.searchParams.has("mcpRunToken")) {
      parsedUrl.searchParams.set("mcpRunToken", "[redacted]")
      return parsedUrl.toString()
    }
  } catch {
    // Not a URL; fall through to the query-param regex.
  }

  return value.replace(/([?&]mcpRunToken=)[^&#]*/g, "$1[redacted]")
}

function formatLlmRunPhase(phase: LlmRunPhase) {
  if (phase === "opening_hand") {
    return "Opening-hand"
  }

  if (phase === "turn") {
    return "Turn"
  }

  if (phase === "report") {
    return "Report"
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
  config: EvaluationLlmRunConfig
): Promise<ResolvedEvaluationLlmRunConfig>
async function resolveLlmRunConfigModel(
  config:
    | EvaluationLlmRunConfig
    | OpeningHandLlmRunConfig
    | TurnSimulationLlmRunConfig
): Promise<
  | ResolvedEvaluationLlmRunConfig
  | ResolvedOpeningHandLlmRunConfig
  | ResolvedTurnSimulationLlmRunConfig
> {
  return config
}

async function getRequiredEnabledSimulationLlmModelPreset(
  deckId: string,
  simulationId: string
) {
  const simulation = await getSimulationSummary(deckId, simulationId)

  if (!simulation) {
    throw new SimulationValidationError("Simulation not found.")
  }

  if (!simulation.llmModelPresetId) {
    throw new SimulationValidationError(
      "Select an enabled model preset before starting LLM runs for this simulation."
    )
  }

  const preset = await getEnabledLlmModelPreset(simulation.llmModelPresetId)

  if (!preset) {
    throw new SimulationValidationError(
      "The selected model preset is disabled. Choose an enabled model preset before starting LLM runs."
    )
  }

  return preset
}

async function getRequiredEnabledEvaluationLlmModelPreset(
  llmModelPresetId: string
) {
  const preset = await getEnabledLlmModelPreset(llmModelPresetId)

  if (!preset) {
    throw new SimulationValidationError(
      "Choose an enabled model preset for this evaluation."
    )
  }

  return preset
}

async function getRequiredEnabledQueuedRunLlmModelPreset(
  run: ClaimedQueuedLlmRun
) {
  if (!run.llmModelPresetId) {
    throw new Error("Queued LLM run is missing a model preset.")
  }

  const preset = await getEnabledLlmModelPreset(run.llmModelPresetId)

  if (!preset) {
    throw new Error("Queued LLM run model preset is disabled or missing.")
  }

  return preset
}

function getLlmModelPresetRunConfig(preset: LlmModelPreset) {
  return {
    id: preset.id,
    provider: preset.provider,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort,
    openrouterModelProvider: preset.openrouterModelProvider,
    inputTokenCostUsdPerMillion: preset.inputTokenCostUsdPerMillion,
    cachedInputTokenCostUsdPerMillion:
      preset.cachedInputTokenCostUsdPerMillion,
    outputTokenCostUsdPerMillion: preset.outputTokenCostUsdPerMillion,
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
    const modelPreset = await getRequiredEnabledSimulationLlmModelPreset(
      deckId,
      simulationId
    )
    const llmConfig = await resolveLlmRunConfigModel(
      getOpeningHandLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
    )

    if (resetBeforeStart) {
      await resetSimulationForOpeningHandLlmRun(deckId, simulationId)
    }

    const openingHandRun = await createOpeningHandLlmRun(deckId, {
      simulationId,
      llmModelPresetId: llmConfig.modelPresetId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      openrouterModelProvider: getLlmRunOpenRouterModelProvider(llmConfig),
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
      QUEUED_MCP_RUN_TOKEN_PLACEHOLDER,
      simulationId
    )

    await updateLlmRunRequestData({
      llmRunId: openingHandRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })

    if (!(await markLlmRunQueued(openingHandRun.llmRunId))) {
      throw new Error("Opening-hand LLM run could not be queued.")
    }
    await publishSimulationResultsState({
      deckId,
      llmRunId: openingHandRun.llmRunId,
      simulationId,
    })
    nudgeLlmRunQueue()

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
    const modelPreset = await getRequiredEnabledSimulationLlmModelPreset(
      deckId,
      simulationId
    )
    const llmConfig = await resolveLlmRunConfigModel(
      getTurnSimulationLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
    )
    const turnRun = await createTurnLlmRun(deckId, {
      simulationId,
      llmModelPresetId: llmConfig.modelPresetId,
      turnNumber,
      provider: llmConfig.provider,
      model: llmConfig.model,
      openrouterModelProvider: getLlmRunOpenRouterModelProvider(llmConfig),
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
      QUEUED_MCP_RUN_TOKEN_PLACEHOLDER,
      simulationId,
      turnNumber
    )

    await updateLlmRunRequestData({
      llmRunId: turnRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })

    if (!(await markLlmRunQueued(turnRun.llmRunId))) {
      throw new Error("Turn LLM run could not be queued.")
    }
    await publishSimulationResultsState({
      deckId,
      llmRunId: turnRun.llmRunId,
      simulationId,
    })
    nudgeLlmRunQueue()

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

async function prepareAndStartReportLlmRun({
  deckId,
  requireAutoSimulateNextStep = false,
  simulationId,
}: {
  deckId: string
  simulationId: string
  requireAutoSimulateNextStep?: boolean
}) {
  let createdLlmRunId: string | null = null

  try {
    const modelPreset = await getRequiredEnabledSimulationLlmModelPreset(
      deckId,
      simulationId
    )
    const llmConfig = await resolveLlmRunConfigModel(
      getTurnSimulationLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
    )
    const fullPrompt = await buildSimulationReportPrompt({
      deckId,
      simulationId,
    })
    const requestPayload = buildReportLlmRequestPayload(
      llmConfig,
      fullPrompt,
      simulationId
    )
    const reportRun = await createReportLlmRun(deckId, {
      simulationId,
      llmModelPresetId: llmConfig.modelPresetId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      openrouterModelProvider: getLlmRunOpenRouterModelProvider(llmConfig),
      reasoningEffort: llmConfig.reasoningEffort,
      runtimeStreamKey: randomUUID(),
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
      requireAutoSimulateNextStep,
    })
    createdLlmRunId = reportRun.llmRunId

    if (!(await markLlmRunQueued(reportRun.llmRunId))) {
      throw new Error("Report LLM run could not be queued.")
    }
    await publishSimulationResultsState({
      deckId,
      llmRunId: reportRun.llmRunId,
      simulationId,
    })
    nudgeLlmRunQueue()

    return reportRun
  } catch (error) {
    if (createdLlmRunId !== null) {
      await failReportLlmRun(createdLlmRunId, getErrorMessage(error)).catch(
        (failError: unknown) => {
          console.error("Failed to mark report LLM run failed:", failError)
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
  if (!completion.nextStep) {
    return
  }

  try {
    if (completion.nextStep.type === "turn") {
      await prepareAndStartTurnLlmRun({
        deckId: completion.deckId,
        simulationId: completion.simulationId,
        turnNumber: completion.nextStep.turnNumber,
        requireAutoSimulateNextStep: true,
      })
      return
    }

    if (completion.nextStep.type === "report") {
      await prepareAndStartReportLlmRun({
        deckId: completion.deckId,
        simulationId: completion.simulationId,
        requireAutoSimulateNextStep: true,
      })
    }
  } catch (error) {
    if (isBenignAutoAdvanceAbortError(error)) {
      console.log(
        `Simulation auto-advance skipped: simulationId=${completion.simulationId} reason=${getErrorMessage(error)}`
      )
      return
    }

    if (completion.nextStep.type === "report") {
      console.error("Failed to auto-start simulation report:", error)
      await publishSimulationResultsState({
        deckId: completion.deckId,
        simulationId: completion.simulationId,
      })
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

function startLlmRunQueue(config: LlmRunQueueConfig) {
  llmRunQueueConfig = config

  if (!llmRunQueueDrainTimer) {
    llmRunQueueDrainTimer = setInterval(
      nudgeLlmRunQueue,
      LLM_RUN_QUEUE_POLL_INTERVAL_MS
    )
  }

  nudgeLlmRunQueue()
}

function stopLlmRunQueue() {
  if (!llmRunQueueDrainTimer) {
    return
  }

  clearInterval(llmRunQueueDrainTimer)
  llmRunQueueDrainTimer = null
}

function nudgeLlmRunQueue() {
  if (!llmRunQueueConfig || llmRunQueueDrainPromise) {
    return
  }

  llmRunQueueDrainPromise = drainLlmRunQueue(llmRunQueueConfig)
    .catch((error: unknown) => {
      console.error("Failed to drain queued LLM runs:", error)
    })
    .finally(() => {
      llmRunQueueDrainPromise = null
    })
}

async function drainLlmRunQueue(config: LlmRunQueueConfig) {
  while (true) {
    const claimedRun = await claimNextQueuedLlmRun({
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxConcurrentRunsPerUser: config.maxConcurrentRunsPerUser,
    })

    if (!claimedRun) {
      return
    }

    await startClaimedQueuedLlmRun(claimedRun)
  }
}

async function startClaimedQueuedLlmRun(run: ClaimedQueuedLlmRun) {
  try {
    const modelPreset = await getRequiredEnabledQueuedRunLlmModelPreset(run)

    if (run.phase === "opening_hand") {
      const config = await resolveLlmRunConfigModel(
        getOpeningHandLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
      )

      assertClaimedRunMatchesConfig(run, config)

      if (!(await isLlmRunStreaming(run.llmRunId))) {
        return
      }

      startOpeningHandLlmRun({
        attemptNumber: run.attemptNumber,
        config,
        createdAt: run.createdAt,
        deckId: run.deckId,
        fullPrompt: run.fullPrompt,
        llmRunId: run.llmRunId,
        runtimeStreamKey: run.runtimeStreamKey,
        simulationId: run.simulationId,
        startedAt: run.startedAt,
      })
      return
    }

    const config = await resolveLlmRunConfigModel(
      getTurnSimulationLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
    )

    assertClaimedRunMatchesConfig(run, config)

    if (!(await isLlmRunStreaming(run.llmRunId))) {
      return
    }

    if (run.phase === "turn") {
      if (typeof run.turnNumber !== "number") {
        throw new Error("Queued turn LLM run is missing its turn number.")
      }

      startTurnLlmRun({
        attemptNumber: run.attemptNumber,
        config,
        createdAt: run.createdAt,
        deckId: run.deckId,
        fullPrompt: run.fullPrompt,
        llmRunId: run.llmRunId,
        runtimeStreamKey: run.runtimeStreamKey,
        simulationId: run.simulationId,
        startedAt: run.startedAt,
        turnNumber: run.turnNumber,
      })
      return
    }

    startReportLlmRun({
      attemptNumber: run.attemptNumber,
      config,
      createdAt: run.createdAt,
      deckId: run.deckId,
      fullPrompt: run.fullPrompt,
      llmRunId: run.llmRunId,
      runtimeStreamKey: run.runtimeStreamKey,
      simulationId: run.simulationId,
      startedAt: run.startedAt,
    })
  } catch (error) {
    console.error("Failed to start queued LLM run:", error)
    await failClaimedQueuedLlmRun(run, getErrorMessage(error))
  }
}

function assertClaimedRunMatchesConfig(
  run: ClaimedQueuedLlmRun,
  config: ResolvedOpeningHandLlmRunConfig | ResolvedTurnSimulationLlmRunConfig
) {
  const currentOpenRouterModelProvider =
    getLlmRunOpenRouterModelProvider(config)

  if (
    run.llmModelPresetId === config.modelPresetId &&
    run.provider === config.provider &&
    run.model === config.model &&
    run.openrouterModelProvider === currentOpenRouterModelProvider &&
    run.reasoningEffort === config.reasoningEffort
  ) {
    return
  }

  throw new Error(
    `${formatLlmRunPhase(run.phase)} LLM run was queued for ${formatQueuedRunConfig(run)}, but current configuration is ${formatLlmRunConfig(config)}.`
  )
}

function formatQueuedRunConfig(run: ClaimedQueuedLlmRun) {
  return formatLlmRunConfigParts({
    model: run.model,
    openrouterModelProvider: run.openrouterModelProvider,
    provider: run.provider,
    reasoningEffort: run.reasoningEffort,
  })
}

function formatLlmRunConfig(
  config: ResolvedOpeningHandLlmRunConfig | ResolvedTurnSimulationLlmRunConfig
) {
  return formatLlmRunConfigParts({
    model: config.model,
    openrouterModelProvider: getLlmRunOpenRouterModelProvider(config),
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
  })
}

function formatLlmRunConfigParts({
  model,
  openrouterModelProvider,
  provider,
  reasoningEffort,
}: {
  model: string
  openrouterModelProvider: string | null
  provider: string
  reasoningEffort: string | null
}) {
  return [
    `provider=${provider}`,
    `model=${model}`,
    openrouterModelProvider ? `modelProvider=${openrouterModelProvider}` : null,
    reasoningEffort ? `reasoningEffort=${reasoningEffort}` : null,
  ]
    .filter(Boolean)
    .join(", ")
}

async function failClaimedQueuedLlmRun(
  run: ClaimedQueuedLlmRun,
  failureMessage: string
) {
  if (run.phase === "report") {
    await failReportLlmRun(run.llmRunId, failureMessage)
  } else {
    await failLlmRun(run.llmRunId, failureMessage)
  }

  await publishSimulationResultsState({
    deckId: run.deckId,
    llmRunId: run.llmRunId,
    simulationId: run.simulationId,
  })
  nudgeLlmRunQueue()
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
  | ReturnType<typeof buildReportOpenAiRequestPayload>
type OpenRouterRequestPayload =
  | OpeningHandOpenRouterRequestPayload
  | TurnSimulationOpenRouterRequestPayload
  | ReportOpenRouterRequestPayload

function isOpenAiRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
): requestPayload is OpenAiRequestPayload {
  return "stream" in requestPayload
}

function isOpenRouterRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
): requestPayload is OpenRouterRequestPayload {
  return asRecord(requestPayload).providerType === "openrouter"
}

function isLlamaCppRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
): requestPayload is LlamaCppRequestPayload {
  return asRecord(requestPayload).providerType === "llamacpp"
}

function requireOpenAiRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
) {
  if (!isOpenAiRequestPayload(requestPayload)) {
    throw new Error("LLM run config and request payload provider mismatch.")
  }

  return requestPayload
}

function requireOpenRouterRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
) {
  if (!isOpenRouterRequestPayload(requestPayload)) {
    throw new Error("LLM run config and request payload provider mismatch.")
  }

  return requestPayload
}

function requireLlamaCppRequestPayload(
  requestPayload:
    | OpeningHandLlmRequestPayload
    | TurnSimulationLlmRequestPayload
    | ReportLlmRequestPayload
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

  await forEachRuntimeAbortableAsync(stream, signal, async (event) => {
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

    await appendRuntimeChunk(runtime, normalizedEvent)

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
    tokenCosts: config.tokenCosts,
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
  createTools?: (mcpClient: Client, signal: AbortSignal) => Tool[]
  llmRunId: string
  mcpPath?: string
  phase: LlmRunPhase
  requestPayload: OpenRouterRequestPayload
  runtime: ActiveLlmRunRuntime
}): Promise<CompletedLlmStreamResult> {
  let outputText = ""
  let responseMetadata: unknown = {}
  let usage: unknown = {}
  let didReceiveCompletedResponse = false
  let providerTerminalEventError: ProviderTerminalEventError | null = null
  let currentOpenRouterTurnIndex = 0
  const completedResponseUsageValues: unknown[] = []
  const toolCallNamesById: OpenRouterToolCallNameMap = new Map()
  const openrouter = new OpenRouter({
    apiKey: config.apiKey,
  })
  const signal = runtime.abortController.signal
  const mcpClient =
    createTools && mcpPath
      ? await createProviderMcpClient({
        clientName: "openrouter-agent",
        path: mcpPath,
        signal,
      })
      : null
  let mcpClientClosePromise: Promise<void> | null = null

  const closeMcpClient = () => {
    if (!mcpClient) {
      return Promise.resolve()
    }

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
        maxOutputTokens: requestPayload.maxOutputTokens,
        metadata: requestPayload.metadata,
        reasoning: requestPayload.reasoning,
        parallelToolCalls: requestPayload.parallelToolCalls,
        provider: requestPayload.provider,
        stopWhen: stepCountIs(requestPayload.stopWhenStepCount),
        tools: mcpClient && createTools ? createTools(mcpClient, signal) : [],
      },
      {
        signal,
      }
    )
    const removeAbortHandler = registerRuntimeAbortHandler(signal, () => {
      void result.cancel().catch(() => { })
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
        const eventTurnNumber = getNumberProperty(eventRecord, "turnNumber")

        if (
          eventType === "turn.start" &&
          eventTurnNumber !== null &&
          Number.isInteger(eventTurnNumber) &&
          eventTurnNumber >= 0
        ) {
          currentOpenRouterTurnIndex = eventTurnNumber
        }

        if (eventType === "response.completed") {
          const response = eventRecord.response
          const responseRecord = asRecord(response)
          const generationId =
            getOpenRouterGenerationIdFromCompletedEvent(event)
          didReceiveCompletedResponse = true
          outputText = getCompletedResponseOutputText(response)
          responseMetadata = response ?? {}
          completedResponseUsageValues.push(responseRecord.usage ?? {})
          usage = aggregateOpenRouterUsage(completedResponseUsageValues)

          if (generationId) {
            const generation = await recordOpenRouterLlmRunGeneration({
              llmRunId,
              openrouterTurnIndex: currentOpenRouterTurnIndex,
              generationId,
              responseMetadata,
            })

            if (generation) {
              rememberRuntimeOpenRouterGeneration(runtime, generation)
            }
          }
        }

        await appendRuntimeChunk(runtime, normalizedEvent)

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
        await result.cancel().catch(() => { })
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
    tokenCosts: config.tokenCosts,
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
  mcpPath?: string
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
  const mcpClient =
    mcpPath && toolDefinitions.length > 0
      ? await createProviderMcpClient({
        clientName: "llamacpp-agent",
        path: mcpPath,
        signal,
      })
      : null
  let mcpClientClosePromise: Promise<void> | null = null

  const closeMcpClient = () => {
    if (!mcpClient) {
      return Promise.resolve()
    }

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
          mcpClient
            ? callMcpToolForProvider(
              mcpClient,
              name,
              args,
              toolSignal,
              "llama.cpp"
            )
            : Promise.reject(new Error("No MCP tools are available.")),
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
        tokenCosts: config.tokenCosts,
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

async function collectRunEvaluationCompletion({
  config,
  llmRunId,
  metadata,
  prompt,
}: {
  config: ResolvedEvaluationLlmRunConfig
  llmRunId: string
  metadata: Record<string, string>
  prompt: string
}) {
  logLlmApiCallStarted({
    llmRunId,
    model: config.model,
    phase: "other",
    provider: config.provider,
  })

  if (config.provider === "openai") {
    const client = new OpenAI({
      apiKey: config.apiKey,
    })
    const response = await client.responses.create({
      model: config.model,
      input: prompt,
      max_output_tokens: config.maxOutputTokens,
      metadata,
      reasoning: {
        effort: config.reasoningEffort,
        summary: "auto" as const,
      },
      text: {
        format: {
          type: "json_object",
        },
      },
    })
    const outputText = getCompletedResponseOutputText(response)

    logLlmApiCallFinished({
      llmRunId,
      model: config.model,
      phase: "other",
      provider: config.provider,
      tokenCosts: config.tokenCosts,
      usage: asRecord(response).usage ?? {},
    })

    return outputText
  }

  if (config.provider === "openrouter") {
    const result = await queryOpenRouterChatCompletion({
      apiKey: config.apiKey,
      body: {
        model: config.model,
        max_completion_tokens: config.maxOutputTokens,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        metadata,
        provider: getOpenRouterChatProviderPreferences(config.modelProvider),
        reasoning: {
          effort: config.reasoningEffort,
          summary: "auto" as const,
        },
        response_format: {
          type: "json_object",
        },
        stream: false,
      },
    })
    const outputText = getChatCompletionOutputText(result)

    logLlmApiCallFinished({
      llmRunId,
      model: config.model,
      phase: "other",
      provider: config.provider,
      tokenCosts: config.tokenCosts,
      usage: asRecord(result).usage ?? {},
    })

    return outputText
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })
  const result = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxOutputTokens,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    stream: false,
  })
  const outputText = getChatCompletionOutputText(result)

  logLlmApiCallFinished({
    llmRunId,
    model: config.model,
    phase: "other",
    provider: config.provider,
    tokenCosts: config.tokenCosts,
    usage: asRecord(result).usage ?? {},
  })

  return outputText
}

function getChatCompletionOutputText(result: unknown) {
  const choices = asRecord(result).choices

  if (!Array.isArray(choices)) {
    throw new Error("Turn evaluation response did not include choices.")
  }

  for (const choice of choices) {
    const message = asRecord(asRecord(choice).message)
    const contentText = getChatMessageContentText(message.content)

    if (contentText.trim()) {
      return contentText
    }
  }

  throw new Error("Turn evaluation response did not include output text.")
}

async function queryOpenRouterChatCompletion({
  apiKey,
  body,
}: {
  apiKey: string
  body: Record<string, unknown>
}) {
  let response: globalThis.Response

  try {
    response = await fetch(OPENROUTER_CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(
      `OpenRouter chat completion could not be reached: ${getErrorMessage(error)}`
    )
  }

  const result = await readOpenRouterResponseBody(response)

  if (!response.ok) {
    throw new Error(getOpenRouterChatCompletionFailureMessage(response, result))
  }

  return result
}

function getOpenRouterChatProviderPreferences(modelProvider: string | null) {
  if (modelProvider === null) {
    return undefined
  }

  return {
    allow_fallbacks: false,
    only: [modelProvider],
  }
}

function getChatMessageContentText(content: unknown) {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .map((part) => getStringProperty(asRecord(part), "text") ?? "")
    .join("")
}

async function saveTurnEvaluation({
  evaluationJson,
  llmModelPresetId,
  simulationId,
  turnLlmRunId,
}: {
  evaluationJson: TurnEvaluationJson
  llmModelPresetId: string
  simulationId: string
  turnLlmRunId: string
}) {
  return upsertTurnEvaluation({
    simulationId,
    turnLlmRunId,
    llmModelPresetId,
    legalTurnPass: evaluationJson.legalTurnPass,
    reasoningPass: evaluationJson.reasoningPass,
    simulationQualityScore: evaluationJson.simulationQualityScore,
    evaluationJson,
  })
}

async function saveOpeningHandEvaluation({
  evaluationJson,
  llmModelPresetId,
  openingHandLlmRunId,
  simulationId,
}: {
  evaluationJson: OpeningHandEvaluationJson
  llmModelPresetId: string
  openingHandLlmRunId: string
  simulationId: string
}) {
  return upsertOpeningHandEvaluation({
    simulationId,
    openingHandLlmRunId,
    llmModelPresetId,
    legalSimulationPass: evaluationJson.legalSimulationPass,
    reasoningPass: evaluationJson.reasoningPass,
    simulationQualityScore: evaluationJson.simulationQualityScore,
    evaluationJson,
  })
}

function isEvaluationOutputError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.startsWith("Turn evaluation response") ||
      error.message.startsWith("Opening-hand evaluation response"))
  )
}

function startOpeningHandLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
}: {
  attemptNumber: number
  config: ResolvedOpeningHandLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
}) {
  void runOpeningHandLlmRun({
    attemptNumber,
    config,
    createdAt,
    deckId,
    fullPrompt,
    llmRunId,
    runtimeStreamKey,
    simulationId,
    startedAt,
  })
}

async function runOpeningHandLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
}: {
  attemptNumber: number
  config: ResolvedOpeningHandLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    attemptNumber,
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    createdAt,
    deckId,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    llmModelPresetId: config.modelPresetId,
    model: config.model,
    fullPrompt,
    nextSequence: 1,
    openrouterGenerations: [],
    phase: "opening_hand",
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
    recentChunks: [],
    resolveCompletion: completion.resolveCompletion,
    runtimeStreamKey,
    simulationId,
    startedAt,
    status: "streaming",
  }

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)

  try {
    throwIfRuntimeAborted(runtime.abortController.signal)
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })

    const mcpRunToken = generateMcpRunToken()
    await createLlmRunMcpToken({
      deckId,
      llmRunId,
      simulationId,
      phase: "opening_hand",
      tokenHash: mcpRunToken.tokenHash,
      expiresAt: mcpRunToken.expiresAt,
    })
    throwIfRuntimeAborted(runtime.abortController.signal)
    const requestPayload = buildOpeningHandLlmRequestPayload(
      config,
      fullPrompt,
      mcpRunToken.token,
      simulationId
    )

    await updateLlmRunRequestData({
      llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })
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
            mcpPath: appendMcpRunTokenToPath(
              OPENING_HAND_MCP_PATH,
              mcpRunToken.token
            ),
            phase: "opening_hand",
            requestPayload: requireOpenRouterRequestPayload(requestPayload),
            runtime,
          })
          : await collectLlamaCppLlmStream({
            config,
            llmRunId,
            mcpPath: appendMcpRunTokenToPath(
              OPENING_HAND_MCP_PATH,
              mcpRunToken.token
            ),
            phase: "opening_hand",
            requestPayload: requireLlamaCppRequestPayload(requestPayload),
            runtime,
            toolDefinitions: openingHandLlmToolDefinitions,
          })

    throwIfRuntimeAborted(runtime.abortController.signal)
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const parsedOpeningHand = parseOpeningHandCompletionFromResponseText(
      streamResult.outputText
    )

    throwIfRuntimeAborted(runtime.abortController.signal)
    await appendRuntimeChunk(
      runtime,
      createFinalParsedOutputChunk(parsedOpeningHand.parsedOutput)
    )
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const completion = await completeOpeningHandLlmRun({
      llmRunId,
      openingHand: parsedOpeningHand.keptHand,
      responseMetadata: streamResult.responseMetadata,
      usage: streamResult.usage,
    })
    runtime.status = "completed"

    if (completion.nextStep?.type === "report") {
      await handleSimulationCompletionNextStep(completion)
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
    } else {
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
      await handleSimulationCompletionNextStep(completion)
    }
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logLlmApiCallCancelled({
        llmRunId,
        phase: "opening_hand",
        provider: config.provider,
      })
      await appendRuntimeChunk(runtime, createCancellationChunk())
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
      await appendRuntimeChunk(runtime, createServerErrorChunk(error))
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
    await revokeLlmRunMcpToken(llmRunId).catch((error: unknown) => {
      console.error("Failed to revoke opening-hand MCP run token:", error)
    })
    clearRuntimeFlushTimer(runtime)
    activeLlmRunRuntimes.delete(runtimeStreamKey)
    runtime.resolveCompletion()
    nudgeLlmRunQueue()
  }
}

function startTurnLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
  turnNumber,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
  turnNumber: number
}) {
  void runTurnLlmRun({
    attemptNumber,
    config,
    createdAt,
    deckId,
    fullPrompt,
    llmRunId,
    runtimeStreamKey,
    simulationId,
    startedAt,
    turnNumber,
  })
}

async function runTurnLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
  turnNumber,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
  turnNumber: number
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    attemptNumber,
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    createdAt,
    deckId,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    llmModelPresetId: config.modelPresetId,
    model: config.model,
    fullPrompt,
    nextSequence: 1,
    openrouterGenerations: [],
    phase: "turn",
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
    recentChunks: [],
    resolveCompletion: completion.resolveCompletion,
    runtimeStreamKey,
    simulationId,
    startedAt,
    status: "streaming",
    turnNumber,
  }

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)

  try {
    throwIfRuntimeAborted(runtime.abortController.signal)
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })

    const mcpRunToken = generateMcpRunToken()
    await createLlmRunMcpToken({
      deckId,
      llmRunId,
      simulationId,
      phase: "turn",
      tokenHash: mcpRunToken.tokenHash,
      expiresAt: mcpRunToken.expiresAt,
    })
    throwIfRuntimeAborted(runtime.abortController.signal)
    const requestPayload = buildTurnSimulationLlmRequestPayload(
      config,
      fullPrompt,
      mcpRunToken.token,
      simulationId,
      turnNumber
    )

    await updateLlmRunRequestData({
      llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })
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
            mcpPath: appendMcpRunTokenToPath(
              TURN_SIMULATION_MCP_PATH,
              mcpRunToken.token
            ),
            phase: "turn",
            requestPayload: requireOpenRouterRequestPayload(requestPayload),
            runtime,
          })
          : await collectLlamaCppLlmStream({
            config,
            llmRunId,
            mcpPath: appendMcpRunTokenToPath(
              TURN_SIMULATION_MCP_PATH,
              mcpRunToken.token
            ),
            phase: "turn",
            requestPayload: requireLlamaCppRequestPayload(requestPayload),
            runtime,
            toolDefinitions: turnSimulationLlmToolDefinitions,
          })

    throwIfRuntimeAborted(runtime.abortController.signal)
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const parsedTurn = parseTurnSimulationCompletionFromResponseText(
      streamResult.outputText
    )

    throwIfRuntimeAborted(runtime.abortController.signal)
    await appendRuntimeChunk(
      runtime,
      createFinalParsedOutputChunk(parsedTurn.parsedOutput)
    )
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const completion = await completeTurnLlmRun({
      llmRunId,
      gameState: parsedTurn.gameState,
      responseMetadata: streamResult.responseMetadata,
      usage: streamResult.usage,
    })
    runtime.status = "completed"

    if (completion.nextStep?.type === "report") {
      await handleSimulationCompletionNextStep(completion)
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
    } else {
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
      await handleSimulationCompletionNextStep(completion)
    }
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logLlmApiCallCancelled({
        llmRunId,
        phase: "turn",
        provider: config.provider,
      })
      await appendRuntimeChunk(
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
      await appendRuntimeChunk(runtime, createServerErrorChunk(error))
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
    await revokeLlmRunMcpToken(llmRunId).catch((error: unknown) => {
      console.error("Failed to revoke turn MCP run token:", error)
    })
    clearRuntimeFlushTimer(runtime)
    activeLlmRunRuntimes.delete(runtimeStreamKey)
    runtime.resolveCompletion()
    nudgeLlmRunQueue()
  }
}

function startReportLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
}) {
  void runReportLlmRun({
    attemptNumber,
    config,
    createdAt,
    deckId,
    fullPrompt,
    llmRunId,
    runtimeStreamKey,
    simulationId,
    startedAt,
  })
}

async function runReportLlmRun({
  attemptNumber,
  config,
  createdAt,
  deckId,
  fullPrompt,
  llmRunId,
  runtimeStreamKey,
  simulationId,
  startedAt,
}: {
  attemptNumber: number
  config: ResolvedTurnSimulationLlmRunConfig
  createdAt: string
  deckId: string
  fullPrompt: string
  llmRunId: string
  runtimeStreamKey: string
  simulationId: string
  startedAt: string
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    attemptNumber,
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    createdAt,
    deckId,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    llmModelPresetId: config.modelPresetId,
    model: config.model,
    fullPrompt,
    nextSequence: 1,
    openrouterGenerations: [],
    phase: "report",
    provider: config.provider,
    reasoningEffort: config.reasoningEffort,
    recentChunks: [],
    resolveCompletion: completion.resolveCompletion,
    runtimeStreamKey,
    simulationId,
    startedAt,
    status: "streaming",
  }

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)

  try {
    throwIfRuntimeAborted(runtime.abortController.signal)
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })

    const requestPayload = buildReportLlmRequestPayload(
      config,
      fullPrompt,
      simulationId
    )
    await updateLlmRunRequestData({
      llmRunId,
      fullPrompt,
      requestPayload: getPersistableLlmRequestPayload(requestPayload),
    })
    throwIfRuntimeAborted(runtime.abortController.signal)

    const streamResult =
      config.provider === "openai"
        ? await collectOpenAiLlmStream({
          config,
          llmRunId,
          phase: "report",
          requestPayload: requireOpenAiRequestPayload(requestPayload),
          runtime,
        })
        : config.provider === "openrouter"
          ? await collectOpenRouterLlmStream({
            config,
            llmRunId,
            phase: "report",
            requestPayload: requireOpenRouterRequestPayload(requestPayload),
            runtime,
          })
          : await collectLlamaCppLlmStream({
            config,
            llmRunId,
            phase: "report",
            requestPayload: requireLlamaCppRequestPayload(requestPayload),
            runtime,
            toolDefinitions: [],
          })

    throwIfRuntimeAborted(runtime.abortController.signal)
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    const report = streamResult.outputText.trim()

    if (!report) {
      throw new Error("Report LLM completed response was empty.")
    }

    await appendRuntimeChunk(runtime, createFinalParsedOutputChunk({ report }))
    await forceFlushRuntimeChunks(runtime)
    throwIfRuntimeAborted(runtime.abortController.signal)

    await completeReportLlmRun({
      llmRunId,
      report,
      responseMetadata: streamResult.responseMetadata,
      usage: streamResult.usage,
    })
    runtime.status = "completed"
    await publishSimulationResultsState({
      deckId,
      llmRunId,
      simulationId,
    })
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logLlmApiCallCancelled({
        llmRunId,
        phase: "report",
        provider: config.provider,
      })
      await appendRuntimeChunk(
        runtime,
        createCancellationChunk("Report LLM run was cancelled.")
      )
      await tryForceFlushRuntimeChunks(runtime, "cancelled report run")
      await cancelReportLlmRun(llmRunId, "Report LLM run was cancelled.")
      runtime.status = "cancelled"
      await publishSimulationResultsState({
        deckId,
        llmRunId,
        simulationId,
      })
      return
    }

    if (!(error instanceof ProviderTerminalEventError)) {
      await appendRuntimeChunk(runtime, createServerErrorChunk(error))
    }

    await tryForceFlushRuntimeChunks(runtime, "failed report run")
    logLlmApiCallStoppedWithError({
      error,
      llmRunId,
      phase: "report",
      provider: config.provider,
    })
    console.error("Report LLM run failed:", error)
    await failReportLlmRun(llmRunId, getErrorMessage(error))
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
    nudgeLlmRunQueue()
  }
}

async function stopActiveAdminUserSimulations(userId: string) {
  const activeSimulations = await listActiveAdminUserSimulations(userId)

  for (const simulation of activeSimulations) {
    await stopActiveSimulationLlmRuns(
      simulation.deckId,
      simulation.simulationId
    )
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
  let stoppedGameplayRun = false

  for (const run of activeRuns) {
    if (run.phase !== "report") {
      stoppedGameplayRun = true
    }

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
      if (run.phase === "report") {
        await cancelReportLlmRun(run.llmRunId, cancellationMessage)
      } else {
        await cancelLlmRun(run.llmRunId, cancellationMessage)
      }
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

  if (stoppedGameplayRun) {
    await markSimulationCancelled(simulationId, "Simulation was stopped.")
  }

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

async function appendRuntimeChunk(
  runtime: ActiveLlmRunRuntime,
  chunk: Omit<LlmRunChunkInput, "sequence">
) {
  const sequencedChunk = {
    ...chunk,
    sequence: runtime.nextSequence,
  }

  runtime.nextSequence += 1

  if (shouldPersistRuntimeChunkBeforeStreaming(sequencedChunk)) {
    await forceFlushRuntimeChunks(runtime)

    const persistedChunk = await appendLlmRunChunkWithResolvedCardMentions(
      runtime.llmRunId,
      sequencedChunk
    )

    if (persistedChunk) {
      publishRuntimeStreamChunk(
        runtime,
        createStreamChunkFromPersistedChunk(persistedChunk)
      )
      return
    }
  }

  runtime.chunkBuffer.push(sequencedChunk)
  publishRuntimeChunk(runtime, sequencedChunk)
  scheduleRuntimeFlush(runtime)
}

function shouldPersistRuntimeChunkBeforeStreaming(chunk: LlmRunChunkInput) {
  return (
    chunk.kind === "mcp_call_complete" || chunk.kind === "final_parsed_output"
  )
}

function createStreamChunkFromPersistedChunk(
  chunk: SimulationDebugLlmRunChunk
): SimulationResultsStreamChunk {
  return {
    ...chunk,
    id: chunk.id,
  }
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
  const queueConfig = getLlmRunQueueConfig()
  await verifyDatabaseConnection()
  await ensureAuthSchema()
  await ensureFreshScryfallOracleCards()
  await ensureDecksSchema()
  await ensureStartingHandsSchema()
  await ensureSavedSeedsSchema()
  await ensureLlmModelPresetsSchema()
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
  const simulationMcpServerEnabled = getSimulationMcpServerEnabled()
  const app = express()

  app.use(localhostHostValidation())

  app.use((req: Request, res: Response, next) => {
    applyCors(req, res, allowedOrigins)

    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }

    next()
  })

  app.all("/api/auth/*splat", toNodeHandler(auth))

  app.use((req: Request, res: Response, next) => {
    if (isMcpPath(req.path, simulationMcpServerEnabled)) {
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

  app.post(APP_SIGN_UP_PATH, async (req: Request, res: Response) => {
    const signUpInput = parseAppSignUpBody(req.body)

    if (!signUpInput) {
      res.status(400).json({
        error:
          "Email and password are required. Password must be between 8 and 128 characters.",
      })
      return
    }

    try {
      if (await userEmailExists(signUpInput.email)) {
        res.status(409).json({
          error: "An account with this email already exists.",
        })
        return
      }

      const signUpResult = await auth.api.signUpEmail({
        body: {
          email: signUpInput.email,
          name: signUpInput.email,
          password: signUpInput.password,
          rememberMe: true,
        },
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      })

      forwardResponseCookies(res, signUpResult.headers)

      res.status(201).json({
        email: signUpInput.email,
      })
    } catch (error) {
      console.error("Failed to create account:", error)
      res.status(500).json({
        error: "Account could not be created.",
      })
    }
  })

  app.get(APP_PASSWORD_RESET_TOKEN_PATH, async (req: Request, res: Response) => {
    const token = parsePasswordResetTokenParam(req.params.token)

    if (!token) {
      res.status(200).json({ valid: false })
      return
    }

    try {
      res.status(200).json({
        valid: await isPasswordResetTokenValid(token),
      })
    } catch (error) {
      console.error("Failed to check password reset token:", error)
      res.status(500).json({
        error: "Password reset link could not be checked.",
      })
    }
  })

  app.get(
    APP_EMAIL_VERIFICATION_CODE_PATH,
    async (req: Request, res: Response) => {
      try {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        })

        if (!session) {
          res.status(401).json({
            error: "Authentication required.",
          })
          return
        }

        res.status(200).json({
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          hasValidCode: session.user.emailVerified
            ? false
            : await hasValidEmailVerificationOtp(session.user.email),
        })
      } catch (error) {
        console.error("Failed to check email verification code:", error)
        res.status(500).json({
          error: "Email verification code could not be checked.",
        })
      }
    }
  )

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: SERVER_NAME,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    })
  })

  app.use(async (req: Request, res: Response, next) => {
    if (
      req.path === "/health" ||
      isAuthPath(req.path) ||
      isMcpPath(req.path, simulationMcpServerEnabled)
    ) {
      next()
      return
    }

    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      })

      if (!session) {
        res.status(401).json({
          error: "Authentication required.",
        })
        return
      }

      if (!session.user.emailVerified) {
        res.status(403).json({
          error: "Email verification required.",
        })
        return
      }

      authenticatedUsersByRequest.set(req, {
        id: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        role: session.user.role ?? null,
      })
      next()
    } catch (error) {
      console.error("Failed to authenticate request:", error)
      res.status(500).json({
        error: "Authentication could not be verified.",
      })
    }
  })

  app.get("/admin/users", async (req: Request, res: Response) => {
    if (!requireAdminUser(req, res)) {
      return
    }

    try {
      const users = await listAdminUsers()

      res.status(200).json({
        users,
        total: users.length,
      })
    } catch (error) {
      console.error("Failed to list admin users:", error)
      res.status(500).json({
        error: "Failed to list users.",
      })
    }
  })

  app.delete("/admin/users/:userId", async (req: Request, res: Response) => {
    const adminUser = requireAdminUser(req, res)

    if (!adminUser) {
      return
    }

    const userId = String(req.params.userId).trim()

    if (!userId) {
      res.status(400).json({
        error: "User ID is required.",
      })
      return
    }

    if (userId === adminUser.id) {
      res.status(400).json({
        error: "You cannot delete your own account.",
      })
      return
    }

    try {
      await stopActiveAdminUserSimulations(userId)

      const deletion = await deleteAdminUser(userId)

      if (!deletion) {
        res.status(404).json({
          error: "User not found.",
        })
        return
      }

      for (const simulationId of deletion.deletedSimulationIds) {
        simulationResultsBroadcaster.closeSimulation(simulationId)
      }

      nudgeLlmRunQueue()
      res.status(204).send()
    } catch (error) {
      if (error instanceof SimulationStopTimeoutError) {
        res.status(504).json({
          error: error.message,
        })
        return
      }

      console.error("Failed to delete admin user:", error)
      res.status(500).json({
        error: "Failed to delete user.",
      })
    }
  })

  app.get("/llm-model-presets", async (_req: Request, res: Response) => {
    try {
      const presets = await listEnabledLlmModelPresets()

      res.status(200).json({
        presets,
        defaultPresetId:
          presets.find((preset) => preset.isDefault)?.id ?? null,
      })
    } catch (error) {
      console.error("Failed to list model presets:", error)
      res.status(500).json({
        error: "Failed to list model presets.",
      })
    }
  })

  app.get(
    "/admin/llm-model-presets",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      try {
        const presets = await listAdminLlmModelPresets()

        res.status(200).json({
          presets,
          total: presets.length,
        })
      } catch (error) {
        console.error("Failed to list admin model presets:", error)
        res.status(500).json({
          error: "Failed to list model presets.",
        })
      }
    }
  )

  app.post(
    "/admin/llm-model-presets",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const parsedPreset = createLlmModelPresetSchema.safeParse(req.body)

      if (!parsedPreset.success) {
        res.status(400).json({
          error: "Model preset payload is not in the expected format.",
        })
        return
      }

      try {
        const preset = await createLlmModelPreset(parsedPreset.data)

        res.status(201).json({
          preset,
        })
      } catch (error) {
        if (error instanceof LlmModelPresetValidationError) {
          res.status(400).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to create model preset:", error)
        res.status(500).json({
          error: "Failed to create model preset.",
        })
      }
    }
  )

  app.patch(
    "/admin/llm-model-presets/:presetId/enabled",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const presetId = String(req.params.presetId)
      const parsedUpdate = updateLlmModelPresetEnabledSchema.safeParse(req.body)

      if (!parsedUpdate.success) {
        res.status(400).json({
          error: "Model preset update payload is not in the expected format.",
        })
        return
      }

      try {
        const preset = await setLlmModelPresetEnabled(
          presetId,
          parsedUpdate.data.isEnabled
        )

        if (!preset) {
          res.status(404).json({
            error: "Model preset not found.",
          })
          return
        }

        res.status(200).json({
          preset,
        })
      } catch (error) {
        console.error("Failed to update model preset:", error)
        res.status(500).json({
          error: "Failed to update model preset.",
        })
      }
    }
  )

  app.put(
    "/admin/llm-model-presets/default",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const parsedDefault = setDefaultLlmModelPresetSchema.safeParse(req.body)

      if (!parsedDefault.success) {
        res.status(400).json({
          error: "Default model preset payload is not in the expected format.",
        })
        return
      }

      try {
        const preset = await setDefaultLlmModelPreset(
          parsedDefault.data.presetId
        )

        res.status(200).json({
          preset,
        })
      } catch (error) {
        if (error instanceof LlmModelPresetValidationError) {
          res.status(400).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to set default model preset:", error)
        res.status(500).json({
          error: "Failed to set default model preset.",
        })
      }
    }
  )

  app.delete(
    "/admin/llm-model-presets/:presetId",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const presetId = String(req.params.presetId)

      try {
        const wasDeleted = await deleteUnusedLlmModelPreset(presetId)

        if (!wasDeleted) {
          res.status(404).json({
            error: "Model preset not found.",
          })
          return
        }

        res.status(204).send()
      } catch (error) {
        if (error instanceof LlmModelPresetValidationError) {
          res.status(400).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to delete model preset:", error)
        res.status(500).json({
          error: "Failed to delete model preset.",
        })
      }
    }
  )

  app.use("/decks/:deckId", async (req: Request, res: Response, next) => {
    try {
      const deckId = String(req.params.deckId)
      const deck = await getDeck(deckId, getAuthenticatedUser(req).id)

      if (!deck) {
        res.status(404).json({
          error: "Deck not found.",
        })
        return
      }

      next()
    } catch (error) {
      console.error("Failed to verify deck ownership:", error)
      res.status(500).json({
        error: "Deck access could not be verified.",
      })
    }
  })

  app.get("/decks", async (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        decks: await listDecks(getAuthenticatedUser(_req).id),
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
    "/decks/:deckId/simulations/:simulationId/opening-hand-llm-runs/:llmRunId/evaluation",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const llmRunId = String(req.params.llmRunId)
      const parsedEvaluationRequest = evaluationLlmRunRequestSchema.safeParse(
        req.body
      )

      if (!parsedEvaluationRequest.success) {
        res.status(400).json({
          error: "Evaluation payload is not in the expected format.",
        })
        return
      }

      try {
        const run = await getOpeningHandLlmRunEvaluationData(
          deckId,
          simulationId,
          llmRunId
        )

        const ineligibilityMessage =
          getOpeningHandEvaluationIneligibilityMessage(run)

        if (ineligibilityMessage !== null) {
          throw new SimulationValidationError(ineligibilityMessage)
        }

        const openingHandEvaluationInputText =
          buildOpeningHandEvaluationInputText({
            chunks: run.chunks,
            fullPrompt: run.fullPrompt,
          })

        if (!openingHandEvaluationInputText.trim()) {
          throw new SimulationValidationError(
            "Opening-hand LLM run does not have evaluation text."
          )
        }

        const prompt = buildOpeningHandEvaluationPrompt({
          attemptNumber: run.attemptNumber,
          openingHandEvaluationInputText,
        })
        const modelPreset = await getRequiredEnabledEvaluationLlmModelPreset(
          parsedEvaluationRequest.data.llmModelPresetId
        )
        const config = await resolveLlmRunConfigModel(
          getEvaluationLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
        )
        const responseText = await collectRunEvaluationCompletion({
          config,
          llmRunId,
          metadata: {
            simulationId,
            phase: "opening_hand_evaluation",
            openingHandLlmRunId: llmRunId,
            attemptNumber: String(run.attemptNumber),
            modelPresetId: config.modelPresetId,
          },
          prompt,
        })
        const evaluationJson =
          parseOpeningHandEvaluationResponseText(responseText)
        const evaluation = await saveOpeningHandEvaluation({
          evaluationJson,
          llmModelPresetId: config.modelPresetId,
          openingHandLlmRunId: llmRunId,
          simulationId,
        })

        res.status(200).json({
          evaluation,
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status =
            error.message === "Opening-hand LLM run not found." ||
              error.message === "Simulation not found."
              ? 404
              : 400

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

        if (isEvaluationOutputError(error)) {
          res.status(502).json({
            error: getErrorMessage(error),
          })
          return
        }

        console.error("Failed to evaluate opening-hand LLM run:", error)
        res.status(500).json({
          error: "Failed to evaluate opening-hand LLM run.",
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
          createdAt: turnRun.createdAt,
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
    "/decks/:deckId/simulations/:simulationId/turn-llm-runs/:llmRunId/evaluation",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const llmRunId = String(req.params.llmRunId)
      const parsedEvaluationRequest = evaluationLlmRunRequestSchema.safeParse(
        req.body
      )

      if (!parsedEvaluationRequest.success) {
        res.status(400).json({
          error: "Evaluation payload is not in the expected format.",
        })
        return
      }

      try {
        const run = await getTurnLlmRunEvaluationData(
          deckId,
          simulationId,
          llmRunId
        )

        const ineligibilityMessage =
          getTurnEvaluationIneligibilityMessage(run)

        if (ineligibilityMessage !== null) {
          throw new SimulationValidationError(ineligibilityMessage)
        }

        const turnEvaluationInputText = buildTurnEvaluationInputText({
          chunks: run.chunks,
          fullPrompt: run.fullPrompt,
        })

        if (!turnEvaluationInputText.trim()) {
          throw new SimulationValidationError(
            "Turn LLM run does not have evaluation text."
          )
        }

        const prompt = buildTurnEvaluationPrompt({
          turnEvaluationInputText,
          turnNumber: run.turnNumber,
        })
        const modelPreset = await getRequiredEnabledEvaluationLlmModelPreset(
          parsedEvaluationRequest.data.llmModelPresetId
        )
        const config = await resolveLlmRunConfigModel(
          getEvaluationLlmRunConfig(getLlmModelPresetRunConfig(modelPreset))
        )
        const responseText = await collectRunEvaluationCompletion({
          config,
          llmRunId,
          metadata: {
            simulationId,
            phase: "turn_evaluation",
            turnLlmRunId: llmRunId,
            turnNumber: String(run.turnNumber),
            modelPresetId: config.modelPresetId,
          },
          prompt,
        })
        const evaluationJson = parseTurnEvaluationResponseText(responseText)
        const evaluation = await saveTurnEvaluation({
          evaluationJson,
          llmModelPresetId: config.modelPresetId,
          simulationId,
          turnLlmRunId: llmRunId,
        })

        res.status(200).json({
          evaluation,
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status =
            error.message === "Turn LLM run not found." ||
              error.message === "Simulation not found."
              ? 404
              : 400

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

        if (isEvaluationOutputError(error)) {
          res.status(502).json({
            error: getErrorMessage(error),
          })
          return
        }

        console.error("Failed to evaluate turn LLM run:", error)
        res.status(500).json({
          error: "Failed to evaluate turn LLM run.",
        })
      }
    }
  )

  app.post(
    "/decks/:deckId/simulations/:simulationId/report-llm-runs",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)

      try {
        const reportRun = await prepareAndStartReportLlmRun({
          deckId,
          simulationId,
        })

        res.status(202).json(reportRun)
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

        console.error("Failed to start report LLM run:", error)
        res.status(500).json({
          error: "Failed to start report LLM run.",
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
      if (!requireAdminUser(req, res)) {
        return
      }

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
    "/decks/:deckId/simulations/:simulationId/openrouter-generations/:generationId",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const generationId = String(req.params.generationId)

      try {
        const generation = await getOpenRouterGenerationForSimulation(
          deckId,
          simulationId,
          generationId
        )

        if (!generation) {
          res.status(404).json({
            error: "OpenRouter generation not found for this simulation.",
          })
          return
        }

        const result = await queryOpenRouterGenerationEndpoint(
          generation.generationId
        )
        const providerName = getOpenRouterGenerationProviderName(result)
        const providerEntry = providerName
          ? await queryOpenRouterProviderEntry(providerName)
          : null
        const providerSlug = getOpenRouterProviderSlug(providerEntry)

        res.status(200).json({
          generation,
          providerName,
          providerEntry,
          providerSlug,
          result,
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          res.status(400).json({
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

        if (error instanceof OpenRouterGenerationLookupError) {
          res.status(error.statusCode).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to query OpenRouter generation:", error)
        res.status(500).json({
          error: "Failed to query OpenRouter generation.",
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
    "/decks/:deckId/simulations/:simulationId/llm-runs/:llmRunId/full-prompt",
    async (req: Request, res: Response) => {
      if (!requireAdminUser(req, res)) {
        return
      }

      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const llmRunId = String(req.params.llmRunId)

      try {
        const fullPrompt = await getSimulationLlmRunFullPrompt(
          deckId,
          simulationId,
          llmRunId
        )

        if (fullPrompt === null) {
          res.status(404).json({
            error: "LLM run prompt not found.",
          })
          return
        }

        res.status(200).json({
          fullPrompt,
        })
      } catch (error) {
        console.error("Failed to load LLM run prompt:", error)
        res.status(500).json({
          error: "Failed to load LLM run prompt.",
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
        let unsubscribe = () => { }
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

        if (
          !isTerminalSimulationStatus(initialSimulation.status) ||
          initialSimulation.activeLlmRunCount > 0
        ) {
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

        if (
          isTerminalSimulationStatus(snapshot.simulation.status) &&
          snapshot.simulation.activeLlmRunCount === 0
        ) {
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

  app.patch(
    "/decks/:deckId/simulations/:simulationId",
    async (req: Request, res: Response) => {
      const deckId = String(req.params.deckId)
      const simulationId = String(req.params.simulationId)
      const parsedUpdate = updateSimulationModelPresetSchema.safeParse(req.body)

      if (!parsedUpdate.success) {
        res.status(400).json({
          error: "Simulation update payload is not in the expected format.",
        })
        return
      }

      try {
        const simulation = await updateSimulationLlmModelPreset(
          deckId,
          simulationId,
          parsedUpdate.data.llmModelPresetId
        )

        await publishSimulationResultsState({
          deckId,
          simulationId,
        })

        res.status(200).json({
          simulation,
        })
      } catch (error) {
        if (error instanceof SimulationValidationError) {
          const status = error.message === "Simulation not found." ? 404 : 400

          res.status(status).json({
            error: error.message,
          })
          return
        }

        console.error("Failed to update simulation:", error)
        res.status(500).json({
          error: "Failed to update simulation.",
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
      const updatedDeck = await updateDeckDetails(
        deckId,
        parsedDeck.data,
        getAuthenticatedUser(req).id
      )

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
    const user = getAuthenticatedUser(req)

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
        mulliganGuidelines: parsedDeck.data.mulliganGuidelines,
        strategyGuidelines: parsedDeck.data.strategyGuidelines,
        ownerUserId: user.id,
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
      const wasDeleted = await deleteDeck(deckId, getAuthenticatedUser(req).id)

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

  registerMcpEndpoint(app, OPENING_HAND_MCP_PATH, createOpeningHandServer, {
    phase: "opening_hand",
  })
  registerMcpEndpoint(app, TURN_SIMULATION_MCP_PATH, createTurnSimulationServer, {
    phase: "turn",
  })

  if (simulationMcpServerEnabled) {
    registerMcpEndpoint(app, SIMULATION_MCP_PATH, createSimulationServer)
  }

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
    if (simulationMcpServerEnabled) {
      console.error(
        `Simulation MCP test endpoint available at http://${host}:${port}${SIMULATION_MCP_PATH}`
      )
    }
    startLlmRunQueue(queueConfig)
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
      stopLlmRunQueue()
      console.error(`Received ${signal}. Closing database pool...`)
      await closeDatabasePool()
      process.exit(0)
    })()
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

class OpenRouterGenerationLookupError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = "OpenRouterGenerationLookupError"
    this.statusCode = statusCode
  }
}

async function queryOpenRouterGenerationEndpoint(generationId: string) {
  const url = new URL(OPENROUTER_GENERATION_ENDPOINT)
  url.searchParams.set("id", generationId)

  let response: globalThis.Response

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getOpenRouterApiKey()}`,
      },
    })
  } catch (error) {
    throw new OpenRouterGenerationLookupError(
      `OpenRouter generation endpoint could not be reached: ${getErrorMessage(error)}`
    )
  }

  const result = await readOpenRouterResponseBody(response)

  if (!response.ok) {
    throw new OpenRouterGenerationLookupError(
      getOpenRouterGenerationLookupFailureMessage(response, result),
      response.status
    )
  }

  return result
}

async function queryOpenRouterProviderEntry(providerName: string) {
  const providersResult = await queryOpenRouterProvidersEndpoint()

  return getOpenRouterProviderEntryByName(providersResult, providerName)
}

async function queryOpenRouterProvidersEndpoint() {
  let response: globalThis.Response

  try {
    response = await fetch(OPENROUTER_PROVIDERS_ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getOpenRouterApiKey()}`,
      },
    })
  } catch (error) {
    throw new OpenRouterGenerationLookupError(
      `OpenRouter providers endpoint could not be reached: ${getErrorMessage(error)}`
    )
  }

  const result = await readOpenRouterResponseBody(response)

  if (!response.ok) {
    throw new OpenRouterGenerationLookupError(
      getOpenRouterProvidersLookupFailureMessage(response, result),
      response.status
    )
  }

  return result
}

function getOpenRouterGenerationProviderName(result: unknown) {
  return getNonEmptyStringProperty(
    asRecord(asRecord(result).data),
    "provider_name"
  )
}

function getOpenRouterProviderEntryByName(
  providersResult: unknown,
  providerName: string
) {
  const providers = asRecord(providersResult).data
  const normalizedProviderName = normalizeOpenRouterProviderName(providerName)

  if (!Array.isArray(providers)) {
    return null
  }

  for (const provider of providers) {
    const providerRecord = asRecord(provider)
    const name = getNonEmptyStringProperty(providerRecord, "name")

    if (
      name &&
      normalizeOpenRouterProviderName(name) === normalizedProviderName
    ) {
      return providerRecord
    }
  }

  return null
}

function getOpenRouterProviderSlug(providerEntry: unknown) {
  return getNonEmptyStringProperty(asRecord(providerEntry), "slug")
}

function normalizeOpenRouterProviderName(providerName: string) {
  return providerName.trim().toLowerCase()
}

async function readOpenRouterResponseBody(response: globalThis.Response) {
  const bodyText = await response.text()

  if (!bodyText.trim()) {
    return null
  }

  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    return bodyText
  }
}

function getOpenRouterGenerationLookupFailureMessage(
  response: globalThis.Response,
  result: unknown
) {
  const resultRecord = asRecord(result)
  const errorRecord = asRecord(resultRecord.error)
  const message =
    getStringProperty(errorRecord, "message") ??
    getStringProperty(resultRecord, "error") ??
    getStringProperty(resultRecord, "message") ??
    response.statusText

  return message
    ? `OpenRouter generation lookup failed (${response.status}): ${message}`
    : `OpenRouter generation lookup failed with status ${response.status}.`
}

function getOpenRouterChatCompletionFailureMessage(
  response: globalThis.Response,
  result: unknown
) {
  const resultRecord = asRecord(result)
  const errorRecord = asRecord(resultRecord.error)
  const message =
    getStringProperty(errorRecord, "message") ??
    getStringProperty(resultRecord, "error") ??
    getStringProperty(resultRecord, "message") ??
    response.statusText

  return message
    ? `OpenRouter chat completion failed (${response.status}): ${message}`
    : `OpenRouter chat completion failed with status ${response.status}.`
}

function getOpenRouterProvidersLookupFailureMessage(
  response: globalThis.Response,
  result: unknown
) {
  const resultRecord = asRecord(result)
  const errorRecord = asRecord(resultRecord.error)
  const message =
    getStringProperty(errorRecord, "message") ??
    getStringProperty(resultRecord, "error") ??
    getStringProperty(resultRecord, "message") ??
    response.statusText

  return message
    ? `OpenRouter providers lookup failed (${response.status}): ${message}`
    : `OpenRouter providers lookup failed with status ${response.status}.`
}

function getNonEmptyStringProperty(
  record: Record<string, unknown>,
  property: string
) {
  const value = getStringProperty(record, property)?.trim()

  return value ? value : null
}

function applyCors(
  req: Request,
  res: Response,
  allowedOrigins: readonly string[]
) {
  const requestOrigin = req.headers.origin

  if (requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Vary", "Origin")
  }

  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true")
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  )
  res.setHeader(
    "Access-Control-Allow-Headers",
    getAllowedRequestHeaders(req.headers["access-control-request-headers"])
  )
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

function getAuthenticatedUser(req: Request) {
  const user = authenticatedUsersByRequest.get(req)

  if (!user) {
    throw new Error("Request has not been authenticated.")
  }

  return user
}

function requireAdminUser(req: Request, res: Response) {
  const user = getAuthenticatedUser(req)

  if (user.role !== "admin") {
    res.status(403).json({
      error: "Admin access required.",
    })
    return null
  }

  return user
}

function parseAppSignUpBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null
  }

  const record = body as Record<string, unknown>
  const parsedBody = appSignUpSchema.safeParse({
    email:
      typeof record.email === "string"
        ? record.email.trim().toLowerCase()
        : record.email,
    password: record.password,
  })

  return parsedBody.success ? parsedBody.data : null
}

function parsePasswordResetTokenParam(token: unknown) {
  const parsedToken = passwordResetTokenSchema.safeParse(token)

  return parsedToken.success ? parsedToken.data : null
}

async function userEmailExists(email: string) {
  const result = await queryDatabase(
    `
      SELECT 1
      FROM "user"
      WHERE lower(email) = lower($1)
      LIMIT 1
    `,
    [email]
  )

  return (result.rowCount ?? 0) > 0
}

function forwardResponseCookies(res: Response, headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie
  const setCookieHeaders = getSetCookie
    ? getSetCookie.call(headers)
    : headers.get("set-cookie")
      ? [headers.get("set-cookie") as string]
      : []

  if (setCookieHeaders.length > 0) {
    res.append("Set-Cookie", setCookieHeaders)
  }
}

function isAuthPath(path: string) {
  return path === AUTH_PATH_PREFIX || path.startsWith(`${AUTH_PATH_PREFIX}/`)
}

function getSimulationMcpServerEnabled() {
  const value = process.env.SIMULATION_MCP_SERVER_ENABLED?.trim().toLowerCase()

  return value === "true" || value === "1" || value === "yes"
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
  app: Express,
  path: string,
  createScopedServer: (authContext?: LlmRunMcpTokenContext) => McpServer,
  authOptions?: {
    phase: LlmRunMcpTokenPhase
  }
) {
  app.post(path, async (req: Request, res: Response) => {
    await handleMcpRequest(req, res, createScopedServer, authOptions)
  })

  app.get(path, (_req: Request, res: Response) => {
    respondWithMethodNotAllowed(res)
  })

  app.delete(path, (_req: Request, res: Response) => {
    respondWithMethodNotAllowed(res)
  })
}

async function authenticateMcpRequest(
  req: Request,
  res: Response,
  phase: LlmRunMcpTokenPhase
) {
  const token = getMcpRunTokenFromRequest(req)

  if (!token) {
    res.status(401).json({
      error: "MCP run token is required.",
    })
    return null
  }

  const authContext = await getActiveLlmRunMcpTokenContext({
    phase,
    tokenHash: hashMcpRunToken(token),
  })

  if (!authContext) {
    res.status(401).json({
      error: "MCP run token is invalid or expired.",
    })
    return null
  }

  return authContext
}

function getMcpRunTokenFromRequest(req: Request) {
  const authorization = req.headers.authorization

  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i)

    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }

  const requestUrl = new URL(req.originalUrl, `http://${DEFAULT_HOST}`)

  return requestUrl.searchParams.get("mcpRunToken")?.trim() || null
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  createScopedServer: (authContext?: LlmRunMcpTokenContext) => McpServer,
  authOptions?: {
    phase: LlmRunMcpTokenPhase
  }
) {
  let authContext: LlmRunMcpTokenContext | null | undefined

  try {
    authContext = authOptions
      ? await authenticateMcpRequest(req, res, authOptions.phase)
      : undefined
  } catch (error) {
    console.error("Failed to authenticate MCP request:", error)
    res.status(500).json({
      error: "MCP authentication could not be verified.",
    })
    return
  }

  if (authContext === null) {
    return
  }

  const server = createScopedServer(authContext)
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

function isMcpPath(path: string, simulationMcpServerEnabled: boolean) {
  return (
    path === OPENING_HAND_MCP_PATH ||
    path === TURN_SIMULATION_MCP_PATH ||
    (simulationMcpServerEnabled && path === SIMULATION_MCP_PATH)
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
  { commanders, library, mulliganGuidelines }: StartingHandSimulationPromptData,
  llmRunId: string
) {
  const commanderLabel = commanders.length === 1 ? "Commander" : "Commanders"
  const commanderNames = expandCardNames(commanders)
  const cardNames = expandCardNames(library)
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...library])
  const cardReference = formatCardReference(uniqueCards)
  const mulliganGuidelinesSection = formatUserGuidelinesSection(
    "User provided mulligan guidelines",
    "USER PROVIDED MULLIGAN GUIDELINES",
    mulliganGuidelines
  )
  const mulliganGuidelinesBlock = mulliganGuidelinesSection
    ? `\n\n${mulliganGuidelinesSection}`
    : ""

  return `${DRAW_STARTING_HAND_PROMPT}

${commanderLabel}:
${commanderNames.join("\n")}

Decklist:
${cardNames.join("\n")}

Card reference:
${cardReference}${mulliganGuidelinesBlock}

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

function formatCardReference(cards: readonly SimulationPromptCard[]) {
  return cards
    .map((card) => `${card.name}\n${formatCardText(card)}\n`)
    .join("\n")
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
  {
    commanders,
    library,
    libraryCards,
    startingHand,
    strategyGuidelines,
  }: TurnSimulationPromptData,
  llmRunId: string,
  gameState?: string
) {
  const commanderNames = expandCardNames(commanders)
  const cardNames = [...library].sort((left, right) =>
    left.localeCompare(right)
  )
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...libraryCards])
  const cardReference = formatCardReference(uniqueCards)
  const resolvedGameState = gameState?.trim()
    ? gameState.trim()
    : buildInitialTurnGameState({
        commanderNames,
        startingHand,
      })
  const strategyGuidelinesSection = formatUserGuidelinesSection(
    "User provided strategy guidelines",
    "USER PROVIDED STRATEGY GUIDELINES",
    strategyGuidelines
  )
  const strategyGuidelinesBlock = strategyGuidelinesSection
    ? `\n\n${strategyGuidelinesSection}`
    : ""

  return `${SIMULATE_TURN_PROMPT}

${GENERIC_GAME_RULES_REFERENCE}

Card reference:
${cardReference}${strategyGuidelinesBlock}

Cards in library. Not actual order of library. Use tools to interact with library:
${cardNames.join("\n")}

===Start Game State===

${resolvedGameState}

===End Game State===

LLM Run ID: ${llmRunId}
`.trim()
}

export async function buildSimulationReportPrompt({
  deckId,
  simulationId,
}: {
  deckId: string
  simulationId: string
}) {
  const promptData = await getSimulationReportPromptData(deckId, simulationId)

  return buildSimulationReportPromptFromData(promptData)
}

function buildSimulationReportPromptFromData({
  startingHand,
  openingHandSummary,
  turns,
}: SimulationReportPromptData) {
  const openingHandSection =
    openingHandSummary === null
      ? `Preset opening hand:\n${formatReportList(startingHand)}`
      : `Opening hand summary:\n${openingHandSummary}\n\nKept hand:\n${formatReportList(startingHand)}`
  const turnSections =
    turns.length === 0
      ? "No turns have been simulated yet."
      : turns.map(formatReportTurnPromptSection).join("\n\n")

  return `
You are analyzing a Magic: The Gathering Commander goldfish simulation.

Generate a concise Markdown report for this simulation.

The report should help the deck user understand:
- how the opening hand performed
- what each simulated turn accomplished
- a short overall takeaway

Keep the report practical and focused. The goal is not to sumarize everything that happened.

=== Opening Hand ===

${openingHandSection}

=== Turns ===

${turnSections}
`.trim()
}

function formatReportTurnPromptSection({
  gameState,
  loggedActions,
  summary,
  turnNumber,
}: SimulationReportTurnPromptData) {
  return `
## Turn ${turnNumber}

Logged actions:
${formatReportList(loggedActions)}

Turn summary:
${summary}

End-of-turn game state:
${gameState}
`.trim()
}

function formatReportList(items: readonly string[]) {
  return items.length === 0
    ? "- none"
    : items.map((item) => `- ${item}`).join("\n")
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
Opponent A Commander Damage: none

Opponent B Life: 40
Opponent B Commander Damage: none

Opponent C Life: 40
Opponent C Commander Damage: none
`.trim()
}

main().catch(async (error: unknown) => {
  console.error(error)
  await closeDatabasePool()
  process.exit(1)
})
