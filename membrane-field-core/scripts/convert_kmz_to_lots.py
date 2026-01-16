#!/usr/bin/env python3
"""
Convert KMZ file (Google Earth) to lots.json for field overlay.

Pipeline: KMZ → doc.kml → lots.json (lat/lon polygons + KMZ comments)

Supports multiple layer types from FIELD_misc_export.kmz:
- phases (FeatureLayer50): Inovus development phases
- industrialParks (FeatureLayer27): Maquila zones
- urbanFootprint (FeatureLayer58): City boundary
- electricity (FeatureLayer17/18/19): Substations and power lines

Usage:
    python convert_kmz_to_lots.py input.kmz --output lots.json
    python convert_kmz_to_lots.py input.kmz --list-layers
    python convert_kmz_to_lots.py input.kmz --layers phases,industrialParks
"""

import argparse
import json
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
import math
import re

# KML namespace
KML_NS = {'kml': 'http://www.opengis.net/kml/2.2'}

# Transform matching ReynosaOverlayBundle.js
PHARR_LAT = 26.06669701044433
PHARR_LON = -98.20517760083658
METERS_PER_DEG_LAT = 111320
METERS_PER_DEG_LON = METERS_PER_DEG_LAT * math.cos(PHARR_LAT * math.pi / 180)

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

LAYER_CONFIG = {
    'FeatureLayer50': {
        'layer': 'phases',
        'type': 'inovus_phase',
        'geometry': 'Polygon',
        'filter': lambda name: any(f'FASE {i}' in name.upper() for i in [1, 2]),
        'enabled': True,
    },
    'FeatureLayer27': {
        'layer': 'industrialParks',
        'type': 'industrial_park',
        'geometry': 'Polygon',
        'filter': None,
        'enabled': True,
    },
    'FeatureLayer58': {
        'layer': 'urbanFootprint',
        'type': 'urban',
        'geometry': 'Polygon',
        'filter': None,
        'enabled': True,
    },
    'FeatureLayer17': {
        'layer': 'electricity',
        'type': 'substation',
        'geometry': 'Point',
        'filter': None,
        'enabled': False,
    },
    'FeatureLayer18': {
        'layer': 'electricity',
        'type': 'distribution_line',
        'geometry': 'LineString',
        'filter': None,
        'enabled': False,
    },
    'FeatureLayer19': {
        'layer': 'electricity',
        'type': 'transmission_line',
        'geometry': 'LineString',
        'filter': None,
        'enabled': False,
    },
}

LAYER_STYLES = {
    'phases': {
        'fill': 'rgba(127, 223, 255, 0.3)',
        'stroke': 'rgba(127, 223, 255, 0.7)',
        'strokeWidth': 2
    },
    'industrialParks': {
        'fill': 'rgba(215, 187, 158, 0.25)',  # Slightly lighter
        'stroke': 'rgba(255, 178, 115, 0.7)',
        'strokeWidth': 1
    },
    'urbanFootprint': {
        'fill': 'rgba(100, 100, 100, 0.2)',  # Slightly darker
        'stroke': 'rgba(150, 150, 150, 0.4)',
        'strokeWidth': 0.5
    },
    'electricity': {
        'fill': 'rgba(255, 223, 127, 0.9)',
        'stroke': 'rgba(0, 255, 85, 0.6)',
        'strokeWidth': 2
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
# KMZ/KML EXTRACTION
# ═══════════════════════════════════════════════════════════════════════════════

def extract_kml_from_kmz(kmz_path):
    """Extract doc.kml from KMZ (which is just a ZIP file)."""
    with zipfile.ZipFile(kmz_path, 'r') as z:
        kml_files = [f for f in z.namelist() if f.endswith('.kml')]
        if not kml_files:
            raise ValueError("No KML file found in KMZ")

        kml_name = 'doc.kml' if 'doc.kml' in kml_files else kml_files[0]
        print(f"[KMZ] Extracting {kml_name}")
        return z.read(kml_name).decode('utf-8')


def get_text(element, path, ns):
    """Get text content from element, handling namespace."""
    el = element.find(path, ns)
    return el.text.strip() if el is not None and el.text else ""


# ═══════════════════════════════════════════════════════════════════════════════
# COORDINATE PARSING
# ═══════════════════════════════════════════════════════════════════════════════

def parse_coordinates(coord_string):
    """
    Parse KML coordinate string.
    KML format: lon,lat,alt lon,lat,alt ...
    Output: [[lat, lon], [lat, lon], ...]
    """
    coords = []
    for point in coord_string.strip().split():
        parts = point.split(',')
        if len(parts) >= 2:
            lon = float(parts[0])
            lat = float(parts[1])
            coords.append([lat, lon])
    return coords


def parse_polygon(placemark):
    """Extract Polygon geometry from a Placemark."""
    polygons = []
    for polygon in placemark.iter('{http://www.opengis.net/kml/2.2}Polygon'):
        outer = polygon.find('.//kml:outerBoundaryIs/kml:LinearRing/kml:coordinates', KML_NS)
        if outer is not None and outer.text:
            coords = parse_coordinates(outer.text)
            if len(coords) >= 3:
                polygons.append({'coordinates': coords, 'geometry': 'Polygon'})
    return polygons


def parse_linestring(placemark):
    """Extract LineString geometry from a Placemark."""
    lines = []
    for linestring in placemark.iter('{http://www.opengis.net/kml/2.2}LineString'):
        coords_el = linestring.find('kml:coordinates', KML_NS)
        if coords_el is not None and coords_el.text:
            coords = parse_coordinates(coords_el.text)
            if len(coords) >= 2:
                lines.append({'coordinates': coords, 'geometry': 'LineString'})
    return lines


def parse_point(placemark):
    """Extract Point geometry from a Placemark."""
    points = []
    for point in placemark.iter('{http://www.opengis.net/kml/2.2}Point'):
        coords_el = point.find('kml:coordinates', KML_NS)
        if coords_el is not None and coords_el.text:
            coords = parse_coordinates(coords_el.text)
            if coords:
                points.append({'coordinates': [coords[0]], 'geometry': 'Point'})
    return points


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER DISCOVERY
# ═══════════════════════════════════════════════════════════════════════════════

def list_layers(kml_content):
    """List all Folder elements with IDs in the KML."""
    root = ET.fromstring(kml_content)
    layers = []

    for folder in root.iter('{http://www.opengis.net/kml/2.2}Folder'):
        folder_id = folder.get('id', '')
        name = get_text(folder, 'kml:name', KML_NS)

        # Count placemarks and geometry types
        placemarks = list(folder.findall('kml:Placemark', KML_NS))
        polygons = sum(1 for pm in placemarks for _ in pm.iter('{http://www.opengis.net/kml/2.2}Polygon'))
        lines = sum(1 for pm in placemarks for _ in pm.iter('{http://www.opengis.net/kml/2.2}LineString'))
        points = sum(1 for pm in placemarks for _ in pm.iter('{http://www.opengis.net/kml/2.2}Point'))

        if folder_id or placemarks:
            layers.append({
                'id': folder_id,
                'name': name,
                'placemarks': len(placemarks),
                'polygons': polygons,
                'lines': lines,
                'points': points,
                'configured': folder_id in LAYER_CONFIG,
            })

    return layers


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER EXTRACTION
# ═══════════════════════════════════════════════════════════════════════════════

def extract_layer(root, folder_id, config):
    """Extract features from a specific folder by ID."""
    features = []
    geometry_type = config['geometry']
    name_filter = config.get('filter')

    # Find folder by ID
    folder = None
    for f in root.iter('{http://www.opengis.net/kml/2.2}Folder'):
        if f.get('id') == folder_id:
            folder = f
            break

    if folder is None:
        print(f"[WARN] Folder {folder_id} not found")
        return features

    # Extract placemarks
    for placemark in folder.findall('kml:Placemark', KML_NS):
        name = get_text(placemark, 'kml:name', KML_NS)
        description = get_text(placemark, 'kml:description', KML_NS)

        # Apply name filter if specified
        if name_filter and not name_filter(name):
            continue

        # Parse geometry based on expected type
        if geometry_type == 'Polygon':
            geometries = parse_polygon(placemark)
        elif geometry_type == 'LineString':
            geometries = parse_linestring(placemark)
        elif geometry_type == 'Point':
            geometries = parse_point(placemark)
        else:
            geometries = []

        if geometries:
            features.append({
                'name': name,
                'description': description,
                'polygons': geometries,  # Keep 'polygons' key for backward compat
                'layer': config['layer'],
                'type': config['type'],
            })

    return features


def parse_kml_by_layers(kml_content, layer_filter=None):
    """
    Parse KML and extract features by configured layers.
    Returns list of features with layer/type metadata.
    """
    root = ET.fromstring(kml_content)
    all_features = []

    for folder_id, config in LAYER_CONFIG.items():
        # Skip if layer filter specified and this layer not included
        if layer_filter and config['layer'] not in layer_filter:
            continue

        print(f"[KMZ] Extracting {folder_id} -> {config['layer']}/{config['type']}")
        features = extract_layer(root, folder_id, config)
        print(f"[KMZ]   Found {len(features)} features")
        all_features.extend(features)

    return all_features


def parse_kml_placemarks(kml_content):
    """
    Legacy: Parse KML and extract all Placemarks with Polygon geometry.
    Used when no layer config matches (fallback behavior).
    """
    root = ET.fromstring(kml_content)
    lots = []

    for placemark in root.iter('{http://www.opengis.net/kml/2.2}Placemark'):
        name = get_text(placemark, 'kml:name', KML_NS)
        description = get_text(placemark, 'kml:description', KML_NS)
        polygons = parse_polygon(placemark)

        if polygons:
            lots.append({
                'name': name,
                'description': description,
                'polygons': polygons
            })

    return lots


# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT BUILDING
# ═══════════════════════════════════════════════════════════════════════════════

def build_lots_json(raw_lots, source_kmz, layer_filter=None):
    """
    Build lots.json structure from raw parsed data.
    Includes layer metadata for v2 schema.
    """
    lots = []
    layer_counts = {}

    for i, raw in enumerate(raw_lots, start=1):
        layer = raw.get('layer', 'lots')
        lot_type = raw.get('type')

        # Generate ID with layer prefix
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        prefix = layer[:4] if layer else 'lot'
        lot_id = f"{prefix}_{layer_counts[layer]:03d}"

        lots.append({
            "id": lot_id,
            "name": raw['name'],
            "comment": raw.get('description', ''),
            "layer": layer,
            "type": lot_type,
            "region_id": None,
            "polygons": raw['polygons'],
            "region_params": None,
            "conversion_rule_ids": None,
            "priority": 0
        })

    # Build layer metadata
    layers_meta = {}
    for layer_name in set(lot.get('layer', 'lots') for lot in lots):
        layers_meta[layer_name] = {
            "enabled": LAYER_CONFIG.get(
                next((k for k, v in LAYER_CONFIG.items() if v['layer'] == layer_name), ''),
                {}
            ).get('enabled', True),
            "style": LAYER_STYLES.get(layer_name, {})
        }

    return {
        "version": "2.0",
        "generated": datetime.now().strftime("%Y-%m-%d"),
        "source_kmz": Path(source_kmz).name,

        "transform": {
            "origin_lat": PHARR_LAT,
            "origin_lon": PHARR_LON,
            "meters_per_deg_lat": METERS_PER_DEG_LAT,
            "meters_per_deg_lon": round(METERS_PER_DEG_LON, 2),
            "notes": "PHARR POE is coordinate origin (0,0). Same as bundle transform."
        },

        "layers": layers_meta,
        "lots": lots
    }


# ═══════════════════════════════════════════════════════════════════════════════
# STATISTICS
# ═══════════════════════════════════════════════════════════════════════════════

def compute_stats(lots_json):
    """Compute statistics about extracted lots."""
    lots = lots_json['lots']
    total_polygons = sum(len(lot['polygons']) for lot in lots)

    # Count by layer
    by_layer = {}
    for lot in lots:
        layer = lot.get('layer', 'lots')
        by_layer[layer] = by_layer.get(layer, 0) + 1

    # Count by geometry type
    by_geometry = {'Polygon': 0, 'LineString': 0, 'Point': 0}
    for lot in lots:
        for poly in lot['polygons']:
            geom = poly.get('geometry', 'Polygon')
            by_geometry[geom] = by_geometry.get(geom, 0) + 1

    # Compute bounding box
    all_lats = []
    all_lons = []
    for lot in lots:
        for poly in lot['polygons']:
            for coord in poly['coordinates']:
                if isinstance(coord, list) and len(coord) >= 2:
                    all_lats.append(coord[0])
                    all_lons.append(coord[1])

    if all_lats:
        lat_range = (min(all_lats), max(all_lats))
        lon_range = (min(all_lons), max(all_lons))
        y_range = ((lat_range[0] - PHARR_LAT) * METERS_PER_DEG_LAT,
                   (lat_range[1] - PHARR_LAT) * METERS_PER_DEG_LAT)
        x_range = ((lon_range[0] - PHARR_LON) * METERS_PER_DEG_LON,
                   (lon_range[1] - PHARR_LON) * METERS_PER_DEG_LON)
    else:
        lat_range = lon_range = y_range = x_range = (0, 0)

    return {
        'num_lots': len(lots),
        'num_polygons': total_polygons,
        'by_layer': by_layer,
        'by_geometry': by_geometry,
        'lat_range': lat_range,
        'lon_range': lon_range,
        'y_range_m': y_range,
        'x_range_m': x_range
    }


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description='Convert KMZ to lots.json with multi-layer support'
    )
    parser.add_argument('input', help='Input KMZ file')
    parser.add_argument('--output', '-o', default='lots.json', help='Output JSON file')
    parser.add_argument('--list-layers', action='store_true',
                        help='List available layers in KMZ and exit')
    parser.add_argument('--layers', '-l', type=str, default=None,
                        help='Comma-separated list of layers to extract (e.g., phases,industrialParks)')
    parser.add_argument('--legacy', action='store_true',
                        help='Use legacy mode: extract all polygons without layer filtering')
    args = parser.parse_args()

    print(f"[KMZ] Reading {args.input}")
    kml_content = extract_kml_from_kmz(args.input)

    # List layers mode
    if args.list_layers:
        print("\n[KMZ] Available layers:")
        layers = list_layers(kml_content)
        for layer in layers:
            configured = "*" if layer['configured'] else " "
            print(f"  [{configured}] {layer['id']:20} {layer['name'][:30]:30} "
                  f"pm={layer['placemarks']:3} poly={layer['polygons']:3} "
                  f"line={layer['lines']:3} pt={layer['points']:3}")
        print("\n[*] = configured in LAYER_CONFIG")
        return

    # Parse layer filter
    layer_filter = None
    if args.layers:
        layer_filter = [l.strip() for l in args.layers.split(',')]
        print(f"[KMZ] Filtering to layers: {layer_filter}")

    # Extract features
    if args.legacy:
        print("[KMZ] Legacy mode: extracting all polygons")
        raw_lots = parse_kml_placemarks(kml_content)
    else:
        print("[KMZ] Multi-layer mode: extracting by folder ID")
        raw_lots = parse_kml_by_layers(kml_content, layer_filter)

    print(f"[KMZ] Found {len(raw_lots)} total features")

    lots_json = build_lots_json(raw_lots, args.input, layer_filter)

    # Stats
    stats = compute_stats(lots_json)
    print(f"\n[STATS] Features: {stats['num_lots']}, Geometries: {stats['num_polygons']}")
    print(f"[STATS] By layer: {stats['by_layer']}")
    print(f"[STATS] By geometry: {stats['by_geometry']}")
    print(f"[STATS] Lat range: {stats['lat_range'][0]:.6f} to {stats['lat_range'][1]:.6f}")
    print(f"[STATS] Lon range: {stats['lon_range'][0]:.6f} to {stats['lon_range'][1]:.6f}")
    print(f"[STATS] Y range (m from PHARR): {stats['y_range_m'][0]:.0f} to {stats['y_range_m'][1]:.0f}")
    print(f"[STATS] X range (m from PHARR): {stats['x_range_m'][0]:.0f} to {stats['x_range_m'][1]:.0f}")

    # Write output
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(lots_json, f, indent=2, ensure_ascii=False)

    print(f"\n[KMZ] Written {args.output}")


if __name__ == '__main__':
    main()
