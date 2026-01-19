// ═══════════════════════════════════════════════════════════════════════════════
// HEATMAP — Congestion visualization rendering
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Canvas rendering functions for congestion heatmaps.
//

/**
 * @typedef {Object} HeatmapContext
 * @property {number} N - Grid dimension
 * @property {Object} roi - Region of interest { cellSize }
 * @property {Float64Array} cellMass - Mass per cell (kg)
 * @property {Uint8Array} regionMap - Region type per cell
 * @property {Object} REGION - Region type enum
 * @property {number} RHO_CONGESTION_0 - Congestion onset threshold
 * @property {number} ROAD_CELL_CAP_KG - Road cell capacity
 * @property {number} COMMUTER_EQUIV_KG - Commuter equivalent mass
 * @property {Float32Array} commuterLoad - Commuter friction per cell
 * @property {Array<number>} roadCellIndices - Road cell indices
 * @property {function} fieldToWorldX - Field to world X transform
 * @property {function} fieldToWorldY - Field to world Y transform
 * @property {function} congestionFactor - Congestion factor computation
 * @property {function} log - Logging function
 */

// Frame counter for debug logging
let _congestionDebugFrame = 0;

/**
 * Draw congestion heatmap - cyan cells where congestion slows particles.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with zoom and viewportWorld
 * @param {HeatmapContext} hctx - Heatmap context
 * @param {boolean} enabled - Whether heatmap is enabled
 */
export function drawCongestionHeatmap(ctx, camera, hctx, enabled) {
    if (!enabled) return;

    const { N, roi, cellMass, regionMap, REGION, fieldToWorldX, fieldToWorldY, congestionFactor, log } = hctx;

    const cellScreenSize = roi.cellSize * camera.zoom;

    // Debug every 60 frames
    const debug = (++_congestionDebugFrame % 60 === 1);
    if (debug) {
        log(`[CONG] cellScreenSize=${cellScreenSize.toFixed(1)}, N=${N}, roi.cellSize=${roi.cellSize}`);
    }

    // Only draw if cells are visible (not too zoomed out)
    if (cellScreenSize < 2) {
        if (debug) log('[CONG] Skipping - cells too small');
        return;
    }

    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    let cellsWithMass = 0;
    let cellsDrawn = 0;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            const rho = cellMass[idx];
            if (rho <= 0) continue;
            cellsWithMass++;

            // Skip lot cells (they don't experience congestion)
            if (regionMap[idx] === REGION.LOT) continue;

            const c = congestionFactor(rho);

            const wx = fieldToWorldX(x);
            const wy = fieldToWorldY(y);

            // Viewport culling
            if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
            if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

            // Intensity: all cells visible, congestion = brighter
            const intensity = 1 - c;
            const alpha = 0.2 + intensity * 0.7;

            ctx.fillStyle = `rgba(0, 255, 255, ${alpha.toFixed(2)})`;
            const screen = camera.worldToScreen(wx, wy);
            ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
            cellsDrawn++;
        }
    }
    if (debug) {
        log(`[CONG] cellsWithMass=${cellsWithMass}, cellsDrawn=${cellsDrawn}`);
    }
}

/**
 * Draw cell-based congestion visualization (always on).
 * Shows effective congestion = freight mass + commuter friction.
 * Renders BEFORE particles so particles appear on top.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with zoom and viewportWorld
 * @param {HeatmapContext} hctx - Heatmap context
 * @param {string} flowRenderMode - Current flow render mode
 */
export function drawCongestionCells(ctx, camera, hctx, flowRenderMode) {
    // Skip during replay heatmap mode
    if (flowRenderMode === 'ROAD_HEATMAP') return;

    const { N, roi, cellMass, commuterLoad, COMMUTER_EQUIV_KG, RHO_CONGESTION_0, ROAD_CELL_CAP_KG, roadCellIndices, fieldToWorldX, fieldToWorldY } = hctx;

    const cellScreenSize = roi.cellSize * camera.zoom;

    // Skip if cells too small to see
    if (cellScreenSize < 1) return;

    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    // Iterate only road cells (sparse set)
    for (const idx of roadCellIndices) {
        const freightMass = cellMass[idx];
        const commuterMass = COMMUTER_EQUIV_KG * commuterLoad[idx];
        const effectiveRho = freightMass + commuterMass;

        // Normalize: 0 at onset, 1 at gridlock
        const congestionLevel = (effectiveRho - RHO_CONGESTION_0) / (ROAD_CELL_CAP_KG - RHO_CONGESTION_0);

        // Skip if below visibility threshold
        if (congestionLevel < 0.1) continue;

        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);

        // Viewport culling
        if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
        if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

        // Magenta fill, alpha proportional to congestion (clamped 0.02-0.08)
        const alpha = 0.02 + Math.min(1, congestionLevel) * 0.06;
        ctx.fillStyle = `rgba(200, 0, 200, ${alpha.toFixed(2)})`;
        const screen = camera.worldToScreen(wx, wy);
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }
}

/**
 * Thermal gradient: blue → cyan → green → yellow → red
 * Same as heatmapExport.js for consistency.
 * @param {number} t - Value in [0, 1]
 * @returns {{r: number, g: number, b: number}} RGB color
 */
export function thermalGradient(t) {
    if (t < 0.25) {
        const s = t / 0.25;
        return { r: 0, g: Math.round(255 * s), b: 255 };
    } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25;
        return { r: 0, g: 255, b: Math.round(255 * (1 - s)) };
    } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25;
        return { r: Math.round(255 * s), g: 255, b: 0 };
    } else {
        const s = (t - 0.75) / 0.25;
        return { r: 255, g: Math.round(255 * (1 - s)), b: 0 };
    }
}

/**
 * Draw replay heatmap from pre-computed frame data.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} camera - Camera with zoom and viewportWorld
 * @param {Object} frameData - { roadCellIndices, roadPresence, roi, N }
 * @param {Object} roi - Current ROI for cell size
 */
export function drawReplayHeatmap(ctx, camera, frameData, roi) {
    const { roadCellIndices: frameRoadCells, roadPresence, roi: frameRoi, N: frameN } = frameData;

    // Find max for normalization (p99 for better color range)
    const sortedValues = [...roadPresence].filter(v => v > 0).sort((a, b) => a - b);
    const maxVal = sortedValues.length > 0
        ? sortedValues[Math.floor(sortedValues.length * 0.99)] || sortedValues[sortedValues.length - 1]
        : 1;

    const cellSize = roi.cellSize * camera.zoom * 2;
    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 4;

    let nonZeroCount = 0;
    for (let i = 0; i < frameRoadCells.length; i++) {
        const presence = roadPresence[i];
        if (presence <= 0) continue;
        nonZeroCount++;

        const idx = frameRoadCells[i];
        const cx = idx % frameN;
        const cy = Math.floor(idx / frameN);

        // Convert field coords to world coords using frame's roi
        const wx = frameRoi.minX + (cx + 0.5) * frameRoi.cellSize;
        const wy = frameRoi.minY + (cy + 0.5) * frameRoi.cellSize;

        // Viewport culling
        if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
        if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

        // Normalize to [0,1] using p99 max
        const t = Math.min(1, presence / maxVal);
        const color = thermalGradient(t);

        // Bright, fully opaque colors
        ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
        const screen = camera.worldToScreen(wx, wy);
        ctx.fillRect(screen.x - cellSize/2, screen.y - cellSize/2, cellSize, cellSize);
    }
}
