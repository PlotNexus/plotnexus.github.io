(function () {
  "use strict";

  // Portugal's rough geographic centre/zoom for the initial view, before the
  // user has picked anywhere.
  const DEFAULT_CENTER = [39.6, -8.0];
  const DEFAULT_ZOOM = 7;

  // Leaflet's default marker icon is loaded via relative paths baked into
  // its own CSS, which breaks when leaflet.css is served from a CDN whose
  // base URL doesn't match — point it at the same CDN's image assets
  // explicitly rather than shipping our own copies.
  function fixDefaultMarkerIcon() {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }

  // Free-text location search via Nominatim (OpenStreetMap's own geocoder,
  // no API key needed). Restricted to Portugal so a plain place name like
  // "Aveiro" doesn't resolve somewhere else in the world.
  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=pt&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`geocoding falhou: ${response.status}`);
    const results = await response.json();
    if (!results.length) return null;
    return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
  }

  // `onChange` is called with `{ lat, lng, radiusKm }` once a centre has
  // been picked (by click or search), on every radius change, and with
  // `null` when cleared. Returns a small handle for the caller (app.js) to
  // reveal/clear the panel from the toolbar toggle.
  function initMapFilter({
    toggleButton,
    panel,
    mapContainerId,
    addressInput,
    addressSubmit,
    radiusInput,
    radiusValueEl,
    clearButton,
    onChange,
  }) {
    let map = null;
    let marker = null;
    let circle = null;
    let center = null; // { lat, lng }
    let radiusKm = Number(radiusInput.value);

    function radiusMeters() {
      return radiusKm * 1000;
    }

    function updateRadiusLabel() {
      radiusValueEl.textContent = `${radiusKm} km`;
    }

    function emitChange() {
      if (!center) {
        clearButton.hidden = true;
        onChange(null);
        return;
      }
      clearButton.hidden = false;
      onChange({ lat: center.lat, lng: center.lng, radiusKm });
    }

    function placeAt(lat, lng, { fly = false } = {}) {
      center = { lat, lng };

      if (!marker) {
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        marker.on("dragend", () => {
          const pos = marker.getLatLng();
          center = { lat: pos.lat, lng: pos.lng };
          circle.setLatLng(pos);
          emitChange();
        });
      } else {
        marker.setLatLng([lat, lng]);
      }

      if (!circle) {
        circle = L.circle([lat, lng], {
          radius: radiusMeters(),
          color: "#26bebe",
          fillColor: "#26bebe",
          fillOpacity: 0.12,
          weight: 2,
        }).addTo(map);
      } else {
        circle.setLatLng([lat, lng]);
        circle.setRadius(radiusMeters());
      }

      if (fly) {
        map.flyTo([lat, lng], Math.max(map.getZoom(), 12));
      }

      emitChange();
    }

    function ensureMapInitialised() {
      if (map) return;

      fixDefaultMarkerIcon();
      map = L.map(mapContainerId).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      map.on("click", (event) => {
        // At the default national view a radius circle of a few km is just
        // a speck — zoom in on the first click so it's actually visible and
        // easy to fine-tune. Once the user is already zoomed in (e.g. after
        // that first click, or after an address search), respect whatever
        // zoom they've since chosen rather than yanking it around.
        placeAt(event.latlng.lat, event.latlng.lng, { fly: map.getZoom() < 11 });
      });
    }

    radiusInput.addEventListener("input", () => {
      radiusKm = Number(radiusInput.value);
      updateRadiusLabel();
      if (circle) circle.setRadius(radiusMeters());
      if (center) emitChange();
    });

    clearButton.addEventListener("click", () => {
      center = null;
      if (marker) {
        map.removeLayer(marker);
        map.removeLayer(circle);
        marker = null;
        circle = null;
      }
      emitChange();
    });

    async function submitAddressSearch() {
      const query = addressInput.value.trim();
      if (!query) return;
      addressSubmit.disabled = true;
      addressSubmit.textContent = "A procurar...";
      try {
        const result = await geocode(query);
        if (!result) {
          window.alert(`Não foi possível encontrar "${query}".`);
          return;
        }
        placeAt(result.lat, result.lng, { fly: true });
      } catch (err) {
        console.error("Falha na pesquisa de localização:", err);
        window.alert("Não foi possível pesquisar essa localização de momento.");
      } finally {
        addressSubmit.disabled = false;
        addressSubmit.textContent = "Procurar";
      }
    }

    addressSubmit.addEventListener("click", submitAddressSearch);
    addressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAddressSearch();
      }
    });

    toggleButton.addEventListener("click", () => {
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      toggleButton.setAttribute("aria-expanded", String(willOpen));
      toggleButton.textContent = willOpen ? "Ocultar mapa" : "Pesquisar no mapa";

      if (willOpen) {
        ensureMapInitialised();
        // Leaflet computes its tile grid from the container's size at init
        // time — since the panel was `hidden` (0×0) until just now, it
        // needs an explicit nudge to size itself correctly.
        setTimeout(() => map.invalidateSize(), 0);
      }
    });

    updateRadiusLabel();
  }

  window.PN = window.PN || {};
  window.PN.initMapFilter = initMapFilter;
})();
