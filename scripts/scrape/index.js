import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeCasaSapo, fetchListingDetail, DETAIL_FETCH_DELAY_MS } from "./sources/casaSapo.js";
import { sleep } from "./lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");

// Full detail (photo gallery, full description, technical data) requires a
// second fetch per listing, on top of the search-page queries. Rather than
// doing that for all ~1500+ listings every run (which would multiply the
// request volume against an already rate-limit-sensitive site), each run
// only enriches a bounded batch of listings it hasn't seen before. The
// cache accumulates across scheduled runs, so coverage grows over time
// without ever spiking request volume in a single run.
const MAX_DETAIL_FETCHES_PER_RUN = 50;

const sources = [{ name: "casasapo", run: scrapeCasaSapo, fetchDetail: fetchListingDetail }];

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mergeDetailInto(listing, detail) {
  const images = detail?.images?.length ? detail.images : listing.image ? [listing.image] : [];
  return {
    ...listing,
    image: images[0] || listing.image || null,
    images,
    description: detail?.description || listing.description || null,
    features: detail?.features || null,
    estado: detail?.estado || null,
    area_util_m2: detail?.area_util_m2 ?? listing.area_m2 ?? null,
    area_bruta_m2: detail?.area_bruta_m2 ?? null,
    ano_construcao: detail?.ano_construcao ?? null,
    certificacao_energetica: detail?.certificacao_energetica ?? null,
    published_at: detail?.published_at || listing.published_at,
  };
}

async function enrichListings(listings, fetchDetail, cache) {
  const idsInCache = new Set(Object.keys(cache));
  const candidates = listings.filter((item) => !idsInCache.has(item.id)).slice(0, MAX_DETAIL_FETCHES_PER_RUN);

  console.log(`[detail] ${candidates.length} novos anúncios a enriquecer nesta execução (de um total de ${listings.length})`);

  for (const [i, item] of candidates.entries()) {
    try {
      const detail = await fetchDetail(item.listing_url);
      cache[item.id] = { ...detail, fetched_at: new Date().toISOString().slice(0, 10) };
      console.log(`[detail] OK — ${item.id} (${detail.images.length} fotos)`);
    } catch (err) {
      console.error(`[detail] falhou em ${item.listing_url}: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleep(DETAIL_FETCH_DELAY_MS);
  }

  // Drop cached detail for listings that are no longer being returned by
  // any search query, so the cache doesn't grow forever.
  const currentIds = new Set(listings.map((item) => item.id));
  for (const id of Object.keys(cache)) {
    if (!currentIds.has(id)) delete cache[id];
  }

  return cache;
}

async function main() {
  const allListings = [];
  const errors = [];

  for (const source of sources) {
    try {
      const items = await source.run();
      console.log(`[${source.name}] OK — ${items.length} anúncios`);
      allListings.push(...items);
    } catch (err) {
      console.error(`[${source.name}] FALHOU — ${err.message}`);
      errors.push({ source: source.name, message: err.message });
    }
  }

  const detailCache = await loadJson(DETAIL_CACHE_PATH, {});

  for (const source of sources) {
    if (!source.fetchDetail) continue;
    const sourceListings = allListings.filter((item) => item.id.startsWith(`${source.name}-`));
    await enrichListings(sourceListings, source.fetchDetail, detailCache);
  }

  const enrichedListings = allListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

  const payload = {
    _readme:
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml.",
    generated_at: new Date().toISOString(),
    errors,
    listings: enrichedListings,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(DETAIL_CACHE_PATH, JSON.stringify(detailCache, null, 2) + "\n");

  const withDetail = enrichedListings.filter((l) => l.images && l.images.length > 1).length;
  console.log(`Escritos ${enrichedListings.length} anúncios em ${OUTPUT_PATH} (${withDetail} com detalhe completo)`);

  if (enrichedListings.length === 0) {
    console.warn("Nenhum anúncio recolhido — ver logs de cada fonte acima.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no scraper:", err);
  process.exit(1);
});
