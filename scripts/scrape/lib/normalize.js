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
// back a price that's off by 1000x (confirmed on imovirtual-706bdd6dd1,
// "Trofa - Coronado": the real Imovirtual page showed 397500€, our data
// had 397500000€ - exactly 1000x) — not anything our scraping logic
// computed wrong. An absolute ceiling, not a price-per-m² ratio: a
// separate, unrelated bug already in production has some listings'
// area_m2 parsed as single digits (e.g. a whole house at "6 m²") with a
// perfectly normal price attached, and a per-m² check would reject those
// good listings too. The current real catalogue's most expensive
// genuine listings (Sotheby's luxury villas) top out under 10M€, so 50M€
// only ever flags values that are themselves absurd on their own,
// regardless of area.
const MAX_PLAUSIBLE_PRICE_EUR = 50_000_000;

// Tried once a price trips the ceiling above: if dividing by 1000 lands
// back under it, that's almost certainly the real price (same bug as
// imovirtual-706bdd6dd1) and worth recovering rather than just hiding
// the listing. A value that's still implausible after ÷1000 (e.g. a
// placeholder number like 1234567890) isn't this bug — drop it instead
// of publishing a "corrected" figure that's still a guess.
function correctImplausiblePrice(id, price) {
  const corrected = price / 1000;
  if (corrected > 0 && corrected <= MAX_PLAUSIBLE_PRICE_EUR) {
    console.warn(`[normalize] ${id}: preço implausível (${price}€) corrigido para ${corrected}€ (÷1000)`);
    return corrected;
  }
  console.warn(`[normalize] ${id}: preço implausível (${price}€), sem correção óbvia — anúncio ignorado`);
  return null;
}

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
    price = correctImplausiblePrice(id, price);
    if (price == null) return null;
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
