(function () {
  "use strict";

  const REAL_DATA_URL = "data/listings.json";
  const SAMPLE_DATA_URL = "data/listings.sample.json";

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function currency(value, curr) {
    return new Intl.NumberFormat("pt-PT", {
      style: "currency",
      currency: curr || "EUR",
      maximumFractionDigits: 0,
    }).format(value);
  }

  function houseIcon() {
    return (
      '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 11L12 3L21 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M5 10V20H19V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M9 20V14H15V20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  async function fetchListings(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    const data = await response.json();
    return data.listings || [];
  }

  async function loadListings() {
    try {
      const listings = await fetchListings(REAL_DATA_URL);
      if (listings.length === 0) throw new Error("sem anúncios reais ainda");
      return { listings, isSample: false };
    } catch (error) {
      console.warn("A usar dados de exemplo:", error.message);
      try {
        const listings = await fetchListings(SAMPLE_DATA_URL);
        return { listings, isSample: true };
      } catch (sampleError) {
        console.error("Não foi possível carregar os imóveis de exemplo.", sampleError);
        return { listings: [], isSample: true };
      }
    }
  }

  function findListingById(listings, id) {
    return listings.find((item) => item.id === id) || null;
  }

  // Great-circle distance in km between two lat/lng points (haversine
  // formula) — plenty accurate for a "within N km" radius filter.
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // A quiet little easter egg: typing the creator's handle anywhere on the
  // site (outside of a text field) reveals a small credit line for a few
  // seconds. Not documented anywhere on purpose.
  function initEasterEgg() {
    const SECRET = "nightmareftw";
    let buffer = "";
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const isTyping = target && /^(input|textarea|select)$/i.test(target.tagName);
      if (isTyping || event.key.length !== 1) return;

      buffer = (buffer + event.key.toLowerCase()).slice(-SECRET.length);
      if (buffer !== SECRET) return;

      const el = document.createElement("div");
      el.className = "easter-egg-credit";
      el.textContent = "Feito por NightmareFTW";
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("visible"));
      setTimeout(() => {
        el.classList.remove("visible");
        setTimeout(() => el.remove(), 600);
      }, 3200);
    });
  }

  window.PN = {
    escapeHtml,
    currency,
    houseIcon,
    loadListings,
    findListingById,
    haversineKm,
    initEasterEgg,
  };

  initEasterEgg();

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
