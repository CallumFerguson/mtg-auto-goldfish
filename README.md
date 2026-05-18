# MTG Auto Deck

[Try it for free here](https://mtgautodeck.com/)

## Screenshots

![Simulation screenshot](docs/simulation-screenshot.png)

![Simulation screenshot 2](docs/simulation-screenshot-2.png)

## Local Setup

1. Copy the server example environment file:

   ```sh
   cp mtg-auto-deck-server/.env.example mtg-auto-deck-server/.env
   ```

2. Fill in the variables in `mtg-auto-deck-server/.env`.

3. Configure the frontend public URLs for each Vite mode.

   Use localhost for development:

   ```sh
   cp .env.example .env.development
   ```

   Vite automatically loads `.env.development` for `npm run dev` and
   `.env.production` for `npm run build`. `VITE_*` values are exposed to the
   browser, so use them only for public configuration like app and API origins.

4. Install dependencies:

   ```sh
   npm install
   ```

## Local Running

Start the app and server:

```sh
npm run dev
```

```sh
npm run server:watch
```

Optionally start ngrok when using openai and running local mcp server:

```sh
npm run ngrok
```

## Deployment

Deployment instructions: [`deploy/README.md`](deploy/README.md).
