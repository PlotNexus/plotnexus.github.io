import { idFromUrl, normalizeListing } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";
import { cutAtLanguageSwitch } from "../lib/languageGuard.js";

const SOURCE_NAME = "KW Portugal";
const SOURCE_URL = "https://kwportugal.pt";
const API_BASE = "https://kwportugal.pt/api/portal";
const SITEMAP_INDEX_URL = "https://www.kwportugal.pt/sitemap-pt.xml";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 2500;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

// listProperties (the same call used for both the summary sweep and full
// detail — see below) always caps its response at exactly 10 results no
// matter how many ids are requested or what pagination-looking fields are
// sent; empirically confirmed by requesting the same batch of ids multiple
// times and by requesting 40+ ids at once. Fetching by explicit
// `idProperties` batches of this size is the only way found to read the
// full catalogue rather than always the same top-10-by-price set.
const BATCH_SIZE = 10;

// There's no per-district search here either (same situation as Century
// 21) — the id space itself is split into virtual buckets instead, each
// responsible for every idProperty whose value falls in that bucket modulo
// BUCKET_COUNT. The full id list (from the sitemap, see listAllPropertyUrls
// below) is small enough to fetch once per shard invocation.
const BUCKET_COUNT = 12;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

// Residential-only scope, matching the other sources — excludes land,
// stores, offices, whole buildings, etc. that also show up in the national
// inventory.
const RESIDENTIAL_TYPES = new Set(["Apartamento", "Moradia"]);

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

async function postJson(url, body) {
  const text = await fetchHtml(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return JSON.parse(text);
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

function extractLocs(xml) {
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]);
}

// The property list API never returns a listing's own page url (the field
// is always null) — but the site's sitemap does, one <loc> per property,
// with the idProperty as the last path segment. Building the real url from
// this instead of reconstructing it from region/type names avoids having
// to reproduce their exact accent-stripping/slugification rules, and
// guarantees every link lands on a real, live page.
async function listAllPropertyUrls() {
  const indexXml = await fetchHtml(SITEMAP_INDEX_URL);
  const subSitemaps = extractLocs(indexXml).filter((url) => url.includes("/imoveis/sitemap/"));

  const urlById = new Map();
  for (const sitemapUrl of subSitemaps) {
    const xml = await fetchHtml(sitemapUrl);
    for (const loc of extractLocs(xml)) {
      const match = /\/(\d+)$/.exec(loc);
      if (match) urlById.set(Number(match[1]), loc);
    }
  }
  return urlById;
}

function imageUrls(images) {
  return (images || [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((img) => img.url)
    .filter(Boolean);
}

function locationLabel(p) {
  const parts = [p.locality, p.region3, p.region2, p.region1].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

function buildTitle(p, location) {
  if (p.designation && p.designation.trim()) return p.designation.trim();
  const typology = p.typology ? ` ${p.typology}` : "";
  const verb = p.business === "Arrendamento" ? "para arrendar" : "para venda";
  return `${p.type || "Imóvel"}${typology} ${verb}${location ? ` em ${location}` : ""}`;
}

// .NET's DateTime default ("never set") serialises as this fixed sentinel
// rather than null — treated the same as missing.
function parseFundDate(value) {
  if (!value || value.startsWith("0001-01-01")) return null;
  return value.slice(0, 10);
}

// KW's auto-generated listing footer embeds the franchise's international
// English tagline as its own line inside an otherwise Portuguese paragraph
// (financing details, then this, then a PT disclaimer sentence) — too short
// and too embedded within genuine PT content for cutAtLanguageSwitch's
// paragraph-level heuristic to catch without also discarding the real
// Portuguese text around it. It's a fixed, known string, so it's simplest
// to just strip it directly rather than widen the general-purpose guard.
function stripKnownBoilerplate(text) {
  return text.replace(/^[ \t]*your partner for life\.?[ \t]*\n?/gim, "");
}

// Some agents separate a pasted-in translation from the original with a
// run of divider characters, or an explicit language label ("ENGLISH:"),
// glued directly onto the end of the previous sentence — no newline or
// even a space at all ("...bem-estar.Aqui poderá...ENGLISH:Located on
// Amparo..."), sometimes with literally zero newlines anywhere in the
// whole field. Neither paragraph- nor line-level splitting can isolate
// something like that as its own paragraph, so both patterns are searched
// for directly and cut at wherever the earliest one appears — regardless
// of surrounding whitespace — rather than relying on splitting at all.
// "Português"/"portuguesa" is deliberately not in the label list: a PT
// self-label at the very start would wrongly truncate the description to
// nothing.
const INLINE_DIVIDER = /[*\-_=~+#`…]{8,}/;
const LANGUAGE_LABEL = /\b(english|ingl[eê]s|espa[nñ]ol|espanhol|fran[cç]ais|franc[eê]s|deutsch|alem[aã]o|italiano)\s*:/i;

function truncateAtEarliestMarker(text) {
  const indices = [INLINE_DIVIDER, LANGUAGE_LABEL]
    .map((re) => re.exec(text)?.index)
    .filter((i) => i != null);
  return indices.length ? text.slice(0, Math.min(...indices)) : text;
}

function cleanDescription(raw) {
  if (!raw) return null;
  const stripped = stripKnownBoilerplate(truncateAtEarliestMarker(String(raw).trim()));
  // Unlike RE/MAX/Century 21's HTML-derived text, KW's description field is
  // free-typed plain text where agents don't reliably blank-line-separate
  // paragraphs — including right at the PT/EN switch point when the same ad
  // is pasted twice (sometimes glued to the previous paragraph by a single
  // newline, sometimes with no divider at all). Cutting at single-newline
  // granularity here catches that switch line-by-line instead of only
  // between blank-line-separated blocks.
  return cutAtLanguageSwitch(stripped, { splitPattern: /\n/, joinSeparator: "\n" }) || null;
}

function toProperty(p) {
  if (!RESIDENTIAL_TYPES.has(p.type)) return null;
  const location = locationLabel(p);
  const listingUrl = p.__listingUrl;
  if (!listingUrl) return null;

  const base = normalizeListing({
    id: idFromUrl(listingUrl, "kwportugal"),
    title: buildTitle(p, location),
    type: p.business === "Arrendamento" ? "arrendamento" : "venda",
    price: p.price ?? null,
    location,
    bedrooms: p.rooms ?? null,
    bathrooms: p.bathrooms ?? null,
    area_m2: p.livingArea || p.totalArea || null,
    image: imageUrls(p.images)[0] || null,
    geo: p.latitude != null && p.longitude != null ? { lat: p.latitude, lng: p.longitude } : null,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    listingUrl,
  });
  if (!base) return null;

  // listProperties returns everything in one call (full photo gallery,
  // description, technical data) — unlike every other source here, there's
  // no separate, lighter "search results" payload to fall back to, so the
  // full detail is attached directly instead of needing a second,
  // per-listing fetch later. See kwportugal's absence of fetchListingDetail/
  // DETAIL_FETCH_DELAY_MS exports and its SOURCES entry in worker.js/index.js.
  return {
    ...base,
    images: imageUrls(p.images),
    description: cleanDescription(p.description),
    estado: p.state || null,
    area_util_m2: p.livingArea || null,
    area_bruta_m2: p.totalArea || null,
    ano_construcao: p.constructionYear || null,
    certificacao_energetica: p.energyClass || null,
    published_at: parseFundDate(p.fundDate) || base.published_at,
  };
}

async function fetchBatch(ids) {
  const results = await postJson(`${API_BASE}/listProperties`, { idProperties: ids });
  return Array.isArray(results) ? results : [];
}

async function scrapeBucket(bucketIndex, urlById, maxListings) {
  const ids = [...urlById.keys()].filter((id) => id % BUCKET_COUNT === bucketIndex).slice(0, maxListings);

  const listings = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    let properties;
    try {
      properties = await fetchBatch(batchIds);
    } catch (err) {
      console.error(`[kwportugal] falhou bucket ${bucketIndex}, lote ${i / BATCH_SIZE}: ${err.message}`);
      continue;
    }
    for (const p of properties) {
      p.__listingUrl = urlById.get(p.idProperty);
      const item = toProperty(p);
      if (item) listings.push(item);
    }
    if (i + BATCH_SIZE < ids.length) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  console.log(`[kwportugal] bucket ${bucketIndex} -> ${listings.length} anúncios (de ${ids.length} ids)`);
  return listings;
}

export async function scrapeKWPortugal({ maxListingsPerQuery = 5000, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);
  if (bucketIndices.length === 0) return [];

  const urlById = await listAllPropertyUrls();
  console.log(`[kwportugal] sitemap: ${urlById.size} imóveis no total`);

  const all = [];
  for (const [i, bucketIndex] of bucketIndices.entries()) {
    const items = await scrapeBucket(bucketIndex, urlById, maxListingsPerQuery);
    all.push(...items);
    if (i < bucketIndices.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  console.log(`[kwportugal] total: ${all.length} recolhidos, ${deduped.length} únicos`);
  return deduped;
}
