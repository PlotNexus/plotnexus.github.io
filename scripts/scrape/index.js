import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeCasaSapo } from "./sources/casaSapo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "data", "listings.json");

const sources = [{ name: "casasapo", run: scrapeCasaSapo }];

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

  const payload = {
    _readme:
      "Dados recolhidos automaticamente (scripts/scrape) a partir de sites parceiros, para uso pessoal. Ver .github/workflows/scrape.yml.",
    generated_at: new Date().toISOString(),
    errors,
    listings: allListings,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Escritos ${allListings.length} anúncios em ${OUTPUT_PATH}`);

  if (allListings.length === 0) {
    console.warn("Nenhum anúncio recolhido — ver logs de cada fonte acima.");
  }
}

main().catch((err) => {
  console.error("Erro fatal no scraper:", err);
  process.exit(1);
});
