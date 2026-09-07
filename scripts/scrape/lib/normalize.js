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
  sourceName,
  sourceUrl,
  listingUrl,
  publishedAt,
}) {
  if (!id || !title || !price || !listingUrl) return null;
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
    source: { name: sourceName, url: sourceUrl },
    listing_url: listingUrl,
    published_at: publishedAt || new Date().toISOString().slice(0, 10),
  };
}
