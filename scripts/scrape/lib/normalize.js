import { createHash } from "node:crypto";

export function parsePriceEUR(text) {
  if (!text) return null;
  const match = String(text).match(/(\d{1,3}(?:[.\s]\d{3})*)(?:,(\d{2}))?\s*€/);
  if (!match) return null;
  const digits = match[1].replace(/[.\s]/g, "");
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

export function parseBedroomsFromText(text) {
  if (!text) return null;
  const match = String(text).match(/\bT(\d)\b/i);
  return match ? Number(match[1]) : null;
}

export function parseAreaM2(text) {
  if (!text) return null;
  const match = String(text).match(/(\d{1,4})\s*m(?:2|²)/i);
  return match ? Number(match[1]) : null;
}

export function guessListingType(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("arrend")) return "arrendamento";
  return "venda";
}

export function idFromUrl(url, prefix) {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return `${prefix}-${hash}`;
}

export function toAbsoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// Confirmed on real listings: a source's own API/page occasionally hands
// back a price that's off by 1000x or more (one real case: Imovirtual's
// totalPrice.value was 397500000 for a house actually listed at 397500€)
// — not anything our scraping logic computed wrong, but worth guarding
// against before publishing it. An absolute ceiling, not a price-per-m²
// ratio: a separate, unrelated bug already in production has some
// listings' area_m2 parsed as single digits (e.g. a whole house at
// "6 m²") with a perfectly normal price attached, and a per-m² check
// would reject those good listings too. The current real catalogue's
// most expensive genuine listings (Sotheby's luxury villas) top out
// under 10M€, so 50M€ only ever catches values that are themselves
// absurd on their own, regardless of area. Dropping the listing (same as
// the existing "!price" check below) beats guessing a "corrected" price
// we have no way to actually know.
const MAX_PLAUSIBLE_PRICE_EUR = 50_000_000;

export function normalizeListing({
  id,
  title,
  type,
  price,
  currency = "EUR",
  location,
  bedrooms = null,
  bathrooms = null,
  area_m2 = null,
  image = null,
  description = null,
  geo = null,
  sourceName,
  sourceUrl,
  listingUrl,
  publishedAt,
}) {
  if (!id || !title || !price || !listingUrl) return null;
  if (price > MAX_PLAUSIBLE_PRICE_EUR) {
    console.warn(`[normalize] ${id}: preço implausível (${price}€) — anúncio ignorado`);
    return null;
  }
  return {
    id,
    title: title.trim(),
    type: type === "arrendamento" ? "arrendamento" : "venda",
    price,
    currency,
    location: (location || "").trim(),
    bedrooms,
    bathrooms,
    area_m2,
    image: image || null,
    description: description ? String(description).trim() : null,
    geo: geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng) ? geo : null,
    source: { name: sourceName, url: sourceUrl },
    listing_url: listingUrl,
    published_at: publishedAt || new Date().toISOString().slice(0, 10),
  };
}
