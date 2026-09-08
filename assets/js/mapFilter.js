(function () {
  "use strict";

  // Portugal's rough geographic centre/zoom for the initial view, before the
  // user has picked anywhere.
  const DEFAULT_CENTER = [39.6, -8.0];
  const DEFAULT_ZOOM = 7;

  // Leaflet's own runtime detection of its default marker icon path (by
  // reading a computed CSS background-image) is a bit fragile depending on
  // how the page's CSS cascades — set it explicitly to our vendored copies
  // instead of relying on that.
  function fixDefaultMarkerIcon() {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "assets/vendor/leaflet/images/marker-icon-2x.png",
      iconUrl: "assets/vendor/leaflet/images/marker-icon.png",
      shadowUrl: "assets/vendor/leaflet/images/marker-shadow.png",
    });
  }

  // Free-text location search via Nominatim (OpenStreetMap's own geocoder,
  // no API key needed). Restricted to Portugal so a plain place name like
  // "Aveiro" doesn't resolve somewhere else in the world.
  //
  // Nominatim's usage policy requires a valid Referer or User-Agent
  // identifying the calling application ("stock User-Agents ... will not
  // do") — a page can't set a custom User-Agent from JS, and a browser's
  // *default* referrer policy doesn't always send one for a cross-origin
  // request (varies by browser/privacy settings), which silently turned
  // into a 403 "Access denied" rather than a network error. Forcing
  // `referrerPolicy: "origin"` here sends it regardless of the page's own
  // default, satisfying the policy every time.
  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=pt&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, referrerPolicy: "origin" });
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
      // Defensive: placeAt can be reached from the address search regardless
      // of whether the map panel was ever actually opened first (e.g. a
      // stale/bfcache-restored tab, or any other path that skipped the
      // toggle button's own init call) — never assume the panel is open or
      // `map` is already set.
      revealPanel();
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
      // Assigned before `.setView(...)` runs (rather than chained in one
      // statement) so that even if setView were to throw — e.g. called
      // against a container that isn't actually visible/sized yet — `map`
      // still ends up holding a real Leaflet instance instead of staying
      // null forever, which would otherwise break every later use of it.
      map = L.map(mapContainerId);
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
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

    // Opens the panel (if not already open), lazily creates the Leaflet map
    // on first call, and re-nudges its size every time — cheap and
    // idempotent, so any entry point (the toggle button, or placeAt() being
    // reached some other way) can call this and be guaranteed a visible,
    // correctly-sized, initialised map afterwards rather than assuming
    // some earlier step already did it.
    function revealPanel() {
      if (panel.hidden) {
        panel.hidden = false;
        toggleButton.setAttribute("aria-expanded", "true");
        toggleButton.textContent = "Ocultar mapa";
      }
      ensureMapInitialised();
      // Leaflet computes its tile grid from the container's size at init
      // time — since the panel was `hidden` (0×0) until just now, it needs
      // an explicit nudge to size itself correctly.
      setTimeout(() => map.invalidateSize(), 0);
    }

    toggleButton.addEventListener("click", () => {
      if (panel.hidden) {
        revealPanel();
      } else {
        panel.hidden = true;
        toggleButton.setAttribute("aria-expanded", "false");
        toggleButton.textContent = "Pesquisar no mapa";
      }
    });

    updateRadiusLabel();
  }

  window.PN = window.PN || {};
  window.PN.initMapFilter = initMapFilter;
})();
