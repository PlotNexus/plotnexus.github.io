// One-off diagnostic, not part of the pipeline: checks whether sites
// previously ruled out for being blocked from GitHub Actions/datacenter
// IPs (see README's "Fontes investigadas mas ainda não viáveis") respond
// differently from an ordinary residential connection — the same
// question that, for e-leilões.pt, turned out to have a surprising
// answer (it wasn't IP-blocking at all, it was a TLS config bug). Also
// probes a batch of brand-new candidate sources nobody's looked at yet.
// Run this by hand, from home, and share the output: it doesn't scrape
// or write anything, just reports what each site's plain-HTTP response
// looks like.
//
// Deliberately excludes CustoJusto and iad Portugal: both explicitly
// disallow scraping their listings in their own robots.txt, which is a
// policy question (do we want to ignore that), not a technical one — no
// network test changes that answer, so there's nothing useful to probe.
// Also excludes vendas.portaldasfinancas.gov.pt (the actual bens-
// penhorados listings sit behind an authenticated "área reservada",
// login required, so a plain fetch here wouldn't tell us anything
// useful) and a handful of names (BPI Expresso Imobiliário, Fine &
// Country, Millennium bcp imóveis, Novo Banco, Imobancos, Utopia,
// OneFix) whose actual current domain/identity couldn't be confirmed —
// see chat for details, ask if you have direct links for any of these.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const TARGETS = [
  {
    name: "SUPERCASA",
    url: "https://www.supercasa.com.pt/",
    note: "Motivo da exclusão: desafio Cloudflare com JavaScript obrigatório.",
  },
  {
    name: "OLX Portugal",
    url: "https://www.olx.pt/imoveis/apartamento-casa-a-venda/",
    note: "Motivo da exclusão: bloqueio CloudFront inconsistente (403 'Request blocked' em ~metade dos pedidos).",
  },
  {
    name: "CGD / Caixa Imobiliário",
    url: "https://www.caixaimobiliario.pt/",
    note: "Motivo da exclusão: 403 com página de erro da Akamai, mesmo na página inicial.",
  },
  {
    name: "Zome",
    url: "https://www.zome.pt/pt",
    note: "Candidato novo. robots.txt: User-agent * -> Allow /.",
  },
  {
    name: "Imovendo",
    url: "https://www.imovendo.pt/",
    note: "Candidato novo. Agência de comissão fixa, ~90 imóveis próprios.",
  },
  {
    name: "Listoo",
    url: "https://listoo.pt/",
    note: "Candidato novo. robots.txt totalmente aberto.",
  },
  {
    name: "Predimed",
    url: "https://predimed.pt/",
    note: "Já excluído no README por ser redundante com a CASA SAPO, não por bloqueio — a reconfirmar.",
  },
  {
    name: "ComprarCasa",
    url: "https://www.comprarcasa.pt/",
    note: "Candidato novo. Rede de franchising APEMIP.",
  },
  {
    name: "Casa Yes",
    url: "https://casayes.pt/",
    note: "Candidato novo. robots.txt proíbe especificamente /api/, /perfil/ e parâmetros de pesquisa/filtro (?search=, ?f=).",
  },
  {
    name: "Engel & Völkers",
    url: "https://www.engelvoelkers.com/pt/pt",
    note: "Candidato novo (agência de luxo). robots.txt proíbe especificamente os caminhos de pesquisa (*/search/*, */propertysearch?*) — paginas de imóvel isoladas podem não ser afetadas, mas pesquisar/filtrar está fora.",
  },
  {
    name: "Sotheby's International Realty (Portugal)",
    url: "https://www.sothebysrealtypt.com/",
    note: "Candidato novo (agência de luxo). robots.txt só restringe /assets/, /api/ e recursos internos.",
  },
  {
    name: "Christie's International Real Estate (Luximos, Algarve/Porto)",
    url: "https://www.luximos.pt/",
    note: "Candidato novo (afiliado regional, não é site nacional). robots.txt só restringe /siges.",
  },
  {
    name: "Savills",
    url: "https://www.savills.pt/",
    note: "Candidato novo (agência de luxo/comercial). robots.txt só restringe /contact/, /forms/, /_inc/.",
  },
  {
    name: "Quintela e Penalva / Knight Frank",
    url: "https://www.quintelaepenalva.pt/",
    note: "Candidato novo (consultora de luxo). robots.txt só restringe páginas de impressão/smartlink.",
  },
  {
    name: "Santander (imóveis recuperados)",
    url: "https://imoveis.santander.pt/",
    note: "Candidato novo. robots.txt totalmente aberto.",
  },
  {
    name: "Citius (Ministério da Justiça)",
    url: "https://www.citius.mj.pt/portal/default.aspx",
    note: "Candidato incerto — pode ser só um sistema de consulta de processos/anúncios, sem lista de imóveis navegável. robots.txt permite o acesso geral.",
  },
];

// Known markers for each anti-bot platform's challenge/block page — if
// any of these show up in the body, the block is still happening
// regardless of what the HTTP status code says (some of these return a
// normal-looking 200 with a JS challenge page as the body).
const BLOCK_MARKERS = [
  { platform: "Cloudflare", patterns: [/just a moment/i, /cf-browser-verification/i, /cdn-cgi\/challenge-platform/i, /attention required.*cloudflare/i] },
  { platform: "Akamai", patterns: [/access denied/i, /reference #\d/i, /_abck/i] },
  { platform: "CloudFront", patterns: [/request blocked/i, /the request could not be satisfied/i] },
  { platform: "DataDome", patterns: [/datadome/i] },
];

function detectBlock(body) {
  for (const { platform, patterns } of BLOCK_MARKERS) {
    if (patterns.some((p) => p.test(body))) return platform;
  }
  return null;
}

async function testTarget(target) {
  console.log(`\n=== ${target.name} ===`);
  console.log(`URL: ${target.url}`);
  console.log(target.note);

  const start = Date.now();
  let res;
  try {
    res = await fetch(target.url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });
  } catch (err) {
    const detail = err.cause ? `${err.message}: ${err.cause.code || err.cause.message || err.cause}` : err.message;
    console.log(`RESULTADO: falha de rede — ${detail}`);
    return;
  }

  const elapsedMs = Date.now() - start;
  const body = await res.text();
  const block = detectBlock(body);

  console.log(`Estado HTTP: ${res.status}`);
  console.log(`Tempo de resposta: ${elapsedMs}ms`);
  console.log(`Tamanho da resposta: ${body.length} caracteres`);

  if (block) {
    console.log(`RESULTADO: BLOQUEADO — página de desafio/bloqueio do ${block} detectada no corpo da resposta.`);
  } else if (res.status >= 400) {
    console.log(`RESULTADO: falhou com estado HTTP ${res.status} (sem marcador de bloqueio conhecido no corpo).`);
  } else if (res.status >= 200 && res.status < 300) {
    console.log("RESULTADO: respondeu 200 sem marcador de bloqueio conhecido — parece ter passado!");
    console.log("--- primeiros 500 caracteres do corpo (para confirmar que é a página real) ---");
    console.log(
      body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)
    );
  } else {
    console.log(`RESULTADO: estado HTTP inesperado (${res.status}).`);
  }
}

async function main() {
  console.log("A testar sites anteriormente bloqueados a partir desta ligação...");
  for (const target of TARGETS) {
    await testTarget(target);
  }
  console.log("\nTeste concluído. Copia esta saída completa para partilhar o resultado.");
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
