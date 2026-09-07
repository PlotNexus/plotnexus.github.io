import * as cheerio from "cheerio";
import {
  parsePriceEUR,
  parseBedroomsFromText,
  parseAreaM2,
  guessListingType,
  idFromUrl,
  toAbsoluteUrl,
  normalizeListing,
} from "../lib/normalize.js";

const SOURCE_NAME = "CASA SAPO";
const SOURCE_URL = "https://casa.sapo.pt";
const SEARCH_URL = "https://casa.sapo.pt/comprar-casas/em-lisboa/";
const USER_AGENT =
  "PlotNexusBot/0.1 (+https://plotnexus.github.io; personal aggregator project; contact via github.com/PlotNexus)";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-PT,pt;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`${url} respondeu ${res.status}`);
  }
  return res.text();
}

function extractFromJsonLd($) {
  const listings = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
    for (const item of items) {
      const type = JSON.stringify(item["@type"] || "");
      if (!/RealEstateListing|Product|Offer|Residence|House|Apartment/i.test(type)) continue;

      const url = item.url || item["@id"];
      const name = item.name;
      const priceRaw = item.offers?.price ?? item.price;
      if (!url || !name || !priceRaw) continue;

      const price = Number(priceRaw);
      if (!Number.isFinite(price)) continue;

      const listingUrl = toAbsoluteUrl(url, SOURCE_URL);
      if (!listingUrl) continue;

      listings.push(
        normalizeListing({
          id: idFromUrl(listingUrl, "casasapo"),
          title: name,
          type: guessListingType(name),
          price,
          location: item.address?.addressLocality || "",
          bedrooms: parseBedroomsFromText(name),
          area_m2: parseAreaM2(JSON.stringify(item)),
          sourceName: SOURCE_NAME,
          sourceUrl: SOURCE_URL,
          listingUrl,
        })
      );
    }
  });
  return listings.filter(Boolean);
}

// CASA SAPO wraps listing links in an ad-tracking redirect
// (gespub.casa.sapo.pt/.../counter.aspx?...&l=<real url>). Prefer the real
// destination when present, both for a cleaner link and a stable id.
function resolveRealListingUrl(absoluteUrl) {
  try {
    const parsed = new URL(absoluteUrl);
    if (parsed.hostname.includes("gespub.casa.sapo.pt")) {
      const real = parsed.searchParams.get("l");
      if (real) return real;
    }
  } catch {
    // fall through
  }
  return absoluteUrl;
}

const PROPERTY_TYPE_REGEX =
  /^(Apartamento|Moradia|Quinta|Terreno|Loja|Armaz[ée]m|Escrit[óo]rio|Pr[ée]dio|Quarto|Garagem)\s*(T\d+(?:\+\d+)?)?/i;
const CONDITION_REGEX = /(Usado|Novo|Recuperado|Em constru[cç][aã]o|Em projecto|Para Recuperar)/i;
const CONDITION_LABEL = {
  usado: "usado",
  novo: "novo",
  recuperado: "remodelado",
  "para recuperar": "para recuperar",
};

function parseListingBlock(block) {
  const typeMatch = block.match(PROPERTY_TYPE_REGEX);
  const conditionMatch = block.match(CONDITION_REGEX);

  const propertyType = typeMatch?.[1] || "Imóvel";
  const typology = typeMatch?.[2] || "";
  const title = `${propertyType}${typology ? " " + typology : ""}`.trim();

  let location = "";
  if (typeMatch && conditionMatch && conditionMatch.index > typeMatch[0].length) {
    location = block.slice(typeMatch[0].length, conditionMatch.index).replace(/,\s*$/, "").trim();
  }

  const conditionKey = conditionMatch?.[1]?.toLowerCase();
  const conditionLabel = conditionKey ? CONDITION_LABEL[conditionKey] : null;
  const fullTitle = conditionLabel ? `${title} ${conditionLabel}` : title;

  return { title: fullTitle, location };
}

function extractByHeuristic($) {
  const priceRegex = /\d{1,3}(?:[.\s]\d{3})*\s*€/;
  const candidates = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const absoluteUrl = toAbsoluteUrl(href, SOURCE_URL);
    if (!absoluteUrl || !absoluteUrl.includes("sapo.pt")) return;

    // Heuristic: a real listing detail link usually has a long numeric id
    // or a descriptive slug in the path (not a nav/filter link).
    const looksLikeListing = /\/\d{5,}(?:$|[/?])/.test(absoluteUrl) || /apartamento|moradia|t\d/i.test(absoluteUrl);
    if (!looksLikeListing) return;

    const block = $(el).text().replace(/\s+/g, " ").trim();
    if (!priceRegex.test(block)) return;

    candidates.push({ listingUrl: resolveRealListingUrl(absoluteUrl), block });
  });

  console.log(`[casasapo] heuristic: ${candidates.length} candidate anchors matched a price`);
  if (candidates.length > 0) {
    console.log("[casasapo] sample candidate:", JSON.stringify(candidates[0]).slice(0, 400));
  }

  const listings = [];
  const seen = new Set();
  for (const { listingUrl, block } of candidates) {
    if (seen.has(listingUrl)) continue;
    seen.add(listingUrl);

    const price = parsePriceEUR(block);
    if (!price) continue;

    const { title, location } = parseListingBlock(block);

    listings.push(
      normalizeListing({
        id: idFromUrl(listingUrl, "casasapo"),
        title,
        type: guessListingType(block),
        price,
        location,
        bedrooms: parseBedroomsFromText(block),
        area_m2: parseAreaM2(block),
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
        listingUrl,
      })
    );
  }
  return listings.filter(Boolean);
}

export async function scrapeCasaSapo({ maxListings = 24 } = {}) {
  const html = await fetchHtml(SEARCH_URL);
  const $ = cheerio.load(html);

  console.log(`[casasapo] fetched ${SEARCH_URL} (${html.length} bytes)`);

  let listings = extractFromJsonLd($);
  console.log(`[casasapo] JSON-LD strategy: ${listings.length} listings`);

  if (listings.length === 0) {
    listings = extractByHeuristic($);
    console.log(`[casasapo] heuristic strategy: ${listings.length} listings`);
  }

  return listings.slice(0, maxListings);
}
