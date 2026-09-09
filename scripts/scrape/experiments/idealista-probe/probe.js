// Throwaway diagnostic, not a scraper: checks whether a real browser,
// running from an actual GitHub Actions runner IP, gets past Idealista's
// DataDome interstitial (curl-based requests get a 403 challenge page on
// the very first hit, from every IP tested so far, including this repo's
// own sandbox — see the conversation this came out of). Success/failure
// here decides whether a real Idealista source is worth building at all.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT_DIR = "out";
mkdirSync(OUT_DIR, { recursive: true });

const TARGET_URL = "https://www.idealista.pt/comprar-casas/lisboa/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function main() {
  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "pt-PT",
    timezoneId: "Europe/Lisbon",
  });

  // Basic, well-known stealth patch — DataDome explicitly checks
  // navigator.webdriver as one of its fingerprint signals.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  const result = { targetUrl: TARGET_URL, timestamp: new Date().toISOString() };

  try {
    const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    result.initialStatus = response ? response.status() : null;
    log("initial navigation status:", result.initialStatus);

    // If it's the DataDome interstitial, its own inline JS runs a
    // fingerprint check and, when the risk score is low enough, reloads
    // the page invisibly with a valid session cookie — give that a real
    // window before giving up.
    await page.waitForTimeout(8000);

    result.finalUrl = page.url();
    result.title = await page.title();
    result.bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 1000);

    const cookies = await context.cookies();
    result.hasDataDomeCookie = cookies.some((c) => c.name.toLowerCase() === "datadome");
    result.cookieNames = cookies.map((c) => c.name);

    // A real search results page has listing cards and a results count;
    // the blocked/interstitial page never does.
    result.listingCardCount = await page.locator("article").count().catch(() => 0);
    result.looksBlocked = /enable js|datadome|captcha/i.test(result.bodyText);

    await page.screenshot({ path: `${OUT_DIR}/idealista-probe.png`, fullPage: true });
    writeFileSync(`${OUT_DIR}/idealista-probe.html`, await page.content());
  } catch (err) {
    result.error = err.message;
    log("ERROR:", err.message);
    try {
      await page.screenshot({ path: `${OUT_DIR}/idealista-probe-error.png`, fullPage: true });
    } catch {
      // best effort only
    }
  }

  writeFileSync(`${OUT_DIR}/result.json`, JSON.stringify(result, null, 2));
  log("RESULT:", JSON.stringify(result, null, 2));

  await browser.close();
}

main();
