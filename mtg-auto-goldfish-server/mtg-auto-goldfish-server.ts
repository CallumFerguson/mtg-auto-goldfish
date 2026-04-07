import "dotenv/config"

import type { Request, Response } from "express"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"

import {
  GameStore,
  type AppendSimulationEventInput,
  type GameCard,
  type SimulationRunKind,
} from "./game-store.js"
import {
  createPostgresPool,
  getRequiredDatabaseUrl,
  initializePostgres,
} from "./postgres.js"
import {
  createPromptProcessor,
  normalizePromptProcessorProvider,
  type PromptProcessingResult,
  type PromptProcessorOptions,
  type PromptProcessorProvider,
  type PromptStreamEvent,
} from "./llm/index.js"
import {
  DRAW_STARTING_HAND_PROMPT,
  SIMULATE_TURN_PROMPT,
  GENERIC_GAME_RULES_REFERENCE,
} from "./llm/prompt-constants.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3001
const SERVER_NAME = "mtg-auto-goldfish-server"
const OPENING_HAND_SERVER_NAME = "opening-hand-server"
const TURN_SIMULATION_SERVER_NAME = "turn-simulation-server"
const OPENING_HAND_MCP_PATH = "/mcp/opening-hand"
const TURN_SIMULATION_MCP_PATH = "/mcp/turn-simulation"
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
const GAME_NOT_FOUND_MESSAGE =
  "Game not found. It may be invalid or may not have been created yet."
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 8192
const DEFAULT_PROMPT_LOG_DIRECTORY = resolve(
  process.cwd(),
  "mtg-auto-goldfish-server",
  "prompt-logs"
)
const SHOULD_LOG_PROMPTS_TO_FILE =
  process.env.LOG_PROMPTS_TO_FILE?.trim().toLowerCase() === "true"
const SIMULATION_EVENT_BATCH_SIZE = 1000
const SIMULATION_EVENT_FLUSH_INTERVAL_MS = 1000

type ToolUiDataRecord = {
  structuredContent?: Record<string, unknown>
  uiMetadata?: Record<string, unknown>
}

type TurnActionLog = {
  turnNumber: number
  actions: string[]
}

type SimulationEventRecorderOptions = {
  simulationRunId: string
  gameId: string
  kind: SimulationRunKind
  turnNumber?: number
}

let gameStore!: GameStore
const toolUiDataStore = new Map<string, ToolUiDataRecord[]>()
const turnActionLogStore = new Map<string, TurnActionLog>()
const gameCardSchema = z.object({
  name: z.string().trim().min(1).describe("The card name."),
  cardText: z
    .string()
    .trim()
    .min(1)
    .describe("The gameplay-relevant card text."),
})
const processPromptSchema = z.object({
  prompt: z.string().trim().min(1).describe("The prompt to run locally."),
})
const simulateDrawingStartingHandSchema = z.object({
  gameId: z.string().trim().min(1).describe("The game ID to simulate."),
})
const simulateTurnSchema = z.object({
  gameId: z.string().trim().min(1).describe("The game ID to simulate."),
})
const toolUiDataLookupSchema = z.object({
  toolName: z.string().trim().min(1).describe("The tool name."),
  gameId: z.string().trim().min(1).describe("The game ID."),
})
const openingHandSnapshotStatusSchema = z.object({
  gameId: z.string().trim().min(1).describe("The game ID."),
})
const resetGameStateSchema = z
  .object({
    gameId: z.string().trim().min(1).describe("The game ID."),
    target: z
      .enum(["initial", "opening_hand_snapshot", "turn_snapshot"])
      .describe("Which saved point-in-time state to restore."),
    turnNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The turn snapshot to restore when target is turn_snapshot."),
  })
  .superRefine((value, context) => {
    if (value.target === "turn_snapshot" && value.turnNumber === undefined) {
      context.addIssue({
        code: "custom",
        path: ["turnNumber"],
        message: "turnNumber is required when target is turn_snapshot.",
      })
    }
  })
const createGameSchema = z
  .object({
    commanders: z
      .array(gameCardSchema)
      .min(1)
      .max(2)
      .describe("The commander or partner pair for this game."),
    deck: z
      .array(gameCardSchema)
      .describe("The main-deck cards for this game."),
    seed: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Optional deterministic seed for library shuffling."),
  })
  .superRefine((value, context) => {
    const expectedDeckSize = value.commanders.length === 1 ? 99 : 98

    if (value.deck.length !== expectedDeckSize) {
      context.addIssue({
        code: "custom",
        path: ["deck"],
        message: `Deck must contain exactly ${expectedDeckSize} cards when there ${value.commanders.length === 1 ? "is 1 commander" : "are 2 commanders"}.`,
      })
    }
  })

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

function createOpeningHandServer() {
  return createServer(OPENING_HAND_SERVER_NAME, (server) => {
    registerDrawStartingHandTool(server)
    registerMulliganTool(server)
    registerKeepHandTool(server)
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
    registerUpdateGameStateTool(server)
  })
}

function registerDrawCardFromTopTool(server: McpServer) {
  server.registerTool(
    "draw_card_from_top",
    {
      title: "Draw Card From Top",
      description:
        "Draw one or more cards from the top of the stored library for an existing game ID that was created outside MCP.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        count: z.number().int().positive().describe("How many cards to draw."),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const drawResult = await gameStore.drawCardsFromTop(gameId, count)

      if (!drawResult.ok) {
        logWarn("draw_top", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? GAME_NOT_FOUND_MESSAGE
            : "That game has no cards left in its library."

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cards: drawResult.cards,
        cardsRemaining: drawResult.cardsRemaining,
      }

      storeToolUiData("draw_card_from_top", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "draw_top",
        `${shortId(gameId)} n=${response.cards.length} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Drew ${response.cards.length} card(s) from the top: ${formatCardList(response.cards)}. ${response.cardsRemaining} cards remain in the library.`,
          },
        ],
        structuredContent: response,
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
        "Draw one or more cards from the bottom of the stored library for an existing game ID that was created outside MCP.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        count: z.number().int().positive().describe("How many cards to draw."),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const drawResult = await gameStore.drawCardsFromBottom(gameId, count)

      if (!drawResult.ok) {
        logWarn("draw_bottom", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? GAME_NOT_FOUND_MESSAGE
            : "That game has no cards left in its library."

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cards: drawResult.cards,
        cardsRemaining: drawResult.cardsRemaining,
      }

      storeToolUiData("draw_card_from_bottom", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "draw_bottom",
        `${shortId(gameId)} n=${response.cards.length} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Drew ${response.cards.length} card(s) from the bottom: ${formatCardList(response.cards)}. ${response.cardsRemaining} cards remain in the library.`,
          },
        ],
        structuredContent: response,
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
        "Draw the very first opening seven-card hand from the stored library for an existing game ID that was created outside MCP. Call this exactly once per game, before any mulligans. Never call this after mulligan, because mulligan already shuffles and draws the replacement seven-card hand.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId }) => {
      const drawResult = await gameStore.drawStartingHand(gameId)

      if (!drawResult.ok) {
        logWarn("draw_starting_hand", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? GAME_NOT_FOUND_MESSAGE
            : "An opening hand is already active for that game. Do not call draw_starting_hand again. If you took a mulligan, use the seven-card hand returned by mulligan."

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cards: drawResult.cards,
        cardsRemaining: drawResult.cardsRemaining,
      }
      storeToolUiData("draw_starting_hand", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "draw_starting_hand",
        `${shortId(gameId)} n=${response.cards.length} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Drew starting hand: ${formatCardList(response.cards)}. ${response.cardsRemaining} cards remain in the library. This tool is only for the very first opening hand.`,
          },
        ],
        structuredContent: response,
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
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        reason: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A short explanation of why this hand is being mulliganed."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        reason: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
        mulliganCount: z.number().int().positive(),
        cardsToBottomIfKept: z.number().int().nonnegative(),
        reminder: z.string(),
        replacesPreviousOpeningHand: z.boolean(),
        alreadyDrewReplacementHand: z.boolean(),
      },
    },
    async ({ gameId, reason }) => {
      const mulliganResult = await gameStore.mulligan(gameId)

      if (!mulliganResult.ok) {
        logWarn("mulligan", `${shortId(gameId)} ${mulliganResult.reason}`)

        const message =
          mulliganResult.reason === "game_not_found"
            ? GAME_NOT_FOUND_MESSAGE
            : "You can only mulligan after drawing your starting hand."

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const reminder = formatMulliganReminder(
        mulliganResult.mulliganCount,
        mulliganResult.cardsToBottomIfKept
      )
      const response = {
        gameId,
        reason,
        cards: mulliganResult.cards,
        cardsRemaining: mulliganResult.cardsRemaining,
        mulliganCount: mulliganResult.mulliganCount,
        cardsToBottomIfKept: mulliganResult.cardsToBottomIfKept,
        reminder,
        replacesPreviousOpeningHand: true,
        alreadyDrewReplacementHand: true,
      }

      storeToolUiData("mulligan", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "mulligan",
        `${shortId(gameId)} n=${response.cards.length} mulligans=${response.mulliganCount} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Mulligan reason: ${response.reason}. Mulliganed into: ${formatCardList(response.cards)}. ${response.cardsRemaining} cards remain in the library. ${response.reminder} This is your new opening hand already; do not call draw_starting_hand again.`,
          },
        ],
        structuredContent: response,
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
        "Return a card to the library for an existing game ID, placing it a specific number of cards from the top or bottom.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
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
      outputSchema: {
        gameId: z.string(),
        card: z.string(),
        side: z.enum(["top", "bottom"]),
        position: z.number().int().nonnegative(),
        insertedFromTop: z.number().int().nonnegative(),
        insertedFromBottom: z.number().int().nonnegative(),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, card, side, position }) => {
      const returnResult = await gameStore.returnCardToLibrary(
        gameId,
        card,
        side,
        position
      )

      if (!returnResult.ok) {
        logWarn(
          "return_to_library",
          `${shortId(gameId)} ${returnResult.reason}`
        )

        return {
          content: [
            {
              type: "text",
              text: GAME_NOT_FOUND_MESSAGE,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        card,
        side,
        position,
        insertedFromTop: returnResult.insertedFromTop,
        insertedFromBottom: returnResult.insertedFromBottom,
        cardsRemaining: returnResult.cardsRemaining,
      }

      storeToolUiData("return_card_to_library", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "return_to_library",
        `${shortId(gameId)} ${card} side=${side} requested=${position} top=${response.insertedFromTop} bottom=${response.insertedFromBottom} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Returned ${JSON.stringify(card)} to the library ${response.insertedFromTop} card(s) from the top and ${response.insertedFromBottom} card(s) from the bottom. ${response.cardsRemaining} cards are now in the library.`,
          },
        ],
        structuredContent: response,
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
        "Return multiple cards to the top or bottom of the library for an existing game ID, optionally randomizing the order they are returned in.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
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
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        side: z.enum(["top", "bottom"]),
        randomizeOrder: z.boolean(),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, cards, side, randomizeOrder }) => {
      const returnResult = await gameStore.returnCardsToLibrary(
        gameId,
        cards,
        side,
        randomizeOrder
      )

      if (!returnResult.ok) {
        logWarn(
          "return_cards_to_library",
          `${shortId(gameId)} ${returnResult.reason}`
        )

        return {
          content: [
            {
              type: "text",
              text: GAME_NOT_FOUND_MESSAGE,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cards: returnResult.cards,
        side,
        randomizeOrder,
        cardsRemaining: returnResult.cardsRemaining,
      }

      storeToolUiData("return_cards_to_library", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "return_cards_to_library",
        `${shortId(gameId)} n=${response.cards.length} side=${side} randomized=${randomizeOrder} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Returned ${response.cards.length} card(s) to the ${side} of the library${randomizeOrder ? " in randomized order" : " in the provided order"}: ${formatCardList(response.cards)}. ${response.cardsRemaining} cards are now in the library.`,
          },
        ],
        structuredContent: response,
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
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The card names to remove from the library. Each request is matched independently against the current remaining library."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        matches: z.array(
          z.object({
            requestedCard: z.string(),
            foundCard: z.string().nullable(),
          })
        ),
        foundCards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, cards }) => {
      const takeResult = await gameStore.takeCardsFromLibrary(gameId, cards)

      if (!takeResult.ok) {
        logWarn(
          "take_cards_from_library",
          `${shortId(gameId)} ${takeResult.reason}`
        )

        return {
          content: [
            {
              type: "text",
              text: GAME_NOT_FOUND_MESSAGE,
            },
          ],
          isError: true,
        }
      }

      const foundCards = takeResult.matches.flatMap((match) =>
        match.foundCard ? [match.foundCard] : []
      )
      const missedCards = takeResult.matches
        .filter((match) => match.foundCard === null)
        .map((match) => match.requestedCard)
      const response = {
        gameId,
        matches: takeResult.matches,
        foundCards,
        cardsRemaining: takeResult.cardsRemaining,
      }

      storeToolUiData("take_cards_from_library", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "take_cards_from_library",
        `${shortId(gameId)} requested=${cards.length} found=${foundCards.length} missed=${missedCards.length} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text:
              foundCards.length > 0 || missedCards.length > 0
                ? `Took ${foundCards.length} requested card(s) from the library: ${foundCards.length > 0 ? formatCardList(foundCards) : "none"}. ${missedCards.length > 0 ? `No reasonably close library match was found for: ${formatCardList(missedCards)}. ` : ""}${response.cardsRemaining} cards remain in the library.`
                : `No cards were taken from the library. ${response.cardsRemaining} cards remain in the library.`,
          },
        ],
        structuredContent: response,
      }
    }
  )
}

function registerShuffleLibraryTool(server: McpServer) {
  server.registerTool(
    "shuffle_library",
    {
      title: "Shuffle Library",
      description:
        "Shuffle the stored library for an existing game ID that was created outside MCP.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId }) => {
      const shuffleResult = await gameStore.shuffleLibrary(gameId)

      if (!shuffleResult.ok) {
        logWarn("shuffle_library", `${shortId(gameId)} ${shuffleResult.reason}`)

        return {
          content: [
            {
              type: "text",
              text: GAME_NOT_FOUND_MESSAGE,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cardsRemaining: shuffleResult.cardsRemaining,
      }

      storeToolUiData("shuffle_library", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "shuffle_library",
        `${shortId(gameId)} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Shuffled the library. ${response.cardsRemaining} cards remain in the library.`,
          },
        ],
        structuredContent: response,
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
        "Append an irreversible action note to the active turn log for this game. Use this as the authoritative turn history while resolving the turn. The response returns the full logged action list for the active turn.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        action: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A concise description of the action being committed, such as a phase change, land play, spell cast, attack, or other turn progression."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        turnNumber: z.number().int().positive(),
        latestAction: z.string(),
        actions: z.array(z.string()),
      },
    },
    async ({ gameId, action }) => {
      const activeTurnInfo = await gameStore.getActiveTurnSimulation(gameId)

      if (!activeTurnInfo.ok) {
        logWarn("log_turn_action", `${shortId(gameId)} ${activeTurnInfo.reason}`)

        const message =
          activeTurnInfo.reason === "no_active_turn_simulation"
            ? "There is no active turn simulation for that game. Only call log_turn_action while resolving the current turn."
            : GAME_NOT_FOUND_MESSAGE

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const existingLog = turnActionLogStore.get(gameId)
      const turnLog =
        existingLog && existingLog.turnNumber === activeTurnInfo.turnNumber
          ? existingLog
          : {
              turnNumber: activeTurnInfo.turnNumber,
              actions: [],
            }

      const response = {
        gameId,
        turnNumber: turnLog.turnNumber,
        latestAction: action,
        actions: [...turnLog.actions, action],
      }

      turnActionLogStore.set(gameId, {
        turnNumber: turnLog.turnNumber,
        actions: response.actions,
      })

      storeToolUiData("log_turn_action", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "log_turn_action",
        `${shortId(gameId)} turn=${response.turnNumber} count=${response.actions.length}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Logged action for turn ${response.turnNumber}: ${JSON.stringify(response.latestAction)}. Locked actions so far: ${response.actions.map((loggedAction, index) => `${index + 1}. ${loggedAction}`).join(" | ")}`,
          },
        ],
        structuredContent: response,
      }
    }
  )
}

function registerUpdateGameStateTool(server: McpServer) {
  server.registerTool(
    "update_game_state",
    {
      title: "Update Game State",
      description:
        "Save the current game state text for the active turn simulation. This can only be called once per turn, and it must be the final tool call for that turn.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        gameState: z
          .string()
          .describe(
            "The full end-of-turn game state string in any format the model chooses."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        turnNumber: z.number().int().positive(),
        nextTurnNumber: z.number().int().positive(),
        gameState: z.string(),
        updated: z.literal(true),
      },
    },
    async ({ gameId, gameState }) => {
      const updateResult = await gameStore.updateGameState(gameId, gameState)

      if (!updateResult.ok) {
        logWarn(
          "update_game_state",
          `${shortId(gameId)} ${updateResult.reason}`
        )

        const message =
          updateResult.reason === "turn_already_updated"
            ? "update_game_state has already been called for this turn. Do not call it more than once."
            : updateResult.reason === "no_active_turn_simulation"
              ? "There is no active turn simulation for that game. Only call update_game_state while resolving the current turn."
              : GAME_NOT_FOUND_MESSAGE

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        turnNumber: updateResult.turnNumber,
        nextTurnNumber: updateResult.nextTurnNumber,
        gameState: updateResult.gameState,
        updated: true as const,
      }

      storeToolUiData("update_game_state", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo(
        "update_game_state",
        `${shortId(gameId)} turn=${response.turnNumber} next=${response.nextTurnNumber} len=${response.gameState.length}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Saved updated game state for turn ${response.turnNumber}. The next turn is ${response.nextTurnNumber}.`,
          },
        ],
        structuredContent: response,
      }
    }
  )
}
function registerKeepHandTool(server: McpServer) {
  server.registerTool(
    "keep_hand",
    {
      title: "Keep Hand",
      description:
        "Confirm the final opening hand after all mulligans and any bottoming decisions are complete. Call this exactly once, after you have fully decided to keep and after any required bottoming has already happened.",
      inputSchema: {
        gameId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
          ),
        cards: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            "The exact cards in the final kept opening hand after all mulligans and any cards bottomed to the library."
          ),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        kept: z.literal(true),
      },
    },
    async ({ gameId, cards }) => {
      const gamePromptContext = await gameStore.getGamePromptContext(gameId)

      if (!gamePromptContext.ok) {
        logWarn("keep_hand", `${shortId(gameId)} ${gamePromptContext.reason}`)

        return {
          content: [
            {
              type: "text",
              text: GAME_NOT_FOUND_MESSAGE,
            },
          ],
          isError: true,
        }
      }

      const response = {
        gameId,
        cards,
        kept: true as const,
      }

      storeToolUiData("keep_hand", gameId, {
        structuredContent: response,
        uiMetadata: {},
      })

      logInfo("keep_hand", `${shortId(gameId)} n=${cards.length}`)

      return {
        content: [
          {
            type: "text",
            text: `Kept opening hand: ${formatCardList(cards)}.`,
          },
        ],
        structuredContent: response,
      }
    }
  )
}
async function main() {
  const host = process.env.HOST ?? DEFAULT_HOST
  const port = getPort(process.env.PORT)
  const postgresPool = createPostgresPool(getRequiredDatabaseUrl())

  await initializePostgres(postgresPool)
  gameStore = new GameStore(postgresPool)

  const app = createMcpExpressApp({ host })
  const allowedOrigins = getAllowedOrigins(process.env.ALLOWED_ORIGINS)
  const llmProvider = normalizePromptProcessorProvider(process.env.LLM_PROVIDER)
  const sharedPromptProcessorOptions = getPromptProcessorOptions(llmProvider)
  const processPromptProcessor = createPromptProcessor(
    sharedPromptProcessorOptions
  )
  const openingHandPromptProcessor = createPromptProcessor({
    ...sharedPromptProcessorOptions,
    mcpServerUrl: resolveMcpServerUrl(
      llmProvider,
      process.env.GOLDFISH_OPENING_HAND_MCP_SERVER_URL,
      getLocalMcpServerUrl(host, port, OPENING_HAND_MCP_PATH),
      "GOLDFISH_OPENING_HAND_MCP_SERVER_URL"
    ),
    mcpServerLabel: OPENING_HAND_SERVER_NAME,
  })
  const turnSimulationPromptProcessor = createPromptProcessor({
    ...sharedPromptProcessorOptions,
    mcpServerUrl: resolveMcpServerUrl(
      llmProvider,
      process.env.GOLDFISH_TURN_SIMULATION_MCP_SERVER_URL,
      getLocalMcpServerUrl(host, port, TURN_SIMULATION_MCP_PATH),
      "GOLDFISH_TURN_SIMULATION_MCP_SERVER_URL"
    ),
    mcpServerLabel: TURN_SIMULATION_SERVER_NAME,
  })

  app.use((req: Request, res: Response, next) => {
    applyCors(req, res, allowedOrigins)

    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }

    next()
  })

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: SERVER_NAME,
    })
  })

  app.post("/games", async (req: Request, res: Response) => {
    const parsedRequest = createGameSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    try {
      const game = await gameStore.createGame(
        parsedRequest.data.commanders,
        parsedRequest.data.deck,
        parsedRequest.data.seed
      )

      logInfo(
        "new",
        `${shortId(game.gameId)} seed=${game.seed} commanders=${game.commanderCount} cards=${game.cardsRemaining} games=${game.totalGames}`
      )

      res.status(201).json(game)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create a game."

      logWarn("new", message)
      res.status(500).json({
        error: message,
      })
    }
  })

  app.post("/tool-ui-data", async (req: Request, res: Response) => {
    const parsedRequest = toolUiDataLookupSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    if (!(await gameStore.hasGame(parsedRequest.data.gameId))) {
      deleteToolUiDataForGame(parsedRequest.data.gameId)
      res.status(404).json({
        error: GAME_NOT_FOUND_MESSAGE,
      })
      return
    }

    const toolUiData = takeToolUiData(
      parsedRequest.data.toolName,
      parsedRequest.data.gameId
    )

    if (!toolUiData) {
      res.status(404).json({
        error: "No tool UI data was found for that tool call.",
      })
      return
    }

    res.status(200).json(toolUiData)
  })

  app.post("/opening-hand-snapshot-status", async (req: Request, res: Response) => {
    const parsedRequest = openingHandSnapshotStatusSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const snapshotStatus = await gameStore.getOpeningHandSnapshotStatus(
      parsedRequest.data.gameId
    )

    if (!snapshotStatus.ok) {
      res.status(404).json({
        error: GAME_NOT_FOUND_MESSAGE,
      })
      return
    }

    res.status(200).json(snapshotStatus)
  })

  app.post("/reset-game-state", async (req: Request, res: Response) => {
    const parsedRequest = resetGameStateSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const { gameId, target, turnNumber } = parsedRequest.data
    const resetResult =
      target === "initial"
        ? await gameStore.resetGameToInitialState(gameId)
        : target === "opening_hand_snapshot"
          ? await gameStore.restoreOpeningHandSnapshot(gameId)
          : await gameStore.restoreTurnSnapshot(gameId, turnNumber!)

    if (!resetResult.ok) {
      const error =
        resetResult.reason === "opening_hand_snapshot_not_found"
          ? "No saved opening-hand snapshot was found for that game."
          : resetResult.reason === "turn_snapshot_not_found"
            ? `No saved turn snapshot was found for turn ${turnNumber}.`
            : GAME_NOT_FOUND_MESSAGE

      res.status(404).json({ error })
      return
    }

    logInfo(
      "reset_game_state",
      `${shortId(gameId)} target=${target}${typeof turnNumber === "number" ? ` turn=${turnNumber}` : ""} cards=${resetResult.cardsRemaining}`
    )

    res.status(200).json({
      target,
      ...(typeof turnNumber === "number" ? { turnNumber } : {}),
      ...resetResult,
    })
  })

  app.post("/process-prompt", async (req: Request, res: Response) => {
    const parsedRequest = processPromptSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const { prompt } = parsedRequest.data

    try {
      const response = await streamPromptResponse(
        res,
        processPromptProcessor,
        prompt
      )

      logInfo(
        "prompt",
        `len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes} ${formatPromptMetrics(response)}`
      )

      res.end()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process prompt."

      logWarn("prompt", message)

      if (res.headersSent) {
        res.write(
          `${JSON.stringify({
            type: "error",
            error: message,
          })}\n`
        )
        res.end()
        return
      }

      res.status(502).json({
        error: message,
      })
    }
  })

  app.post(
    "/simulate-drawing-starting-hand",
    async (req: Request, res: Response) => {
      const parsedRequest = simulateDrawingStartingHandSchema.safeParse(
        req.body
      )

      if (!parsedRequest.success) {
        res.status(400).json({
          error: "Invalid request body.",
          details: parsedRequest.error.issues,
        })
        return
      }

      const { gameId } = parsedRequest.data
      const gamePromptContext = await gameStore.getGamePromptContext(gameId)

      if (!gamePromptContext.ok) {
        res.status(404).json({
          error: GAME_NOT_FOUND_MESSAGE,
        })
        return
      }

      const prompt = buildStartingHandSimulationPrompt(
        gamePromptContext.gameId,
        gamePromptContext.commanders,
        gamePromptContext.initialLibrary
      )
      const simulationRun = await gameStore.createSimulationRun({
        gameId,
        kind: "opening_hand",
        promptText: prompt,
        provider: llmProvider,
      })
      const simulationEventRecorder = new SimulationEventRecorder({
        simulationRunId: simulationRun.simulationRunId,
        gameId,
        kind: "opening_hand",
      })

      try {
        await writePromptLog(gameId, "opening-hand", prompt)

        let keptHandCards: string[] | undefined
        const response = await streamPromptResponse(
          res,
          openingHandPromptProcessor,
          prompt,
          (event) => {
            simulationEventRecorder.recordEvent(event)
            keptHandCards =
              getKeepHandCardsFromPromptEvent(event) ?? keptHandCards
          }
        )

        if (!keptHandCards?.length) {
          throw new Error(
            "The opening-hand simulation did not report a final kept hand through keep_hand."
          )
        }

        const snapshotResult = await gameStore.saveOpeningHandSnapshot(
          gameId,
          keptHandCards
        )

        if (!snapshotResult.ok) {
          throw new Error(GAME_NOT_FOUND_MESSAGE)
        }

        logInfo(
          "simulate_starting_hand",
          `${shortId(gameId)} hand=${snapshotResult.startingHand.length} library=${snapshotResult.library.length} valid=${snapshotResult.validation.isValid} len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes} ${formatPromptMetrics(response)}`
        )

        await simulationEventRecorder.complete(response)
        res.end()
      } catch (error) {
        await simulationEventRecorder.fail(error)
        const message =
          error instanceof Error ? error.message : "Failed to process prompt."

        logWarn("simulate_starting_hand", `${shortId(gameId)} ${message}`)

        if (res.headersSent) {
          res.write(
            `${JSON.stringify({
              type: "error",
              error: message,
            })}\n`
          )
          res.end()
          return
        }

        res.status(502).json({
          error: message,
        })
      }
    }
  )

  app.post("/simulate-turn", async (req: Request, res: Response) => {
    const parsedRequest = simulateTurnSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const { gameId } = parsedRequest.data
    const gamePromptContext = await gameStore.getGamePromptContext(gameId)

    if (!gamePromptContext.ok) {
      res.status(404).json({
        error: GAME_NOT_FOUND_MESSAGE,
      })
      return
    }

    const resolvedStartingHand =
      gamePromptContext.openingHandSnapshot?.startingHand

    if (!resolvedStartingHand?.length) {
      res.status(400).json({
        error:
          "No saved opening-hand snapshot was found for that game. Run the opening-hand simulation first.",
      })
      return
    }

    const snapshotValidation = gamePromptContext.openingHandSnapshot?.validation

    if (!snapshotValidation?.isValid) {
      res.status(400).json({
        error:
          snapshotValidation?.message ??
          "The saved opening-hand snapshot is invalid.",
      })
      return
    }

    const startTurnResult = await gameStore.startTurnSimulation(gameId)

    if (!startTurnResult.ok) {
      res
        .status(
          startTurnResult.reason === "turn_simulation_already_active"
            ? 409
            : 404
        )
        .json({
          error:
            startTurnResult.reason === "turn_simulation_already_active"
              ? "A turn simulation is already active for that game."
              : GAME_NOT_FOUND_MESSAGE,
        })
      return
    }

    initializeTurnActionLog(gameId, startTurnResult.turnNumber)

    const prompt = buildTurnSimulationPrompt(
      gamePromptContext.gameId,
      startTurnResult.turnNumber,
      resolvedStartingHand,
      gamePromptContext.commanders,
      gamePromptContext.currentLibrary,
      gamePromptContext.initialLibrary,
      gamePromptContext.currentGameState
    )
    const simulationRun = await gameStore.createSimulationRun({
      gameId,
      kind: "turn",
      turnNumber: startTurnResult.turnNumber,
      promptText: prompt,
      provider: llmProvider,
    })
    const simulationEventRecorder = new SimulationEventRecorder({
      simulationRunId: simulationRun.simulationRunId,
      gameId,
      kind: "turn",
      turnNumber: startTurnResult.turnNumber,
    })

    try {
      await writePromptLog(gameId, `turn-${startTurnResult.turnNumber}`, prompt)

      const response = await streamPromptResponse(
        res,
        turnSimulationPromptProcessor,
        prompt,
        (event) => {
          simulationEventRecorder.recordEvent(event)
        }
      )

      logInfo(
        "simulate_turn",
        `${shortId(gameId)} turn=${startTurnResult.turnNumber} hand=${resolvedStartingHand.length} len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes} ${formatPromptMetrics(response)}`
      )

      await simulationEventRecorder.complete(response)
      res.end()
    } catch (error) {
      await simulationEventRecorder.fail(error)
      const message =
        error instanceof Error ? error.message : "Failed to process prompt."

      logWarn("simulate_turn", `${shortId(gameId)} ${message}`)

      if (res.headersSent) {
        res.write(
          `${JSON.stringify({
            type: "error",
            error: message,
          })}\n`
        )
        res.end()
        return
      }

      res.status(502).json({
        error: message,
      })
    } finally {
      const endTurnResult = await gameStore.endTurnSimulation(gameId)
      deleteTurnActionLog(gameId)

      if (!endTurnResult.ok) {
        logWarn("simulate_turn", `${shortId(gameId)} ${endTurnResult.reason}`)
      } else if (!endTurnResult.turnWasUpdated) {
        logWarn(
          "simulate_turn",
          `${shortId(gameId)} turn=${endTurnResult.turnNumber ?? startTurnResult.turnNumber} ended_without_update_game_state`
        )
      }
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

function getPort(rawPort: string | undefined) {
  if (!rawPort) {
    return DEFAULT_PORT
  }

  const parsedPort = Number.parseInt(rawPort, 10)

  if (Number.isNaN(parsedPort) || parsedPort <= 0) {
    throw new Error(`Invalid PORT value: ${rawPort}`)
  }

  return parsedPort
}

function getAllowedOrigins(rawOrigins: string | undefined) {
  if (!rawOrigins?.trim()) {
    return DEFAULT_ALLOWED_ORIGINS
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function getPromptProcessorOptions(
  provider: PromptProcessorProvider
): PromptProcessorOptions {
  const model = getProviderModel(provider)

  return {
    provider,
    baseUrl: getProviderBaseUrl(provider),
    apiToken: getProviderApiToken(provider),
    apiKey: getProviderApiKey(provider),
    model,
    maxOutputTokens:
      getOptionalPositiveInteger(process.env.LLM_MAX_OUTPUT_TOKENS) ??
      DEFAULT_LLM_MAX_OUTPUT_TOKENS,
    reasoningEffort: getProviderReasoningEffort(provider, model),
    reasoningSummary: getProviderReasoningSummary(provider),
  }
}

function getProviderReasoningEffort(
  provider: PromptProcessorProvider,
  _model: string | undefined
) {
  switch (provider) {
    case "llama.cpp":
      return undefined
    case "openai":
      return process.env.OPENAI_REASONING_EFFORT?.trim() || "medium"
    case "claude":
      return process.env.CLAUDE_REASONING_EFFORT?.trim() || "medium"
    case "gemini":
      return process.env.GEMINI_THINKING_LEVEL?.trim() || undefined
    case "lm-studio":
    default:
      return undefined
  }
}

function getProviderReasoningSummary(provider: PromptProcessorProvider) {
  switch (provider) {
    case "llama.cpp":
      return undefined
    case "openai": {
      const configuredSummary = process.env.OPENAI_REASONING_SUMMARY?.trim()

      if (!configuredSummary) {
        return undefined
      }

      if (configuredSummary.toLowerCase() === "off") {
        return undefined
      }

      return configuredSummary
    }
    case "claude":
    case "gemini":
    case "lm-studio":
    default:
      return undefined
  }
}
function getProviderBaseUrl(provider: PromptProcessorProvider) {
  switch (provider) {
    case "llama.cpp":
      return process.env.LLAMA_CPP_BASE_URL?.trim() || undefined
    case "openai":
      return undefined
    case "claude":
      return undefined
    case "gemini":
      return process.env.GEMINI_BASE_URL?.trim() || undefined
    case "lm-studio":
    default:
      return process.env.LM_STUDIO_BASE_URL?.trim() || undefined
  }
}

function getProviderApiToken(provider: PromptProcessorProvider) {
  if (provider !== "lm-studio") {
    return undefined
  }

  return process.env.LM_STUDIO_API_TOKEN?.trim() || undefined
}

function getProviderApiKey(provider: PromptProcessorProvider) {
  switch (provider) {
    case "llama.cpp":
      return process.env.LLAMA_CPP_API_KEY?.trim() || undefined
    case "openai":
      return requireNonEmptyEnvValue("OPENAI_API_KEY")
    case "claude":
      return requireNonEmptyEnvValue("CLAUDE_API_KEY")
    case "gemini":
      return requireNonEmptyEnvValue("GEMINI_API_KEY")
    case "lm-studio":
    default:
      return process.env.LM_STUDIO_API_TOKEN?.trim() || undefined
  }
}

function getProviderModel(provider: PromptProcessorProvider) {
  switch (provider) {
    case "llama.cpp":
      return undefined
    case "openai":
      return requireNonEmptyEnvValue("OPENAI_MODEL")
    case "claude":
      return requireNonEmptyEnvValue("CLAUDE_MODEL")
    case "gemini":
      return requireNonEmptyEnvValue("GEMINI_MODEL")
    case "lm-studio":
    default:
      return process.env.LM_STUDIO_MODEL?.trim() || undefined
  }
}
function resolveMcpServerUrl(
  provider: PromptProcessorProvider,
  configuredUrl: string | undefined,
  localUrl: string,
  envName: string
) {
  if (provider === "lm-studio" || provider === "llama.cpp") {
    return localUrl
  }

  const trimmedUrl = configuredUrl?.trim()

  if (!trimmedUrl) {
    throw new Error(
      `${envName} must be set to a public HTTPS URL when LLM_PROVIDER=${provider}.`
    )
  }

  if (!isHttpsUrl(trimmedUrl)) {
    throw new Error(
      `${envName} must use https:// when LLM_PROVIDER=${provider}. Received: ${trimmedUrl}`
    )
  }

  return trimmedUrl
}

function requireNonEmptyEnvValue(envName: string) {
  const value = process.env[envName]?.trim()

  if (!value) {
    throw new Error(`${envName} is required.`)
  }

  return value
}

function getOptionalPositiveInteger(value: string | undefined) {
  if (!value?.trim()) {
    return undefined
  }

  const parsedValue = Number.parseInt(value, 10)

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `Expected a positive integer but received ${JSON.stringify(value)}.`
    )
  }

  return parsedValue
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
function getLocalMcpServerUrl(host: string, port: number, path: string) {
  return `http://${normalizeLocalHost(host)}:${port}${path}`
}

function normalizeLocalHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1"
  }

  return host
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

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader(
    "Access-Control-Allow-Headers",
    getAllowedRequestHeaders(req.headers["access-control-request-headers"])
  )
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]) {
  return allowedOrigins.includes(origin) || isLoopbackOrigin(origin)
}

function isLoopbackOrigin(origin: string) {
  try {
    const parsedOrigin = new URL(origin)

    return (
      parsedOrigin.protocol === "http:" &&
      (parsedOrigin.hostname === "localhost" ||
        parsedOrigin.hostname === "127.0.0.1")
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

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)

    res.on("close", () => {
      void transport.close()
      void server.close()
    })
  } catch (error) {
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

class SimulationEventRecorder {
  private readonly simulationRunId: string
  private readonly gameId: string
  private readonly kind: SimulationRunKind
  private readonly turnNumber?: number
  private pendingEvents: AppendSimulationEventInput[] = []
  private nextSequenceIndex = 0
  private flushTimer: NodeJS.Timeout | undefined
  private operationChain: Promise<void> = Promise.resolve()

  constructor(options: SimulationEventRecorderOptions) {
    this.simulationRunId = options.simulationRunId
    this.gameId = options.gameId
    this.kind = options.kind
    this.turnNumber = options.turnNumber
  }

  recordEvent(event: PromptStreamEvent) {
    const eventTime = new Date()

    if (event.type === "start") {
      this.queueOperation(() =>
        gameStore.updateSimulationRunModel(this.simulationRunId, event.model)
      )
    }

    const mappedEvents = mapPromptStreamEventToSimulationEvents(
      event,
      eventTime,
      this.gameId
    )

    if (mappedEvents.length === 0) {
      return
    }

    this.pendingEvents.push(...mappedEvents)

    if (this.pendingEvents.length >= SIMULATION_EVENT_BATCH_SIZE) {
      void this.flush()
      return
    }

    this.scheduleFlush()
  }

  async complete(response: PromptProcessingResult) {
    await this.flush()
    await this.queueOperation(() =>
      gameStore.completeSimulationRun({
        simulationRunId: this.simulationRunId,
        status: "succeeded",
        modelKey: response.model.key,
        modelDisplayName: response.model.displayName,
        modelSizeBytes: response.model.sizeBytes,
        finalResultText: response.result,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        reasoningTokens: response.usage?.reasoningTokens,
        totalTokens: response.usage?.totalTokens,
      })
    )
  }

  async fail(error: unknown) {
    await this.flush()

    const errorMessage =
      error instanceof Error ? error.message : "Failed to process prompt."

    await this.queueOperation(() =>
      gameStore.completeSimulationRun({
        simulationRunId: this.simulationRunId,
        status: isPromptAbortError(error) ? "aborted" : "failed",
        errorMessage,
      })
    )
  }

  private scheduleFlush() {
    if (this.flushTimer) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, SIMULATION_EVENT_FLUSH_INTERVAL_MS)
  }

  private async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    if (this.pendingEvents.length === 0) {
      await this.operationChain
      return
    }

    const eventsToPersist = this.pendingEvents
    const startSequenceIndex = this.nextSequenceIndex

    this.pendingEvents = []
    this.nextSequenceIndex += eventsToPersist.length

    await this.queueOperation(() =>
      gameStore.appendSimulationEvents(
        this.simulationRunId,
        this.gameId,
        this.kind,
        this.turnNumber,
        startSequenceIndex,
        eventsToPersist
      )
    )
  }

  private async queueOperation(operation: () => Promise<void>) {
    this.operationChain = this.operationChain.then(operation, operation)
    await this.operationChain
  }
}

function mapPromptStreamEventToSimulationEvents(
  event: PromptStreamEvent,
  eventTime: Date,
  gameId: string
): AppendSimulationEventInput[] {
  switch (event.type) {
    case "start":
      return [
        {
          eventType: "start",
          eventTime,
          metadata: {
            modelKey: event.model.key,
            modelDisplayName: event.model.displayName,
            modelSizeBytes: event.model.sizeBytes,
          },
        },
      ]
    case "status":
      return [
        {
          eventType: event.event,
          eventTime,
          metadata: {
            progress: event.progress,
            modelInstanceId: event.modelInstanceId,
          },
        },
      ]
    case "reasoning":
      return [
        {
          eventType: "reasoning.delta",
          eventTime,
          reasoningTextDelta: event.delta,
        },
      ]
    case "message":
      return [
        {
          eventType: "message.delta",
          eventTime,
          messageTextDelta: event.delta,
        },
      ]
    case "tool": {
      const toolUiData =
        event.event === "tool_call.success" && event.tool
          ? getToolUiData(event.tool, gameId)
          : undefined

      return [
        {
          eventType: event.event,
          eventTime,
          toolName: event.tool,
          toolProvider: event.provider,
          toolStatusEvent: event.event,
          argumentsText: event.argumentsText,
          outputText: event.output,
          structuredContent:
            event.structuredContent ?? toolUiData?.structuredContent,
          uiMetadata: event.uiMetadata ?? toolUiData?.uiMetadata,
          errorText: event.error,
        },
      ]
    }
    case "error":
      return [
        {
          eventType: "error",
          eventTime,
          errorText: event.error,
        },
      ]
    case "done":
      return [
        {
          eventType: "done",
          eventTime,
          metadata: {
            modelKey: event.model.key,
            modelDisplayName: event.model.displayName,
            modelSizeBytes: event.model.sizeBytes,
            resultLength: event.result.length,
            reasoningLength: event.reasoning.length,
          },
        },
      ]
    default:
      return []
  }
}

function isPromptAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

async function streamPromptResponse(
  res: Response,
  promptProcessor: ReturnType<typeof createPromptProcessor>,
  prompt: string,
  onEvent?: (event: PromptStreamEvent) => void
) {
  const abortController = new AbortController()

  res.on("close", () => {
    abortController.abort()
  })

  res.status(200)
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")

  return promptProcessor.processPromptStream(
    prompt,
    (event) => {
      onEvent?.(event)
      res.write(`${JSON.stringify(event)}\n`)
    },
    abortController.signal
  )
}

function tryParseJsonObject(value: string | undefined) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function getKeepHandCardsFromPromptEvent(event: PromptStreamEvent) {
  if (event.type !== "tool" || event.tool !== "keep_hand") {
    return undefined
  }

  const parsedArguments = tryParseJsonObject(event.argumentsText)

  if (
    parsedArguments === null ||
    !("cards" in parsedArguments) ||
    !Array.isArray(parsedArguments.cards)
  ) {
    return undefined
  }

  const cards = parsedArguments.cards
    .filter((card: unknown): card is string => typeof card === "string")
    .map((card: string) => card.trim())
    .filter(Boolean)

  return cards.length ? cards : undefined
}

function buildStartingHandSimulationPrompt(
  gameId: string,
  commanders: readonly GameCard[],
  initialLibrary: readonly GameCard[]
) {
  const commanderLabel = commanders.length === 1 ? "Commander" : "Commanders"
  const commanderNames = commanders.map((card) => card.name)
  const cardNames = initialLibrary.map((card) => card.name)
  const uniqueCards = dedupeCardsByNameAndText([
    ...commanders,
    ...initialLibrary,
  ])

  return `${DRAW_STARTING_HAND_PROMPT}

Game ID: ${gameId}

${commanderLabel}:
${commanderNames.join("\n")}

Decklist:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${card.cardText}\n`).join("\n")}
`.trim()
}

function buildTurnSimulationPrompt(
  gameId: string,
  currentTurn: number,
  startingHand: readonly string[],
  commanders: readonly GameCard[],
  currentLibrary: readonly string[],
  initialLibrary: readonly GameCard[],
  currentGameState?: string
) {
  const commanderNames = commanders.map((card) => card.name)
  const cardNames = currentLibrary
  const uniqueCards = dedupeCardsByNameAndText([
    ...commanders,
    ...initialLibrary,
  ])
  const resolvedGameState = currentGameState?.trim()
    ? currentGameState.trim()
    : `
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
`

  return `${SIMULATE_TURN_PROMPT}

Game ID: ${gameId}
Current Turn: ${currentTurn}

===Start Game State===

${resolvedGameState}

===End Game State===

Cards in library. Not actual order of library. Use tools to interact with library:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${card.cardText}\n`).join("\n")}

${GENERIC_GAME_RULES_REFERENCE}
`.trim()
}
function dedupeCardsByNameAndText(cards: readonly GameCard[]) {
  const seenCards = new Set<string>()

  return cards.filter((card) => {
    const key = `${card.name}\n${card.cardText}`

    if (seenCards.has(key)) {
      return false
    }

    seenCards.add(key)
    return true
  })
}

function formatMulliganReminder(
  mulliganCount: number,
  cardsToBottomIfKept: number
) {
  if (mulliganCount === 1) {
    return "That was your first mulligan, which is free in Commander, so you can keep all 7 cards."
  }

  return `That was your ${toOrdinal(mulliganCount)} mulligan, so if you keep that hand you must put ${cardsToBottomIfKept} ${cardsToBottomIfKept === 1 ? "card" : "cards"} on the bottom of the deck.`
}

function formatCardList(cards: readonly string[]) {
  return cards.map((card) => JSON.stringify(card)).join(", ")
}

function toOrdinal(value: number) {
  const mod100 = value % 100

  if (mod100 >= 11 && mod100 <= 13) {
    return `${value}th`
  }

  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

function shortId(gameId: string) {
  return gameId.slice(0, 8)
}

type TokenPricing = {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
}

function formatPromptMetrics(response: PromptProcessingResult) {
  const inputTokens = response.usage?.inputTokens ?? "unknown"
  const outputTokens = response.usage?.outputTokens ?? "unknown"
  const reasoningTokens = response.usage?.reasoningTokens
  const estimatedCostUsd = estimatePromptCostUsd(response)
  const formattedCost =
    estimatedCostUsd === undefined
      ? "unknown"
      : formatCostInCents(estimatedCostUsd)

  const reasoningMetrics =
    typeof reasoningTokens === "number"
      ? ` reasoning_tokens=${reasoningTokens} billed_output_tokens=${getBilledOutputTokens(response) ?? "unknown"}`
      : ""

  return `input_tokens=${inputTokens} output_tokens=${outputTokens}${reasoningMetrics} duration_seconds=${formatDurationSeconds(response.durationMs)} estimated_cost_cents=${formattedCost}`
}

function estimatePromptCostUsd(response: PromptProcessingResult) {
  if (response.provider === "lm-studio" || response.provider === "llama.cpp") {
    return undefined
  }

  const inputTokens = response.usage?.inputTokens
  const billedOutputTokens = getBilledOutputTokens(response)

  if (
    typeof inputTokens !== "number" ||
    typeof billedOutputTokens !== "number"
  ) {
    return undefined
  }

  const pricing = getTokenPricing(
    response.provider,
    response.model.key,
    inputTokens
  )

  if (!pricing) {
    return undefined
  }

  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (billedOutputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  )
}

function getBilledOutputTokens(response: PromptProcessingResult) {
  const outputTokens = response.usage?.outputTokens
  const reasoningTokens = response.usage?.reasoningTokens

  if (typeof outputTokens !== "number") {
    return undefined
  }

  if (response.provider === "gemini") {
    return (
      outputTokens + (typeof reasoningTokens === "number" ? reasoningTokens : 0)
    )
  }

  return outputTokens
}

function getTokenPricing(
  provider: PromptProcessorProvider,
  modelKey: string,
  inputTokens?: number
): TokenPricing | undefined {
  const normalizedModelKey = modelKey.trim().toLowerCase()

  switch (provider) {
    case "llama.cpp":
      return undefined
    case "openai":
      return getOpenAiTokenPricing(normalizedModelKey, inputTokens)
    case "claude":
      return getClaudeTokenPricing(normalizedModelKey, inputTokens)
    case "gemini":
      return getGeminiTokenPricing(normalizedModelKey)
    case "lm-studio":
    default:
      return undefined
  }
}

function getOpenAiTokenPricing(
  modelKey: string,
  inputTokens?: number
): TokenPricing | undefined {
  const pricingTable: Array<[string, TokenPricing]> = [
    [
      "gpt-5.4-pro",
      { inputUsdPerMillionTokens: 30, outputUsdPerMillionTokens: 180 },
    ],
    [
      "gpt-5.4-mini",
      { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 4.5 },
    ],
    [
      "gpt-5.4-nano",
      { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.25 },
    ],
    [
      "gpt-5.4",
      { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
    ],
    [
      "gpt-5-pro",
      { inputUsdPerMillionTokens: 15, outputUsdPerMillionTokens: 120 },
    ],
    [
      "gpt-5.2-pro",
      { inputUsdPerMillionTokens: 21, outputUsdPerMillionTokens: 168 },
    ],
    [
      "gpt-5.2-codex",
      { inputUsdPerMillionTokens: 1.75, outputUsdPerMillionTokens: 14 },
    ],
    [
      "gpt-5.2-chat-latest",
      { inputUsdPerMillionTokens: 1.75, outputUsdPerMillionTokens: 14 },
    ],
    [
      "gpt-5.2",
      { inputUsdPerMillionTokens: 1.75, outputUsdPerMillionTokens: 14 },
    ],
    [
      "gpt-5.1-codex-max",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
    [
      "gpt-5.1-codex-mini",
      { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 2 },
    ],
    [
      "gpt-5.1-codex",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
    [
      "gpt-5.1-chat-latest",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
    [
      "gpt-5.1",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
    [
      "gpt-5-codex",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
    [
      "gpt-5-mini",
      { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 2 },
    ],
    [
      "gpt-5-nano",
      { inputUsdPerMillionTokens: 0.05, outputUsdPerMillionTokens: 0.4 },
    ],
    [
      "gpt-5",
      { inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ],
  ]

  const basePricing = pricingTable.find(([prefix]) =>
    modelKey.startsWith(prefix)
  )?.[1]

  if (!basePricing) {
    return undefined
  }

  if (
    typeof inputTokens === "number" &&
    inputTokens > 272_000 &&
    (modelKey.startsWith("gpt-5.4") || modelKey.startsWith("gpt-5.4-pro"))
  ) {
    return {
      inputUsdPerMillionTokens: basePricing.inputUsdPerMillionTokens * 2,
      outputUsdPerMillionTokens: basePricing.outputUsdPerMillionTokens * 1.5,
    }
  }

  return basePricing
}

function getClaudeTokenPricing(
  modelKey: string,
  inputTokens?: number
): TokenPricing | undefined {
  const pricingTable: Array<[string, TokenPricing]> = [
    [
      "claude-opus-4-6",
      { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
    ],
    [
      "claude-opus-4.6",
      { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
    ],
    [
      "claude-opus-4-5",
      { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
    ],
    [
      "claude-opus-4.5",
      { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
    ],
    [
      "claude-opus-4-1",
      { inputUsdPerMillionTokens: 15, outputUsdPerMillionTokens: 75 },
    ],
    [
      "claude-opus-4.1",
      { inputUsdPerMillionTokens: 15, outputUsdPerMillionTokens: 75 },
    ],
    [
      "claude-opus-4",
      { inputUsdPerMillionTokens: 15, outputUsdPerMillionTokens: 75 },
    ],
    [
      "claude-sonnet-4-6",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-sonnet-4.6",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-sonnet-4-5",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-sonnet-4.5",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-sonnet-4",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-3-7-sonnet",
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ],
    [
      "claude-3-5-haiku",
      { inputUsdPerMillionTokens: 0.8, outputUsdPerMillionTokens: 4 },
    ],
    [
      "claude-3-haiku",
      { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 1.25 },
    ],
  ]

  const basePricing = pricingTable.find(([prefix]) =>
    modelKey.startsWith(prefix)
  )?.[1]

  if (!basePricing) {
    return undefined
  }

  if (
    typeof inputTokens === "number" &&
    inputTokens > 200_000 &&
    (modelKey.startsWith("claude-sonnet-4") ||
      modelKey.startsWith("claude-sonnet-4-5") ||
      modelKey.startsWith("claude-sonnet-4.5") ||
      modelKey.startsWith("claude-sonnet-4-6") ||
      modelKey.startsWith("claude-sonnet-4.6"))
  ) {
    return {
      inputUsdPerMillionTokens: 6,
      outputUsdPerMillionTokens: 22.5,
    }
  }

  return basePricing
}

function getGeminiTokenPricing(modelKey: string): TokenPricing | undefined {
  const pricingTable: Array<[string, TokenPricing]> = [
    [
      "gemini-3.1-pro-preview",
      { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 12 },
    ],
    [
      "gemini-3.1-flash-lite-preview",
      { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 1.5 },
    ],
  ]

  return pricingTable.find(([prefix]) => modelKey.startsWith(prefix))?.[1]
}

function formatCostInCents(valueUsd: number) {
  const valueCents = valueUsd * 100

  if (valueCents < 0.1) {
    return "<0.1"
  }

  return valueCents.toFixed(1)
}

function formatDurationSeconds(durationMs: number) {
  return Math.round(durationMs / 1000)
}

async function writePromptLog(
  gameId: string,
  promptType: string,
  prompt: string
) {
  if (!SHOULD_LOG_PROMPTS_TO_FILE) {
    return
  }

  try {
    await mkdir(DEFAULT_PROMPT_LOG_DIRECTORY, { recursive: true })

    const sanitizedGameId = gameId.replace(/[^a-zA-Z0-9-_]/g, "_")
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filePath = resolve(
      DEFAULT_PROMPT_LOG_DIRECTORY,
      `${sanitizedGameId}-${promptType}-${timestamp}.log`
    )

    await writeFile(filePath, prompt, "utf8")
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to write prompt log."
    logWarn("prompt_log", `${shortId(gameId)} ${message}`)
  }
}

function logInfo(event: string, message: string) {
  console.error(`[${event}] ${message}`)
}

function logWarn(event: string, message: string) {
  console.warn(`[${event}] ${message}`)
}

main().catch((error) => {
  console.error("Server error:", error)
  process.exit(1)
})

function initializeTurnActionLog(gameId: string, turnNumber: number) {
  turnActionLogStore.set(gameId, {
    turnNumber,
    actions: [],
  })
}

function deleteTurnActionLog(gameId: string) {
  turnActionLogStore.delete(gameId)
}

function createToolUiDataKey(toolName: string, gameId: string) {
  return `${toolName}:${gameId}`
}

function deleteToolUiDataForGame(gameId: string) {
  const gameKeySuffix = `:${gameId}`

  for (const key of toolUiDataStore.keys()) {
    if (key.endsWith(gameKeySuffix)) {
      toolUiDataStore.delete(key)
    }
  }
}

function storeToolUiData(
  toolName: string,
  gameId: string,
  toolUiData: ToolUiDataRecord
) {
  const key = createToolUiDataKey(toolName, gameId)
  const existingEntries = toolUiDataStore.get(key) ?? []

  toolUiDataStore.set(key, [...existingEntries, toolUiData])
}

function takeToolUiData(toolName: string, gameId: string) {
  const key = createToolUiDataKey(toolName, gameId)
  const toolUiDataEntries = toolUiDataStore.get(key)

  if (!toolUiDataEntries?.length) {
    return undefined
  }

  const [toolUiData, ...remainingEntries] = toolUiDataEntries

  if (remainingEntries.length > 0) {
    toolUiDataStore.set(key, remainingEntries)
  } else {
    toolUiDataStore.delete(key)
  }

  return toolUiData
}

function getToolUiData(toolName: string, gameId: string) {
  return toolUiDataStore.get(createToolUiDataKey(toolName, gameId))?.[0]
}





