import { parseBedroomsFromText, idFromUrl, normalizeListing } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

const SOURCE_NAME = "Imovirtual";
const SOURCE_URL = "https://www.imovirtual.com";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// Imovirtual tolerated rapid consecutive requests fine in manual testing
// (no 429s even at ~1s apart), unlike CASA SAPO — still keeping a
// deliberate, jittered pace rather than hammering it.
const DELAY_BETWEEN_QUERIES_MS = 3000;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

// Mainland districts, plus every individual island of Madeira and the
// Açores archipelago — found via Imovirtual's own sitemap_locations_0.xml.
// This is genuine national coverage including the Azores, which CASA SAPO
// has no working equivalent for at all.
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
  "ilha-da-madeira",
  "ilha-de-porto-santo",
  "ilha-de-sao-miguel",
  "ilha-de-santa-maria",
  "ilha-terceira",
  "ilha-da-graciosa",
  "ilha-de-sao-jorge",
  "ilha-do-pico",
  "ilha-do-faial",
  "ilha-das-flores",
  "ilha-do-corvo",
];

const OPERATIONS = [
  { pathPrefix: "comprar", type: "venda" },
  { pathPrefix: "arrendar", type: "arrendamento" },
];

const PROPERTY_TYPES = ["apartamento", "moradia"];

function buildQueries(districts) {
  return OPERATIONS.flatMap(({ pathPrefix, type }) =>
    PROPERTY_TYPES.flatMap((propertyType) =>
      districts.map((district) => ({
        url: `https://www.imovirtual.com/pt/resultados/${pathPrefix}/${propertyType}/${district}`,
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

// Both the search-results and listing-detail pages are server-rendered by
// Next.js and embed the full page payload as clean JSON in
// <script id="__NEXT_DATA__"> — no HTML parsing needed at all, unlike
// CASA SAPO's JSON-LD-in-cards approach.
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// roomsNumber counts total divisions including the living room, so an
// approximate "T<n>" is one less — only used when the title itself has no
// parseable tipologia.
const ROOMS_MAP = { ONE: 0, TWO: 1, THREE: 2, FOUR: 3, FIVE: 4, SIX: 5, SEVEN: 6, EIGHT: 7, NINE: 8, TEN: 9 };
function bedroomsFromRoomsNumber(roomsNumber) {
  return ROOMS_MAP[roomsNumber] ?? null;
}

// Descriptions come through as HTML with <br/> line breaks, same shape as
// CASA SAPO's (no separate "(...)" truncation marker to strip here though).
function cleanDescription(raw) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/\r/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function locationLabel(item) {
  const locs = item.location?.reverseGeocoding?.locations || [];
  const byLevel = (level) => locs.find((l) => l.locationLevel === level)?.name;
  const parts = [byLevel("parish"), byLevel("council"), byLevel("district")].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

function largestImage(image) {
  return image?.large || image?.medium || image?.small || image?.thumbnail || null;
}

async function scrapeQuery({ url, type }, maxListings) {
  const html = await fetchHtml(url);
  const nextData = extractNextData(html);
  const items = nextData?.props?.pageProps?.data?.searchAds?.items || [];

  const listings = items
    .slice(0, maxListings)
    .map((item) => {
      const listingUrl = `https://www.imovirtual.com/pt/anuncio/${item.slug}`;
      return normalizeListing({
        id: idFromUrl(listingUrl, "imovirtual"),
        title: item.title,
        type,
        price: item.totalPrice?.value ?? null,
        location: locationLabel(item),
        // roomsNumber counts total divisions (bedrooms + living room), not
        // the "T<n>" bedroom count our schema/UI expects — e.g. a "T3" ad
        // reports roomsNumber FOUR. Trust the title's own "T<n>" first;
        // only fall back to roomsNumber (minus the living room) when the
        // title has no tipologia at all.
        bedrooms: parseBedroomsFromText(item.title) ?? bedroomsFromRoomsNumber(item.roomsNumber),
        area_m2: item.areaInSquareMeters ?? null,
        image: largestImage(item.images?.[0]),
        description: cleanDescription(item.shortDescription),
        geo: null, // not present on search results; filled in by fetchListingDetail
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      });
    })
    .filter(Boolean);

  console.log(`[imovirtual] ${url} -> ${listings.length} anúncios`);
  return listings;
}

// `districts` lets a caller scope this to a subset (used to shard the
// national sweep across parallel GitHub Actions jobs — see worker.js).
// Falls back to SCRAPE_DISTRICTS (comma-separated, for local testing) or
// the full national list.
export async function scrapeImovirtual({ maxListingsPerQuery = 36, districts } = {}) {
  const resolvedDistricts =
    districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const queries = buildQueries(resolvedDistricts);

  const all = [];
  for (const [i, query] of queries.entries()) {
    try {
      const items = await scrapeQuery(query, maxListingsPerQuery);
      all.push(...items);
    } catch (err) {
      console.error(`[imovirtual] falhou em ${query.url}: ${err.message}`);
    }
    if (i < queries.length - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  console.log(`[imovirtual] total: ${all.length} recolhidos, ${deduped.length} únicos após ${queries.length} pesquisas`);
  return deduped;
}

const ESTADO_MAP = {
  ready_to_use: "Usado",
  to_renovate: "Para recuperar",
  to_complete: "Por acabar",
  under_construction: "Em construção",
};

// additionalInformation entries not interesting as a "feature" — either
// surfaced elsewhere on the listing already, or not user-facing.
const SKIP_FEATURE_LABELS = new Set([
  "advertiser_type",
  "building_type",
  "bathrooms_num",
  "lift",
  "construction_status",
  "build_year",
  "rooms_num",
  "market",
]);

const FEATURE_GROUP_LABELS = {
  extras_types: "Equipamentos",
  security_types: "Segurança",
  media_types: "Multimédia",
  heating: "Aquecimento",
  equipment_types: "Equipamento",
  orientation: "Orientação",
  windows_type: "Janelas",
  parking_types: "Estacionamento",
};

// Raw values look like "extras_types::lift" or "security_types-101::anti_burglary_door"
// — the site is PT-PT throughout, and this vocabulary is English, so every
// value shown must go through an explicit translation. An unrecognised
// group label or value is dropped rather than shown untranslated (a
// missing minor feature is a much smaller issue than English text leaking
// onto the site).
const VALUE_TRANSLATIONS = {
  lift: "Elevador",
  garage: "Garagem",
  two_storey: "Duplex",
  roller_shutters: "Estores",
  closed_area: "Condomínio fechado",
  anti_burglary_door: "Porta blindada",
  furniture: "Mobilado",
  oven: "Forno",
  aluminium: "Caixilharia de alumínio",
  wood: "Caixilharia de madeira",
  plastic: "Caixilharia de PVC",
  urban: "Aquecimento urbano",
  electric: "Aquecimento eléctrico",
  gas: "Aquecimento a gás",
  fireplace: "Lareira",
  air_conditioning: "Ar condicionado",
  balcony: "Varanda",
  terrace: "Terraço",
  garden: "Jardim",
  basement: "Cave",
  separate_kitchen: "Cozinha independente",
  dishwasher: "Máquina de lavar loiça",
  fridge: "Frigorífico",
  cable_television: "TV por cabo",
  internet: "Internet",
  intercom: "Intercomunicador",
  alarm: "Alarme",
  monitoring: "Videovigilância",
  entryphone: "Vídeo-porteiro",
  north: "Norte",
  south: "Sul",
  east: "Este",
  west: "Oeste",
};

function translateToken(rawToken) {
  const token = String(rawToken).replace(/^[a-z0-9_-]+::/, "");
  return VALUE_TRANSLATIONS[token] || null;
}

function parseFeatures(additionalInformation) {
  const features = {};
  for (const item of additionalInformation || []) {
    if (SKIP_FEATURE_LABELS.has(item.label)) continue;
    const groupLabel = FEATURE_GROUP_LABELS[item.label];
    if (!groupLabel) continue;
    const values = (item.values || []).map(translateToken).filter(Boolean);
    if (values.length) features[groupLabel] = (features[groupLabel] || []).concat(values);
  }
  return features;
}

function characteristicValue(characteristics, key) {
  return characteristics?.find((c) => c.key === key)?.value ?? null;
}

function additionalInfoValue(additionalInformation, label) {
  return additionalInformation?.find((i) => i.label === label)?.values?.[0] ?? null;
}

// Fetches a listing's own page for the full description, gallery,
// characteristics, technical data and precise geo that the search results
// don't expose — all already structured JSON, no HTML scraping needed.
export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const nextData = extractNextData(html);
  const ad = nextData?.props?.pageProps?.ad;
  if (!ad) throw new Error(`${url}: não foi possível extrair __NEXT_DATA__.props.pageProps.ad`);

  const constructionStatus = characteristicValue(ad.characteristics, "construction_status");
  const buildYear = characteristicValue(ad.characteristics, "build_year");
  const energyCert = characteristicValue(ad.characteristics, "energy_certificate");
  const area = characteristicValue(ad.characteristics, "m");
  // Seen in the wild as e.g. "4_or_more" rather than a plain number.
  const bathroomsRaw = additionalInfoValue(ad.additionalInformation, "bathrooms_num");
  const bathroomsMatch = bathroomsRaw ? String(bathroomsRaw).match(/\d+/) : null;
  const coords = ad.location?.coordinates;

  return {
    images: (ad.images || []).map(largestImage).filter(Boolean),
    description: cleanDescription(ad.description),
    features: parseFeatures(ad.additionalInformation),
    estado: constructionStatus ? ESTADO_MAP[constructionStatus] || null : null,
    area_util_m2: area ? Number(area) : null,
    area_bruta_m2: null,
    ano_construcao: buildYear ? Number(buildYear) : null,
    certificacao_energetica: energyCert
      ? energyCert.toLowerCase() === "exempt"
        ? "Isento"
        : energyCert.toUpperCase()
      : null,
    bathrooms: bathroomsMatch ? Number(bathroomsMatch[0]) : null,
    geo: coords?.latitude != null && coords?.longitude != null ? { lat: coords.latitude, lng: coords.longitude } : null,
    published_at: ad.createdAt ? ad.createdAt.slice(0, 10) : null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
