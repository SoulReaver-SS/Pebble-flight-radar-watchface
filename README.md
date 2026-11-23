# Flight Radar watchface for Pebble smartwatch

A Pebble watchface that shows live ADS-B traffic around you on a dark map styled after the Wingbits live map. Runs on Pebble Time 2 and Pebble Round 2.

https://apps.repebble.com/057454964bc84d3f881d3edd

- Time band on top, highlighted aircraft at the bottom: callsign, route (like SJC-LAS), distance, bearing arrow, altitude, speed and ICAO type (like B738)
- Map centered on your phone's GPS: water, highways, major roads and runways from OpenStreetMap vector tiles (OpenFreeMap by default)
- Aircraft colored by altitude with the Wingbits "thermal" ramp, snapped to Pebble's 64 colors
- Plane silhouettes at every range, with smaller pre-drawn icons past ~40 nm
- Trails: highlighted plane only (default), all planes, or off
- Optional callsign labels at 5 nm and closer
- Live window after a wrist flick (10, 20, 30 or 60 s): refetches about every 6 s and moves planes every second
- Background refresh every 1, 2 (default), 5, 10, 15 or 30 minutes, or off, with an optional overnight pause
- Watch battery and Quiet Time icon in the top band
- Opt-in alerts with a vibration: emergency squawks (7500, 7600, 7700), low passes overhead, military aircraft, helicopters, and a watchlist of callsigns or registrations
- Center on GPS, a preset city or airport (Bay Area and global metros), a ZIP/postal code, or coordinates
- Range from 1 to 100 nm; side streets and taxiways appear at 1-2 nm
- Tap/swipe controls are written but switched off: PebbleOS does not deliver touch input to watchfaces yet

## Data

| What | Source | Key |
|---|---|---|
| Aircraft | Your own readsb/tar1090 receiver (`aircraft.json`), when the phone can reach it | None |
| Aircraft | Wingbits customer API (`/v1/flights?by=radius`) | Your own key, set in settings |
| Aircraft fallback | adsb.lol, then adsb.fi (`/v2/lat/{lat}/lon/{lon}/dist/{nm}`) | None |
| Route and type | adsbdb.com (`/v0/callsign/{cs}`, `/v0/aircraft/{hex}`), cached a day | None |
| Map | OpenFreeMap (OpenMapTiles schema) | None |
| Map, optional | Protomaps hosted tiles v4 | Your own key, set in settings |
| Postal codes | Zippopotam.us | None |

Sources are tried in that order. A home receiver is only reachable on your home network (the app declares the `LocalNetwork` permission for private addresses, `.local` and `.home.arpa`); away from home the public sources take over.

Callsign routes in public databases go stale when airlines reuse flight numbers, so a route is only shown when the plane is roughly on the way between the two airports.

Military flags come from adsb.lol and adsb.fi; Wingbits does not provide them. Targets with a `~` address (no ICAO address, mostly airport ground vehicles) and surface vehicles are dropped. Aircraft on the ground are hidden by default.

## How it works

The phone side (`src/pkjs`) gets a GPS fix, downloads the vector tiles covering the view, decodes them (`mvt.js`), clips and simplifies water polygons and road lines to the screen area, and packs them as int16 coordinates in 4 m steps, doubled at wide ranges so everything fits (`geo.js`, `mapbuilder.js`). The map is rebuilt only after you move about 2 km and is cached on the phone. Aircraft are fetched every refresh, sorted by distance and packed 24 bytes each (`planes.js`), with trails (`trails.js`), alerts (`alerts.js`) and the highlighted plane's route and type (`enrich.js`) sent alongside.

The watch side (`src/c/flight_radar.c`) receives the map in chunks and the aircraft list, then draws everything with you at the center.

## Build

```
pebble build
pebble install --emulator emery
pebble install --emulator gabbro
```

`tools/icons.py` regenerates the small plane icons.

## Credits

- Map data © OpenMapTiles © OpenStreetMap contributors, served by OpenFreeMap (or Protomaps with your key)
- Aircraft data from Wingbits, adsb.lol (ODbL) and adsb.fi; routes and types from adsbdb.com
- IBM Plex Mono, SIL Open Font License (`resources/fonts/OFL-IBMPlexMono.txt`)
- Quiet Time icon from TimeStyle by Freakified, MIT License (`THIRD_PARTY.md`)
- Aircraft silhouettes are original drawings

## Support

Flight Radar is free and open source. If you want to support it:

Monero (XMR)
```
8C6RthZR9m7UJjEBSmbBPEDMyigok2Pte8hpBGtYZtCE2zrY1BRKgDy4DoC5Y7mrCQ2RPRei3pjRuBMeHGkBTzTLPW7AJGM
```

Bitcoin (BTC)
```
bc1pqac2n5rylc58gdx9envwjw4dy8xv49gwvwtc62ejkzh5w5cfcj2qv7trgz
```

Solana (SOL)
```
3Yqyu1q5rcZHt2R5sN6HjaSj9T7Bpjp1vougx992fbjx
```
