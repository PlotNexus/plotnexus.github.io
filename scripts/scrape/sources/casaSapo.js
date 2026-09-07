import * as cheerio from "cheerio";
import {
  parsePriceEUR,
  parseBedroomsFromText,
  parseAreaM2,
  idFromUrl,
  toAbsoluteUrl,
  normalizeListing,
} from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

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

// Mainland districts plus Madeira — full national coverage, one query per
// district per property type per operation (first results page only; this
// is not a full pagination crawl of every listing CASA SAPO has).
//
// IMPORTANT: CASA SAPO returns HTTP 200 with a generic nationwide "recent
// listings" page (no location filter applied at all) for ANY unrecognised
// location path — including a nonsense slug. The `/comprar-casas/em-X/`
// URL this scraper used to hit was never a real category (confirmed via
// their sitemap.xml) and was silently returning that same generic page for
// every single district, which is why national coverage looked plausible
// but wasn't real (~90 unique listings total, ~90% duplicates across
// districts). The real, sitemap-confirmed pattern is
// `/{comprar,alugar}-{apartamentos,moradias}/distrito.<district>/` — verified
// to return genuinely district-scoped results (e.g. distrito.braganca only
// returns Bragança-district municipalities). The Azores have no equivalent
// `distrito.acores` entry (verified empirically: falls back to the generic
// page too), so they are not covered here.
export const DISTRICTS_FULL = [
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
  "madeira",
];

const OPERATIONS = [
  { pathPrefix: "comprar", type: "venda" },
  { pathPrefix: "alugar", type: "arrendamento" },
];

const PROPERTY_TYPES = ["apartamentos", "moradias"];

function buildQueries(districts) {
  return OPERATIONS.flatMap(({ pathPrefix, type }) =>
    PROPERTY_TYPES.flatMap((propertyType) =>
      districts.map((district) => ({
        url: `https://casa.sapo.pt/${pathPrefix}-${propertyType}/distrito.${district}/`,
        type,
      }))
    )
  );
}

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

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

// Extracts the "Dados do imóvel" grid (Estado, Área útil, Área bruta, Ano
// de construção, Certificação Energética, Publicado em, ...) into a plain
// {label: value} map.
function parseMainFeatures($) {
  const features = {};
  $(".detail-main-features-item").each((_, el) => {
    const title = $(el).find(".detail-main-features-item-title").text().trim();
    const valueEl = $(el).find(".detail-main-features-item-value");
    const energeticSpan = valueEl.find(".energetic-value");
    const value = energeticSpan.length ? energeticSpan.text().trim() : valueEl.text().trim();
    if (title) features[title] = value;
  });
  return features;
}

// Extracts the "Características" tabs (e.g. "Divisões", "Equipamentos") as
// {tabLabel: [item, item, ...]}.
function parseFeatureTabs($) {
  const tabs = {};
  $(".detail-features-menu-content > span").each((_, el) => {
    const label = $(el).text().trim();
    const onclick = $(el).attr("onclick") || "";
    const keyMatch = onclick.match(/changeFeatureTab\(this,\s*'([^']+)'\)/);
    const key = keyMatch ? keyMatch[1] : null;
    if (!label || !key) return;
    const items = $(`.detail-features-menu-content [data-title="${key}"] .detail-features-item`)
      .map((__, item) => $(item).text().trim())
      .get()
      .filter(Boolean);
    if (items.length) tabs[label] = items;
  });
  return tabs;
}

// The full description lives in .detail-description-text with real <br/>
// formatting (unlike the truncated, flattened one in the search-card
// JSON-LD).
function parseFullDescription($) {
  const html = $(".detail-description-text").first().html();
  return cleanDescription(html);
}

// Photo gallery: every photo appears multiple times (two sizes, jpg + webp),
// so dedupe by the shared ID token and keep the larger size, jpg only.
function parseGalleryImages(html) {
  const matches = html.match(/https:\/\/media\.casasapo\.pt\/Z1440x1080\/[^"'\s]+?\.jpg(?!\.webp)/g) || [];
  const seen = new Set();
  const images = [];
  for (const url of matches) {
    if (seen.has(url)) continue;
    seen.add(url);
    images.push(url);
  }
  return images;
}

// "24/08/2026" -> "2026-08-24"
function parsePublishedDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

// Fetches a single listing's own page for the richer detail the search
// results page doesn't expose: full photo gallery, full description,
// characteristics/rooms, and technical data (area útil/bruta, construction
// year, energy certificate, real publish date). Returns null on failure so
// callers can just skip enrichment for that listing rather than fail the
// whole run.
export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const mainFeatures = parseMainFeatures($);
  const publishedAt = parsePublishedDate(mainFeatures["Publicado em"]);

  return {
    images: parseGalleryImages(html),
    description: parseFullDescription($) || null,
    features: parseFeatureTabs($),
    estado: mainFeatures["Estado"] || null,
    area_util_m2: parseAreaM2(mainFeatures["Área útil"]),
    area_bruta_m2: parseAreaM2(mainFeatures["Área bruta"]),
    ano_construcao: mainFeatures["Ano de construção"] ? Number(mainFeatures["Ano de construção"]) : null,
    certificacao_energetica: mainFeatures["Certificação Energética"] || null,
    published_at: publishedAt,
  };
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

// `districts` lets a caller scope this to a subset (used to shard the
// national sweep across parallel GitHub Actions jobs — see worker.js).
// Falls back to SCRAPE_DISTRICTS (comma-separated, for local testing) or
// the full national list.
export async function scrapeCasaSapo({ maxListingsPerQuery = 30, districts } = {}) {
  const resolvedDistricts =
    districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const queries = buildQueries(resolvedDistricts);

  const all = [];
  for (const [i, query] of queries.entries()) {
    try {
      const items = await scrapeQuery(query, maxListingsPerQuery);
      all.push(...items);
    } catch (err) {
      console.error(`[casasapo] falhou em ${query.url}: ${err.message}`);
    }
    if (i < queries.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  console.log(`[casasapo] total: ${all.length} recolhidos, ${deduped.length} únicos após ${queries.length} pesquisas`);
  return deduped;
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
