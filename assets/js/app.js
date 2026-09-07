(function () {
  "use strict";

  const REAL_DATA_URL = "data/listings.json";
  const SAMPLE_DATA_URL = "data/listings.sample.json";

  const state = {
    listings: [],
    query: "",
    tipo: "todos",
    activeSources: new Set(),
    sort: "recentes",
  };

  const el = {
    grid: document.getElementById("listings-grid"),
    resultsCount: document.getElementById("results-count"),
    emptyState: document.getElementById("empty-state"),
    sourcesFilter: document.getElementById("sources-filter"),
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("q"),
    tipoSelect: document.getElementById("tipo"),
    sortSelect: document.getElementById("sort"),
    year: document.getElementById("year"),
    bannerText: document.getElementById("banner-demo-text"),
  };

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

  function buildSourceChips() {
    const sources = Array.from(
      new Set(state.listings.map((item) => item.source.name))
    ).sort();

    sources.forEach((name) => state.activeSources.add(name));

    el.sourcesFilter.querySelectorAll(".chip").forEach((chip) => chip.remove());

    sources.forEach((name) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = name;
      chip.setAttribute("aria-pressed", "true");
      chip.addEventListener("click", () => {
        if (state.activeSources.has(name)) {
          state.activeSources.delete(name);
          chip.setAttribute("aria-pressed", "false");
        } else {
          state.activeSources.add(name);
          chip.setAttribute("aria-pressed", "true");
        }
        render();
      });
      el.sourcesFilter.appendChild(chip);
    });
  }

  function matchesFilters(item) {
    const q = state.query.trim().toLowerCase();
    const matchesQuery =
      !q ||
      item.title.toLowerCase().includes(q) ||
      item.location.toLowerCase().includes(q);

    const matchesTipo = state.tipo === "todos" || item.type === state.tipo;
    const matchesSource = state.activeSources.has(item.source.name);

    return matchesQuery && matchesTipo && matchesSource;
  }

  function sortListings(list) {
    const sorted = list.slice();
    if (state.sort === "preco-asc") {
      sorted.sort((a, b) => a.price - b.price);
    } else if (state.sort === "preco-desc") {
      sorted.sort((a, b) => b.price - a.price);
    } else {
      sorted.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    }
    return sorted;
  }

  function renderCard(item) {
    const isRent = item.type === "arrendamento";
    const specs = [];
    if (item.bedrooms > 0) specs.push(`T${item.bedrooms}`);
    if (item.bathrooms) specs.push(`${item.bathrooms} WC`);
    if (item.area_m2) specs.push(`${item.area_m2} m²`);

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-media">
        <span class="card-type-badge">${isRent ? "Arrendar" : "Comprar"}</span>
        ${houseIcon()}
      </div>
      <div class="card-body">
        <div class="card-price">${currency(item.price, item.currency)}${
      isRent ? '<span class="per-month"> /mês</span>' : ""
    }</div>
        <h3 class="card-title">${item.title}</h3>
        <div class="card-location">${item.location}</div>
        <div class="card-specs">${specs.join(" · ")}</div>
        <div class="card-footer">
          <span class="source-badge" data-source="${item.source.name}">${item.source.name}</span>
          <a class="card-link" href="${item.listing_url}" target="_blank" rel="noopener noreferrer">Ver anúncio →</a>
        </div>
      </div>
    `;
    return card;
  }

  function render() {
    const filtered = sortListings(state.listings.filter(matchesFilters));

    el.grid.innerHTML = "";
    filtered.forEach((item) => el.grid.appendChild(renderCard(item)));

    el.resultsCount.textContent = `${filtered.length} imóve${
      filtered.length === 1 ? "l" : "is"
    } encontrado${filtered.length === 1 ? "" : "s"}`;

    el.emptyState.hidden = filtered.length !== 0;
    el.grid.hidden = filtered.length === 0;
  }

  function attachEvents() {
    el.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.query = el.searchInput.value;
      state.tipo = el.tipoSelect.value;
      render();
    });

    el.sortSelect.addEventListener("change", () => {
      state.sort = el.sortSelect.value;
      render();
    });

    el.year.textContent = new Date().getFullYear();
  }

  async function fetchListings(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    const data = await response.json();
    return data.listings || [];
  }

  async function init() {
    attachEvents();

    let usingSample = false;
    try {
      state.listings = await fetchListings(REAL_DATA_URL);
      if (state.listings.length === 0) throw new Error("sem anúncios reais ainda");
    } catch (error) {
      console.warn("A usar dados de exemplo:", error.message);
      usingSample = true;
      try {
        state.listings = await fetchListings(SAMPLE_DATA_URL);
      } catch (sampleError) {
        console.error("Não foi possível carregar os imóveis de exemplo.", sampleError);
        state.listings = [];
      }
    }

    if (!usingSample && el.bannerText) {
      el.bannerText.innerHTML =
        '🔧 <strong>Em expansão:</strong> por agora só agregamos anúncios da <strong>CASA SAPO</strong> — as restantes imobiliárias (Imovirtual, Idealista, SUPERCASA, RE/MAX) serão adicionadas em breve.';
    }

    buildSourceChips();
    render();
  }

  init();
})();
