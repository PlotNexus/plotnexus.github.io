import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, mergeWithPrevious, mergeDetailInto, pruneDetailCache } from "./lib/merge.js";

// Combines every shard's output (written by worker.js, downloaded here as
// build artifacts) into the site's data files. This is the only script
// that touches data/listings.json and data/listings-detail.json, and the
// only job that commits — shards never write to git themselves, so
// parallel shards can never race each other on a push.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");
const DETAIL_CACHE_PATH = path.join(__dirname, "..", "..", "data", "listings-detail.json");
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

  const previousPayload = await loadJson(OUTPUT_PATH, null);
  const previousListings = previousPayload?.listings || [];
  const mergedListings = mergeWithPrevious(allListings, previousListings);

  pruneDetailCache(detailCache, mergedListings);

  const enrichedListings = mergedListings.map((item) => mergeDetailInto(item, detailCache[item.id]));

  const payload = {
    _readme:
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml.",
    generated_at: new Date().toISOString(),
    errors: [],
    listings: enrichedListings,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(DETAIL_CACHE_PATH, JSON.stringify(detailCache, null, 2) + "\n");

  const withDetail = enrichedListings.filter((l) => l.images && l.images.length > 1).length;
  console.log(`Escritos ${enrichedListings.length} anúncios em ${OUTPUT_PATH} (${withDetail} com detalhe completo)`);

  if (allListings.length === 0) {
    console.warn("Nenhum anúncio novo recolhido nesta execução — todos os shards falharam. A servir dados anteriores.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no finalize:", err);
  process.exit(1);
});
