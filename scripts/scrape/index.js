import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrapeCasaSapo,
  fetchListingDetail as fetchCasaSapoDetail,
  DETAIL_FETCH_DELAY_MS as CASASAPO_DETAIL_DELAY_MS,
} from "./sources/casaSapo.js";
import {
  scrapeImovirtual,
  fetchListingDetail as fetchImovirtualDetail,
  DETAIL_FETCH_DELAY_MS as IMOVIRTUAL_DETAIL_DELAY_MS,
} from "./sources/imovirtual.js";
import {
  scrapeRemax,
  fetchListingDetail as fetchRemaxDetail,
  DETAIL_FETCH_DELAY_MS as REMAX_DETAIL_DELAY_MS,
} from "./sources/remax.js";
import {
  scrapeCentury21,
  fetchListingDetail as fetchCentury21Detail,
  DETAIL_FETCH_DELAY_MS as CENTURY21_DETAIL_DELAY_MS,
} from "./sources/century21.js";
import {
  scrapeKWPortugal,
  fetchListingDetail as fetchKWPortugalDetail,
  DETAIL_FETCH_DELAY_MS as KWPORTUGAL_DETAIL_DELAY_MS,
} from "./sources/kwportugal.js";
import { sleepJittered } from "./lib/http.js";
import { loadJson, mergeWithPrevious, mergeDetailInto, pickEnrichmentCandidates, pruneDetailCache } from "./lib/merge.js";

// This is the simple, single-process entry point for local runs
// (`node index.js`) — it does the full national sweep plus detail
// enrichment sequentially, in one go. The GitHub Actions workflow instead
// uses worker.js + finalize.js, which split the same work across parallel
// jobs (see .github/workflows/scrape.yml) so no single run/IP has to make
// every request.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");

// Full detail (photo gallery, full description, technical data) requires a
// second fetch per listing, on top of the search-page queries. Rather than
// doing that for all ~1800+ listings every run (which would multiply the
// request volume against an already rate-limit-sensitive site), each run
// only enriches a bounded batch of listings it hasn't seen before. The
// cache accumulates across scheduled runs, so coverage grows over time
// without ever spiking request volume in a single run.
const MAX_DETAIL_FETCHES_PER_RUN = 75;

const sources = [
  { name: "casasapo", run: scrapeCasaSapo, fetchDetail: fetchCasaSapoDetail, detailDelayMs: CASASAPO_DETAIL_DELAY_MS },
  { name: "imovirtual", run: scrapeImovirtual, fetchDetail: fetchImovirtualDetail, detailDelayMs: IMOVIRTUAL_DETAIL_DELAY_MS },
  { name: "remax", run: scrapeRemax, fetchDetail: fetchRemaxDetail, detailDelayMs: REMAX_DETAIL_DELAY_MS },
  { name: "century21", run: scrapeCentury21, fetchDetail: fetchCentury21Detail, detailDelayMs: CENTURY21_DETAIL_DELAY_MS },
  { name: "kwportugal", run: scrapeKWPortugal, fetchDetail: fetchKWPortugalDetail, detailDelayMs: KWPORTUGAL_DETAIL_DELAY_MS },
];

async function enrichListings(listings, fetchDetail, cache, delayMs) {
  const candidates = pickEnrichmentCandidates(listings, cache, MAX_DETAIL_FETCHES_PER_RUN);

  console.log(`[detail] ${candidates.length} novos anúncios a enriquecer nesta execução (de um total de ${listings.length})`);

  for (const [i, item] of candidates.entries()) {
    try {
      const detail = await fetchDetail(item.listing_url);
      cache[item.id] = { ...detail, fetched_at: new Date().toISOString().slice(0, 10) };
      console.log(`[detail] OK — ${item.id} (${detail.images.length} fotos)`);
    } catch (err) {
      console.error(`[detail] falhou em ${item.listing_url}: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleepJittered(delayMs);
  }

  pruneDetailCache(cache, listings);
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
    await enrichListings(sourceListings, source.fetchDetail, detailCache, source.detailDelayMs);
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
