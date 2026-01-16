# Industrial Parks Injection Plan

## Goal

Split Reynosa-local tonnage (3.12B kg) across industrial parks by area (M²).

## Steps

1. **Render industrial parks** - thin black outlines
2. **Calculate M²** for each park
3. **Distribute 3.12B kg** proportionally by area
4. **Inject at park locations** (or connecting roads)

## Data Source

Industrial parks already loaded from KMZ:
- Layer: `industrialParks`
- Type: `industrial_park`
- Count: 39 polygons
- Source: `FeatureLayer27` in `FIELD_misc_export.kmz`

## Current Style (from KMZ_LAYERS_IMPLEMENTATION.md)

```javascript
industrialParks: {
  fill: 'rgba(215, 187, 158, 0.3)',
  stroke: 'rgba(255, 178, 115, 0.8)'
}
```

## Target Style

Thin black outlines only:
```javascript
industrialParks: {
  fill: 'transparent',
  stroke: 'rgba(0, 0, 0, 0.8)',
  lineWidth: 1
}
```

## Implementation

1. Check lots.json for industrialParks data
2. Update render style to thin black lines
3. Add area calculation (M²) per park
4. Create injection points at park centroids
5. Weight by area ratio
