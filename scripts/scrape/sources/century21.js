import { idFromUrl, normalizeListing, parseBedroomsFromText } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";
import { cutAtLanguageSwitch } from "../lib/languageGuard.js";

const SOURCE_NAME = "Century 21";
const SOURCE_URL = "https://century21.pt";
const API_BASE = "https://century21.pt/api";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

// No rate limiting observed in manual testing (same as RE/MAX) — kept at a
// deliberate, jittered pace regardless.
const DELAY_BETWEEN_QUERIES_MS = 3000;
const RETRY_BASE_DELAY_MS = 6000;
const MAX_RETRIES = 4;

// Unlike the other sources, /api/properties is one single national,
// page-based list — there's no per-district search to shard by. To still
// split the sweep across parallel GitHub Actions shards, the "districts"
// abstraction is repurposed as purely virtual page buckets: bucket i is
// responsible for pages i+1, i+1+BUCKET_COUNT, i+1+2*BUCKET_COUNT, ... A
// round number divisible by common shard counts (2, 3, 4, 6) so nothing is
// left idle regardless of how many shards are configured.
const BUCKET_COUNT = 12;
export const DISTRICTS_FULL = Array.from({ length: BUCKET_COUNT }, (_, i) => `bucket-${i}`);

const OPERATIONS = [
  { ad_type: "sell", type: "venda" },
  { ad_type: "rent", type: "arrendamento" },
];

// Residential-only scope, matching the other sources — excludes land,
// stores, cafés, bars, etc. that also show up in the national inventory.
const ASSET_TYPES = "house,apartment";
const PAGE_SIZE = 20;
// Safety ceiling per bucket per operation, well above the ~60 pages a
// bucket actually needs to cover today's ~9 000 residential listings —
// this source has no rate limiting, so there's no cost to just covering
// the whole thing in one run rather than trickling in over many.
const MAX_PAGES_PER_BUCKET = 120;

const fetchHtml = createFetcher({
  userAgent: USER_AGENT,
  retries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
});

async function getJson(url) {
  return JSON.parse(await fetchHtml(url, { headers: { Accept: "application/json" } }));
}

function bucketIndexOf(token) {
  const match = /^bucket-(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

function imageList(images) {
  return Array.isArray(images) ? images.filter(Boolean) : [];
}

function locationLabel(item) {
  // No structured district/council/parish breakdown in this API — `address`
  // is a street-level string, so location falls back to just that (still
  // meaningfully more specific than nothing, and the map/geo filter doesn't
  // depend on this text at all).
  return item.address || "";
}

async function scrapePage({ ad_type, page }, maxListings) {
  const url = `${API_BASE}/properties?asset_type=${ASSET_TYPES}&ad_type=${ad_type}&page=${page}`;
  const data = await getJson(url);
  const results = data?.data || [];

  const listings = results
    .slice(0, maxListings)
    .map((item) => {
      const title = item.title?.pt;
      if (!title) return null;
      return normalizeListing({
        id: idFromUrl(item.link, "century21"),
        title,
        type: ad_type === "rent" ? "arrendamento" : "venda",
        price: item.price ?? null,
        location: locationLabel(item),
        // `number_of_rooms` counts total divisions (bedrooms + living room
        // + ...), not the "T<n>" bedroom count our schema expects — e.g. a
        // "T2+1" title (T2, one extra convertible division) reported
        // number_of_rooms 2, and a plain "T2+2" reported 4. The title's own
        // "T<n>" is trustworthy and always present when the asset type has
        // one; only fall back to the raw count when it's genuinely missing.
        bedrooms: parseBedroomsFromText(title) ?? item.number_of_rooms ?? null,
        bathrooms: item.number_of_wcs ?? null,
        area_m2: item.useful_area ?? item.gross_area ?? null,
        image: imageList(item.images)[0] || null,
        geo: item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng } : null,
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl: item.link,
      });
    })
    .filter(Boolean);

  return { listings, total: data?.total ?? 0 };
}

async function scrapeBucket({ bucketIndex, ad_type, type }, maxListingsPerQuery) {
  const all = [];
  for (let i = 0; i < MAX_PAGES_PER_BUCKET; i++) {
    const page = bucketIndex + 1 + i * BUCKET_COUNT;
    let result;
    try {
      result = await scrapePage({ ad_type, page }, maxListingsPerQuery);
    } catch (err) {
      console.error(`[century21] falhou bucket ${bucketIndex} (${type}) página ${page}: ${err.message}`);
      break;
    }
    all.push(...result.listings);
    // A page beyond the last one returns 200 with an empty `data` array
    // (confirmed empirically) — that's the signal we've run past the end
    // of this bucket's slice of the national listing.
    if (result.listings.length === 0) break;
    if (i < MAX_PAGES_PER_BUCKET - 1) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }
  console.log(`[century21] bucket ${bucketIndex} (${type}) -> ${all.length} anúncios`);
  return all;
}

// `districts` here are the virtual page-bucket tokens (see DISTRICTS_FULL)
// — lets a caller scope this to a subset (used to shard the national sweep
// across parallel GitHub Actions jobs — see worker.js). Falls back to
// SCRAPE_DISTRICTS (comma-separated, for local testing) or the full set.
export async function scrapeCentury21({ maxListingsPerQuery = PAGE_SIZE, districts } = {}) {
  const resolvedBuckets = districts || (process.env.SCRAPE_DISTRICTS ? process.env.SCRAPE_DISTRICTS.split(",") : DISTRICTS_FULL);
  const bucketIndices = resolvedBuckets.map(bucketIndexOf).filter((i) => i != null);

  const all = [];
  for (const [i, bucketIndex] of bucketIndices.entries()) {
    for (const [j, op] of OPERATIONS.entries()) {
      const items = await scrapeBucket({ bucketIndex, ...op }, maxListingsPerQuery);
      all.push(...items);
      const isLast = i === bucketIndices.length - 1 && j === OPERATIONS.length - 1;
      if (!isLast) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  const seen = new Set();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  console.log(`[century21] total: ${all.length} recolhidos, ${deduped.length} únicos`);
  return deduped;
}

// Condition values seen so far are a small, standard enum shared across
// most PT real-estate platforms — same drop-rather-than-leak policy as
// everywhere else for anything not in this list.
const CONDITION_MAP = {
  new: "Novo",
  used: "Usado",
  under_construction: "Em construção",
  to_renovate: "Para recuperar",
  renovated: "Renovado",
};

// Surveyed across the search results of 5 national pages (190 distinct
// tokens) — translated as a batch, grouped by category below. An
// unrecognised token is dropped rather than shown untranslated.
const NEAR_SUFFIX_MAP = {
  amenities: "comodidades",
  bank: "um banco",
  beach: "a praia",
  bus_station: "uma paragem de autocarro",
  church: "uma igreja",
  city_center: "o centro da cidade",
  commercial_area: "uma zona comercial",
  fire_station: "um quartel de bombeiros",
  gas_station: "uma bomba de gasolina",
  golf_course: "um campo de golfe",
  green_spaces: "espaços verdes",
  highway: "uma autoestrada",
  historic_area: "uma zona histórica",
  kindergarten: "um infantário",
  market: "um mercado",
  metro: "o metro",
  pharmacy: "uma farmácia",
  police: "a polícia",
  public_place: "um espaço público",
  railway_station: "uma estação de comboio",
  restaurants: "restaurantes",
  sports_complex: "um complexo desportivo",
  taxi_rank: "uma praça de táxis",
};

const VALUE_TRANSLATIONS = {
  // Climate & energy
  air_conditioning: "Ar condicionado",
  central_heating: "Aquecimento central",
  heater: "Aquecedor",
  heated_floor: "Piso radiante",
  heated_towel_rack: "Toalheiro aquecido",
  heat_recovery: "Recuperador de calor",
  fireplace: "Lareira",
  solar_panels: "Painéis solares",
  termic_isolation: "Isolamento térmico",
  sound_isolation: "Isolamento acústico",
  double_windows: "Janelas duplas",
  pre_air_conditioning: "Pré-instalação de ar condicionado",
  // Kitchen & appliances
  equipped_kitchen: "Cozinha equipada",
  kitchen: "Cozinha",
  kitchenet: "Kitchenette",
  kitchenette: "Kitchenette",
  appliances: "Eletrodomésticos",
  dishwasher: "Máquina de lavar loiça",
  washing_machine: "Máquina de lavar roupa",
  fridge: "Frigorífico",
  microwave: "Micro-ondas",
  oven: "Forno",
  stove: "Fogão",
  electric_stove: "Fogão elétrico",
  gas_stove: "Fogão a gás",
  induction_stove: "Fogão de indução",
  exhaust_fan: "Exaustor",
  pantry: "Despensa",
  // Rooms & layout
  bedroom: "Quarto",
  bedrooms_hall: "Hall de quartos",
  bathroom: "Casa de banho",
  private_bathroom: "Casa de banho privativa",
  shared_bathroom: "Casa de banho partilhada",
  suite: "Suite",
  suite_bathroom: "Casa de banho de suite",
  suite_room: "Quarto em suite",
  living_room: "Sala de estar",
  dining_room: "Sala de jantar",
  entrance_hall: "Hall de entrada",
  hallway: "Corredor",
  corridor: "Corredor",
  cloak_room: "Vestiário",
  office: "Escritório",
  desk: "Escritório",
  guest_room: "Quarto de hóspedes",
  other_room: "Outra divisão",
  open_space: "Open space",
  attic: "Sótão",
  loft: "Loft",
  basement: "Cave",
  cellar: "Cave",
  storage: "Arrecadação",
  laundry: "Lavandaria",
  laundrette: "Lavandaria",
  pool: "Piscina",
  common_pool: "Piscina comum",
  garden: "Jardim",
  garden_service: "Manutenção de jardim",
  patio: "Pátio",
  terrace: "Terraço",
  covered_terrace: "Terraço coberto",
  balcony: "Varanda",
  balconies: "Varandas",
  front_porch: "Alpendre",
  marquis: "Marquise",
  marquise: "Marquise",
  garage: "Garagem",
  parking: "Estacionamento",
  bar: "Bar",
  gym: "Ginásio",
  sauna: "Sauna",
  turkish_bath: "Banho turco",
  squash: "Campo de squash",
  tennis_court: "Campo de ténis",
  playground: "Parque infantil",
  party_room: "Sala de festas",
  salon: "Salão",
  shed: "Alpendre",
  vegetable_garden: "Horta",
  fruit_trees: "Árvores de fruto",
  old_trees: "Árvores centenárias",
  bushes: "Arbustos",
  vineyard: "Vinha",
  well: "Poço",
  barbecue: "Churrasqueira",
  // Views & location character
  sea_view: "Vista mar",
  beach_view: "Vista praia",
  river_view: "Vista rio",
  city_view: "Vista cidade",
  country_view: "Vista campo",
  mountain_view: "Vista serra",
  panoramic_view: "Vista panorâmica",
  first_line_view: "Primeira linha",
  good_light_exposure: "Boa exposição solar",
  quiet_place: "Zona tranquila",
  good_location: "Boa localização",
  central_location: "Localização central",
  gated_community: "Condomínio fechado",
  golf_course: "Campo de golfe",
  // Security
  alarm: "Alarme",
  intrusion_detector: "Deteção de intrusão",
  smoke_detector: "Detetor de fumo",
  smoke_extractor: "Exaustor de fumo",
  gas_detector: "Detetor de gás",
  fire_door: "Porta corta-fogo",
  emergency_exit: "Saída de emergência",
  high_security_door: "Porta de alta segurança",
  video_intercom: "Vídeo-porteiro",
  security_service: "Serviço de segurança",
  concierge: "Porteiro",
  electric_gate: "Portão elétrico",
  safe_box: "Cofre",
  // Finishes & structure
  elevator: "Elevador",
  ramp: "Rampa de acesso",
  disabled_accessibility: "Acessibilidade para mobilidade reduzida",
  load_unload_accessibility: "Acesso para cargas e descargas",
  ground_floor: "Rés-do-chão",
  high_ceilings: "Tetos altos",
  fake_ceiling: "Teto falso",
  recessed_lighting: "Iluminação embutida",
  painted_walls: "Paredes pintadas",
  hardwood_floor: "Soalho em madeira",
  wooden_floor: "Piso em madeira",
  floating_floor: "Piso flutuante",
  taco_floor: "Soalho à portuguesa",
  tile_floor: "Piso em azulejo",
  mosaic_floor: "Piso em mosaico",
  stone_floor: "Piso em pedra",
  granite_floor: "Piso em granito",
  frescos: "Frescos",
  window_frames: "Caixilharia",
  double_bed: "Cama de casal",
  single_bed: "Cama de solteiro",
  wardrobe: "Roupeiro",
  showcase: "Vitrine",
  road_access: "Acesso por estrada",
  dirt_access: "Acesso por caminho de terra",
  trench: "Vala",
  machinerys_house: "Casa de máquinas",
  // Utilities
  electricity: "Eletricidade",
  water: "Água",
  tap_water: "Água canalizada",
  hot_water: "Água quente",
  water_heater: "Esquentador",
  electric_water_heater: "Termoacumulador elétrico",
  gas: "Gás",
  piped_gas: "Gás canalizado",
  gas_canister: "Gás em botija",
  sanitation: "Saneamento",
  telephone: "Telefone",
  television: "Televisão",
  iron: "Ferro de engomar",
  electric_blinds: "Estores elétricos",
  pre_internet_cable: "Pré-instalação de internet",
  public_lighting: "Iluminação pública",
  // Services & terms
  cleaning_service: "Serviço de limpeza",
  maintenance_service: "Serviço de manutenção",
  luxury: "Luxo",
  chain_free: "Sem cadeia de venda",
  couples_allowed: "Aceita casais",
  fixed_contract: "Contrato fixo",
  long_lease: "Arrendamento de longa duração",
  guarantor: "Fiador necessário",
  freehold: "Propriedade plena",
  other: "Outro",
};

function translateToken(token) {
  const nearMatch = /^near_(.+)$/.exec(token);
  if (nearMatch) {
    const suffix = NEAR_SUFFIX_MAP[nearMatch[1]];
    return suffix ? `Perto de ${suffix}` : null;
  }
  return VALUE_TRANSLATIONS[token] || null;
}

function parseFeatures(characteristics) {
  const items = (characteristics || []).map(translateToken).filter(Boolean);
  return items.length ? { Características: [...new Set(items)] } : {};
}

// The description is HTML-ish free text (real <br/>, occasional inline
// styles) with the same per-language-slot structure — and the same risk of
// an agent pasting every language into the "pt" slot — as RE/MAX, hence
// reusing the same cutAtLanguageSwitch safety net.
function cleanDescription(raw) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/\r/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cutAtLanguageSwitch(text) || null;
}

// Both the search-results and listing-detail pages are Next.js App Router
// pages that stream their data as React Server Component "flight" chunks
// (`self.__next_f.push([1, "<chunk>"])`) rather than the older Pages
// Router's single clean __NEXT_DATA__ blob — each chunk is itself a
// JSON-encoded string prefixed with a small id (e.g. `9:[...]`), and the
// full property object lives inside the one chunk whose parsed array has a
// `.property` field.
function extractNextFPushChunks(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let match;
  while ((match = re.exec(html))) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // malformed/truncated chunk — skip it
    }
  }
  return chunks;
}

function extractProperty(html) {
  for (const chunk of extractNextFPushChunks(html)) {
    if (!chunk.includes('"property":{"id"')) continue;
    const withoutIdPrefix = chunk.replace(/^[0-9a-zA-Z]+:/, "");
    let parsed;
    try {
      parsed = JSON.parse(withoutIdPrefix);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const withProperty = parsed.find((el) => el && typeof el === "object" && !Array.isArray(el) && el.property);
    if (withProperty) return withProperty.property;
  }
  return null;
}

// Fetches a listing's own page for the full PT description, gallery,
// characteristics, condition, energy certificate and construction year the
// search results don't expose.
export async function fetchListingDetail(url) {
  const html = await fetchHtml(url);
  const property = extractProperty(html);
  if (!property) throw new Error(`${url}: não foi possível extrair o objeto "property" dos dados da página`);

  return {
    images: imageList(property.images),
    description: cleanDescription(property.description?.pt),
    features: parseFeatures(property.characteristics),
    estado: property.condition ? CONDITION_MAP[property.condition] || null : null,
    area_util_m2: property.useful_area ?? null,
    area_bruta_m2: property.gross_area ?? null,
    ano_construcao: property.building_year ?? null,
    certificacao_energetica: property.energy_efficiency ? property.energy_efficiency.toUpperCase() : null,
    bathrooms: property.number_of_wcs ?? null,
    geo: property.lat != null && property.lng != null ? { lat: property.lat, lng: property.lng } : null,
    published_at: null,
  };
}

export const DETAIL_FETCH_DELAY_MS = DELAY_BETWEEN_QUERIES_MS;
