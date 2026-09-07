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

// A search query that fails outright (network block, timeout, ...) used to
// mean its whole slice of listings vanished from the site until the next
// successful run — e.g. every Lisboa query failing left zero Lisboa
// listings for hours. Instead, listings from a run are merged on top of
// the previous output: anything freshly scraped refreshes/replaces its
// entry, and anything not seen this run (because its query failed, or it
// simply didn't make this run's top results) is kept for a grace period
// rather than dropped immediately. A failure now means "slightly stale
// data" instead of "no data".
const STALE_LISTING_RETENTION_DAYS = 3;

const sources = [{ name: "casasapo", run: scrapeCasaSapo, fetchDetail: fetchListingDetail }];

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mergeWithPrevious(freshListings, previousListings) {
  const today = new Date().toISOString().slice(0, 10);
  const merged = new Map();

  for (const item of previousListings) {
    merged.set(item.id, item);
  }
  for (const item of freshListings) {
    merged.set(item.id, { ...item, last_seen_at: today });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALE_LISTING_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const kept = [];
  let staleCount = 0;
  for (const item of merged.values()) {
    // Listings written before this field existed are treated as seen
    // today, giving them a fresh grace period rather than being dropped
    // immediately on the first run of this logic.
    const lastSeen = item.last_seen_at || today;
    if (lastSeen >= cutoffStr) {
      kept.push(item);
    } else {
      staleCount++;
    }
  }

  if (staleCount > 0) {
    console.log(
      `[merge] a remover ${staleCount} anúncios não vistos há mais de ${STALE_LISTING_RETENTION_DAYS} dias (provavelmente vendidos/expirados)`
    );
  }
  const carriedOver = kept.length - freshListings.length;
  if (carriedOver > 0) {
    console.log(`[merge] ${carriedOver} anúncios mantidos de execuções anteriores (não vistos nesta execução)`);
  }

  return kept;
}

// `listing` can either be freshly scraped this run (no images/features yet)
// or carried over from a previous run's already-merged output (via
// mergeWithPrevious) — so every field falls back through fresh cache data,
// then whatever the listing already had, before reconstructing from
// scratch. This keeps a carried-over listing's full detail intact even on
// a run where its cache entry isn't touched.
function mergeDetailInto(listing, detail) {
  const images = detail?.images?.length
    ? detail.images
    : listing.images?.length
      ? listing.images
      : listing.image
        ? [listing.image]
        : [];
  return {
    ...listing,
    image: images[0] || listing.image || null,
    images,
    description: detail?.description || listing.description || null,
    features: detail?.features || listing.features || null,
    estado: detail?.estado || listing.estado || null,
    area_util_m2: detail?.area_util_m2 ?? listing.area_util_m2 ?? listing.area_m2 ?? null,
    area_bruta_m2: detail?.area_bruta_m2 ?? listing.area_bruta_m2 ?? null,
    ano_construcao: detail?.ano_construcao ?? listing.ano_construcao ?? null,
    certificacao_energetica: detail?.certificacao_energetica ?? listing.certificacao_energetica ?? null,
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

  const previousPayload = await loadJson(OUTPUT_PATH, null);
  const previousListings = previousPayload?.listings || [];
  const mergedListings = mergeWithPrevious(allListings, previousListings);

  const detailCache = await loadJson(DETAIL_CACHE_PATH, {});

  for (const source of sources) {
    if (!source.fetchDetail) continue;
    const sourceListings = mergedListings.filter((item) => item.id.startsWith(`${source.name}-`));
    await enrichListings(sourceListings, source.fetchDetail, detailCache);
  }

  const enrichedListings = mergedListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

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

  if (allListings.length === 0) {
    // Every source failed outright this run. The site still shows the
    // previous (now slightly stale) data thanks to the carry-over merge
    // above, but this is worth a loud warning since it's a symptom of a
    // real problem (blocked, site structure changed, ...) rather than
    // ordinary per-query flakiness.
    console.warn("Nenhum anúncio novo recolhido nesta execução — todas as fontes falharam. A servir dados anteriores.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no scraper:", err);
  process.exit(1);
});
