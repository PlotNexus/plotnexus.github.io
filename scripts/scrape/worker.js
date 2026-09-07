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

// A GitHub Actions job hit by its `timeout-minutes` is killed outright —
// every remaining step, including uploading the shard's own output as an
// artifact, is skipped, not just the current one. That silently discarded
// an entire shard's progress on a large catch-up burst even though the
// script itself was saving incrementally to local disk the whole time.
// So the script polices its own budget and stops itself well short of
// the job-level timeout, exiting normally so the upload step still runs.
const START_TIME = Date.now();
const maxRuntimeMs = Number(process.env.MAX_RUNTIME_MINUTES ?? 165) * 60 * 1000;
function timeBudgetExceeded() {
  return Date.now() - START_TIME > maxRuntimeMs;
}

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

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `shard-${shardIndex}.json`);

  // Written after every fetch (not just once at the end) so a run that
  // gets killed by the job timeout mid-burst still leaves finalize.js a
  // usable partial result instead of losing the whole shard's work.
  async function saveProgress() {
    await fs.writeFile(outputPath, JSON.stringify({ listings: allListings, detail }, null, 2) + "\n");
  }

  for (const source of SOURCES) {
    if (timeBudgetExceeded()) {
      console.log(`[shard ${shardIndex}] orçamento de tempo esgotado, a saltar ${source.name}`);
      continue;
    }

    const districts = myShare(source.districts);
    console.log(`[shard ${shardIndex}/${shardCount}] ${source.name}: ${districts.join(", ") || "(nenhum)"}`);

    const listings = districts.length ? await source.scrape({ districts }) : [];
    console.log(`[shard ${shardIndex}] ${source.name} OK — ${listings.length} anúncios`);
    allListings.push(...listings);
    await saveProgress();

    // Read-only snapshot of the cache as checked out at the start of the
    // run — good enough since each shard only ever touches listings from
    // its own districts, so shards can't collide on ids.
    const candidates = pickEnrichmentCandidates(listings, existingCache, maxDetailPerShardSource);
    console.log(`[shard ${shardIndex}] ${source.name}: ${candidates.length} anúncios a enriquecer`);

    for (const [i, item] of candidates.entries()) {
      if (timeBudgetExceeded()) {
        console.log(
          `[shard ${shardIndex}] orçamento de tempo esgotado a meio de ${source.name} (${i}/${candidates.length} feitos) — a terminar de forma limpa`
        );
        break;
      }
      try {
        const detailData = await source.fetchDetail(item.listing_url);
        detail[item.id] = { ...detailData, fetched_at: new Date().toISOString().slice(0, 10) };
        console.log(`[shard ${shardIndex}] ${source.name} OK — ${item.id} (${detailData.images.length} fotos)`);
      } catch (err) {
        console.error(`[shard ${shardIndex}] ${source.name} falhou em ${item.listing_url}: ${err.message}`);
      }
      await saveProgress();
      if (i < candidates.length - 1) await sleepJittered(source.detailDelayMs);
    }
  }

  console.log(`[shard ${shardIndex}] escrito ${outputPath}`);
}

main().catch((err) => {
  console.error(`[shard ${shardIndex}] erro fatal:`, err);
  process.exit(1);
});
