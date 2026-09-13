import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadJson,
  mergeWithPrevious,
  mergeDetailInto,
  pruneDetailCache,
  toListingSummary,
  loadPreviousListings,
  writeListingFiles,
  enforceSizeBudget,
} from "./lib/merge.js";
import { removeDuplicateListings } from "./lib/dedupe.js";
import { buildSitemap } from "./lib/sitemap.js";

// Combines every shard's output (written by worker.js, downloaded here as
// build artifacts) into the site's data files. This is the only script
// that touches data/listings.json, data/listings-detail.json and
// data/listings/, and the only job that commits — shards never write to
// git themselves, so parallel shards can never race each other on a push.
//
// data/listings.json used to hold every field for every listing — full
// description, every photo, characteristics, everything — and every
// visitor downloaded the whole thing just to see the homepage grid or a
// single listing: 41,000+ listings, 80MB+, 14-16 seconds (measured
// directly) before a single card could even render. It now holds only
// the lightweight summary fields the homepage actually reads (see
// toListingSummary in lib/merge.js); full detail for each listing lives
// in its own data/listings/<id>.json, fetched on demand only by the one
// detail page that needs it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");
const LISTINGS_DIR = path.join(__dirname, "..", "..", "data", "listings");
const SITEMAP_PATH = path.join(__dirname, "..", "..", "sitemap.xml");
const SHARDS_DIR = path.join(__dirname, "shard-artifacts");

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

  const { listings: previousListings, rawById: previousRawById, files: previousFiles } = await loadPreviousListings(
    LISTINGS_DIR
  );
  const mergedListings = mergeWithPrevious(allListings, previousListings);

  const enrichedListings = mergedListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

  // Runs after detail is merged in (not before) so that when the same
  // property is cross-posted to more than one source, the keeper is
  // chosen by which one actually has the richer page — not decided before
  // that's even known.
  const dedupedListings = removeDuplicateListings(enrichedListings);

  pruneDetailCache(detailCache, dedupedListings);
  enforceSizeBudget(detailCache, dedupedListings);

  await writeListingFiles(LISTINGS_DIR, dedupedListings, previousRawById, previousFiles);

  const summaryListings = dedupedListings.map(toListingSummary);
  const payload = {
    _readme:
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml. Cada anúncio tem o detalhe completo em data/listings/<id>.json.",
    generated_at: new Date().toISOString(),
    errors: [],
    listings: summaryListings,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(DETAIL_CACHE_PATH, JSON.stringify(detailCache, null, 2) + "\n");
  await fs.writeFile(SITEMAP_PATH, buildSitemap(summaryListings));

  const withDetail = dedupedListings.filter((l) => l.images && l.images.length > 1).length;
  console.log(`Escritos ${dedupedListings.length} anúncios (${withDetail} com detalhe completo)`);

  if (allListings.length === 0) {
    console.warn("Nenhum anúncio novo recolhido nesta execução — todos os shards falharam. A servir dados anteriores.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no finalize:", err);
  process.exit(1);
});
