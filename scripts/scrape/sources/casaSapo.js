import * as cheerio from "cheerio";
import {
  parsePriceEUR,
  parseBedroomsFromText,
  parseAreaM2,
  idFromUrl,
  toAbsoluteUrl,
  normalizeListing,
} from "../lib/normalize.js";

const SOURCE_NAME = "CASA SAPO";
const SOURCE_URL = "https://casa.sapo.pt";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// Each query is a separate search (CASA SAPO uses distinct URLs per
// operation/location rather than query-string filters).
const QUERIES = [
  { url: "https://casa.sapo.pt/comprar-casas/em-lisboa/", type: "venda" },
  { url: "https://casa.sapo.pt/alugar-casas/em-lisboa/", type: "arrendamento" },
  { url: "https://casa.sapo.pt/comprar-casas/em-porto/", type: "venda" },
  { url: "https://casa.sapo.pt/alugar-casas/em-porto/", type: "arrendamento" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-PT,pt;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`${url} respondeu ${res.status}`);
  }
  return res.text();
}

// CASA SAPO wraps listing links in an ad-tracking redirect
// (gespub.casa.sapo.pt/.../counter.aspx?...&l=<real url>). Prefer the real
// destination when present, both for a cleaner link and a stable id.
function resolveRealListingUrl(absoluteUrl) {
  try {
    const parsed = new URL(absoluteUrl);
    if (parsed.hostname.includes("gespub.casa.sapo.pt")) {
      const real = parsed.searchParams.get("l");
      if (real) return real;
    }
  } catch {
    // fall through
  }
  return absoluteUrl;
}

function firstImage(image) {
  if (Array.isArray(image)) return image[0] || null;
  return typeof image === "string" ? image : null;
}

// Primary strategy: each listing card embeds a schema.org Offer as
// <script type="application/ld+json"> with a clean title, description,
// image and address — far more reliable than scraping the rendered text.
// The Offer itself has no url, so we resolve it from the anchor inside
// the same card container, and pull area/condition from that container's
// visible text (the JSON description is free text and can mention an
// unrelated lot size instead of the living area).
function extractFromJsonLd($, type) {
  const listings = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    if (data["@type"] !== "Offer" && data["@type"] !== "Product") return;

    // A property can be listed for both sale and rent at once, in which
    // case `price` holds both values with no label telling them apart —
    // e.g. ["5.500.000 €", "16.000 €"]. A rent is always far smaller than
    // a sale price for the same property, so pick the min for a rental
    // search and the max for a sale search.
    const priceCandidates = (Array.isArray(data.price) ? data.price : [data.price])
      .map(parsePriceEUR)
      .filter((p) => p != null);
    if (priceCandidates.length === 0 || !data.name) return;
    const price = type === "arrendamento" ? Math.min(...priceCandidates) : Math.max(...priceCandidates);

    const container = $(el).closest('[id^="property_"]');
    const anchorHref = container.find("a[href]").first().attr("href");
    const absoluteAnchor = anchorHref ? toAbsoluteUrl(anchorHref, SOURCE_URL) : null;
    if (!absoluteAnchor) return;
    const listingUrl = resolveRealListingUrl(absoluteAnchor);

    const containerClone = container.clone();
    containerClone.find("script").remove();
    const visibleText = containerClone.text().replace(/\s+/g, " ").trim();

    const address = data.availableAtOrFrom?.address || {};
    const location = [address.addressRegion, address.addressLocality].filter(Boolean).join(", ");

    listings.push(
      normalizeListing({
        id: idFromUrl(listingUrl, "casasapo"),
        title: data.name,
        type,
        price,
        location,
        bedrooms: parseBedroomsFromText(data.name),
        area_m2: parseAreaM2(visibleText),
        image: firstImage(data.image),
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      })
    );
  });

  return listings.filter(Boolean);
}

// Fallback used only if the JSON-LD strategy finds nothing (e.g. the page
// markup changes) — scans anchors for a price nearby in the visible text.
function extractByHeuristic($, type) {
  const priceRegex = /\d{1,3}(?:[.\s]\d{3})*\s*€/;
  const candidates = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const absoluteUrl = toAbsoluteUrl(href, SOURCE_URL);
    if (!absoluteUrl || !absoluteUrl.includes("sapo.pt")) return;

    const looksLikeListing = /\/\d{5,}(?:$|[/?])/.test(absoluteUrl) || /apartamento|moradia|t\d/i.test(absoluteUrl);
    if (!looksLikeListing) return;

    const block = $(el).text().replace(/\s+/g, " ").trim();
    if (!priceRegex.test(block)) return;

    candidates.push({ listingUrl: resolveRealListingUrl(absoluteUrl), block });
  });

  console.log(`[casasapo] heuristic fallback: ${candidates.length} candidate anchors matched a price`);

  const listings = [];
  const seen = new Set();
  for (const { listingUrl, block } of candidates) {
    if (seen.has(listingUrl)) continue;
    seen.add(listingUrl);

    const price = parsePriceEUR(block);
    if (!price) continue;

    listings.push(
      normalizeListing({
        id: idFromUrl(listingUrl, "casasapo"),
        title: block.slice(0, 90),
        type,
        price,
        location: "",
        bedrooms: parseBedroomsFromText(block),
        area_m2: parseAreaM2(block),
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      })
    );
  }
  return listings.filter(Boolean);
}

async function scrapeQuery({ url, type }, maxListings) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  console.log(`[casasapo] fetched ${url} (${html.length} bytes)`);

  let listings = extractFromJsonLd($, type);
  console.log(`[casasapo] ${url} — JSON-LD strategy: ${listings.length} listings`);

  if (listings.length === 0) {
    listings = extractByHeuristic($, type);
    console.log(`[casasapo] ${url} — heuristic strategy: ${listings.length} listings`);
  }

  return listings.slice(0, maxListings);
}

export async function scrapeCasaSapo({ maxListingsPerQuery = 20 } = {}) {
  const all = [];
  for (const [i, query] of QUERIES.entries()) {
    try {
      const items = await scrapeQuery(query, maxListingsPerQuery);
      all.push(...items);
    } catch (err) {
      console.error(`[casasapo] falhou em ${query.url}:`, err.message);
    }
    if (i < QUERIES.length - 1) await sleep(800);
  }

  const seen = new Set();
  return all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
