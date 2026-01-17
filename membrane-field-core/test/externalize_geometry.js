#!/usr/bin/env node
/**
 * Externalize geometry from bundles to reduce memory usage.
 *
 * Before: 3 bundles × 83 MB = 246 MB (geometry duplicated 3x)
 * After:  1 geometry.json (47 MB) + 3 bundles × 36 MB = 155 MB
 *
 * Run: node externalize_geometry.js
 */

const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

const BUNDLE_FILES = [
    'bundle_baseline.json',
    'bundle_baseline_LAYER_A.json',
    'interserrana_bundle.json',
];

const GEOMETRY_FILE = 'geometry.json';

function main() {
    console.log('=== Externalize Geometry ===\n');

    // Step 1: Extract geometry from baseline (they're all identical)
    const baselinePath = path.join(TEST_DIR, BUNDLE_FILES[0]);
    console.log(`Reading geometry from: ${BUNDLE_FILES[0]}`);

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const geometry = baseline.geometry;

    if (!geometry) {
        console.error('ERROR: No geometry found in baseline bundle');
        process.exit(1);
    }

    // Step 2: Write geometry to separate file
    const geometryPath = path.join(TEST_DIR, GEOMETRY_FILE);
    const geometryJson = JSON.stringify(geometry);
    fs.writeFileSync(geometryPath, geometryJson);
    console.log(`Wrote: ${GEOMETRY_FILE} (${(geometryJson.length / 1e6).toFixed(2)} MB)\n`);

    // Step 3: Strip geometry from all bundles
    for (const bundleFile of BUNDLE_FILES) {
        const bundlePath = path.join(TEST_DIR, bundleFile);

        console.log(`Processing: ${bundleFile}`);
        const beforeSize = fs.statSync(bundlePath).size;

        const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

        // Remove geometry, keep a reference marker
        delete bundle.geometry;
        bundle._geometryExternal = true;

        const newJson = JSON.stringify(bundle);
        fs.writeFileSync(bundlePath, newJson);

        const afterSize = newJson.length;
        const reduction = ((1 - afterSize / beforeSize) * 100).toFixed(0);
        console.log(`  ${(beforeSize / 1e6).toFixed(2)} MB -> ${(afterSize / 1e6).toFixed(2)} MB (${reduction}% reduction)\n`);
    }

    console.log('=== Done ===');
    console.log('\nNext: Update testBundle.html to load geometry.json separately');
    console.log('See the loader code that needs to be added.');
}

main();
