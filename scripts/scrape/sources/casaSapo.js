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

// CASA SAPO is quite aggressive with rate limiting (a handful of requests
// under ~2s apart is enough to get a 429), so requests are spaced well
// apart and retried with backoff rather than sped up.
const DELAY_BETWEEN_QUERIES_MS = 5000;
const RETRY_BASE_DELAY_MS = 8000;
const MAX_RETRIES = 4;

// Mainland districts plus the two autonomous regions — full national
// coverage, one query per district per operation (first results page only;
// this is not a full pagination crawl of every listing CASA SAPO has).
const DISTRICTS_FULL = [
  "aveiro",
  "beja",
  "braga",
  "braganca",
  "castelo-branco",
  "coimbra",
  "evora",
  "faro",
  "guarda",
  "leiria",
  "lisboa",
  "portalegre",
  "porto",
  "santarem",
  "setubal",
  "viana-do-castelo",
  "vila-real",
  "viseu",
  "acores",
  "madeira",
];
const DISTRICTS = process.env.SCRAPE_DISTRICTS
  ? process.env.SCRAPE_DISTRICTS.split(",")
  : DISTRICTS_FULL;

const OPERATIONS = [
  { pathSegment: "comprar-casas", type: "venda" },
  { pathSegment: "alugar-casas", type: "arrendamento" },
];

const QUERIES = OPERATIONS.flatMap(({ pathSegment, type }) =>
  DISTRICTS.map((district) => ({
    url: `https://casa.sapo.pt/${pathSegment}/em-${district}/`,
    type,
  }))
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-PT,pt;q=0.9",
      },
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${url} continua a responder 429 depois de ${MAX_RETRIES} tentativas`);
      }
      const wait = RETRY_BASE_DELAY_MS * (attempt + 1);
      console.warn(`[casasapo] 429 em ${url}, a aguardar ${wait}ms antes de repetir`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      throw new Error(`${url} respondeu ${res.status}`);
    }

    return res.text();
  }
  throw new Error(`${url}: esgotadas as tentativas`);
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

// The JSON-LD description is free text with literal `<br/>` line breaks
// and a trailing "(...)" truncation marker from CASA SAPO itself.
function cleanDescription(raw) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\(\.\.\.\)\s*$/, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function extractGeo(data) {
  const geo = data.availableAtOrFrom?.geo;
  if (!geo) return null;
  const lat = Number(geo.latitude);
  const lng = Number(geo.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
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
        description: cleanDescription(data.description),
        geo: extractGeo(data),
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

  let listings = extractFromJsonLd($, type);

  if (listings.length === 0) {
    listings = extractByHeuristic($, type);
  }

  console.log(`[casasapo] ${url} -> ${listings.length} anúncios`);
  return listings.slice(0, maxListings);
}

export async function scrapeCasaSapo({ maxListingsPerQuery = 30 } = {}) {
  const all = [];
  for (const [i, query] of QUERIES.entries()) {
    try {
      const items = await scrapeQuery(query, maxListingsPerQuery);
      all.push(...items);
    } catch (err) {
      console.error(`[casasapo] falhou em ${query.url}: ${err.message}`);
    }
    if (i < QUERIES.length - 1) await sleep(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  console.log(`[casasapo] total: ${all.length} recolhidos, ${deduped.length} únicos após ${QUERIES.length} pesquisas`);
  return deduped;
}
