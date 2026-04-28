/**
 * PlaneSight Map Card — Live ADS-B radar for Home Assistant
 *
 * Renders a clean OpenStreetMap-based radar view of aircraft seen by your
 * ultrafeeder / tar1090 instance.  Plane icons are rotated to their heading
 * and colour-coded by altitude.  No sidebar, no toolbars — just the map.
 *
 * Card config (Lovelace YAML):
 *
 *   type: custom:planesight-card-map
 *   url: "http://192.168.1.50:8080"    # tar1090 base URL
 *   height: 450                         # map height in px  (default 450)
 *   poll_interval: 5                    # refresh seconds   (default 5)
 *   dark_tiles: true                    # dark CartoDB tiles (default true)
 *   range_rings: true                   # draw range rings   (default true)
 *   range_ring_distances: [50,100,200]  # distances in nm   (default [50,100,150,200])
 *   auto_fit: false                     # auto-zoom to all planes (default false)
 *   show_controls: false                # show Leaflet zoom controls (default false)
 */

// ---------------------------------------------------------------------------
// Leaflet loader — loads once into the document, then resolves on every call
// ---------------------------------------------------------------------------

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_JS  = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;

let _leafletPromise = null;

async function loadLeaflet() {
  if (_leafletPromise) return _leafletPromise;

  _leafletPromise = (async () => {
    // ── CSS into document head ───────────────────────────────────────────
    if (!document.getElementById("leaflet-css-global")) {
      const link = document.createElement("link");
      link.id   = "leaflet-css-global";
      link.rel  = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }

    // ── JS into document head ────────────────────────────────────────────
    if (!window.L) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src     = LEAFLET_JS;
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // Fix for broken default marker images (we use divIcon, but silence errors)
    if (window.L) {
      window.L.Icon.Default.imagePath =
        `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/`;
    }
  })();

  return _leafletPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const R_NM          = 3440.065;
const FEET_TO_METRES = 0.3048;
const KNOTS_TO_KMH   = 1.852;
const NM_TO_KM       = 1.852;
const DISTANCE_FIELDS = ["distance_nm", "distance", "dist", "dst", "r_dst"];

function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function positionAgeSeconds(ac) {
  const age = Number(ac.seen_pos ?? ac.seen ?? 0);
  return Number.isFinite(age) ? age : 0;
}

function existingDistanceNm(ac) {
  for (const field of DISTANCE_FIELDS) {
    if (ac[field] == null) continue;
    const n = Number(ac[field]);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

function aircraftKey(ac, idx = 0) {
  return ac.hex || `${ac.lat}:${ac.lon}:${ac.flight || ac.r || idx}`;
}

/**
 * Colour an aircraft marker by barometric altitude.
 *   ground / unknown  →  grey
 *   < 2 000 ft        →  lime green   (very low / local traffic)
 *   2 000–10 000 ft   →  yellow-green
 *   10 000–20 000 ft  →  amber
 *   20 000–30 000 ft  →  sky blue
 *   > 30 000 ft       →  violet       (cruise altitude)
 */
/** Resolve alt_baro to feet (number), handling "ground" and "FL200" strings. */
function altToFeet(alt) {
  if (alt === undefined || alt === null) return null;
  if (typeof alt === "string") {
    const v = alt.trim().toLowerCase();
    if (v === "ground") return 0;
    if (v.startsWith("fl")) {
      const fl = Number(v.slice(2));
      return Number.isFinite(fl) ? fl * 100 : null;
    }
    const n = Number(alt);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(alt);
  return Number.isFinite(n) ? n : null;
}

function altColor(alt) {
  const ft = altToFeet(alt);
  if (ft === null) return "#9ca3af";   // unknown → grey
  if (ft === 0)    return "#9ca3af";   // ground  → grey
  if (ft <  2_000) return "#4ade80";   // lime
  if (ft < 10_000) return "#a3e635";   // yellow-green
  if (ft < 20_000) return "#fbbf24";   // amber
  if (ft < 30_000) return "#38bdf8";   // sky blue
  return "#c084fc";                     // violet
}

/** Top-down airplane SVG path (nose pointing up / north at 0°). */
function planeSvg(color, heading, size = 22) {
  // We rotate the wrapping div rather than the SVG path so the hit-box stays square.
  return `
    <div style="
      width:${size}px;height:${size}px;
      transform:rotate(${heading ?? 0}deg);
      filter:drop-shadow(0 0 3px rgba(0,0,0,0.9)) drop-shadow(0 1px 2px rgba(0,0,0,0.7));
    ">
      <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <!-- fuselage -->
        <ellipse cx="12" cy="11" rx="1.6" ry="7.5" fill="${color}"/>
        <!-- wings -->
        <polygon points="12,10 2,16.5 2,18 12,14.5 22,18 22,16.5" fill="${color}"/>
        <!-- horizontal stabiliser -->
        <polygon points="12,18.5 7,21 7,22 12,20.5 17,22 17,21" fill="${color}"/>
      </svg>
    </div>`;
}

function formatPopupAlt(alt) {
  if (alt === undefined || alt === null) return "--";
  const ft = altToFeet(alt);
  if (ft === null) return "--";
  if (ft === 0)    return "GND";
  const m = Math.round((ft * FEET_TO_METRES) / 10) * 10;
  return `${m.toLocaleString()} m`;
}

function formatPopupSpeed(gs) {
  if (gs == null) return "--";
  return `${Math.round(gs * KNOTS_TO_KMH)} km/h`;
}

// ---------------------------------------------------------------------------
// Web Component
// ---------------------------------------------------------------------------

class PlaneSightMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._config       = {};
    this._map          = null;
    this._markers      = new Map();   // hex → L.Marker
    this._recvMarker   = null;
    this._rangeRings   = [];
    this._pollTimer    = null;
    this._bootPromise  = null;
    this._resizeObserver = null;
    this._lastAircraft = [];
    this._receiverLat  = null;
    this._receiverLon  = null;
    this._receiverIsHomeFallback = false;
    this._recvFetched  = false;
    this._lastSensorUpdated = null;
    this._mapReady     = false;
    this._homeDefaultApplied = false;
    this._leafletCssInjected = false;
    this._visibilityHandler = () => this._recoverMap();
    this._windowResizeHandler = () => this._recoverMap();
    this._photoCache   = new Map();   // hex → photo URL or null
    this._photoPromises = new Map();   // hex → in-flight planespotters lookup
  }

  _isValidCoordinate(lat, lon) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    );
  }

  _homeLocation() {
    const lat = Number(this._hass?.config?.latitude);
    const lon = Number(this._hass?.config?.longitude);
    return this._isValidCoordinate(lat, lon) ? { lat, lon } : null;
  }

  _setHomeDefaultView() {
    if (!this._map || this._receiverLat != null || this._homeDefaultApplied) return;

    const home = this._homeLocation();
    if (home) {
      this._map.setView([home.lat, home.lon], this._config.default_zoom || 8);
      this._homeDefaultApplied = true;
    }
  }

  // ------------------------------------------------------------------
  // HA card protocol
  // ------------------------------------------------------------------

  static getStubConfig() {
    return {
      url: "http://192.168.1.1:8080",
      height: 450,
      dark_tiles: true,
      range_rings: true,
    };
  }

  setConfig(config) {
    if (!config.url && !config.entity) {
      throw new Error("PlaneSight map card: provide either `url` or `entity`");
    }
    this._destroyMap();
    this._config = { ...config };
    this._homeDefaultApplied = false;
    this._render();
    this._boot();
  }

  connectedCallback() {
    window.addEventListener("resize", this._windowResizeHandler);
    document.addEventListener("visibilitychange", this._visibilityHandler);

    if (this._config.url || this._config.entity) {
      this._boot();
    }
    this._recoverMap();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._mapReady) {
      this._setHomeDefaultView();
    }
    // Entity mode: HA calls set hass on every entity change in the system.
    // Only process when the PlaneSight sensor itself has actually updated.
    // We also gate on _mapReady; _lastSensorUpdated is only set when the map
    // is ready, so the first call after boot always processes current state.
    if (this._config.entity && this._mapReady) {
      const state = hass.states[this._config.entity];
      if (state && state.last_updated !== this._lastSensorUpdated) {
        this._lastSensorUpdated = state.last_updated;

        const aircraft = state.attributes.aircraft || [];
        const rLat = Number(state.attributes.receiver_lat);
        const rLon = Number(state.attributes.receiver_lon);
        if (
          this._isValidCoordinate(rLat, rLon) &&
          (this._receiverLat == null || this._receiverIsHomeFallback)
        ) {
          this._receiverLat = rLat;
          this._receiverLon = rLon;
          this._receiverIsHomeFallback = false;
          this._placeReceiverMarker();
          this._addRangeRings();
          this._map.setView([rLat, rLon], this._config.default_zoom || 8);
        }
        this._setHomeReceiverFallback();
        this._updatePlanes(aircraft.map((ac) => this._enrichAircraft(ac)));
      }
    }
  }

  getCardSize() {
    return Math.ceil((this._config.height || 450) / 50);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this._windowResizeHandler);
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    this._destroyMap();
  }

  _destroyMap() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._map) {
      this._map.remove();
      this._map = null;
      this._mapReady = false;
    }
    this._bootPromise = null;
    this._recvMarker = null;
    this._rangeRings = [];
    this._markers.clear();
    // Reset fetch flags so a new boot re-fetches receiver position and
    // re-processes the first entity-mode state it receives.
    this._recvFetched = false;
    this._lastSensorUpdated = null;
  }

  // ------------------------------------------------------------------
  // Boot sequence — load Leaflet then init map
  // ------------------------------------------------------------------

  async _boot() {
    if (this._bootPromise) return this._bootPromise;
    if (!this.isConnected) return null;

    this._bootPromise = this._doBoot();
    try {
      return await this._bootPromise;
    } finally {
      this._bootPromise = null;
    }
  }

  async _doBoot() {
    try {
      await loadLeaflet();
      await this._injectLeafletCssToShadow();
      this._initMap();
      if (!this._map) {
        throw new Error("Map container was not available");
      }
      this._mapReady = true;
      this._hideError();
      this._watchMapSize();
      if (this._isValidCoordinate(this._receiverLat, this._receiverLon)) {
        this._map.setView(
          [this._receiverLat, this._receiverLon],
          this._config.default_zoom || 8
        );
        this._placeReceiverMarker();
        this._addRangeRings();
      } else {
        this._setHomeDefaultView();
      }
      if (this._config.url) {
        this._startPolling();
      } else if (this._lastAircraft.length > 0) {
        this._updatePlanes(this._lastAircraft);
      }
      this._recoverMap();
    } catch (err) {
      console.error("PlaneSight map: failed to load Leaflet", err);
      this._showError("Could not load map library. Check internet connectivity.");
    }
  }

  /** Fetch Leaflet CSS text and inject it into the shadow root so that
   *  tile images, controls, and popup styling all work correctly. */
  async _injectLeafletCssToShadow() {
    if (this._leafletCssInjected) return;
    this._leafletCssInjected = true;
    try {
      const resp = await fetch(LEAFLET_CSS);
      const css  = await resp.text();
      const style = document.createElement("style");
      style.id = "leaflet-shadow";
      style.textContent = css;
      this.shadowRoot.insertBefore(style, this.shadowRoot.firstChild);
    } catch (e) {
      // Non-fatal — map may still render without perfectly styled controls
      console.warn("PlaneSight map: could not inject Leaflet CSS into shadow root", e);
    }
  }

  _initMap() {
    const container = this.shadowRoot.getElementById("ps-map");
    if (!container || !window.L) return;
    if (this._map) {
      this._recoverMap();
      return;
    }

    const showControls = this._config.show_controls === true;
    const dark         = this._config.dark_tiles !== false; // default dark

    this._map = window.L.map(container, {
      zoomControl:        showControls,
      attributionControl: false,
      preferCanvas:       true,
    });

    // ── Tile layer ────────────────────────────────────────────────────
    const tileUrl = dark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

    window.L.tileLayer(tileUrl, {
      maxZoom:     19,
      crossOrigin: true,
    }).addTo(this._map);

    // Default view — will be re-centred to HA home, then receiver when known.
    this._map.setView([0, 0], 5);
    this._setHomeDefaultView();

    // ── Aircraft photo: fetch from planespotters.net on popup open ────────
    this._map.on("popupopen", (e) => {
      this._resolvePopupPhoto(e.popup);
    });
  }

  _resolvePopupPhoto(popup, attempt = 0) {
    // Use rAF so Leaflet has finished injecting the popup content into DOM.
    requestAnimationFrame(() => {
      const container = popup?.getElement?.();
      const photoDiv  = container?.querySelector(".pop-photo[data-hex]");
      if (!photoDiv) {
        if (attempt < 12) {
          setTimeout(() => this._resolvePopupPhoto(popup, attempt + 1), 50);
        }
        return;
      }
      if (
        photoDiv.dataset.photoState === "loading" ||
        photoDiv.dataset.photoState === "loaded" ||
        photoDiv.dataset.photoState === "none"
      ) return;

      // Strip tar1090 synthetic-address prefix (~) and normalise to uppercase.
      const rawHex = photoDiv.dataset.hex || "";
      const hex    = rawHex.replace(/^~/, "").toUpperCase();

      // Must look like a real ICAO address (6 hex digits).
      if (!/^[0-9A-F]{6}$/.test(hex)) {
        this._showNoPhoto(photoDiv, popup);
        this._updatePopupLayout(popup);
        return;
      }

      photoDiv.dataset.photoState = "loading";
      this._loadPhoto(hex).then((result) => {
        this._applyPhoto(photoDiv, result, popup, hex);
      });
    });
  }

  _loadPhoto(hex) {
    if (this._photoCache.has(hex)) {
      return Promise.resolve(this._photoCache.get(hex));
    }
    if (this._photoPromises.has(hex)) {
      return this._photoPromises.get(hex);
    }

    const controller = typeof AbortController !== "undefined"
      ? new AbortController()
      : null;

    const fetchPromise = fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
        signal: controller ? controller.signal : undefined,
      })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const photo = data?.photos?.[0] ?? null;
        return photo
          ? {
              src:    photo.thumbnail_large?.src || photo.thumbnail?.src,
              link:   photo.link || "#",
              credit: photo.photographer || "planespotters.net",
            }
          : null;
      });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        if (controller) controller.abort();
        resolve(null);
      }, 8000);
    });

    const promise = Promise.race([fetchPromise, timeoutPromise])
      .catch(() => null)
      .then((result) => {
        this._photoCache.set(hex, result);
        this._photoPromises.delete(hex);
        return result;
      });

    this._photoPromises.set(hex, promise);
    return promise;
  }

  _applyPhoto(photoDiv, result, popup, expectedHex = null) {
    if (!photoDiv) return;
    if (expectedHex) {
      const currentHex = (photoDiv.dataset.hex || "").replace(/^~/, "").toUpperCase();
      if (currentHex !== expectedHex) return;
    }
    if (!result || !result.src) {
      this._showNoPhoto(photoDiv, popup);
      return;
    }
    if (photoDiv.dataset.photoSrc === result.src) {
      this._updatePopupLayout(popup);
      return;
    }
    photoDiv.dataset.photoState = "loaded";
    photoDiv.dataset.photoSrc = result.src;
    photoDiv.classList.remove("is-loading");
    photoDiv.classList.add("has-photo");
    photoDiv.innerHTML = `
      <a href="${result.link}" target="_blank" rel="noopener noreferrer">
        <img class="pop-photo-img" src="${result.src}" alt="Aircraft photo"
             decoding="async">
      </a>
      <div class="pop-photo-credit">${result.credit} / planespotters.net</div>`;

    if (popup) {
      const img = photoDiv.querySelector("img");
      if (img) {
        img.addEventListener("load",  () => this._updatePopupLayout(popup), { once: true });
        img.addEventListener("error", () => {
          photoDiv.remove();
          this._updatePopupLayout(popup);
        }, { once: true });
      }
      this._updatePopupLayout(popup);
    }
  }

  _showNoPhoto(photoDiv, popup) {
    if (!photoDiv) return;
    photoDiv.dataset.photoState = "none";
    photoDiv.classList.remove("is-loading", "has-photo");
    photoDiv.classList.add("no-photo");
    photoDiv.innerHTML = `<div class="pop-photo-loading">No photo</div>`;
    this._updatePopupLayout(popup);
  }

  _updatePopupLayout(popup) {
    if (!popup || !this._map) return;
    requestAnimationFrame(() => {
      if (!this._map || !popup.isOpen?.()) return;
      popup.update();
      requestAnimationFrame(() => this._panPopupIntoView(popup));
    });
  }

  _panPopupIntoView(popup) {
    if (!this._map || !popup?.getElement) return;
    const popupEl = popup.getElement();
    const mapEl = this._map.getContainer();
    if (!popupEl || !mapEl) return;

    const popupRect = popupEl.getBoundingClientRect();
    const mapRect = mapEl.getBoundingClientRect();
    const padding = 12;
    let dx = 0;
    let dy = 0;

    if (popupRect.top < mapRect.top + padding) {
      dy = popupRect.top - mapRect.top - padding;
    } else if (popupRect.bottom > mapRect.bottom - padding) {
      dy = popupRect.bottom - mapRect.bottom + padding;
    }

    if (popupRect.left < mapRect.left + padding) {
      dx = popupRect.left - mapRect.left - padding;
    } else if (popupRect.right > mapRect.right - padding) {
      dx = popupRect.right - mapRect.right + padding;
    }

    if (dx || dy) {
      this._map.panBy([dx, dy], { animate: false });
    }
  }

  _watchMapSize() {
    const container = this.shadowRoot.getElementById("ps-map");
    if (typeof ResizeObserver === "undefined") return;
    if (!container || this._resizeObserver) return;

    this._resizeObserver = new ResizeObserver(() => this._recoverMap());
    this._resizeObserver.observe(container);
  }

  _recoverMap() {
    if (!this.isConnected) return;
    if (!this._mapReady || !this._map || !window.L) {
      if (this._config.url || this._config.entity) this._boot();
      return;
    }

    requestAnimationFrame(() => {
      if (!this.isConnected || !this._map) return;
      this._map.invalidateSize({ animate: false, pan: false });
      this._placeReceiverMarker();
      this._addRangeRings();
      if (this._lastAircraft.length > 0) {
        this._updatePlanes(this._lastAircraft);
      }
    });
  }

  // ------------------------------------------------------------------
  // Receiver marker + range rings
  // ------------------------------------------------------------------

  _placeReceiverMarker() {
    if (!this._map || this._receiverLat == null) return;

    const icon = window.L.divIcon({
      html: `<div class="recv-dot"></div>`,
      className: "",
      iconSize:   [6, 6],
      iconAnchor: [3, 3],
    });

    if (this._recvMarker) {
      this._recvMarker.setLatLng([this._receiverLat, this._receiverLon]);
    } else {
      this._recvMarker = window.L.marker(
        [this._receiverLat, this._receiverLon],
        { icon, zIndexOffset: 1000 }
      )
        .bindTooltip("Your receiver", { permanent: false, direction: "top" })
        .addTo(this._map);
    }
  }

  _addRangeRings() {
    if (!this._map || this._receiverLat == null) return;
    if (this._config.range_rings === false) return;
    // Rings are drawn once per boot; skip if already on the map.
    // _destroyMap() clears _rangeRings, so after a setConfig they are redrawn.
    if (this._rangeRings.length > 0) return;

    const distances = this._config.range_ring_distances || [50, 100, 150, 200];

    distances.forEach((nm) => {
      const meters = nm * 1852; // nautical miles → metres
      const ring = window.L.circle(
        [this._receiverLat, this._receiverLon],
        {
          radius:    meters,
          color:     "#2a3d55",
          weight:    1,
          dashArray: "4 8",
          fill:      false,
          opacity:   0.55,
          interactive: false,
        }
      ).addTo(this._map);

      // Simple label using a div-icon tooltip near the ring top
      const labelLat = this._receiverLat + (nm / 60); // rough degree offset
      const label = window.L.marker([labelLat, this._receiverLon], {
        icon: window.L.divIcon({
          html: `<span class="ring-label">${Math.round(nm * NM_TO_KM)}km</span>`,
          className: "",
          iconSize: [40, 16],
          iconAnchor: [20, 8],
        }),
        interactive: false,
        zIndexOffset: -100,
      }).addTo(this._map);

      this._rangeRings.push(ring);
      this._rangeRings.push(label);
    });
  }

  _setHomeReceiverFallback() {
    if (this._receiverLat != null && this._receiverLon != null) return;
    const home = this._homeLocation();
    if (home) {
      this._receiverLat = home.lat;
      this._receiverLon = home.lon;
      this._receiverIsHomeFallback = true;
      this._placeReceiverMarker();
      this._addRangeRings();
    }
  }

  _enrichAircraft(ac) {
    const copy = { ...ac };
    if (copy.flight) copy.flight = copy.flight.trim();

    if (this._isValidCoordinate(Number(copy.lat), Number(copy.lon))) {
      copy.lat = Number(copy.lat);
      copy.lon = Number(copy.lon);
    }

    if (
      this._isValidCoordinate(this._receiverLat, this._receiverLon) &&
      this._isValidCoordinate(copy.lat, copy.lon)
    ) {
      copy.distance_nm =
        Math.round(
          haversineNm(
            Number(this._receiverLat),
            Number(this._receiverLon),
            copy.lat,
            copy.lon
          ) * 10
        ) / 10;
    } else {
      const distance = existingDistanceNm(copy);
      if (distance != null) copy.distance_nm = distance;
    }

    return copy;
  }

  // ------------------------------------------------------------------
  // Polling (URL mode)
  // ------------------------------------------------------------------

  _startPolling() {
    if (this._pollTimer) return;
    const intervalMs = (this._config.poll_interval || 5) * 1000;
    const poll = () => this._fetchAndUpdate();
    poll();
    this._pollTimer = setInterval(poll, intervalMs);
  }

  async _fetchAndUpdate() {
    const base = this._config.url.replace(/\/$/, "");
    try {
      // Fetch receiver position once
      if (!this._recvFetched) {
        this._recvFetched = true;
        try {
          const r = await fetch(`${base}/data/receiver.json`);
          if (r.ok) {
            const recv = await r.json();
            const rLat = Number(recv.lat);
            const rLon = Number(recv.lon);
            if (this._isValidCoordinate(rLat, rLon)) {
              this._receiverLat = rLat;
              this._receiverLon = rLon;
              this._receiverIsHomeFallback = false;
              this._map.setView([rLat, rLon], this._config.default_zoom || 8);
              this._placeReceiverMarker();
              this._addRangeRings();
            }
          }
        } catch (_) { /* best-effort */ }
        this._setHomeReceiverFallback();
      }

      const resp = await fetch(`${base}/data/aircraft.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const raw  = data.aircraft || [];

      // Filter: match tar1090's map behavior by using position age when available.
      const visible = raw
        .filter((a) => (
          this._isValidCoordinate(Number(a.lat), Number(a.lon)) &&
          positionAgeSeconds(a) <= 60
        ))
        .map((a) => this._enrichAircraft(a));

      this._hideError();
      this._updatePlanes(visible);
    } catch (err) {
      console.warn("PlaneSight map: fetch error", err);
      this._showError("Could not refresh aircraft data.");
    }
  }

  // ------------------------------------------------------------------
  // Update plane markers
  // ------------------------------------------------------------------

  _updatePlanes(aircraft) {
    if (!this._map || !window.L) return;
    this._lastAircraft = aircraft;

    const activeHexes = new Set(aircraft.map((a, idx) => aircraftKey(a, idx)));

    // Remove stale markers
    for (const [hex, marker] of this._markers) {
      if (!activeHexes.has(hex)) {
        this._map.removeLayer(marker);
        this._markers.delete(hex);
      }
    }

    // Add / update markers
    aircraft.forEach((ac, idx) => {
      const key   = aircraftKey(ac, idx);
      const pos   = [ac.lat, ac.lon];
      const color = altColor(ac.alt_baro);
      const size  = 22;

      const icon = window.L.divIcon({
        html:       planeSvg(color, ac.track, size),
        className:  "plane-marker",
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      if (this._markers.has(key)) {
        const marker = this._markers.get(key);
        marker.setLatLng(pos);
        marker.setIcon(icon);
        if (marker.getPopup()) {
          if (marker.isPopupOpen()) {
            this._updateOpenPopup(marker.getPopup(), ac);
          } else {
            marker.getPopup().setContent(this._popupHtml(ac));
          }
        }
      } else {
        const marker = window.L.marker(pos, { icon })
          .bindPopup(this._popupHtml(ac), {
            maxWidth: 260,
            className: "ps-popup",
            keepInView: true,
            autoPanPaddingTopLeft: [12, 72],
            autoPanPaddingBottomRight: [12, 12],
          })
          .on("click", () => setTimeout(() => this._resolvePopupPhoto(marker.getPopup()), 0))
          .on("popupopen", (e) => this._resolvePopupPhoto(e.popup || marker.getPopup()))
          .addTo(this._map);
        this._markers.set(key, marker);
      }
    });

    // Optional: auto-fit map bounds to show all planes + receiver
    if (this._config.auto_fit && aircraft.length > 0) {
      const bounds = aircraft.map((a) => [a.lat, a.lon]);
      if (this._receiverLat != null) {
        bounds.push([this._receiverLat, this._receiverLon]);
      }
      this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
    }
  }

  _popupValues(ac) {
    const flight = ac.flight || ac.hex || "unknown";
    const type   = ac.t || "--";
    // Use baro altitude, fall back to geometric
    const altSrc = (ac.alt_baro !== undefined && ac.alt_baro !== null) ? ac.alt_baro : ac.alt_geom;
    const alt    = formatPopupAlt(altSrc);
    const speed  = formatPopupSpeed(ac.gs);
    const dist   = ac.distance_nm != null
      ? `${(ac.distance_nm * NM_TO_KM).toFixed(1)} km`
      : "--";
    const hdg    = ac.track != null ? `${Math.round(ac.track)}°` : "--";
    // baro_rate is in ft/min → convert to m/min
    const vs     = ac.baro_rate != null
      ? (() => {
          const mpm = Math.round(ac.baro_rate * FEET_TO_METRES);
          if (ac.baro_rate > 200)  return `↑ ${mpm} m/min`;
          if (ac.baro_rate < -200) return `↓ ${Math.abs(mpm)} m/min`;
          return "level";
        })()
      : "--";

    return { flight, type, alt, speed, dist, hdg, vs };
  }

  _updateOpenPopup(popup, ac) {
    const el = popup?.getElement?.();
    if (!el) return;
    const values = this._popupValues(ac);
    for (const [key, value] of Object.entries(values)) {
      const target = el.querySelector(`[data-pop-field="${key}"]`);
      if (target && target.textContent !== value) target.textContent = value;
    }
    this._panPopupIntoView(popup);
  }

  _popupHtml(ac) {
    const { flight, type, alt, speed, dist, hdg, vs } = this._popupValues(ac);

    return `
      <div class="ps-pop">
        <div class="pop-photo is-loading" data-hex="${ac.hex || ""}">
          <div class="pop-photo-loading">Loading photo…</div>
        </div>
        <div class="pop-callsign" data-pop-field="flight">${flight}</div>
        <div class="pop-type" data-pop-field="type">${type}</div>
        <table class="pop-table">
          <tr><td>Alt</td>     <td data-pop-field="alt">${alt}</td></tr>
          <tr><td>V/S</td>     <td data-pop-field="vs">${vs}</td></tr>
          <tr><td>Speed</td>   <td data-pop-field="speed">${speed}</td></tr>
          <tr><td>Heading</td> <td data-pop-field="hdg">${hdg}</td></tr>
          <tr><td>Distance</td><td data-pop-field="dist">${dist}</td></tr>
        </table>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Render skeleton
  // ------------------------------------------------------------------

  _render() {
    const height = this._config.height || 450;
    this.shadowRoot.innerHTML = `
      <style>${this._css(height)}</style>
      <ha-card>
        <div id="ps-map-wrap">
          <div id="ps-map"></div>
          <div id="ps-error" style="display:none"></div>
        </div>
      </ha-card>`;
  }

  _showError(msg) {
    const el = this.shadowRoot.getElementById("ps-error");
    if (el) {
      el.style.display = "flex";
      el.textContent = msg;
    }
  }

  _hideError() {
    const el = this.shadowRoot.getElementById("ps-error");
    if (el) {
      el.style.display = "none";
      el.textContent = "";
    }
  }

  _css(height) {
    return `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');

      :host { display: block; }

      ha-card {
        overflow: hidden;
        padding: 0;
      }

      #ps-map-wrap {
        position: relative;
        width: 100%;
        height: ${height}px;
      }

      #ps-map {
        width: 100%;
        height: 100%;
        background: #0d1520;
      }

      /* ── Error overlay ──────────────────────────────────────────────── */
      #ps-error {
        position: absolute;
        top: 10px;
        right: 10px;
        max-width: min(280px, calc(100% - 20px));
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10,14,22,0.88);
        border: 1px solid rgba(239,68,68,0.45);
        border-radius: 6px;
        color: #fca5a5;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.85em;
        padding: 8px 10px;
        text-align: left;
        z-index: 9999;
        pointer-events: none;
        box-shadow: 0 4px 18px rgba(0,0,0,0.45);
      }

      /* ── Receiver dot (pulsing) ─────────────────────────────────────── */
      .recv-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(134,239,172,0.42);
        border: 1px solid rgba(134,239,172,0.34);
        box-shadow: 0 0 2px rgba(34,197,94,0.25);
        animation: recvPulse 4s ease-in-out infinite;
      }

      @keyframes recvPulse {
        0%,100% { transform: scale(1);    opacity: 0.48; box-shadow: 0 0 2px rgba(34,197,94,0.22); }
        50%      { transform: scale(1.12); opacity: 0.28; box-shadow: 0 0 4px rgba(34,197,94,0.24); }
      }

      /* ── Plane marker wrapper ───────────────────────────────────────── */
      .plane-marker { background: transparent !important; border: none !important; }

      /* ── Range ring labels ──────────────────────────────────────────── */
      .ring-label {
        font-family: 'JetBrains Mono', 'Courier New', monospace;
        font-size: 0.65em;
        color: #3a5070;
        white-space: nowrap;
        background: transparent;
        pointer-events: none;
      }

      /* ── Popup styling ──────────────────────────────────────────────── */
      .leaflet-popup-content-wrapper {
        background: #0d1520 !important;
        border: 1px solid #1e3050 !important;
        border-radius: 6px !important;
        box-shadow: 0 4px 20px rgba(0,0,0,0.8) !important;
        color: #c8d8e8 !important;
      }
      .leaflet-popup-tip { background: #0d1520 !important; }
      .leaflet-popup-close-button { color: #4a6080 !important; }

      .ps-pop {
        font-family: 'JetBrains Mono', 'Courier New', monospace;
        font-size: 12px;
        min-width: 160px;
        color: #c8d8e8;
      }
      .pop-callsign {
        font-size: 15px;
        font-weight: 700;
        color: #ffd060;
        letter-spacing: 0.1em;
        margin-bottom: 2px;
        text-shadow: 0 0 8px rgba(255,208,96,0.4);
      }
      .pop-type {
        font-size: 11px;
        color: #607898;
        margin-bottom: 7px;
        letter-spacing: 0.05em;
      }
      .pop-table { width: 100%; border-collapse: collapse; }
      .pop-table td {
        padding: 2px 4px;
        font-size: 11px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .pop-table tr:last-child td { border-bottom: none; }
      .pop-table td:first-child { color: #4a6080; width: 55px; }
      .pop-table td:last-child  { color: #a0c0e0; font-weight: 600; }

      /* ── Aircraft photo ─────────────────────────────────────────────── */
      .pop-photo {
        position: relative;
        margin-bottom: 8px;
        width: 100%;
        min-height: 18px;
        overflow: hidden;
      }
      .pop-photo.is-loading,
      .pop-photo.has-photo {
        aspect-ratio: 16 / 9;
        background: #09111c;
        border: 1px solid #1e3050;
        border-radius: 4px;
      }
      .pop-photo.is-loading {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .pop-photo-loading {
        color: #3a5070;
        font-size: 10px;
        font-style: italic;
        font-family: 'JetBrains Mono', 'Courier New', monospace;
      }
      .pop-photo-img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 4px;
      }
      .pop-photo-credit {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        font-size: 9px;
        color: #8aa0bd;
        background: linear-gradient(to top, rgba(9,17,28,0.88), rgba(9,17,28,0));
        padding: 12px 5px 3px;
        text-align: right;
        font-family: 'JetBrains Mono', 'Courier New', monospace;
      }
      .pop-photo-credit a {
        color: #3a5070;
        text-decoration: none;
      }
    `;
  }
}

customElements.define("planesight-card-map", PlaneSightMapCard);

// Register for Lovelace card picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "planesight-card-map",
  name: "PlaneSight — Radar Map",
  description:
    "Live ADS-B radar map with OpenStreetMap tiles, plane icons, and range rings.",
  preview: true,
  documentationURL: "https://github.com/planesight/planesight",
});
