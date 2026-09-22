import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync } from "fs";

mkdirSync("out", { recursive: true });

const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";
const BASE = "https://www.olx.pt";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jitteredDelay(baseMs, jitter = 0.4) {
  const min = baseMs * (1 - jitter);
  const max = baseMs * (1 + jitter);
  return Math.round(min + Math.random() * (max - min));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt-PT,pt;q=0.9" },
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, body };
}

function looksLikeBlockPage(html) {
  const markers = ["cloudflare", "captcha", "access denied", "just a moment", "request blocked", "attention required"];
  const lower = html.toLowerCase();
  return markers.filter((m) => lower.includes(m));
}

async function main() {
  const summary = { robotsTxt: null, categoryDiscovery: null, burstTest: [] };

  // 1. robots.txt, straight from a real GitHub Actions IP (the earlier
  // check was via a different fetch path and may not reflect what our
  // actual scraper's requests would see).
  console.log("--- robots.txt ---");
  const robots = await fetchText(`${BASE}/robots.txt`);
  writeFileSync("out/robots.txt", robots.body);
  summary.robotsTxt = { status: robots.status, blockMarkers: looksLikeBlockPage(robots.body) };
  console.log(`status=${robots.status} bytes=${robots.body.length} blockMarkers=${JSON.stringify(summary.robotsTxt.blockMarkers)}`);

  await sleep(jitteredDelay(2000));

  // 2. Base imóveis category page — discover the real subcategory/URL
  // structure from links on the page itself, rather than guessing.
  console.log("\n--- /imoveis/ ---");
  const category = await fetchText(`${BASE}/imoveis/`);
  writeFileSync("out/imoveis-category.html", category.body);
  const blockMarkers = looksLikeBlockPage(category.body);
  const $ = cheerio.load(category.body);
  const subcategoryLinks = [...new Set(
    $('a[href*="/imoveis/"]')
      .map((_, el) => $(el).attr("href"))
      .get()
      .filter((href) => href && href.includes("/imoveis/") && href !== "/imoveis/")
  )].slice(0, 15);
  const adDetailLinksOnCategoryPage = $('a[href*="/d/anuncio/"], a[href*="/d/ad/"]').length;
  const priceMatches = (category.body.match(/\d[\d.\s]*\s?€/g) || []).length;
  summary.categoryDiscovery = {
    status: category.status,
    bytes: category.body.length,
    blockMarkers,
    subcategoryLinksFound: subcategoryLinks.length,
    sampleSubcategoryLinks: subcategoryLinks,
    adDetailLinksOnCategoryPage,
    priceLikeMatches: priceMatches,
  };
  console.log(JSON.stringify(summary.categoryDiscovery, null, 2));

  // 3. Burst test: a modest run of sequential requests against real pages
  // (the category page + up to 2 discovered subcategories, each fetched
  // twice), paced like the other sources, to see if anything degrades
  // (429, block page, connection resets) under realistic-ish volume.
  console.log("\n--- burst test ---");
  const targets = [`${BASE}/imoveis/`, ...subcategoryLinks.slice(0, 2).map((h) => (h.startsWith("http") ? h : `${BASE}${h}`))];
  const burstUrls = [];
  for (const t of targets) burstUrls.push(t, t);

  for (const [i, url] of burstUrls.entries()) {
    const start = Date.now();
    let result;
    try {
      const r = await fetchText(url);
      const marks = looksLikeBlockPage(r.body);
      const adLinks = (r.body.match(/\/d\/(anuncio|ad)\//g) || []).length;
      result = { url, status: r.status, bytes: r.body.length, blockMarkers: marks, adLinkMatches: adLinks, ms: Date.now() - start };
      if (i === 0) writeFileSync("out/burst-0.html", r.body);
    } catch (err) {
      result = { url, error: err.message, ms: Date.now() - start };
    }
    summary.burstTest.push(result);
    console.log(JSON.stringify(result));
    if (i < burstUrls.length - 1) await sleep(jitteredDelay(2500));
  }

  writeFileSync("out/summary.json", JSON.stringify(summary, null, 2));
  console.log("\n--- done, summary written to out/summary.json ---");
}

main().catch((err) => {
  console.error("Erro fatal na sonda:", err);
  process.exit(1);
});
