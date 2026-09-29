import https from "node:https";
import tls from "node:tls";
import * as cheerio from "cheerio";
import { idFromUrl, toAbsoluteUrl, parseBedroomsFromText } from "../lib/normalize.js";
import { sleep, jitteredDelay, sleepJittered } from "../lib/http.js";

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
// A very different data shape from every other source, too: this is a
// judicial auction, not a listed sale — there's no single "asking price",
// there's a starting bid (VB, Valor Base), a minimum acceptable bid (VM,
// Valor Mínimo) and the current bid (LA, Licitação Actual), plus a hard
// deadline. See buildAuctionInfo below for how that's carried alongside
// the normal listing fields (as `listing.leilao`) rather than forced into
// the venda/arrendamento price model other sources use.

const SOURCE_NAME = "e-Leilões";
const SOURCE_URL = "https://www.e-leiloes.pt";
const LISTING_PAGE_URL = "https://www.e-leiloes.pt/listagem.aspx";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

const DELAY_BETWEEN_QUERIES_MS = 3000;

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
function fetchHtml(url, retries = 3, retryBaseDelayMs = 6000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      const req = https.request(
        url,
        { agent: eleiloesAgent, headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt-PT,pt;q=0.9" } },
        (res) => {
          if (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600)) {
            res.resume();
            return onTransientFailure(`respondeu ${res.statusCode}`);
          }
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error(`${url}: demasiados redirecionamentos`));
            return resolve(
              fetchHtml(new URL(res.headers.location, url).toString(), retries, retryBaseDelayMs, redirectsLeft - 1)
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

// Property-type keywords actually seen on the listings page (screenshot,
// 2026-09) — used to keep only the "Imóveis" category out of the auction
// platform's full catalogue (which also covers vehicles, equipment,
// furniture, machinery, "direitos"). Deliberately broad/inclusive: a
// false positive here just means one extra non-property row gets built
// and then silently dropped for lacking a parseable price, not a crash.
const PROPERTY_KEYWORDS =
  /\b(apartamento|moradia|vivenda|terreno|prédio|predio|armaz[ée]m|loja|escrit[óo]rio|gar(?:agem|em)|fra[cç][aã]o|quinta|edif[íi]cio|lote)\b/i;

const REFERENCE_RE = /\bLO\d{6,}\b/g;
const TITLE_RE = /\*\*(.+?)\*\*/;
const VB_RE = /VB:?\s*([\d.,\s]+)\s*€/i;
const VM_RE = /VM:?\s*([\d.,\s]+)\s*€/i;
const LA_RE = /LA:?\s*([\d.,\s]+)\s*€/i;
const DATE_FROM_RE = /\bde:?\s*(\d{2}\/\d{2}\/\d{4})/i;
const DATE_TO_RE = /\ba:?\s*(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/i;

function parseEuro(text) {
  if (!text) return null;
  const digits = text.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

// "DD/MM/YYYY" (+ optional "HH:MM:SS") -> ISO-ish "YYYY-MM-DD"[ "T"HH:MM:SS].
function parsePtDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split("/");
  if (!d || !m || !y) return null;
  const iso = `${y}-${m}-${d}`;
  return timeStr ? `${iso}T${timeStr}` : iso;
}

// Splits the page's flattened visible text into one chunk per listing,
// anchored on the reference code (the one thing confirmed present, once,
// per card) — robust to not knowing the real class names/DOM structure,
// unlike a cheerio selector guessed from a screenshot alone.
function splitIntoCards(bodyText) {
  const matches = [...bodyText.matchAll(REFERENCE_RE)];
  const cards = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : bodyText.length;
    cards.push({ reference: matches[i][0], text: bodyText.slice(start, end) });
  }
  return cards;
}

// The card's own detail-page link — found by scanning every <a href> on
// the page for one whose own text contains this card's reference code,
// rather than assuming a specific class/structure. A listing without a
// confidently-matched link is dropped rather than given a guessed url:
// every other source on this site guarantees "Ver anúncio original"
// really goes to the real listing, and that's not worth breaking here.
function buildReferenceToHrefMap($) {
  const map = new Map();
  $("a[href]").each((_, el) => {
    const text = $(el).text();
    const match = text.match(/\bLO\d{6,}\b/);
    if (match && !map.has(match[0])) {
      map.set(match[0], $(el).attr("href"));
    }
  });
  return map;
}

function buildAuctionInfo(cardText) {
  const vb = parseEuro(VB_RE.exec(cardText)?.[1]);
  const vm = parseEuro(VM_RE.exec(cardText)?.[1]);
  const la = parseEuro(LA_RE.exec(cardText)?.[1]);
  const fromMatch = DATE_FROM_RE.exec(cardText);
  const toMatch = DATE_TO_RE.exec(cardText);
  return {
    valor_base: vb,
    valor_minimo: vm,
    licitacao_atual: la,
    data_inicio: parsePtDate(fromMatch?.[1]),
    data_fim: parsePtDate(toMatch?.[1], toMatch?.[2]),
  };
}

// Whatever free text sits between the reference/badge and the bolded
// title — in the screenshot this is the tipologia ("Apartamento, T1")
// followed by the district/concelho ("Faro, Loulé"). Kept as one combined
// string rather than split apart: with no real HTML to check the exact
// separator against, guessing wrong would silently corrupt both fields,
// where folding them together just reads slightly redundantly on the
// card. parseBedroomsFromText still finds "T1"/"T2"/etc. wherever it
// falls in this string.
function extractLocationMeta(cardText, titleMatchIndex) {
  const prefix = cardText.slice(0, titleMatchIndex);
  const withoutBadge = prefix.replace(/^\s*\bLO\d{6,}\b/, "").replace(/\bLeil[aã]o\s+Online\b/i, "");
  return withoutBadge.replace(/\s+/g, " ").trim();
}

function buildListingFromCard(card, hrefByReference) {
  const titleMatch = TITLE_RE.exec(card.text);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();
  if (!title) return null;

  const href = hrefByReference.get(card.reference);
  if (!href) return null;
  const listingUrl = toAbsoluteUrl(href, SOURCE_URL);
  if (!listingUrl) return null;

  const locationMeta = extractLocationMeta(card.text, titleMatch.index);
  if (!PROPERTY_KEYWORDS.test(locationMeta) && !PROPERTY_KEYWORDS.test(title)) return null;

  const auction = buildAuctionInfo(card.text);
  if (auction.valor_base == null) return null;

  return {
    id: idFromUrl(listingUrl, "eleiloes"),
    title,
    type: "venda",
    price: auction.valor_base,
    currency: "EUR",
    location: locationMeta || null,
    bedrooms: parseBedroomsFromText(locationMeta) ?? parseBedroomsFromText(title),
    bathrooms: null,
    area_m2: null,
    image: null,
    images: [],
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
    published_at: auction.data_inicio || new Date().toISOString().slice(0, 10),
    leilao: auction,
  };
}

// Exported (only) for debug-eleiloes.js — everything else here reaches the
// page through scrapeELeiloes.
export async function fetchListingPage(pageNum) {
  const url = pageNum > 1 ? `${LISTING_PAGE_URL}?page=${pageNum}` : LISTING_PAGE_URL;
  return fetchHtml(url);
}

export async function scrapeELeiloes({ maxPages = 15 } = {}) {
  const all = [];
  const seenIds = new Set();
  let previousBodyText = null;

  for (let page = 1; page <= maxPages; page++) {
    let html;
    try {
      html = await fetchListingPage(page);
    } catch (err) {
      console.error(`[eleiloes] falhou a página ${page}: ${err.message}`);
      break;
    }

    const $ = cheerio.load(html);
    const bodyText = $("body").text();

    // No confirmed pagination scheme (ASP.NET WebForms sites often
    // paginate via postback, which a plain GET can't follow) — if
    // "?page=N" turns out not to change anything, stop rather than
    // looping through N identical copies of page 1.
    if (previousBodyText !== null && bodyText === previousBodyText) {
      console.log(`[eleiloes] página ${page} idêntica à anterior — a parar (paginação provavelmente não é via ?page=N)`);
      break;
    }
    previousBodyText = bodyText;

    const hrefByReference = buildReferenceToHrefMap($);
    const cards = splitIntoCards(bodyText);
    if (cards.length === 0) {
      console.log(`[eleiloes] página ${page}: nenhuma referência de leilão encontrada — a parar`);
      break;
    }

    let addedThisPage = 0;
    for (const card of cards) {
      const listing = buildListingFromCard(card, hrefByReference);
      if (!listing || seenIds.has(listing.id)) continue;
      seenIds.add(listing.id);
      all.push(listing);
      addedThisPage++;
    }
    console.log(`[eleiloes] página ${page}: ${cards.length} referência(s), ${addedThisPage} imóvel/imóveis novo(s)`);

    if (addedThisPage === 0) break;
    if (page < maxPages) await sleepJittered(DELAY_BETWEEN_QUERIES_MS);
  }

  console.log(`[eleiloes] total: ${all.length} imóveis em leilão`);
  return all;
}
