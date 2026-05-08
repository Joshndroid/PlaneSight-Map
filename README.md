# PlaneSight Radar Map

HACS Dashboard plugin layout for the PlaneSight map card.

```yaml
type: custom:planesight-card-map
entity: sensor.planesight_aircraft_list
```

Optional generic aircraft-type photo fallbacks can be supplied when
PlaneSpotters has no photo for the exact aircraft registration. Keys are the
tar1090/ICAO type code from the `t` field.

```yaml
type: custom:planesight-card-map
entity: sensor.planesight_aircraft_list
generic_type_photos:
  BE58:
    reg: N758CA
    src: https://t.plnspttrs.net/36686/1904216_d9a8d43d8b_280.jpg
    link: https://www.planespotters.net/photo/1904216/n758ca-fenix-air-charter-beechcraft-58-baron?utm_source=api
    credit: Tran Nguyen An Binh
  B738: N872AN
```

If a type maps to a registration only, the card will ask PlaneSpotters for
that registration. If `src` is also supplied, that image can be shown
immediately while exact-photo lookup continues in the background. Helicopter
type photos with a configured `src` are treated as authoritative because reused
registrations and hex codes can otherwise return stale fixed-wing photos.

The map starts centered on Home Assistant's configured home location, then
recenters on the ADS-B receiver location if the PlaneSight sensor or receiver
feed provides one. Set `default_zoom` to override the initial zoom level.
Aircraft markers use different silhouettes for common type-code families such
as single-prop aircraft, twin-props, helicopters, jets, and larger airliners.

The repository root must contain `planesight-map.js`, or the file must be under `dist/`.
