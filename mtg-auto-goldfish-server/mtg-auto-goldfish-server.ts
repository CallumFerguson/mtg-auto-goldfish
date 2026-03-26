import type { Request, Response } from "express"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"

import { GameStore, type GameCard } from "./game-store.js"
import { createPromptProcessor } from "./llm/index.js"
import { DRAW_STARTING_HAND_PROMPT } from "./llm/prompt-constants.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3001
const SERVER_NAME = "mtg-auto-goldfish-server"
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]
const GAME_NOT_FOUND_MESSAGE =
  "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."

const gameStore = new GameStore()
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

function createServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: "0.0.1",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  )

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

  return server
}

async function main() {
  const host = process.env.HOST ?? DEFAULT_HOST
  const port = getPort(process.env.PORT)
  const app = createMcpExpressApp({ host })
  const allowedOrigins = getAllowedOrigins(process.env.ALLOWED_ORIGINS)
  const promptProcessor = createPromptProcessor({
    baseUrl: process.env.LM_STUDIO_BASE_URL,
    apiToken: process.env.LM_STUDIO_API_TOKEN,
    mcpServerUrl:
      process.env.GOLDFISH_MCP_SERVER_URL ?? getLocalMcpServerUrl(host, port),
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
      parsedRequest.data.deck
    )

    logInfo(
      "new",
      `${shortId(game.gameId)} commanders=${game.commanderCount} cards=${game.cardsRemaining} games=${game.totalGames}`
    )

    res.status(201).json(game)
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
      const response = await streamPromptResponse(res, promptProcessor, prompt)

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
      const response = await streamPromptResponse(res, promptProcessor, prompt)

      logInfo(
        "simulate_starting_hand",
        `${shortId(gameId)} len=${prompt.length} model=${response.model.key} size=${response.model.sizeBytes}`
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

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createServer()

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
  })

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  })

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  })

  app.listen(port, host, (error?: Error) => {
    if (error) {
      console.error("Failed to start server:", error)
      process.exit(1)
    }

    console.error(`${SERVER_NAME} listening at http://${host}:${port}`)
    console.error(`MCP endpoint available at http://${host}:${port}/mcp`)
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

function getLocalMcpServerUrl(host: string, port: number) {
  return `http://${normalizeLocalHost(host)}:${port}/mcp`
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

async function streamPromptResponse(
  res: Response,
  promptProcessor: ReturnType<typeof createPromptProcessor>,
  prompt: string
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
      res.write(`${JSON.stringify(event)}\n`)
    },
    abortController.signal
  )
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

