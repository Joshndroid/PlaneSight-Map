# PlaneSight Radar Map

HACS Dashboard plugin layout for the PlaneSight map card.

```yaml
type: custom:planesight-card-map
entity: sensor.planesight_aircraft_list
```

The map starts centered on Home Assistant's configured home location, then
recenters on the ADS-B receiver location if the PlaneSight sensor or receiver
feed provides one. Set `default_zoom` to override the initial zoom level.

The repository root must contain `planesight-map.js`, or the file must be under `dist/`.
