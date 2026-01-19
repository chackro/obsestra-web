// ═══════════════════════════════════════════════════════════════════════════════
// ROADS — Road geometry rendering
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Canvas rendering for road segments with Path2D caching.
//

/**
 * Build cached Path2D for road segments.
 * Filters segments to those within 100km of ROI center.
 * @param {Object} geometry - Geometry object with roadSegments
 * @param {Object} roi - Region of interest { centerX, centerY }
 * @returns {Path2D|null} Cached road path, or null if Path2D unavailable
 */
export function buildRoadPath(geometry, roi) {
    // Skip in Node.js (no Path2D)
    if (typeof Path2D === 'undefined') return null;

    const segments = geometry?.roadSegments;
    if (!segments) return null;

    // Filter to segments that pass within 100km of ROI center
    const cx = roi.centerX;
    const cy = roi.centerY;
    const maxDist = 100000;  // 100km

    const roadPath = new Path2D();
    let segCount = 0;
    for (const seg of segments) {
        if (!seg.points || seg.points.length < 2) continue;
        // Check if ANY point is within range
        let inRange = false;
        for (const p of seg.points) {
            if (Math.abs(p.x - cx) <= maxDist && Math.abs(p.y - cy) <= maxDist) {
                inRange = true;
                break;
            }
        }
        if (!inRange) continue;

        segCount++;
        roadPath.moveTo(seg.points[0].x, seg.points[0].y);
        for (let i = 1; i < seg.points.length; i++) {
            roadPath.lineTo(seg.points[i].x, seg.points[i].y);
        }
    }

    return roadPath;
}

/**
 * Add city segments to an existing road path.
 * @param {Path2D} roadPath - Existing road path to append to
 * @param {Array} citySegments - City segment data
 * @param {Object} roi - Region of interest { centerX, centerY }
 * @returns {Path2D} Updated road path
 */
export function addCitySegmentsToPath(roadPath, citySegments, roi) {
    if (!roadPath) roadPath = new Path2D();

    const cx = roi.centerX;
    const cy = roi.centerY;
    const maxDist = 100000;  // 100km

    for (const seg of citySegments) {
        if (!seg.points || seg.points.length < 2) continue;
        // Check if ANY point is within range
        let inRange = false;
        for (const p of seg.points) {
            if (Math.abs(p.x - cx) <= maxDist && Math.abs(p.y - cy) <= maxDist) {
                inRange = true;
                break;
            }
        }
        if (!inRange) continue;

        roadPath.moveTo(seg.points[0].x, seg.points[0].y);
        for (let i = 1; i < seg.points.length; i++) {
            roadPath.lineTo(seg.points[i].x, seg.points[i].y);
        }
    }

    return roadPath;
}

/**
 * @typedef {Object} RoadsContext
 * @property {Path2D} roadPath - Cached road path
 * @property {Path2D} twinSpanPath - Twin span bridge/approach path
 * @property {number} twinSpanAlpha - Twin span visibility (0-1)
 * @property {boolean} darkMode - Whether dark mode is enabled
 */

/**
 * Draw roads using cached Path2D.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with transform data
 * @param {RoadsContext} rctx - Roads context
 */
export function drawRoads(ctx, camera, rctx) {
    const { roadPath, twinSpanPath, twinSpanAlpha, darkMode } = rctx;

    if (!roadPath) return;

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

    // Apply camera transform: world → screen
    ctx.setTransform(zoom, 0, 0, -zoom, halfW - cx * zoom, halfH + cy * zoom);

    // Dark mode: subtle gray so particles stand out. Light mode: darker gray.
    ctx.strokeStyle = darkMode ? 'rgb(70, 70, 70)' : 'rgb(140, 140, 140)';
    ctx.lineWidth = 24;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.stroke(roadPath);

    // Draw twin span if active
    if (twinSpanPath && twinSpanAlpha > 0.01) {
        ctx.globalAlpha = twinSpanAlpha;
        ctx.strokeStyle = darkMode ? 'rgb(70, 70, 70)' : 'rgb(140, 140, 140)';
        ctx.stroke(twinSpanPath);
        ctx.globalAlpha = 1;
    }

    ctx.restore();
}
