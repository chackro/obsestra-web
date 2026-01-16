// ═══════════════════════════════════════════════════════════════════════════════
// LOTS LOADER
// Load polygon lots from lots.json and rasterize to field cells.
// Supports v2.0 schema with layers, geometry types (Polygon/LineString/Point).
// ═══════════════════════════════════════════════════════════════════════════════

import { RENDERER_TRANSFORM } from '../contracts/ReynosaOverlayBundle.js';

// Verbosity flag — set false for headless runs
let _verbose = true;
export function setLotsLoaderVerbose(v) { _verbose = v; }
function log(...args) { if (_verbose) console.log(...args); }

// Node.js file:// fetch polyfill
const isNode = typeof process !== 'undefined' && process.versions?.node;
let nodeFetch = null;
if (isNode) {
    const fs = await import('fs');
    const { fileURLToPath } = await import('url');
    nodeFetch = async (url) => {
        const filePath = url.startsWith('file://') ? fileURLToPath(url) : url;
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
            ok: true,
            json: async () => JSON.parse(content),
        };
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// COORDINATE TRANSFORMS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Convert lat/lon to world meters relative to PHARR origin.
 * @param {number} lat
 * @param {number} lon
 * @returns {{ x: number, y: number }}
 */
function latLonToWorld(lat, lon) {
    return {
        x: (lon - RENDERER_TRANSFORM.origin_lon) * RENDERER_TRANSFORM.meters_per_deg_lon,
        y: (lat - RENDERER_TRANSFORM.origin_lat) * RENDERER_TRANSFORM.meters_per_deg_lat,
    };
}

/**
 * Convert world meters to field cell coordinates.
 * @param {number} wx - world x
 * @param {number} wy - world y
 * @param {{ centerX: number, centerY: number, sizeM: number }} roi
 * @param {number} N - field resolution
 * @returns {{ fx: number, fy: number }}
 */
function worldToField(wx, wy, roi, N) {
    return {
        fx: ((wx - roi.centerX) / roi.sizeM + 0.5) * N,
        fy: ((wy - roi.centerY) / roi.sizeM + 0.5) * N,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// POLYGON RASTERIZATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Point-in-polygon test using ray casting.
 * @param {number} x
 * @param {number} y
 * @param {Array<{x: number, y: number}>} polygon - vertices
 * @returns {boolean}
 */
function pointInPolygon(x, y, polygon) {
    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;

        if (((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * Rasterize a polygon to cell indices.
 * @param {Array<{x: number, y: number}>} fieldPolygon - vertices in field coords
 * @param {number} N - field resolution
 * @returns {number[]} - array of cell indices
 */
function rasterizePolygon(fieldPolygon, N) {
    const cells = [];

    // Bounding box
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const p of fieldPolygon) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }

    // Clamp to field bounds
    minX = Math.max(0, Math.floor(minX));
    maxX = Math.min(N - 1, Math.ceil(maxX));
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(N - 1, Math.ceil(maxY));

    // Test each cell center
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (pointInPolygon(x + 0.5, y + 0.5, fieldPolygon)) {
                cells.push(y * N + x);
            }
        }
    }

    // Handle small polygons: ensure at least one cell
    if (cells.length === 0 && fieldPolygon.length > 0) {
        const cx = Math.floor((minX + maxX) / 2);
        const cy = Math.floor((minY + maxY) / 2);
        if (cx >= 0 && cx < N && cy >= 0 && cy < N) {
            cells.push(cy * N + cx);
        }
    }

    return cells;
}

/**
 * Rasterize a line (LineString) to cell indices using Bresenham's algorithm.
 * @param {Array<{x: number, y: number}>} fieldLine - vertices in field coords
 * @param {number} N - field resolution
 * @returns {number[]} - array of cell indices
 */
function rasterizeLine(fieldLine, N) {
    const cellSet = new Set();

    for (let i = 0; i < fieldLine.length - 1; i++) {
        const x0 = Math.floor(fieldLine[i].x);
        const y0 = Math.floor(fieldLine[i].y);
        const x1 = Math.floor(fieldLine[i + 1].x);
        const y1 = Math.floor(fieldLine[i + 1].y);

        // Bresenham's line algorithm
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        let sx = x0 < x1 ? 1 : -1;
        let sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;

        let x = x0, y = y0;
        while (true) {
            if (x >= 0 && x < N && y >= 0 && y < N) {
                cellSet.add(y * N + x);
            }
            if (x === x1 && y === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x += sx; }
            if (e2 < dx) { err += dx; y += sy; }
        }
    }

    return [...cellSet];
}

/**
 * Rasterize a point to a single cell index.
 * @param {{x: number, y: number}} fieldPoint - point in field coords
 * @param {number} N - field resolution
 * @returns {number[]} - array with single cell index (or empty if out of bounds)
 */
function rasterizePoint(fieldPoint, N) {
    const x = Math.floor(fieldPoint.x);
    const y = Math.floor(fieldPoint.y);
    if (x >= 0 && x < N && y >= 0 && y < N) {
        return [y * N + x];
    }
    return [];
}

// ───────────────────────────────────────────────────────────────────────────────
// MAIN LOADER
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Load lots from JSON and rasterize to field cells.
 * Supports v2.0 schema with layers and geometry types.
 *
 * @param {string} lotsJsonPath - path to lots.json (relative to page)
 * @param {{ centerX: number, centerY: number, sizeM: number }} roi
 * @param {number} N - field resolution
 * @returns {Promise<{
 *   lots: Array<{
 *     id: string,
 *     name: string,
 *     layer: string,
 *     type: string,
 *     cells: number[],
 *     polygons: Array<{ geometry: string, worldCoords: {x,y}[], fieldCoords: {x,y}[] }>
 *   }>,
 *   layers: Object,
 *   totalCells: number
 * }>}
 */
export async function loadLots(lotsJsonPath, roi, N) {
    const fetchFn = nodeFetch || fetch;
    const response = await fetchFn(lotsJsonPath);
    if (!response.ok) {
        throw new Error(`Failed to load lots.json: ${response.status}`);
    }

    const data = await response.json();
    const version = data.version || '1.0';
    const layers = data.layers || {};

    log(`[LOTS] Loaded ${data.lots.length} lots (v${version}) from ${lotsJsonPath}`);

    const results = [];
    let totalCells = 0;
    let outsideROI = 0;
    let tooSmall = 0;
    const statsByLayer = {};
    const statsByGeometry = { Polygon: 0, LineString: 0, Point: 0 };

    for (const lot of data.lots) {
        const layer = lot.layer || 'lots';
        const lotType = lot.type || null;

        // Skip if layer is disabled
        if (layers[layer]?.enabled === false) {
            continue;
        }

        // Skip if layer has allowedNames filter and lot name not in list
        const allowedNames = layers[layer]?.allowedNames;
        if (allowedNames && !allowedNames.includes(lot.name)) {
            continue;
        }

        const lotCells = [];
        const lotPolygons = [];

        for (const polygon of lot.polygons) {
            const geometry = polygon.geometry || 'Polygon';

            // Convert lat/lon -> world -> field
            const worldCoords = [];
            const fieldCoords = [];

            for (const coord of polygon.coordinates) {
                // Handle both [lat, lon] array and {lat, lon} object formats
                const lat = Array.isArray(coord) ? coord[0] : coord.lat;
                const lon = Array.isArray(coord) ? coord[1] : coord.lon;

                const world = latLonToWorld(lat, lon);
                const field = worldToField(world.x, world.y, roi, N);
                worldCoords.push({ x: world.x, y: world.y });
                fieldCoords.push({ x: field.fx, y: field.fy });
            }

            // Check if any point is within field bounds
            const inBounds = fieldCoords.some(p =>
                p.x >= 0 && p.x < N && p.y >= 0 && p.y < N
            );

            if (!inBounds) {
                outsideROI++;
                continue;
            }

            // Store geometry for rendering
            lotPolygons.push({ geometry, worldCoords, fieldCoords });

            // Skip rasterization for render-only layers (no physics)
            if (layers[layer]?.renderOnly) {
                continue;
            }

            // Rasterize based on geometry type
            let cells = [];
            if (geometry === 'Polygon') {
                cells = rasterizePolygon(fieldCoords, N);
            } else if (geometry === 'LineString') {
                cells = rasterizeLine(fieldCoords, N);
            } else if (geometry === 'Point') {
                cells = rasterizePoint(fieldCoords[0], N);
            }

            lotCells.push(...cells);
            statsByGeometry[geometry] = (statsByGeometry[geometry] || 0) + 1;
        }

        if (lotCells.length === 0 && lotPolygons.length > 0) {
            tooSmall++;
        }

        // Track stats by layer
        statsByLayer[layer] = (statsByLayer[layer] || 0) + 1;

        results.push({
            id: lot.id,
            name: lot.name,
            layer,
            type: lotType,
            style: layers[layer]?.style || null,
            cells: lotCells,
            polygons: lotPolygons,
        });

        totalCells += lotCells.length;
    }

    log(`[LOTS] Rasterized: ${totalCells} total cells`);
    log(`[LOTS] By layer:`, statsByLayer);
    log(`[LOTS] By geometry:`, statsByGeometry);
    if (outsideROI > 0) {
        log(`[LOTS] ${outsideROI} geometries outside ROI (skipped)`);
    }
    if (tooSmall > 0) {
        log(`[LOTS] ${tooSmall} lots with 0 cells (too small or outside)`);
    }

    return { lots: results, layers, totalCells };
}

/**
 * Stamp lot cells into regionMap.
 * @param {Array<{id: string, cells: number[]}>} lots
 * @param {Uint8Array} regionMap
 * @param {number} lotRegionId - Uint8 value for lot region
 * @returns {number} - total cells stamped
 */
export function stampLots(lots, regionMap, lotRegionId) {
    let count = 0;

    for (const lot of lots) {
        for (const idx of lot.cells) {
            regionMap[idx] = lotRegionId;
            count++;
        }
    }

    log(`[LOTS] Stamped ${count} cells with region ${lotRegionId}`);
    return count;
}

/**
 * Build sparse index of lot cells.
 * @param {Uint8Array} regionMap
 * @param {number} lotRegionId
 * @param {number} N2 - total cells (N*N)
 * @returns {number[]} - array of cell indices
 */
export function buildLotCellIndices(regionMap, lotRegionId, N2) {
    const indices = [];

    for (let i = 0; i < N2; i++) {
        if (regionMap[i] === lotRegionId) {
            indices.push(i);
        }
    }

    log(`[LOTS] Built lotCellIndices: ${indices.length} cells`);
    return indices;
}

/**
 * Calculate polygon area using Shoelace formula.
 * @param {Array<{x: number, y: number}>} polygon - vertices in world coords (meters)
 * @returns {number} - area in square meters
 */
export function calculatePolygonArea(polygon) {
    if (polygon.length < 3) return 0;

    let area = 0;
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += polygon[i].x * polygon[j].y;
        area -= polygon[j].x * polygon[i].y;
    }

    return Math.abs(area) / 2;
}

/**
 * Get industrial parks with their areas.
 * @param {Array} lots - loaded lots array
 * @returns {Array<{id: string, name: string, areaM2: number, centroid: {x: number, y: number}}>}
 */
export function getIndustrialParksWithArea(lots) {
    const parks = lots.filter(lot => lot.layer === 'industrialParks');

    return parks.map(park => {
        let totalArea = 0;
        let centroidX = 0;
        let centroidY = 0;
        let totalPoints = 0;

        for (const poly of park.polygons) {
            if (poly.geometry === 'Polygon' && poly.worldCoords.length >= 3) {
                totalArea += calculatePolygonArea(poly.worldCoords);

                // Compute centroid as average of vertices
                for (const pt of poly.worldCoords) {
                    centroidX += pt.x;
                    centroidY += pt.y;
                    totalPoints++;
                }
            }
        }

        if (totalPoints > 0) {
            centroidX /= totalPoints;
            centroidY /= totalPoints;
        }

        return {
            id: park.id,
            name: park.name,
            areaM2: totalArea,
            centroid: { x: centroidX, y: centroidY },
        };
    });
}

/**
 * Filter lots by layer name.
 * @param {Array} lots - loaded lots array
 * @param {string|string[]} layerNames - layer name(s) to include
 * @returns {Array} - filtered lots
 */
export function filterLotsByLayer(lots, layerNames) {
    const names = Array.isArray(layerNames) ? layerNames : [layerNames];
    return lots.filter(lot => names.includes(lot.layer));
}

/**
 * Get unique layer names from loaded lots.
 * @param {Array} lots - loaded lots array
 * @returns {string[]} - array of layer names
 */
export function getLayerNames(lots) {
    return [...new Set(lots.map(lot => lot.layer))];
}
