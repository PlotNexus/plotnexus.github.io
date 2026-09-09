// Throwaway diagnostic, not a scraper: checks whether a real browser,
// running from an actual GitHub Actions runner IP, gets past Idealista's
// DataDome interstitial, and (now that the first probe run confirmed it
// does) gathers what a real source module would need to know: pagination
// URL scheme, per-location vs. nationwide coverage, and whether the
// detail page exposes geo-coordinates.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT_DIR = "out";
mkdirSync(OUT_DIR, { recursive: true });

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function probeUrl(page, label, url) {
  const start = Date.now();
  const result = { label, url };
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    result.status = response ? response.status() : null;
    await page.waitForTimeout(2500);
    result.elapsedMs = Date.now() - start;
    result.finalUrl = page.url();
    result.title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText);
    result.looksBlocked = /enable js|datadome|captcha/i.test(bodyText);
    result.listingCardCount = await page.locator("article.item").count().catch(() => 0);
    result.bodyTextSnippet = bodyText.slice(0, 300);
  } catch (err) {
    result.error = err.message;
    result.elapsedMs = Date.now() - start;
  }
  log(label, JSON.stringify(result));
  return result;
}

async function main() {
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "pt-PT",
    timezoneId: "Europe/Lisbon",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  const results = [];

  // 1) Does a location-less / broader URL work (nationwide pagination
  // instead of having to enumerate every concelho)?
  results.push(await probeUrl(page, "nationwide-no-location", "https://www.idealista.pt/comprar-casas/"));
  results.push(await probeUrl(page, "distrito-level", "https://www.idealista.pt/comprar-casas/faro/"));
  results.push(await probeUrl(page, "concelho-level", "https://www.idealista.pt/comprar-casas/sintra/"));

  // 2) Pagination scheme, second page of a known-good search.
  results.push(
    await probeUrl(page, "pagination-page2", "https://www.idealista.pt/comprar-casas/lisboa/pagina-2.html")
  );

  // 3) Detail page — geo-coordinates, description, características.
  const detailResult = await probeUrl(page, "detail-page", "https://www.idealista.pt/imovel/35081413/");
  results.push(detailResult);

  if (!detailResult.error) {
    const detailExtras = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const latLngMatch = html.match(/"latitude":\s*(-?\d+\.\d+).{0,50}?"longitude":\s*(-?\d+\.\d+)/s);
      const mapLink = document.querySelector('a[href*="google.com/maps"], a[href*="maps.google"]');
      const scriptWithCoords = [...document.scripts]
        .map((s) => s.textContent)
        .find((t) => t && /latitude|"lat"/i.test(t));
      return {
        latLngFromRegex: latLngMatch ? [latLngMatch[1], latLngMatch[2]] : null,
        mapLinkHref: mapLink ? mapLink.getAttribute("href") : null,
        hasScriptWithCoords: !!scriptWithCoords,
        scriptCoordsSnippet: scriptWithCoords ? scriptWithCoords.slice(0, 500) : null,
        characteristicsHeadings: [...document.querySelectorAll("h2, h3")]
          .map((h) => h.textContent.trim())
          .filter(Boolean)
          .slice(0, 20),
      };
    });
    results.push({ label: "detail-extras", ...detailExtras });
    await page.screenshot({ path: `${OUT_DIR}/idealista-detail.png`, fullPage: true });
    writeFileSync(`${OUT_DIR}/idealista-detail.html`, await page.content());
  }

  writeFileSync(`${OUT_DIR}/probe2-results.json`, JSON.stringify(results, null, 2));
  log("ALL RESULTS:", JSON.stringify(results, null, 2));

  await browser.close();
}

main();
