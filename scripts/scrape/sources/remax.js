import * as cheerio from "cheerio";
import { idFromUrl, normalizeListing } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

const SOURCE_NAME = "RE/MAX";
const SOURCE_URL = "https://remax.pt";
const API_BASE = "https://www.remax.pt/api";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// RE/MAX showed no rate limiting at all in manual testing (rapid-fire
// requests all came back 200 in under a second), unlike CASA SAPO — kept at
// the same deliberate, jittered pace as Imovirtual regardless, rather than
// hammering it just because we can.
const DELAY_BETWEEN_QUERIES_MS = 3000;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

// RE/MAX's own /api/Reference/Regions1 endpoint returns exactly this set —
// the 18 mainland districts plus every individual island of Madeira and the
// Açores (same national scope as Imovirtual), minus its one non-Portugal
// entry ("Z - Fora de Portugal"). Hardcoded rather than fetched live since
// it essentially never changes, same as the other sources' DISTRICTS_FULL.
const REGION_IDS = {
  aveiro: 56,
  beja: 57,
  braga: 58,
  braganca: 59,
  "castelo-branco": 60,
  coimbra: 61,
  evora: 62,
  faro: 55,
  guarda: 63,
  "ilha-da-graciosa": 64,
  "ilha-da-madeira": 65,
  "ilha-das-flores": 66,
  "ilha-de-porto-santo": 67,
  "ilha-de-santa-maria": 68,
  "ilha-de-sao-jorge": 69,
  "ilha-de-sao-miguel": 70,
  "ilha-do-corvo": 71,
  "ilha-do-faial": 72,
  "ilha-do-pico": 73,
  "ilha-terceira": 74,
  leiria: 75,
  lisboa: 76,
  portalegre: 77,
  porto: 78,
  santarem: 79,
  setubal: 80,
  "viana-do-castelo": 81,
  "vila-real": 82,
  viseu: 83,
};

export const DISTRICTS_FULL = Object.keys(REGION_IDS);

// businessTypeID: 1 = comprar, 2 = arrendar (confirmed via the site's own
// search filter metadata). listingClassID 1 = residential — kept fixed so
// commercial/investment listings never leak in.
const OPERATIONS = [
  { businessTypeID: 1, type: "venda" },
  { businessTypeID: 2, type: "arrendamento" },
];

// listingTypeID 1 = Apartamento, 11 = Moradia — same residential-only scope
// as CASA SAPO/Imovirtual's "apartamentos"/"moradias" queries. The API
// accepts a comma-separated string for a "multiple" filter (an actual JSON
// array 400s).
const LISTING_TYPE_IDS = "1,11";
const LISTING_TYPE_NAMES = { 1: "Apartamento", 11: "Moradia" };

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

async function getJson(url) {
  return JSON.parse(await fetchHtml(url, { headers: { Accept: "application/json" } }));
}

// Both the search-results API and the listing-detail page's own
// __NEXT_DATA__ payload are clean structured JSON — no HTML parsing needed
// anywhere in this source, same as Imovirtual.
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Every photo path returned by the API (search results and detail alike)
// is relative to this CDN host, under a fixed "ds-l" (display, large) size
// prefix.
function imageUrl(path) {
  return path ? `https://i.maxwork.pt/ds-l/${path}` : null;
}

// Region1/2/3 are Distrito/Concelho/Freguesia respectively (per the site's
// own filter labels) — same district > council > parish shape as
// Imovirtual's reverse-geocoded location, just already flat on the record.
function locationLabel(r) {
  const parts = [r.regionName3, r.regionName2, r.regionName1].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

// The search API has no free-text listing title at all (listingTitle is
// just an internal reference code like "120121006-2767") — the site itself
// builds a display title client-side, so this does the same from the
// structured fields.
function buildTitle(r) {
  const typeName = LISTING_TYPE_NAMES[r.listingTypeID] || "Imóvel";
  const typology = r.numberOfBedrooms != null ? ` T${r.numberOfBedrooms}` : "";
  const verb = r.businessTypeID === 2 ? "para arrendar" : "para venda";
  const location = locationLabel(r);
  return `${typeName}${typology} ${verb}${location ? ` em ${location}` : ""}`;
}

function buildQueries(districts) {
  return OPERATIONS.flatMap(({ businessTypeID, type }) =>
    districts
      .map((district) => ({ district, regionId: REGION_IDS[district], businessTypeID, type }))
      .filter((q) => q.regionId != null)
  );
}

async function scrapeQuery({ district, regionId, businessTypeID, type }, maxListings) {
  const payload = {
    filters: [
      { field: "businessTypeID", operationType: "int", operator: "=", value: String(businessTypeID) },
      { field: "listingClassID", operationType: "int", operator: "=", value: "1" },
      { field: "region1ID", operationType: "int", operator: "=", value: String(regionId) },
      { field: "listingTypeID", operationType: "multiple", operator: "=", value: LISTING_TYPE_IDS },
    ],
    pageNumber: 1,
    pageSize: Math.min(maxListings, 200),
    sort: [],
    searchValue: "",
  };

  const data = await postJson(`${API_BASE}/Listing/PaginatedMultiMatchSearch`, payload);
  const results = data?.results || [];

  const listings = results
    .slice(0, maxListings)
    .map((r) => {
      const listingUrl = `https://remax.pt/pt/${r.listingTitle}`;
      return normalizeListing({
        id: idFromUrl(listingUrl, "remax"),
        title: buildTitle(r),
        type,
        price: r.listingPrice ?? null,
        location: locationLabel(r),
        bedrooms: r.numberOfBedrooms ?? null,
        bathrooms: r.numberOfBathrooms ?? null,
        area_m2: r.livingArea ?? r.totalArea ?? null,
        image: imageUrl(r.listingPictureUrl),
        geo: r.latitude != null && r.longitude != null ? { lat: r.latitude, lng: r.longitude } : null,
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
        publishedAt: r.publishDate ? r.publishDate.slice(0, 10) : undefined,
      });
    })
    .filter(Boolean);

  console.log(`[remax] ${district} (${type}) -> ${listings.length} anúncios`);
  return listings;
}

// `districts` lets a caller scope this to a subset (used to shard the
// national sweep across parallel GitHub Actions jobs — see worker.js).
// Falls back to SCRAPE_DISTRICTS (comma-separated, for local testing) or
// the full national list.
export async function scrapeRemax({ maxListingsPerQuery = 40, districts } = {}) {
  const resolvedDistricts =
    districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const queries = buildQueries(resolvedDistricts);

  const all = [];
  for (const [i, query] of queries.entries()) {
    try {
      const items = await scrapeQuery(query, maxListingsPerQuery);
      all.push(...items);
    } catch (err) {
      console.error(`[remax] falhou em ${query.district} (${query.type}): ${err.message}`);
    }
    if (i < queries.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  console.log(`[remax] total: ${all.length} recolhidos, ${deduped.length} únicos após ${queries.length} pesquisas`);
  return deduped;
}

// Conservation status, energy efficiency and feature-attribute labels are
// only exposed as numeric ids by the search/detail APIs — this reference
// endpoint maps them to their (already PT-PT) display text. Unlike
// Imovirtual's raw English tokens, nothing here needs a translation
// dictionary at all: an unrecognised id is simply dropped, same
// drop-rather-than-leak policy, just with a much smaller chance of firing.
let referenceDataPromise = null;
async function getReferenceData() {
  if (!referenceDataPromise) {
    referenceDataPromise = getJson(`${API_BASE}/Reference/GetAll`).then((data) => {
      const toMap = (list) => Object.fromEntries((list || []).map((item) => [item.id, item.displayText]));
      return {
        conservationStatuses: toMap(data.listingConservationStatuses),
        energyEfficiencies: toMap(data.listingEnergyEfficiencies),
        attributeTypes: toMap(data.listingAttributesTypes),
      };
    });
  }
  return referenceDataPromise;
}

function parseFeatures(attributeIds, reference) {
  const items = (attributeIds || []).map((id) => reference.attributeTypes[id]).filter(Boolean);
  return items.length ? { Características: items } : {};
}

// Word-boundary function words distinctive enough to tell Portuguese
// paragraphs apart from an English/Spanish/French/German one appended after
// it. Deliberately not a real language detector — just enough signal for
// the specific "same ad copy repeated per language" pattern this source has.
const PT_MARKERS =
  /\b(de|da|do|das|dos|para|com|uma|um|que|não|está|mais|em|os|as|se|ao|à|é|são|ou|também|muito|esta|este|onde|isto|seu|sua|foi|ser|tem|têm|pelo|pela|pelos|pelas|nas|nos|na|no|imóvel|localizado|localizada|quarto|quartos|casa|sala|cozinha|varanda|desta|deste|nesta|neste|ainda|todos|toda|cada|entre)\b/gi;
const FOREIGN_MARKERS =
  /\b(the|and|with|this|for|are|from|your|you|will|our|have|has|located|view|views|bedroom|bedrooms|bathroom|bathrooms|kitchen|house|apartment|property|floor|living|room|of|is|to|it|welcomes?|offers?|features?|includes?|situated|access|space|design(ed)?|el|la|los|las|en|con|una|uno|habitaci[oó]n|habitaciones|baño|dormitorio|dormitorios|vivienda|le|les|des|und|der|die|das|zimmer|wohnung)\b/gi;

function countMatches(re, text) {
  return (text.match(re) || []).length;
}

// Seen as *** / --- / ___ / +++ / ### and combinations of those, of varying
// length, but also as a single "…" ellipsis character on its own line.
function isDividerLine(paragraph) {
  const trimmed = paragraph.trim();
  return /^[*\-_=~.+#\s]{3,}$/.test(trimmed) || /^…+$/.test(trimmed);
}

// Many RE/MAX listing agents paste the same ad copy once per language
// (PT/EN/ES/...) into a single free-text field rather than using the site's
// own per-language description slots — sometimes separated by a divider
// line, sometimes just a paragraph break with no marker at all. The PT-PT
// requirement is absolute, so anything from the first foreign-looking
// paragraph onward is dropped entirely rather than risking English (or
// Spanish/French/German) leaking onto the site.
function cutAtLanguageSwitch(text) {
  const paragraphs = text.split(/\n{2,}/);
  const kept = [];
  for (const paragraph of paragraphs) {
    if (isDividerLine(paragraph)) break;
    const wordCount = (paragraph.match(/\S+/g) || []).length;
    const ptScore = countMatches(PT_MARKERS, paragraph);
    const foreignScore = countMatches(FOREIGN_MARKERS, paragraph);
    // A short heading-style paragraph (e.g. a translated title repeating
    // the ad above it) often has only one distinctly-foreign word — but a
    // genuinely Portuguese paragraph of 2+ words practically always
    // contains at least one of the extremely common PT function words, so
    // zero PT hits plus any foreign hit is still a safe signal.
    const isForeign =
      wordCount >= 2 && (ptScore === 0 ? foreignScore >= 1 : foreignScore >= 3 && foreignScore > ptScore * 1.5);
    if (isForeign) break;
    kept.push(paragraph);
  }
  return kept.join("\n\n").trim();
}

// The PT description is HTML (real <p>/<li>/<br/> formatting, occasional
// inline styles, HTML entities like &nbsp;/&atilde;) — decoded via cheerio
// (already a project dependency) rather than a hand-rolled entity table.
function cleanDescription(raw) {
  if (!raw) return null;
  const withBreaks = String(raw)
    .replace(/\r/g, "")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li)>/gi, "\n\n");
  // A divider can end up glued to the text right after it on the same line
  // (joined by a single <br> rather than a real paragraph boundary) — force
  // any line that's purely divider punctuation onto its own paragraph so
  // cutAtLanguageSwitch always sees it in isolation.
  const withIsolatedDividers = withBreaks.replace(/^[ \t]*([*\-_=~.+#]{3,}|…+)[ \t]*$/gm, "\n\n$1\n\n");
  const text = cheerio
    .load(withIsolatedDividers, null, false)
    .root()
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cutAtLanguageSwitch(text) || null;
}

// Fetches a listing's own page for the full PT description, gallery,
// features and technical data the search results don't expose. The whole
// listing record travels as one base64-encoded JSON blob
// (`listingEncoded`) inside __NEXT_DATA__ — same structured shape as the
// search API's own result objects, just richer (multi-language
// descriptions, the full attribute id list).
export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const nextData = extractNextData(html);
  const encoded = nextData?.props?.pageProps?.listingEncoded;
  if (!encoded) throw new Error(`${url}: não foi possível extrair listingEncoded`);

  const r = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const reference = await getReferenceData();
  const ptDescription = r.descriptions?.find((d) => d.languageCode === "PT")?.description;

  return {
    images: (r.listingPictures || []).map(imageUrl).filter(Boolean),
    description: cleanDescription(ptDescription),
    features: parseFeatures(r.listingAttributesIds, reference),
    estado: r.conservationStatusID != null ? reference.conservationStatuses[r.conservationStatusID] || null : null,
    area_util_m2: r.livingArea ?? null,
    area_bruta_m2: r.totalArea ?? null,
    ano_construcao: r.constructionYear ?? null,
    certificacao_energetica:
      r.energyEfficiencyLevelID != null ? reference.energyEfficiencies[r.energyEfficiencyLevelID] || null : null,
    bathrooms: r.numberOfBathrooms ?? null,
    geo: r.latitude != null && r.longitude != null ? { lat: r.latitude, lng: r.longitude } : null,
    published_at: r.publishDate ? r.publishDate.slice(0, 10) : null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
