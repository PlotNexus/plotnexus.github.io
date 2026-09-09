(function () {
  "use strict";

  const { escapeHtml, currency, houseIcon, loadListings, findListingById } = window.PN;

  const el = {
    loading: document.getElementById("listing-loading"),
    notFound: document.getElementById("listing-not-found"),
    detail: document.getElementById("listing-detail"),
  };

  function osmEmbedUrl(geo) {
    const delta = 0.006;
    const bbox = [geo.lng - delta, geo.lat - delta * 0.7, geo.lng + delta, geo.lat + delta * 0.7].join("%2C");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${geo.lat}%2C${geo.lng}`;
  }

  function osmLinkUrl(geo) {
    return `https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lng}#map=16/${geo.lat}/${geo.lng}`;
  }

  function icon(paths, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  const STROKE = 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"';

  function bedIcon() {
    return icon(`<path d="M2 4v16" ${STROKE}/><path d="M2 8h18a2 2 0 0 1 2 2v10" ${STROKE}/><path d="M2 17h20" ${STROKE}/><path d="M6 8v9" ${STROKE}/>`);
  }

  function bathIcon() {
    return icon(`<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3Z" ${STROKE}/><path d="M4 12V7a2 2 0 0 1 2-2h1" ${STROKE}/><path d="M7 19v2" ${STROKE}/><path d="M17 19v2" ${STROKE}/>`);
  }

  function areaIcon() {
    return icon(`<path d="M8 3H5a2 2 0 0 0-2 2v3" ${STROKE}/><path d="M21 8V5a2 2 0 0 0-2-2h-3" ${STROKE}/><path d="M3 16v3a2 2 0 0 0 2 2h3" ${STROKE}/><path d="M16 21h3a2 2 0 0 0 2-2v-3" ${STROKE}/>`);
  }

  function roomIcon() {
    return icon(`<rect x="3" y="3" width="18" height="18" rx="2" ${STROKE}/><path d="M3 9h18" ${STROKE}/>`, 20);
  }

  function printIcon() {
    return icon(`<path d="M6 9V2h12v7" ${STROKE}/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" ${STROKE}/><rect x="6" y="14" width="12" height="8" ${STROKE}/>`, 16);
  }

  function shareIcon() {
    return icon(`<circle cx="18" cy="5" r="3" ${STROKE}/><circle cx="6" cy="12" r="3" ${STROKE}/><circle cx="18" cy="19" r="3" ${STROKE}/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5" ${STROKE}/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" ${STROKE}/>`, 16);
  }

  // Raw energy-certificate values are inconsistent across sources — some
  // already send a clean "A+"/"B-", others send raw API enum codes
  // ("APLUS", "IN_PROCESS", "N/A"). Normalizing here (rather than per
  // source) covers everything already cached in listings-detail.json too,
  // not just future scrapes. An unrecognized value is dropped (returns
  // null) rather than shown raw, per the site's no-foreign-text rule.
  const ENERGY_LABELS = {
    "A+": "A+", APLUS: "A+",
    A: "A", B: "B",
    "B-": "B-", BMINUS: "B-",
    C: "C", D: "D", E: "E", F: "F", G: "G",
    EXEMPT: "Isento", ISENTO: "Isento",
    INPROCESS: "Em trâmite", EMTRAMITE: "Em trâmite",
  };

  function normalizeEnergyLabel(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toUpperCase().replace(/[\s_]+/g, "");
    return ENERGY_LABELS[key] || null;
  }

  function energyBadgeHtml(raw) {
    const label = normalizeEnergyLabel(raw);
    if (!label) return null;
    const tier = /^[A-G][+-]?$/.test(label) ? label.toLowerCase().replace("+", "plus").replace("-", "minus") : "info";
    return `<span class="epc-badge" data-tier="${tier}">${escapeHtml(label)}</span>`;
  }

  function specBarHtml(item) {
    const specs = [];
    if (item.bedrooms > 0) specs.push([bedIcon(), `T${item.bedrooms}`]);
    if (item.bathrooms) specs.push([bathIcon(), `${item.bathrooms} WC`]);
    if (item.area_util_m2) specs.push([areaIcon(), `${item.area_util_m2} m² úteis`]);
    if (item.area_bruta_m2 && item.area_bruta_m2 !== item.area_util_m2) {
      specs.push([areaIcon(), `${item.area_bruta_m2} m² brutos`]);
    }
    if (!item.area_util_m2 && !item.area_bruta_m2 && item.area_m2) {
      specs.push([areaIcon(), `${item.area_m2} m²`]);
    }
    if (specs.length === 0) return "";
    return `
      <div class="listing-spec-bar">
        ${specs.map(([svg, label]) => `<span class="spec-chip">${svg}<span>${escapeHtml(label)}</span></span>`).join("")}
      </div>
    `;
  }

  function showToast(message) {
    let toast = document.querySelector(".pn-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "pn-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add("visible"));
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  async function shareListing(item) {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: item.title, text: `${item.title} — ${currency(item.price, item.currency)}`, url });
      } catch (err) {
        if (err.name !== "AbortError") showToast("Não foi possível partilhar.");
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copiado para a área de transferência.");
    } catch {
      showToast("Não foi possível copiar o link.");
    }
  }

  function descriptionHtml(description) {
    if (!description) return "";
    return description
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
      .join("");
  }

  function galleryHtml(images, title) {
    if (!images || images.length === 0) {
      return `<div class="listing-photo listing-photo-placeholder">${houseIcon()}</div>`;
    }

    if (images.length === 1) {
      return `<img class="listing-photo" src="${escapeHtml(images[0])}" alt="${escapeHtml(title)}" />`;
    }

    const thumbs = images
      .map(
        (src, i) =>
          `<button type="button" class="listing-gallery-thumb${i === 0 ? " active" : ""}" data-index="${i}" aria-label="Foto ${i + 1} de ${images.length}">
            <img src="${escapeHtml(src)}" alt="" loading="lazy" />
          </button>`
      )
      .join("");

    return `
      <div class="listing-gallery" data-count="${images.length}">
        <div class="listing-gallery-main">
          <button type="button" class="listing-gallery-nav prev" aria-label="Foto anterior">&larr;</button>
          <img class="listing-photo listing-gallery-current" src="${escapeHtml(images[0])}" alt="${escapeHtml(title)}" />
          <button type="button" class="listing-gallery-nav next" aria-label="Foto seguinte">&rarr;</button>
          <span class="listing-gallery-count">1 / ${images.length}</span>
        </div>
        <div class="listing-gallery-thumbs">${thumbs}</div>
      </div>
    `;
  }

  function attachGalleryEvents(images) {
    const gallery = el.detail.querySelector(".listing-gallery");
    if (!gallery) return;

    const mainImg = gallery.querySelector(".listing-gallery-current");
    const countEl = gallery.querySelector(".listing-gallery-count");
    const thumbs = [...gallery.querySelectorAll(".listing-gallery-thumb")];
    let index = 0;

    function show(newIndex) {
      index = (newIndex + images.length) % images.length;
      mainImg.src = images[index];
      countEl.textContent = `${index + 1} / ${images.length}`;
      thumbs.forEach((thumb, i) => thumb.classList.toggle("active", i === index));
    }

    gallery.querySelector(".prev").addEventListener("click", () => show(index - 1));
    gallery.querySelector(".next").addEventListener("click", () => show(index + 1));
    thumbs.forEach((thumb) => {
      thumb.addEventListener("click", () => show(Number(thumb.dataset.index)));
    });
  }

  // "Divisões" (and per-floor variants like "Piso 0 - Divisões") get a
  // card grid instead of plain pills — a nicer, more organized read for
  // room-style breakdowns than a flat list of pills.
  function isDivisionsCategory(label) {
    return /divis/i.test(label);
  }

  function pillsHtml(items) {
    return `<div class="listing-features-items">${items.map((item) => `<span class="feature-pill">${escapeHtml(item)}</span>`).join("")}</div>`;
  }

  function divisionsGridHtml(items) {
    return `
      <div class="divisions-grid">
        ${items
          .map(
            (item) => `
              <div class="division-card">
                <span class="division-card-icon">${roomIcon()}</span>
                <span class="division-card-label">${escapeHtml(item)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function featuresHtml(features) {
    const entries = Object.entries(features || {}).filter(([, items]) => items && items.length);
    if (entries.length === 0) return "";

    if (entries.length === 1) {
      const [label, items] = entries[0];
      return `
        <div class="listing-section">
          <h2 class="listing-section-title">Características</h2>
          ${isDivisionsCategory(label) ? divisionsGridHtml(items) : pillsHtml(items)}
        </div>
      `;
    }

    const tabButtons = entries
      .map(
        ([label], i) => `
          <button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-tab-index="${i}" role="tab" aria-selected="${i === 0}">
            ${escapeHtml(label)}
          </button>
        `
      )
      .join("");

    const tabPanels = entries
      .map(
        ([label, items], i) => `
          <div class="tab-panel" data-tab-index="${i}" role="tabpanel" ${i === 0 ? "" : "hidden"}>
            ${isDivisionsCategory(label) ? divisionsGridHtml(items) : pillsHtml(items)}
          </div>
        `
      )
      .join("");

    return `
      <div class="listing-section">
        <h2 class="listing-section-title">Características</h2>
        <div class="listing-tabs" role="tablist">${tabButtons}</div>
        <div class="listing-tab-panels">${tabPanels}</div>
      </div>
    `;
  }

  function attachTabEvents() {
    const tabsContainer = el.detail.querySelector(".listing-tabs");
    if (!tabsContainer) return;

    const buttons = [...tabsContainer.querySelectorAll(".tab-btn")];
    const panels = [...el.detail.querySelectorAll(".tab-panel")];

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = btn.dataset.tabIndex;
        buttons.forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.tabIndex !== index;
        });
      });
    });
  }

  function technicalDataHtml(item) {
    const rows = [
      ["Estado", item.estado],
      ["Área útil", item.area_util_m2 ? `${item.area_util_m2} m²` : null],
      ["Área bruta", item.area_bruta_m2 ? `${item.area_bruta_m2} m²` : null],
      ["Ano de construção", item.ano_construcao],
      ["Certificação energética", energyBadgeHtml(item.certificacao_energetica)],
    ].filter(([, value]) => value != null && value !== "");

    if (rows.length === 0) return "";

    return `
      <div class="listing-section">
        <h2 class="listing-section-title">Dados do imóvel</h2>
        <div class="listing-technical-grid">
          ${rows
            .map(
              ([label, value]) => `
                <div class="listing-technical-item">
                  <div class="listing-technical-label">${escapeHtml(label)}</div>
                  <div class="listing-technical-value">${label === "Certificação energética" ? value : escapeHtml(value)}</div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function renderListing(item) {
    document.title = `${item.title} | PlotNexus`;

    const isRent = item.type === "arrendamento";

    const images = item.images && item.images.length ? item.images : item.image ? [item.image] : [];
    const media = galleryHtml(images, item.title);

    const mapBlock = item.geo
      ? `
        <div class="listing-map">
          <iframe
            src="${osmEmbedUrl(item.geo)}"
            title="Localização aproximada do imóvel"
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
          ></iframe>
          <a href="${osmLinkUrl(item.geo)}" target="_blank" rel="noopener noreferrer" class="listing-map-link">
            Ver mapa maior num separador novo
          </a>
        </div>`
      : "";

    const descriptionBlock = item.description
      ? `<div class="listing-description">${descriptionHtml(item.description)}</div>`
      : "";

    el.detail.innerHTML = `
      <div class="listing-hero">
        ${media}
        <div class="listing-hero-info">
          <div class="listing-badges">
            <span class="card-type-badge listing-type-badge">${isRent ? "Arrendar" : "Comprar"}</span>
            <span class="source-badge" data-source="${escapeHtml(item.source.name)}">${escapeHtml(item.source.name)}</span>
          </div>
          <h1 class="listing-title">${escapeHtml(item.title)}</h1>
          <p class="listing-location">${escapeHtml(item.location)}</p>
          ${specBarHtml(item)}
          <div class="listing-price-row">
            <div class="listing-price">${currency(item.price, item.currency)}${
      isRent ? '<span class="per-month"> /mês</span>' : ""
    }</div>
            <div class="listing-actions-row">
              <button type="button" class="icon-btn" id="btn-print" aria-label="Imprimir anúncio">${printIcon()} Imprimir</button>
              <button type="button" class="icon-btn" id="btn-share" aria-label="Partilhar anúncio">${shareIcon()} Partilhar</button>
            </div>
          </div>
        </div>
      </div>
      <div class="listing-body">
        ${descriptionBlock}
        ${technicalDataHtml(item)}
        ${featuresHtml(item.features)}
        ${mapBlock}
        <a
          class="btn btn-primary listing-cta"
          href="${escapeHtml(item.listing_url)}"
          target="_blank"
          rel="noopener noreferrer"
        >
          Ver anúncio original em ${escapeHtml(item.source.name)} →
        </a>
      </div>
    `;

    if (images.length > 1) attachGalleryEvents(images);
    attachTabEvents();

    const printBtn = el.detail.querySelector("#btn-print");
    const shareBtn = el.detail.querySelector("#btn-share");
    if (printBtn) printBtn.addEventListener("click", () => window.print());
    if (shareBtn) shareBtn.addEventListener("click", () => shareListing(item));

    el.loading.hidden = true;
    el.detail.hidden = false;
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");

    const { listings } = await loadListings();
    const item = id ? findListingById(listings, id) : null;

    if (!item) {
      el.loading.hidden = true;
      el.notFound.hidden = false;
      return;
    }

    renderListing(item);
  }

  init();
})();
