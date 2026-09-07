import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrapeCasaSapo,
  fetchListingDetail as fetchCasaSapoDetail,
  DISTRICTS_FULL as CASASAPO_DISTRICTS,
  DETAIL_FETCH_DELAY_MS as CASASAPO_DETAIL_DELAY_MS,
} from "./sources/casaSapo.js";
import {
  scrapeImovirtual,
  fetchListingDetail as fetchImovirtualDetail,
  DISTRICTS_FULL as IMOVIRTUAL_DISTRICTS,
  DETAIL_FETCH_DELAY_MS as IMOVIRTUAL_DETAIL_DELAY_MS,
} from "./sources/imovirtual.js";
import { sleepJittered } from "./lib/http.js";
import { loadJson, pickEnrichmentCandidates } from "./lib/merge.js";

// One shard of the national sweep, across every registered source: each
// source's own district/location list is split independently across the
// shard count, so no single job (and likely no single runner IP) ever
// makes a source's full national sweep by itself. Running N of these as
// parallel GitHub Actions matrix jobs writes one JSON file per shard for
// finalize.js to combine.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "shard-output");
const EXISTING_DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");

const shardIndex = Number(process.env.SHARD_INDEX ?? 0);
const shardCount = Number(process.env.SHARD_COUNT ?? 1);
const maxDetailPerShardSource = Number(process.env.MAX_DETAIL_PER_SHARD_SOURCE ?? 20);

const SOURCES = [
  {
    name: "casasapo",
    districts: CASASAPO_DISTRICTS,
    scrape: scrapeCasaSapo,
    fetchDetail: fetchCasaSapoDetail,
    detailDelayMs: CASASAPO_DETAIL_DELAY_MS,
  },
  {
    name: "imovirtual",
    districts: IMOVIRTUAL_DISTRICTS,
    scrape: scrapeImovirtual,
    fetchDetail: fetchImovirtualDetail,
    detailDelayMs: IMOVIRTUAL_DETAIL_DELAY_MS,
  },
];

function myShare(list) {
  return list.filter((_, i) => i % shardCount === shardIndex);
}

async function main() {
  const existingCache = await loadJson(EXISTING_DETAIL_CACHE_PATH, {});

  const allListings = [];
  const detail = {};

  for (const source of SOURCES) {
    const districts = myShare(source.districts);
    console.log(`[shard ${shardIndex}/${shardCount}] ${source.name}: ${districts.join(", ") || "(nenhum)"}`);

    const listings = districts.length ? await source.scrape({ districts }) : [];
    console.log(`[shard ${shardIndex}] ${source.name} OK — ${listings.length} anúncios`);
    allListings.push(...listings);

    // Read-only snapshot of the cache as checked out at the start of the
    // run — good enough since each shard only ever touches listings from
    // its own districts, so shards can't collide on ids.
    const candidates = pickEnrichmentCandidates(listings, existingCache, maxDetailPerShardSource);
    console.log(`[shard ${shardIndex}] ${source.name}: ${candidates.length} anúncios a enriquecer`);

    for (const [i, item] of candidates.entries()) {
      try {
        const detailData = await source.fetchDetail(item.listing_url);
        detail[item.id] = { ...detailData, fetched_at: new Date().toISOString().slice(0, 10) };
        console.log(`[shard ${shardIndex}] ${source.name} OK — ${item.id} (${detailData.images.length} fotos)`);
      } catch (err) {
        console.error(`[shard ${shardIndex}] ${source.name} falhou em ${item.listing_url}: ${err.message}`);
      }
      if (i < candidates.length - 1) await sleepJittered(source.detailDelayMs);
    }
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `shard-${shardIndex}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ listings: allListings, detail }, null, 2) + "\n");
  console.log(`[shard ${shardIndex}] escrito ${outputPath}`);
}

main().catch((err) => {
  console.error(`[shard ${shardIndex}] erro fatal:`, err);
  process.exit(1);
});
