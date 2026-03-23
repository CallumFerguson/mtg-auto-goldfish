import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod/v4'

import { GameStore } from './game-store.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3001
const SERVER_NAME = 'mtg-auto-goldfish-server'
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

const gameStore = new GameStore()
const gameCardSchema = z.object({
  name: z.string().trim().min(1).describe('The card name.'),
  cardText: z.string().trim().min(1).describe('The gameplay-relevant card text.'),
})
const createGameSchema = z
  .object({
    commanders: z
      .array(gameCardSchema)
      .min(1)
      .max(2)
      .describe('The commander or partner pair for this game.'),
    deck: z.array(gameCardSchema).describe('The main-deck cards for this game.'),
  })
  .superRefine((value, context) => {
    const expectedDeckSize = value.commanders.length === 1 ? 99 : 98

    if (value.deck.length !== expectedDeckSize) {
      context.addIssue({
        code: 'custom',
        path: ['deck'],
        message: `Deck must contain exactly ${expectedDeckSize} cards when there ${value.commanders.length === 1 ? 'is 1 commander' : 'are 2 commanders'}.`,
      })
    }
  })

function createServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: '0.0.1',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  )

  server.registerTool(
    'draw_card',
    {
      title: 'Draw Card',
      description:
        'Draw one or more cards from the stored library for an existing game ID that was created outside MCP.',
      inputSchema: {
        gameId: z
          .uuid()
          .describe(
            'The game ID returned by the regular HTTP create-game endpoint, not by an MCP tool.',
          ),
        count: z.number().int().positive().describe('How many cards to draw.'),
      },
      outputSchema: {
        gameId: z.uuid(),
        cards: z.array(gameCardSchema),
        cardsRemaining: z.number().int().nonnegative(),
      },
    },
    async ({ gameId, count }) => {
      const drawResult = gameStore.drawCards(gameId, count)

      if (!drawResult.ok) {
        logWarn('draw', `${shortId(gameId)} ${drawResult.reason}`)

        const message =
          drawResult.reason === 'game_not_found'
            ? 'Game not found. It may be invalid, may not have been created yet, or may have expired after one hour.'
            : 'That game has no cards left in its library.'

        return {
          content: [
            {
              type: 'text',
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
        'draw',
        `${shortId(gameId)} n=${response.cards.length} left=${response.cardsRemaining}`,
      )

      return {
        content: [
          {
            type: 'text',
            text: `Drew ${response.cards.length} card(s): ${response.cards.map(card => card.name).join(', ')}. ${response.cardsRemaining} cards remain in the library.`,
          },
        ],
        structuredContent: response,
      }
    },
  )

  return server
}

async function main() {
  const host = process.env.HOST ?? DEFAULT_HOST
  const port = getPort(process.env.PORT)
  const app = createMcpExpressApp({ host })
  const allowedOrigins = getAllowedOrigins(process.env.ALLOWED_ORIGINS)

  app.use((req: Request, res: Response, next) => {
    applyCors(req, res, allowedOrigins)

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  })

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: SERVER_NAME,
    })
  })

  app.post('/games', (req: Request, res: Response) => {
    const parsedRequest = createGameSchema.safeParse(req.body)

    if (!parsedRequest.success) {
      res.status(400).json({
        error: 'Invalid request body.',
        details: parsedRequest.error.issues,
      })
      return
    }

    const game = gameStore.createGame(
      parsedRequest.data.commanders,
      parsedRequest.data.deck,
    )

    logInfo(
      'new',
      `${shortId(game.gameId)} commanders=${game.commanderCount} cards=${game.cardsRemaining} games=${game.totalGames}`,
    )

    res.status(201).json(game)
  })

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createServer()

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)

      res.on('close', () => {
        void transport.close()
        void server.close()
      })
    } catch (error) {
      console.error('Error handling MCP request:', error)

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        })
      }
    }
  })

  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    })
  })

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    })
  })

  app.listen(port, host, (error?: Error) => {
    if (error) {
      console.error('Failed to start server:', error)
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
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function applyCors(
  req: Request,
  res: Response,
  allowedOrigins: readonly string[],
) {
  const requestOrigin = req.headers.origin

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
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

main().catch(error => {
  console.error('Server error:', error)
  process.exit(1)
})
