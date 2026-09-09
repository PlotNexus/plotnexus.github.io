// Throwaway diagnostic, not a scraper. Earlier runs established: (1) a
// real browser gets past the DataDome interstitial on a session's first
// navigation, every time; (2) every navigation after that, in the SAME
// session, gets the interstitial again — even with a realistic ~9s
// settle wait matching the successful first run, ruling out "just needed
// more time" as the explanation. This run isolates the remaining
// variable: is it specifically page.goto() to a constructed URL that's
// the tell (no referrer, no user gesture), or does ANY second navigation
// in a session get challenged regardless of how it happens? Tests a
// real .click() on an in-page link instead of a second goto().
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT_DIR = "out";
mkdirSync(OUT_DIR, { recursive: true });

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function describe(page, label) {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  return {
    label,
    url: page.url(),
    title: await page.title().catch(() => null),
    looksBlocked: /enable js|datadome|captcha/i.test(bodyText),
    listingCardCount: await page.locator("article.item").count().catch(() => 0),
    bodyTextSnippet: bodyText.slice(0, 200),
  };
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

  // Step 1: known-good cold load.
  const resp1 = await page.goto("https://www.idealista.pt/comprar-casas/lisboa/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(9000);
  const step1 = await describe(page, "step1-cold-goto");
  step1.status = resp1 ? resp1.status() : null;
  results.push(step1);
  log("step1", JSON.stringify(step1));

  // Step 2: real .click() on an in-page listing link (organic navigation:
  // proper referrer, a genuine user-gesture click event) rather than a
  // second goto() to a constructed URL.
  let step2;
  try {
    const link = page.locator("a.item-link").first();
    const href = await link.getAttribute("href");
    await Promise.all([page.waitForNavigation({ timeout: 30000, waitUntil: "domcontentloaded" }), link.click()]);
    await page.waitForTimeout(9000);
    step2 = await describe(page, "step2-click-navigation");
    step2.clickedHref = href;
  } catch (err) {
    step2 = { label: "step2-click-navigation", error: err.message };
  }
  results.push(step2);
  log("step2", JSON.stringify(step2));
  await page.screenshot({ path: `${OUT_DIR}/step2.png`, fullPage: false }).catch(() => {});

  // Step 3: a second .click(), this time on the pagination "next page"
  // control from the search results (only meaningful if step 2 itself
  // landed back on a results-style page with one — otherwise skipped).
  let step3;
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(9000);
    const nextLink = page.locator('a[href*="pagina-2"]').first();
    const count = await nextLink.count();
    if (count === 0) {
      step3 = { label: "step3-click-pagination", skipped: "no pagination link found after goBack" };
    } else {
      await Promise.all([
        page.waitForNavigation({ timeout: 30000, waitUntil: "domcontentloaded" }),
        nextLink.click(),
      ]);
      await page.waitForTimeout(9000);
      step3 = await describe(page, "step3-click-pagination");
    }
  } catch (err) {
    step3 = { label: "step3-click-pagination", error: err.message };
  }
  results.push(step3);
  log("step3", JSON.stringify(step3));

  writeFileSync(`${OUT_DIR}/probe4-results.json`, JSON.stringify(results, null, 2));
  log("ALL RESULTS:", JSON.stringify(results, null, 2));

  await browser.close();
}

main();
