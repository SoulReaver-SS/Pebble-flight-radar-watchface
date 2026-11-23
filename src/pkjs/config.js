// Settings page (rendered by Clay inside the Pebble app on the phone).
var places = require('./places');

var RANGES = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60, 80, 100];

function hours() {
  var out = [];
  for (var h = 0; h < 24; h++) {
    var label = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM');
    out.push({ label: label, value: String(h) });
  }
  return out;
}

module.exports = [
  { type: 'heading', defaultValue: 'Flight Radar' },
  { type: 'text', defaultValue: 'Live ADS-B traffic around you on a dark map.' },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Location' },
      {
        type: 'select', messageKey: 'CFG_LOC_MODE', label: 'Center the map on', defaultValue: 'gps',
        options: [
          { label: 'My location (GPS)', value: 'gps' },
          { label: 'A city or airport', value: 'preset' },
          { label: 'A ZIP or postal code', value: 'zip' },
          { label: 'Coordinates', value: 'coords' }
        ]
      },
      {
        type: 'select', messageKey: 'CFG_PRESET', label: 'City or airport', defaultValue: 'sj',
        options: places.presetOptions()
      },
      {
        type: 'input', messageKey: 'CFG_ZIP', label: 'ZIP or postal code', defaultValue: '',
        description: 'US ZIP like 95123, or a country code and postal code like TR 34437.',
        attributes: { placeholder: '95123', autocapitalize: 'characters', autocorrect: 'off', type: 'text' }
      },
      {
        type: 'input', messageKey: 'CFG_COORDS', label: 'Coordinates', defaultValue: '',
        description: 'Latitude, longitude in decimal degrees.',
        attributes: { placeholder: '37.3382, -121.8863', autocorrect: 'off', type: 'text' }
      }
    ]
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Data' },
      {
        type: 'input', messageKey: 'CFG_WB_KEY', label: 'Wingbits API key', defaultValue: '',
        description: 'Optional. Wingbits station owners can claim a free Starter key in the Wingbits dashboard. Leave blank to use adsb.lol.',
        attributes: { placeholder: 'wb_...', autocapitalize: 'off', autocorrect: 'off', type: 'text' }
      },
      {
        type: 'input', messageKey: 'CFG_PM_KEY', label: 'Protomaps API key (map)', defaultValue: '',
        description: 'Optional. Leave blank to use OpenFreeMap, which needs no key.',
        attributes: { placeholder: 'OpenFreeMap', autocapitalize: 'off', autocorrect: 'off', type: 'text' }
      },
      {
        type: 'input', messageKey: 'CFG_RECEIVER', label: 'Your own receiver (optional)', defaultValue: '',
        description: 'Address of a readsb or tar1090 aircraft.json on your home network, like http://192.168.1.50/tar1090/data/aircraft.json. Used when your phone can reach it, otherwise the sources above.',
        attributes: { placeholder: 'http://adsb.local/tar1090/data/aircraft.json', autocapitalize: 'off', autocorrect: 'off', type: 'url' }
      }
    ]
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Refresh' },
      {
        type: 'select', messageKey: 'CFG_LIVE', label: 'Live after a wrist flick', defaultValue: '10',
        description: 'Flick your wrist and the map updates every few seconds for this long, with planes moving in real time.',
        options: [
          { label: '10 seconds', value: '10' },
          { label: '20 seconds', value: '20' },
          { label: '30 seconds', value: '30' },
          { label: '1 minute', value: '60' }
        ]
      },
      {
        type: 'select', messageKey: 'CFG_INTERVAL', label: 'In the background, refresh every', defaultValue: '2',
        description: 'A free Wingbits Starter key allows 30,000 requests a month. 2 minutes uses about 21,600, leaving room for your wrist flicks.',
        options: [
          { label: 'Off (wrist flick only)', value: '0' },
          { label: '1 minute', value: '1' },
          { label: '2 minutes', value: '2' },
          { label: '5 minutes', value: '5' },
          { label: '10 minutes', value: '10' },
          { label: '15 minutes', value: '15' },
          { label: '30 minutes', value: '30' }
        ]
      },
      { type: 'toggle', messageKey: 'CFG_NIGHT', label: 'Pause overnight', defaultValue: false,
        description: 'No background refreshes or alert vibrations during these hours. A wrist flick still works.' },
      { type: 'select', messageKey: 'CFG_NIGHT_FROM', label: 'From', defaultValue: '23', options: hours() },
      { type: 'select', messageKey: 'CFG_NIGHT_TO', label: 'Until', defaultValue: '7', options: hours() }
    ]
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Display' },
      {
        type: 'select', messageKey: 'CFG_RADIUS', label: 'Range', defaultValue: '10',
        options: RANGES.map(function (r) { return { label: r + ' nm', value: String(r) }; })
      },
      {
        type: 'select', messageKey: 'CFG_TOUCH_ZOOM', label: 'Zoom gesture', defaultValue: 'up',
        description: 'Coming soon. PebbleOS does not send touch input to watchfaces yet. This turns on once Pebble enables it.',
        options: [
          { label: 'Swipe up to zoom in', value: 'up' },
          { label: 'Swipe down to zoom in', value: 'down' },
          { label: 'Swipe right to zoom in', value: 'right' },
          { label: 'Swipe left to zoom in', value: 'left' },
          { label: 'Off', value: 'off' }
        ]
      },
      {
        type: 'radiogroup', messageKey: 'CFG_ROADS', label: 'Roads', defaultValue: '1',
        options: [
          { label: 'Solid gray', value: '0' },
          { label: 'Dithered (closer to Wingbits)', value: '1' },
          { label: 'Hidden', value: '2' }
        ]
      },
      {
        type: 'select', messageKey: 'CFG_TRAILS', label: 'Trails', defaultValue: 'sel',
        options: [
          { label: 'Highlighted plane only', value: 'sel' },
          { label: 'All planes', value: 'all' },
          { label: 'Off', value: 'off' }
        ]
      },
      { type: 'toggle', messageKey: 'CFG_LABELS', label: 'Callsign labels at 5 nm and closer', defaultValue: false },
      { type: 'toggle', messageKey: 'CFG_BATTERY', label: 'Watch battery in the top bar', defaultValue: true },
      { type: 'toggle', messageKey: 'CFG_RING', label: 'Range ring', defaultValue: true },
      { type: 'toggle', messageKey: 'CFG_GROUND', label: 'Hide aircraft on the ground', defaultValue: true }
    ]
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Alerts' },
      { type: 'text', defaultValue: 'The watch vibrates and shows the plane in the top bar. Each plane alerts once every 30 minutes.' },
      { type: 'toggle', messageKey: 'CFG_ALERT_SQUAWK', label: 'Emergency squawks (7500, 7600, 7700)', defaultValue: false },
      { type: 'toggle', messageKey: 'CFG_ALERT_LOW', label: 'Low pass overhead (within 1 nm)', defaultValue: false },
      {
        type: 'select', messageKey: 'CFG_ALERT_LOW_FT', label: 'Low means below', defaultValue: '3000',
        options: [
          { label: '2,000 ft', value: '2000' },
          { label: '3,000 ft', value: '3000' },
          { label: '5,000 ft', value: '5000' },
          { label: '10,000 ft', value: '10000' }
        ]
      },
      { type: 'toggle', messageKey: 'CFG_ALERT_MIL', label: 'Military aircraft', defaultValue: false,
        description: 'Uses adsb.lol and adsb.fi data. Not available from Wingbits.' },
      { type: 'toggle', messageKey: 'CFG_ALERT_HELI', label: 'Helicopters', defaultValue: false },
      {
        type: 'input', messageKey: 'CFG_WATCHLIST', label: 'Watchlist', defaultValue: '',
        description: 'Callsigns or registrations, separated by commas. Prefixes work: UAL matches every United flight.',
        attributes: { placeholder: 'N123AB, RCH, UAL870', autocapitalize: 'characters', autocorrect: 'off', type: 'text' }
      }
    ]
  },
  {
    type: 'text',
    defaultValue: 'Map &copy; OpenMapTiles &copy; OpenStreetMap contributors, via OpenFreeMap (or Protomaps with your key). Aircraft data from Wingbits (with your key), adsb.lol (ODbL) or adsb.fi. Routes and aircraft types from adsbdb.com. Postal codes via Zippopotam.us.'
  },
  { type: 'submit', defaultValue: 'Save' }
];

