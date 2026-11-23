// Opt-in alerts: emergency squawks, low passes overhead, and a watchlist (military, helicopters,
// starred callsigns or registrations). Each aircraft alerts once per kind every 30 minutes.

var KIND = { EMERGENCY: 1, LOW: 2, MILITARY: 3, HELI: 4, WATCH: 5 };
var REPEAT_MS = 30 * 60000;
var EMERGENCY_SQUAWKS = { '7500': 'HIJACK', '7600': 'NORDO', '7700': 'MAYDAY' };

function seen() {
  try { return JSON.parse(localStorage.getItem('fr-alerts')) || {}; } catch (e) { return {}; }
}
function save(s) {
  var now = Date.now();
  for (var k in s) { if (s.hasOwnProperty(k) && now - s[k] > REPEAT_MS) { delete s[k]; } }
  try { localStorage.setItem('fr-alerts', JSON.stringify(s)); } catch (e) { }
}

function watchlist(text) {
  return String(text || '').toUpperCase().split(/[\s,;]+/).filter(function (w) { return w.length >= 2; });
}

function label(p) { return (p.cs || p.reg || p.hex).toUpperCase(); }

// arranged: entries from planes.arrange (p, d in meters). Returns { kind, text } or null.
function check(arranged, cfg) {
  if (!cfg.alertSquawk && !cfg.alertLow && !cfg.alertMil && !cfg.alertHeli && !cfg.watchlist) { return null; }
  var list = watchlist(cfg.watchlist), memo = seen(), now = Date.now(), best = null;

  function consider(kind, e, text) {
    var key = e.p.hex + ':' + kind;
    if (memo[key] && now - memo[key] < REPEAT_MS) { return; }
    if (!best || kind < best.kind) { best = { kind: kind, text: text, key: key }; }
  }

  arranged.forEach(function (e) {
    var p = e.p;
    if (cfg.alertSquawk && (EMERGENCY_SQUAWKS[p.squawk] || p.emergency)) {
      consider(KIND.EMERGENCY, e, (p.squawk || 'EMERG') + ' ' + label(p));
    }
    if (cfg.alertLow && !p.ground && p.alt !== null && p.alt <= cfg.alertLowFt && e.d <= 1852) {
      consider(KIND.LOW, e, 'LOW ' + label(p));
    }
    if (cfg.alertMil && p.mil) { consider(KIND.MILITARY, e, 'MIL ' + label(p)); }
    if (cfg.alertHeli && p.cat === 'A7') { consider(KIND.HELI, e, 'HELI ' + label(p)); }
    if (list.length) {
      var cs = (p.cs || '').toUpperCase(), reg = (p.reg || '').toUpperCase();
      for (var i = 0; i < list.length; i++) {
        if ((cs && cs.indexOf(list[i]) === 0) || (reg && reg.replace('-', '').indexOf(list[i].replace('-', '')) === 0)) {
          consider(KIND.WATCH, e, 'WATCH ' + label(p));
          break;
        }
      }
    }
  });
  if (!best) { return null; }
  memo[best.key] = now;
  save(memo);
  return { kind: best.kind, text: best.text.substr(0, 18) };
}

module.exports = { check: check, KIND: KIND };
