import fs from "node:fs/promises";

// A search query that fails outright (network block, timeout, ...) used to
// mean its whole slice of listings vanished from the site until the next
// successful run — e.g. every Lisboa query failing left zero Lisboa
// listings for hours. Instead, listings from a run are merged on top of
// the previous output: anything freshly scraped refreshes/replaces its
// entry, and anything not seen this run (because its query failed, or it
// simply didn't make this run's top results) is kept for a grace period
// rather than dropped immediately. A failure now means "slightly stale
// data" instead of "no data".
export const STALE_LISTING_RETENTION_DAYS = 3;

export async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function mergeWithPrevious(freshListings, previousListings) {
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
export function mergeDetailInto(listing, detail) {
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

// Newest-first: `published_at` is today's date for a listing seen for the
// first time this run (see normalizeListing), so this means a freshly
// discovered listing gets its full detail before older never-enriched
// backlog items, rather than waiting behind them.
export function pickEnrichmentCandidates(listings, cache, maxCount) {
  const idsInCache = new Set(Object.keys(cache));
  return listings
    .filter((item) => !idsInCache.has(item.id))
    .sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""))
    .slice(0, maxCount);
}

// Drops cached detail for listings that are no longer part of the current
// merged set, so the cache doesn't grow forever.
export function pruneDetailCache(cache, currentListings) {
  const currentIds = new Set(currentListings.map((item) => item.id));
  for (const id of Object.keys(cache)) {
    if (!currentIds.has(id)) delete cache[id];
  }
}
