// IS24 Web URL → canonical Homelander search model → Mobile API translator.
// The mobile API is public; Homelander imports search links conservatively:
// known result-affecting params are parsed, tracking params are ignored safely,
// unknown params are surfaced by validateSearchUrl() instead of silently saved.

const MOBILE_API_BASE = 'https://api.mobile.immobilienscout24.de/search/list';

const REALESTATE_TYPE_MAP = {
  // Base types — Fredy + Homelander combined
  'wohnung-mieten': 'apartmentrent',
  'wohnung-kaufen': 'apartmentbuy',
  'haus-mieten': 'houserent',
  'haus-kaufen': 'housebuy',
  'grundstueck-kaufen': 'plotbuy',
  // Swap / neubau variants (Homelander)
  'wohnung-mieten-tausch': 'apartmentrent',
  'neubauwohnung-mieten': 'apartmentrent',
  'neubauwohnung-kaufen': 'apartmentbuy',
  'neubauhaus-mieten': 'houserent',
  'neubauhaus-kaufen': 'housebuy',
  // Fredy's SEO-inflected buy variants
  'wohnung-kaufen-mit-balkon': 'apartmentbuy',
  'eigentumswohnung-mit-garten': 'apartmentbuy',
  'haus-mit-keller-kaufen': 'housebuy',
  'luxushaus-kaufen': 'housebuy',
  'villa-kaufen': 'housebuy',
};

const NEW_BUILD_TYPES = new Set([
  'neubauwohnung-mieten',
  'neubauwohnung-kaufen',
  'neubauhaus-mieten',
  'neubauhaus-kaufen',
]);

// SEO-inflected web paths that imply equipment/apartment-type filters.
// When a URL ends with one of these slugs, the implied params are injected
// into the canonical model. Adapted from Fredy's WEB_PATH_TO_APARTMENT_EQUIPMENT_MAP.
const SEO_PATH_EQUIPMENT_MAP = {
  // Category "Balkon/Terrasse"
  'wohnung-mit-balkon-mieten': { equipment: ['BALCONY'] },
  'wohnung-mit-garten-mieten': { equipment: ['GARDEN'] },
  // Category "Wohnungstyp"
  'souterrainwohnung-mieten': { apartmentTypes: ['halfbasement'] },
  'erdgeschosswohnung-mieten': { apartmentTypes: ['groundfloor'] },
  'hochparterrewohnung-mieten': { apartmentTypes: ['raisedgroundfloor'] },
  'etagenwohnung-mieten': { apartmentTypes: ['apartment'] },
  'loft-mieten': { apartmentTypes: ['loft'] },
  'maisonette-mieten': { apartmentTypes: ['maisonette'] },
  'terrassenwohnung-mieten': { apartmentTypes: ['terracedflat'] },
  'penthouse-mieten': { apartmentTypes: ['penthouse'] },
  'dachgeschosswohnung-mieten': { apartmentTypes: ['roofstorey'] },
  // Category "Ausstattung"
  'wohnung-mit-garage-mieten': { equipment: ['PARKING_SPACE'] },
  'wohnung-mit-einbaukueche-mieten': { equipment: ['BUILT_IN_KITCHEN'] },
  'wohnung-mit-keller-mieten': { equipment: ['CELLAR'] },
  // Category "Merkmale"
  'barrierefreie-wohnung-mieten': { equipment: ['HANDICAPPED_ACCESSIBLE'] },
};

// Value corrections for IS24 web params that use different value formats
// than the mobile API.
const EXCLUSION_CRITERIA_CORRECTIONS = {
  swapflat: 'swap_flat',
};

// Web uses A%2B/A+/A_PLUS, mobile uses a_plus
const ENERGY_EFFICIENCY_CORRECTIONS = {
  'a_plus': 'a_plus', 'a+': 'a_plus', 'a+b': 'a_plus', 'aplus': 'a_plus',
  'a': 'a', 'b': 'b', 'c': 'c', 'd': 'd', 'e': 'e',
  'f': 'f', 'g': 'g', 'h': 'h',
};

// SEO-optimized warmrent paths: "wohnung-bis-800-euro-warm" → implicit price + pricetype.
// From Fredy's parseSeoMaxWarmrentPath.
const SEO_RENT_TYPE_TO_REAL_ESTATE_TYPE = {
  wohnung: 'apartmentrent',
  haus: 'houserent',
};
const SEO_MAX_WARMRENT_PATH_PATTERN = /^(?<type>wohnung|haus)-bis-(?<price>\d+)-euro-warm$/;

const PRICE_TYPE_MAP = {
  'wohnung-mieten': 'calculatedtotalrent',
  'neubauwohnung-mieten': 'calculatedtotalrent',
  'haus-mieten': 'calculatedtotalrent',
  'neubauhaus-mieten': 'calculatedtotalrent',
  'wohnung-kaufen': 'purchaseprice',
  'neubauwohnung-kaufen': 'purchaseprice',
  'haus-kaufen': 'purchaseprice',
  'neubauhaus-kaufen': 'purchaseprice',
  'grundstueck-kaufen': 'purchaseprice',
};

const PREVIEW_I18N = {
  en: {
    realEstate: {
      apartmentrent: 'Apartment rent',
      apartmentbuy: 'Apartment buy',
      houserent: 'House rent',
      housebuy: 'House buy',
      plotbuy: 'Plot buy',
    },
    heating: {
      CENTRAL_HEATING: 'central heating',
      SELF_CONTAINED_CENTRAL_HEATING: 'self-contained central heating',
      FLOOR_HEATING: 'floor heating',
      GAS_HEATING: 'gas heating',
      OIL_HEATING: 'oil heating',
      DISTRICT_HEATING: 'district heating',
      NIGHT_STORAGE_HEATER: 'night storage heating',
      STOVE_HEATING: 'stove heating',
      WOOD_PELLET_HEATING: 'wood pellet heating',
      HEAT_PUMP: 'heat pump',
      SOLAR_HEATING: 'solar heating',
    },
    equipment: {
      HANDICAPPED_ACCESSIBLE: 'barrier-free',
      BALCONY: 'balcony',
      GARDEN: 'garden',
      BUILT_IN_KITCHEN: 'built-in kitchen',
      LIFT: 'elevator',
      PARKING_SPACE: 'parking',
      GUEST_TOILET: 'guest toilet',
      CELLAR: 'cellar',
      FRIDGE: 'fridge',
      COOKER: 'cooker',
      PETS_ALLOWED: 'pets allowed',
      INTERNET: 'internet',
    },
    labels: {
      allGermany: 'All Germany',
      newBuildPrefix: 'New-build',
      price: 'Price',
      rooms: 'Rooms',
      livingSpace: 'Living space',
      heating: 'Heating',
      equipment: 'Equipment',
      energy: 'Energy',
      pets: 'Pets',
      any: 'any',
      selected: 'selected',
      radiusSuffix: (km) => `${km} km radius`,
      selectedAreas: (n) => (n === 1 ? '1 selected area' : `${n} selected areas`),
      drawnAreas: (n) => (n === 1 ? '1 drawn area' : `${n} drawn areas`),
      mapArea: 'map area',
      unsupportedFilters: 'Unsupported IS24 search filters',
      mobileRejects: (label) => `The IS24 mobile API rejects ${label} filters; Homelander keeps the supported parts of the search.`,
      radiusMissingCoordinates: 'This radius link is missing its map coordinates. Open the search on immobilienscout24.de and copy the URL from the results page again.',
      bboxMissingRegion: 'This map-area link is missing its region. Open the search on immobilienscout24.de and copy the URL from the results page again.',
      shapeMissingOutline: 'This map-drawn link is missing the outline you drew. Open the search on immobilienscout24.de and copy the URL from the results page again.',
    },
  },
  de: {
    realEstate: {
      apartmentrent: 'Wohnung zur Miete',
      apartmentbuy: 'Wohnung zum Kauf',
      houserent: 'Haus zur Miete',
      housebuy: 'Haus zum Kauf',
      plotbuy: 'Grundstück zum Kauf',
    },
    heating: {
      CENTRAL_HEATING: 'Zentralheizung',
      SELF_CONTAINED_CENTRAL_HEATING: 'Etagenheizung',
      FLOOR_HEATING: 'Fußbodenheizung',
      GAS_HEATING: 'Gasheizung',
      OIL_HEATING: 'Ölheizung',
      DISTRICT_HEATING: 'Fernwärme',
      NIGHT_STORAGE_HEATER: 'Nachtspeicherheizung',
      STOVE_HEATING: 'Ofenheizung',
      WOOD_PELLET_HEATING: 'Pelletheizung',
      HEAT_PUMP: 'Wärmepumpe',
      SOLAR_HEATING: 'Solarheizung',
    },
    equipment: {
      HANDICAPPED_ACCESSIBLE: 'barrierefrei',
      BALCONY: 'Balkon',
      GARDEN: 'Garten',
      BUILT_IN_KITCHEN: 'Einbauküche',
      LIFT: 'Aufzug',
      PARKING_SPACE: 'Stellplatz',
      GUEST_TOILET: 'Gäste-WC',
      CELLAR: 'Keller',
      FRIDGE: 'Kühlschrank',
      COOKER: 'Herd',
      PETS_ALLOWED: 'Haustiere erlaubt',
      INTERNET: 'Internet',
    },
    labels: {
      allGermany: 'Deutschlandweit',
      newBuildPrefix: 'Neubau',
      price: 'Preis',
      rooms: 'Zimmer',
      livingSpace: 'Wohnfläche',
      heating: 'Heizung',
      equipment: 'Ausstattung',
      energy: 'Energie',
      pets: 'Haustiere',
      any: 'egal',
      selected: 'ausgewählt',
      radiusSuffix: (km) => `${km} km Umkreis`,
      selectedAreas: (n) => (n === 1 ? '1 ausgewähltes Gebiet' : `${n} ausgewählte Gebiete`),
      drawnAreas: (n) => (n === 1 ? '1 gezeichnetes Gebiet' : `${n} gezeichnete Gebiete`),
      mapArea: 'Kartenausschnitt',
      unsupportedFilters: 'Nicht unterstützte IS24-Suchfilter',
      mobileRejects: (label) => `Die IS24 Mobile API lehnt Filter für ${label} ab; Homelander übernimmt die unterstützten Teile der Suche.`,
      radiusMissingCoordinates: 'Diesem Umkreis-Link fehlen die Kartenkoordinaten. Öffne die Suche auf immobilienscout24.de und kopiere die URL erneut aus der Ergebnisliste.',
      bboxMissingRegion: 'Diesem Kartenausschnitt-Link fehlt die Region. Öffne die Suche auf immobilienscout24.de und kopiere die URL erneut aus der Ergebnisliste.',
      shapeMissingOutline: 'Diesem gezeichneten Link fehlt der Umriss. Öffne die Suche auf immobilienscout24.de und kopiere die URL erneut aus der Ergebnisliste.',
    },
  },
};

function previewLocale(locale = 'en') {
  return PREVIEW_I18N[String(locale).toLowerCase().startsWith('de') ? 'de' : 'en'];
}

const SAFE_IGNORED_PARAM_PATTERNS = [
  /^enteredfrom$/i,
  /^utm_/i,
  /^referrer$/i,
  /^referrerurl$/i,
  /^from$/i,
  /^viewmode$/i,
  /^sorting$/i,
  /^pagenumber$/i,
  /^pagesize$/i,
];

// Direct query passthroughs kept for legacy coverage and known mobile API params.
// Entries removed (2026-06-22) after live mobile API conformance test confirmed 412:
//   has-pictures, ageofconstruction, barrier-free, pets-allowed, energy-efficiency
const DIRECT_PARAM_MAP = {
  'exclusioncriteria': 'exclusioncriteria',
  'energyefficiencyclasses': 'energyefficiencyclasses',
  'energy-efficiency': 'energyefficiencyclasses',  // IS24 web → value-corrected
  'petsallowedtypes': 'petsallowedtypes',
  'pets-allowed': 'petsallowedtypes',        // IS24 web param → value-corrected
  'floor': 'floor',
  'apartmenttypes': 'apartmenttypes',
  'haspromotion': 'haspromotion',
  'constructionyear': 'constructionyear',
  'newbuilding': 'newbuilding',
  'fulltext': 'fulltext',
  'osmtags': 'osmtags',
  'minimuminternetspeed': 'minimuminternetspeed',
  'exclusiveonis24': 'exclusiveonis24',
  'comingsoon': 'comingsoon',
  'paywall': 'paywall',
  'buildingtypes': 'buildingtypes',
  'ground': 'ground',
};

const HEATING_TYPE_MAP = {
  central: 'CENTRAL_HEATING',
  selfcontainedcentral: 'SELF_CONTAINED_CENTRAL_HEATING',
  floorheating: 'FLOOR_HEATING',
  gas: 'GAS_HEATING',
  oil: 'OIL_HEATING',
  district: 'DISTRICT_HEATING',
  nightstorage: 'NIGHT_STORAGE_HEATER',
  stove: 'STOVE_HEATING',
  woodpellet: 'WOOD_PELLET_HEATING',
  heatpump: 'HEAT_PUMP',
  solar: 'SOLAR_HEATING',
};

const HEATING_TYPE_MOBILE_VALUE = Object.fromEntries(
  Object.entries(HEATING_TYPE_MAP).map(([mobile, canonical]) => [canonical, mobile])
);

const HEATING_LABELS = {
  CENTRAL_HEATING: 'central heating',
  SELF_CONTAINED_CENTRAL_HEATING: 'self-contained central heating',
  FLOOR_HEATING: 'floor heating',
  GAS_HEATING: 'gas heating',
  OIL_HEATING: 'oil heating',
  DISTRICT_HEATING: 'district heating',
  NIGHT_STORAGE_HEATER: 'night storage heating',
  STOVE_HEATING: 'stove heating',
  WOOD_PELLET_HEATING: 'wood pellet heating',
  HEAT_PUMP: 'heat pump',
  SOLAR_HEATING: 'solar heating',
};

const EQUIPMENT_MAP = {
  handicappedaccessible: 'HANDICAPPED_ACCESSIBLE',
  barrierfree: 'HANDICAPPED_ACCESSIBLE',
  onlywithbarrierfree: 'HANDICAPPED_ACCESSIBLE',
  'barrier-free': 'HANDICAPPED_ACCESSIBLE',   // IS24 web param → equipment
  balcony: 'BALCONY',
  onlywithbalcony: 'BALCONY',
  garden: 'GARDEN',
  onlywithgarden: 'GARDEN',
  builtinKitchen: 'BUILT_IN_KITCHEN',
  builtinkitchen: 'BUILT_IN_KITCHEN',
  'built-in-kitchen': 'BUILT_IN_KITCHEN',
  kitchen: 'BUILT_IN_KITCHEN',
  onlywithkitchen: 'BUILT_IN_KITCHEN',
  elevator: 'LIFT',
  lift: 'LIFT',
  onlywithelevator: 'LIFT',
  parking: 'PARKING_SPACE',
  onlywithparking: 'PARKING_SPACE',
  guesttoilet: 'GUEST_TOILET',
  'guest-toilet': 'GUEST_TOILET',
  cellar: 'CELLAR',
  fridge: 'FRIDGE',
  cooker: 'COOKER',
  petsallowed: 'PETS_ALLOWED',
  internet: 'INTERNET',
  onlywithguesttoilet: 'GUEST_TOILET',
  onlywithbasement: 'CELLAR',
  onlywithinternet: 'INTERNET',
  onlywithfridge: 'FRIDGE',
  onlywithcooker: 'COOKER',
};

const EQUIPMENT_MOBILE_VALUE = Object.fromEntries(
  Object.entries(EQUIPMENT_MAP).map(([mobile, canonical]) => [canonical, mobile])
);
EQUIPMENT_MOBILE_VALUE.HANDICAPPED_ACCESSIBLE = 'handicappedaccessible';
EQUIPMENT_MOBILE_VALUE.BUILT_IN_KITCHEN = 'builtinKitchen';
EQUIPMENT_MOBILE_VALUE.GUEST_TOILET = 'guesttoilet';
EQUIPMENT_MOBILE_VALUE.PARKING_SPACE = 'parking';
EQUIPMENT_MOBILE_VALUE.LIFT = 'lift';         // mobile API accepts 'lift', not 'elevator'
EQUIPMENT_MOBILE_VALUE.CELLAR = 'cellar';
EQUIPMENT_MOBILE_VALUE.FRIDGE = 'fridge';
EQUIPMENT_MOBILE_VALUE.COOKER = 'cooker';
EQUIPMENT_MOBILE_VALUE.PETS_ALLOWED = 'petsallowed';
EQUIPMENT_MOBILE_VALUE.INTERNET = 'internet';
EQUIPMENT_MOBILE_VALUE.BALCONY = 'balcony';   // prevent onlywithbalcony→BALCONY overwrite
EQUIPMENT_MOBILE_VALUE.GARDEN = 'garden';     // prevent onlywithgarden→GARDEN overwrite

const EQUIPMENT_LABELS = {
  HANDICAPPED_ACCESSIBLE: 'barrier-free',
  BALCONY: 'balcony',
  GARDEN: 'garden',
  BUILT_IN_KITCHEN: 'built-in kitchen',
  LIFT: 'elevator',
  PARKING_SPACE: 'parking',
  GUEST_TOILET: 'guest toilet',
  CELLAR: 'cellar',
  FRIDGE: 'fridge',
  COOKER: 'cooker',
  PETS_ALLOWED: 'pets allowed',
  INTERNET: 'internet',
};

// Mobile API silently ignores these equipment values — accepted but no filtering.
const MOBILE_IGNORED_EQUIPMENT_CANONICAL = new Set([
  'FRIDGE', 'COOKER', 'PETS_ALLOWED', 'INTERNET',
]);

// Mobile API rejects these heating types with 412 — removed from IS24's mobile API.
const MOBILE_UNSUPPORTED_HEATING_CANONICAL = new Set([
  'FLOOR_HEATING', 'GAS_HEATING', 'OIL_HEATING', 'DISTRICT_HEATING',
  'NIGHT_STORAGE_HEATER', 'WOOD_PELLET_HEATING', 'HEAT_PUMP', 'SOLAR_HEATING',
]);

const MOBILE_UNSUPPORTED_WEB_FILTER_LABELS = {
  // Removed DIRECT_PARAM_MAP entries (2026-06-22) — confirmed 412 by live conformance test
  'has-pictures': 'listing pictures filter',
  'ageofconstruction': 'age of construction',
  // Original entries
  gender: 'flatmate gender',
  smokingallowed: 'smoking allowed',
  startrentaldate: 'rental start date',
  furniture: 'furnished',
  rentalduration: 'rental duration',
  wohnberechtigungsscheinneeded: 'WBS required',
  onlyshorttermbuildable: 'short-term buildable',
  onlywithplanningpermission: 'planning permission',
  onlywithoutcourtage: 'commission-free',
  sitedevelopmenttypes: 'site development type',
  siteconstructibletypes: 'site constructible type',
  rentalperiodvalue: 'rental period',
  rentalperiodtype: 'rental period type',
  beginrent: 'move-in date',
  shorttermaccommodationtype: 'accommodation type',
  numberofpersons: 'number of persons',
  withfurniture: 'furnishing',
  smokingpermitted: 'smoking permitted',
  flatsharesize: 'WG size',
  rentdurationinmonths: 'rental duration (months)',
  furnishing: 'furnishing',
  flatmategender: 'flatmate gender',
  garagetypes: 'garage type',
  onlywithcookingpossibility: 'cooking possibility',
  onlywithambulantnursingservice: 'ambulant nursing service',
  assistedlivingcommercializationtype: 'commercialization type',
  onlywithcareofdementiapatients: 'dementia care',
  onlywithcareofartificalrespirationpatients: 'respiration care',
  onlywithcareofvegetativestatepatients: 'vegetative state care',
  caretypes: 'care type',
  seniorcarelevels: 'care level',
  roomtypes: 'room type',
};

const EQUIPMENT_CHECKBOX_PARAMS = new Set([
  'onlywithbalcony', 'onlywithgarden', 'onlywithparking',
  'onlywithkitchen', 'onlywithelevator', 'onlywithguesttoilet',
  'onlywithbasement', 'onlywithbarrierfree',
  'balcony', 'garden', 'parking', 'cellar', 'elevator',
  'onlywithinternet', 'onlywithfridge', 'onlywithcooker',
  'barrier-free',   // IS24 web param → equipment=handicappedaccessible
]);

// IS24 search type slugs that the mobile API has no realestatetype for.
// These categories are desktop-only; searching them via the mobile API would
// return wrong listings (apartments instead of garages/WG/senior living).
const MOBILE_UNSUPPORTED_TYPE_SLUGS = new Set([
  'garage-mieten',
  'garage-kaufen',
  'stellplatz-mieten',
  'stellplatz-kaufen',
  'wg-zimmer',
  'wg-zimmer-mieten',
  'wg-zimmer-angebot',
  'wg-zimmer-gesucht',
  'wohnen-auf-zeit',
  'seniorenwohnen',
  'pflegeheim',
  'sozialwohnung-mieten',
]);

function parseWgSlug(segment) {
  const match = String(segment || '').match(/^(\d+)er-wg$/i);
  if (!match) return null;
  return { size: Number(match[1]), fullText: `${match[1]}er wg`, label: `${match[1]}er WG` };
}

// errorCode names a PREVIEW_I18N label so validateSearchUrl() can render the
// message in the caller's locale; without one the English text is used as-is.
function emptyResult(error, errorCode = null) {
  return {
    canonical: null,
    unsupportedParams: [],
    safeIgnoredParams: [],
    error,
    errorCode,
  };
}

function normalizeUrl(webUrl) {
  const input = String(webUrl || '').trim();
  if (!input) throw new Error('Invalid URL');
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

function parseRange(raw, label) {
  const value = String(raw ?? '').trim();
  const m = value.match(/^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/);
  if (!m) {
    const single = value.match(/^\d+(?:\.\d+)?$/);
    if (single) return { min: Number(value), max: Number(value) };
    throw new Error(`Invalid ${label} range: ${value}`);
  }
  const min = m[1] ? Number(m[1]) : null;
  const max = m[2] ? Number(m[2]) : null;
  if (min === null && max === null) throw new Error(`Invalid ${label} range: ${value}`);
  if (min !== null && max !== null && min > max) throw new Error(`Invalid ${label} range: ${value}`);
  return { min, max };
}

function formatRange(range) {
  if (!range) return null;
  if (range.min === null && range.max === null) return null;
  const min = range.min ?? '';
  const max = range.max ?? '';
  if (range.min !== null && range.max !== null && range.min === range.max) return String(range.min);
  return `${min}-${max}`;
}

// IS24 radius searches carry the circle in the query string as
// geocoordinates=lat;lon;radiusKm. Returns null for anything malformed —
// callers surface that through unsupportedParams rather than guessing a
// location, because a wrong guess silently searches the wrong place.
function parseGeoCoordinates(raw) {
  const parts = String(raw ?? '').split(';').map(p => p.trim());
  if (parts.length !== 3 || parts.some(p => p === '')) return null;
  const [lat, lon, radiusKm] = parts.map(Number);
  if (![lat, lon, radiusKm].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  if (radiusKm <= 0) return null;
  return { lat, lon, radiusKm };
}

// IS24's district picker ("filter_suggestions") keeps the container region in
// the path and puts the actually selected areas in geocodes= as numeric IDs.
// Leading zeroes are significant: the mobile API answers 0200000005056 and
// rejects 200000005056 with a 412. Returns null for anything that is not a
// plain ID list, so the caller can surface it rather than fall back to the
// container region — that would silently search the whole city.
function parseGeocodeIds(raw) {
  const values = splitValues(raw);
  if (!values.length) return null;
  if (!values.every(v => /^\d{4,20}$/.test(v))) return null;
  return [...new Set(values)];
}

// bbox carries the map viewport as an encoded polyline rectangle. Homelander
// forwards it verbatim — the mobile API accepts the web's own encoding — so it
// only needs to be checked for characters that survive a query string intact.
function isBboxValue(raw) {
  const value = String(raw ?? '').trim();
  return value !== '' && /^[A-Za-z0-9+/=_.~-]+$/.test(value);
}

// Google-encoded polyline → [[lat, lon], …], or null for anything malformed.
// Homelander decodes only to prove a drawn shape survived IS24's transport
// encoding intact — what it sends the mobile API is the polyline string itself,
// never these points.
function decodePolylinePoints(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    const deltas = [];
    for (let axis = 0; axis < 2; axis++) {
      let shift = 0;
      let result = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        // Truncated pair, runaway varint, or a character below the polyline
        // alphabet — all mean this is not a polyline, so stop rather than guess.
        if (index >= encoded.length || shift > 30) return null;
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0) return null;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      deltas.push((result & 1) ? ~(result >> 1) : (result >> 1));
    }
    lat += deltas[0];
    lon += deltas[1];
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

// Map-drawn searches carry their outlines in shape=, base64 over one or more
// polylines joined by ';' (two drawn areas → two polylines). IS24's base64 is
// URL-transport-safe: '/'→'-', '+'→'_', '='→'.'. The mobile API answers 400 for
// that encoded form and 200 for the polylines themselves, so unlike bbox this
// one has to be unwrapped — and therefore verified, since a bad unwrap would
// send the API an outline that is not the one the user drew.
function parseShape(raw) {
  const value = String(raw ?? '').trim();
  if (!value || !/^[A-Za-z0-9+/=_.~-]+$/.test(value)) return null;
  const polyline = Buffer
    .from(value.replace(/-/g, '/').replace(/_/g, '+').replace(/\./g, '='), 'base64')
    .toString('latin1');
  const polygons = polyline.split(';');
  if (polygons.some(polygon => !polygon)) return null;
  for (const polygon of polygons) {
    const points = decodePolylinePoints(polygon);
    // Fewer than three corners cannot enclose an area.
    if (!points || points.length < 3) return null;
    if (!points.every(([lat, lon]) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  }
  return { polyline, polygonCount: polygons.length };
}

// centerofsearchaddress is display-only: IS24 varies its separators between
// URL shapes, so parse defensively. The value never reaches the mobile API,
// so a wrong guess about the format is cosmetic, never functional.
function formatCenterAddress(raw) {
  return String(raw ?? '')
    .split(/[;,]/)
    .map(p => p.trim())
    .filter(Boolean)
    .join(', ');
}

function splitValues(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function mapMultiValues(rawValue, mapping, key, unsupportedParams) {
  const mapped = [];
  for (const value of splitValues(rawValue)) {
    const normalized = value.toLowerCase();
    if (mapping[normalized]) mapped.push(mapping[normalized]);
    else unsupportedParams.push({ key, value, risk: 'dangerous' });
  }
  return mapped;
}

function titleizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isSafeIgnoredParam(key) {
  return SAFE_IGNORED_PARAM_PATTERNS.some(rx => rx.test(key));
}

/**
 * Parse an IS24 web search URL into Homelander's canonical search model.
 * @param {string} webUrl
 * @returns {{canonical: object|null, unsupportedParams: Array, safeIgnoredParams: Array, error: string|null}}
 */
export function parseSearchUrl(webUrl) {
  try {
    const url = new URL(normalizeUrl(webUrl));
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const sucheIdx = pathParts.findIndex(p => p.toLowerCase() === 'suche');
    if (sucheIdx === -1) return emptyResult('URL does not contain /Suche/ path');
    if (!/immobilienscout24\.de$/i.test(url.hostname) && !/\.immobilienscout24\.de$/i.test(url.hostname)) {
      return emptyResult('URL is not an immobilienscout24.de search link');
    }

    const afterSuche = pathParts.slice(sucheIdx + 1);

    // IS24 always puts the type slug as the LAST path segment. Adopt Fredy's
    // structurally-correct approach: last segment = type, everything between
    // /Suche/ and the type is geocode (plus optional radius/shape prefix).
    const typeSlug = afterSuche.at(-1) || '';

    // Mobile API only supports 5 realEstateTypes. Desktop-only categories
    // (garage, WG, senior living, etc.) would silently return wrong listings.
    if (MOBILE_UNSUPPORTED_TYPE_SLUGS.has(typeSlug)) {
      return emptyResult(`The IS24 mobile API does not support this search category: ${typeSlug}. This search type is desktop-only and would return incorrect listings.`);
    }

    let realEstatePathType = null;
    let seoPathParams = null;

    // Tier 1: direct lookup in REALESTATE_TYPE_MAP
    if (REALESTATE_TYPE_MAP[typeSlug]) {
      realEstatePathType = typeSlug;
    }
    // Tier 2: SEO equipment path (e.g. wohnung-mit-balkon-mieten)
    else if (SEO_PATH_EQUIPMENT_MAP[typeSlug]) {
      seoPathParams = SEO_PATH_EQUIPMENT_MAP[typeSlug];
      realEstatePathType = 'wohnung-mieten'; // fall back to base type
    }
    // Tier 3: SEO warmrent path (e.g. wohnung-bis-800-euro-warm)
    else {
      const warmrentMatch = typeSlug.match(SEO_MAX_WARMRENT_PATH_PATTERN);
      if (warmrentMatch) {
        const { type, price } = warmrentMatch.groups;
        realEstatePathType = `${type}-mieten`;
        seoPathParams = {
          price: { min: null, max: Number(price), type: 'calculatedtotalrent' },
        };
      }
    }

    // WG size pattern (e.g. 4er-wg) as a sub-tier within the last segment
    const wgSearch = parseWgSlug(typeSlug);
    if (wgSearch && !realEstatePathType) {
      realEstatePathType = 'wohnung-mieten';
    }

    // Geocode: everything between /Suche/ and the type slug (last segment).
    // The first geocode part after /Suche/ may be 'radius' or 'shape'.
    const rawGeocodeParts = afterSuche.slice(0, -1);
    const searchType = rawGeocodeParts[0] === 'radius' ? 'radius'
      : rawGeocodeParts[0] === 'shape' ? 'shape'
      : 'region';
    const geocodeParts = searchType !== 'region'
      ? rawGeocodeParts.slice(1)
      : rawGeocodeParts;

    const canonical = {
      originalUrl: url.toString(),
      realEstateType: REALESTATE_TYPE_MAP[realEstatePathType] || 'apartmentrent',
      realEstatePathType: realEstatePathType || typeSlug || null,
      searchType,
      location: {
        path: geocodeParts,
        geocode: geocodeParts.length ? `/${geocodeParts.join('/')}` : '',
        geocodes: [],
        bbox: null,
        shape: null,
        label: geocodeParts.length ? geocodeParts.filter(p => p !== 'de').map(titleizeSlug).join(' / ') : 'All Germany',
        center: null,
      },
      construction: { newBuildingOnly: NEW_BUILD_TYPES.has(realEstatePathType) },
      price: seoPathParams?.price || { min: null, max: null, type: PRICE_TYPE_MAP[realEstatePathType] || 'calculatedtotalrent' },
      rooms: { min: null, max: null },
      livingSpace: { min: null, max: null },
      heatingTypes: [],
      equipment: seoPathParams?.equipment || [],
      apartmentTypes: seoPathParams?.apartmentTypes || [],
      fullText: wgSearch?.fullText || null,
      flatShare: wgSearch || null,
      directParams: [],
      excludeSwapFlat: !String(webUrl).includes('tausch'),
    };

    const unsupportedParams = [];
    const safeIgnoredParams = [];
    const seenKnownKeys = new Set();
    let centerAddress = '';

    for (const [rawKey, value] of url.searchParams) {
      const key = rawKey.toLowerCase();
      if (key === 'price') {
        canonical.price = { ...parseRange(value, 'price'), type: canonical.price.type };
        seenKnownKeys.add(key);
      } else if (key === 'numberofrooms') {
        canonical.rooms = parseRange(value, 'number of rooms');
        seenKnownKeys.add(key);
      } else if (key === 'livingspace') {
        canonical.livingSpace = parseRange(value, 'living space');
        seenKnownKeys.add(key);
      } else if (key === 'pricetype') {
        canonical.price.type = value;
        seenKnownKeys.add(key);
      } else if (key === 'heatingtypes') {
        canonical.heatingTypes.push(...mapMultiValues(value, HEATING_TYPE_MAP, rawKey, unsupportedParams));
        seenKnownKeys.add(key);
      } else if (key === 'equipment') {
        canonical.equipment.push(...mapMultiValues(value, EQUIPMENT_MAP, rawKey, unsupportedParams));
        seenKnownKeys.add(key);
      } else if (EQUIPMENT_CHECKBOX_PARAMS.has(key)) {
        // Equipment checkboxes (onlyWithBalcony, etc.) must go into the
        // equipment= param — standalone booleans return 412 from mobile API.
        const mapped = EQUIPMENT_MAP[key];
        if (mapped) canonical.equipment.push(mapped);
        seenKnownKeys.add(key);
      } else if (DIRECT_PARAM_MAP[key]) {
        const mappedKey = DIRECT_PARAM_MAP[key];
        // Apply value corrections (e.g. swapflat → swap_flat, 1/true → yes for pets, A%2B → a_plus)
        const correctedValue = mappedKey === 'exclusioncriteria'
          ? splitValues(value).map(v => EXCLUSION_CRITERIA_CORRECTIONS[v.toLowerCase()] || v).join(',')
          : mappedKey === 'petsallowedtypes' && key === 'pets-allowed'
            ? (value === '1' || value === 'true' ? 'yes' : value === '0' || value === 'false' ? 'no' : value)
            : mappedKey === 'energyefficiencyclasses' && key === 'energy-efficiency'
              ? (ENERGY_EFFICIENCY_CORRECTIONS[value.toLowerCase()] || value)
              : value;
        // Populate structured canonical fields from query params (skip directParams
        // for fields that buildMobileApiUrl already outputs from canonical structure)
        const skipDirect = mappedKey === 'newbuilding' || mappedKey === 'fulltext' || mappedKey === 'apartmenttypes';
        if (!skipDirect) canonical.directParams.push({ key: mappedKey, value: correctedValue });
        if (mappedKey === 'newbuilding') canonical.construction.newBuildingOnly = true;
        if (mappedKey === 'fulltext') canonical.fullText = String(value);
        if (mappedKey === 'apartmenttypes') canonical.apartmentTypes = splitValues(value);
        seenKnownKeys.add(key);
      } else if (MOBILE_UNSUPPORTED_WEB_FILTER_LABELS[key]) {
        safeIgnoredParams.push({
          key: rawKey,
          value,
          label: MOBILE_UNSUPPORTED_WEB_FILTER_LABELS[key],
          mobileRejected: true,
          reason: `The IS24 mobile API rejects ${MOBILE_UNSUPPORTED_WEB_FILTER_LABELS[key]} filters; Homelander keeps the supported parts of the search.`,
        });
        seenKnownKeys.add(key);
      } else if (key === 'built-in-kitchen' || key === 'guest-toilet') {
        // Legacy IS24/Fredy-style flags: keep the historical mobile param shape
        // while also surfacing a human-readable equipment preview.
        canonical.directParams.push({ key: 'equipment', value });
        const mapped = EQUIPMENT_MAP[key];
        if (mapped) canonical.equipment.push(mapped);
        seenKnownKeys.add(key);
      } else if (key === 'geocoordinates') {
        // The circle itself. Mutates canonical.searchType, not the local const —
        // canonical was already built from it, so canonical holds the truth.
        const center = parseGeoCoordinates(value);
        if (center) {
          canonical.location.center = center;
          canonical.searchType = 'radius';
        } else {
          unsupportedParams.push({ key: rawKey, value, risk: 'dangerous' });
        }
        seenKnownKeys.add(key);
      } else if (key === 'geocodes') {
        const ids = parseGeocodeIds(value);
        if (ids) canonical.location.geocodes = ids;
        else unsupportedParams.push({ key: rawKey, value, risk: 'dangerous' });
        seenKnownKeys.add(key);
      } else if (key === 'shape') {
        // Mirrors geocoordinates: the outline itself decides the search type, so
        // a shape= param without a /shape/ path segment still works. An outline
        // Homelander cannot read is still a drawn search — blocked below rather
        // than dropped, which would search far outside what the user drew.
        canonical.location.shape = parseShape(value);
        canonical.searchType = 'shape';
        seenKnownKeys.add(key);
      } else if (key === 'bbox') {
        if (isBboxValue(value)) canonical.location.bbox = String(value).trim();
        else unsupportedParams.push({ key: rawKey, value, risk: 'dangerous' });
        seenKnownKeys.add(key);
      } else if (key === 'centerofsearchaddress') {
        centerAddress = formatCenterAddress(value);
        seenKnownKeys.add(key);
      } else if (isSafeIgnoredParam(rawKey)) {
        safeIgnoredParams.push({ key: rawKey, value });
      } else {
        unsupportedParams.push({ key: rawKey, value, risk: 'dangerous' });
      }
    }

    // A radius URL usually has no geocode path at all, which is what made the
    // preview claim "All Germany" while actually dropping the location.
    if (canonical.location.center) {
      const { lat, lon } = canonical.location.center;
      canonical.location.label = centerAddress || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    if (canonical.searchType === 'shape' && !canonical.location.shape) {
      return emptyResult(PREVIEW_I18N.en.labels.shapeMissingOutline, 'shapeMissingOutline');
    }

    if (canonical.searchType === 'radius' && !canonical.location.center) {
      return emptyResult(PREVIEW_I18N.en.labels.radiusMissingCoordinates, 'radiusMissingCoordinates');
    }

    // The mobile API answers 412 for a bbox that no region bounds. Dropping the
    // bbox instead would quietly search far beyond the map the user was looking
    // at, so say what is missing rather than run a wider search.
    if (!canonical.location.center && canonical.location.bbox
      && !canonical.location.geocodes.length && !canonical.location.geocode) {
      return emptyResult(PREVIEW_I18N.en.labels.bboxMissingRegion, 'bboxMissingRegion');
    }

    canonical.heatingTypes = [...new Set(canonical.heatingTypes)];
    canonical.equipment = [...new Set(canonical.equipment)];

    return { canonical, unsupportedParams, safeIgnoredParams, error: null };
  } catch (err) {
    return emptyResult(err.message);
  }
}

/** Build a mobile API list URL from a canonical search model. */
export function buildMobileApiUrl(canonical, { page = 1, pageSize = 20, includeListControls = true } = {}) {
  const params = new URLSearchParams();
  const center = canonical.location?.center;
  const shape = canonical.location?.shape;
  if (center) {
    // The API requires geocoordinates for a radius search and ignores geocodes
    // when both are present — omit geocodes rather than rely on that precedence.
    params.set('searchType', 'radius');
    params.set('geocoordinates', `${center.lat};${center.lon};${center.radiusKm}`);
  } else if (shape) {
    // Multiple drawn areas travel as one ';'-joined value; repeating shape= is a
    // 412. The API ignores geocodes here, so the outline stands alone.
    params.set('searchType', 'shape');
    params.set('shape', shape.polyline);
  } else {
    // Picked areas replace the path region instead of joining it: the API unions
    // comma-separated geocodes, so sending both would widen the search back to
    // the whole container region the picker started from.
    const geocodes = canonical.location?.geocodes?.length
      ? canonical.location.geocodes.join(',')
      : canonical.location?.geocode;
    if (geocodes) params.set('geocodes', geocodes);
    params.set('searchType', canonical.searchType || 'region');
    // bbox intersects with the geocodes and 412s without them.
    if (geocodes && canonical.location?.bbox) params.set('bbox', canonical.location.bbox);
  }
  params.set('realestatetype', canonical.realEstateType || 'apartmentrent');
  if (canonical.price?.type) params.set('pricetype', canonical.price.type);

  const price = formatRange(canonical.price);
  const rooms = formatRange(canonical.rooms);
  const livingSpace = formatRange(canonical.livingSpace);
  if (price) params.set('price', price);
  if (rooms) params.set('numberofrooms', rooms);
  if (livingSpace) params.set('livingspace', livingSpace);
  if (canonical.construction?.newBuildingOnly) params.set('newbuilding', 'true');
  if (canonical.fullText) params.set('fulltext', canonical.fullText);
  if (canonical.heatingTypes?.length) {
    const supported = canonical.heatingTypes.filter(v => !MOBILE_UNSUPPORTED_HEATING_CANONICAL.has(v));
    if (supported.length) {
      params.set('heatingtypes', supported.map(v => HEATING_TYPE_MOBILE_VALUE[v] || v).join(','));
    }
  }
  if (canonical.equipment?.length) {
    const supported = canonical.equipment.filter(v => !MOBILE_IGNORED_EQUIPMENT_CANONICAL.has(v));
    if (supported.length) {
      params.set('equipment', supported.map(v => EQUIPMENT_MOBILE_VALUE[v] || v).join(','));
    }
  }
  for (const { key, value } of canonical.directParams || []) {
    // Merge exclusioncriteria values into a single comma-separated param
    if (key === 'exclusioncriteria') continue; // handled below
    params.append(key, value);
  }
  // Collect all exclusion criteria: from directParams + swap_flat
  const exclValues = (canonical.directParams || [])
    .filter(p => p.key === 'exclusioncriteria')
    .map(p => p.value)
    .flatMap(v => v.split(','));
  if (canonical.excludeSwapFlat) exclValues.push('swap_flat');
  if (exclValues.length) params.set('exclusioncriteria', exclValues.join(','));
  if (canonical.apartmentTypes?.length) {
    params.append('apartmenttypes', canonical.apartmentTypes.join(','));
  }
  if (includeListControls) {
    params.set('sorting', '-firstactivation');
    params.set('pagenumber', String(page));
    params.set('pagesize', String(pageSize));
  }
  return `${MOBILE_API_BASE}?${params.toString()}`;
}

function formatRangePreview(range, unit = '') {
  const suffix = unit ? ` ${unit}` : '';
  if (!range || (range.min === null && range.max === null)) return null;
  if (range.min !== null && range.max !== null) return `${range.min}–${range.max}${suffix}`;
  if (range.min !== null) return `≥ ${range.min}${suffix}`;
  return `≤ ${range.max}${suffix}`;
}

function formatDirectParamPreview({ key, value }, i18n) {
  if (key === 'energyefficiencyclasses') {
    const label = value.split(',').map(v => v.replace('a_plus', 'A+').toUpperCase()).join(', ');
    return `${i18n.labels.energy}: ${label}`;
  }
  if (key === 'petsallowedtypes') {
    const values = value.split(',').map(v => v.trim()).filter(Boolean);
    const allPetValues = ['no', 'yes', 'negotiable'];
    if (allPetValues.every(v => values.includes(v))) return `${i18n.labels.pets}: ${i18n.labels.any}`;
    return `${i18n.labels.pets}: ${values.join(', ')}`;
  }
  return `${key}: ${value}`;
}

function previewFor(canonical, locale = 'en') {
  const i18n = previewLocale(locale);
  const filters = [];
  let type = i18n.realEstate[canonical.realEstateType] || canonical.realEstateType;
  if (canonical.construction?.newBuildingOnly) {
    type = String(locale).toLowerCase().startsWith('de')
      ? `${i18n.labels.newBuildPrefix}: ${type}`
      : `${i18n.labels.newBuildPrefix} ${type.charAt(0).toLowerCase()}${type.slice(1)}`;
  }
  if (canonical.flatShare?.label) type = canonical.flatShare.label;
  filters.push(type);

  const price = formatRangePreview(canonical.price);
  const rooms = formatRangePreview(canonical.rooms);
  const livingSpace = formatRangePreview(canonical.livingSpace, 'm²');
  if (price) filters.push(`${i18n.labels.price} ${price}`);
  if (rooms) filters.push(`${i18n.labels.rooms} ${rooms}`);
  if (livingSpace) filters.push(`${i18n.labels.livingSpace} ${livingSpace}`);
  if (canonical.heatingTypes?.length) filters.push(`${i18n.labels.heating}: ${canonical.heatingTypes.map(v => i18n.heating[v] || v).join(', ')}`);
  if (canonical.equipment?.length) {
    const labels = canonical.equipment.map(v => i18n.equipment[v] || v);
    filters.push(labels.length > 3 ? `${i18n.labels.equipment}: ${labels.length} ${i18n.labels.selected}` : `${i18n.labels.equipment}: ${labels.join(', ')}`);
  }
  for (const directParam of canonical.directParams || []) filters.push(formatDirectParamPreview(directParam, i18n));
  const center = canonical.location?.center;
  if (center) {
    // radiusKm is already a Number, so 1.0 and 2.50 render as "1" and "2.5".
    const suffix = i18n.labels.radiusSuffix(String(center.radiusKm));
    return { location: `${canonical.location.label} · ${suffix}`, filters };
  }
  // A picked-area search keeps its container region in the path, so the path
  // label alone would claim the whole city — carry it as a prefix instead.
  const pathLabel = canonical.location?.label;
  const locationParts = [];
  if (pathLabel && pathLabel !== PREVIEW_I18N.en.labels.allGermany) locationParts.push(pathLabel);
  if (canonical.location?.shape) {
    locationParts.push(i18n.labels.drawnAreas(canonical.location.shape.polygonCount));
  }
  if (canonical.location?.geocodes?.length) {
    locationParts.push(i18n.labels.selectedAreas(canonical.location.geocodes.length));
  }
  if (canonical.location?.bbox) locationParts.push(i18n.labels.mapArea);
  if (!locationParts.length) locationParts.push(i18n.labels.allGermany);
  return { location: locationParts.join(' · '), filters };
}

/** Validate a pasted search URL for user-facing import. Blocks dangerous unknown filters. */
export function validateSearchUrl(webUrl, options = {}) {
  const locale = typeof options === 'string' ? options : (options.locale || 'en');
  const i18n = previewLocale(locale);
  const parsed = parseSearchUrl(webUrl);
  if (parsed.error) {
    // Blocks carrying an errorCode render in the caller's locale; anything else
    // keeps its raw message for the generic userErrors mapping downstream.
    const localized = parsed.errorCode && i18n.labels[parsed.errorCode]
      ? i18n.labels[parsed.errorCode]
      : parsed.error;
    return { ok: false, ...parsed, error: localized, preview: { location: '', filters: [] }, mobileUrl: '' };
  }
  const preview = previewFor(parsed.canonical, locale);
  const dangerous = parsed.unsupportedParams.filter(p => p.risk === 'dangerous');
  const error = dangerous.length
    ? `${i18n.labels.unsupportedFilters}: ${dangerous.map(p => `${p.key}=${p.value}`).join(', ')}`
    : null;
  const localizeIgnored = (p) => {
    if (!p.mobileRejected) return p;
    return { ...p, reason: i18n.labels.mobileRejects(p.label || p.key) };
  };
  return {
    ok: !error,
    error,
    canonical: parsed.canonical,
    preview,
    unsupportedParams: parsed.unsupportedParams,
    safeIgnoredParams: parsed.safeIgnoredParams.map(localizeIgnored),
    mobileUrl: buildMobileApiUrl(parsed.canonical),
  };
}

/**
 * Parse an IS24 web search URL and return mobile API query parameters.
 * Kept compatible with existing callers; use validateSearchUrl() for import gates.
 */
export function translateUrl(webUrl) {
  const parsed = parseSearchUrl(webUrl);
  if (parsed.error) return { fullUrl: '', error: parsed.error, parsed };
  return { fullUrl: buildMobileApiUrl(parsed.canonical), error: null, parsed };
}

/** Fetch total result count for a search URL (used by "Test" button). */
export async function getTotalResults(webUrl, options = {}) {
  const validation = validateSearchUrl(webUrl, options);
  if (!validation.ok) return { total: 0, error: validation.error, validation };

  const totalUrl = buildMobileApiUrl(validation.canonical, { includeListControls: false })
    .replace('/search/list?', '/search/total?');

  try {
    const resp = await fetch(totalUrl, {
      headers: {
        'User-Agent': 'ImmoScout_27.12_26.2_._',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return { total: 0, error: `HTTP ${resp.status}`, validation };
    const data = await resp.json();
    return { total: data.totalResults || data.numberOfHits || data.total || 0, error: null, validation };
  } catch (err) {
    return { total: 0, error: err.message, validation };
  }
}

/** Fetch listings from the mobile API. */
export async function fetchListings(webUrl, page = 1) {
  const validation = validateSearchUrl(webUrl);
  if (!validation.ok) return { listings: [], error: validation.error, validation };
  const fetchUrl = buildMobileApiUrl(validation.canonical, { page });

  try {
    const resp = await fetch(fetchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'ImmoScout_27.12_26.2_._',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ supportedResultListTypes: [], userData: {} }),
    });

    if (!resp.ok) return { listings: [], error: `HTTP ${resp.status}`, validation };

    // Detect AWS WAF perimeter captcha (returns HTML instead of JSON)
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return { listings: [], error: 'PERIMETER_CAPTCHA (AWS WAF — solve in browser to continue)', validation };
    }

    const data = await resp.json();
    const items = data.resultListItems || [];
    const listings = items.map((item) => {
      const expose = item.item || item;
      const attrs = {};
      if (Array.isArray(expose.attributes)) {
        for (const attr of expose.attributes) {
          if (attr.attribute && attr.value) attrs[attr.attribute] = attr.value;
        }
      }
      return {
        expose_id: String(expose.id || expose.exposeId || ''),
        title: expose.title || '',
        price: parseFloat(attrs.price || attrs.totalRent || attrs.purchasePrice || 0),
        size: parseFloat(attrs.livingSpace || attrs.area || 0),
        rooms: parseFloat(attrs.numberOfRooms || 0),
        address: expose.address?.line || expose.address || '',
        image_url: expose.titlePicture?.full || expose.titlePicture?.preview || '',
      };
    });

    return { listings: listings.filter(l => l.expose_id), error: null, validation };
  } catch (err) {
    return { listings: [], error: err.message, validation };
  }
}
