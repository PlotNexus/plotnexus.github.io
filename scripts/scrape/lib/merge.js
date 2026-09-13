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

// A handful of listings (mostly Imovirtual) carry 50-135 photos — no
// gallery needs that many, and at ~270 bytes per signed image URL, a
// single such listing costs 10-35KB. That's what pushed data/listings.json
// past GitHub's 100MB hard limit (confirmed: several scheduled runs in a
// row got their push rejected outright), even though the two-phase
// summary+enrichment pattern was designed to keep growth bounded — nobody
// anticipated one listing's photo count alone being the problem. Capping
// here, in the one place detail actually gets attached to a listing,
// covers every source uniformly rather than needing the same limit
// re-added in each source file.
export const MAX_IMAGES_PER_LISTING = 20;

export function capImages(images) {
  return images && images.length > MAX_IMAGES_PER_LISTING ? images.slice(0, MAX_IMAGES_PER_LISTING) : images;
}

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
  const images = capImages(
    detail?.images?.length ? detail.images : listing.images?.length ? listing.images : listing.image ? [listing.image] : []
  );
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
    bathrooms: detail?.bathrooms ?? listing.bathrooms ?? null,
    geo: detail?.geo || listing.geo || null,
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

// Everything the homepage grid, filters, sort and map-radius search
// actually read from a listing (see assets/js/app.js/mapFilter.js) — full
// detail (description, features, technical data, every photo) lives in
// its own data/listings/<id>.json instead (see loadPreviousListings /
// writeListingFiles below), fetched only by the one listing that needs
// it. Splitting this out is what took the homepage/listing pages from
// 14+ seconds to load (measured directly) down to near-instant, since
// neither one downloads the whole ~40,000-listing catalogue anymore.
export function toListingSummary(listing) {
  return {
    id: listing.id,
    title: listing.title,
    type: listing.type,
    price: listing.price,
    currency: listing.currency,
    location: listing.location,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    area_m2: listing.area_m2,
    image: listing.image,
    geo: listing.geo,
    source: listing.source,
    published_at: listing.published_at,
  };
}

// Reads back every previously-written per-listing file, both as parsed
// objects (the merge base for mergeWithPrevious — this replaces reading
// full listings back out of data/listings.json, now that it only holds
// summaries) and as raw text (so writeListingFiles can skip rewriting
// anything whose content hasn't actually changed).
export async function loadPreviousListings(listingsDir) {
  const files = (await fs.readdir(listingsDir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const listings = [];
  const rawById = new Map();
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    try {
      const raw = await fs.readFile(`${listingsDir}/${file}`, "utf-8");
      rawById.set(id, raw);
      listings.push(JSON.parse(raw));
    } catch {
      // Corrupt or unreadable — treat as if it didn't exist rather than
      // failing the whole run over one bad file.
    }
  }
  return { listings, rawById, files };
}

// Only actually rewrites a listing's file when its content changed — with
// 40,000+ listings and most runs only touching a small slice of them,
// rewriting everything unconditionally would cost real time for no
// reason (identical content doesn't produce a git diff either way, so
// this is purely about not doing tens of thousands of needless syscalls).
export async function writeListingFiles(listingsDir, listings, previousRawById, previousFiles) {
  await fs.mkdir(listingsDir, { recursive: true });
  let written = 0;
  let unchanged = 0;
  const currentIds = new Set();

  for (const listing of listings) {
    currentIds.add(listing.id);
    const text = JSON.stringify(listing, null, 2) + "\n";
    if (previousRawById.get(listing.id) === text) {
      unchanged++;
      continue;
    }
    await fs.writeFile(`${listingsDir}/${listing.id}.json`, text);
    written++;
  }

  let removed = 0;
  for (const file of previousFiles) {
    const id = file.slice(0, -".json".length);
    if (currentIds.has(id)) continue;
    await fs.unlink(`${listingsDir}/${file}`).catch(() => {});
    removed++;
  }

  console.log(`[merge] data/listings/: ${written} escrito(s), ${unchanged} sem alterações, ${removed} removido(s)`);
}

// GitHub hard-rejects any pushed file over 100MB (this actually happened:
// data/listings.json hit 100.64MB and every scheduled run failed at the
// commit step for a day and a half, discarding that run's freshly scraped
// data each time — retrying the exact same merge on a push rejection can
// never fix a size problem, only a git race condition). Splitting detail
// out per listing means data/listings.json itself is no longer at any
// realistic risk of this — but data/listings-detail.json (the enrichment
// cache every listing's full detail is read from) still accumulates every
// photo/description ever fetched, so this backstop stays pointed at that.
export const MAX_SAFE_JSON_BYTES = 90 * 1024 * 1024;
const EMERGENCY_IMAGE_CAPS = [10, 5, 2, 0];

// Must match the exact serialization used when actually writing a file
// (JSON.stringify(..., null, 2) + "\n") — the pretty-printed, indented
// format is ~18% bigger than a compact JSON.stringify of the same data,
// large enough that checking the compact size instead would let a
// payload through that's actually over budget once written to disk.
export function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + "\n");
}

function shrinkImagesEverywhere(cap, detailCache, listings) {
  for (const entry of Object.values(detailCache)) {
    if (entry.images && entry.images.length > cap) entry.images = entry.images.slice(0, cap);
  }
  for (const listing of listings) {
    if (listing.images && listing.images.length > cap) {
      listing.images = listing.images.slice(0, cap);
      listing.image = listing.images[0] || listing.image || null;
    }
  }
}

// Called once detail is merged in but before anything is written — only
// ever does something on the rare run where the normal MAX_IMAGES_PER_LISTING
// cap wasn't enough on its own.
export function enforceSizeBudget(detailCache, listings) {
  let detailBytes = byteSize(detailCache);
  if (detailBytes <= MAX_SAFE_JSON_BYTES) return;

  console.warn(
    `[merge] data/listings-detail.json acima do seguro mesmo após o limite normal de fotos (${(detailBytes / 1e6).toFixed(1)}MB) — a aplicar um limite de emergência`
  );
  for (const cap of EMERGENCY_IMAGE_CAPS) {
    shrinkImagesEverywhere(cap, detailCache, listings);
    detailBytes = byteSize(detailCache);
    console.warn(`[merge]   limite de emergência de ${cap} fotos/anúncio -> detail=${(detailBytes / 1e6).toFixed(1)}MB`);
    if (detailBytes <= MAX_SAFE_JSON_BYTES) return;
  }
  console.error(
    "[merge] mesmo sem fotos nenhumas, o cache de detalhe continua acima do limite seguro — o problema já não é fotos, é o número de anúncios em si."
  );
}
