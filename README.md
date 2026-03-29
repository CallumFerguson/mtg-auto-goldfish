# MTG Auto Goldfish

A dark-mode React app for turning a Commander decklist into AI-ready gameplay text.

## Screenshots

![Deck input screen](<docs/deck input screenshot.png>)
![Simulation screen](<docs/simulation screenshot.png>)

The current UI focuses on deck intake:

- Enter `1` or `2` commanders in separate boxes.
- Paste a plain-text main deck list in standard MTG mass-entry format.
- Validate the deck shape as either `1 commander + 99 cards` or `2 commanders + 98 cards`.
- Look up cards through the Scryfall API.
- Accept exact matches automatically.
- Require manual approval for fuzzy matches.
- Fall back to manual rules-text entry for cards Scryfall cannot resolve.

## Current behavior

- Commander fields accept plain names like `Pantlaza, Sun-Favored` and single-copy entry style like `1 Pantlaza, Sun-Favored`.
- Commander fields reject duplicate commanders and quantities above `1` in a single commander slot.
- The process action stays disabled until the commander setup and deck count are valid.
- The app uses Scryfall's `/cards/collection` endpoint for batched exact-name lookups.
- If an exact match is not found, the app asks Scryfall for a fuzzy match suggestion, but the user must explicitly accept it before it is used.
- If no acceptable match is found, the user can paste gameplay-relevant card text manually.

## Scripts

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run server:dev
npm run server:build
```

## Server

This repo now includes a standalone HTTP server for deck goldfishing experiments. Its source lives in `mtg-auto-goldfish-server/`. It still exposes an MCP endpoint, but it can also serve regular HTTP endpoints alongside it.

Current API surface:

- `POST /games`: creates a new in-memory game from the provided commanders and deck and returns a `gameId`.
- MCP tool `draw_card`: draws one or more cards from the stored deck for the supplied `gameId` and `count`.

Behavior:

- Each new game uses only the commanders and deck submitted in its own `POST /games` request.
- `POST /games` requires exactly `1` or `2` commanders.
- `POST /games` requires exactly `99` deck cards when there is `1` commander, or exactly `98` deck cards when there are `2` commanders.
- Games are stored in memory only.
- Any game older than 1 hour is automatically removed.
- The app is expected to create the game over HTTP first, then pass that `gameId` into the LLM prompt.
- The MCP endpoint is served over HTTP at `/mcp`.

### Create a game

Request body:

```json
{
  "commanders": [
    {
      "name": "Pantlaza, Sun-Favored",
      "cardText": "Whenever Pantlaza, Sun-Favored or another Dinosaur enters..."
    }
  ],
  "deck": [
    {
      "name": "Sol Ring",
      "cardText": "{T}: Add {C}{C}."
    },
    {
      "name": "Cultivate",
      "cardText": "Search your library for up to two basic land cards..."
    }
  ]
}
```

### Run locally

Development:

```bash
npm run server:dev
```

Production-style local run:

```bash
npm run server:build
npm run server:start
```

By default the server listens on `http://127.0.0.1:3001`.

Example `.env` file:

```dotenv
# Global LLM selection
# Valid values: lm-studio, openai, claude
LLM_PROVIDER=lm-studio

# Used by OpenAI and Claude requests. Ignored by LM Studio.
LLM_MAX_OUTPUT_TOKENS=50000

# LM Studio
# Optional. If blank, the server picks the largest currently loaded LM Studio model.
LM_STUDIO_MODEL=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
OPENAI_REASONING_EFFORT=medium

# Claude
CLAUDE_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_REASONING_EFFORT=medium

# Public MCP URLs for cloud providers only.
# Required when LLM_PROVIDER=openai or LLM_PROVIDER=claude.
# Ignored when LLM_PROVIDER=lm-studio, because LM Studio always uses local http MCP URLs.
GOLDFISH_OPENING_HAND_MCP_SERVER_URL=https://example.com//mcp/opening-hand
GOLDFISH_TURN_SIMULATION_MCP_SERVER_URL=https://example.com/mcp/turn-simulation
```

### LM Studio configuration

Configure LM Studio to connect to the running HTTP MCP endpoint instead of spawning it.

```json
{
  "mtg-auto-goldfish": {
    "url": "http://127.0.0.1:3001/mcp"
  }
}
```

### App flow

The intended flow is:

1. The app calls `POST /games` with the commander array and the full deck list and receives a `gameId`.
2. The app includes that `gameId` in the model prompt or tool context.
3. The model can call `draw_card`, but it cannot create a game through MCP.

## Development

1. Install dependencies:

```bash
npm install
```

2. Start the Vite dev server:

```bash
npm run dev
```

3. Open the local app URL shown in the terminal.

## Tech

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui
- Scryfall API


