import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync } from "fs";

mkdirSync("out", { recursive: true });

const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

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
  const markers = ["cloudflare", "captcha", "access denied", "just a moment", "request blocked", "attention required", "akamai"];
  const lower = html.toLowerCase();
  return markers.filter((m) => lower.includes(m));
}

async function probeQuatru(summary) {
  console.log("\n========== QUATRU ==========");
  const BASE = "https://www.quatru.pt";
  summary.quatru = {};

  console.log("--- robots.txt ---");
  const robots = await fetchText(`${BASE}/robots.txt`);
  writeFileSync("out/quatru-robots.txt", robots.body);
  summary.quatru.robotsTxt = { status: robots.status, blockMarkers: looksLikeBlockPage(robots.body) };
  console.log(JSON.stringify(summary.quatru.robotsTxt));
  await sleep(jitteredDelay(2000));

  console.log("\n--- sitemap_index.xml ---");
  const sitemapIndex = await fetchText(`${BASE}/sitemap_index.xml`);
  writeFileSync("out/quatru-sitemap-index.xml", sitemapIndex.body);
  const subSitemaps = [...sitemapIndex.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, 30);
  summary.quatru.sitemapIndex = { status: sitemapIndex.status, subSitemapCount: subSitemaps.length, sample: subSitemaps.slice(0, 10) };
  console.log(JSON.stringify(summary.quatru.sitemapIndex, null, 2));
  await sleep(jitteredDelay(2000));

  // Look for a sitemap that sounds like it holds individual property pages
  // (vs. blog posts, static pages, etc.) rather than guessing a URL.
  const propertySitemapUrl = subSitemaps.find((u) => /imov|propert|anuncio|listing/i.test(u)) || subSitemaps[0];
  let listingUrls = [];
  if (propertySitemapUrl) {
    console.log(`\n--- sub-sitemap: ${propertySitemapUrl} ---`);
    const sub = await fetchText(propertySitemapUrl);
    writeFileSync("out/quatru-sub-sitemap.xml", sub.body);
    listingUrls = [...sub.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    summary.quatru.subSitemap = { url: propertySitemapUrl, status: sub.status, urlCount: listingUrls.length, sample: listingUrls.slice(0, 10) };
    console.log(JSON.stringify(summary.quatru.subSitemap, null, 2));
  }
  await sleep(jitteredDelay(2000));

  console.log("\n--- homepage ---");
  const home = await fetchText(`${BASE}/`);
  writeFileSync("out/quatru-home.html", home.body);
  const $ = cheerio.load(home.body);
  const searchLinks = [...new Set($('a[href]').map((_, el) => $(el).attr("href")).get())].filter(
    (h) => /compr|arrend|pesquis|imov|search/i.test(h)
  ).slice(0, 15);
  summary.quatru.homepage = {
    status: home.status,
    bytes: home.body.length,
    blockMarkers: looksLikeBlockPage(home.body),
    searchLinksFound: searchLinks,
  };
  console.log(JSON.stringify(summary.quatru.homepage, null, 2));

  // Burst test: homepage + up to 2 discovered listing URLs (from the
  // sitemap, so real individual property pages) + 1 search link, fetched
  // twice each, paced like the other sources.
  const targets = [`${BASE}/`, ...listingUrls.slice(0, 2), ...(searchLinks[0] ? [searchLinks[0].startsWith("http") ? searchLinks[0] : `${BASE}${searchLinks[0]}`] : [])];
  const burstUrls = targets.flatMap((t) => [t, t]);
  summary.quatru.burstTest = [];
  console.log("\n--- burst test ---");
  for (const [i, url] of burstUrls.entries()) {
    const start = Date.now();
    let result;
    try {
      const r = await fetchText(url);
      const marks = looksLikeBlockPage(r.body);
      const priceMatches = (r.body.match(/\d[\d.\s]*\s?€/g) || []).length;
      result = { url, status: r.status, bytes: r.body.length, blockMarkers: marks, priceLikeMatches: priceMatches, ms: Date.now() - start };
      if (i === 0) writeFileSync("out/quatru-burst-0.html", r.body);
    } catch (err) {
      result = { url, error: err.message, ms: Date.now() - start };
    }
    summary.quatru.burstTest.push(result);
    console.log(JSON.stringify(result));
    if (i < burstUrls.length - 1) await sleep(jitteredDelay(2500));
  }
}

async function probeELeiloes(summary) {
  console.log("\n\n========== E-LEILOES.PT ==========");
  const BASE = "https://www.e-leiloes.pt";
  summary.eleiloes = {};

  console.log("--- robots.txt ---");
  const robots = await fetchText(`${BASE}/robots.txt`);
  writeFileSync("out/eleiloes-robots.txt", robots.body);
  summary.eleiloes.robotsTxt = { status: robots.status, bytes: robots.body.length, blockMarkers: looksLikeBlockPage(robots.body) };
  console.log(JSON.stringify(summary.eleiloes.robotsTxt));
  await sleep(jitteredDelay(2000));

  console.log("\n--- homepage ---");
  const home = await fetchText(`${BASE}/`);
  writeFileSync("out/eleiloes-home.html", home.body);
  const $home = cheerio.load(home.body);
  const homeLinks = [...new Set($home('a[href]').map((_, el) => $home(el).attr("href")).get())]
    .filter((h) => /listagem|imov|leilao|categoria|search/i.test(h))
    .slice(0, 15);
  summary.eleiloes.homepage = {
    status: home.status,
    bytes: home.body.length,
    blockMarkers: looksLikeBlockPage(home.body),
    relevantLinksFound: homeLinks,
  };
  console.log(JSON.stringify(summary.eleiloes.homepage, null, 2));
  await sleep(jitteredDelay(2500));

  console.log("\n--- /listagem.aspx ---");
  const listagem = await fetchText(`${BASE}/listagem.aspx`);
  writeFileSync("out/eleiloes-listagem.html", listagem.body);
  const $list = cheerio.load(listagem.body);
  const forms = $list("form").length;
  const hasImoveisFilter = /im[oó]ve/i.test(listagem.body);
  const priceMatches = (listagem.body.match(/\d[\d.\s]*\s?€/g) || []).length;
  const requiresLoginHints = /login|autenticar|autentica[cç][aã]o|cart[aã]o de cidad[aã]o|chave m[oó]vel/i.test(listagem.body);
  summary.eleiloes.listagem = {
    status: listagem.status,
    bytes: listagem.body.length,
    blockMarkers: looksLikeBlockPage(listagem.body),
    formCount: forms,
    mentionsImoveis: hasImoveisFilter,
    priceLikeMatches: priceMatches,
    requiresLoginHints,
  };
  console.log(JSON.stringify(summary.eleiloes.listagem, null, 2));

  // Burst test against the two real pages fetched above, each twice.
  const burstUrls = [`${BASE}/`, `${BASE}/`, `${BASE}/listagem.aspx`, `${BASE}/listagem.aspx`];
  summary.eleiloes.burstTest = [];
  console.log("\n--- burst test ---");
  for (const [i, url] of burstUrls.entries()) {
    await sleep(jitteredDelay(2500));
    const start = Date.now();
    let result;
    try {
      const r = await fetchText(url);
      const marks = looksLikeBlockPage(r.body);
      result = { url, status: r.status, bytes: r.body.length, blockMarkers: marks, ms: Date.now() - start };
    } catch (err) {
      result = { url, error: err.message, ms: Date.now() - start };
    }
    summary.eleiloes.burstTest.push(result);
    console.log(JSON.stringify(result));
  }
}

async function main() {
  const summary = {};
  await probeQuatru(summary).catch((err) => {
    console.error("Quatru probe falhou:", err);
    summary.quatru = { ...(summary.quatru || {}), fatalError: err.message };
  });
  await probeELeiloes(summary).catch((err) => {
    console.error("e-leiloes probe falhou:", err);
    summary.eleiloes = { ...(summary.eleiloes || {}), fatalError: err.message };
  });
  writeFileSync("out/summary.json", JSON.stringify(summary, null, 2));
  console.log("\n\n--- done, summary written to out/summary.json ---");
}

main().catch((err) => {
  console.error("Erro fatal na sonda:", err);
  process.exit(1);
});
