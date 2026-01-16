#!/usr/bin/env python3
"""
Build SIG.json from multiple KMZ sources:
- FIELD_misc_export.kmz: phases, industrialParks, urbanFootprint, electricity
- MERCADO_TRANSPORTE.kmz: lots (PATIOS folder)

Usage:
    python scripts/build_SIG_json.py
    python scripts/build_SIG_json.py --output test/SIG.json
"""

import argparse
import json
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
import math

# KML namespace
KML_NS = {'kml': 'http://www.opengis.net/kml/2.2'}

# Transform matching ReynosaOverlayBundle.js
PHARR_LAT = 26.06669701044433
PHARR_LON = -98.20517760083658
METERS_PER_DEG_LAT = 111320
METERS_PER_DEG_LON = METERS_PER_DEG_LAT * math.cos(PHARR_LAT * math.pi / 180)

# Layer styles
LAYER_STYLES = {
    'phases': {
        'enabled': True,
        'allowedNames': ['FASE 1', 'FASE 2'],
        'style': {'fill': 'rgba(255, 140, 0, 0.3)', 'stroke': None, 'strokeWidth': 0}
    },
    'electricity': {
        'enabled': False,
        'style': {'fill': 'rgba(255, 223, 127, 0.9)', 'stroke': 'rgba(0, 255, 85, 0.6)', 'strokeWidth': 2}
    },
    'urbanFootprint': {
        'enabled': False,
        'renderOnly': True,
        'style': {'fill': 'rgba(200, 200, 200, 0.08)', 'stroke': None, 'strokeWidth': 0}
    },
    'industrialParks': {
        'enabled': True,
        'style': {'fill': 'rgba(100, 100, 100, 0.15)', 'stroke': None, 'strokeWidth': 0}
    },
    'lots': {
        'enabled': True,
        'style': {'fill': 'rgba(255, 255, 255, 0.08)', 'stroke': 'rgba(255, 255, 255, 0.4)', 'strokeWidth': 1}
    }
}

# FIELD_misc_export.kmz layer mapping (Spanish folder names)
FIELD_LAYERS = {
    'Fases': {'layer': 'phases', 'type': 'inovus_phase'},
    'Parques industriales': {'layer': 'industrialParks', 'type': 'industrial_park'},
    'Mancha urbana': {'layer': 'urbanFootprint', 'type': 'urban'},
    'SE Eléctricas': {'layer': 'electricity', 'type': 'substation'},
    'Líneas de Distribución': {'layer': 'electricity', 'type': 'distribution_line'},
    'Líneas de Transmisión': {'layer': 'electricity', 'type': 'transmission_line'},
}


def extract_kml(kmz_path):
    """Extract doc.kml from KMZ file."""
    with zipfile.ZipFile(kmz_path, 'r') as z:
        return z.read('doc.kml')


def parse_coordinates(coords_text):
    """Parse KML coordinates string to list of [lat, lon]."""
    coords = []
    for coord in coords_text.strip().split():
        parts = coord.split(',')
        if len(parts) >= 2:
            lon, lat = float(parts[0]), float(parts[1])
            coords.append([lat, lon])
    return coords


def get_geometry_type(placemark):
    """Determine geometry type from placemark."""
    if placemark.find('.//kml:Polygon', KML_NS) is not None:
        return 'Polygon'
    elif placemark.find('.//kml:LineString', KML_NS) is not None:
        return 'LineString'
    elif placemark.find('.//kml:Point', KML_NS) is not None:
        return 'Point'
    return None


def extract_from_field_misc(kmz_path):
    """Extract features from FIELD_misc_export.kmz by folder ID."""
    if not Path(kmz_path).exists():
        print(f"[WARN] {kmz_path} not found, skipping")
        return []

    kml = extract_kml(kmz_path)
    root = ET.fromstring(kml)
    features = []

    for folder in root.iter('{http://www.opengis.net/kml/2.2}Folder'):
        name_el = folder.find('kml:name', KML_NS)
        if name_el is None:
            continue
        folder_name = name_el.text or ''

        # Check if this folder is configured
        config = FIELD_LAYERS.get(folder_name)
        if not config:
            continue

        layer = config['layer']
        feat_type = config['type']

        # Filter phases by allowed names
        allowed_names = LAYER_STYLES.get(layer, {}).get('allowedNames')

        for pm in folder.findall('kml:Placemark', KML_NS):
            pm_name_el = pm.find('kml:name', KML_NS)
            pm_name = pm_name_el.text if pm_name_el is not None else ''

            # Apply name filter for phases
            if allowed_names and not any(an in pm_name.upper() for an in [n.upper() for n in allowed_names]):
                continue

            # Get coordinates
            coords_el = pm.find('.//kml:coordinates', KML_NS)
            if coords_el is None:
                continue

            coords = parse_coordinates(coords_el.text)
            if len(coords) < 2:
                continue

            geom_type = get_geometry_type(pm)

            # Get comment/description
            desc_el = pm.find('kml:description', KML_NS)
            comment = desc_el.text if desc_el is not None else ''

            features.append({
                'name': pm_name,
                'comment': comment,
                'layer': layer,
                'type': feat_type,
                'coordinates': coords,
                'geometry': geom_type
            })

    print(f"[FIELD_misc] Extracted {len(features)} features")
    return features


def extract_from_mercado_transporte(kmz_path):
    """Extract PATIOS polygons from MERCADO_TRANSPORTE.kmz."""
    if not Path(kmz_path).exists():
        print(f"[WARN] {kmz_path} not found, skipping")
        return []

    kml = extract_kml(kmz_path)
    root = ET.fromstring(kml)
    features = []

    for pm in root.iter('{http://www.opengis.net/kml/2.2}Placemark'):
        pm_name_el = pm.find('kml:name', KML_NS)
        pm_name = pm_name_el.text if pm_name_el is not None else ''

        # Get polygon coordinates
        coords_el = pm.find('.//kml:Polygon//kml:coordinates', KML_NS)
        if coords_el is None:
            continue

        coords = parse_coordinates(coords_el.text)
        if len(coords) < 3:
            continue

        # Get comment/description
        desc_el = pm.find('kml:description', KML_NS)
        comment = desc_el.text if desc_el is not None else ''

        features.append({
            'name': pm_name,
            'comment': comment,
            'layer': 'lots',
            'type': 'yard',
            'coordinates': coords,
            'geometry': 'Polygon'
        })

    print(f"[MERCADO_TRANSPORTE] Extracted {len(features)} PATIOS polygons")
    return features


def build_sig_json(features):
    """Build SIG.json structure from features."""
    lots = []
    counters = {}

    for feat in features:
        layer = feat['layer']
        prefix = {'phases': 'phas', 'industrialParks': 'park', 'urbanFootprint': 'urbn',
                  'electricity': 'elec', 'lots': 'lot'}.get(layer, 'feat')

        counters[prefix] = counters.get(prefix, 0) + 1
        feat_id = f"{prefix}_{counters[prefix]:03d}"

        lots.append({
            'id': feat_id,
            'name': feat['name'],
            'comment': feat['comment'],
            'layer': layer,
            'type': feat['type'],
            'region_id': None,
            'polygons': [{
                'coordinates': feat['coordinates'],
                'geometry': feat['geometry']
            }],
            'priority': 0
        })

    return {
        'version': '2.0',
        'generated': datetime.now().strftime('%Y-%m-%d'),
        'source_kmz': 'FIELD_misc_export.kmz + MERCADO_TRANSPORTE.kmz',
        'transform': {
            'origin_lat': PHARR_LAT,
            'origin_lon': PHARR_LON,
            'meters_per_deg_lat': METERS_PER_DEG_LAT,
            'meters_per_deg_lon': METERS_PER_DEG_LON,
            'notes': 'PHARR POE is coordinate origin (0,0). Same as bundle transform.'
        },
        'layers': LAYER_STYLES,
        'lots': lots
    }


def main():
    parser = argparse.ArgumentParser(description='Build SIG.json from KMZ sources')
    parser.add_argument('--output', '-o', default='test/SIG.json', help='Output JSON file')
    parser.add_argument('--field-kmz', default='FIELD_misc_export.kmz',
                        help='Path to FIELD_misc_export.kmz')
    parser.add_argument('--mercado-kmz', default='MERCADO_TRANSPORTE.kmz',
                        help='Path to MERCADO_TRANSPORTE.kmz')
    args = parser.parse_args()

    # Get script directory for relative paths
    script_dir = Path(__file__).parent.parent

    field_path = script_dir / args.field_kmz
    mercado_path = script_dir / args.mercado_kmz
    output_path = script_dir / args.output

    print(f"[BUILD] FIELD_misc: {field_path}")
    print(f"[BUILD] MERCADO_TRANSPORTE: {mercado_path}")
    print(f"[BUILD] Output: {output_path}")

    # Extract from both KMZs
    features = []
    features.extend(extract_from_field_misc(field_path))
    features.extend(extract_from_mercado_transporte(mercado_path))

    # Build and write SIG.json
    sig = build_sig_json(features)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(sig, f, indent=2, ensure_ascii=False)

    # Summary
    layer_counts = {}
    for lot in sig['lots']:
        layer_counts[lot['layer']] = layer_counts.get(lot['layer'], 0) + 1

    print(f"\n[BUILD] Complete: {len(sig['lots'])} features")
    for layer, count in sorted(layer_counts.items()):
        print(f"  {layer}: {count}")


if __name__ == '__main__':
    main()
