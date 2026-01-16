/**
 * Animated Heatmap GIF Export
 *
 * Renders accumulated congestion data as animated GIFs showing
 * evolution over time. Uses cumulative buildup visualization.
 */

import GIFEncoder from 'gif-encoder-2';
import { createCanvas } from 'canvas';
import fs from 'fs';

// Viewport matching testBundle.html
const VIEWPORT = {
    center: { x: 4818, y: -9210 },
    width: 35014,
    height: 18974
};

// Canvas resolution
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = Math.round(CANVAS_WIDTH * VIEWPORT.height / VIEWPORT.width);

// GIF settings
const FRAME_DELAY = 50;  // ms between frames (~20fps)
const GIF_QUALITY = 10;  // 1-30, lower = better quality

/**
 * Thermal gradient: Blue -> Cyan -> Green -> Yellow -> Red
 * @param {number} t - Value in [0, 1]
 * @returns {{r: number, g: number, b: number}}
 */
function thermalGradient(t) {
    t = Math.max(0, Math.min(1, t));
    let r, g, b;

    if (t < 0.25) {
        const s = t / 0.25;
        r = 0;
        g = Math.round(255 * s);
        b = 255;
    } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25;
        r = 0;
        g = 255;
        b = Math.round(255 * (1 - s));
    } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25;
        r = Math.round(255 * s);
        g = 255;
        b = 0;
    } else {
        const s = (t - 0.75) / 0.25;
        r = 255;
        g = Math.round(255 * (1 - s));
        b = 0;
    }

    return { r, g, b };
}

/**
 * Diverging gradient: Blue (negative) -> White (zero) -> Red (positive)
 * @param {number} t - Value in [-1, 1]
 * @returns {{r: number, g: number, b: number}}
 */
function divergingGradient(t) {
    t = Math.max(-1, Math.min(1, t));

    if (t < 0) {
        const s = -t;
        return {
            r: Math.round(255 * (1 - s)),
            g: Math.round(255 * (1 - 0.6 * s)),
            b: 255
        };
    } else {
        const s = t;
        return {
            r: 255,
            g: Math.round(255 * (1 - 0.8 * s)),
            b: Math.round(255 * (1 - s))
        };
    }
}

/**
 * Convert world coordinates to canvas coordinates
 */
function worldToCanvas(wx, wy) {
    const x = (wx - (VIEWPORT.center.x - VIEWPORT.width / 2)) / VIEWPORT.width * CANVAS_WIDTH;
    const y = (wy - (VIEWPORT.center.y - VIEWPORT.height / 2)) / VIEWPORT.height * CANVAS_HEIGHT;
    return { x, y: CANVAS_HEIGHT - y };
}

/**
 * Format simulation time as human-readable string
 */
function formatTime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) {
        return `Day ${days + 1}, ${hours}:00`;
    }
    return `${hours}:00`;
}

/**
 * Render a single frame to a canvas context
 */
function renderFrame(ctx, cellHours, metadata, maxVal, label, timeLabel) {
    const { N, roi, roadCellIndices, lotCellIndices, sinkCellIndices } = metadata;
    const cellSize = roi.cellSize;

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. Draw lot cells as dark gray
    ctx.fillStyle = '#1a1a1a';
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

    // 4. Draw road cells as very dark gray
    ctx.fillStyle = '#0d0d0d';
    for (const idx of roadCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 5. Draw heatmap (thermal gradient on road cells)
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

    // 6. Draw legend
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

    // 7. Title and time
    ctx.font = 'bold 16px monospace';
    ctx.fillText(label, legendX, legendY - 10);

    // Time indicator (top right)
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(timeLabel, CANVAS_WIDTH - 20, 30);
    ctx.textAlign = 'left';
}

/**
 * Render a single lot dwell frame
 */
function renderLotFrame(ctx, cellHours, metadata, maxVal, label, timeLabel) {
    const { N, roi, lotCellIndices, sinkCellIndices } = metadata;
    const cellSize = roi.cellSize;

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. Draw sink cells (bridge) as dark blue
    ctx.fillStyle = '#001a33';
    for (const idx of sinkCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 3. Draw lot cells with heatmap
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

    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(timeLabel, CANVAS_WIDTH - 20, 30);
    ctx.textAlign = 'left';
}

/**
 * Render a delta frame (scenario vs baseline)
 */
function renderDeltaFrame(ctx, baselineHours, scenarioHours, metadata, maxAbsDelta, label, timeLabel) {
    const { N, roi, roadCellIndices, lotCellIndices, sinkCellIndices } = metadata;
    const cellSize = roi.cellSize;

    // 1. Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. Draw lot cells as dark gray
    ctx.fillStyle = '#1a1a1a';
    for (const idx of lotCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 3. Draw sink cells
    ctx.fillStyle = '#001a33';
    for (const idx of sinkCellIndices) {
        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = cellSize / VIEWPORT.width * CANVAS_WIDTH;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 4. Draw delta heatmap
    for (const idx of roadCellIndices) {
        const delta = scenarioHours[idx] - baselineHours[idx];
        if (Math.abs(delta) < 0.001) continue;

        const t = delta / maxAbsDelta;
        const color = divergingGradient(t);
        const alpha = 0.5 + Math.abs(t) * 0.5;

        const cx = roi.minX + (idx % N) * cellSize;
        const cy = roi.minY + Math.floor(idx / N) * cellSize;
        const screen = worldToCanvas(cx, cy);
        const screenSize = Math.max(2, cellSize / VIEWPORT.width * CANVAS_WIDTH);

        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(2)})`;
        ctx.fillRect(screen.x, screen.y - screenSize, screenSize, screenSize);
    }

    // 5. Legend (diverging)
    const legendX = 20;
    const legendY = CANVAS_HEIGHT - 100;
    const legendWidth = 200;
    const legendHeight = 20;

    const gradient = ctx.createLinearGradient(legendX, legendY, legendX + legendWidth, legendY);
    gradient.addColorStop(0, 'rgb(0, 102, 255)');
    gradient.addColorStop(0.5, 'rgb(255, 255, 255)');
    gradient.addColorStop(1, 'rgb(255, 51, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);

    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`-${maxAbsDelta.toFixed(0)}`, legendX, legendY + legendHeight + 15);
    ctx.textAlign = 'center';
    ctx.fillText('0', legendX + legendWidth / 2, legendY + legendHeight + 15);
    ctx.textAlign = 'right';
    ctx.fillText(`+${maxAbsDelta.toFixed(0)}`, legendX + legendWidth, legendY + legendHeight + 15);

    ctx.textAlign = 'left';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(label, legendX, legendY - 10);

    ctx.font = '11px monospace';
    ctx.fillStyle = '#6af';
    ctx.fillText('improvement', legendX, legendY - 30);
    ctx.fillStyle = '#f63';
    ctx.textAlign = 'right';
    ctx.fillText('worsening', legendX + legendWidth, legendY - 30);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(timeLabel, CANVAS_WIDTH - 20, 30);
    ctx.textAlign = 'left';
}

/**
 * Find global max across all frames for consistent color scaling
 */
function findGlobalMax(frames, key, cellIndices) {
    let globalMax = 0;
    for (const frame of frames) {
        for (const idx of cellIndices) {
            if (frame[key][idx] > globalMax) {
                globalMax = frame[key][idx];
            }
        }
    }
    return Math.max(globalMax, 0.1);
}

/**
 * Find global max delta across all frames
 */
function findGlobalMaxDelta(baselineFrames, scenarioFrames, key, cellIndices) {
    let maxAbsDelta = 0;
    for (let i = 0; i < baselineFrames.length; i++) {
        for (const idx of cellIndices) {
            const delta = Math.abs(scenarioFrames[i][key][idx] - baselineFrames[i][key][idx]);
            if (delta > maxAbsDelta) {
                maxAbsDelta = delta;
            }
        }
    }
    return Math.max(maxAbsDelta, 0.001);
}

/**
 * Export animated heatmap GIF for a scenario
 * @param {Array} frames - Array of {t, cellPresenceHours, cellLotDwellHours}
 * @param {Object} metadata - Grid metadata (N, roi, cellIndices, etc.)
 * @param {string} scenarioName - Name of the scenario
 * @param {string} dir - Output directory
 */
export function exportAnimatedHeatmaps(frames, metadata, scenarioName, dir) {
    if (!frames || frames.length === 0) {
        console.warn(`[AnimatedHeatmap] No frames to export for ${scenarioName}`);
        return;
    }

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { roadCellIndices, lotCellIndices } = metadata;

    // Road presence GIF
    const presenceMax = findGlobalMax(frames, 'cellPresenceHours', roadCellIndices);
    exportGif(
        frames,
        metadata,
        'cellPresenceHours',
        roadCellIndices,
        presenceMax,
        `Road Presence: ${scenarioName}`,
        `${dir}/presence_${scenarioName}.gif`,
        renderFrame
    );

    // Lot dwell GIF
    const lotMax = findGlobalMax(frames, 'cellLotDwellHours', lotCellIndices);
    exportGif(
        frames,
        metadata,
        'cellLotDwellHours',
        lotCellIndices,
        lotMax,
        `Lot Dwell: ${scenarioName}`,
        `${dir}/lotdwell_${scenarioName}.gif`,
        renderLotFrame
    );
}

/**
 * Export animated delta heatmaps (scenario vs baseline)
 */
export function exportAnimatedDeltaHeatmaps(baselineFrames, scenarioFrames, metadata, scenarioName, baselineName, dir) {
    if (!baselineFrames || !scenarioFrames || baselineFrames.length === 0) {
        console.warn(`[AnimatedDeltaHeatmap] Missing frames for delta ${scenarioName} vs ${baselineName}`);
        return;
    }

    if (baselineFrames.length !== scenarioFrames.length) {
        console.warn(`[AnimatedDeltaHeatmap] Frame count mismatch: baseline=${baselineFrames.length}, scenario=${scenarioFrames.length}`);
        return;
    }

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { roadCellIndices, lotCellIndices } = metadata;

    // Delta road presence GIF
    const presenceMaxDelta = findGlobalMaxDelta(baselineFrames, scenarioFrames, 'cellPresenceHours', roadCellIndices);
    exportDeltaGif(
        baselineFrames,
        scenarioFrames,
        metadata,
        'cellPresenceHours',
        roadCellIndices,
        presenceMaxDelta,
        `Road Presence: ${scenarioName} vs ${baselineName}`,
        `${dir}/delta_presence_${scenarioName}_vs_${baselineName}.gif`
    );

    // Delta lot dwell GIF
    const lotMaxDelta = findGlobalMaxDelta(baselineFrames, scenarioFrames, 'cellLotDwellHours', lotCellIndices);
    exportDeltaGif(
        baselineFrames,
        scenarioFrames,
        metadata,
        'cellLotDwellHours',
        lotCellIndices,
        lotMaxDelta,
        `Lot Dwell: ${scenarioName} vs ${baselineName}`,
        `${dir}/delta_lotdwell_${scenarioName}_vs_${baselineName}.gif`
    );
}

/**
 * Core GIF export function
 */
function exportGif(frames, metadata, dataKey, cellIndices, maxVal, label, outputPath, renderFn) {
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    const encoder = new GIFEncoder(CANVAS_WIDTH, CANVAS_HEIGHT);
    encoder.setDelay(FRAME_DELAY);
    encoder.setQuality(GIF_QUALITY);
    encoder.setRepeat(0);

    const stream = fs.createWriteStream(outputPath);
    encoder.createReadStream().pipe(stream);
    encoder.start();

    for (const frame of frames) {
        const timeLabel = formatTime(frame.t);
        renderFn(ctx, frame[dataKey], metadata, maxVal, label, timeLabel);
        encoder.addFrame(ctx);
    }

    encoder.finish();
    console.log(`[AnimatedHeatmap] Saved: ${outputPath} (${frames.length} frames, max=${maxVal.toFixed(0)})`);
}

/**
 * Core delta GIF export function
 */
function exportDeltaGif(baselineFrames, scenarioFrames, metadata, dataKey, cellIndices, maxAbsDelta, label, outputPath) {
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    const encoder = new GIFEncoder(CANVAS_WIDTH, CANVAS_HEIGHT);
    encoder.setDelay(FRAME_DELAY);
    encoder.setQuality(GIF_QUALITY);
    encoder.setRepeat(0);

    const stream = fs.createWriteStream(outputPath);
    encoder.createReadStream().pipe(stream);
    encoder.start();

    for (let i = 0; i < baselineFrames.length; i++) {
        const timeLabel = formatTime(baselineFrames[i].t);
        renderDeltaFrame(
            ctx,
            baselineFrames[i][dataKey],
            scenarioFrames[i][dataKey],
            metadata,
            maxAbsDelta,
            label,
            timeLabel
        );
        encoder.addFrame(ctx);
    }

    encoder.finish();
    console.log(`[AnimatedDeltaHeatmap] Saved: ${outputPath} (${baselineFrames.length} frames, maxDelta=${maxAbsDelta.toFixed(0)})`);
}
