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
const PHOTO_CACHE_VERSION = "v3";
const DEFAULT_GENERIC_TYPE_PHOTOS = {
  BE58: {
    reg: "N758CA",
    src: "https://t.plnspttrs.net/36686/1904216_d9a8d43d8b_280.jpg",
    link: "https://www.planespotters.net/photo/1904216/n758ca-fenix-air-charter-beechcraft-58-baron?utm_source=api",
    credit: "Tran Nguyen An Binh",
  },
  B58T: {
    reg: "N58TK",
    src: "https://t.plnspttrs.net/42321/1912250_9855f166c6_280.jpg",
    link: "https://www.planespotters.net/photo/1912250/n58tk-private-beechcraft-58tc-baron?utm_source=api",
    credit: "NS_Aviation",
  },
};

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

function aircraftIconKind(ac) {
  const type     = String(ac?.t || ac?.aircraft_type || ac?.aircraftType || "").trim().toUpperCase();
  const desc     = String(ac?.desc || "").trim().toUpperCase();
  const category = String(ac?.category || "").trim().toUpperCase();

  // ── Priority 1: ICAO type description (from readsb/dump1090 DB) ──────────
  // Format: [class][engine-count][engine-type]
  //   class:       L=Landplane  S=Seaplane  A=Amphibian  H=Helicopter  G=Gyroplane
  //   engine-type: P=Piston     T=Turboprop J=Jet        E=Electric
  // e.g. "L2P" = Cessna 310 (landplane, 2 piston engines)
  //      "L1P" = Cessna 172  (landplane, 1 piston engine)
  //      "H1T" = Robinson R44 (helicopter, 1 turbine)
  //      "L2J" = business jet or airliner
  if (desc.length >= 3) {
    const cls     = desc.charAt(0);
    const engines = desc.charAt(1);
    const engType = desc.charAt(2);

    if (cls === "H" || cls === "G") return "helicopter";

    if (engType === "P" || engType === "T") {
      return engines === "1" ? "single-prop" : "twin-prop";
    }
    if (engType === "J" || engType === "E") {
      return "jet";
    }
  }
  // Single-char desc "H" also means helicopter
  if (desc === "H" || desc === "G") return "helicopter";

  // ── Priority 2: Exact type-code lookup ───────────────────────────────────
  if (type) {
    // Helicopters
    if (/^(R22|R44|R66|S76|S92|S61|H60|NH90|H64|H47|H46|AS3[2B]|PUMA|TIGR|MI24|A139|A169|A149|A189|EC25|EC55|EC75|EH10|H160|H53|H53S|GAZL|AS50|AS55|ALO[23]|AS65|BK11[57]|BO10[45]|GYRO)/.test(type))
      return "helicopter";

    // Twin-prop
    if (/^(C310|C31T|C320|C335|C336|C337|C340|C401|C402|C404|C411|C414|C421|C425|C441|BE55|BE56|BE58|BE60|B58T|BE76|P68|PA23|PA27|PA30|PA31|PA34|PA39|PA44|DA42|DA62|BN2|DHC6|AC50|AEST)/.test(type))
      return "twin-prop";

    // Business / small jets
    if (/^(C25[ABC]|C501|C510|C525|C550|C560|C56X|C650|C680|C68A|C750|LJ[2-9]\d|LR[34]\d|H25[ABC]|ASTR|G150|GLF[2-6]|GL[5-7]T|GLEX|GA[5-8]C|FA[12567]0|FA[678]X|F2TH|F900|CRJ[129]|CRJX|SF50|PRM1|E[34]5[LP]|E50P|EA50|PC24|BE40)/.test(type))
      return "jet";

    // Single-prop
    if (/^(C1[5-9]\d|C2[0-9]\d|PA1[6-9]|PA20|PA22|PA24|PA25|PA28|PA32|PA46|BE23|BE35|BE36|SR2[02]|S22T|DA20|DA40|DV20|DR[34]\d|PC12|PC6|TBM[789]|TBM9|M20|M7[ABCPRT]|RV[0-9]|VEZE|VELO|PA24)/.test(type))
      return "single-prop";
  }

  // ── Priority 3: ADS-B emitter category (broadcast by aircraft) ───────────
  // Mirrors tar1090 CategoryIcons
  if (category === "A7") return "helicopter";
  if (category === "A6") return "jet";          // high-performance
  if (category === "A1") return "single-prop";  // light < 7t
  if (category === "B1") return "single-prop";  // glider
  if (category === "B4") return "single-prop";  // ultralight
  if (category === "B6") return "jet";          // UAV

  return "airliner";
}

// ---------------------------------------------------------------------------
// Aircraft icon paths — sourced from tar1090/wiedehopf (GPL-2.0)
// Each entry returns { viewBox, path } so the SVG can scale correctly.
// All icons are oriented nose-up (north = 0 °) to match heading rotation.
// ---------------------------------------------------------------------------

function aircraftIconPath(kind, color) {
  switch (kind) {
    case "single-prop":
      // tar1090 "cessna" — single-engine light aircraft
      return {
        viewBox: "0 -1 32 31",
        path: `<path fill="${color}" d="M16.36 20.96l2.57.27s.44.05.4.54l-.02.63s-.03.47-.45.54l-2.31.34-.44-.74-.22 1.63-.25-1.62-.38.73-2.35-.35s-.44-.1-.43-.6l-.02-.6s0-.5.48-.5l2.5-.27-.56-5.4-3.64-.1-5.83-1.02h-.45v-2.06s-.07-.37.46-.34l5.8-.17 3.55.12s-.1-2.52.52-2.82l-1.68-.04s-.1-.06 0-.14l1.94-.03s.35-1.18.7 0l1.91.04s.11.05 0 .14l-1.7.02s.62-.09.56 2.82l3.54-.1 5.81.17s.51-.04.48.35l-.01 2.06h-.47l-5.8 1-3.67.11z"/>`,
      };
    case "twin-prop":
      // tar1090 "twin_small" — twin-engine piston/turboprop
      return {
        viewBox: "-3 -4 25 22",
        path: `<path fill="${color}" d="M9.5,15.75c-.21,0-.34-.17-.41-.51l-2.88.23v-.27c0-.78,0-1.11.28-1.13L9,13.1c-.31-1.86-.55-5-.59-5.55l-.08-.09H6.08L.25,6.54v-1A.43.43,0,0,1,.67,5l3.75-.27L5,4.45V3.53H4.73V2.7a.35.35,0,0,1,.34-.35h.07c.12-.52.26-.83.54-.83s.42.31.53.83h.07a.35.35,0,0,1,.34.35v.83H6.36v1l2-.08C8.42.81,9.09.25,9.49.25s1.09.55,1.12,4.21l2,.08v-1h-.25V2.7a.35.35,0,0,1,.34-.35h.07c.12-.52.26-.83.53-.83s.42.31.54.83h.07a.35.35,0,0,1,.34.35v.83H14v.92l.57.32L18.32,5a.42.42,0,0,1,.43.46v1L13,7.46H10.71l-.08.09c0,.56-.27,3.68-.59,5.55l2.46,1c.28,0,.28.35.28,1.13v.27l-2.88-.23C9.84,15.58,9.71,15.75,9.5,15.75Z"/>`,
      };
    case "helicopter":
      // tar1090 "helicopter" — 4-blade rotor, fuselage and tail boom
      return {
        viewBox: "-13 -13 90 90",
        path: `<path fill="${color}" d="m 24.698,60.712 c 0,0 -0.450,2.134 -0.861,2.142 -0.561,0.011 -0.480,-3.836 -0.593,-5.761 -0.064,-1.098 1.381,-1.192 1.481,-0.042 l 5.464,0.007 -0.068,-9.482 -0.104,-1.108 c -2.410,-2.131 -3.028,-3.449 -3.152,-7.083 l -12.460,13.179 c -0.773,0.813 -2.977,0.599 -3.483,-0.428 L 26.920,35.416 26.866,29.159 11.471,14.513 c -0.813,-0.773 -0.599,-2.977 0.428,-3.483 l 14.971,14.428 0.150,-5.614 c -0.042,-1.324 1.075,-4.784 3.391,-5.633 0.686,-0.251 2.131,-0.293 3.033,0.008 2.349,0.783 3.433,4.309 3.391,5.633 l 0.073,4.400 12.573,-12.763 c 0.779,-0.807 2.977,-0.599 3.483,0.428 L 37.054,28.325 37.027,35.027 52.411,49.365 c 0.813,0.773 0.599,2.977 -0.428,3.483 L 36.992,38.359 c -0.124,3.634 -0.742,5.987 -3.152,8.118 l -0.104,1.108 -0.068,9.482 5.321,-0.068 c 0.101,-1.150 1.546,-1.057 1.481,0.042 -0.113,1.925 -0.032,5.772 -0.593,5.761 -0.412,-0.008 -0.861,-2.142 -0.861,-2.142 l -5.387,-0.011 0.085,9.377 -1.094,2.059 -1.386,-0.018 -1.093,-2.049 0.085,-9.377 z"/>`,
      };
    case "jet":
      // tar1090 "jet_swept" — swept-wing business / small jet
      return {
        viewBox: "-1 -1 20 26",
        path: `<path fill="${color}" d="M9.44,23c-.1.6-.35.6-.44.6s-.34,0-.44-.6l-3,.67V22.6A.54.54,0,0,1,6,22.05l2.38-1.12L8,19.33H6.69l0-.2a8.23,8.23,0,0,1-.14-3.85l.06-.18H7.73V13.19h-2L.26,14.29v-.93c0-.28.07-.46.22-.53l7.25-3.6V3.85A4.47,4.47,0,0,1,8.83.49L9,.34l.17.15a4.47,4.47,0,0,1,1.1,3.36V9.23l7.25,3.6c.14.07.22.25.22.53v.93l-5.51-1.1h-2V15.1h1.17l.06.18a8.24,8.24,0,0,1-.15,3.84l0,.2H10l-.36,1.6,2.43,1.14a.52.52,0,0,1,.35.53v1.08z"/>`,
      };
    default:
      // tar1090 "airliner" — twin-engine narrow/wide body airliner
      return {
        viewBox: "-1 -2 34 34",
        path: `<path fill="${color}" d="M16 1c-.17 0-.67.58-.9 1.03-.6 1.21-.6 1.15-.65 5.2-.04 2.97-.08 3.77-.18 3.9-.15.17-1.82 1.1-1.98 1.1-.08 0-.1-.25-.05-.83.03-.5.01-.92-.05-1.08-.1-.25-.13-.26-.71-.26-.82 0-.86.07-.78 1.5.03.6.08 1.17.11 1.25.05.12-.02.2-.25.33l-8 4.2c-.2.2-.18.1-.19 1.29 3.9-1.2 3.71-1.21 3.93-1.21.06 0 .1 0 .13.14.08.3.28.3.28-.04 0-.25.03-.27 1.16-.6.65-.2 1.22-.35 1.28-.35.05 0 .12.04.15.17.07.3.27.27.27-.08 0-.25.01-.27.7-.47.68-.1.98-.09 1.47-.1.18 0 .22 0 .26.18.06.34.22.35.27-.01.04-.2.1-.17 1.06-.14l1.07.02.05 4.2c.05 3.84.07 4.28.26 5.09.11.49.2.99.2 1.11 0 .19-.31.43-1.93 1.5l-1.93 1.26v1.02l4.13-.95.63 1.54c.05.07.12.09.19.09s.14-.02.19-.09l.63-1.54 4.13.95V29.3l-1.93-1.27c-1.62-1.06-1.93-1.3-1.93-1.49 0-.12.09-.62.2-1.11.19-.81.2-1.25.26-5.09l.05-4.2 1.07-.02c.96-.03 1.02-.05 1.06.14.05.36.21.35.27 0 .04-.17.08-.16.26-.16.49 0 .8-.02 1.48.1.68.2.69.21.69.46 0 .35.2.38.27.08.03-.13.1-.17.15-.17.06 0 .63.15 1.28.34 1.13.34 1.16.36 1.16.61 0 .35.2.34.28.04.03-.13.07-.14.13-.14.22 0 .03 0 3.93 1.2-.01-1.18.02-1.07-.19-1.27l-8-4.21c-.23-.12-.3-.21-.25-.33.03-.08.08-.65.11-1.25.08-1.43.04-1.5-.78-1.5-.58 0-.61.01-.71.26-.06.16-.08.58-.05 1.08.04.58.03.83-.05.83-.16 0-1.83-.93-1.98-1.1-.1-.13-.14-.93-.18-3.9-.05-4.05-.05-3.99-.65-5.2C16.67 1.58 16.17 1 16 1z"/>`,
      };
  }
}

/** Top-down aircraft SVG icon (nose pointing up / north at 0°). */
function planeSvg(color, heading, size = 22, ac = null) {
  // We rotate the wrapping div rather than the SVG path so the hit-box stays square.
  const kind = aircraftIconKind(ac);
  const { viewBox, path } = aircraftIconPath(kind, color);
  return `
    <div style="
      width:${size}px;height:${size}px;
      transform:rotate(${heading ?? 0}deg);
      filter:drop-shadow(0 0 3px rgba(0,0,0,0.9)) drop-shadow(0 1px 2px rgba(0,0,0,0.7));
    ">
      <svg viewBox="${viewBox}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        ${path}
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
    this._photoCache   = new Map();   // lookup key → photo URL or null
    this._photoPromises = new Map();   // lookup key → in-flight planespotters lookup
    this._activePopup   = null;
    this._popupCloseResetTimer = null;
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
    if (this._popupCloseResetTimer) {
      clearTimeout(this._popupCloseResetTimer);
      this._popupCloseResetTimer = null;
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
    this._activePopup = null;
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
      this._activePopup = e.popup;
      if (this._popupCloseResetTimer) {
        clearTimeout(this._popupCloseResetTimer);
        this._popupCloseResetTimer = null;
      }
      this._resolvePopupPhoto(e.popup);
    });
    this._map.on("popupclose", (e) => {
      if (this._activePopup === e.popup) this._activePopup = null;
      this._schedulePopupCloseRecenter();
    });
  }

  _schedulePopupCloseRecenter() {
    if (this._popupCloseResetTimer) {
      clearTimeout(this._popupCloseResetTimer);
    }
    this._popupCloseResetTimer = setTimeout(() => {
      this._popupCloseResetTimer = null;
      if (!this._activePopup) this._recenterHomeView();
    }, 150);
  }

  _recenterHomeView() {
    if (!this._map) return;
    const home = this._homeLocation();
    const center = home || (
      this._isValidCoordinate(this._receiverLat, this._receiverLon)
        ? { lat: this._receiverLat, lon: this._receiverLon }
        : null
    );
    if (!center) return;
    this._map.setView([center.lat, center.lon], this._config.default_zoom || 8, {
      animate: true,
    });
  }

  _resolvePopupPhoto(popup, attempt = 0) {
    // Use rAF so Leaflet has finished injecting the popup content into DOM.
    requestAnimationFrame(() => {
      const container = popup?.getElement?.();
      const photoDiv  = container?.querySelector(".pop-photo[data-photo-key]");
      if (!photoDiv) {
        if (attempt < 12) {
          setTimeout(() => this._resolvePopupPhoto(popup, attempt + 1), 50);
        }
        return;
      }
    if (photoDiv.dataset.photoSrc && photoDiv.dataset.photoGeneric !== "true") return;

      const identity = this._photoIdentityFromDataset(photoDiv.dataset);
      if (!identity) {
        photoDiv.remove();
        this._updatePopupLayout(popup);
        return;
      }

      this._loadPhoto(identity).then((result) => {
        this._applyPhotoToPopup(popup, identity.key, result);
      });
    });
  }

  _loadMarkerPhoto(marker, ac) {
    const identity = this._photoIdentity(ac);
    if (!identity) return;
    this._loadPhoto(identity).then((result) => {
      this._applyPhotoToPopup(marker.getPopup(), identity.key, result);
    });
  }

  _photoIdentity(ac) {
    const rawHex = ac?.hex || "";
    const hex = rawHex.replace(/^~/, "").toUpperCase();
    const reg = String(ac?.r || ac?.registration || "").trim().toUpperCase();
    const type = String(ac?.t || ac?.aircraft_type || ac?.aircraftType || "").trim().toUpperCase();
    const validHex = /^[0-9A-F]{6}$/.test(hex) ? hex : "";
    const cleanReg = /^[A-Z0-9-]+$/.test(reg) ? reg : "";
    const cleanType = /^[A-Z0-9-]+$/.test(type) ? type : "";

    if (!validHex && !cleanReg && !this._genericTypePhoto(cleanType)) return null;
    return {
      key: `${PHOTO_CACHE_VERSION}|${cleanReg || "-"}|${validHex || "-"}|${cleanType || "-"}`,
      hex: validHex,
      reg: cleanReg,
      type: cleanType,
    };
  }

  _photoIdentityFromDataset(dataset) {
    const rawHex = dataset.hex || "";
    const hex = rawHex.replace(/^~/, "").toUpperCase();
    const reg = String(dataset.reg || "").trim().toUpperCase();
    const type = String(dataset.aircraftType || "").trim().toUpperCase();
    const validHex = /^[0-9A-F]{6}$/.test(hex) ? hex : "";
    const cleanReg = /^[A-Z0-9-]+$/.test(reg) ? reg : "";
    const cleanType = /^[A-Z0-9-]+$/.test(type) ? type : "";

    if (!validHex && !cleanReg && !this._genericTypePhoto(cleanType)) return null;
    return {
      key: dataset.photoKey || `${PHOTO_CACHE_VERSION}|${cleanReg || "-"}|${validHex || "-"}|${cleanType || "-"}`,
      hex: validHex,
      reg: cleanReg,
      type: cleanType,
    };
  }

  _photoHtml(ac) {
    const identity = this._photoIdentity(ac);
    if (!identity) return "";

    const result = this._photoCache.has(identity.key)
      ? this._photoCache.get(identity.key)
      : undefined;
    const fallback = this._genericTypePhotoResult(identity);
    const displayResult = result || fallback;
    const attrs = this._photoDataAttrs(identity);

    if (displayResult && displayResult.src) {
      return `
        <div class="pop-photo has-photo" ${attrs} data-photo-src="${this._escapeHtml(displayResult.src)}"${displayResult.genericType ? ' data-photo-generic="true"' : ""}>
          <a class="pop-photo-link" href="${this._escapeHtml(displayResult.link || "#")}" target="_blank" rel="noopener noreferrer">
            <img class="pop-photo-img" src="${this._escapeHtml(displayResult.src)}" alt="Aircraft photo" decoding="async">
          </a>
          <div class="pop-photo-credit">${this._escapeHtml(this._photoCredit(displayResult))}</div>
        </div>`;
    }

    if (result === null) return "";

    return `
        <div class="pop-photo is-loading" ${attrs}>
          <div class="pop-photo-loading">Loading photo…</div>
        </div>`;
  }

  _photoDataAttrs(identity) {
    return [
      `data-photo-key="${this._escapeHtml(identity.key)}"`,
      `data-hex="${this._escapeHtml(identity.hex || "")}"`,
      `data-reg="${this._escapeHtml(identity.reg || "")}"`,
      `data-aircraft-type="${this._escapeHtml(identity.type || "")}"`,
    ].join(" ");
  }

  _escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  _applyPhotoToPopup(popup, photoKey, result, attempt = 0) {
    const container = popup?.getElement?.();
    const photoDiv = container?.querySelector(".pop-photo[data-photo-key]");
    if (!photoDiv) {
      if (attempt < 12) {
        setTimeout(() => this._applyPhotoToPopup(popup, photoKey, result, attempt + 1), 50);
      }
      return;
    }
    this._applyPhoto(photoDiv, result, popup, photoKey);
  }

  _loadPhoto(identity) {
    if (this._photoCache.has(identity.key)) {
      return Promise.resolve(this._photoCache.get(identity.key));
    }
    if (this._photoPromises.has(identity.key)) {
      return this._photoPromises.get(identity.key);
    }

    const controller = typeof AbortController !== "undefined"
      ? new AbortController()
      : null;

    const fetchPromise = this._fetchBestPhoto(identity, controller);

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        if (controller) controller.abort();
        resolve(this._genericTypePhotoResult(identity));
      }, 8000);
    });

    const promise = Promise.race([fetchPromise, timeoutPromise])
      .catch(() => null)
      .then((result) => {
        this._photoCache.set(identity.key, result);
        this._photoPromises.delete(identity.key);
        return result;
      });

    this._photoPromises.set(identity.key, promise);
    return promise;
  }

  async _fetchBestPhoto(identity, controller) {
    const urls = [];
    if (identity.reg) {
      urls.push({
        url: `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(identity.reg)}`,
      });
    }
    if (identity.hex) {
      const params = new URLSearchParams();
      if (identity.reg) params.set("reg", identity.reg);
      if (identity.type) params.set("icaoType", identity.type);
      const query = params.toString();
      urls.push({
        url: `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(identity.hex)}${query ? `?${query}` : ""}`,
      });
    }
    const genericPhoto = this._genericTypePhoto(identity.type);
    if (genericPhoto?.reg && genericPhoto.reg !== identity.reg) {
      urls.push({
        url: `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(genericPhoto.reg)}`,
        genericType: identity.type,
      });
    }

    for (const request of urls) {
      const result = await this._fetchPhotoUrl(request.url, controller);
      if (result && request.genericType) result.genericType = request.genericType;
      if (result) return result;
    }
    return genericPhoto
      ? {
          src: genericPhoto.src,
          link: genericPhoto.link,
          credit: genericPhoto.credit,
          genericType: identity.type,
        }
      : null;
  }

  _fetchPhotoUrl(url, controller) {
    return fetch(url, {
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
  }

  _genericTypePhotoResult(identity) {
    const genericPhoto = this._genericTypePhoto(identity?.type);
    return genericPhoto?.src
      ? {
          src: genericPhoto.src,
          link: genericPhoto.link,
          credit: genericPhoto.credit,
          genericType: identity.type,
        }
      : null;
  }

  _genericTypePhoto(type) {
    const cleanType = String(type || "").trim().toUpperCase();
    if (!cleanType) return null;

    const configured = this._config?.generic_type_photos?.[cleanType];
    const fallback = configured ?? DEFAULT_GENERIC_TYPE_PHOTOS[cleanType];
    if (!fallback) return null;

    if (typeof fallback === "string") {
      const reg = fallback.trim().toUpperCase();
      return reg ? { reg } : null;
    }

    if (typeof fallback !== "object") return null;
    const reg = String(fallback.reg || "").trim().toUpperCase();
    const src = String(fallback.src || "").trim();
    const link = String(fallback.link || "").trim();
    const credit = String(fallback.credit || "").trim();

    if (!reg && !src) return null;
    return { reg, src, link, credit };
  }

  _photoCredit(result) {
    const credit = result?.credit || "planespotters.net";
    return result?.genericType
      ? `Generic ${result.genericType} photo: ${credit} / planespotters.net`
      : `${credit} / planespotters.net`;
  }

  _applyPhoto(photoDiv, result, popup, expectedPhotoKey = null) {
    if (!photoDiv) return;
    if (expectedPhotoKey) {
      const currentPhotoKey = photoDiv.dataset.photoKey || "";
      if (currentPhotoKey !== expectedPhotoKey) return;
    }
    if (!result || !result.src) {
      photoDiv.remove();
      this._updatePopupLayout(popup);
      return;
    }
    if (photoDiv.dataset.photoSrc === result.src) {
      this._updatePopupLayout(popup);
      return;
    }
    const img = new Image();
    img.className = "pop-photo-img";
    img.alt = "Aircraft photo";
    img.decoding = "async";

    const showLoadedPhoto = () => {
      const currentPhotoKey = photoDiv.dataset.photoKey || "";
      if (expectedPhotoKey && currentPhotoKey !== expectedPhotoKey) return;

      const frame = document.createElement("div");
      frame.className = "pop-photo has-photo";
      frame.dataset.hex = photoDiv.dataset.hex || "";
      frame.dataset.reg = photoDiv.dataset.reg || "";
      frame.dataset.aircraftType = photoDiv.dataset.aircraftType || "";
      frame.dataset.photoKey = photoDiv.dataset.photoKey || "";
      frame.dataset.photoSrc = result.src;
      if (result.genericType) frame.dataset.photoGeneric = "true";

      const link = document.createElement("a");
      link.className = "pop-photo-link";
      link.href = result.link || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.appendChild(img);

      const credit = document.createElement("div");
      credit.className = "pop-photo-credit";
      credit.textContent = this._photoCredit(result);

      frame.appendChild(link);
      frame.appendChild(credit);
      this._replacePopupPhotoContent(photoDiv, frame, popup);
    };

    img.addEventListener("load", showLoadedPhoto, { once: true });
    img.addEventListener("error", () => {
      photoDiv.remove();
      this._updatePopupLayout(popup);
    }, { once: true });
    img.src = result.src;
    if (img.complete && img.naturalWidth > 0) {
      showLoadedPhoto();
    }
  }

  _replacePopupPhotoContent(photoDiv, replacement, popup) {
    if (!photoDiv || !replacement) return;
    if (!popup) {
      photoDiv.replaceWith(replacement);
      return;
    }

    const root = photoDiv.closest(".ps-pop");
    if (!root) {
      photoDiv.replaceWith(replacement);
      this._panPopupAfterContentChange(popup);
      return;
    }

    const rootClone = root.cloneNode(true);
    const oldPhoto = rootClone.querySelector(".pop-photo[data-photo-key]");
    if (oldPhoto) oldPhoto.replaceWith(replacement.cloneNode(true));
    popup.setContent(rootClone.outerHTML);
    this._panPopupAfterContentChange(popup);
  }

  _panPopupAfterContentChange(popup) {
    if (!popup || !this._map) return;
    requestAnimationFrame(() => {
      if (!this._map || !popup.isOpen?.()) return;
      requestAnimationFrame(() => this._panPopupIntoView(popup));
    });
  }

  _showNoPhoto(photoDiv, popup) {
    if (!photoDiv) return;
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
        html:       planeSvg(color, ac.track, size, ac),
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
          .on("click", () => this._loadMarkerPhoto(marker, ac))
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
    this._resolvePopupPhoto(popup);
    this._panPopupIntoView(popup);
  }

  _popupHtml(ac) {
    const { flight, type, alt, speed, dist, hdg, vs } = this._popupValues(ac);

    return `
      <div class="ps-pop">
        ${this._photoHtml(ac)}
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
      .pop-photo.has-photo {
        display: block;
      }
      .pop-photo.has-photo .pop-photo-loading {
        display: none;
      }
      .pop-photo-loading {
        color: #3a5070;
        font-size: 10px;
        font-style: italic;
        font-family: 'JetBrains Mono', 'Courier New', monospace;
      }
      .pop-photo-link,
      .pop-photo-img {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
      }
      .pop-photo-link { z-index: 1; }
      .pop-photo-img { object-fit: cover; }
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
        z-index: 2;
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
