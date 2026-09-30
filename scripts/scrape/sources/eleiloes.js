import https from "node:https";
import tls from "node:tls";
import { idFromUrl, toAbsoluteUrl, parseBedroomsFromText } from "../lib/normalize.js";
import { sleep, jitteredDelay, sleepJittered } from "../lib/http.js";
import { capImages } from "../lib/merge.js";

// e-leilões.pt — the official judicial property-auction platform (run by
// OSAE, the Order of Solicitors and Enforcement Agents). Not part of the
// automated scrape (see .github/workflows/scrape.yml / worker.js): every
// datacenter network tested (this repo's own dev sandbox, a real GitHub
// Actions runner, Anthropic's own web-fetch infrastructure) gets DNS and
// raw TCP connect succeeding instantly but the HTTPS request itself
// hanging for ~12s and then getting reset — that's consistent with
// IP-range-based filtering of datacenter ranges, and there's no known fix
// for it, so this can only run from wherever a person runs it by hand, on
// their own residential network. See run-eleiloes-manual.js.
//
// That's a *separate* problem from the one below, which affects even a
// residential connection: osae.pt's certificate is signed by "Sectigo
// Public Server Authentication CA DV R36", but the server's TLS handshake
// only sends that leaf certificate, not the intermediate — a real
// misconfiguration on their end (openssl s_client -showcerts confirms
// it: "Certificate chain" has only depth 0). Browsers paper over this via
// AIA-fetching (chasing the "CA Issuers" URL in the cert) and OS-level
// cert caching; Node's fetch()/TLS stack does neither, so it fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE regardless of which network it runs
// from. Fixed below by pinning the missing intermediate as a supplemental
// trust anchor for this source only, fetched once from Sectigo's own
// public repository (http://crt.sectigo.com/…R36.crt, the same URL the
// cert's own AIA extension points browsers to) and verified to chain up
// to a root Node already trusts ("Sectigo Public Server Authentication
// Root R46", present in tls.rootCertificates). CA intermediates like this
// are reissued on the order of years/a decade, not months, so this
// shouldn't need touching again unless osae.pt's CA changes — and the
// actual proper fix is on their end (send the intermediate in the
// handshake, like everyone else's TLS config does).
//
// The site itself is a client-rendered SPA (Vue) — the plain listagem.aspx
// URL used previously returns an empty <div id="app"> shell, so no amount
// of HTML parsing was ever going to find anything (confirmed via
// debug-eleiloes.js against the real page: 0 bytes of useful body text).
// Real data comes from a JSON API the front-end itself calls
// (https://www.e-leiloes.pt/api/Eventos/?tableParams=<url-encoded JSON>,
// a PrimeVue-style lazy-DataTable endpoint — found via the browser's
// Network tab), which is what's used below instead. Much more robust than
// text-scraping a rendered page: structured fields, an authoritative
// `pagination.total`/`cancelado`/`terminado` instead of guessing from
// page-identical-to-previous heuristics, and no dependency on exact
// wording or DOM structure.
//
// A very different data shape from every other source, too: this is a
// judicial auction, not a listed sale — there's no single "asking price",
// there's a starting bid (VB, Valor Base), a minimum acceptable bid (VM,
// Valor Mínimo) and the current bid (LA, Licitação Actual), plus a hard
// deadline. That's carried alongside the normal listing fields (as
// `listing.leilao`) rather than forced into the venda/arrendamento price
// model other sources use — `price` is set to the starting bid (valor
// base), the closest equivalent to an "asking price" a judicial auction
// has.
//
// Detail enrichment: the list endpoint alone only gives title, VB/VM/LA,
// district/concelho, dates and one cover photo — description, the full
// photo gallery, area (privativa/dependente/total), tipologia and GPS
// coordinates live on a separate per-listing endpoint,
// api/Eventos/<referencia>/ (found the same way, via the browser's
// Network tab while viewing /evento/<referencia>). Fetching that for
// all ~800 listings on every run would mean ~800 more sequential
// requests (at the same paced delay as everything else here, that's
// close to 40 minutes) — instead, previousListingsById (the previous
// run's own already-detailed listings, passed in by
// run-eleiloes-manual.js) is checked first, and only listings that have
// never been detailed before (or whose detail fetch previously failed)
// actually hit the network. So the first run against a given catalogue
// is the slow one; every run after that only pays for genuinely new
// auctions.
//
// Deliberately NOT captured from that endpoint: `executados` (the
// debtor's name and NIF) and the case-manager's contact details — that's
// personal data about a named individual in financial distress, not
// property information, and republishing it here serves no purpose this
// site has. `onus` (liens/encumbrances, e.g. an existing lease that
// survives the sale) is kept, since — unlike `executados` — it's about
// the property, not a person, and matters to anyone actually bidding.

const SOURCE_NAME = "e-Leilões";
const SOURCE_URL = "https://www.e-leiloes.pt";
const API_URL = "https://www.e-leiloes.pt/api/Eventos/";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 3000;
const ROWS_PER_PAGE = 12; // matches the site's own default page size (confirmed working); untested with larger values
const TIPO_IMOVEL = 1; // "tipo" filter value for the "Imóveis" category, confirmed via the site's own UI/network tab

// Missing intermediate cert for osae.pt/e-leiloes.pt's TLS chain — see the
// long comment above. Fetched from http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt
const SECTIGO_DV_R36_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----`;

// tls.rootCertificates is Node's own bundled trust store — passing `ca` to
// an Agent *replaces* it rather than extending it, so every other root
// needs to be included alongside the one intermediate we're patching in.
const eleiloesAgent = new https.Agent({
  ca: [...tls.rootCertificates, SECTIGO_DV_R36_INTERMEDIATE],
  keepAlive: true,
});

// A small hand-rolled fetch instead of lib/http.js's shared createFetcher:
// this source is the only one that needs the custom `ca` above (global
// fetch() can't take a plain https.Agent — it only accepts undici's own
// Dispatcher type), so it isn't worth complicating the shared fetcher for
// every other source's sake. Retry/backoff behaviour mirrors createFetcher
// (network-error and 429 both treated as transient, same jittered backoff).
function fetchText(url, retries = 3, retryBaseDelayMs = 6000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      const req = https.request(
        url,
        {
          agent: eleiloesAgent,
          headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "pt-PT,pt;q=0.9" },
        },
        (res) => {
          if (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600)) {
            res.resume();
            return onTransientFailure(`respondeu ${res.statusCode}`);
          }
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error(`${url}: demasiados redirecionamentos`));
            return resolve(
              fetchText(new URL(res.headers.location, url).toString(), retries, retryBaseDelayMs, redirectsLeft - 1)
            );
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`${url} respondeu ${res.statusCode}`));
          }
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }
      );
      req.on("error", (err) => onTransientFailure(err.message));
      req.end();
    };
    const onTransientFailure = (detail) => {
      if (attempt >= retries) {
        return reject(new Error(`${url}: falha de rede persistente após ${retries} tentativas (${detail})`));
      }
      const wait = jitteredDelay(retryBaseDelayMs * (attempt + 1));
      console.warn(`[http] falha de rede em ${url} (${detail}), a aguardar ${wait}ms antes de repetir`);
      attempt++;
      sleep(wait).then(tryOnce);
    };
    tryOnce();
  });
}

function buildEventosUrl(first) {
  const tableParams = JSON.stringify({
    first,
    rows: ROWS_PER_PAGE,
    sortField: "dataFim",
    sortOrder: 1,
    filters: { tipo: { value: TIPO_IMOVEL, matchMode: "equals" } },
  });
  return `${API_URL}?tableParams=${encodeURIComponent(tableParams)}`;
}

// Exported (only) for debug-eleiloes.js.
export async function fetchEventosPage(first) {
  return fetchText(buildEventosUrl(first));
}

export async function fetchEventoDetail(referencia) {
  return fetchText(`${API_URL}${referencia}/`);
}

// Titles come back either plain ("Apartamento T2 sito em Santarém") or
// wrapped in "**...**" (no discernible pattern for which) — strip the
// markers either way rather than treating them as part of the title.
function cleanTitle(titulo) {
  return (titulo || "").replace(/^\*\*|\*\*$/g, "").trim();
}

function buildListingFromEvento(evento) {
  if (evento.cancelado || evento.terminado) return null;
  if (evento.valorBase == null || !evento.referencia) return null;

  const title = cleanTitle(evento.titulo);
  if (!title) return null;

  const listingUrl = `${SOURCE_URL}/evento/${evento.referencia}`;
  const location = [evento.moradaConcelho, evento.moradaDistrito].filter(Boolean).join(", ") || null;
  const image = evento.capa ? toAbsoluteUrl(evento.capa, SOURCE_URL) : null;

  return {
    id: idFromUrl(listingUrl, "eleiloes"),
    title,
    type: "venda",
    price: evento.valorBase,
    currency: "EUR",
    location,
    bedrooms: parseBedroomsFromText(title),
    bathrooms: null,
    area_m2: null,
    image,
    images: image ? [image] : [],
    description: null,
    features: null,
    estado: null,
    area_util_m2: null,
    area_bruta_m2: null,
    ano_construcao: null,
    certificacao_energetica: null,
    geo: null,
    source: { name: SOURCE_NAME, url: SOURCE_URL },
    listing_url: listingUrl,
    published_at: evento.dataInicio ? evento.dataInicio.slice(0, 10) : new Date().toISOString().slice(0, 10),
    leilao: {
      valor_base: evento.valorBase,
      valor_minimo: evento.valorMinimo ?? null,
      licitacao_atual: evento.lanceAtual ?? null,
      data_inicio: evento.dataInicio ?? null,
      data_fim: evento.dataFim ?? null,
    },
  };
}

// Merges a fully-detailed evento (from fetchEventoDetail) into a listing
// built by buildListingFromEvento. Mutates in place — called right after
// construction, in a loop, so there's no benefit to the immutable-update
// style used elsewhere in this file.
function applyEventoDetail(listing, detail) {
  const images = capImages(
    (detail.fotos || []).map((f) => toAbsoluteUrl(f.image, SOURCE_URL)).filter(Boolean)
  );
  if (images.length) {
    listing.images = images;
    listing.image = images[0];
  }

  listing.description = [detail.descricao, detail.observacoes].filter(Boolean).join("\n\n") || null;

  const bedroomsFromTipologia = parseBedroomsFromText(detail.tipologia);
  if (bedroomsFromTipologia != null) listing.bedrooms = bedroomsFromTipologia;

  const areaUtil = Number.isFinite(detail.areaUtilPrivativa) ? detail.areaUtilPrivativa : null;
  const areaTotal = Number.isFinite(detail.areaTotal) ? detail.areaTotal : null;
  listing.area_util_m2 = areaUtil;
  listing.area_bruta_m2 = areaTotal;
  listing.area_m2 = areaUtil ?? areaTotal;

  const lat = Number(detail.coordenadasLAT);
  const lng = Number(detail.coordenadasLON);
  listing.geo = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  listing.leilao.valor_abertura = detail.valorAbertura ?? null;
  listing.leilao.onus = (detail.onus || []).map((o) => ({
    tipo: o.tipoDesc || null,
    valor: o.valor ?? null,
    descricao: o.descricao || null,
  }));
}

// Same shape of update as applyEventoDetail, but copying from this
// listing's own previous run instead of a fresh API response — see the
// "Detail enrichment" comment above for why this is the common case.
function applyPreviousDetail(listing, previous) {
  listing.description = previous.description ?? null;
  if (previous.images?.length) {
    listing.images = previous.images;
    listing.image = previous.image ?? previous.images[0];
  }
  if (previous.bedrooms != null) listing.bedrooms = previous.bedrooms;
  listing.area_util_m2 = previous.area_util_m2 ?? null;
  listing.area_bruta_m2 = previous.area_bruta_m2 ?? null;
  listing.area_m2 = previous.area_m2 ?? null;
  listing.geo = previous.geo ?? null;
  listing.leilao.valor_abertura = previous.leilao?.valor_abertura ?? null;
  listing.leilao.onus = previous.leilao?.onus ?? [];
}

export async function scrapeELeiloes({ maxPages = 100, previousListingsById = new Map(), maxDetailFetches = 1000 } = {}) {
  const entries = [];
  let first = 0;
  let total = Infinity;

  for (let page = 1; page <= maxPages && first < total; page++) {
    let body;
    try {
      body = await fetchEventosPage(first);
    } catch (err) {
      console.error(`[eleiloes] falhou a página ${page} (first=${first}): ${err.message}`);
      break;
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch (err) {
      console.error(`[eleiloes] resposta da API não é JSON válido na página ${page}: ${err.message}`);
      break;
    }

    if (json.errors) {
      console.error(`[eleiloes] API reportou erro na página ${page}: ${JSON.stringify(json.errorsList)}`);
      break;
    }

    const items = json.list || [];
    total = json.pagination?.total ?? items.length;

    let addedThisPage = 0;
    for (const evento of items) {
      const listing = buildListingFromEvento(evento);
      if (!listing) continue;
      entries.push({ listing, referencia: evento.referencia });
      addedThisPage++;
    }
    console.log(
      `[eleiloes] página ${page} (first=${first}): ${items.length} recebido(s), ${addedThisPage} válido(s) — catálogo tem ${total} no total`
    );

    if (items.length === 0) break;
    first += ROWS_PER_PAGE;
    if (first < total) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  console.log(`[eleiloes] total: ${entries.length} imóveis em leilão — a obter detalhe (descrição, área, fotos, coordenadas)...`);

  let fetched = 0;
  let reused = 0;
  let failed = 0;
  for (const { listing, referencia } of entries) {
    const previous = previousListingsById.get(listing.id);
    if (previous && previous.description != null) {
      applyPreviousDetail(listing, previous);
      reused++;
      continue;
    }
    if (fetched >= maxDetailFetches) continue;

    try {
      const body = await fetchEventoDetail(referencia);
      const json = JSON.parse(body);
      if (json.errors) throw new Error(JSON.stringify(json.errorsList));
      if (json.item) applyEventoDetail(listing, json.item);
      fetched++;
    } catch (err) {
      console.warn(`[eleiloes] falhou o detalhe de ${referencia}: ${err.message}`);
      failed++;
    }
    await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  console.log(
    `[eleiloes] detalhe: ${fetched} obtido(s) de novo, ${reused} reaproveitado(s) de execuções anteriores, ${failed} falhado(s)`
  );

  return entries.map((e) => e.listing);
}
