# MTG Auto Deck

![Simulation screenshot](docs/simulation-screenshot.png)

![Simulation screenshot 2](docs/simulation-screenshot-2.png)

## Setup

1. Copy the example environment file:

   ```sh
   cp mtg-auto-deck-server/.env.example mtg-auto-deck-server/.env
   ```

2. Fill in the variables in `mtg-auto-deck-server/.env`.

   For user accounts, set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `APP_PUBLIC_URL`, and the `SMTP_*` variables used for auth email.
   In local development, open the app at the same host configured in
   `APP_PUBLIC_URL` so auth cookies are sent consistently.
   The standalone `/mcp/simulation` server is test-only and is disabled by
   default; set `SIMULATION_MCP_SERVER_ENABLED=true` only when intentionally
   testing that endpoint.

3. Install dependencies:

   ```sh
   npm install
   ```

## Running

Start the app and server in separate terminals:

```sh
npm run dev
```

```sh
npm run server:watch
```

Optionally start ngrok when using openai and locally running mcp server:

```sh
npm run ngrok
```
