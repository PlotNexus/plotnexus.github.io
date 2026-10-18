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

// Testados por página de pesquisa/listagem real sempre que uma foi
// encontrada nos links da própria homepage (nunca adivinhada) — uma
// homepage pode passar sem desafio enquanto a página de resultados, onde
// o anti-bot costuma realmente atuar, bloqueia. Também vale o inverso:
// uma homepage pequena/vazia (ex.: Casa Yes) não significa que o site
// seja todo assim — confirmado ao testar uma sub-página de listagem real
// em vez de assumir pelo HTML da raiz.
const TARGETS = [
  {
    name: "SUPERCASA",
    url: "https://supercasa.pt/",
    note:
      "CORRIGIDO: o domínio certo é supercasa.pt, não supercasa.com.pt (esse é uma loja WooCommerce sem relação, erro meu numa verificação anterior). " +
      "Motivo da exclusão: desafio Cloudflare 'managed' com JavaScript obrigatório, confirmado mesmo a partir de datacenter — testa também aqui para confirmar da tua ligação.",
  },
  {
    name: "OLX Portugal",
    url: "https://www.olx.pt/imoveis/apartamento-casa-a-venda/",
    note: "Motivo da exclusão: bloqueio CloudFront inconsistente (403 'Request blocked' em ~metade dos pedidos).",
  },
  {
    name: "CGD / Caixa Imobiliário",
    url: "https://www.caixaimobiliario.pt/",
    note: "Motivo da exclusão: página de 1KB sem conteúdo real — parece ser só uma casca que carrega tudo via JavaScript, não um bloqueio.",
  },
  {
    name: "Zome",
    url: "https://www.zome.pt/pt/pesquisar/comprar-casa/apartamento/t2/l1-lisboa/l2-lisboa",
    note: "Página de pesquisa real (extraída dos links da homepage). robots.txt: User-agent * -> Allow /. Em teste anterior, chegou à página certa mas sem preços visíveis no HTML estático — a confirmar se precisa de JavaScript para a lista em si.",
  },
  {
    name: "Imovendo",
    url: "https://www.imovendo.pt/",
    note: "A própria homepage já lista imóveis com preço diretamente no HTML. Agência de comissão fixa, ~90 imóveis próprios — já cruzados com CASA SAPO e Casa Yes, por isso provavelmente redundante.",
  },
  {
    name: "Listoo",
    url: "https://app.listoo.pt/properties",
    note: "Página de pesquisa real (subdomínio app.listoo.pt, robots.txt aberto). Em teste anterior tinha dados __NEXT_DATA__ mas só com textos de interface, sem a lista de imóveis em si — parece precisar de JavaScript para os resultados.",
  },
  {
    name: "Predimed",
    url: "https://predimed.pt/",
    note: "A própria homepage já lista imóveis com preço diretamente no HTML. Já excluído no README por ser redundante com a CASA SAPO, não por bloqueio.",
  },
  {
    name: "ComprarCasa",
    url: "https://www.comprarcasa.pt/imoveis/1/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/-/0,0,0,1",
    note: "Página de pesquisa real (extraída dos links da homepage) — confirmado com preços reais no HTML estático.",
  },
  {
    name: "Casa Yes",
    url: "https://casayes.pt/pt/agencia/imovendo",
    note:
      "A homepage (casayes.pt/) é só uma casca de 7KB sem conteúdo — mas esta sub-página (perfil de uma agência) tem preços reais no HTML estático, por isso o site não está todo bloqueado. " +
      "A página de pesquisa geral (/pt/comprar) não mostrou preços no teste anterior — pode precisar de JavaScript para paginar. " +
      "robots.txt proíbe especificamente /api/, /perfil/ e parâmetros de pesquisa/filtro (?search=, ?f=).",
  },
  {
    name: "Engel & Völkers",
    url: "https://www.engelvoelkers.com/pt/pt",
    note: "robots.txt proíbe especificamente os caminhos de pesquisa (*/search/*, */propertysearch?*) — isto é uma questão de política, como o CustoJusto/iad, não técnica. Não vale a pena testar uma página de pesquisa aqui.",
  },
  {
    name: "Sotheby's International Realty (Portugal)",
    url: "https://www.sothebysrealtypt.com/imoveis/-/apartamentos+moradias?z=499",
    note: "Página de pesquisa real (extraída dos links da homepage) — confirmado com preços reais no HTML estático. robots.txt só restringe /assets/, /api/ e recursos internos.",
  },
  {
    name: "Christie's International Real Estate (Luximos, Algarve/Porto)",
    url: "https://www.luximos.pt/pt/comprar",
    note: "Confirmado: este site devolve o mesmo conteúdo para qualquer caminho (até um inexistente) — é uma SPA onde o routing real acontece em JavaScript no browser, não dá para obter os imóveis com um pedido HTTP simples a nenhum caminho.",
  },
  {
    name: "Savills",
    url: "https://www.savills.pt/encontre-um-imovel/",
    note: "Página de pesquisa real (extraída dos links da homepage), mas sem preços nem dados de imóveis visíveis no HTML estático em teste anterior — parece carregar tudo via JavaScript/mapa interativo.",
  },
  {
    name: "Quintela e Penalva / Knight Frank",
    url: "https://www.quintelaepenalva.pt/imoveis",
    note: "Página de pesquisa real (extraída dos links da homepage, título confirma 'Listagem de imóveis'), mas sem preços visíveis no HTML estático em teste anterior — parece carregar a lista via JavaScript.",
  },
  {
    name: "Santander (imóveis recuperados)",
    url: "https://imoveis.santander.pt/imoveis",
    note: "Página de pesquisa real (extraída dos links da homepage, título confirma 'Imóveis em promoção'), mas sem preços de imóveis visíveis no HTML estático em teste anterior — só textos de interface ('Ordenar: Preço crescente').",
  },
  {
    name: "Citius (Ministério da Justiça)",
    url: "https://www.citius.mj.pt/portal/default.aspx",
    note: "Confirmado: a própria página avisa 'Este site requer o javascript ativado para funcionar corretamente' — mesma categoria da CGD, não dá para obter conteúdo com um pedido HTTP simples. Também pode ser só um sistema de consulta de processos, sem lista de imóveis navegável.",
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

// A 200 response with no anti-bot marker isn't automatically useful: some
// sites (CGD, Listoo, Luximos, Citius — confirmed by hand this session)
// serve a mostly-empty shell and fetch the actual listings client-side via
// JavaScript after load, which a plain HTTP request never runs. A price
// tag ("350 000 €" or "€ 350.000") in the static HTML is a decent proxy
// for "this page's real content is actually in the response", since every
// listing page on every site tested so far shows a price somewhere.
const PRICE_PATTERN = /[0-9]{2,3}[ .]?[0-9]{3}\s?€|€\s?[0-9]{2,3}[ .]?[0-9]{3}/;

function countPriceMatches(body) {
  return (body.match(new RegExp(PRICE_PATTERN, "g")) || []).length;
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
    const priceMatches = countPriceMatches(body);
    if (priceMatches > 0) {
      console.log(`RESULTADO: respondeu 200 com ${priceMatches} preços visíveis no HTML — parece ter passado e tem conteúdo real!`);
    } else {
      console.log(
        "RESULTADO: respondeu 200 sem marcador de bloqueio conhecido, mas sem nenhum preço visível no HTML — " +
          "pode ser uma página que só carrega os imóveis via JavaScript depois de abrir no browser (não é bloqueio, " +
          "é arquitetura do site; confirma visualmente no browser antes de assumir que passou)."
      );
    }
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
