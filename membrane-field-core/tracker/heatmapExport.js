/**
 * Heatmap PNG Export for Headless Simulation
 *
 * Renders accumulated congestion data as thermal gradient heatmaps.
 * Two outputs per scenario:
 *   - *_presence.png: Total truck-hours in each cell (traffic volume)
 *   - *_stall.png: Truck-hours at reduced speed (congestion pain)
 */

import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';

// Viewport matching testBundle.html
const VIEWPORT = {
    center: { x: 4818, y: -9210 },
    width: 35014,
    height: 18974
};

// Canvas resolution
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = Math.round(CANVAS_WIDTH * VIEWPORT.height / VIEWPORT.width);  // ~1040

/**
 * Thermal gradient: Blue → Cyan → Green → Yellow → Red
 * @param {number} t - Value in [0, 1]
 * @returns {{r: number, g: number, b: number}} RGB values 0-255
 */
function thermalGradient(t) {
    // Clamp to [0, 1]
    t = Math.max(0, Math.min(1, t));

    let r, g, b;

    if (t < 0.25) {
        // Blue (0,0,255) → Cyan (0,255,255)
        const s = t / 0.25;
        r = 0;
        g = Math.round(255 * s);
        b = 255;
    } else if (t < 0.5) {
        // Cyan (0,255,255) → Green (0,255,0)
        const s = (t - 0.25) / 0.25;
        r = 0;
        g = 255;
        b = Math.round(255 * (1 - s));
    } else if (t < 0.75) {
        // Green (0,255,0) → Yellow (255,255,0)
        const s = (t - 0.5) / 0.25;
        r = Math.round(255 * s);
        g = 255;
        b = 0;
    } else {
        // Yellow (255,255,0) → Red (255,0,0)
        const s = (t - 0.75) / 0.25;
        r = 255;
        g = Math.round(255 * (1 - s));
        b = 0;
    }

    return { r, g, b };
}

/**
 * Convert world coordinates to canvas coordinates
 */
function worldToCanvas(wx, wy) {
    const x = (wx - (VIEWPORT.center.x - VIEWPORT.width / 2)) / VIEWPORT.width * CANVAS_WIDTH;
    const y = (wy - (VIEWPORT.center.y - VIEWPORT.height / 2)) / VIEWPORT.height * CANVAS_HEIGHT;
    return { x, y: CANVAS_HEIGHT - y };  // Flip Y (world Y increases up, canvas Y increases down)
}

/**
 * Render a heatmap from cell data
 * @param {Object} data - From getCongestionHeatmapData()
 * @param {Float64Array} cellHours - cellPresenceHours or cellStallHours
 * @param {string} outputPath - Output PNG path
 * @param {string} label - Label for the heatmap (e.g., "Presence", "Stall")
 */
function renderHeatmap(data, cellHours, outputPath, label) {
    const { N, roi, roadCellIndices, lotCellIndices, sinkCellIndices, regionMap, REGION } = data;

    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. Draw lot cells as dark gray
    ctx.fillStyle = '#1a1a1a';
    const cellSize = roi.cellSize;
    for (const idx of lotCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 3. Draw sink cells (bridge) as dark blue
    ctx.fillStyle = '#001a33';
    for (const idx of sinkCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 4. Draw road cells as very dark gray (background for heatmap)
    ctx.fillStyle = '#0d0d0d';
    for (const idx of roadCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 5. Find max value for normalization (use 99th percentile to show hotspots)
    const values = [];
    for (const idx of roadCellIndices) {
        if (cellHours[idx] > 0) values.push(cellHours[idx]);
    }
    values.sort((a, b) => a - b);
    const p99 = values.length > 0 ? values[Math.floor(values.length * 0.99)] : 0;
    const maxVal = Math.max(p99, 0.1);

    // 6. Draw heatmap (thermal gradient on road cells)
    for (const idx of roadCellIndices) {
        const hours = cellHours[idx];
        if (hours <= 0) continue;

        const t = Math.min(1, hours / maxVal);
        if (t < 0.001) continue;

        const color = thermalGradient(t);
        const alpha = 0.5 + t * 0.5;

        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = Math.max(2, cellSize / VIEWPORT.width * CANVAS_WIDTH);

        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(2)})`;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 7. Draw legend
    const legendX = 20;
    const legendY = CANVAS_HEIGHT - 100;
    const legendWidth = 200;
    const legendHeight = 20;

    // Gradient bar
    const gradient = ctx.createLinearGradient(legendX, legendY, legendX + legendWidth, legendY);
    gradient.addColorStop(0, 'rgb(0, 0, 255)');      // Blue
    gradient.addColorStop(0.25, 'rgb(0, 255, 255)'); // Cyan
    gradient.addColorStop(0.5, 'rgb(0, 255, 0)');    // Green
    gradient.addColorStop(0.75, 'rgb(255, 255, 0)'); // Yellow
    gradient.addColorStop(1, 'rgb(255, 0, 0)');      // Red
    ctx.fillStyle = gradient;
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);

    // Border
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.fillText('0', legendX, legendY + legendHeight + 15);
    ctx.fillText(`${maxVal.toFixed(0)} truck-hrs`, legendX + legendWidth - 80, legendY + legendHeight + 15);

    // Title
    ctx.font = 'bold 16px monospace';
    ctx.fillText(label, legendX, legendY - 10);

    // 8. Save PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`[Heatmap] Saved: ${outputPath} (max=${maxVal.toFixed(0)} truck-hrs)`);
}

/**
 * Render lot dwell heatmap (uses lotCellIndices instead of roadCellIndices)
 */
function renderLotHeatmap(data, outputPath, label) {
    const { N, roi, lotCellIndices } = data;
    const cellHours = data.cellLotDwellHours;

    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const cellSize = roi.cellSize;

    // 2. Find max for normalization
    const values = [];
    for (const idx of lotCellIndices) {
        if (cellHours[idx] > 0) values.push(cellHours[idx]);
    }
    values.sort((a, b) => a - b);
    const p99 = values.length > 0 ? values[Math.floor(values.length * 0.99)] : 0;
    const maxVal = Math.max(p99, 0.1);

    // 3. Draw lot cells
    for (const idx of lotCellIndices) {
        const hours = cellHours[idx];
        if (hours <= 0) continue;

        const t = Math.min(1, hours / maxVal);
        if (t < 0.001) continue;

        const color = thermalGradient(t);
        const alpha = 0.5 + t * 0.5;

        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = Math.max(2, cellSize / VIEWPORT.width * CANVAS_WIDTH);

        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(2)})`;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 4. Legend
    const legendX = 20;
    const legendY = CANVAS_HEIGHT - 100;
    const legendWidth = 200;
    const legendHeight = 20;

    const gradient = ctx.createLinearGradient(legendX, legendY, legendX + legendWidth, legendY);
    gradient.addColorStop(0, 'rgb(0, 0, 255)');
    gradient.addColorStop(0.25, 'rgb(0, 255, 255)');
    gradient.addColorStop(0.5, 'rgb(0, 255, 0)');
    gradient.addColorStop(0.75, 'rgb(255, 255, 0)');
    gradient.addColorStop(1, 'rgb(255, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);

    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.fillText('0', legendX, legendY + legendHeight + 15);
    ctx.fillText(`${maxVal.toFixed(0)} truck-hrs`, legendX + legendWidth - 80, legendY + legendHeight + 15);

    ctx.font = 'bold 16px monospace';
    ctx.fillText(label, legendX, legendY - 10);

    // 5. Save
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`[Heatmap] Saved: ${outputPath} (max=${maxVal.toFixed(0)} truck-hrs)`);
}

/**
 * Diverging colormap for delta visualization.
 * Blue (improvement/negative) → White (neutral) → Red (worsening/positive)
 * @param {number} t - Value in [-1, 1]
 * @returns {{r: number, g: number, b: number}} RGB values 0-255
 */
function divergingGradient(t) {
    // Clamp to [-1, 1]
    t = Math.max(-1, Math.min(1, t));

    if (t < 0) {
        // Blue gradient: white → blue (improvement)
        const s = -t;  // 0 to 1
        return {
            r: Math.round(255 * (1 - s)),
            g: Math.round(255 * (1 - 0.6 * s)),
            b: 255
        };
    } else {
        // Red gradient: white → red (worsening)
        const s = t;  // 0 to 1
        return {
            r: 255,
            g: Math.round(255 * (1 - 0.8 * s)),
            b: Math.round(255 * (1 - s))
        };
    }
}

/**
 * Render delta heatmap (scenario - baseline).
 * Diverging colormap: blue (improvement) → white (neutral) → red (worsening)
 * @param {Object} baselineData - Baseline scenario data from getCongestionHeatmapData()
 * @param {Object} scenarioData - Comparison scenario data
 * @param {string} scenarioName - Name of comparison scenario
 * @param {string} baselineName - Name of baseline scenario
 * @param {string} outputPath - Output PNG path
 * @param {string} type - 'presence' or 'lotdwell'
 */
function renderDeltaHeatmap(baselineData, scenarioData, scenarioName, baselineName, outputPath, type = 'presence') {
    const { N, roi, roadCellIndices, lotCellIndices, sinkCellIndices } = baselineData;

    const sourceArray = type === 'presence' ? 'cellPresenceHours' : 'cellLotDwellHours';
    const cellIndices = type === 'presence' ? roadCellIndices : lotCellIndices;
    const baselineHours = baselineData[sourceArray];
    const scenarioHours = scenarioData[sourceArray];

    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const cellSize = roi.cellSize;

    // 2. Draw lot cells as dark gray (for context)
    if (type === 'presence') {
        ctx.fillStyle = '#1a1a1a';
        for (const idx of lotCellIndices) {
            const cx = roi.minX + (idx % N) * cellSize;
            const cy = roi.minY + Math.floor(idx / N) * cellSize;
            const screen = worldToCanvas(cx, cy);
            const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
            ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
        }
    }

    // 3. Draw sink cells (bridge) as dark blue (for context)
    ctx.fillStyle = '#001a33';
    for (const idx of sinkCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 4. Compute delta and find max absolute value
    const delta = new Float64Array(N * N);
    let maxAbsDelta = 0;
    for (const idx of cellIndices) {
        delta[idx] = scenarioHours[idx] - baselineHours[idx];
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta[idx]));
    }

    // Avoid division by zero
    if (maxAbsDelta < 0.001) maxAbsDelta = 0.001;

    // 5. Draw delta heatmap
    for (const idx of cellIndices) {
        const d = delta[idx];
        if (Math.abs(d) < 0.001) continue;  // Skip near-zero deltas

        const t = d / maxAbsDelta;  // [-1, 1]
        const color = divergingGradient(t);
        const alpha = 0.5 + Math.abs(t) * 0.5;

        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = Math.max(2, cellSize / VIEWPORT.width * CANVAS_WIDTH);

        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(2)})`;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 6. Draw legend (diverging: blue - white - red)
    const legendX = 20;
    const legendY = CANVAS_HEIGHT - 100;
    const legendWidth = 200;
    const legendHeight = 20;

    // Diverging gradient bar
    const gradient = ctx.createLinearGradient(legendX, legendY, legendX + legendWidth, legendY);
    gradient.addColorStop(0, 'rgb(0, 102, 255)');     // Blue (improvement)
    gradient.addColorStop(0.5, 'rgb(255, 255, 255)'); // White (neutral)
    gradient.addColorStop(1, 'rgb(255, 51, 0)');      // Red (worsening)
    ctx.fillStyle = gradient;
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);

    // Border
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`-${maxAbsDelta.toFixed(0)}`, legendX, legendY + legendHeight + 15);
    ctx.textAlign = 'center';
    ctx.fillText('0', legendX + legendWidth / 2, legendY + legendHeight + 15);
    ctx.textAlign = 'right';
    ctx.fillText(`+${maxAbsDelta.toFixed(0)}`, legendX + legendWidth, legendY + legendHeight + 15);

    // Title
    ctx.textAlign = 'left';
    ctx.font = 'bold 16px monospace';
    const typeLabel = type === 'presence' ? 'Road Presence' : 'Lot Dwell';
    ctx.fillText(`Δ ${typeLabel}: ${scenarioName} vs ${baselineName}`, legendX, legendY - 10);

    // Interpretation labels
    ctx.font = '11px monospace';
    ctx.fillStyle = '#6af';
    ctx.fillText('← improvement', legendX, legendY - 30);
    ctx.fillStyle = '#f63';
    ctx.textAlign = 'right';
    ctx.fillText('worsening →', legendX + legendWidth, legendY - 30);

    // 7. Save PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`[DeltaHeatmap] Saved: ${outputPath} (max delta = ±${maxAbsDelta.toFixed(0)} truck-hrs)`);
}

/**
 * Export delta heatmaps comparing scenario to baseline
 * @param {Object} baselineData - Baseline scenario data
 * @param {Object} scenarioData - Comparison scenario data
 * @param {string} scenarioName - Name of comparison scenario
 * @param {string} baselineName - Name of baseline scenario
 * @param {string} dir - Output directory
 */
function exportDeltaHeatmaps(baselineData, scenarioData, scenarioName, baselineName, dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Delta presence (roads)
    renderDeltaHeatmap(
        baselineData, scenarioData,
        scenarioName, baselineName,
        `${dir}/delta_presence_${scenarioName}_vs_${baselineName}.png`,
        'presence'
    );

    // Delta lot dwell
    renderDeltaHeatmap(
        baselineData, scenarioData,
        scenarioName, baselineName,
        `${dir}/delta_lotdwell_${scenarioName}_vs_${baselineName}.png`,
        'lotdwell'
    );
}

/**
 * Export presence and lot dwell heatmaps for a scenario
 * @param {Object} data - From getCongestionHeatmapData()
 * @param {string} basePath - Base path without extension (e.g., "./results/260107_1234/Baseline")
 */
function exportHeatmaps(data, basePath) {
    const dir = path.dirname(basePath);
    const scenario = path.basename(basePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Naming: layer_scenario.png (e.g., presence_Baseline.png)
    renderHeatmap(data, data.cellPresenceHours, `${dir}/presence_${scenario}.png`, 'Road Presence');
    renderLotHeatmap(data, `${dir}/lotdwell_${scenario}.png`, 'Lot Dwell');
}

export { renderHeatmap, exportHeatmaps, thermalGradient, exportDeltaHeatmaps, renderDeltaHeatmap };
