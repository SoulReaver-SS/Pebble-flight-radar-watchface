// Fixed locations: presets, ZIP/postal codes and raw coordinates.
var net = require('./net');

// id: [watch label (short), settings name, lat, lon]
var PRESETS = {
  sj: ['SAN JOSE', 'San Jose', 37.3382, -121.8863],
  sjc: ['SJC', 'San Jose Airport (SJC)', 37.3639, -121.9289],
  sf: ['SF', 'San Francisco', 37.7749, -122.4194],
  sfo: ['SFO', 'San Francisco Airport (SFO)', 37.6213, -122.3790],
  oak: ['OAKLAND', 'Oakland', 37.8044, -122.2712],
  oakap: ['OAK', 'Oakland Airport (OAK)', 37.7126, -122.2197],
  pa: ['PALO ALTO', 'Palo Alto', 37.4419, -122.1430],
  fremont: ['FREMONT', 'Fremont', 37.5485, -121.9886],
  sc: ['SANTA CRUZ', 'Santa Cruz', 36.9741, -122.0308],
  nyc: ['NEW YORK', 'New York', 40.7128, -74.0060],
  jfk: ['JFK', 'New York JFK', 40.6413, -73.7781],
  la: ['LA', 'Los Angeles', 34.0522, -118.2437],
  lax: ['LAX', 'Los Angeles Airport (LAX)', 33.9416, -118.4085],
  chi: ['CHICAGO', 'Chicago', 41.8781, -87.6298],
  lon: ['LONDON', 'London', 51.5074, -0.1278],
  lhr: ['HEATHROW', 'London Heathrow (LHR)', 51.4700, -0.4543],
  par: ['PARIS', 'Paris', 48.8566, 2.3522],
  ams: ['AMSTERDAM', 'Amsterdam', 52.3676, 4.9041],
  fra: ['FRANKFURT', 'Frankfurt', 50.1109, 8.6821],
  ist: ['ISTANBUL', 'Istanbul', 41.0082, 28.9784],
  istap: ['IST', 'Istanbul Airport (IST)', 41.2753, 28.7519],
  ank: ['ANKARA', 'Ankara', 39.9334, 32.8597],
  dxb: ['DUBAI', 'Dubai', 25.2048, 55.2708],
  sin: ['SINGAPORE', 'Singapore', 1.3521, 103.8198],
  hkg: ['HONG KONG', 'Hong Kong', 22.3193, 114.1694],
  tyo: ['TOKYO', 'Tokyo', 35.6762, 139.6503],
  hnd: ['HANEDA', 'Tokyo Haneda (HND)', 35.5494, 139.7798],
  sel: ['SEOUL', 'Seoul', 37.5665, 126.9780],
  syd: ['SYDNEY', 'Sydney', -33.8688, 151.2093]
};

var GROUPS = [
  ['Bay Area', ['sj', 'sjc', 'sf', 'sfo', 'oak', 'oakap', 'pa', 'fremont', 'sc']],
  ['Americas', ['nyc', 'jfk', 'la', 'lax', 'chi']],
  ['Europe', ['lon', 'lhr', 'par', 'ams', 'fra']],
  ['Turkey', ['ist', 'istap', 'ank']],
  ['Asia & Pacific', ['dxb', 'sin', 'hkg', 'tyo', 'hnd', 'sel', 'syd']]
];

// Option groups for the settings page.
function presetOptions() {
  return GROUPS.map(function (g) {
    return { label: g[0], value: g[1].map(function (id) { return { label: PRESETS[id][1], value: id }; }) };
  });
}

function shortLabel(s) { return String(s).toUpperCase().substr(0, 10); }

// "37.3382, -121.8863" -> {lat, lon} or null
function parseCoords(text) {
  var m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) { return null; }
  var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) { return null; }
  return { lat: lat, lon: lon };
}

// "95123" (US) or "TR 34437" (country code + postal code) via zippopotam.us, cached on the phone.
function geocodePostal(text, cb) {
  var raw = String(text || '').trim();
  var m = raw.match(/^([A-Za-z]{2})[\s\/-]+(.+)$/);
  var cc = m ? m[1].toLowerCase() : 'us', code = (m ? m[2] : raw).trim();
  if (!code) { cb(new Error('empty')); return; }
  var cacheKey = 'overhead-zip-' + cc + '-' + code.toUpperCase();
  try {
    var hit = JSON.parse(localStorage.getItem(cacheKey));
    if (hit && typeof hit.lat === 'number') { cb(null, hit); return; }
  } catch (e) { }
  var url = 'https://api.zippopotam.us/' + cc + '/' + encodeURIComponent(code);
  net.get(url, { json: true, timeout: 15000 }, function (err, status, body) {
    var place = body && body.places && body.places[0];
    if (err || status !== 200 || !place) { cb(err || new Error('postal HTTP ' + status)); return; }
    var res = { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude), label: shortLabel(place['place name'] || code) };
    if (!isFinite(res.lat) || !isFinite(res.lon)) { cb(new Error('bad postal result')); return; }
    try { localStorage.setItem(cacheKey, JSON.stringify(res)); } catch (e) { }
    cb(null, res);
  });
}

// cfg.locMode: 'gps' | 'preset' | 'zip' | 'coords'. cb(err, {lat, lon, label}) ; null result means use GPS.
function resolveFixed(cfg, cb) {
  if (cfg.locMode === 'preset') {
    var p = PRESETS[cfg.preset];
    if (!p) { cb(new Error('unknown preset')); return; }
    cb(null, { lat: p[2], lon: p[3], label: p[0] });
  } else if (cfg.locMode === 'coords') {
    var c = parseCoords(cfg.coords);
    if (!c) { cb(new Error('bad coordinates')); return; }
    cb(null, { lat: c.lat, lon: c.lon, label: c.lat.toFixed(1) + ',' + c.lon.toFixed(1) });
  } else if (cfg.locMode === 'zip') {
    geocodePostal(cfg.zip, cb);
  } else {
    cb(null, null);
  }
}

module.exports = { PRESETS: PRESETS, presetOptions: presetOptions, resolveFixed: resolveFixed, parseCoords: parseCoords };
