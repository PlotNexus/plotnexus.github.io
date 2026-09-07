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

  function featuresHtml(features) {
    if (!features || Object.keys(features).length === 0) return "";

    const tabs = Object.entries(features)
      .map(
        ([label, items]) => `
          <div class="listing-features-group">
            <h3 class="listing-features-label">${escapeHtml(label)}</h3>
            <div class="listing-features-items">
              ${items.map((item) => `<span class="feature-pill">${escapeHtml(item)}</span>`).join("")}
            </div>
          </div>
        `
      )
      .join("");

    return `
      <div class="listing-section">
        <h2 class="listing-section-title">Características</h2>
        ${tabs}
      </div>
    `;
  }

  function technicalDataHtml(item) {
    const rows = [
      ["Estado", item.estado],
      ["Área útil", item.area_util_m2 ? `${item.area_util_m2} m²` : null],
      ["Área bruta", item.area_bruta_m2 ? `${item.area_bruta_m2} m²` : null],
      ["Ano de construção", item.ano_construcao],
      ["Certificação energética", item.certificacao_energetica],
      ["Publicado em", item.published_at],
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
                  <div class="listing-technical-value">${escapeHtml(value)}</div>
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
    const specs = [];
    if (item.bedrooms > 0) specs.push(`T${item.bedrooms}`);
    if (item.bathrooms) specs.push(`${item.bathrooms} WC`);
    if (item.area_m2) specs.push(`${item.area_m2} m²`);

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
      ${media}
      <div class="listing-detail-body">
        <div class="listing-badges">
          <span class="card-type-badge listing-type-badge">${isRent ? "Arrendar" : "Comprar"}</span>
          <span class="source-badge" data-source="${escapeHtml(item.source.name)}">${escapeHtml(item.source.name)}</span>
        </div>
        <h1 class="listing-title">${escapeHtml(item.title)}</h1>
        <p class="listing-location">${escapeHtml(item.location)}</p>
        <div class="listing-price">${currency(item.price, item.currency)}${
      isRent ? '<span class="per-month"> /mês</span>' : ""
    }</div>
        ${specs.length ? `<div class="listing-specs">${specs.join(" · ")}</div>` : ""}
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
