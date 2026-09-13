// Regenerated every run (not a one-off static file) because the listing
// catalogue itself changes every run — new ids appear, stale ones get
// pruned after STALE_LISTING_RETENTION_DAYS (see merge.js). A sitemap
// that only listed index.html/sobre.html would miss the tens of
// thousands of imovel.html?id=... pages, which is most of the site's
// actual SEO surface — those pages are otherwise only reachable via a
// client-side fetch of data/listings.json, not a crawlable link.
const BASE_URL = "https://plotnexus.github.io";

function xmlEscape(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function urlEntry(loc, lastmod) {
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
}

// `listings` should be the summary-shaped array (id + published_at is all
// this needs) — see toListingSummary in lib/merge.js.
export function buildSitemap(listings) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    urlEntry(`${BASE_URL}/`, today),
    urlEntry(`${BASE_URL}/sobre.html`, today),
    ...listings.map((l) => urlEntry(`${BASE_URL}/imovel.html?id=${encodeURIComponent(l.id)}`, l.published_at || today)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}
