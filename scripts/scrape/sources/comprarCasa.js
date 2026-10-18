import * as cheerio from "cheerio";
import {
  parsePriceEUR,
  parseAreaM2,
  idFromUrl,
  toAbsoluteUrl,
  normalizeListing,
} from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

const SOURCE_NAME = "ComprarCasa";
const SOURCE_URL = "https://www.comprarcasa.pt";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 4000;
const RETRY_BASE_DELAY_MS = 7000;
const MAX_RETRIES = 4;

// The search results page shows no location/district filter of its own in
// practice (every dash-separated placeholder in the URL below was tested
// empty and still returns the same unfiltered national result set — the
// site is a single nationwide franchise listing, not district-partitioned
// like CASA SAPO), so there's nothing to shard by location. Sharding by
// abstract page-stride buckets instead (same trick era.js uses for its own
// unrelated reason) spreads the ~60-120 pages of a national sweep across
// GitHub Actions' 4 parallel jobs.
const PAGE_SIZE = 16;
const BUCKET_COUNT = 4;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

// The "1" right after /imoveis/ in the URL is NOT the page number — it's a
// fixed part of the path (confirmed: requesting it as 1, 5, 9, ... returns
// either identical or empty results every time). The real, zero-indexed
// page lives in the `p` query parameter instead (confirmed: p=0/1/2 each
// return a genuinely different, non-overlapping set of listing ids).
function searchUrl(page) {
  return `${SOURCE_URL}/imoveis/1/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/0,0,0,1?p=${page - 1}&el=${PAGE_SIZE}`;
}

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

// Despite the URL only ever asking for "Comprar", the actual results mix
// venda/arrendamento/trespasse together — each card's own href encodes which
// (.../<tipo>/<tipologia>/<operação>/<local>/<estado>) so that's read back
// off the link itself rather than trusted from the query. Trespasse (selling
// a commercial lease/goodwill, not the property itself) isn't a residential
// sale or rental, so it's dropped.
// The operation path segment isn't always the literal word: a rental can be
// "arrendamento-ao-ano", "arrendamento-ferias", etc. — matched by prefix,
// not an exact "/arrendamento/" segment (confirmed by hand: that exact
// check silently dropped every single rental card on a real search page).
function operationFromHref(href) {
  // /imovel/<tipo>/<tipologia>/<operação>/<local>/<estado>?id=...
  const segment = href.split("/")[4] || "";
  if (segment.startsWith("venda")) return "venda";
  if (segment.startsWith("arrendamento")) return "arrendamento";
  return null;
}

function iconText($, card, iconClass) {
  return $(card).find(`li:has(i.${iconClass})`).text().replace(/\s+/g, " ").trim();
}

function parseIntFromText(text) {
  const match = String(text || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

// Each card's og-style background image comes from the active carousel
// slide; the rest only carry a lazy-loaded `data-bg`, never a plain `src`.
function firstCardImage($, card) {
  const style = $(card).find(".carousel-item.active").attr("style") || "";
  const match = style.match(/url\(([^)]+)\)/);
  if (match) return match[1];
  return $(card).find(".carousel-item[data-bg]").first().attr("data-bg") || null;
}

function extractListings($) {
  const listings = [];
  $("a.prop").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const operation = operationFromHref(href);
    if (!operation) return;

    const listingUrl = toAbsoluteUrl(href, SOURCE_URL);
    if (!listingUrl) return;

    const titleLine = $(el).find(".prop_title").first().text().replace(/\s+/g, " ").trim();
    const price = parsePriceEUR(titleLine);
    const title = titleLine.split("|")[0].trim() || titleLine;
    if (!price || !title) return;

    listings.push(
      normalizeListing({
        id: idFromUrl(listingUrl, "comprarcasa"),
        title,
        type: operation,
        price,
        location: $(el).find(".prop_subTitle").first().text().replace(/\s+/g, " ").trim(),
        bedrooms: parseIntFromText(iconText($, el, "icon-bed")),
        bathrooms: parseIntFromText(iconText($, el, "icon-bath")),
        area_m2: parseAreaM2(iconText($, el, "icon-housearea")),
        image: firstCardImage($, el),
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      })
    );
  });
  return listings.filter(Boolean);
}

async function scrapePage(page) {
  const html = await fetchHtml(searchUrl(page));
  const $ = cheerio.load(html);
  return extractListings($);
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

async function scrapeBucket(bucketIndex, maxPages) {
  const listings = [];
  let emptyStreak = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = bucketIndex + 1 + i * BUCKET_COUNT;
    let items;
    try {
      items = await scrapePage(page);
    } catch (err) {
      console.error(`[comprarcasa] falhou bucket ${bucketIndex}, página ${page}: ${err.message}`);
      break;
    }
    if (items.length === 0) {
      // The site repeats the last page's results rather than 404ing past
      // the end, so two consecutive empty pages (not just one, in case a
      // single page genuinely has zero matching cards for this bucket's
      // stride) is the real end-of-results signal.
      emptyStreak++;
      if (emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
      listings.push(...items);
    }
    await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  console.log(`[comprarcasa] bucket ${bucketIndex} -> ${listings.length} anúncios`);
  return listings;
}

export async function scrapeComprarCasa({ maxPagesPerBucket = 40, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);
  if (bucketIndices.length === 0) return [];

  const all = [];
  for (const [i, bucketIndex] of bucketIndices.entries()) {
    const items = await scrapeBucket(bucketIndex, maxPagesPerBucket);
    all.push(...items);
    if (i < bucketIndices.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  console.log(`[comprarcasa] total: ${all.length} recolhidos, ${deduped.length} únicos`);
  return deduped;
}

function cleanDescription(html) {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

// The "Detalhes gerais do imóvel" block is a flat {label: value} list (unlike
// the tabbed "Características" block below it, which groups into named
// categories) — each row's own label is the field name, so no translation
// dictionary is needed to find a specific one (área útil, estado, ...).
function parseMainDetails($) {
  const details = {};
  $(".block_list li").each((_, el) => {
    const label = $(el).find("span").first().text().replace(":", "").trim();
    const value = $(el).clone().find("span").remove().end().text().replace(/\s+/g, " ").trim();
    if (label) details[label] = value;
  });
  return details;
}

function parseFeatureTabs($) {
  const tabs = {};
  $(".blockTabs_tabsList a").each((_, el) => {
    const label = $(el).text().trim();
    const anchor = ($(el).attr("href") || "").replace("#", "");
    if (!label || !anchor) return;
    const items = $(`#${anchor} .blockTabs_list li`)
      .map((__, item) => $(item).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    if (items.length) tabs[label] = items;
  });
  return tabs;
}

function findEnergyCert(tabs) {
  for (const items of Object.values(tabs)) {
    for (const item of items) {
      const match = /certifica[cç][aã]o energ[eé]tica:\s*([a-g][+]?)/i.exec(item);
      if (match) return match[1].toUpperCase();
    }
  }
  return null;
}

// Every photo appears twice: once plain (full resolution) and once with a
// &width=...&height=...&mode=crop thumbnail suffix — dedupe by the shared
// UUID filename and keep the unsized (full-res) copy.
function parseGalleryImages(html) {
  const matches = html.match(/https:\/\/cdn\.proppy\.app\/propertyphotos\/[^"'\s]+?\?quality=\d+(?![^"'\s]*&amp;width)/g) || [];
  const seen = new Set();
  const images = [];
  for (const raw of matches) {
    const url = raw.replace(/&amp;/g, "&");
    if (seen.has(url)) continue;
    seen.add(url);
    images.push(url);
  }
  return images;
}

function parseGeo($) {
  const lat = Number($("[data-lat]").first().attr("data-lat"));
  const lng = Number($("[data-lng]").first().attr("data-lng"));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const mainDetails = parseMainDetails($);
  const tabs = parseFeatureTabs($);

  return {
    images: parseGalleryImages(html),
    description: cleanDescription($(".description-container .block_text").first().html()),
    features: tabs,
    estado: mainDetails["Estado"] || null,
    area_util_m2: parseAreaM2(mainDetails["Área útil"]),
    area_bruta_m2: parseAreaM2(mainDetails["Área bruta"]),
    ano_construcao: mainDetails["Ano de construção"] ? parseIntFromText(mainDetails["Ano de construção"]) : null,
    certificacao_energetica: findEnergyCert(tabs),
    bathrooms: parseIntFromText(mainDetails["Casas de Banho"]),
    geo: parseGeo($),
    published_at: null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
