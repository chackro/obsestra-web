// ═══════════════════════════════════════════════════════════════════════════════
// LOTS — Lot geometry rendering
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Canvas rendering for lot polygons with Path2D caching.
//

/**
 * Build cached Path2D objects for each lot layer.
 * Called once during initialization to avoid per-frame path construction.
 * @param {Array} loadedLots - Loaded lot data
 * @param {function} log - Logging function
 * @returns {Object|null} Cache object by layer name, or null if Path2D unavailable
 */
export function buildLotPaths(loadedLots, log) {
    // Skip in Node.js (no Path2D)
    if (typeof Path2D === 'undefined') return null;
    if (!loadedLots || loadedLots.length === 0) return null;

    const renderOrder = ['urbanFootprint', 'industrialParks', 'electricity', 'phases', 'parkWaiting', 'lots'];

    // Layer styles (same as drawLots)
    const layerStyles = {
        lots: { fill: null, stroke: true },
        parkWaiting: { fill: true, stroke: true }
        // Others use default (fill + stroke)
    };

    const lotPathsByLayer = {};
    let totalPolygons = 0;

    for (const layerName of renderOrder) {
        const layerLots = loadedLots.filter(lot => lot.layer === layerName);
        if (layerLots.length === 0) continue;

        const style = layerStyles[layerName] || { fill: true, stroke: true };
        const hasStroke = style.stroke !== false;
        const hasFill = style.fill !== false && style.fill !== null;

        // Build stroke path (batches all polygons)
        const strokePath = hasStroke ? new Path2D() : null;
        // Build individual fill paths (for overlapping polygons)
        const fillPaths = hasFill ? [] : null;

        for (const lot of layerLots) {
            for (const poly of (lot.polygons || [])) {
                if (!poly.worldCoords || poly.worldCoords.length < 2) continue;
                const geometry = poly.geometry || 'Polygon';

                // Build path in world coordinates
                const polyPath = new Path2D();
                polyPath.moveTo(poly.worldCoords[0].x, poly.worldCoords[0].y);
                for (let i = 1; i < poly.worldCoords.length; i++) {
                    polyPath.lineTo(poly.worldCoords[i].x, poly.worldCoords[i].y);
                }
                if (geometry === 'Polygon') {
                    polyPath.closePath();
                }

                // Add to stroke batch
                if (strokePath) {
                    strokePath.addPath(polyPath);
                }
                // Store individual path for fills
                if (fillPaths) {
                    fillPaths.push({ path: polyPath, geometry });
                }

                totalPolygons++;
            }
        }

        lotPathsByLayer[layerName] = {
            stroke: strokePath,
            fills: fillPaths,
            style: style
        };
    }

    log('[INIT] Lot Path2D cached:', totalPolygons, 'polygons across', Object.keys(lotPathsByLayer).length, 'layers');
    return lotPathsByLayer;
}

/**
 * @typedef {Object} LotsContext
 * @property {Object} lotPathsByLayer - Cached Path2D objects by layer
 * @property {Array} loadedLots - Loaded lot data (for debug logging)
 * @property {boolean} darkMode - Whether dark mode is enabled
 * @property {boolean} phasesAsLots - Whether phases are rendered as lots
 * @property {function} log - Logging function
 */

/**
 * Draw lot geometries with per-layer styles using cached Path2D.
 * Renders in z-order: urbanFootprint, industrialParks, electricity, phases, parkWaiting, lots.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with transform data
 * @param {LotsContext} lctx - Lots context
 */
export function drawLots(ctx, camera, lctx) {
    const { lotPathsByLayer, loadedLots, darkMode, phasesAsLots, log } = lctx;

    if (!lotPathsByLayer || !camera) return;

    // Render order (back to front)
    const renderOrder = ['urbanFootprint', 'industrialParks', 'electricity', 'phases', 'parkWaiting', 'lots'];

    // Default style fallback (dark mode aware)
    const defaultStyle = darkMode
        ? { fill: 'rgba(255, 255, 255, 0.08)', stroke: 'rgba(255, 255, 255, 0.4)', strokeWidth: 1 }
        : { fill: 'rgba(0, 0, 0, 0.06)', stroke: 'rgba(0, 0, 0, 0.3)', strokeWidth: 1 };

    // Layer-specific style overrides (dark mode aware)
    const layerStyles = {
        lots: {
            fill: null,  // No fill - just outlines
            stroke: darkMode ? 'rgba(153, 153, 153, 0.8)' : 'rgba(80, 80, 80, 0.6)',
            strokeWidth: 1
        },
        parkWaiting: {
            fill: 'rgba(204, 0, 204, 0.15)',  // Magenta tint (matches particle color)
            stroke: 'rgba(204, 0, 204, 0.6)',  // Magenta outline
            strokeWidth: 1.5
        },
        industrialParks: {
            fill: darkMode ? 'rgba(35, 35, 35, 1)' : 'rgba(200, 200, 200, 1)',
            stroke: null,
            strokeWidth: 1
        }
    };

    // Camera transform: world → screen
    const cx = camera.centerWorld.x;
    const cy = camera.centerWorld.y;
    const zoom = camera.zoom;
    const halfW = camera.canvasWidth * 0.5;
    const halfH = camera.canvasHeight * 0.5;

    ctx.save();

    // Clip to canvas bounds - helps browser optimize path clipping at high zoom
    ctx.beginPath();
    ctx.rect(0, 0, camera.canvasWidth, camera.canvasHeight);
    ctx.clip();

    // Apply camera transform (same as drawRoads)
    ctx.setTransform(zoom, 0, 0, -zoom, halfW - cx * zoom, halfH + cy * zoom);

    // DEBUG: log once per layer
    if (!drawLots._debugged) {
        drawLots._debugged = true;
        for (const ln of renderOrder) {
            const ll = loadedLots.filter(lot => lot.layer === ln);
            const polyCount = ll.reduce((sum, l) => sum + (l.polygons?.length || 0), 0);
            const wcCount = ll.reduce((sum, l) => sum + (l.polygons?.filter(p => p.worldCoords?.length > 0).length || 0), 0);
            log(`[LOTS RENDER v2] layer=${ln} lots=${ll.length} polygons=${polyCount} withWorldCoords=${wcCount}`);
        }
    }

    for (const layerName of renderOrder) {
        // Skip phases layer when Inovus is disabled
        if (layerName === 'phases' && !phasesAsLots) continue;

        const cached = lotPathsByLayer[layerName];
        if (!cached) continue;

        const style = layerStyles[layerName] || defaultStyle;

        // Draw fills (individual paths to handle overlaps)
        if (cached.fills && style.fill) {
            ctx.fillStyle = style.fill;
            for (const fillData of cached.fills) {
                ctx.fill(fillData.path);
            }
        }

        // Draw strokes (batched for performance)
        if (cached.stroke && style.stroke) {
            ctx.strokeStyle = style.stroke;
            // Line width in world units - convert to screen: 1px at any zoom
            ctx.lineWidth = 1 / zoom;
            ctx.stroke(cached.stroke);
        }
    }

    ctx.restore();
}

// Static debug flag
drawLots._debugged = false;

/**
 * Reset debug flag (call on init to re-enable logging)
 */
export function resetLotsDebug() {
    drawLots._debugged = false;
}
