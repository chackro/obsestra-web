// ═══════════════════════════════════════════════════════════════════════════════
// SPEED LIMITS — Speed zone visualization
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Canvas rendering for speed limit polylines.
//

// Speed limit colors by kph
export const SPEED_COLORS = {
    25: '#ff0000',   // Red - slow zone
    55: '#ffaa00',   // Orange - arterial
    60: '#ffff00',   // Yellow - default (won't be drawn, but for reference)
    80: '#aaff00',   // Yellow-green - fast arterial
    100: '#55ff00',  // Light green - fast road
    110: '#00ff00',  // Green - highway
};

/**
 * @typedef {Object} SpeedLimitContext
 * @property {string} overlayMode - Current overlay mode
 * @property {boolean} editMode - Whether edit mode is active
 * @property {Array} editData - Edit data when editing, null otherwise
 * @property {Array} polylineData - Original SPEED_LIMIT_POLYLINES data
 * @property {number} nodeRadius - Node radius for edit mode
 */

/**
 * Draw speed limit polylines as colored lines.
 * Color indicates speed: red=25, orange=55, green=110 kph.
 * When edit mode is active, draws draggable nodes at each vertex.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with worldToScreen and zoom
 * @param {SpeedLimitContext} sctx - Speed limit context
 */
export function drawSpeedLimitPolylines(ctx, camera, sctx) {
    const { overlayMode, editMode, editData, polylineData, nodeRadius } = sctx;

    if (overlayMode !== 'SPEED') return;

    // Use edit data if editing, otherwise use original
    const data = editMode && editData ? editData : polylineData;

    ctx.save();
    ctx.lineWidth = Math.max(3, camera.zoom * 8);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const zone of data) {
        const color = SPEED_COLORS[zone.speedKph] || '#ffffff';
        ctx.strokeStyle = color;

        for (const polyline of zone.polylines) {
            if (polyline.length < 2) continue;

            ctx.beginPath();
            const start = camera.worldToScreen(polyline[0][0], polyline[0][1]);
            ctx.moveTo(start.x, start.y);

            for (let i = 1; i < polyline.length; i++) {
                const pt = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();

            // Draw nodes when in edit mode
            if (editMode) {
                for (let i = 0; i < polyline.length; i++) {
                    const pt = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                    // Outer ring
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    // Inner dot
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                }
                ctx.lineWidth = Math.max(3, camera.zoom * 8);  // restore line width
            }
        }

        // Draw speed label at midpoint of first polyline
        if (zone.polylines.length > 0 && zone.polylines[0].length >= 2) {
            const pl = zone.polylines[0];
            const midIdx = Math.floor(pl.length / 2);
            const midPt = camera.worldToScreen(pl[midIdx][0], pl[midIdx][1]);

            ctx.fillStyle = color;
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${zone.speedKph} kph`, midPt.x, midPt.y - 15);
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px sans-serif';
            ctx.fillText(zone.name, midPt.x, midPt.y + 15);
        }
    }

    // Edit mode indicator
    if (editMode) {
        ctx.fillStyle = '#00ff00';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('SPEED EDIT: drag=move | dblclick=add | rightclick=delete | C=copy | TAB=exit', 10, 10);
    }

    ctx.restore();
}
