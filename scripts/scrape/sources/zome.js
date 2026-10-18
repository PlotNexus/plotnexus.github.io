import {
  parseBedroomsFromText,
  parseAreaM2,
  idFromUrl,
  normalizeListing,
} from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

const SOURCE_NAME = "Zome";
const SOURCE_URL = "https://www.zome.pt";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// Zome's own public site (a Nuxt.js SPA) never renders a single listing in
// its initial HTML or embedded __NUXT__ state — every page is a client-side
// fetch. The real backend, found by downloading and statically searching
// every JS chunk the search page loads for Supabase's distinctive
// `.from("table").select(...)` query-builder calls, is a Supabase project
// (luvskhnljpxllkxpeasu) with a public "publishable" key — the same class
// of client-side credential as the ERA anti-forgery token or the Sotheby's
// loader.aspx endpoint elsewhere in this file's sibling sources, not
// anything bypassing real access control (confirmed directly against the
// live API, with the user's explicit authorization, after the exact table
// name needed one more confirmation: PostgREST's own 404 error for a
// plausible-but-wrong guess, "tab_listing", helpfully suggested the real
// one, "tab_listing_list").
const SUPABASE_URL = "https://luvskhnljpxllkxpeasu.supabase.co/rest/v1";
const SUPABASE_KEY = "sb_publishable_fY6BgFcFONgcOhMf1Snqjw_qwwJY2zk";
const SUPABASE_SCHEMA = "pt_prod";

const DELAY_BETWEEN_QUERIES_MS = 2500;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

const OPERATIONS = [
  { idtiponegocio: 1, type: "venda" },
  { idtiponegocio: 2, type: "arrendamento" },
];

// Residential-only scope, matching the other sources — but checked
// client-side in toSummary() below (era.js's isResidential() does the
// same), not server-side: `tipoimovel` looks like a jsonb column (its
// value is a per-language object) but is actually plain text holding a
// JSON *string* (confirmed: the raw API response shows escaped quotes
// inside the field's own string value) — PostgREST's `->>` JSON-path
// filter operator silently matched zero rows against it instead of
// erroring, which is what first revealed the mismatch.
const RESIDENTIAL_TYPES = new Set(["Apartamento", "Moradia"]);

const PAGE_SIZE = 100;
const BUCKET_COUNT = 4;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Accept-Profile": SUPABASE_SCHEMA,
  };
}

// Several columns (tipoimovel, tipologiaimovel, txtcondicaoimovel, ...) are
// a per-language object, but stored as a JSON *string* rather than a native
// jsonb value — confirmed directly in the raw API response, which shows
// escaped quotes inside the field's own string value — so they need a
// second JSON.parse() on top of the response body's own.
function parseLangJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function langText(raw, lang = "PT") {
  const parsed = parseLangJson(raw);
  return parsed ? (parsed[lang] || "").trim() : "";
}

const SEARCH_SELECT = [
  "id",
  "pid",
  "idtiponegocio",
  "idestadoimovel",
  "tipoimovel",
  "tipologiaimovel",
  "localizacaolevel1imovel",
  "localizacaolevel2imovel",
  "localizacaolevel3imovel",
  "attr_wcs",
  "areabrutaconst",
  "areautilhab",
  "precosemformatacao",
  "gallery",
  "geocoordinateslat",
  "geocoordinateslong",
  "url_detail_view_link",
].join(",");

function buildSearchUrl({ idtiponegocio, offset }) {
  const url = new URL(`${SUPABASE_URL}/tab_listing_list`);
  url.searchParams.set("select", SEARCH_SELECT);
  url.searchParams.set("showwebsite", "eq.true");
  url.searchParams.set("idestadoimovel", "eq.1");
  url.searchParams.set("idtiponegocio", `eq.${idtiponegocio}`);
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

function parseGeo(lat, lng) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  return Number.isFinite(parsedLat) && Number.isFinite(parsedLng) ? { lat: parsedLat, lng: parsedLng } : null;
}

function toSummary(row, type) {
  const propertyType = langText(row.tipoimovel);
  if (!RESIDENTIAL_TYPES.has(propertyType)) return null;

  const slug = langText(row.url_detail_view_link);
  if (!slug) return null;
  const listingUrl = `${SOURCE_URL}/pt/${slug}`;

  const title = langText(row.tipologiaimovel) ? `${propertyType} ${langText(row.tipologiaimovel)}` : propertyType;
  const price = Number(row.precosemformatacao);
  if (!title || !Number.isFinite(price) || price <= 0) return null;

  const location = [row.localizacaolevel3imovel, row.localizacaolevel2imovel, row.localizacaolevel1imovel]
    .filter(Boolean)
    .join(", ");

  return normalizeListing({
    id: idFromUrl(listingUrl, "zome"),
    title,
    type,
    price,
    location,
    bedrooms: parseBedroomsFromText(langText(row.tipologiaimovel)),
    bathrooms: Number.isFinite(row.attr_wcs) ? row.attr_wcs : null,
    area_m2: parseAreaM2(`${row.areabrutaconst || row.areautilhab || ""}m2`),
    image: row.gallery?.mres?.[0] || row.gallery?.lres?.[0] || null,
    geo: parseGeo(row.geocoordinateslat, row.geocoordinateslong),
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    listingUrl,
  });
}

async function searchPage(query) {
  const text = await fetchHtml(buildSearchUrl(query), { headers: supabaseHeaders() });
  return JSON.parse(text);
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

async function scrapeQueryBucket({ idtiponegocio, type }, bucketIndex, maxPages) {
  const listings = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = (bucketIndex + page * BUCKET_COUNT) * PAGE_SIZE;
    let rows;
    try {
      rows = await searchPage({ idtiponegocio, offset });
    } catch (err) {
      console.error(`[zome] falhou ${type}, bloco ${bucketIndex}, offset ${offset}: ${err.message}`);
      break;
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      const item = toSummary(row, type);
      if (item) listings.push(item);
    }
    if (rows.length < PAGE_SIZE) break;
    await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  return listings;
}

export async function scrapeZome({ maxPagesPerBucket = 50, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);
  if (bucketIndices.length === 0) return [];

  const all = [];
  for (const [qi, query] of OPERATIONS.entries()) {
    for (const [bi, bucketIndex] of bucketIndices.entries()) {
      const items = await scrapeQueryBucket(query, bucketIndex, maxPagesPerBucket);
      all.push(...items);
      console.log(`[zome] ${query.type} bloco ${bucketIndex} -> ${items.length} anúncios`);
      if (!(qi === OPERATIONS.length - 1 && bi === bucketIndices.length - 1)) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  console.log(`[zome] total: ${all.length} recolhidos, ${deduped.length} únicos`);
  return deduped;
}

function pidNumberFromUrl(listingUrl) {
  const match = /-ZMPT(\d+)$/i.exec(listingUrl);
  return match ? match[1] : null;
}

const DETAIL_SELECT = [
  "pid_number",
  "descricao_completa",
  "txtcondicaoimovel",
  "areautilhab",
  "areabrutaconst",
  "gallery",
  "geocoordinateslat",
  "geocoordinateslong",
  "attr_wcs",
  "attr_year",
  "attributes_extras",
  "certificadenergeticodesc",
  "dataentradarede",
].join(",");

// `descricao_completa` holds several named sections (short titles plus one
// real free-text block), each keyed by an internal widget id rather than a
// fixed, predictable key — and a "..._html" duplicate of at least one of
// them. Rather than guess which key holds the real text, the longest
// stripped-HTML value among them reliably is it (confirmed: the short
// "sw012sNN" title duplicates are a few words, the real description is
// several paragraphs) — the same "pick whichever is richer" approach used
// elsewhere in this project for resolving ambiguous data.
function longestDescription(raw) {
  const parsed = parseLangJson(raw);
  if (!parsed) return null;
  let best = "";
  for (const [key, value] of Object.entries(parsed)) {
    if (key.endsWith("_html")) continue;
    const text = String(value?.PT || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

function parseAttributesExtras(raw) {
  const text = langText(raw);
  if (!text) return {};
  try {
    const items = JSON.parse(text);
    const labels = items.map((i) => i.name).filter(Boolean);
    return labels.length ? { Características: labels } : {};
  } catch {
    return {};
  }
}

export async function fetchListingDetail(url) {
  const pidNumber = pidNumberFromUrl(url);
  if (!pidNumber) throw new Error(`${url}: não foi possível extrair o pid_number`);

  const detailUrl = new URL(`${SUPABASE_URL}/tab_listing_view`);
  detailUrl.searchParams.set("select", DETAIL_SELECT);
  detailUrl.searchParams.set("pid_number", `eq.${pidNumber}`);

  const text = await fetchHtml(detailUrl.toString(), { headers: supabaseHeaders() });
  const [row] = JSON.parse(text);
  if (!row) throw new Error(`${url}: tab_listing_view não devolveu o imóvel ${pidNumber}`);

  const images = row.gallery?.hres?.length ? row.gallery.hres : row.gallery?.mres || [];

  return {
    images,
    description: longestDescription(row.descricao_completa),
    features: parseAttributesExtras(row.attributes_extras),
    estado: langText(row.txtcondicaoimovel) || null,
    area_util_m2: parseAreaM2(`${row.areautilhab || ""}m2`),
    area_bruta_m2: parseAreaM2(`${row.areabrutaconst || ""}m2`),
    ano_construcao: row.attr_year ? Number(row.attr_year) : null,
    certificacao_energetica: row.certificadenergeticodesc || null,
    bathrooms: Number.isFinite(row.attr_wcs) ? row.attr_wcs : null,
    geo: parseGeo(row.geocoordinateslat, row.geocoordinateslong),
    published_at: row.dataentradarede ? row.dataentradarede.slice(0, 10) : null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
