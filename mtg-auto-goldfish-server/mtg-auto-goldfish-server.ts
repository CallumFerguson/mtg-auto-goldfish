import "dotenv/config"
import express, { type Request, type Response } from "express"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"
import { closeDatabasePool, verifyDatabaseConnection } from "./db.js"
import {
  createDeck,
  deleteDeck,
  ensureDecksSchema,
  getDeck,
  listDecks,
  updateDeckDetails,
} from "./decks-postgres.js"
import { ensureFreshScryfallOracleCards } from "./scryfall-cache.js"
import { ensureSimulationsSchema } from "./simulations-postgres.js"
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

const externalGameIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool."
  )
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
        gameId: externalGameIdSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const response = {
        gameId,
        cards: [],
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Placeholder: would draw ${count} card(s) from the top. No cards were drawn.`,
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
        gameId: externalGameIdSchema,
        count: z.number().int().positive().describe("How many cards to draw."),
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const response = {
        gameId,
        cards: [],
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Placeholder: would draw ${count} card(s) from the bottom. No cards were drawn.`,
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
        gameId: externalGameIdSchema,
      },
      outputSchema: {
        gameId: z.string(),
        cards: z.array(z.string()),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId }) => {
      const response = {
        gameId,
        cards: [],
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would draw the starting hand. No cards were drawn.",
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        reason,
        cards: [],
        cardsRemaining: 0,
        mulliganCount: 1,
        cardsToBottomIfKept: 0,
        reminder:
          "Placeholder: mulligan tracking is not implemented yet, so this is empty data.",
        replacesPreviousOpeningHand: false,
        alreadyDrewReplacementHand: false,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would mulligan and draw a replacement hand. No cards were moved or drawn.",
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        card,
        side,
        position,
        insertedFromTop: 0,
        insertedFromBottom: 0,
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Placeholder: would return ${JSON.stringify(card)} to the library. No card was moved.`,
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        cards: [],
        side,
        randomizeOrder,
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Placeholder: would return ${cards.length} card(s) to the ${side} of the library. No cards were moved.`,
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        matches: cards.map((card) => ({
          requestedCard: card,
          foundCard: null,
        })),
        foundCards: [],
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would take requested card(s) from the library. No cards were found or moved.",
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
        gameId: externalGameIdSchema,
      },
      outputSchema: {
        gameId: z.string(),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId }) => {
      const response = {
        gameId,
        cardsRemaining: 0,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would shuffle the library. No cards were moved.",
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        turnNumber: 1,
        latestAction: action,
        actions: [],
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would log this turn action. No action was persisted.",
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        turnNumber: 1,
        nextTurnNumber: 2,
        gameState,
        updated: true as const,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Placeholder: would save the updated game state. No state was persisted.",
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
        gameId: externalGameIdSchema,
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
      const response = {
        gameId,
        cards: [],
        kept: true as const,
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Placeholder: would keep ${cards.length} card(s). No hand was persisted.`,
          },
        ],
        structuredContent: response,
      }
    }
  )
}

async function main() {
  registerShutdownHandlers()
  await verifyDatabaseConnection()
  await ensureFreshScryfallOracleCards()
  await ensureDecksSchema()
  await ensureSimulationsSchema()

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

    express.json()(req, res, next)
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

/*
Future prompt-builder reference. These are intentionally commented out because
the old GameCard type and game-store model have been removed.

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
*/

main().catch(async (error: unknown) => {
  console.error(error)
  await closeDatabasePool()
  process.exit(1)
})
