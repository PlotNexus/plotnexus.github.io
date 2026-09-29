import * as cheerio from "cheerio";
import { idFromUrl, toAbsoluteUrl, parseBedroomsFromText } from "../lib/normalize.js";
import { createFetcher, sleepJittered } from "../lib/http.js";

// e-leilões.pt — the official judicial property-auction platform (run by
// OSAE, the Order of Solicitors and Enforcement Agents). Not part of the
// automated scrape (see .github/workflows/scrape.yml / worker.js): this
// site is unreachable from every datacenter network tested (this repo's
// own dev sandbox, a real GitHub Actions runner, and Anthropic's own
// web-fetch infrastructure all got the exact same behaviour — DNS and raw
// TCP connect both succeed instantly, but the actual HTTPS request hangs
// for ~12s and then gets reset) while working instantly from an ordinary
// residential connection. That points at IP-range-based filtering rather
// than a broken site, and GitHub Actions runners are exactly the kind of
// datacenter range such filtering targets — so this can only run from
// wherever a person runs it by hand, on their own network. See
// run-eleiloes-manual.js.
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

const fetchHtml = createFetcher({ userAgent: USER_AGENT, retries: 3, retryBaseDelayMs: 6000 });

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

async function fetchListingPage(pageNum) {
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
