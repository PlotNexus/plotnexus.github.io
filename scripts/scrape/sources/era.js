import { idFromUrl, normalizeListing, parsePriceEUR } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";
import { cutAtLanguageSwitch } from "../lib/languageGuard.js";

const SOURCE_NAME = "ERA";
const SOURCE_URL = "https://www.era.pt";
const API_BASE = "https://www.era.pt/API/ServicesModule/Property";
const SESSION_URL = "https://www.era.pt/comprar";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 2000;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

// era.pt's search results are fetched entirely client-side by a DNN
// ("DotNetNuke") module — there's no server-rendered listing data, and the
// endpoint itself was only found by digging through the actual (unminified
// by babel, if not by webpack) module bundle for the literal controller/
// action names and the DNN Services Framework's own request-signing
// convention. Every call needs a fresh anti-forgery cookie+token pair plus
// the module/tab ids scraped off a real page load — none of this is a
// documented public API.
const PAGE_SIZE = 15;
const BUCKET_COUNT = 12;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

// PropertyType is inconsistent about whether it holds the broad category
// ("Moradia") or a specific subtype ("Moradia Isolada"/"Moradia Geminada"/
// "Moradia em Banda") — checking a prefix instead of an exact match catches
// every variant seen in practice.
function isResidential(propertyType) {
  return propertyType === "Apartamento" || propertyType === "Duplex" || propertyType.startsWith("Moradia");
}

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

// A DNN anti-forgery cookie+token pair, plus the module/tab id the search
// module is mounted as on this page — all four are required together on
// every API call, but are otherwise unrelated to any single listing, so
// one session is bootstrapped per scrape() call (and once more for the
// separate detail-enrichment phase, which runs later in its own pass) and
// reused for every request that process makes.
let session = null;

async function bootstrapSession() {
  const res = await fetch(SESSION_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${SESSION_URL} respondeu ${res.status} ao iniciar sessão`);
  const html = await res.text();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(
    Boolean
  )).map((c) => c.split(";")[0]);

  const tokenMatch = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);
  const moduleIdMatch = /id="rootContainer-(\d+)"/.exec(html);
  const tabIdMatch = /id="rootContainer-\d+"[\s\S]{0,50}?data-tabid="(\d+)"/.exec(html);
  if (!tokenMatch || !moduleIdMatch || !tabIdMatch) {
    throw new Error("não foi possível extrair a sessão (token/moduleId/tabId) da página de pesquisa da ERA");
  }

  return {
    cookie: cookies.join("; "),
    token: tokenMatch[1],
    moduleId: moduleIdMatch[1],
    tabId: tabIdMatch[1],
  };
}

async function ensureSession() {
  if (!session) session = await bootstrapSession();
  return session;
}

async function callWithSession(method, path, query, body) {
  const s = await ensureSession();
  const url = new URL(`${API_BASE}/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const headers = {
    Cookie: s.cookie,
    ModuleId: s.moduleId,
    TabId: s.tabId,
    RequestVerificationToken: s.token,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const text = await fetchHtml(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return JSON.parse(text);
}

// A run works through many pages at a slow, steady pace — long enough
// that the anti-forgery session (tied to server-side session state, not
// just a fixed key) could plausibly expire before the run finishes, unlike
// every other source here. A 401 is the one error worth a real retry
// (rather than just logging and moving on to the next page): it clears
// the cached session so the next attempt bootstraps a fresh one instead
// of repeating the same now-invalid credentials for the rest of the run.
async function apiCall(method, path, options = {}) {
  try {
    return await callWithSession(method, path, options.query, options.body);
  } catch (err) {
    if (!/\s401\b/.test(err.message)) throw err;
    session = null;
    return callWithSession(method, path, options.query, options.body);
  }
}

// The request's own filter fields (businessTypes/propertyTypes/location)
// are silently ignored server-side no matter what's sent — confirmed by
// requesting every combination and always getting the same unfiltered
// result set back — so every property type and both business types (sale
// and rental) come back mixed together regardless, and have to be split
// apart client-side from each listing's own BusinessType/PropertyType
// fields instead of via the request.
async function searchPage(page) {
  return apiCall("POST", "Search", { body: { page, order: 1 } });
}

function parseGeo(lat, lng) {
  if (!lat || !lng) return null;
  const parsedLat = Number(String(lat).replace(",", "."));
  const parsedLng = Number(String(lng).replace(",", "."));
  return Number.isFinite(parsedLat) && Number.isFinite(parsedLng) ? { lat: parsedLat, lng: parsedLng } : null;
}

function parseIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toSummary(p) {
  if (!p.PropertyType || !isResidential(p.PropertyType)) return null;
  // Rental prices are masked behind a fixed placeholder value for every
  // single listing regardless of its real rent (verified: dozens of
  // unrelated rentals across very different locations/sizes all show the
  // exact same "1.500 €", including on the detail endpoint) — almost
  // certainly a deliberate lead-generation gate rather than real data, so
  // rentals are skipped entirely rather than showing a fabricated price.
  if (!p.BusinessType?.[0] || p.BusinessType[0].Name !== "Comprar") return null;
  const price = parsePriceEUR(p.SellPrice?.Value);
  if (!price) return null;

  return normalizeListing({
    id: idFromUrl(p.DetailUrl, "era"),
    title: p.Title,
    type: "venda",
    price,
    location: p.Localization || "",
    bedrooms: parseIntOrNull(p.Rooms),
    bathrooms: parseIntOrNull(p.Wcs),
    area_m2: parseIntOrNull(p.NetArea) || parseIntOrNull(p.ListingArea),
    image: p.Gallery?.[0]?.Url || null,
    geo: parseGeo(p.Lat, p.Lng),
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    listingUrl: p.DetailUrl,
  });
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

// features() groups OtherFeatures into { category: ["label: value", ...] }
// — the API already returns them pre-grouped by category name, unlike
// Century 21's flat characteristic-token list, so no translation
// dictionary is needed here.
function parseFeatures(otherFeatures) {
  const result = {};
  for (const group of otherFeatures || []) {
    const items = (group.Attributes || [])
      .map((a) => (a.Label ? `${a.Label}: ${a.Value}` : a.Value))
      .filter(Boolean);
    if (!items.length) continue;
    const category = group.Name || "Características";
    result[category] = [...(result[category] || []), ...items];
  }
  return result;
}

function findFeatureValue(otherFeatures, label) {
  for (const group of otherFeatures || []) {
    const match = (group.Attributes || []).find((a) => a.Label === label);
    if (match) return match.Value;
  }
  return null;
}

async function scrapeBucket(bucketIndex, totalPages, maxPages) {
  const listings = [];
  for (let page = bucketIndex + 1; page <= totalPages && page <= (bucketIndex + 1) + maxPages * BUCKET_COUNT; page += BUCKET_COUNT) {
    let data;
    try {
      data = await searchPage(page);
    } catch (err) {
      console.error(`[era] falhou bucket ${bucketIndex}, página ${page}: ${err.message}`);
      continue;
    }
    for (const p of data.PropertyList || []) {
      const item = toSummary(p);
      if (item) listings.push(item);
    }
    if (page + BUCKET_COUNT <= totalPages) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  console.log(`[era] bucket ${bucketIndex} -> ${listings.length} anúncios`);
  return listings;
}

export async function scrapeEra({ maxPagesPerBucket = 200, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);
  if (bucketIndices.length === 0) return [];

  const first = await searchPage(1);
  const totalPages = first.TotalPages || 1;
  console.log(`[era] ${first.TotalRecords} imóveis no total, ${totalPages} páginas de ${PAGE_SIZE}`);

  const all = [];
  for (const [i, bucketIndex] of bucketIndices.entries()) {
    const items = await scrapeBucket(bucketIndex, totalPages, maxPagesPerBucket);
    all.push(...items);
    if (i < bucketIndices.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  console.log(`[era] total: ${all.length} recolhidos, ${deduped.length} únicos`);
  return deduped;
}

function referenceFromUrl(listingUrl) {
  const match = /-(\d+)$/.exec(listingUrl);
  return match ? match[1] : null;
}

export async function fetchListingDetail(listingUrl) {
  const reference = referenceFromUrl(listingUrl);
  if (!reference) throw new Error(`${listingUrl}: não foi possível extrair a referência do url`);

  const p = await apiCall("GET", "PropertyDetailByReference", { query: { reference } });
  if (!p || !p.Id) throw new Error(`${listingUrl}: PropertyDetailByReference não devolveu o imóvel ${reference}`);

  return {
    images: (p.Gallery || []).map((g) => g.Url).filter(Boolean),
    description: p.Description ? cutAtLanguageSwitch(String(p.Description).trim()) || null : null,
    features: parseFeatures(p.OtherFeatures),
    estado: findFeatureValue(p.OtherFeatures, "Estado"),
    area_util_m2: parseIntOrNull(p.NetArea),
    area_bruta_m2: parseIntOrNull(p.ListingArea),
    ano_construcao: null,
    certificacao_energetica: p.Ce ? p.Ce.trim() : null,
    bathrooms: parseIntOrNull(p.Wcs),
    geo: parseGeo(p.Lat, p.Lng),
    published_at: null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
