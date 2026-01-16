#!/usr/bin/env python3
"""Compact JSON bundles for GitHub (<100MB limit)"""
import json
import sys

def round_coords(coords, decimals=4):
    """Round coordinate arrays to N decimals"""
    if isinstance(coords, list):
        if len(coords) == 2 and all(isinstance(x, (int, float)) for x in coords):
            return [round(coords[0], decimals), round(coords[1], decimals)]
        return [round_coords(c, decimals) for c in coords]
    return coords

def round_nested(obj):
    """Round float values to integers"""
    if isinstance(obj, dict):
        return {k: round_nested(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [round_nested(v) for v in obj]
    elif isinstance(obj, float):
        return round(obj)
    return obj

def compact_bundle(path):
    print(f"Processing: {path}")

    with open(path, 'r') as f:
        data = json.load(f)

    original_size = len(json.dumps(data, indent=2))

    # Round coordinates in geometry
    if 'geometry' in data:
        geom = data['geometry']
        if 'segments_in_roi' in geom:
            for seg in geom['segments_in_roi']:
                if 'geometry_coordinates' in seg:
                    seg['geometry_coordinates'] = round_coords(seg['geometry_coordinates'], 4)
        if 'pharr_coords' in geom:
            geom['pharr_coords'] = {k: round(v, 4) for k, v in geom['pharr_coords'].items()}

    # Round flow values (kg doesn't need decimals)
    for section in ['segment_load_kg_by_destination_hs2', 'segment_load_kg_by_poe_hs2', 'flow_kg_by_poe', 'inflow', 'capacity']:
        if section in data:
            data[section] = round_nested(data[section])

    # Write compact (no whitespace)
    with open(path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))

    new_size = len(json.dumps(data, separators=(',', ':')))
    print(f"  {original_size/1_000_000:.1f} MB -> {new_size/1_000_000:.1f} MB ({100*(1-new_size/original_size):.0f}% reduction)")

if __name__ == '__main__':
    files = [
        r'C:\Users\pablo\projects\obsestra-web\membrane-field-core\test\bundle_baseline.json',
        r'C:\Users\pablo\projects\obsestra-web\membrane-field-core\test\bundle_baseline_LAYER_A.json',
        r'C:\Users\pablo\projects\obsestra-web\membrane-field-core\test\interserrana_bundle.json',
    ]
    for f in files:
        compact_bundle(f)
    print("Done!")
