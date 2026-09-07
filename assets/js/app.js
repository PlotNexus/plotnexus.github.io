(function () {
  "use strict";

  const { escapeHtml, currency, houseIcon, loadListings } = window.PN;

  const state = {
    listings: [],
    query: "",
    tipo: "todos",
    tipologia: "qualquer",
    precoMin: null,
    precoMax: null,
    areaMin: null,
    areaMax: null,
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
    bannerText: document.getElementById("banner-demo-text"),
    advancedToggle: document.getElementById("advanced-filters-toggle"),
    advancedPanel: document.getElementById("advanced-filters"),
    tipologiaSelect: document.getElementById("tipologia"),
    precoMinInput: document.getElementById("preco-min"),
    precoMaxInput: document.getElementById("preco-max"),
    areaMinInput: document.getElementById("area-min"),
    areaMaxInput: document.getElementById("area-max"),
    advancedForm: document.getElementById("advanced-filters"),
  };

  function buildSourceChips() {
    const sources = Array.from(new Set(state.listings.map((item) => item.source.name))).sort();

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
      !q || item.title.toLowerCase().includes(q) || item.location.toLowerCase().includes(q);

    const matchesTipo = state.tipo === "todos" || item.type === state.tipo;
    const matchesSource = state.activeSources.has(item.source.name);

    const matchesTipologia =
      state.tipologia === "qualquer" ||
      (state.tipologia === "t5mais" ? (item.bedrooms ?? -1) >= 5 : item.bedrooms === Number(state.tipologia));

    const matchesPrecoMin = state.precoMin == null || item.price >= state.precoMin;
    const matchesPrecoMax = state.precoMax == null || item.price <= state.precoMax;
    const matchesAreaMin = state.areaMin == null || (item.area_m2 ?? 0) >= state.areaMin;
    const matchesAreaMax = state.areaMax == null || (item.area_m2 ?? Infinity) <= state.areaMax;

    return (
      matchesQuery &&
      matchesTipo &&
      matchesSource &&
      matchesTipologia &&
      matchesPrecoMin &&
      matchesPrecoMax &&
      matchesAreaMin &&
      matchesAreaMax
    );
  }

  function sortListings(list) {
    const sorted = list.slice();
    if (state.sort === "preco-asc") {
      sorted.sort((a, b) => a.price - b.price);
    } else if (state.sort === "preco-desc") {
      sorted.sort((a, b) => b.price - a.price);
    } else if (state.sort === "area-desc") {
      sorted.sort((a, b) => (b.area_m2 ?? 0) - (a.area_m2 ?? 0));
    } else if (state.sort === "area-asc") {
      sorted.sort((a, b) => (a.area_m2 ?? Infinity) - (b.area_m2 ?? Infinity));
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

    const detailUrl = `imovel.html?id=${encodeURIComponent(item.id)}`;
    const media = item.image
      ? `<img class="card-photo" src="${escapeHtml(item.image)}" alt="" loading="lazy" />`
      : houseIcon();

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <a class="card-link-wrap" href="${escapeHtml(detailUrl)}" aria-label="Ver detalhes de ${escapeHtml(item.title)}">
        <div class="card-media${item.image ? " has-photo" : ""}">
          <span class="card-type-badge">${isRent ? "Arrendar" : "Comprar"}</span>
          ${media}
        </div>
        <div class="card-body">
          <div class="card-price">${currency(item.price, item.currency)}${
      isRent ? '<span class="per-month"> /mês</span>' : ""
    }</div>
          <h3 class="card-title">${escapeHtml(item.title)}</h3>
          <div class="card-location">${escapeHtml(item.location)}</div>
          <div class="card-specs">${specs.join(" · ")}</div>
        </div>
      </a>
      <div class="card-footer">
        <span class="source-badge" data-source="${escapeHtml(item.source.name)}">${escapeHtml(item.source.name)}</span>
        <a class="card-link" href="${escapeHtml(detailUrl)}">Ver detalhes →</a>
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

  function parseNumberOrNull(value) {
    if (value === "" || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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

    if (el.advancedToggle && el.advancedPanel) {
      el.advancedToggle.addEventListener("click", () => {
        const willOpen = el.advancedPanel.hidden;
        el.advancedPanel.hidden = !willOpen;
        el.advancedToggle.setAttribute("aria-expanded", String(willOpen));
        el.advancedToggle.textContent = willOpen ? "Menos filtros" : "Mais filtros";
      });
    }

    if (el.advancedForm) {
      el.advancedForm.addEventListener("submit", (event) => {
        event.preventDefault();
        state.tipologia = el.tipologiaSelect.value;
        state.precoMin = parseNumberOrNull(el.precoMinInput.value);
        state.precoMax = parseNumberOrNull(el.precoMaxInput.value);
        state.areaMin = parseNumberOrNull(el.areaMinInput.value);
        state.areaMax = parseNumberOrNull(el.areaMaxInput.value);
        render();
      });
    }
  }

  async function init() {
    attachEvents();

    const { listings, isSample } = await loadListings();
    state.listings = listings;

    if (!isSample && el.bannerText) {
      el.bannerText.innerHTML =
        "🔧 <strong>Em expansão:</strong> por agora cobrimos apenas uma fonte de anúncios. Estamos a trabalhar para adicionar mais imobiliárias brevemente.";
    }

    buildSourceChips();
    render();
  }

  init();
})();
