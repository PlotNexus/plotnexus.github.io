import { idFromUrl, normalizeListing } from "../lib/normalize.js";
import { createFetcher } from "../lib/http.js";
import { cutAtLanguageSwitch } from "../lib/languageGuard.js";

const SOURCE_NAME = "Idealista";
const SOURCE_URL = "https://www.idealista.pt";
const API_HOST = "idealista-real-estate.p.rapidapi.com";
const API_BASE = `https://${API_HOST}`;
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// Idealista itself blocks plain HTTP requests outright (DataDome) and, even
// with a real browser, an anti-abuse layer restricts sustained volume from
// datacenter IPs — see the README's "Fontes investigadas mas ainda não
// viáveis" history. This goes through a third-party paid API
// (idealista-real-estate on RapidAPI) instead: a normal authenticated REST
// call, no browser, no anti-bot cat-and-mouse — but metered on a free tier
// of only 750 requests/month, which is why this source's request budget is
// far tighter than every other one here.
const DELAY_BETWEEN_QUERIES_MS = 2500;
const RETRY_BASE_DELAY_MS = 4000;
const MAX_RETRIES = 1; // quota is scarce; a retry storm on a bad request is expensive, not helpful

// Resolved once via /v1/locations/autocomplete (country=pt) and hardcoded
// here since they never change — Idealista's location ids are opaque and
// not worth re-resolving every run. Priority locations get swept twice as
// often as secondary ones in the rotation below (see ROTATION_CYCLE).
const PRIORITY_LOCATIONS = [
  { id: "0-EU-PT-11", name: "Lisboa" },
  { id: "0-EU-PT-06", name: "Coimbra" },
  { id: "0-EU-PT-06-11", name: "Oliveira do Hospital" },
  { id: "0-EU-PT-06-16", name: "Tábua" },
  { id: "0-EU-PT-18-14", name: "Santa Comba Dão" },
];
const SECONDARY_LOCATIONS = [
  { id: "0-EU-PT-13", name: "Porto" },
  { id: "0-EU-PT-08", name: "Faro" },
];
const OPERATIONS = ["sale", "rent"];

// A single sentinel "district" rather than a real per-shard list: with
// SHARD_COUNT=4, myShare()'s `i % shardCount === shardIndex` confines this
// one-element list to shard 0 only (every other shard gets an empty slice
// and never even calls scrape()). That's deliberate — splitting an
// already-tiny 750/month budget four ways would leave each shard with
// less than two requests to work with.
export const DISTRICTS_FULL = ["rotating"];

// Every (location, operation) pair the rotation can land on, one entry
// consumed per run (see scrapeIdealista). Priority locations are listed
// twice so they come up roughly twice as often as Porto/Faro.
function buildRotationCycle() {
  const combos = [];
  for (let round = 0; round < 2; round++) {
    for (const loc of PRIORITY_LOCATIONS) for (const op of OPERATIONS) combos.push({ loc, op });
  }
  for (const loc of SECONDARY_LOCATIONS) for (const op of OPERATIONS) combos.push({ loc, op });
  return combos;
}
const ROTATION_CYCLE = buildRotationCycle();

// Advances by exactly one per scheduled run (every 6h, matching
// .github/workflows/scrape.yml's cron) without needing any persisted
// state — just the wall clock. An extra manual run just burns one cycle
// slot a little early; harmless.
//
// Slots count from ROTATION_EPOCH (when this rotation shipped) rather
// than from the Unix epoch — counting from 1970 would land the very
// first run on whatever remainder that many 6h slots happens to leave,
// which turned out to be Faro, not one of the priority locations this
// was built to favour. Anchoring "now" as slot 0 means the first run
// after deploy starts at the top of the cycle (Lisboa) and rotates
// forward from there, same as always after that.
const ROTATION_EPOCH = Date.parse("2026-09-09T14:27:00Z");
const SLOT_MS = 6 * 60 * 60 * 1000;
function currentSlot() {
  return Math.floor((Date.now() - ROTATION_EPOCH) / SLOT_MS);
}

const HOME_TYPE_LABELS = {
  flat: "Apartamento",
  chalet: "Moradia",
  duplex: "Apartamento Duplex",
  penthouse: "Apartamento (Cobertura)",
  studio: "Estúdio",
  countryHouse: "Casa de Campo",
};
function homeTypeLabel(propertyType) {
  return HOME_TYPE_LABELS[propertyType] || "Imóvel";
}

const STATUS_LABELS = {
  good: "Bom estado",
  renew: "Para remodelar",
  newdevelopment: "Novo",
};

const fetchJson = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

async function apiGet(pathname, params = {}) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error("RAPIDAPI_KEY não está definida");

  const url = new URL(`${API_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }

  const text = await fetchJson(url.toString(), {
    headers: { "x-rapidapi-key": key, "x-rapidapi-host": API_HOST, accept: "application/json" },
  });
  return JSON.parse(text);
}

async function searchOnce({ locationId, operation }) {
  const data = await apiGet("/v1/search", {
    operation,
    propertyType: "homes",
    locationIds: `[${locationId}]`,
    country: "pt",
    maxItems: 40,
  });
  return data.elementList || [];
}

// Only structured, enum-like fields feed the title/location — Idealista
// aggregates listings from agencies across Spain/Portugal/Italy, and
// several of the API's own free-text fields (description, address) come
// back in Spanish even for Portuguese listings, so nothing free-text is
// safe to pass through untranslated here (see fetchListingDetail for how
// the detail endpoint's propertyComment, which genuinely is Portuguese,
// is handled instead).
function buildTitle(item) {
  const typeLabel = homeTypeLabel(item.propertyType);
  const bedroomsPart = item.rooms ? ` T${item.rooms}` : "";
  const place = item.municipality || item.province || "";
  return `${typeLabel}${bedroomsPart}${place ? ` em ${place}` : ""}`;
}

function toSummary(item) {
  if (!item.price) return null;
  return normalizeListing({
    id: idFromUrl(item.url, "idealista"),
    title: buildTitle(item),
    type: item.operation === "rent" ? "arrendamento" : "venda",
    price: item.price,
    location: [item.municipality, item.province].filter(Boolean).join(", "),
    bedrooms: item.rooms ?? null,
    bathrooms: item.bathrooms ?? null,
    area_m2: item.size ?? null,
    // Idealista's own photo URLs are signed and expire in ~24h (confirmed
    // empirically: the same URL without its signature 403s) — nowhere near
    // long enough to survive in a cache refreshed only occasionally, unlike
    // every other source's stable image URLs. Skipping photos entirely
    // rather than shipping links that go dead within a day; "Ver anúncio
    // original" still gets users to the real gallery on Idealista's site.
    image: null,
    geo: Number.isFinite(item.latitude) && Number.isFinite(item.longitude) ? { lat: item.latitude, lng: item.longitude } : null,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    listingUrl: item.url,
  });
}

export async function scrapeIdealista({ districts } = {}) {
  if (!districts || districts.length === 0) return [];
  if (!process.env.RAPIDAPI_KEY) {
    console.error("[idealista] RAPIDAPI_KEY não definida — a saltar esta fonte");
    return [];
  }

  const slot = currentSlot();
  // JS's % is remainder, not modulo — a negative slot (only possible if
  // this ever runs before ROTATION_EPOCH) would otherwise index
  // backwards off the array instead of wrapping.
  const index = ((slot % ROTATION_CYCLE.length) + ROTATION_CYCLE.length) % ROTATION_CYCLE.length;
  const combo = ROTATION_CYCLE[index];
  console.log(`[idealista] ciclo ${slot} -> ${combo.loc.name} (${combo.op === "rent" ? "arrendar" : "comprar"})`);

  let elements;
  try {
    elements = await searchOnce({ locationId: combo.loc.id, operation: combo.op });
  } catch (err) {
    console.error(`[idealista] pesquisa falhou (${combo.loc.name}, ${combo.op}): ${err.message}`);
    return [];
  }

  const listings = elements.map(toSummary).filter(Boolean);
  console.log(`[idealista] ${combo.loc.name} (${combo.op}) -> ${listings.length} anúncios`);
  return listings;
}

function buildFeatures(translatedTexts) {
  const groups = translatedTexts?.characteristicsDescriptions || [];
  const result = {};
  for (const group of groups) {
    const items = (group.detailFeatures || []).map((f) => f.phrase?.trim()).filter(Boolean);
    if (items.length) result[group.title || "Características"] = items;
  }
  return result;
}

function extractConstructionYear(translatedTexts) {
  const groups = translatedTexts?.characteristicsDescriptions || [];
  for (const group of groups) {
    for (const feature of group.detailFeatures || []) {
      const match = /constru[ií]do em (\d{4})/i.exec(feature.phrase || "");
      if (match) return Number(match[1]);
    }
  }
  return null;
}

function propertyCodeFromUrl(listingUrl) {
  const match = /\/imovel\/(\d+)/.exec(listingUrl);
  return match ? match[1] : null;
}

export async function fetchListingDetail(listingUrl) {
  const propertyCode = propertyCodeFromUrl(listingUrl);
  if (!propertyCode) throw new Error(`${listingUrl}: não foi possível extrair o propertyCode`);

  const p = await apiGet(`/v1/property/${propertyCode}`, { country: "pt", locale: "pt" });
  const mc = p.moreCharacteristics || {};
  const geo =
    p.ubication && Number.isFinite(p.ubication.latitude) && Number.isFinite(p.ubication.longitude)
      ? { lat: p.ubication.latitude, lng: p.ubication.longitude }
      : null;

  return {
    // See toSummary — same expiring-URL problem, so no photos here either.
    images: [],
    description: p.propertyComment
      ? cutAtLanguageSwitch(String(p.propertyComment).trim(), { splitPattern: /\n{2,}/, joinSeparator: "\n\n" })
      : null,
    features: buildFeatures(p.translatedTexts),
    estado: STATUS_LABELS[mc.status] || null,
    area_util_m2: mc.usableArea ?? null,
    area_bruta_m2: mc.constructedArea ?? null,
    ano_construcao: extractConstructionYear(p.translatedTexts),
    certificacao_energetica: mc.energyCertificationType ? mc.energyCertificationType.toUpperCase() : null,
    bathrooms: mc.bathNumber ?? null,
    geo,
    published_at: null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
