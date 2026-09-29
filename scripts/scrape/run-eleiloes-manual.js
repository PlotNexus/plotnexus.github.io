import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeELeiloes } from "./sources/eleiloes.js";
import {
  loadPreviousListings,
  mergeWithPrevious,
  writeListingFiles,
  toListingSummary,
} from "./lib/merge.js";
import { removeDuplicateListings } from "./lib/dedupe.js";
import { buildSitemap } from "./lib/sitemap.js";

// Manual-only counterpart to finalize.js, for the one source that can't
// run on GitHub Actions (see sources/eleiloes.js for why) — run this by
// hand, from an ordinary residential connection, whenever you want to
// refresh e-leilões listings:
//
//   cd scripts/scrape && node run-eleiloes-manual.js
//   git add data/listings.json data/listings/ sitemap.xml
//   git commit -m "chore: update e-leilões listings"
//   git push
//
// Safe to run alongside the automated scrape: it only ever touches
// e-leilões' own listings (mergeWithPrevious leaves every other source's
// last_seen_at untouched, see lib/merge.js), and shares the exact same
// data/listings.json + data/listings/ + sitemap.xml that finalize.js
// writes — this is just that same merge pipeline, minus the shard/detail-
// cache machinery no other part of this run needs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const LISTINGS_DIR = path.join(__dirname, "..", "..", "data", "listings");
const SITEMAP_PATH = path.join(__dirname, "..", "..", "sitemap.xml");

async function main() {
  const freshListings = await scrapeELeiloes();

  if (freshListings.length === 0) {
    console.warn(
      "[eleiloes] 0 imóveis encontrados — antes de assumir que o site mudou de estrutura, confirma que " +
        "https://www.e-leiloes.pt/listagem.aspx abre normalmente no teu browser primeiro."
    );
  }

  const { listings: previousListings, rawById: previousRawById, files: previousFiles } = await loadPreviousListings(
    LISTINGS_DIR
  );
  const mergedListings = mergeWithPrevious(freshListings, previousListings);
  const dedupedListings = removeDuplicateListings(mergedListings);

  await writeListingFiles(LISTINGS_DIR, dedupedListings, previousRawById, previousFiles);

  const summaryListings = dedupedListings.map(toListingSummary);
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

  const eleiloesCount = dedupedListings.filter((l) => l.id.startsWith("eleiloes-")).length;
  console.log(
    `Escritos ${dedupedListings.length} anúncios no total (${eleiloesCount} do e-leilões) em ${OUTPUT_PATH}`
  );
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
