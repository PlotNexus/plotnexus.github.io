import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, mergeWithPrevious, mergeDetailInto, pruneDetailCache } from "./lib/merge.js";
import { removeDuplicateListings } from "./lib/dedupe.js";

// Combines every shard's output (written by worker.js, downloaded here as
// build artifacts) into the site's data files. This is the only script
// that touches data/listings.json and data/listings-detail.json, and the
// only job that commits — shards never write to git themselves, so
// parallel shards can never race each other on a push.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");
const SHARDS_DIR = path.join(__dirname, "shard-artifacts");

// GitHub hard-rejects any pushed file over 100MB (this actually happened:
// data/listings.json hit 100.64MB and every scheduled run failed at the
// commit step for a day and a half, discarding that run's freshly scraped
// data each time — the retry-on-push-rejection logic below only helps with
// git race conditions, not this, since re-doing the exact same merge just
// produces the exact same oversized file again). The per-listing photo cap
// in lib/merge.js (capImages) is the normal fix and should make this a
// non-issue going forward, but this is a hard backstop against ever
// hitting the limit again — e.g. if raw listing *count* alone grows enough
// to matter, or a future source turns out to need a lower cap than 20.
// 90MB leaves real margin under the 100MB hard limit rather than cutting
// it close.
const MAX_SAFE_JSON_BYTES = 90 * 1024 * 1024;
const EMERGENCY_IMAGE_CAPS = [10, 5, 2, 0];

// Must match the exact serialization used when actually writing the file
// (see the JSON.stringify(..., null, 2) + "\n" calls below) — the
// pretty-printed, indented format is ~18% bigger than a compact
// JSON.stringify of the same data, which is large enough that checking
// the compact size instead would let a payload through that's actually
// over budget once written to disk.
function byteSize(value) {
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

// Called right before writing, once the normal per-listing cap has
// already been applied — this only ever does anything on the rare run
// where that wasn't enough.
function enforceSizeBudget(payload, detailCache) {
  let listingsBytes = byteSize(payload);
  let detailBytes = byteSize(detailCache);
  if (listingsBytes <= MAX_SAFE_JSON_BYTES && detailBytes <= MAX_SAFE_JSON_BYTES) return;

  console.warn(
    `[finalize] tamanho acima do seguro mesmo após o limite normal de fotos (listings=${(listingsBytes / 1e6).toFixed(1)}MB, detail=${(detailBytes / 1e6).toFixed(1)}MB) — a aplicar um limite de emergência`
  );
  for (const cap of EMERGENCY_IMAGE_CAPS) {
    shrinkImagesEverywhere(cap, detailCache, payload.listings);
    listingsBytes = byteSize(payload);
    detailBytes = byteSize(detailCache);
    console.warn(
      `[finalize]   limite de emergência de ${cap} fotos/anúncio -> listings=${(listingsBytes / 1e6).toFixed(1)}MB, detail=${(detailBytes / 1e6).toFixed(1)}MB`
    );
    if (listingsBytes <= MAX_SAFE_JSON_BYTES && detailBytes <= MAX_SAFE_JSON_BYTES) return;
  }
  console.error(
    "[finalize] mesmo sem fotos nenhumas, o payload continua acima do limite seguro — o problema já não é fotos, é o número de anúncios em si."
  );
}

async function main() {
  const files = (await fs.readdir(SHARDS_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  console.log(`[finalize] ${files.length} shard(s) encontrados: ${files.join(", ") || "(nenhum)"}`);

  const allListings = [];
  const detailCache = await loadJson(DETAIL_CACHE_PATH, {});

  for (const file of files) {
    const shard = await loadJson(path.join(SHARDS_DIR, file), { listings: [], detail: {} });
    allListings.push(...(shard.listings || []));
    Object.assign(detailCache, shard.detail || {});
  }

  const previousPayload = await loadJson(OUTPUT_PATH, null);
  const previousListings = previousPayload?.listings || [];
  const mergedListings = mergeWithPrevious(allListings, previousListings);

  const enrichedListings = mergedListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

  // Runs after detail is merged in (not before) so that when the same
  // property is cross-posted to more than one source, the keeper is
  // chosen by which one actually has the richer page — not decided before
  // that's even known.
  const dedupedListings = removeDuplicateListings(enrichedListings);

  pruneDetailCache(detailCache, dedupedListings);

  const payload = {
    _readme:
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml.",
    generated_at: new Date().toISOString(),
    errors: [],
    listings: dedupedListings,
  };

  enforceSizeBudget(payload, detailCache);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(DETAIL_CACHE_PATH, JSON.stringify(detailCache, null, 2) + "\n");

  const withDetail = dedupedListings.filter((l) => l.images && l.images.length > 1).length;
  console.log(`Escritos ${dedupedListings.length} anúncios em ${OUTPUT_PATH} (${withDetail} com detalhe completo)`);

  if (allListings.length === 0) {
    console.warn("Nenhum anúncio novo recolhido nesta execução — todos os shards falharam. A servir dados anteriores.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no finalize:", err);
  process.exit(1);
});
