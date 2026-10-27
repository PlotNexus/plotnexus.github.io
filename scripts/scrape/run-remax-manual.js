import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeRemax, fetchListingDetail as fetchRemaxDetail, DETAIL_FETCH_DELAY_MS } from "./sources/remax.js";
import { sleepJittered } from "./lib/http.js";
import {
  loadJson,
  mergeWithPrevious,
  mergeDetailInto,
  pickEnrichmentCandidates,
  pruneDetailCache,
  capImages,
  toListingSummary,
  loadPreviousListings,
  writeListingFiles,
  enforceSizeBudget,
} from "./lib/merge.js";
import { buildSitemap } from "./lib/sitemap.js";

// Manual-only counterpart to index.js/finalize.js, for RE/MAX specifically
// — confirmed in October 2026 that its search API now rejects every
// request from a datacenter IP (GitHub Actions runners, and this
// project's own dev sandbox) with a 405 that still claims "Allow: POST",
// while the exact same request from an ordinary residential connection
// gets back a normal 200 with real data. A Cloudflare-level block on the
// /api/ route specifically, the same pattern already seen with SUPERCASA/
// OLX (see README) — not something retrying from GitHub Actions can ever
// fix, so RE/MAX is run by hand instead, the same treatment e-leilões
// already gets:
//
//   cd scripts/scrape && node run-remax-manual.js
//   git add data/listings.json data/listings-detail.json data/listings/ sitemap.xml
//   git commit -m "chore: update RE/MAX listings"
//   git push
//
// Safe to run alongside the automated scrape or run-eleiloes-manual.js:
// mergeWithPrevious leaves every other source's last_seen_at untouched,
// and this shares the exact same data/listings.json + data/listings-
// detail.json + data/listings/ + sitemap.xml those write — this is just
// that same merge+enrichment pipeline, scoped to one source instead of
// split across shards.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");
const LISTINGS_DIR = path.join(__dirname, "..", "..", "data", "listings");
const SITEMAP_PATH = path.join(__dirname, "..", "..", "sitemap.xml");

// A manual run is infrequent (whenever someone remembers to do it from
// home) rather than every 6 hours, so it can afford a larger one-off
// enrichment batch than the automated sources' per-run budgets — the
// backlog only grows between runs, it never shrinks on its own.
const MAX_DETAIL_FETCHES_PER_RUN = 150;

async function enrichListings(listings, cache) {
  const candidates = pickEnrichmentCandidates(listings, cache, MAX_DETAIL_FETCHES_PER_RUN);
  console.log(`[remax] ${candidates.length} novos anúncios a enriquecer nesta execução (de um total de ${listings.length})`);

  for (const [i, item] of candidates.entries()) {
    try {
      const detail = await fetchRemaxDetail(item.listing_url);
      cache[item.id] = { ...detail, images: capImages(detail.images), fetched_at: new Date().toISOString().slice(0, 10) };
      console.log(`[remax] detalhe OK — ${item.id} (${detail.images.length} fotos)`);
    } catch (err) {
      console.error(`[remax] detalhe falhou em ${item.listing_url}: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleepJittered(DETAIL_FETCH_DELAY_MS);
  }
}

async function main() {
  const freshListings = await scrapeRemax();

  if (freshListings.length === 0) {
    console.warn(
      "[remax] 0 imóveis encontrados — antes de assumir que o site mudou de estrutura, confirma que " +
        "https://remax.pt/pt/comprar abre normalmente no teu browser primeiro."
    );
  }

  const { listings: previousListings, rawById: previousRawById, files: previousFiles } = await loadPreviousListings(
    LISTINGS_DIR
  );
  const mergedListings = mergeWithPrevious(freshListings, previousListings);

  const detailCache = await loadJson(DETAIL_CACHE_PATH, {});
  const remaxListings = mergedListings.filter((item) => item.id.startsWith("remax-"));
  await enrichListings(remaxListings, detailCache);

  // Once, against the full merged set (every source) — not just RE/MAX's
  // own listings. Pruning against a subset deletes every other source's
  // cache entries too, since their ids simply aren't in that subset; see
  // index.js's own comment on this exact bug for the full story.
  pruneDetailCache(detailCache, mergedListings);

  const enrichedListings = mergedListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

  enforceSizeBudget(detailCache, enrichedListings);
  await writeListingFiles(LISTINGS_DIR, enrichedListings, previousRawById, previousFiles);

  const summaryListings = enrichedListings.map(toListingSummary);
  const previousPayload = await fs
    .readFile(OUTPUT_PATH, "utf-8")
    .then(JSON.parse)
    .catch(() => ({ _readme: undefined, errors: [] }));
  const payload = {
    _readme:
      previousPayload._readme ||
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml. Cada anúncio tem o detalhe completo em data/listings/<id>.json.",
    generated_at: new Date().toISOString(),
    errors: previousPayload.errors || [],
    listings: summaryListings,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(DETAIL_CACHE_PATH, JSON.stringify(detailCache, null, 2) + "\n");
  await fs.writeFile(SITEMAP_PATH, buildSitemap(summaryListings));

  const remaxCount = enrichedListings.filter((l) => l.id.startsWith("remax-")).length;
  console.log(`Escritos ${enrichedListings.length} anúncios no total (${remaxCount} da RE/MAX) em ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
