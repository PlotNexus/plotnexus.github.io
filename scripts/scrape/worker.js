import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeCasaSapo, fetchListingDetail, DISTRICTS_FULL, DETAIL_FETCH_DELAY_MS } from "./sources/casaSapo.js";
import { sleepJittered } from "./lib/http.js";
import { loadJson, pickEnrichmentCandidates } from "./lib/merge.js";

// One shard of the national sweep: scrapes a subset of districts, then
// enriches a bounded slice of its own freshly-found listings, and writes
// its own result to a JSON file for finalize.js to combine with every
// other shard's output. Running N of these as parallel GitHub Actions
// matrix jobs means no single job (and likely no single runner IP) ever
// makes the full ~150-request national sweep by itself.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "shard-output");
const EXISTING_DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");

const shardIndex = Number(process.env.SHARD_INDEX ?? 0);
const shardCount = Number(process.env.SHARD_COUNT ?? 1);
const maxDetailPerShard = Number(process.env.MAX_DETAIL_PER_SHARD ?? 20);

function myShare(list) {
  return list.filter((_, i) => i % shardCount === shardIndex);
}

async function main() {
  const districts = myShare(DISTRICTS_FULL);
  console.log(`[shard ${shardIndex}/${shardCount}] distritos: ${districts.join(", ") || "(nenhum)"}`);

  const listings = districts.length ? await scrapeCasaSapo({ districts }) : [];
  console.log(`[shard ${shardIndex}] OK — ${listings.length} anúncios`);

  // Read-only snapshot of the cache as checked out at the start of the
  // run — good enough to avoid re-enriching something another shard has
  // no way of knowing about yet anyway (each shard only ever touches
  // listings from its own districts, so shards can't collide on ids).
  const existingCache = await loadJson(EXISTING_DETAIL_CACHE_PATH, {});
  const candidates = pickEnrichmentCandidates(listings, existingCache, maxDetailPerShard);
  console.log(`[shard ${shardIndex}] ${candidates.length} anúncios a enriquecer`);

  const detail = {};
  for (const [i, item] of candidates.entries()) {
    try {
      const detailData = await fetchListingDetail(item.listing_url);
      detail[item.id] = { ...detailData, fetched_at: new Date().toISOString().slice(0, 10) };
      console.log(`[shard ${shardIndex}] OK — ${item.id} (${detailData.images.length} fotos)`);
    } catch (err) {
      console.error(`[shard ${shardIndex}] falhou em ${item.listing_url}: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleepJittered(DETAIL_FETCH_DELAY_MS);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `shard-${shardIndex}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ listings, detail }, null, 2) + "\n");
  console.log(`[shard ${shardIndex}] escrito ${outputPath}`);
}

main().catch((err) => {
  console.error(`[shard ${shardIndex}] erro fatal:`, err);
  process.exit(1);
});
