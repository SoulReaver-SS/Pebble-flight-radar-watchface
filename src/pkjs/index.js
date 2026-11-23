// Flight Radar: phone side. Gets GPS, builds the map, fetches aircraft and ships it all to the watch.
var Clay = require('@rebble/clay');
var clayConfig = require('./config');
var clayFn = require('./config-fn');
var places = require('./places');
var geo = require('./geo');
var planes = require('./planes');
var mapbuilder = require('./mapbuilder');
var enrich = require('./enrich');
var alerts = require('./alerts');
var trails = require('./trails');
var keys = require('message_keys');

var clay = new Clay(clayConfig, clayFn, { autoHandleEvents: false });

var MAX_PLANES = 60;
var CHUNK = 1500;
var NM = 1852;

// Screen geometry per watch: px from the map center to the bands (range ring) and to the edges.
function screen() {
  var platform = '';
  try { platform = Pebble.getActiveWatchInfo().platform; } catch (e) { }
  if (platform === 'gabbro') { return { radiusPx: 68, halfW: 130, halfH: 130 }; }  // Round 2, 260x260
  return { radiusPx: 77, halfW: 100, halfH: 120 };                                 // Time 2, 200x228
}

var CMD_REFRESH = 1;
var CMD_HELLO = 2;
var CMD_ZOOM = 3;
var again = false; // a refresh was asked for while one was running

var busy = false, busySince = 0;
var watchMap = null; // map currently on the watch: { id, lat, lon, mpp }

// ---------- settings ----------
function settings() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (e) { s = {}; }
  function pick(k, d) { return (s[k] === undefined || s[k] === null || s[k] === '') ? d : s[k]; }
  return {
    wbKey: String(pick('CFG_WB_KEY', '')).trim(),
    pmKey: String(pick('CFG_PM_KEY', '')).trim(),  // blank = OpenFreeMap
    interval: (function (v) { return isNaN(v) ? 2 : v; })(parseInt(pick('CFG_INTERVAL', '2'), 10)),  // 0 = off
    live: parseInt(pick('CFG_LIVE', '10'), 10) || 10,
    night: on(pick('CFG_NIGHT', false)),
    nightFrom: parseInt(pick('CFG_NIGHT_FROM', '23'), 10),
    nightTo: parseInt(pick('CFG_NIGHT_TO', '7'), 10),
    trails: String(pick('CFG_TRAILS', 'sel')),
    labels: on(pick('CFG_LABELS', false)),
    battery: on(pick('CFG_BATTERY', true)),
    receiver: String(pick('CFG_RECEIVER', '')).trim(),
    alertSquawk: on(pick('CFG_ALERT_SQUAWK', false)),
    alertLow: on(pick('CFG_ALERT_LOW', false)),
    alertLowFt: parseInt(pick('CFG_ALERT_LOW_FT', '3000'), 10) || 3000,
    alertMil: on(pick('CFG_ALERT_MIL', false)),
    alertHeli: on(pick('CFG_ALERT_HELI', false)),
    watchlist: String(pick('CFG_WATCHLIST', '')).trim(),
    radiusNm: parseInt(pick('CFG_RADIUS', '10'), 10) || 10,
    roads: parseInt(pick('CFG_ROADS', '1'), 10),
    ring: pick('CFG_RING', true) !== false && pick('CFG_RING', true) !== 0,
    touchZoom: zoomMode(pick('CFG_TOUCH_ZOOM', 'up')),
    locMode: String(pick('CFG_LOC_MODE', 'gps')),
    preset: String(pick('CFG_PRESET', 'sj')),
    zip: String(pick('CFG_ZIP', '')),
    coords: String(pick('CFG_COORDS', '')),
    hideGround: pick('CFG_GROUND', true) !== false && pick('CFG_GROUND', true) !== 0
  };
}

function on(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

// Watch zoom gesture: 0 off, 1 swipe up = in, 2 down = in, 3 right = in, 4 left = in.
function zoomMode(v) {
  if (v === true) { return 1; }
  if (v === false || v === 0) { return 0; }
  return { off: 0, up: 1, down: 2, right: 3, left: 4 }[v] || 1;
}

function mppFor(cfg) { return cfg.radiusNm * NM / screen().radiusPx; }

// ---------- AppMessage queue ----------
var queue = [], sending = false;
function send(dict, done) {
  queue.push({ dict: dict, done: done, tries: 0 });
  pump();
}
function pump() {
  if (sending || !queue.length) { return; }
  sending = true;
  var item = queue[0];
  Pebble.sendAppMessage(item.dict, function () {
    queue.shift(); sending = false;
    if (item.done) { item.done(null); }
    pump();
  }, function (e) {
    sending = false;
    if (++item.tries >= 4) {
      queue.shift();
      console.log('AppMessage dropped: ' + JSON.stringify(e && e.error ? e.error : e));
      if (item.done) { item.done(new Error('send failed')); }
      pump();
    } else {
      setTimeout(pump, 300 * item.tries);
    }
  });
}

function sendConfig() {
  var cfg = settings(), d = {};
  d[keys.ROAD_STYLE] = cfg.roads;
  d[keys.SHOW_RING] = cfg.ring ? 1 : 0;
  d[keys.INTERVAL_MIN] = cfg.interval;
  d[keys.RADIUS_NM] = cfg.radiusNm;
  d[keys.TOUCH_ZOOM] = cfg.touchZoom;
  d[keys.LIVE_SECS] = cfg.live;
  d[keys.NIGHT_FROM] = cfg.night ? cfg.nightFrom : -1;
  d[keys.NIGHT_TO] = cfg.night ? cfg.nightTo : -1;
  d[keys.LABELS] = cfg.labels ? 1 : 0;
  d[keys.BATTERY] = cfg.battery ? 1 : 0;
  d[keys.TRAIL_MODE] = { off: 0, sel: 1, all: 2 }[cfg.trails] || 0;
  send(d);
}

function sendStatus(text) {
  var d = {};
  d[keys.STATUS] = text;
  send(d);
}

function toArray(u8) { return Array.prototype.slice.call(u8); }

function b64encode(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i++) { s += String.fromCharCode(u8[i]); }
  return btoa(s);
}
function b64decode(str) {
  var s = atob(str), u8 = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) { u8[i] = s.charCodeAt(i); }
  return u8;
}

// Send a built map to the watch in chunks.
function sendMap(map, cb) {
  var id = ((watchMap && watchMap.id) || 0) + 1;
  var head = {};
  head[keys.MAP_ID] = id;
  head[keys.MAP_TOTAL] = map.bytes.length;
  head[keys.MPP10] = Math.round(map.mpp * 10);
  head[keys.UNIT] = map.unit;
  send(head);
  for (var off = 0; off < map.bytes.length; off += CHUNK) {
    var d = {};
    d[keys.MAP_ID] = id;
    d[keys.MAP_OFFSET] = off;
    d[keys.MAP_CHUNK] = toArray(map.bytes.subarray(off, Math.min(off + CHUNK, map.bytes.length)));
    send(d);
  }
  // Marker message so the callback fires after every chunk is acknowledged.
  var tail = {};
  tail[keys.MAP_ID] = id;
  send(tail, function (err) {
    if (!err) { watchMap = { id: id, lat: map.lat, lon: map.lon, mpp: map.mpp, unit: map.unit, empty: !map.bytes.length, builtAt: Date.now() }; }
    cb(err);
  });
}

function cachedMap(lat, lon, mpp, src) {
  try {
    var c = JSON.parse(localStorage.getItem('overhead-map'));
    if (!c || c.v !== 3 || c.src !== src || Math.abs(c.mpp - mpp) > 0.01) { return null; }
    var p = geo.makeProjection(c.lat, c.lon).toLocal(lat, lon);
    if (Math.sqrt(p[0] * p[0] + p[1] * p[1]) > mapbuilder.marginFor(mpp) * 0.8) { return null; }
    return { bytes: b64decode(c.b64), lat: c.lat, lon: c.lon, mpp: c.mpp, unit: c.unit };
  } catch (e) { return null; }
}
function storeMap(map, src) {
  try {
    localStorage.setItem('overhead-map', JSON.stringify({ v: 3, src: src, lat: map.lat, lon: map.lon, mpp: map.mpp, unit: map.unit, b64: b64encode(map.bytes) }));
  } catch (e) { console.log('map cache failed: ' + e.message); }
}
function emptyMap(lat, lon, mpp) { return { bytes: new Uint8Array(0), lat: lat, lon: lon, mpp: mpp, unit: geo.unitFor(mpp) }; }

// Make sure the watch has a map that covers (lat, lon) at the configured scale.
function ensureMap(lat, lon, cfg, cb) {
  var mpp = mppFor(cfg);
  if (watchMap && Math.abs(watchMap.mpp - mpp) < 0.01) {
    var p = geo.makeProjection(watchMap.lat, watchMap.lon).toLocal(lat, lon);
    var near = Math.sqrt(p[0] * p[0] + p[1] * p[1]) < mapbuilder.marginFor(mpp) * 0.8;
    // An empty map (earlier build failed) is retried at most every 5 minutes.
    var retryDue = watchMap.empty && Date.now() - watchMap.builtAt > 300000;
    if (near && !retryDue) { cb(null); return; }
  }
  var src = cfg.pmKey ? 'pm' : 'ofm';
  var cached = cachedMap(lat, lon, mpp, src);
  if (cached) { sendMap(cached, cb); return; }
  var sc = screen();
  mapbuilder.buildMap({ lat: lat, lon: lon, mpp: mpp, key: cfg.pmKey, halfW: sc.halfW, halfH: sc.halfH }, function (err, map) {
    if (err) {
      console.log('map build failed: ' + err.message);
      // Still give the watch a scale so planes render; retry the map next refresh.
      sendMap(emptyMap(lat, lon, mpp), function (e2) { if (!e2) { watchMap.empty = true; } sendStatus('NO MAP'); cb(e2); });
      return;
    }
    console.log('map: z' + map.zoom + ' ' + map.tiles + ' tiles, ' + map.bytes.length + ' bytes');
    if (!map.partial) { storeMap(map, src); }
    sendMap(map, cb);
  });
}

// ---------- location ----------
// A fixed place from settings, or the phone's GPS.
function where(cfg, cb) {
  if (cfg.locMode === 'gps') { locate(cb); return; }
  places.resolveFixed(cfg, function (err, fixed) {
    if (err || !fixed) {
      console.log('fixed location failed: ' + (err && err.message));
      locate(function (e2, fix) { if (fix) { fix.warn = 'BAD PLACE'; } cb(e2, fix); });
      return;
    }
    cb(null, { lat: fixed.lat, lon: fixed.lon, label: fixed.label, t: Date.now() });
  });
}

function locate(cb) {
  navigator.geolocation.getCurrentPosition(function (pos) {
    var fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: Date.now() };
    try { localStorage.setItem('overhead-fix', JSON.stringify(fix)); } catch (e) { }
    cb(null, fix);
  }, function (err) {
    var last = null;
    try { last = JSON.parse(localStorage.getItem('overhead-fix')); } catch (e) { }
    if (last) { last.stale = true; cb(null, last); } else { cb(err || new Error('no gps')); }
  }, { enableHighAccuracy: false, maximumAge: 300000, timeout: 15000 });
}

// ---------- refresh cycle ----------
function done() {
  busy = false;
  if (again) { var force = again === 'force'; again = false; refresh(force); }
}

function refresh(forceMap) {
  if (busy && Date.now() - busySince < 60000) { again = again || 'plain'; if (forceMap) { again = 'force'; } return; }
  busy = true; busySince = Date.now();
  var cfg = settings();
  if (forceMap) { watchMap = null; }

  where(cfg, function (err, fix) {
    if (err) { sendStatus('NO GPS'); done(); return; }
    ensureMap(fix.lat, fix.lon, cfg, function () {
      if (!watchMap) { done(); return; }
      var proj = geo.makeProjection(watchMap.lat, watchMap.lon);
      var user = proj.toLocal(fix.lat, fix.lon);
      // Fetch a bit past the visible corners.
      var fetchNm = cfg.radiusNm * 1.75;
      planes.fetchPlanes({
        wbKey: cfg.wbKey, receiver: cfg.receiver, lat: fix.lat, lon: fix.lon,
        radiusNm: fetchNm, hideGround: cfg.hideGround
      }, function (perr, list, src, warn) {
        if (perr) { sendStatus('NO DATA'); done(); return; }
        var unit = watchMap.unit || geo.UNIT_M;
        var all = planes.arrange(list, proj, user, 100000, fetchNm * NM);
        var arranged = all.slice(0, MAX_PLANES);
        trails.record(all.map(function (e) { return e.p; }));
        var packed = planes.packPlanes(arranged, unit, geo.clamp16);
        var d = {};
        d[keys.MAP_ID] = watchMap.id;
        d[keys.USER_X] = Math.round(user[0] / unit);
        d[keys.USER_Y] = Math.round(user[1] / unit);
        d[keys.UNIT] = unit;
        d[keys.PLANE_COUNT] = packed.count;
        d[keys.PLANES] = packed.count ? toArray(packed.bytes) : [0];
        d[keys.SRC] = src;
        d[keys.STATUS] = warn || fix.warn || (fix.stale ? 'OLD GPS' : '') || (watchMap.empty ? 'NO MAP' : '');
        d[keys.LOC_LABEL] = fix.label || '';
        send(d);

        // Trails for the nearest plane (or all), then any alert, then route/type for the nearest.
        var tb = trails.pack(arranged, cfg.trails, proj, unit, geo.clamp16, 1600);
        var tm = {};
        tm[keys.TRAILS] = tb ? toArray(tb) : [0];
        send(tm);
        var alert = alerts.check(all, cfg);
        if (alert) {
          var am = {};
          am[keys.ALERT] = alert.text;
          am[keys.ALERT_KIND] = alert.kind;
          send(am);
        }
        if (!arranged.length) { done(); return; }
        var near = arranged[0].p;
        enrich.lookup(near, function (info) {
          var em = {};
          em[keys.NEAR_CS] = (near.cs || near.hex).toUpperCase().substr(0, 8);
          em[keys.NEAR_TYPE] = info.type || '';
          em[keys.ROUTE] = info.route || '';
          send(em, done);
        });
      });
    });
  });
}

Pebble.addEventListener('ready', function () {
  console.log('Overhead phone side ready');
  sendConfig();
  refresh(true);
});

Pebble.addEventListener('appmessage', function (e) {
  var cmd = e.payload && (e.payload.CMD !== undefined ? e.payload.CMD : e.payload[keys.CMD]);
  if (cmd === CMD_HELLO) { sendConfig(); refresh(true); }
  else if (cmd === CMD_REFRESH) { refresh(false); }
  else if (cmd === CMD_ZOOM) {
    // Swipe zoom on the watch: remember the new range like a settings change, then redraw.
    var nm = e.payload.RADIUS_NM !== undefined ? e.payload.RADIUS_NM : e.payload[keys.RADIUS_NM];
    if (nm > 0) {
      var st = {};
      try { st = JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (x) { st = {}; }
      st.CFG_RADIUS = String(nm);
      localStorage.setItem('clay-settings', JSON.stringify(st));
      refresh(false);
    }
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  var before = settings();
  clay.getSettings(e.response); // persists to localStorage
  var after = settings();
  sendConfig();
  var moved = before.locMode !== after.locMode || before.preset !== after.preset ||
    before.zip !== after.zip || before.coords !== after.coords;
  refresh(before.radiusNm !== after.radiusNm || before.pmKey !== after.pmKey || moved);
});
