import fs from "node:fs/promises";
import { fetchListingPage } from "./sources/eleiloes.js";

// One-off diagnostic, not part of the pipeline: run this by hand
// (node debug-eleiloes.js) when scrapeELeiloes() finds 0 listings, to see
// what the real page actually looks like without having to hand-copy
// megabytes of HTML into a chat. Prints a few yes/no signals plus a
// snippet of real markup around the first auction reference found (if
// any), and saves the full page to eleiloes-debug.html for closer
// inspection. Safe to delete once sources/eleiloes.js's parsing matches
// reality.

const html = await fetchListingPage(1);
await fs.writeFile(new URL("./eleiloes-debug.html", import.meta.url), html);

console.log("Tamanho do HTML:", html.length, "caracteres");
console.log("Contém 'leilão'/'licitação' (case-insensitive)?", /leil(?:ã|a)o|licita/i.test(html));
console.log("Parece pedir JavaScript?", /enable javascript|activ(?:e|ar) o javascript|noscript/i.test(html));

const refMatches = [...html.matchAll(/\bLO\d{6,}\b/g)];
console.log("Referências no formato LO###### encontradas:", refMatches.length);

if (refMatches.length > 0) {
  const idx = refMatches[0].index;
  console.log("\n--- contexto à volta da 1ª referência (LO######) ---\n");
  console.log(html.slice(Math.max(0, idx - 800), idx + 1500));
} else {
  // No LO###### anywhere — try to find *any* run of digits that could be a
  // reference code under a different prefix/format, to see what's really there.
  const anyRefMatches = [...html.matchAll(/\b[A-Z]{1,4}\d{4,}\b/g)];
  console.log("Outros códigos alfanuméricos parecidos (prefixo+dígitos) encontrados:", anyRefMatches.length);
  console.log([...new Set(anyRefMatches.slice(0, 20).map((m) => m[0]))]);

  console.log("\n--- primeiros 3000 caracteres do <body> (texto visível) ---\n");
  // crude body-text extraction without pulling in cheerio just for this
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const bodyText = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(bodyText.slice(0, 3000));
}

console.log(`\nHTML completo guardado em: ${new URL("./eleiloes-debug.html", import.meta.url).pathname}`);
