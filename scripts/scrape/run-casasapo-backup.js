import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeCasaSapo, fetchListingDetail as fetchCasaSapoDetail, DETAIL_FETCH_DELAY_MS } from "./sources/casaSapo.js";
import { sleepJittered } from "./lib/http.js";
import {
  mergeWithPrevious,
  mergeDetailInto,
  pickEnrichmentCandidates,
  alreadyEnrichedIds,
  capImages,
  toListingSummary,
  loadPreviousListings,
  writeListingFiles,
} from "./lib/merge.js";
import { buildSitemap } from "./lib/sitemap.js";

// Backup-only counterpart to worker.js/finalize.js, for CASA SAPO
// specifically — confirmed via a real run's logs (2026-11-03) that it
// now 429s on every single request from GitHub Actions' datacenter IPs,
// exhausting all retries, while the exact same scraper works fine from a
// residential connection (same pattern already seen with RE/MAX). Unlike
// RE/MAX, CASA SAPO isn't dropped from the regular rotation entirely —
// the Pi already covers it nightly via index.js/run-dietpi-scrape.sh, so
// this only needs to run occasionally (see .github/workflows/
// casasapo-backup.yml, ~twice a month) as a cross-check that GitHub
// Actions' own view of this source still roughly matches what the Pi has
// been collecting, in case the IP block ever lifts or something drifts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const LISTINGS_DIR = path.join(__dirname, "..", "..", "data", "listings");
const SITEMAP_PATH = path.join(__dirname, "..", "..", "sitemap.xml");

// Infrequent by design (twice a month, not every 6h), so it can afford a
// larger one-off enrichment batch than the automated sources' per-run
// budgets — same reasoning as run-remax-manual.js's own override.
const MAX_DETAIL_FETCHES_PER_RUN = 150;

async function enrichListings(listings, freshDetail, enrichedIds) {
  const candidates = pickEnrichmentCandidates(listings, enrichedIds, MAX_DETAIL_FETCHES_PER_RUN);
  console.log(`[casasapo] ${candidates.length} novos anúncios a enriquecer nesta execução (de um total de ${listings.length})`);

  for (const [i, item] of candidates.entries()) {
    try {
      const detail = await fetchCasaSapoDetail(item.listing_url);
      freshDetail[item.id] = {
        ...detail,
        images: capImages(detail.images),
        detail_fetched_at: new Date().toISOString().slice(0, 10),
      };
      console.log(`[casasapo] detalhe OK — ${item.id} (${detail.images.length} fotos)`);
    } catch (err) {
      console.error(`[casasapo] detalhe falhou em ${item.listing_url}: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleepJittered(DETAIL_FETCH_DELAY_MS);
  }
}

async function main() {
  const freshListings = await scrapeCasaSapo();

  if (freshListings.length === 0) {
    console.warn(
      "[casasapo] 0 imóveis encontrados — se isto não for o bloqueio de IP já conhecido (ver comentário no topo " +
        "deste ficheiro), confirma que https://casa.sapo.pt/comprar-apartamentos abre normalmente no teu browser."
    );
  }

  const { listings: previousListings, rawById: previousRawById, files: previousFiles } = await loadPreviousListings(
    LISTINGS_DIR
  );
  const mergedListings = mergeWithPrevious(freshListings, previousListings);

  const previousById = new Map(previousListings.map((item) => [item.id, item]));
  const enrichedIds = alreadyEnrichedIds(previousListings);
  const freshDetail = {};
  const casasapoListings = mergedListings.filter((item) => item.id.startsWith("casasapo-"));
  await enrichListings(casasapoListings, freshDetail, enrichedIds);

  const enrichedListings = mergedListings.map((item) =>
    mergeDetailInto(item, freshDetail[item.id] || previousById.get(item.id))
  );

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
  await fs.writeFile(SITEMAP_PATH, buildSitemap(summaryListings));

  const casasapoCount = enrichedListings.filter((l) => l.id.startsWith("casasapo-")).length;
  console.log(`Escritos ${enrichedListings.length} anúncios no total (${casasapoCount} do CASA SAPO) em ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
