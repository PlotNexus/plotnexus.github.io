import * as cheerio from "cheerio";
import {
  parsePriceEUR,
  parseAreaM2,
  idFromUrl,
  toAbsoluteUrl,
  normalizeListing,
} from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

const SOURCE_NAME = "Sotheby's International Realty";
const SOURCE_URL = "https://www.sothebysrealtypt.com";
const LOADER_URL = `${SOURCE_URL}/conteudos/imoveis/loader.aspx`;
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 3000;
const RETRY_BASE_DELAY_MS = 7000;
const MAX_RETRIES = 4;

// The search page's own "página seguinte" links/path look pageable, but
// they aren't — the real pagination is entirely client-side: the page's
// jQuery builds a `parametrosObj` from the visible filter form and POSTs
// it to this undocumented endpoint (found by digging through the page's
// own JS bundle, assets/release/js/all.min.js, for the literal ajax() call
// — the same technique era.js's own comment describes for a different
// site). `grupo=1,2` restricts to Apartamentos+Moradias (the same two
// residential categories the search page itself pre-checks by default;
// left unset it also returns land/shops/offices/warehouses etc., which
// isn't a residential sale or rental).
const GRUPO_RESIDENCIAL = "1,2";
const OPERATIONS = [
  { objectivo: 1, type: "venda" },
  { objectivo: 2, type: "arrendamento" },
];

const PAGE_SIZE = 12;
const BUCKET_COUNT = 4;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

async function loaderPage(objectivo, page) {
  return fetchHtml(LOADER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: `pagina=${page}&objectivo=${objectivo}&tipoPesquisa=2&grupo=${GRUPO_RESIDENCIAL}&textual=`,
  });
}

function parseTotal(html) {
  const match = /class="total-imoveis">\s*<b>(\d+)<\/b>/.exec(html);
  return match ? Number(match[1]) : 0;
}

function iconValue($, card, title) {
  return $(card).find(`[title="${title}"] .valor`).first().text().replace(/\s+/g, " ").trim();
}

// Same icon+.valor markup as a search card's, but at the top of the detail
// page rather than scoped to one card — looked up directly on the document.
function pageIconValue($, title) {
  return $(`[title="${title}"] .valor`).first().text().replace(/\s+/g, " ").trim();
}

function parseIntFromText(text) {
  const match = String(text || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function extractListings(html, type) {
  const $ = cheerio.load(html);
  const listings = [];

  $(".modulo-imovel-item").each((_, el) => {
    const href = $(el).find(".lnk_imagem").first().attr("href");
    if (!href) return;
    const listingUrl = toAbsoluteUrl(href, SOURCE_URL);
    if (!listingUrl) return;

    const title = $(el).find(".mad-card-titulo").first().text().replace(/\s+/g, " ").trim();
    const price = parsePriceEUR($(el).find(".mad-preco").first().text());
    if (!title || !price) return;

    // On a search card (unlike the detail page's own gallery, where the two
    // attributes always agree), data-imgurl is actually the generic
    // onerror fallback image, not the real photo — confirmed by hand: it
    // was "/assets/release/images/imovel0.jpg" (the fallback) while src had
    // the real mediaf*.sothebysrealtypt.com photo. src is the real one here.
    const img = $(el).find("img").first();
    const image = img.attr("src") || img.attr("data-imgurl") || null;

    listings.push(
      normalizeListing({
        id: idFromUrl(listingUrl, "sothebys"),
        title,
        type,
        price,
        location: title,
        bedrooms: parseIntFromText(iconValue($, el, "Quartos")),
        bathrooms: parseIntFromText(iconValue($, el, "C. Banho")),
        area_m2: parseAreaM2(iconValue($, el, "Área construção")),
        image: image ? image.replace(/&amp;/g, "&") : null,
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      })
    );
  });

  return listings.filter(Boolean);
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

async function scrapeOperationBucket(objectivo, type, bucketIndex, totalPages, maxPages) {
  const listings = [];
  for (
    let page = bucketIndex + 1;
    page <= totalPages && page <= bucketIndex + 1 + maxPages * BUCKET_COUNT;
    page += BUCKET_COUNT
  ) {
    let html;
    try {
      html = await loaderPage(objectivo, page);
    } catch (err) {
      console.error(`[sothebys] falhou ${type}, bloco ${bucketIndex}, página ${page}: ${err.message}`);
      continue;
    }
    listings.push(...extractListings(html, type));
    if (page + BUCKET_COUNT <= totalPages) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  return listings;
}

export async function scrapeSothebys({ maxPagesPerBucket = 80, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);
  if (bucketIndices.length === 0) return [];

  const all = [];
  for (const { objectivo, type } of OPERATIONS) {
    let totalPages;
    try {
      const first = await loaderPage(objectivo, 1);
      const total = parseTotal(first);
      totalPages = Math.ceil(total / PAGE_SIZE);
      console.log(`[sothebys] ${type}: ${total} imóveis no total, ${totalPages} páginas`);
      all.push(...extractListings(first, type));
    } catch (err) {
      console.error(`[sothebys] falhou o pedido inicial de ${type}: ${err.message}`);
      continue;
    }
    await sleepJittered(DELAY_BETWEEN_QUERIES_MS);

    // Bucket 0's own stride starts at page 1 too, which was already fetched
    // just above (needed to learn the real total) — one harmless repeat
    // request for that bucket specifically, not worth special-casing away.
    for (const [i, bucketIndex] of bucketIndices.entries()) {
      const items = await scrapeOperationBucket(objectivo, type, bucketIndex, totalPages, maxPagesPerBucket);
      all.push(...items);
      if (i < bucketIndices.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  console.log(`[sothebys] total: ${all.length} recolhidos, ${deduped.length} únicos`);
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

// Each category's value is a single ";"-separated string (e.g. "Companhia,
// Furo;") rather than its own repeated markup, unlike CASA SAPO/ComprarCasa's
// tabbed lists — split on top-level "," after dropping the trailing ";". A
// plain split(",") would also cut inside a parenthesised sub-list (e.g.
// "Estores (Alumínio, Eléctricos, Térmicos)" into three broken fragments),
// so commas inside ( ) are protected first.
function splitTopLevelCommas(text) {
  let depth = 0;
  let current = "";
  const parts = [];
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseFeatures($) {
  const features = {};
  $(".caracteristica-holder").each((_, el) => {
    const label = $(el).find(".nome-caracteristica").text().trim();
    const raw = $(el).find(".detalhe-texto").text().replace(/;\s*$/, "").trim();
    if (!label || !raw) return;
    features[label] = splitTopLevelCommas(raw).map((s) => s.trim()).filter(Boolean);
  });
  return features;
}

function findFeature(features, labelPattern) {
  for (const [label, items] of Object.entries(features)) {
    if (labelPattern.test(label)) return items.join(", ");
  }
  return null;
}

function parseGalleryImages($) {
  const seen = new Set();
  const images = [];
  $(".galeria-fotos li.foto img").each((_, el) => {
    const url = ($(el).attr("data-imgurl") || $(el).attr("src") || "").replace(/&amp;/g, "&");
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push(url);
  });
  return images;
}

function parseGeo($) {
  const lat = Number($("[data-lat]").first().attr("data-lat"));
  const lng = Number($("[data-lon]").first().attr("data-lon"));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const features = parseFeatures($);
  const anoMatch = /\b(19|20)\d{2}\b/.exec(findFeature(features, /constru/i) || "");

  return {
    images: parseGalleryImages($),
    description: cleanDescription($(".descricao .mad-texto").first().html()),
    features,
    estado: findFeature(features, /^estado$/i),
    area_util_m2: parseAreaM2(pageIconValue($, "Área privativa")),
    area_bruta_m2: parseAreaM2(pageIconValue($, "Área construção")),
    ano_construcao: anoMatch ? Number(anoMatch[0]) : null,
    certificacao_energetica: $("#cph1_moduloimoveisdetalhe_img_certificacao").attr("title") || null,
    bathrooms: parseIntFromText(pageIconValue($, "C. Banho")),
    geo: parseGeo($),
    published_at: null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
