import type { Request, Response } from "express"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod/v4"

import { GameStore } from "./game-store.js"
import { createPromptProcessor } from "./llm/index.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 3001
const SERVER_NAME = "mtg-auto-goldfish-server"
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]

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
        cards: z.array(gameCardSchema),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const drawResult = gameStore.drawCardsFromTop(gameId, count)

      if (!drawResult.ok) {
        logWarn("draw_top", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."
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
            text: `Drew ${response.cards.length} card(s) from the top: ${response.cards.map((card) => card.name).join(", ")}. ${response.cardsRemaining} cards remain in the library.`,
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
        cards: z.array(gameCardSchema),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const drawResult = gameStore.drawCardsFromBottom(gameId, count)

      if (!drawResult.ok) {
        logWarn("draw_bottom", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."
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
            text: `Drew ${response.cards.length} card(s) from the bottom: ${response.cards.map((card) => card.name).join(", ")}. ${response.cardsRemaining} cards remain in the library.`,
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
        "Draw the opening seven-card hand from the stored library for an existing game ID that was created outside MCP. This can only be called once per game.",
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
        cards: z.array(gameCardSchema),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId }) => {
      const drawResult = gameStore.drawStartingHand(gameId)

      if (!drawResult.ok) {
        logWarn("draw_starting_hand", `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === "game_not_found"
            ? "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."
            : "The starting hand has already been drawn for that game."

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
            text: `Drew starting hand: ${response.cards.map((card) => card.name).join(", ")}. ${response.cardsRemaining} cards remain in the library.`,
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
        "Return the starting hand to the library, shuffle, and draw a fresh seven-card hand. This can only be called after the starting hand has been drawn.",
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
        cards: z.array(gameCardSchema),
        cardsRemaining: z.number().int().nonnegative(),
        mulliganCount: z.number().int().positive(),
        cardsToBottomIfKept: z.number().int().nonnegative(),
        reminder: z.string(),
      },
    },
    async ({ gameId }) => {
      const mulliganResult = gameStore.mulligan(gameId)

      if (!mulliganResult.ok) {
        logWarn("mulligan", `${shortId(gameId)} ${mulliganResult.reason}`)

        const message =
          mulliganResult.reason === "game_not_found"
            ? "Game not found. It may be invalid, may not have been created yet, or may have expired after one hour."
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
        cards: mulliganResult.cards,
        cardsRemaining: mulliganResult.cardsRemaining,
        mulliganCount: mulliganResult.mulliganCount,
        cardsToBottomIfKept: mulliganResult.cardsToBottomIfKept,
        reminder,
      }

      logInfo(
        "mulligan",
        `${shortId(gameId)} n=${response.cards.length} mulligans=${response.mulliganCount} left=${response.cardsRemaining}`
      )

      return {
        content: [
          {
            type: "text",
            text: `Mulliganed into: ${response.cards.map((card) => card.name).join(", ")}. ${response.cardsRemaining} cards remain in the library. ${response.reminder}`,
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
      res.status(200)
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")

      const response = await promptProcessor.processPromptStream(
        prompt,
        (event) => {
          res.write(`${JSON.stringify(event)}\n`)
        }
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

function formatMulliganReminder(
  mulliganCount: number,
  cardsToBottomIfKept: number
) {
  if (mulliganCount === 1) {
    return "That was your first mulligan, which is free in Commander, so you can keep all 7 cards."
  }

  return `That was your ${toOrdinal(mulliganCount)} mulligan, so if you keep that hand you must put ${cardsToBottomIfKept} ${cardsToBottomIfKept === 1 ? "card" : "cards"} on the bottom of the deck.`
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
