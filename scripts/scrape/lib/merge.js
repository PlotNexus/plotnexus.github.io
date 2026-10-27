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
  } catch (err) {
    // A missing file (first run, fresh checkout) is routine and silent on
    // purpose — but a file that *exists* and fails to parse is different:
    // a single corrupted byte anywhere (confirmed: literal unresolved git
    // conflict markers, committed by accident, in what was then the
    // combined data/listings-detail.json cache) fails the *entire* file,
    // silently handing back an empty fallback here. Confirmed the hard
    // way: one source alone went from 1433 enriched listings to 101 in a
    // single run this way, and it took several cycles to notice. Logging
    // loudly here (instead of staying silent) is the cheapest possible
    // tripwire against this repeating unnoticed.
    if (err.code !== "ENOENT") {
      console.error(`[merge] ${filePath} existe mas falhou o parse (${err.message}) — a usar o valor por omissão`);
    }
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
// mergeWithPrevious) — so every field falls back through fresh detail data,
// then whatever the listing already had, before reconstructing from
// scratch. This keeps a carried-over listing's full detail intact even on
// a run where its detail isn't freshly fetched.
//
// `detail_fetched_at` is set the one time a real fetchDetail call actually
// succeeds for this listing, and is the ONLY reliable "already fully
// enriched" signal — not `description`: several sources (confirmed on
// CASA SAPO) expose a short blurb straight from the search-results page
// (JSON-LD), well before the listing's own detail page has ever been
// visited, so a present-but-short `description` doesn't mean the real
// detail fetch (full description, features, technical data, photo
// gallery) ever ran.
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
    detail_fetched_at: detail?.detail_fetched_at || listing.detail_fetched_at || null,
  };
}

// Every id that has a real detail_fetched_at in its own data/listings/
// file already — i.e. previousListings, as loaded by loadPreviousListings.
// This is what used to live in the separate data/listings-detail.json
// cache: now that every listing's own file already carries everything
// that cache held, keeping a second combined copy just to answer "is this
// one already enriched" was pure duplication (and the thing that kept
// pushing that file past GitHub's size warnings).
export function alreadyEnrichedIds(previousListings) {
  return new Set(previousListings.filter((item) => item.detail_fetched_at != null).map((item) => item.id));
}

// Newest-first: `published_at` is today's date for a listing seen for the
// first time this run (see normalizeListing), so this means a freshly
// discovered listing gets its full detail before older never-enriched
// backlog items, rather than waiting behind them.
export function pickEnrichmentCandidates(listings, enrichedIds, maxCount) {
  return listings
    .filter((item) => !enrichedIds.has(item.id))
    .sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""))
    .slice(0, maxCount);
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
// out per listing (data/listings/<id>.json) means no single file is ever
// at realistic risk of this again — one listing's own data never gets
// remotely close to 100MB — which is also why the combined
// data/listings-detail.json cache this file used to also guard (capping
// photos in an emergency once the combined cache crossed 90MB) was
// retired instead of chased further down: with no single giant file left
// to protect, that backstop had nothing left to do.
