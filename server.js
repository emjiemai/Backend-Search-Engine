// Free tender-portal scraper for xarid.uzex.uz and etender.uzex.uz
//
// These sites are JavaScript-rendered (React/Vue-style SPAs) and return almost
// nothing to a plain HTTP request - a real browser has to load and run the page's
// JS before the tender listings appear in the DOM. Playwright does that for free
// (open-source, runs on your own VPS - no per-request cost, no subscription).
//
// This exposes simple GET endpoints that n8n's HTTP Request node can call just
// like any normal API, e.g.:
//   GET http://localhost:8081/scrape/xarid?keyword=kir+yuvish
//   GET http://localhost:8081/scrape/etender?keyword=laundry
//
// IMPORTANT - READ BEFORE DEPLOYING:
// I could not load the real xarid.uzex.uz page from my own environment (network
// sandboxed), so the CSS selectors below are a reasonable best guess based on
// common patterns for this kind of procurement portal, NOT verified against the
// live DOM. Before trusting this in production:
//   1. Deploy to your VPS (which has full internet access).
//   2. Call GET /debug/xarid to dump the actual page HTML/structure.
//   3. Adjust the SELECTORS object below to match what you actually see.
// This is a normal, expected step for scraping any JS-heavy site - selectors
// almost never work on the first guess.

import Fastify from "fastify";
import { chromium } from "playwright";

// Render injects PORT and expects the app to listen on it. Fall back to
// SCRAPER_PORT (or 8081) for local/manual runs.
const PORT = process.env.PORT || process.env.SCRAPER_PORT || 8081;

const fastify = Fastify({ logger: true });

// One shared browser instance, reused across requests for speed.
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

// ---------------------------------------------------------------------------
// SELECTORS - the part most likely to need adjustment after you inspect the
// real page. Update these once you've run /debug/xarid on your VPS.
// ---------------------------------------------------------------------------
const SELECTORS = {
  xarid: {
    url: "https://xarid.uzex.uz/",
    // Common patterns for procurement listing pages - ADJUST AFTER INSPECTING:
    listItem: "[class*='lot'], [class*='tender'], [class*='card'], tr",
    title: "[class*='title'], [class*='name'], td:nth-child(2)",
    link: "a",
    date: "[class*='date'], td:nth-child(4)",
    waitForSelector: "[class*='lot'], [class*='tender'], table",
  },
  etender: {
    url: "https://etender.uzex.uz/",
    listItem: "[class*='lot'], [class*='tender'], [class*='card'], tr",
    title: "[class*='title'], [class*='name'], td:nth-child(2)",
    link: "a",
    date: "[class*='date'], td:nth-child(4)",
    waitForSelector: "[class*='lot'], [class*='tender'], table",
  },
};

async function scrapePortal(portalKey, keyword) {
  const config = SELECTORS[portalKey];
  if (!config) throw new Error(`Unknown portal: ${portalKey}`);

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(config.url, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for the actual content to render (not just the page shell).
    await page.waitForSelector(config.waitForSelector, { timeout: 15000 }).catch(() => {
      fastify.log.warn(`waitForSelector timed out for ${portalKey} - page structure may differ from expected`);
    });

    // If the portal has a search box, try typing the keyword.
    // This selector is a guess too - verify on your VPS.
    if (keyword) {
      const searchInput = await page.$("input[type='search'], input[placeholder*='иск'], input[placeholder*='qidir']");
      if (searchInput) {
        await searchInput.fill(keyword);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000); // let results refresh
      }
    }

    const items = await page.$$eval(
      config.listItem,
      (elements, cfg) => {
        return elements.slice(0, 30).map((el) => {
          const titleEl = el.querySelector(cfg.title);
          const linkEl = el.querySelector(cfg.link);
          const dateEl = el.querySelector(cfg.date);
          return {
            title: titleEl ? titleEl.textContent.trim() : el.textContent.trim().slice(0, 200),
            link: linkEl ? linkEl.href : null,
            date: dateEl ? dateEl.textContent.trim() : null,
          };
        });
      },
      config
    );

    // Filter out obviously empty/junk rows (headers, empty state messages).
    const cleaned = items.filter((i) => i.title && i.title.length > 5);

    return {
      portal: portalKey,
      keyword: keyword || null,
      scrapedAt: new Date().toISOString(),
      resultCount: cleaned.length,
      results: cleaned,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fastify.get("/scrape/xarid", async (request, reply) => {
  try {
    const data = await scrapePortal("xarid", request.query.keyword);
    reply.send(data);
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: err.message });
  }
});

fastify.get("/scrape/etender", async (request, reply) => {
  try {
    const data = await scrapePortal("etender", request.query.keyword);
    reply.send(data);
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// Debug route - dumps raw page info so you can inspect real structure and
// fix the SELECTORS above. Use this FIRST, before trusting /scrape results.
fastify.get("/debug/:portal", async (request, reply) => {
  const portalKey = request.params.portal;
  const config = SELECTORS[portalKey];
  if (!config) return reply.code(404).send({ error: "Unknown portal" });

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext();
  const page = await context.newPage();

  try {
    await page.goto(config.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    const bodyHtmlSnippet = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
    const screenshot = await page.screenshot({ encoding: "base64" });

    reply.send({
      portal: portalKey,
      url: config.url,
      htmlSnippet: bodyHtmlSnippet,
      screenshotBase64: screenshot,
      note: "Inspect htmlSnippet to find real class names / structure, then update SELECTORS in server.js accordingly.",
    });
  } finally {
    await context.close();
  }
});

fastify.get("/health", async () => ({ status: "ok" }));

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Tender scraper listening on port ${PORT}`);
});
