import "dotenv/config"
import express, { type Request, type Response } from "express"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
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
  SimulationValidationError,
  takeCardsFromSimulationLibrary,
  updateLlmRunRequestData,
} from "./simulations-postgres.js"
import type {
  LlmRunChunkInput,
  LlmRunPhase,
  SimulationLlmCompletionResult,
  SimulationPromptCard,
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
  parseOpeningHandFromResponseText,
  parseTurnSimulationFromResponseText,
} from "./llm-run-events.js"
import {
  SimulationStopTimeoutError,
  waitForSimulationStopCompletions,
} from "./simulation-stop.js"
import { estimateOpenAiTokenPriceCents } from "./openai-pricing.js"
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
const OPENING_HAND_MCP_PATH = "/mcp/opening-hand"
const TURN_SIMULATION_MCP_PATH = "/mcp/turn-simulation"
const OPENING_HAND_MCP_SERVER_LABEL = "opening_hand"
const TURN_SIMULATION_MCP_SERVER_LABEL = "turn_simulation"
const OPENAI_PROVIDER = "openai"
const STREAM_FLUSH_INTERVAL_MS = 1000
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
const createSimulationSchema = z.object({
  seed: z.string().trim().min(1),
  turnsToSimulate: z.number().int().nonnegative(),
  startingHandId: z.uuid().nullable(),
})
const createTurnLlmRunSchema = z.object({
  turnNumber: z.number().int().positive(),
})
const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

type OpenAiRunConfig = {
  apiKey: string
  model: string
  reasoningEffort: z.infer<typeof reasoningEffortSchema>
}

type OpeningHandOpenAiRunConfig = OpenAiRunConfig & {
  openingHandMcpPublicUrl: string
}

type TurnSimulationOpenAiRunConfig = OpenAiRunConfig & {
  turnSimulationMcpPublicUrl: string
}

type ActiveLlmRunRuntime = {
  abortController: AbortController
  chunkBuffer: LlmRunChunkInput[]
  completionPromise: Promise<void>
  flushTimer: NodeJS.Timeout | null
  flushPromise: Promise<void> | null
  llmRunId: string
  nextSequence: number
  resolveCompletion: () => void
}

const activeLlmRunRuntimes = new Map<string, ActiveLlmRunRuntime>()

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

function logOpenAiApiCallStarted({
  llmRunId,
  model,
  phase,
}: {
  llmRunId: string
  model: string
  phase: LlmRunPhase
}) {
  console.log(
    `OpenAI API call started: phase=${phase} llmRunId=${llmRunId} model=${model}`
  )
}

function logOpenAiApiCallFinished({
  llmRunId,
  model,
  phase,
  usage,
}: {
  llmRunId: string
  model: string
  phase: LlmRunPhase
  usage: unknown
}) {
  const tokenUsage = getOpenAiTokenUsageSummary(usage)
  const priceEstimate = estimateOpenAiTokenPriceCents({ model, usage })
  const priceEstimateText = priceEstimate
    ? `${priceEstimate.formattedCents}c`
    : "unsupported"

  console.log(
    `OpenAI API call finished: phase=${phase} llmRunId=${llmRunId} totalTokens=${tokenUsage.total} inputTokens=${tokenUsage.input} reasoningTokens=${tokenUsage.reasoning} outputTokens=${tokenUsage.output} estimatedPrice=${priceEstimateText}`
  )
}

function logOpenAiApiCallCancelled({
  llmRunId,
  phase,
}: {
  llmRunId: string
  phase: LlmRunPhase
}) {
  console.log(`OpenAI API call cancelled: phase=${phase} llmRunId=${llmRunId}`)
}

function logOpenAiApiCallStoppedWithError({
  error,
  llmRunId,
  phase,
}: {
  error: unknown
  llmRunId: string
  phase: LlmRunPhase
}) {
  console.error(
    `OpenAI API call stopped with error: phase=${phase} llmRunId=${llmRunId} error=${getErrorMessage(error)}`,
    error
  )
}

function getOpenAiTokenUsageSummary(usage: unknown) {
  const usageRecord = asRecord(usage)
  const outputTokens = getNumberProperty(usageRecord, "output_tokens")
  const outputDetails = asRecord(usageRecord.output_tokens_details)
  const reasoningTokens =
    getNumberProperty(outputDetails, "reasoning_tokens") ?? 0
  const visibleOutputTokens =
    outputTokens === null ? null : Math.max(outputTokens - reasoningTokens, 0)
  const totalTokens =
    getNumberProperty(usageRecord, "total_tokens") ??
    sumTokenCounts([
      getNumberProperty(usageRecord, "input_tokens"),
      reasoningTokens,
      visibleOutputTokens,
    ])

  return {
    input: formatTokenCount(getNumberProperty(usageRecord, "input_tokens")),
    output: formatTokenCount(visibleOutputTokens),
    reasoning: formatTokenCount(reasoningTokens),
    total: formatTokenCount(totalTokens),
  }
}

function getNumberProperty(record: Record<string, unknown>, property: string) {
  const value = record[property]

  return typeof value === "number" && Number.isFinite(value) ? value : null
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

async function resolveMcpSimulationId(llmRunId: string) {
  return resolveSimulationIdentifier({ llmRunId })
}

function createOpeningHandServer() {
  return createServer(OPENING_HAND_SERVER_NAME, (server) => {
    registerDrawStartingHandTool(server)
    registerMulliganTool(server)
    registerReturnCardsToLibraryTool(server)
  })
}

function createTurnSimulationServer() {
  return createServer(TURN_SIMULATION_SERVER_NAME, (server) => {
    registerLogTurnActionTool(server)
    registerDrawCardFromTopTool(server)
    registerDrawCardFromBottomTool(server)
    registerTakeCardsFromLibraryTool(server)
    registerReturnCardToLibraryTool(server)
    registerReturnCardsToLibraryTool(server)
    registerShuffleLibraryTool(server)
  })
}

function registerDrawCardFromTopTool(server: McpServer) {
  server.registerTool(
    "draw_card_from_top",
    {
      title: "Draw Card From Top",
      description:
        "Draw one or more cards from the top of the stored library for an existing simulation.",
      inputSchema: {
        ...llmRunIdentifierSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async ({ count, llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerDrawCardFromBottomTool(server: McpServer) {
  server.registerTool(
    "draw_card_from_bottom",
    {
      title: "Draw Card From Bottom",
      description:
        "Draw one or more cards from the bottom of the stored library for an existing simulation.",
      inputSchema: {
        ...llmRunIdentifierSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
    },
    async ({ count, llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerDrawStartingHandTool(server: McpServer) {
  server.registerTool(
    "draw_starting_hand",
    {
      title: "Draw Starting Hand",
      description:
        "Draw the very first opening seven-card hand from the stored library for an existing simulation. Call this exactly once per simulation, before any mulligans. Never call this after mulligan, because mulligan already shuffles and draws the replacement seven-card hand.",
      inputSchema: {
        ...llmRunIdentifierSchema,
      },
    },
    async ({ llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerMulliganTool(server: McpServer) {
  server.registerTool(
    "mulligan",
    {
      title: "Mulligan",
      description:
        "Return the current opening hand to the library, shuffle, and draw a fresh seven-card hand. This can only be called after the starting hand has been drawn. Important: this tool already draws and returns the replacement hand, so do not call draw_starting_hand after using this tool.",
      inputSchema: {
        ...llmRunIdentifierSchema,
        reason: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A short explanation of why this hand is being mulliganed."
          ),
      },
    },
    async ({ llmRunId, reason }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerReturnCardToLibraryTool(server: McpServer) {
  server.registerTool(
    "return_card_to_library",
    {
      title: "Return Card To Library",
      description:
        "Return a card to the library for an existing simulation, placing it a specific number of cards from the top or bottom.",
      inputSchema: {
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
      },
    },
    async ({ card, llmRunId, position, side }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerReturnCardsToLibraryTool(server: McpServer) {
  server.registerTool(
    "return_cards_to_library",
    {
      title: "Return Cards To Library",
      description:
        "Return multiple cards to the top or bottom of the library for an existing simulation, optionally randomizing the order they are returned in.",
      inputSchema: {
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
          .describe(
            "Whether to shuffle the returned cards before putting them back."
          ),
      },
    },
    async ({ cards, llmRunId, randomizeOrder, side }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerTakeCardsFromLibraryTool(server: McpServer) {
  server.registerTool(
    "take_cards_from_library",
    {
      title: "Take Cards From Library",
      description:
        "Take one or more specific cards out of the stored library for tutor and search effects. Each requested name uses the best reasonably close fuzzy match, ignoring case and punctuation. If no close enough match exists, that request returns no card.",
      inputSchema: {
        ...llmRunIdentifierSchema,
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The card names to remove from the library. Each request is matched independently against the current remaining library."
          ),
      },
    },
    async ({ cards, llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerShuffleLibraryTool(server: McpServer) {
  server.registerTool(
    "shuffle_library",
    {
      title: "Shuffle Library",
      description: "Shuffle the stored library for an existing simulation.",
      inputSchema: {
        ...llmRunIdentifierSchema,
      },
    },
    async ({ llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

function registerLogTurnActionTool(server: McpServer) {
  server.registerTool(
    "log_turn_action",
    {
      title: "Log Turn Action",
      description:
        "Append an irreversible action note to the active turn log for this simulation. Use this as the authoritative turn history while resolving the turn. The response returns the full logged action list for the active turn.",
      inputSchema: {
        ...llmRunIdentifierSchema,
        action: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A concise description of the action being committed, such as a phase change, land play, spell cast, attack, or other turn progression."
          ),
      },
    },
    async ({ action, llmRunId }) => {
      const resolvedSimulationId = await resolveMcpSimulationId(llmRunId)
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

class OpenAiConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenAiConfigurationError"
  }
}

function getOpenAiRunConfig(): OpenAiRunConfig {
  const missingVariables = [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_REASONING_EFFORT",
  ].filter((environmentVariable) => !process.env[environmentVariable]?.trim())

  if (missingVariables.length > 0) {
    throw new OpenAiConfigurationError(
      `Missing OpenAI environment variable(s): ${missingVariables.join(", ")}. Add them to your repo-root .env file.`
    )
  }

  const parsedReasoningEffort = reasoningEffortSchema.safeParse(
    process.env.OPENAI_REASONING_EFFORT?.trim()
  )

  if (!parsedReasoningEffort.success) {
    throw new OpenAiConfigurationError(
      "OPENAI_REASONING_EFFORT must be one of: none, minimal, low, medium, high, xhigh."
    )
  }

  return {
    apiKey: process.env.OPENAI_API_KEY!.trim(),
    model: process.env.OPENAI_MODEL!.trim(),
    reasoningEffort: parsedReasoningEffort.data,
  }
}

function getOpeningHandOpenAiRunConfig(): OpeningHandOpenAiRunConfig {
  return {
    ...getOpenAiRunConfig(),
    openingHandMcpPublicUrl: getRequiredOpenAiEnvironmentVariable(
      "OPENING_HAND_MCP_PUBLIC_URL"
    ),
  }
}

function getTurnSimulationOpenAiRunConfig(): TurnSimulationOpenAiRunConfig {
  return {
    ...getOpenAiRunConfig(),
    turnSimulationMcpPublicUrl: getRequiredOpenAiEnvironmentVariable(
      "TURN_SIMULATION_MCP_PUBLIC_URL"
    ),
  }
}

function getRequiredOpenAiEnvironmentVariable(environmentVariable: string) {
  const value = process.env[environmentVariable]?.trim()

  if (!value) {
    throw new OpenAiConfigurationError(
      `Missing OpenAI environment variable(s): ${environmentVariable}. Add them to your repo-root .env file.`
    )
  }

  return value
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

function getPersistableOpenAiRequestPayload<
  TRequestPayload extends { input: unknown },
>(requestPayload: TRequestPayload) {
  return {
    ...requestPayload,
    input: "[stored in llm_runs.full_prompt]",
  }
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
    const openAiConfig = getOpeningHandOpenAiRunConfig()

    if (resetBeforeStart) {
      await resetSimulationForOpeningHandLlmRun(deckId, simulationId)
    }

    const openingHandRun = await createOpeningHandLlmRun(deckId, {
      simulationId,
      provider: OPENAI_PROVIDER,
      model: openAiConfig.model,
      reasoningEffort: openAiConfig.reasoningEffort,
      runtimeStreamKey: randomUUID(),
      fullPrompt: "",
      requestPayload: {},
    })
    createdLlmRunId = openingHandRun.llmRunId
    const fullPrompt = await buildStartingHandSimulationPrompt({
      llmRunId: openingHandRun.llmRunId,
    })
    const requestPayload = buildOpeningHandOpenAiRequestPayload(
      openAiConfig,
      fullPrompt,
      simulationId
    )

    await updateLlmRunRequestData({
      llmRunId: openingHandRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableOpenAiRequestPayload(requestPayload),
    })

    startOpeningHandLlmRun({
      config: openAiConfig,
      fullPrompt,
      llmRunId: openingHandRun.llmRunId,
      requestPayload,
      runtimeStreamKey: openingHandRun.runtimeStreamKey,
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
    const openAiConfig = getTurnSimulationOpenAiRunConfig()
    const turnRun = await createTurnLlmRun(deckId, {
      simulationId,
      turnNumber,
      provider: OPENAI_PROVIDER,
      model: openAiConfig.model,
      reasoningEffort: openAiConfig.reasoningEffort,
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
    const requestPayload = buildTurnSimulationOpenAiRequestPayload(
      openAiConfig,
      fullPrompt,
      simulationId,
      turnNumber
    )

    await updateLlmRunRequestData({
      llmRunId: turnRun.llmRunId,
      fullPrompt,
      requestPayload: getPersistableOpenAiRequestPayload(requestPayload),
    })

    startTurnLlmRun({
      config: openAiConfig,
      fullPrompt,
      llmRunId: turnRun.llmRunId,
      requestPayload,
      runtimeStreamKey: turnRun.runtimeStreamKey,
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
  }
}

function isBenignAutoAdvanceAbortError(error: unknown) {
  return (
    error instanceof SimulationValidationError &&
    (error.message === SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE ||
      error.message === SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE)
  )
}

function startOpeningHandLlmRun({
  config,
  fullPrompt,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
}: {
  config: OpenAiRunConfig
  fullPrompt: string
  llmRunId: string
  requestPayload: ReturnType<typeof buildOpeningHandOpenAiRequestPayload>
  runtimeStreamKey: string
}) {
  void runOpeningHandLlmRun({
    config,
    fullPrompt,
    llmRunId,
    requestPayload,
    runtimeStreamKey,
  })
}

async function runOpeningHandLlmRun({
  config,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
}: {
  config: OpenAiRunConfig
  fullPrompt: string
  llmRunId: string
  requestPayload: ReturnType<typeof buildOpeningHandOpenAiRequestPayload>
  runtimeStreamKey: string
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    nextSequence: 1,
    resolveCompletion: completion.resolveCompletion,
  }
  let outputText = ""
  let responseMetadata: unknown = {}
  let usage: unknown = {}
  let didReceiveCompletedResponse = false
  let providerTerminalEventError: ProviderTerminalEventError | null = null

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)

  try {
    await markLlmRunStreaming(llmRunId)

    const client = new OpenAI({
      apiKey: config.apiKey,
    })
    logOpenAiApiCallStarted({
      llmRunId,
      model: requestPayload.model,
      phase: "opening_hand",
    })
    const stream = await client.responses.create(requestPayload, {
      signal: runtime.abortController.signal,
    })

    for await (const event of stream) {
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
    }

    await forceFlushRuntimeChunks(runtime)

    if (providerTerminalEventError) {
      throw providerTerminalEventError
    }

    if (!didReceiveCompletedResponse) {
      throw new Error(
        "Opening-hand LLM stream ended without response.completed."
      )
    }

    logOpenAiApiCallFinished({
      llmRunId,
      model: requestPayload.model,
      phase: "opening_hand",
      usage,
    })

    const parsedOpeningHand = parseOpeningHandFromResponseText(outputText)

    const completion = await completeOpeningHandLlmRun({
      llmRunId,
      openingHand: parsedOpeningHand.keptHand,
      responseMetadata,
      usage,
    })
    await handleSimulationCompletionNextStep(completion)
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logOpenAiApiCallCancelled({
        llmRunId,
        phase: "opening_hand",
      })
      appendRuntimeChunk(runtime, createCancellationChunk())
      await tryForceFlushRuntimeChunks(runtime, "cancelled opening-hand run")
      await cancelLlmRun(llmRunId, "Opening-hand LLM run was cancelled.")
      return
    }

    const effectiveError = providerTerminalEventError ?? error

    if (!(effectiveError instanceof ProviderTerminalEventError)) {
      appendRuntimeChunk(runtime, createServerErrorChunk(effectiveError))
    }

    await tryForceFlushRuntimeChunks(runtime, "failed opening-hand run")
    logOpenAiApiCallStoppedWithError({
      error: effectiveError,
      llmRunId,
      phase: "opening_hand",
    })
    console.error("Opening-hand LLM run failed:", effectiveError)
    await failLlmRun(llmRunId, getErrorMessage(effectiveError))
  } finally {
    clearRuntimeFlushTimer(runtime)
    activeLlmRunRuntimes.delete(runtimeStreamKey)
    runtime.resolveCompletion()
  }
}

function startTurnLlmRun({
  config,
  fullPrompt,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
}: {
  config: OpenAiRunConfig
  fullPrompt: string
  llmRunId: string
  requestPayload: ReturnType<typeof buildTurnSimulationOpenAiRequestPayload>
  runtimeStreamKey: string
}) {
  void runTurnLlmRun({
    config,
    fullPrompt,
    llmRunId,
    requestPayload,
    runtimeStreamKey,
  })
}

async function runTurnLlmRun({
  config,
  llmRunId,
  requestPayload,
  runtimeStreamKey,
}: {
  config: OpenAiRunConfig
  fullPrompt: string
  llmRunId: string
  requestPayload: ReturnType<typeof buildTurnSimulationOpenAiRequestPayload>
  runtimeStreamKey: string
}) {
  const completion = createRuntimeCompletion()
  const runtime: ActiveLlmRunRuntime = {
    abortController: new AbortController(),
    chunkBuffer: [],
    completionPromise: completion.completionPromise,
    flushTimer: null,
    flushPromise: null,
    llmRunId,
    nextSequence: 1,
    resolveCompletion: completion.resolveCompletion,
  }
  let outputText = ""
  let responseMetadata: unknown = {}
  let usage: unknown = {}
  let didReceiveCompletedResponse = false
  let providerTerminalEventError: ProviderTerminalEventError | null = null

  activeLlmRunRuntimes.set(runtimeStreamKey, runtime)

  try {
    await markLlmRunStreaming(llmRunId)

    const client = new OpenAI({
      apiKey: config.apiKey,
    })
    logOpenAiApiCallStarted({
      llmRunId,
      model: requestPayload.model,
      phase: "turn",
    })
    const stream = await client.responses.create(requestPayload, {
      signal: runtime.abortController.signal,
    })

    for await (const event of stream) {
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
    }

    await forceFlushRuntimeChunks(runtime)

    if (providerTerminalEventError) {
      throw providerTerminalEventError
    }

    if (!didReceiveCompletedResponse) {
      throw new Error("Turn LLM stream ended without response.completed.")
    }

    logOpenAiApiCallFinished({
      llmRunId,
      model: requestPayload.model,
      phase: "turn",
      usage,
    })

    const parsedTurn = parseTurnSimulationFromResponseText(outputText)

    const completion = await completeTurnLlmRun({
      llmRunId,
      gameState: parsedTurn.gameState,
      responseMetadata,
      usage,
    })
    await handleSimulationCompletionNextStep(completion)
  } catch (error) {
    if (isAbortError(error) || runtime.abortController.signal.aborted) {
      logOpenAiApiCallCancelled({
        llmRunId,
        phase: "turn",
      })
      appendRuntimeChunk(
        runtime,
        createCancellationChunk("Turn LLM run was cancelled.")
      )
      await tryForceFlushRuntimeChunks(runtime, "cancelled turn run")
      await cancelLlmRun(llmRunId, "Turn LLM run was cancelled.")
      return
    }

    const effectiveError = providerTerminalEventError ?? error

    if (!(effectiveError instanceof ProviderTerminalEventError)) {
      appendRuntimeChunk(runtime, createServerErrorChunk(effectiveError))
    }

    await tryForceFlushRuntimeChunks(runtime, "failed turn run")
    logOpenAiApiCallStoppedWithError({
      error: effectiveError,
      llmRunId,
      phase: "turn",
    })
    console.error("Turn LLM run failed:", effectiveError)
    await failLlmRun(llmRunId, getErrorMessage(effectiveError))
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
  runtime.chunkBuffer.push({
    ...chunk,
    sequence: runtime.nextSequence,
  })
  runtime.nextSequence += 1
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
        const simulation = await createSimulation(deckId, parsedSimulation.data)
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

        if (error instanceof OpenAiConfigurationError) {
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

        if (error instanceof OpenAiConfigurationError) {
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

        if (error instanceof OpenAiConfigurationError) {
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
  return path === OPENING_HAND_MCP_PATH || path === TURN_SIMULATION_MCP_PATH
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

LLM Run ID: ${llmRunId}
Use this exact tool identifier shape: { "llmRunId": "${llmRunId}" }

${commanderLabel}:
${commanderNames.join("\n")}

Decklist:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${formatCardText(card)}\n`).join("\n")}
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

LLM Run ID: ${llmRunId}
Use this exact tool identifier shape: { "llmRunId": "${llmRunId}" }

===Start Game State===

${resolvedGameState}

===End Game State===

Cards in library. Not actual order of library. Use tools to interact with library:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${formatCardText(card)}\n`).join("\n")}

${GENERIC_GAME_RULES_REFERENCE}
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
