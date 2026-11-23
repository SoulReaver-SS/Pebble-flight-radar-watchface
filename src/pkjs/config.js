// Settings page (rendered by Clay inside the Pebble app on the phone).
var places = require('./places');

var RANGES = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60, 80, 100];

module.exports = [
  { type: 'heading', defaultValue: 'Aircraft Map' },
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
        type: 'select', messageKey: 'CFG_INTERVAL', label: 'Refresh every', defaultValue: '2',
        description: 'A free Wingbits Starter key allows 30,000 requests a month. 2 minutes uses about 21,600.',
        options: [
          { label: '1 minute', value: '1' },
          { label: '2 minutes', value: '2' },
          { label: '3 minutes', value: '3' },
          { label: '5 minutes', value: '5' }
        ]
      }
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
      { type: 'toggle', messageKey: 'CFG_RING', label: 'Range ring', defaultValue: true },
      { type: 'toggle', messageKey: 'CFG_GROUND', label: 'Hide aircraft on the ground', defaultValue: true }
    ]
  },
  {
    type: 'text',
    defaultValue: 'Map &copy; OpenMapTiles &copy; OpenStreetMap contributors, via OpenFreeMap (or Protomaps with your key). Aircraft data from Wingbits (with your key) or adsb.lol (ODbL). Postal codes via Zippopotam.us.'
  },
  { type: 'submit', defaultValue: 'Save' }
];

