# Deployment

This folder contains example production config for hosting the Node/Express API
server and Postgres database on one DigitalOcean Droplet behind Caddy.

The expected production shape is:

```text
https://example.com      -> Cloudflare Worker landing page
https://app.example.com  -> Cloudflare Worker React app
https://api.example.com  -> DigitalOcean Droplet -> Caddy -> 127.0.0.1:3001
Postgres                 -> same Droplet, localhost only
```

## First Server Deploy

1. Create the Droplet and DNS.

   Create a DigitalOcean Droplet for the API server and database. In
   Cloudflare DNS, create an `api.example.com` `A` record pointing at the
   Droplet IP. Start with the record set to DNS-only until Caddy has issued a
   certificate and the API health check passes. If you later proxy the record
   through Cloudflare, use Full (strict) SSL/TLS mode.

2. Configure the firewall.

   Allow SSH, HTTP, and HTTPS. Do not expose Postgres publicly.

   ```sh
   sudo apt update
   sudo apt install -y ufw
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

3. Install runtime dependencies on the Droplet.

   Install the base packages used by the setup commands:

   ```sh
   sudo apt update
   sudo apt install -y ca-certificates curl gnupg git postgresql postgresql-contrib
   ```

   Install Node.js LTS from NodeSource. As of May 18, 2026, Node.js 24 is the
   latest LTS line; check the [Node.js download page](https://nodejs.org/en/download)
   before a fresh production setup and update the setup script version if the
   LTS line has changed:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v
   npm -v
   ```

   Install Caddy from the
   [official Caddy apt repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

   ```sh
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
     | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
     | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install -y caddy
   caddy version
   ```

4. Create the Postgres user and database.

   Generate a database password and save it somewhere secure:

   ```sh
   openssl rand -base64 32
   ```

   Open `psql` as the Postgres admin user:

   ```sh
   sudo -u postgres psql
   ```

   At the `postgres=#` prompt, run the database setup commands. Replace the
   password placeholder first.

   Do not copy and paste the whole block. Run one line at a time:

   ```sql
   CREATE USER mtg_auto_deck WITH PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD';
   CREATE DATABASE mtg_auto_deck OWNER mtg_auto_deck;
   \c mtg_auto_deck
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   \q
   ```

   Verify the new application database user can connect:

   ```sh
   psql "postgresql://mtg_auto_deck:REPLACE_WITH_LONG_RANDOM_PASSWORD@127.0.0.1:5432/mtg_auto_deck" -c "SELECT 1;"
   ```

5. Create an app user and clone the repo:

   ```sh
   sudo adduser --system --group --home /opt/mtg-auto-deck --shell /bin/bash mtgapp
   sudo install -d -o mtgapp -g mtgapp /opt/mtg-auto-deck
   sudo -u mtgapp git clone <YOUR_REPO_URL> /opt/mtg-auto-deck
   cd /opt/mtg-auto-deck
   sudo -u mtgapp npm ci
   sudo -u mtgapp npm run server:build
   ```

6. Copy and update the server environment file on the Droplet.

   Create the server env file from the checked-in example:

   ```sh
   sudo -u mtgapp cp mtg-auto-deck-server/.env.example mtg-auto-deck-server/.env
   sudo -u mtgapp chmod 600 mtg-auto-deck-server/.env
   ```

   Then update `mtg-auto-deck-server/.env` for production:

   ```env
   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=mtg_auto_deck
   PGUSER=mtg_auto_deck
   PGPASSWORD=REPLACE_WITH_DB_PASSWORD

   BETTER_AUTH_URL=https://api.example.com
   APP_PUBLIC_URL=https://app.example.com

   OPENING_HAND_MCP_PUBLIC_URL=https://api.example.com/mcp/opening-hand
   TURN_SIMULATION_MCP_PUBLIC_URL=https://api.example.com/mcp/turn-simulation
   SIMULATION_MCP_SERVER_ENABLED=false
   ```

   This snippet only shows the deployment-specific values. Fill in every other
   required variable from the example file too, including auth, billing, email,
   and LLM provider settings.
   Generate `BETTER_AUTH_SECRET` with:

   ```sh
   openssl rand -base64 48
   ```

7. Configure external services.

   Configure Stripe before starting the service because the server requires
   `STRIPE_WEBHOOK_SECRET` at startup. In Stripe, point the auth webhook at:

   ```text
   https://api.example.com/api/auth/stripe/webhook
   ```

   Use the resulting Stripe signing secret as `STRIPE_WEBHOOK_SECRET` in the
   server environment file.

8. Run the server once in the foreground to prime Scryfall data.

   On first startup, the server downloads Scryfall `oracle_cards` bulk data and
   imports it into Postgres before the health endpoint starts responding. This
   can take a while, so run it manually once before putting the process under
   systemd:

   ```sh
   sudo -u mtgapp npm run server:start
   ```

   Wait until the logs show that `mtg-auto-deck-server` is listening at
   `http://127.0.0.1:3001`, then stop the foreground process with `Ctrl+C`.
   If the command exits before listening, fix the reported environment,
   database, or Scryfall import issue and run it again.

9. Install and start the service:

   ```sh
   sudo cp deploy/mtg-auto-deck-server.service.example /etc/systemd/system/mtg-auto-deck-server.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now mtg-auto-deck-server
   sudo journalctl -u mtg-auto-deck-server -f
   ```

10. Install and reload the Caddy config:

    ```sh
    sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
    ```

11. Verify the API:

    ```sh
    curl -fsS http://127.0.0.1:3001/health
    curl -fsS https://api.example.com/health
    ```

12. Bootstrap the first admin user.

    After signing up through the app, promote your user in Postgres:

    ```sh
    sudo -u postgres psql -d mtg_auto_deck -c "UPDATE \"user\" SET role='admin' WHERE email='you@example.com';"
    ```

    Then use the admin dashboard to create and enable the first LLM model
    presets.

## Deploying Updates

Deploy backend updates on the Droplet:

```sh
cd /opt/mtg-auto-deck
sudo -u mtgapp git fetch --all --prune
sudo -u mtgapp git pull --ff-only
sudo install -d -o postgres -g postgres -m 700 /var/backups/mtg-auto-deck
sudo -u postgres pg_dump -Fc mtg_auto_deck -f /var/backups/mtg-auto-deck/mtg-auto-deck-$(date +%F-%H%M).dump
sudo -u mtgapp npm ci
sudo -u mtgapp npm run test
sudo -u mtgapp npm run server:build
sudo systemctl restart mtg-auto-deck-server
curl -fsS https://api.example.com/health
```

If the Caddy or systemd examples change, copy the updated file to its system
location, then validate/reload Caddy or run `sudo systemctl daemon-reload`.

Useful logs:

```sh
sudo journalctl -u mtg-auto-deck-server -f
sudo journalctl -u caddy -f
```

## Deploying the Frontend to Cloudflare Workers

This deploys the Vite React frontend as Cloudflare Workers Static Assets. The
Node/Express server in `mtg-auto-deck-server` still needs to be hosted
separately or ported to a Worker-compatible API.

Before deploying from a local checkout, copy and update the frontend production
environment file:

```sh
cp .env.example .env.production
```

Then update `.env.production` with your deployed API and app URLs:

```env
VITE_API_BASE_URL=https://api.example.com
VITE_APP_PUBLIC_URL=https://app.example.com
```

For Cloudflare Git builds, set `VITE_API_BASE_URL` and `VITE_APP_PUBLIC_URL` as
build environment variables in the Cloudflare dashboard, since local
`.env.production` files are not committed.

Production domains should come from environment variables and deployment
configuration, not from application or server source code. On the hosted server,
set `BETTER_AUTH_URL` to the public API origin and `APP_PUBLIC_URL` to the
public React app origin. In local development, the example env files use
`http://localhost:3001` for the API and `http://localhost:5173` for the app.

Then deploy:

```sh
npm run deploy
```

After the Worker deploys, add the production app domain, such as
`app.example.com`, to the `mtg-auto-deck` Worker in Cloudflare Workers Domains
& Routes.

## Deploying the Landing Page to Cloudflare Workers

The landing page is a separate Astro app in `landing` and deploys to its own
Cloudflare Worker, `mtg-auto-deck-landing`. Deploy it separately from the React
app Worker.

Before deploying a custom domain, make sure the landing page's app links point
at the deployed React app URL. The current links are based on `appBaseUrl` in
`landing/src/pages/index.astro`.

From a local checkout:

```sh
cd landing
npm ci
npm run deploy
```

After the Worker deploys, add the production landing domain, such as
`example.com`, to the `mtg-auto-deck-landing` Worker in Cloudflare Workers
Domains & Routes. Keep the React app on its own app domain, such as
`app.example.com`, and keep the API on the Droplet-backed API domain, such as
`api.example.com`.
