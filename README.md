# Tender scraper — deploy fix

## Why the build failed

Render's build log shows:

```
Installing dependencies...
Switching to root user to install dependencies...
Password: su: Authentication failure
Failed to install browsers
```

That's `npx playwright install --with-deps chromium` trying to run `apt-get`
as root via `sudo`/`su`. Render's **native Node** build environment runs as
a non-root user with no sudo access, so this step can never succeed there —
it's not something you can fix by editing `server.js`.

## The fix

Switch this service to Render's **Docker** runtime and build from Playwright's
official base image, which already contains Chromium *and* every OS-level
library it needs. No `apt-get`, no sudo, nothing to install at build time.

Files added/changed:
- `Dockerfile` — new, builds from `mcr.microsoft.com/playwright:v1.48.0-jammy`
- `.dockerignore` — new
- `render.yaml` — new, optional Blueprint so Render auto-detects the Docker setup
- `server.js` — one-line change: now reads `process.env.PORT` (which Render
  injects automatically) before falling back to `SCRAPER_PORT`/8081

## Deploy steps on Render

1. Push these files (including the new `Dockerfile`) to your repo, same
   `emjiemai/Backend-Search-Engine` repo/branch Render is already pulling from.
2. In the Render dashboard, open the service settings:
   - **Settings → Environment** → change the runtime/environment from
     **Node** to **Docker**.
   - If Render still shows a "Build Command" / "Start Command" field, clear
     them — Docker services build from `Dockerfile`'s own `RUN`/`CMD` instead.
   - (Alternatively, delete the service and re-create it via **New → Blueprint**,
     pointing at this repo — `render.yaml` will configure the Docker service
     for you automatically.)
3. Deploy. The build now just runs `npm install` inside the Playwright image —
   no browser install step, no root prompt.
4. Once live, hit `GET https://<your-service>.onrender.com/health` to confirm
   it's up.

## Important: the CSS selectors are still unverified

The comments already flag this in `server.js`: the selectors in `SELECTORS`
are best-guess patterns, not confirmed against the real DOM of
`xarid.uzex.uz` / `etender.uzex.uz`. Before wiring this into a real n8n
workflow:

1. Deploy first (steps above).
2. Call `GET /debug/xarid` and `GET /debug/etender` — each returns a raw
   HTML snippet + screenshot of the live page.
3. Update `title`, `link`, `date`, `listItem`, and `waitForSelector` in
   `SELECTORS` to match what you actually see.

Skipping this step means `/scrape/xarid` and `/scrape/etender` will likely
return an empty `results` array even once the server itself is running fine.

## Using it from n8n

Once deployed and selectors are verified, add an **HTTP Request** node in n8n:

- Method: `GET`
- URL: `https://<your-service>.onrender.com/scrape/xarid?keyword=<term>`
  (or `/scrape/etender`)
- Response format: JSON

The response shape is:

```json
{
  "portal": "xarid",
  "keyword": "kir yuvish",
  "scrapedAt": "2026-08-17T10:00:00.000Z",
  "resultCount": 12,
  "results": [{ "title": "...", "link": "...", "date": "..." }]
}
```

Render's free/starter plans spin down idle services, so the first request
after inactivity can take 30–60s (cold start) — worth setting a longer
timeout on the n8n HTTP node, or pinging `/health` on a schedule to keep it
warm.
