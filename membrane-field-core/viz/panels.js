// ═══════════════════════════════════════════════════════════════════════════════
// PANELS — UI overlay rendering
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Canvas rendering functions for HUD panels and overlays.
//

/**
 * @typedef {Object} MetricsPanelContext
 * @property {number} simTime - Current simulation time (seconds)
 * @property {Object} metrics - Metrics object { injected, exited, ... }
 * @property {number} inRateKtMin - IN rate (kt/min)
 * @property {number} outRateKtMin - OUT rate (kt/min)
 * @property {Object} hudCache - { roadMass, peakCell, lotMassTotal, lotsOccupied, maxUtil }
 * @property {boolean} darkMode - Whether dark mode is enabled
 * @property {number} sinkCapKgPerHour - Sink capacity (0 = bridge closed)
 */

/**
 * Draw metrics panel - top-left HUD showing sim clock and status.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {MetricsPanelContext} pctx - Panel context
 */
export function drawMetricsPanel(ctx, pctx) {
    const { simTime, hudCache, darkMode, sinkCapKgPerHour } = pctx;
    const { roadMass, lotMassTotal } = hudCache;

    // Format sim time as HH:MM
    const hours = Math.floor(simTime / 3600) % 24;
    const minutes = Math.floor((simTime % 3600) / 60);
    const simTimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    // SIM CLOCK — Top-right corner, 5x size (80px)
    ctx.save();
    ctx.font = "700 80px 'IBM Plex Mono', monospace";
    ctx.textAlign = 'right';
    ctx.fillStyle = darkMode ? '#ddd' : '#000';
    ctx.fillText(simTimeStr, ctx.canvas.width - 30, 80);

    // STATUS NOTES — Below clock, Spanish
    ctx.font = "600 18px 'IBM Plex Mono', monospace";
    ctx.fillStyle = darkMode ? '#ddd' : '#000';
    let statusY = 110;
    const statusX = ctx.canvas.width - 30;

    // Bridge closed indicator
    if (sinkCapKgPerHour === 0) {
        ctx.fillText('Puente cerrado', statusX, statusY);
        statusY += 24;
    }

    // Shift change indicator (during peak hours: 4-8, 12-16, 20-24)
    const h = hours;
    const isShiftChange = (h >= 4 && h < 8) || (h >= 12 && h < 16) || (h >= 20 && h < 24);
    if (isShiftChange) {
        ctx.fillText('Cambio de turno', statusX, statusY);
    }

    ctx.restore();
}

/**
 * @typedef {Object} StallLegendContext
 * @property {number} N2 - Grid size squared
 * @property {Array<Array>} cellParticles - Particles per cell
 * @property {Uint8Array} regionMap - Region type per cell
 * @property {Object} REGION - Region type enum
 * @property {Float64Array} cellMass - Mass per cell (kg)
 * @property {number} RHO_CONGESTION_0 - Congestion onset threshold
 * @property {function} isInQueueZone - Queue zone check function
 * @property {boolean} darkMode - Whether dark mode is enabled
 */

/**
 * Draw stall mode legend (when M key cycles to STALL mode).
 * Shows counts of particles by stall reason.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {StallLegendContext} sctx - Stall legend context
 */
export function drawStallModeLegend(ctx, sctx) {
    const { N2, cellParticles, regionMap, REGION, cellMass, RHO_CONGESTION_0, isInQueueZone, darkMode } = sctx;

    // Count particles by state
    let inQueue = 0;      // In SINK region OR in queue zone (bridge approach)
    let deadEnd = 0;      // stallReason === 'dead_end'
    let lotFull = 0;      // stallReason === 'lot_full'
    let roadFull = 0;     // stallReason === 'road_full'
    let preLotHold = 0;   // stallReason === 'pre_lot_hold'
    let congested = 0;    // On road with mass > RHO_CONGESTION_0
    let moving = 0;       // Normal flow

    for (let i = 0; i < N2; i++) {
        for (const p of cellParticles[i]) {
            if (regionMap[p.cellIdx] === REGION.SINK) {
                inQueue++;
            } else if (p.renderStalled && isInQueueZone(p.x, p.y)) {
                // Stalled in queue zone = bridge queue, not road congestion
                inQueue++;
            } else if (p.stallReason === 'dead_end') {
                deadEnd++;
            } else if (p.stallReason === 'lot_full') {
                lotFull++;
            } else if (p.stallReason === 'road_full') {
                roadFull++;
            } else if (p.stallReason === 'pre_lot_hold') {
                preLotHold++;
            } else if (regionMap[p.cellIdx] === REGION.ROAD && cellMass[p.cellIdx] > RHO_CONGESTION_0) {
                congested++;
            } else {
                moving++;
            }
        }
    }

    const lineH = 20;
    const boxSize = 12;
    const x = ctx.canvas.width - 30;
    let y = 160;

    ctx.save();
    ctx.textAlign = 'right';

    ctx.font = "700 14px 'IBM Plex Mono', monospace";
    ctx.fillStyle = darkMode ? '#fff' : '#000';
    ctx.fillText('STALL MODE', x, y);
    y += lineH + 4;

    const legend = [
        { color: '#0080ff', label: 'queue', count: inQueue },
        { color: '#ff0000', label: 'dead_end', count: deadEnd },
        { color: '#ff00ff', label: 'lot_full', count: lotFull },
        { color: '#ff8000', label: 'road_full', count: roadFull },
        { color: '#00ffff', label: 'pre_lot_hold', count: preLotHold },
        { color: '#ffff00', label: 'congested', count: congested },
        { color: '#00ff00', label: 'moving', count: moving },
    ];

    ctx.font = "400 13px 'IBM Plex Mono', monospace";
    for (const item of legend) {
        // Draw color box
        ctx.fillStyle = item.color;
        ctx.fillRect(x - boxSize, y - boxSize + 3, boxSize, boxSize);
        // Draw label and count
        ctx.fillStyle = darkMode ? '#fff' : '#000';
        ctx.fillText(`${item.label}: ${item.count}`, x - boxSize - 8, y);
        y += lineH;
    }

    ctx.restore();
}
