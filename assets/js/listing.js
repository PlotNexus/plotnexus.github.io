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

  function renderListing(item) {
    document.title = `${item.title} | PlotNexus`;

    const isRent = item.type === "arrendamento";
    const specs = [];
    if (item.bedrooms > 0) specs.push(`T${item.bedrooms}`);
    if (item.bathrooms) specs.push(`${item.bathrooms} WC`);
    if (item.area_m2) specs.push(`${item.area_m2} m²`);

    const media = item.image
      ? `<img class="listing-photo" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" />`
      : `<div class="listing-photo listing-photo-placeholder">${houseIcon()}</div>`;

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
