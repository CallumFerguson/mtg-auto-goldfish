import "dotenv/config"

import type { Request, Response } from "express"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"

import { GameStore, type GameCard } from "./game-store.js"
import {
  createPromptProcessor,
  normalizePromptProcessorProvider,
  type PromptProcessorOptions,
  type PromptProcessorProvider,
  type PromptStreamEvent,
} from "./llm/index.js"
import {
  DRAW_STARTING_HAND_PROMPT,
  SIMULATE_TURN_PROMPT,
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
const GAME_NOT_FOUND_MESSAGE =
  "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 8192


type ToolUiDataRecord = {
  structuredContent?: Record<string, unknown>
  uiMetadata?: Record<string, unknown>
}

const gameStore = new GameStore({
  onDeleteGame: deleteToolUiDataForGame,
})
const toolUiDataStore = new Map<string, ToolUiDataRecord>()
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
    registerDrawCardFromTopTool(server)
    registerDrawCardFromBottomTool(server)
    registerReturnCardToLibraryTool(server)
    registerReturnCardsToLibraryTool(server)
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
      const drawResult = gameStore.drawCardsFromTop(gameId, count)

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
      const drawResult = gameStore.drawCardsFromBottom(gameId, count)

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
      const drawResult = gameStore.drawStartingHand(gameId)

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
      const mulliganResult = gameStore.mulligan(gameId)

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
        card: z.string().trim().min(1).describe("The card name to put back into the library."),
        side: z
          .enum(["top", "bottom"])
          .describe("Whether the position is measured from the top or the bottom of the library."),
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
      const returnResult = gameStore.returnCardToLibrary(gameId, card, side, position)

      if (!returnResult.ok) {
        logWarn("return_to_library", `${shortId(gameId)} ${returnResult.reason}`)

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
          .describe("Whether to shuffle the returned cards before putting them back."),
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
      const returnResult = gameStore.returnCardsToLibrary(
        gameId,
        cards,
        side,
        randomizeOrder
      )

      if (!returnResult.ok) {
        logWarn("return_cards_to_library", `${shortId(gameId)} ${returnResult.reason}`)

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
      const gamePromptContext = gameStore.getGamePromptContext(gameId)

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
  const app = createMcpExpressApp({ host })
  const allowedOrigins = getAllowedOrigins(process.env.ALLOWED_ORIGINS)
  const llmProvider = normalizePromptProcessorProvider(process.env.LLM_PROVIDER)
  const sharedPromptProcessorOptions = getPromptProcessorOptions(llmProvider)
  const processPromptProcessor = createPromptProcessor(sharedPromptProcessorOptions)
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

  app.post("/games", (req: Request, res: Response) => {
    const parsedRequest = createGameSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const game = gameStore.createGame(
      parsedRequest.data.commanders,
      parsedRequest.data.deck,
      parsedRequest.data.seed
    )

    logInfo(
      "new",
      `${shortId(game.gameId)} seed=${game.seed} commanders=${game.commanderCount} cards=${game.cardsRemaining} games=${game.totalGames}`
    )

    res.status(201).json(game)
  })

  app.post("/tool-ui-data", (req: Request, res: Response) => {
    const parsedRequest = toolUiDataLookupSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    if (!gameStore.hasGame(parsedRequest.data.gameId)) {
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

  app.post("/opening-hand-snapshot-status", (req: Request, res: Response) => {
    const parsedRequest = openingHandSnapshotStatusSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const snapshotStatus = gameStore.getOpeningHandSnapshotStatus(
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
        `len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes}`
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

  app.post("/simulate-drawing-starting-hand", async (req: Request, res: Response) => {
    const parsedRequest = simulateDrawingStartingHandSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: "Invalid request body.",
        details: parsedRequest.error.issues,
      })
      return
    }

    const { gameId } = parsedRequest.data
    const gamePromptContext = gameStore.getGamePromptContext(gameId)

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

    try {
      let keptHandCards: string[] | undefined
      const response = await streamPromptResponse(
        res,
        openingHandPromptProcessor,
        prompt,
        (event) => {
          keptHandCards = getKeepHandCardsFromPromptEvent(event) ?? keptHandCards
        }
      )

      if (!keptHandCards?.length) {
        throw new Error(
          "The opening-hand simulation did not report a final kept hand through keep_hand."
        )
      }

      const snapshotResult = gameStore.saveOpeningHandSnapshot(gameId, keptHandCards)

      if (!snapshotResult.ok) {
        throw new Error(GAME_NOT_FOUND_MESSAGE)
      }

      logInfo(
        "simulate_starting_hand",
        `${shortId(gameId)} hand=${snapshotResult.startingHand.length} library=${snapshotResult.library.length} valid=${snapshotResult.validation.isValid} len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes}`
      )

      res.end()
    } catch (error) {
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
  })


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
    const gamePromptContext = gameStore.getGamePromptContext(gameId)

    if (!gamePromptContext.ok) {
      res.status(404).json({
        error: GAME_NOT_FOUND_MESSAGE,
      })
      return
    }

    const resolvedStartingHand = gamePromptContext.openingHandSnapshot?.startingHand

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

    const prompt = buildTurnSimulationPrompt(
      gamePromptContext.gameId,
      resolvedStartingHand,
      gamePromptContext.commanders,
      gamePromptContext.currentLibrary,
      gamePromptContext.initialLibrary
    )

    try {
      const response = await streamPromptResponse(
        res,
        turnSimulationPromptProcessor,
        prompt
      )

      logInfo(
        "simulate_turn",
        `${shortId(gameId)} hand=${resolvedStartingHand.length} len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes}`
      )

      res.end()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process prompt."

      logWarn("simulate_turn", `${shortId(gameId)} ${message}`)

      if (res.headersSent) {
        res.write(
          `${JSON.stringify({
            type: "error",
            error: message,
          })}
`
        )
        res.end()
        return
      }

      res.status(502).json({
        error: message,
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
    case "openai":
      return process.env.OPENAI_REASONING_EFFORT?.trim() || "medium"
    case "claude":
      return process.env.CLAUDE_REASONING_EFFORT?.trim() || "medium"
    case "lm-studio":
    default:
      return undefined
  }
}

function getProviderReasoningSummary(provider: PromptProcessorProvider) {
  switch (provider) {
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
    case "lm-studio":
    default:
      return undefined
  }
}
function getProviderBaseUrl(provider: PromptProcessorProvider) {
  switch (provider) {
    case "openai":
      return undefined
    case "claude":
      return undefined
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
    case "openai":
      return requireNonEmptyEnvValue("OPENAI_API_KEY")
    case "claude":
      return requireNonEmptyEnvValue("CLAUDE_API_KEY")
    case "lm-studio":
    default:
      return process.env.LM_STUDIO_API_TOKEN?.trim() || undefined
  }
}

function getProviderModel(provider: PromptProcessorProvider) {
  switch (provider) {
    case "openai":
      return requireNonEmptyEnvValue("OPENAI_MODEL")
    case "claude":
      return requireNonEmptyEnvValue("CLAUDE_MODEL")
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
  if (provider === "lm-studio") {
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

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
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
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...initialLibrary])

  return `${DRAW_STARTING_HAND_PROMPT}

Game ID: ${gameId}

${commanderLabel}:
${commanderNames.join("\n")}

Decklist:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map(card => `${card.name}\n${card.cardText}\n`).join("\n")}
`.trim();
}


function buildTurnSimulationPrompt(
  gameId: string,
  startingHand: readonly string[],
  commanders: readonly GameCard[],
  currentLibrary: readonly string[],
  initialLibrary: readonly GameCard[]
) {
  const commanderNames = commanders.map((card) => card.name)
  const cardNames = currentLibrary
  const uniqueCards = dedupeCardsByNameAndText([...commanders, ...initialLibrary])

  return `${SIMULATE_TURN_PROMPT}

Game ID: ${gameId}

===start game state===

Hand:
${startingHand.join("\n")}

Command Zone:
${commanderNames.join("\n")}

Graveyard:
// empty

Exile:
// empty

Battlefield:
// empty

===end game state===

Cards in library. Not actual order of library. Use tools to interact with library:
${cardNames.join("\n")}

Card reference:
${uniqueCards.map((card) => `${card.name}\n${card.cardText}\n`).join("\n")}
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
  toolUiDataStore.set(createToolUiDataKey(toolName, gameId), toolUiData)
}

function takeToolUiData(toolName: string, gameId: string) {
  const key = createToolUiDataKey(toolName, gameId)
  const toolUiData = toolUiDataStore.get(key)

  if (!toolUiData) {
    return undefined
  }

  toolUiDataStore.delete(key)

  return toolUiData
}























