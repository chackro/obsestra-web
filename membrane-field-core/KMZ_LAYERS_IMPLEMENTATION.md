# KMZ Multi-Layer Implementation

## Overview

Extended the lots pipeline to support multiple layer types from `FIELD_misc_export.kmz`, including phases, industrial parks, urban footprint, and electrical infrastructure.

## Pipeline

```
FIELD_misc_export.kmz
    ↓ scripts/convert_kmz_to_lots.py
overlay/lots.json (v2.0 schema)
    ↓ overlay/lotsLoader.js
Physics (rasterized cells) + Rendering (polygon/line/point vertices)
    ↓ overlay/reynosaOverlay.js
Canvas rendering with per-layer styles
```

## Files Modified

| File | Changes |
|------|---------|
| `scripts/convert_kmz_to_lots.py` | Multi-layer extraction, geometry types, CLI args |
| `overlay/lotsLoader.js` | v2.0 schema support, LineString/Point rasterization |
| `overlay/reynosaOverlay.js` | Per-layer styles, z-ordered rendering |
| `overlay/lots.json` | Generated output (214 features) |

---

## Layer Configuration

### Extracted Layers

| Folder ID | Layer | Type | Geometry | Count |
|-----------|-------|------|----------|-------|
| FeatureLayer50 | phases | inovus_phase | Polygon | 10 |
| FeatureLayer27 | industrialParks | industrial_park | Polygon | 39 |
| FeatureLayer58 | urbanFootprint | urban | Polygon | 57 |
| FeatureLayer17 | electricity | substation | Point | 28 |
| FeatureLayer18 | electricity | distribution_line | LineString | 30 |
| FeatureLayer19 | electricity | transmission_line | LineString | 50 |

### Layer Styles

```javascript
phases:          { fill: 'rgba(127, 223, 255, 0.3)', stroke: 'rgba(127, 223, 255, 0.7)' }
industrialParks: { fill: 'rgba(215, 187, 158, 0.3)', stroke: 'rgba(255, 178, 115, 0.8)' }
urbanFootprint:  { fill: 'rgba(100, 100, 100, 0.15)', stroke: 'rgba(150, 150, 150, 0.3)' }
electricity:     { fill: 'rgba(255, 223, 127, 0.9)', stroke: 'rgba(0, 255, 85, 0.6)' }
```

### Default Enabled State

- **Enabled:** phases, industrialParks, urbanFootprint
- **Disabled:** electricity (substations, distribution, transmission)

---

## lots.json Schema (v2.0)

```json
{
  "version": "2.0",
  "generated": "2025-12-19",
  "source_kmz": "FIELD_misc_export.kmz",

  "transform": {
    "origin_lat": 26.06669701044433,
    "origin_lon": -98.20517760083658,
    "meters_per_deg_lat": 111320,
    "meters_per_deg_lon": 99996.88
  },

  "layers": {
    "phases": { "enabled": true, "style": {...} },
    "industrialParks": { "enabled": true, "style": {...} },
    "urbanFootprint": { "enabled": true, "style": {...} },
    "electricity": { "enabled": false, "style": {...} }
  },

  "lots": [
    {
      "id": "phas_001",
      "name": "FASE 1",
      "comment": "...",
      "layer": "phases",
      "type": "inovus_phase",
      "region_id": null,
      "polygons": [
        {
          "coordinates": [[lat, lon], ...],
          "geometry": "Polygon"
        }
      ],
      "priority": 0
    }
  ]
}
```

---

## CLI Usage

```bash
# List available layers in KMZ
python scripts/convert_kmz_to_lots.py FIELD_misc_export.kmz --list-layers

# Extract all configured layers
python scripts/convert_kmz_to_lots.py FIELD_misc_export.kmz -o overlay/lots.json

# Extract specific layers only
python scripts/convert_kmz_to_lots.py FIELD_misc_export.kmz --layers phases,industrialParks

# Legacy mode (all polygons, no layer filtering)
python scripts/convert_kmz_to_lots.py FIELD_misc_export.kmz --legacy
```

### Example Output

```
[KMZ] Reading FIELD_misc_export.kmz
[KMZ] Extracting doc.kml
[KMZ] Multi-layer mode: extracting by folder ID
[KMZ] Extracting FeatureLayer50 -> phases/inovus_phase
[KMZ]   Found 10 features
[KMZ] Extracting FeatureLayer27 -> industrialParks/industrial_park
[KMZ]   Found 39 features
[KMZ] Extracting FeatureLayer58 -> urbanFootprint/urban
[KMZ]   Found 57 features
[KMZ] Extracting FeatureLayer17 -> electricity/substation
[KMZ]   Found 28 features
[KMZ] Extracting FeatureLayer18 -> electricity/distribution_line
[KMZ]   Found 30 features
[KMZ] Extracting FeatureLayer19 -> electricity/transmission_line
[KMZ]   Found 50 features
[KMZ] Found 214 total features

[STATS] Features: 214, Geometries: 229
[STATS] By layer: {'phases': 10, 'industrialParks': 39, 'urbanFootprint': 57, 'electricity': 108}
[STATS] By geometry: {'Polygon': 121, 'LineString': 80, 'Point': 28}
```

---

## Geometry Rasterization

### Polygon (existing)
Point-in-polygon test using ray casting. Small polygons get at least 1 cell.

### LineString (new)
Bresenham's line algorithm connecting vertices. Returns unique cell indices.

### Point (new)
Single cell at floor(x), floor(y) coordinates.

---

## Rendering

### Z-Order (back to front)
1. urbanFootprint (gray background)
2. industrialParks (tan maquila zones)
3. electricity (green lines, yellow dots)
4. phases (cyan Inovus parcels)
5. lots (fallback layer)

### Geometry Rendering
- **Polygon:** fill + stroke, closePath
- **LineString:** stroke only, no closePath
- **Point:** arc with fill + stroke

---

## Backward Compatibility

- Old v1.0 lots.json files work unchanged
- Missing `layer` field defaults to `'lots'`
- Missing `geometry` field defaults to `'Polygon'`
- Missing `layers` metadata uses default styles

---

## Future Work

- [ ] Add layer visibility toggles to debug menu
- [ ] Per-layer physics parameters (different K values by layer type)
- [ ] Region type mapping (phases → conversion zones, urban → reduced conductance)
