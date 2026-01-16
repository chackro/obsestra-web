// ═══════════════════════════════════════════════════════════════════════════════
// STUB CIEN RENDERER
// Minimal fake renderer for testing Reynosa overlay in isolation.
// Implements all interfaces from renderer_interfaces.js with hardcoded data.
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// GEOMETRY (fake but plausible)
// Based on real coords from geometry.js: PHARR at (703, -444)
// ───────────────────────────────────────────────────────────────────────────────

export const stubGeometry = {
    worldBounds: {
        originX: -2000,
        originY: -1500,
        width: 4000,
        height: 3000,
    },

    poePoints: {
        PHARR: { x: 703, y: -444 },
    },

    // Simplified road network converging on PHARR
    roadSegments: [
        // Main corridor from south (MTY direction)
        {
            id: 'corridor_mty',
            points: [
                { x: -500, y: 800 },
                { x: 0, y: 500 },
                { x: 300, y: 200 },
                { x: 500, y: 0 },
                { x: 650, y: -200 },
                { x: 703, y: -444 },
            ]
        },
        // Victoria corridor from southeast
        {
            id: 'corridor_victoria',
            points: [
                { x: 900, y: 600 },
                { x: 850, y: 400 },
                { x: 800, y: 200 },
                { x: 750, y: 0 },
                { x: 720, y: -200 },
                { x: 703, y: -444 },
            ]
        },
        // MMRS corridor from east
        {
            id: 'corridor_mmrs',
            points: [
                { x: 1200, y: 300 },
                { x: 1000, y: 200 },
                { x: 850, y: 50 },
                { x: 750, y: -150 },
                { x: 703, y: -444 },
            ]
        },
        // Local Reynosa roads (grid-ish)
        {
            id: 'reynosa_main_ew',
            points: [
                { x: 400, y: 100 },
                { x: 600, y: 100 },
                { x: 800, y: 100 },
                { x: 1000, y: 100 },
            ]
        },
        {
            id: 'reynosa_secondary_ew',
            points: [
                { x: 450, y: -100 },
                { x: 650, y: -100 },
                { x: 850, y: -100 },
            ]
        },
        {
            id: 'reynosa_ns_1',
            points: [
                { x: 600, y: 300 },
                { x: 600, y: 100 },
                { x: 600, y: -100 },
                { x: 650, y: -300 },
            ]
        },
        {
            id: 'reynosa_ns_2',
            points: [
                { x: 800, y: 250 },
                { x: 800, y: 100 },
                { x: 800, y: -100 },
                { x: 750, y: -300 },
            ]
        },
    ],
};

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO DATA (fake hourly schedules)
// ───────────────────────────────────────────────────────────────────────────────

// Hourly inflow profile (peaks at hours 8-10, 14-16)
const HOURLY_INFLOW_PROFILE = [
    0.2, 0.15, 0.1, 0.1, 0.15, 0.3,   // 0-5
    0.5, 0.8, 1.0, 1.0, 0.9, 0.85,    // 6-11
    0.8, 0.85, 0.95, 1.0, 0.9, 0.7,   // 12-17
    0.5, 0.4, 0.35, 0.3, 0.25, 0.2,   // 18-23
];

// Base daily tonnage through PHARR (rough estimate)
const BASE_DAILY_KG = 15_000_000;  // 15,000 tonnes/day
const BASE_HOURLY_KG = BASE_DAILY_KG / 24;

// Gate capacity: LOCKED to match contract
// PHARR: s=4 lanes, μ=0.33 trucks/min/lane, 9000 kg/truck
// capacity = 4 * 0.33 * 60 * 9000 = 712,800 kg/hr
const AVG_KG_PER_TRUCK = 9000;  // LOCKED (from contracts/ReynosaOverlayBundle.js)
const GATE_CAP_KG_PER_HOUR = 4 * 0.33 * 60 * AVG_KG_PER_TRUCK;  // ~712,800 kg/hr

export const stubScenario = {
    scenarioId: 'stub_baseline_2025',

    getPharrInflow(hour) {
        const h = hour % 24;
        const multiplier = HOURLY_INFLOW_PROFILE[h];
        const totalKg = BASE_HOURLY_KG * multiplier;

        // Distribute across HS2 categories
        return {
            hs2_kg: {
                "85": totalKg * 0.25,  // Electronics
                "87": totalKg * 0.20,  // Vehicles
                "84": totalKg * 0.15,  // Machinery
                "39": totalKg * 0.10,  // Plastics
                "72": totalKg * 0.10,  // Steel
                "07": totalKg * 0.08,  // Vegetables
                "94": totalKg * 0.07,  // Furniture
                "90": totalKg * 0.05,  // Instruments
            }
        };
    },

    getPharrGateCapacity(hour) {
        // Capacity varies slightly by hour (fewer lanes at night)
        const h = hour % 24;
        let capMultiplier = 1.0;

        if (h >= 22 || h < 6) {
            capMultiplier = 0.5;  // Night shift: half capacity
        } else if (h >= 6 && h < 8) {
            capMultiplier = 0.75; // Ramp up
        }

        return {
            cap_kg_per_hour: GATE_CAP_KG_PER_HOUR * capMultiplier
        };
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// CAMERA (pan/zoom with world↔screen transforms)
// ───────────────────────────────────────────────────────────────────────────────

export class StubCamera {
    constructor(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;

        // Start centered on Reynosa (south of PHARR)
        this.centerWorld = {
            x: stubGeometry.poePoints.PHARR.x,
            y: stubGeometry.poePoints.PHARR.y + 6000
        };

        this.zoom = 0.15;  // pixels per meter
        this._updateViewport();
    }

    _updateViewport() {
        const halfW = (this.canvasWidth / 2) / this.zoom;
        const halfH = (this.canvasHeight / 2) / this.zoom;

        this.viewportWorld = {
            minX: this.centerWorld.x - halfW,
            maxX: this.centerWorld.x + halfW,
            minY: this.centerWorld.y - halfH,
            maxY: this.centerWorld.y + halfH,
        };
    }

    worldToScreen(wx, wy) {
        const sx = this.canvasWidth / 2 + (wx - this.centerWorld.x) * this.zoom;
        const sy = this.canvasHeight / 2 + (wy - this.centerWorld.y) * this.zoom;
        return { x: sx, y: sy };
    }

    screenToWorld(sx, sy) {
        const wx = this.centerWorld.x + (sx - this.canvasWidth / 2) / this.zoom;
        const wy = this.centerWorld.y + (sy - this.canvasHeight / 2) / this.zoom;
        return { x: wx, y: wy };
    }

    metersToPixels(meters) {
        return meters * this.zoom;
    }

    pan(dx, dy) {
        // dx, dy in screen pixels
        this.centerWorld.x -= dx / this.zoom;
        this.centerWorld.y -= dy / this.zoom;
        this._updateViewport();
    }

    zoomAt(factor, screenX, screenY) {
        // Zoom centered on a screen point
        const worldBefore = this.screenToWorld(screenX, screenY);
        this.zoom *= factor;
        this.zoom = Math.max(0.01, Math.min(2.0, this.zoom));
        this._updateViewport();

        // Adjust center to keep worldBefore at same screen position
        const worldAfter = this.screenToWorld(screenX, screenY);
        this.centerWorld.x += worldBefore.x - worldAfter.x;
        this.centerWorld.y += worldBefore.y - worldAfter.y;
        this._updateViewport();
    }

    setZoom(z) {
        this.zoom = Math.max(0.01, Math.min(2.0, z));
        this._updateViewport();
    }

    focusOnReynosa() {
        this.centerWorld = {
            x: stubGeometry.poePoints.PHARR.x,
            y: stubGeometry.poePoints.PHARR.y + 4000
        };
        this.zoom = 0.10;  // Above Z_ON threshold to activate overlay
        this._updateViewport();
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// TIME (simulation clock)
// ───────────────────────────────────────────────────────────────────────────────

export class StubTime {
    constructor() {
        this.simTimeSeconds = 0;
        this.scenarioId = stubScenario.scenarioId;
        this.timeScale = 60;  // 1 real second = 1 sim minute
        this.paused = false;
    }

    get currentHour() {
        return Math.floor(this.simTimeSeconds / 3600) % 24;
    }

    tick(dtReal) {
        if (!this.paused) {
            this.simTimeSeconds += (dtReal / 1000) * this.timeScale;
        }
    }

    setHour(hour) {
        this.simTimeSeconds = hour * 3600;
    }

    setTimeScale(scale) {
        this.timeScale = scale;
    }

    togglePause() {
        this.paused = !this.paused;
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// RENDERER CONTEXT (what overlay receives)
// ───────────────────────────────────────────────────────────────────────────────

export function createRendererContext() {
    return {
        geometry: stubGeometry,
        scenario: stubScenario,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// BASE MAP DRAWING (so you see roads under the overlay)
// ───────────────────────────────────────────────────────────────────────────────

export function drawBaseMap(ctx, camera) {
    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, camera.canvasWidth, camera.canvasHeight);

    // Draw roads
    ctx.strokeStyle = '#3a3a5e';
    ctx.lineWidth = Math.max(1, camera.metersToPixels(80));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const seg of stubGeometry.roadSegments) {
        ctx.beginPath();
        for (let i = 0; i < seg.points.length; i++) {
            const screen = camera.worldToScreen(seg.points[i].x, seg.points[i].y);
            if (i === 0) {
                ctx.moveTo(screen.x, screen.y);
            } else {
                ctx.lineTo(screen.x, screen.y);
            }
        }
        ctx.stroke();
    }

    // Draw PHARR marker
    const pharr = camera.worldToScreen(
        stubGeometry.poePoints.PHARR.x,
        stubGeometry.poePoints.PHARR.y
    );
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(pharr.x, pharr.y, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.fillText('PHARR', pharr.x + 12, pharr.y + 4);
}
