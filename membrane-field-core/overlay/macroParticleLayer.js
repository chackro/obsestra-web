// ═══════════════════════════════════════════════════════════════════════════════
// MACRO PARTICLE LAYER
// Geometric particle flow along CIEN corridor segments (no physics).
// Particles follow polyline paths; direction fixed, magnitude from allocation.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MacroParticleLayer
 * 
 * Renders particles flowing along CIEN segments based on flow weights.
 * - Particles advance geometrically along polylines (not physics-based)
 * - Spawn rate proportional to segment weight
 * - Speed mapped from weight
 * - Wrapping + finite life
 * - Zero imports from engine layer (pure geometry)
 */
export class MacroParticleLayer {
    constructor(opts = {}) {
        // Hard ceiling: balance between density and flow visibility
        this.maxParticles = opts.maxParticles ?? 20000;

        // Global spawn budget (particles/sec), distributed across active corridors by weight.
        // If not provided, derive from maxParticles / targetAvgLifeSec.
        this.targetAvgLifeSec = opts.targetAvgLifeSec ?? 8;
        this.spawnPerSecondBudget = opts.spawnPerSecondBudget ?? (this.maxParticles / Math.max(1, this.targetAvgLifeSec));
        this._spawnResidual = 0;
        // Uniform particle speed in meters/sec
        this.particleSpeed = opts.particleSpeed ?? 61200;  // 2x from 30600
        this.viewportPaddingFraction = opts.viewportPaddingFraction ?? 0.25; // 25% of viewport

        // Lateral spread: particles drift perpendicular to road for visual width
        this.lateralSpreadM = opts.lateralSpreadM ?? 2000;  // ±2km spread for wide fuzzy corridors
        this.lateralDriftSpeed = opts.lateralDriftSpeed ?? 150;  // slower drift for smoother feel

        // Trail rendering for motion feel
        this.trailLength = opts.trailLength ?? 2;  // reduced trail segments for perf
        this.trailFade = opts.trailFade ?? 0.35;   // slightly faster fade

        // Segment registry: segmentId → SegmentData
        this.segments = new Map();
        // Connectivity graph: segmentId → { fromStart: [...], fromEnd: [...] }
        // Each entry is { seg, atStart } meaning "connects to seg, entering at start or end"
        this._connectivity = new Map();
        this._connectivityBuilt = false;
        this._connectTolerance = 10; // meters - endpoints within this distance are connected

        // Mexican origins for true source detection (lat/lon → world coords)
        this._originCoords = null; // Map: originName → { x, y } in world coords
        this._originTolerance = 50000; // meters - segments within this distance of an origin are sources

        // POE cone integrity: connector budget for bridging sparse flow data
        // Particles can take K "off-cone" steps (segments without their POE flow)
        // before being killed. This bridges gaps without allowing unlimited wandering.
        this._connectorBudget = opts.connectorBudget ?? 30;


        // Spawn distribution (rebuilt per frame, viewport-aware)
        this._spawnSegments = [];
        this._spawnCumWeights = [];
        this._spawnTotalW = 0;

        // Particle pool
        this.particles = [];

        // Pause state (particles freeze in place)
        this._paused = true;  // Start paused

        // DEV: Color override for all particles (null = use normal colors)
        this.devColorOverride = null;  // e.g. '#ff0000' for red

        // DEV: Ghost particles for comparison (snapshot of positions at different α)
        this._devGhostParticles = null;  // Array of {x, y} positions
        this._devGhostColor = '#00ff00';  // Green for ghosts

        // No per-segment spawn accumulators: spawning is budgeted globally.

        // Flow weight range for speed mapping (computed from segment weights)
        this.flowMin = 0;
        this.flowMax = 1;

        // Kill threshold: segments with weight below this don't spawn
        this.killWeightThreshold = 0.001;
        this.spawnEpsilon = opts.spawnEpsilon ?? 1e-6;

        // Spawn weight compression: 1.0 = linear, 0.5 = sqrt, 0.3 = more compressed
        // Lower values flatten distribution so heavy segments don't dominate
        this.spawnWeightPower = opts.spawnWeightPower ?? 1.0;

        // Spawn ramp-up: start slow, accelerate to full rate over rampUpDuration
        this.spawnRampUpSec = opts.spawnRampUpSec ?? 0;  // 0 = no ramp, instant full rate
        this._spawnElapsedSec = 0;  // time since unpaused

        // Accelerated death rate for particles on segments with collapsed weight
        this.acceleratedDeathMultiplier = 2.5;

        // Speed mapping log scale factor
        this.speedLogScale = opts.speedLogScale ?? 1.0;

        // Diagnostics
        this.spawnedThisFrame = 0;
        this.spawnLogT = 0;
        this.probeLogT = 0;
        this.probe = null;
        this._diagFrame = 0;
        this._diagSpawnLogs = 0;
        this._diagEnabled = false;

        // POE cone diagnostics
        this._coneStats = { onCone: 0, offCone: 0, budgetKills: 0, reentries: 0 };
        this._coneStatsLogT = 0;
        this._diagForceSpawn = false; // Set true temporarily to prove motion

        // Dynamic spawn throttling based on frame time
        this._frameTimeEMA = 16;      // Start at target 60fps
        this._spawnMultiplier = 1.0;  // 1.0 = full budget, lower = throttled
        this._perfAlpha = 0.1;        // EMA smoothing factor
        this._lastFrameStart = 0;

        // Director-controlled density multiplier (for narrative emphasis)
        this._densityMultiplier = 1.0;
        this._baseBudget = this.spawnPerSecondBudget;
        this._baseMaxParticles = this.maxParticles;

        // Debug: show segment tracers when enabled
        this.debugTracers = false;       // flickering lightshow mode (x)
        this.debugTracersStable = false; // stable diagnostic mode (c)
        this.particlesVisible = true;    // toggle particle rendering

        // Flicker state for X mode (time-based, smooth oscillation)
        this._flickerTime = 0;
        this._flickerPhases = new Map(); // segmentId → random phase offset

        // Dark mode: use light particles instead of black
        this.darkMode = opts.darkMode ?? true;  // Default ON

        // Pharr highlight mode (P key): Pharr particles black, others faint grey
        this.pharrHighlightMode = false;
        this.highlightPoe = 'hidalgo_pharr';  // POE to highlight when mode is on

        // Corridor highlight mode (Director-driven): highlight specific POE corridors
        this.corridorHighlightMode = false;
        this.corridorHighlightPoes = new Set();  // POE IDs to highlight
        // Three-way classification for magenta hierarchy
        this.corridorPrimaryPoe = null;    // POE_LAREDO - full brightness magenta
        this.corridorSecondaryPoe = null;  // POE_PHARR - reduced brightness magenta
        this.hideNonHighlightedParticles = false;  // When true, only show highlighted POE particles
        this.nonHighlightedAlpha = 1.0;  // Alpha for non-highlighted corridors (1.0 = full, 0 = hidden)
        this.highlightedAlpha = 1.0;     // Alpha for highlighted corridors (can be reduced to "meet in middle")
        this.poeColorOverrides = new Map();  // POE -> color override ('white', 'magenta', etc.)
        // Per-segment POE distribution for probabilistic POE assignment at spawn
        // Separate distributions for each scenario (they represent different realities)
        this.baselinePoeDistribution = new Map();
        this.interserranaPoeDistribution = new Map();
        this.scenarioAlpha = 0;  // 0 = baseline, 1 = interserrana

        // WebGL renderer (optional, for GPU-accelerated rendering)
        this._glRenderer = null;
        this._glPositions = null;  // Float32Array for WebGL positions
        this._glColors = null;     // Float32Array for WebGL colors

        // Persistent draw buffers (avoid GC pressure from per-frame allocation)
        this._drawBufferSize = 0;
        this._drawBucketData = null;
        this._drawBucketCounts = new Uint32Array(5);
        // Separate buffers for highlighted particles
        this._drawPharrBucketData = null;       // Primary POE (full magenta)
        this._drawPharrBucketCounts = new Uint32Array(5);
        this._drawSecondaryBucketData = null;   // Secondary POE (0.7 magenta)
        this._drawSecondaryBucketCounts = new Uint32Array(5);

        // Gravity sink effect (3D potential field)
        this.potentialField = null;   // Set via setPotentialField()
        this.zScale = opts.zScale ?? 80;  // VERY intense gravity dip

        // Layer B: REMOVED - fake POE rebalancing removed in favor of proper geometry bundles
        // Use separate Layer A/B bundles with different segment weights instead

        // Queue mode: Particles slow down and cluster at POEs
        this.queueMode = false;
        this.queueData = null;         // Current hour's queue values { poe: val, ... }
        this.queueSpeedFactor = 0.15;  // Slow to 15% speed in queue mode

        // Pre-allocated buffers for particle handoff (avoid GC pressure)
        this._handoffValidConns = new Array(32);  // Max 32 connections per node
        this._handoffWeights = new Float32Array(32);
        this._handoffCount = 0;

        // Object pool for particles (avoid GC pressure from spawn/death churn)
        this._particlePool = [];
        this._particlePoolMax = 5000;  // Keep up to 5k recycled particles

        // Debug: handoff failure visualization
        this._handoffFailures = [];  // { x, y, t } - position and timestamp
        this._handoffFailureMaxAge = 3;  // seconds to show failure marker
    }

    get paused() {
        return this._paused;
    }

    set paused(val) {
        const wasPaused = this._paused;
        this._paused = val;
        // Reset spawn ramp when unpausing
        if (wasPaused && !val) {
            this._spawnElapsedSec = 0;
        }
    }

    /**
     * DEV: Snapshot current particle positions as "ghosts" for comparison.
     * Ghosts render in green while current particles can be red.
     */
    devSnapshotGhosts() {
        this._devGhostParticles = [];
        for (const p of this.particles) {
            if (p.dead) continue;
            const seg = p.seg || this.segments.get(p.segmentId);
            if (!seg || !seg.polyline || !seg.cumLengths) continue;

            // Compute world position from seg and s
            const sNorm = ((p.s % seg.totalLength) + seg.totalLength) % seg.totalLength;
            let lo = 0, hi = seg.cumLengths.length - 1;
            while (lo < hi - 1) {
                const mid = (lo + hi) >> 1;
                if (seg.cumLengths[mid] <= sNorm) lo = mid;
                else hi = mid;
            }
            const s0 = seg.cumLengths[lo];
            const s1 = seg.cumLengths[lo + 1];
            const t = s1 > s0 ? (sNorm - s0) / (s1 - s0) : 0;
            const p0 = seg.polyline[lo];
            const p1 = seg.polyline[lo + 1];
            const worldX = p0.x + t * (p1.x - p0.x);
            const worldY = p0.y + t * (p1.y - p0.y);

            this._devGhostParticles.push({ x: worldX, y: worldY });
        }
        console.log(`[DEV] Snapshotted ${this._devGhostParticles.length} ghost particles`);
    }

    /**
     * DEV: Clear ghost particles.
     */
    devClearGhosts() {
        this._devGhostParticles = null;
        console.log('[DEV] Cleared ghost particles');
    }

    /**
     * Clear all live particles (for comparison mode respawn).
     */
    clearAllParticles() {
        const aliveCount = this.particles.filter(p => !p.dead).length;
        for (const p of this.particles) {
            p.dead = true;
        }
        console.log(`[MacroParticles] Cleared ${aliveCount} particles`);
    }

    /**
     * Set WebGL renderer for GPU-accelerated particle drawing.
     * @param {ParticleRenderer} renderer
     */
    setWebGLRenderer(renderer) {
        this._glRenderer = renderer;
        // Pre-allocate buffers
        this._glPositions = new Float32Array(this.maxParticles * 2);
        this._glColors = new Float32Array(this.maxParticles * 3);
        console.log('[MacroParticles] WebGL renderer enabled');
    }

    /**
     * Set potential field for gravity sink effect.
     * Particles visually "flow downhill" into destination wells.
     * @param {PotentialField} field - From potentialField.js
     */
    setPotentialField(field) {
        this.potentialField = field;
        console.log(`[MacroParticles] Potential field set with ${field?.sinks?.length || 0} sinks`);
    }



    /**
     * Enable/disable queue mode.
     * In queue mode, particles slow down and cluster at POE endpoints.
     * @param {boolean} enabled
     * @param {Object} queueData - Current hour's queue values { poe: value, ... }
     */
    setQueueMode(enabled, queueData = null) {
        this.queueMode = enabled;
        this.queueData = queueData;
        console.log(`[MacroParticles] Queue mode: ${enabled ? 'ON' : 'OFF'}`);
    }

    /**
     * Toggle debug tracer mode - flickering lightshow (x key).
     */
    toggleDebugTracers() {
        this.debugTracers = !this.debugTracers;
        this._tracerLoggedOnce = false;  // reset log flag
        if (this.debugTracers) this.debugTracersStable = false;  // only one mode at a time
        console.log(`[MacroParticles] Debug tracers (lightshow): ${this.debugTracers ? 'ON' : 'OFF'}`);
        return this.debugTracers;
    }

    /**
     * Toggle stable debug tracer mode - clean diagnostic view (c key).
     */
    toggleDebugTracersStable() {
        this.debugTracersStable = !this.debugTracersStable;
        if (this.debugTracersStable) this.debugTracers = false;  // only one mode at a time
        console.log(`[MacroParticles] Debug tracers (stable): ${this.debugTracersStable ? 'ON' : 'OFF'}`);
        return this.debugTracersStable;
    }

    /**
     * Set the per-segment POE distributions for both scenarios.
     * @param {Map} baselineDist - POE distribution from baseline bundle
     * @param {Map} interserranaDist - POE distribution from interserrana bundle (can be null)
     */
    setScenarioPoeDistributions(baselineDist, interserranaDist) {
        this.baselinePoeDistribution = baselineDist || new Map();
        this.interserranaPoeDistribution = interserranaDist || new Map();
        console.log(`[MacroParticles] POE distributions set: baseline=${baselineDist?.size || 0}, interserrana=${interserranaDist?.size || 0}`);
    }

    /**
     * Set the scenario alpha (0 = baseline, 1 = interserrana).
     * This determines which POE distribution is used when spawning new particles.
     * @param {number} alpha
     */
    setScenarioAlpha(alpha) {
        this.scenarioAlpha = alpha;
    }

    /**
     * Set destination routing data (US-side routing).
     * @param {Object} destLoads - segment_load_kg_by_destination_hs2 { dest: { hs2: { segId: kg } } }
     * @param {Object} poeDestDist - poe_to_destination_distribution { poe: { dest: prob } }
     */
    setDestinationData(destLoads, poeDestDist) {
        this.poeDestinationDistribution = poeDestDist || {};

        // Index destination loads by Segment ID for fast lookup: SegID -> { destId: weight }
        this.segmentDestinationWeights = new Map();

        if (destLoads) {
            for (const [dest, hs2Map] of Object.entries(destLoads)) {
                for (const segMap of Object.values(hs2Map)) {
                    for (const [segId, kg] of Object.entries(segMap)) {
                        let map = this.segmentDestinationWeights.get(segId);
                        if (!map) {
                            map = {};
                            this.segmentDestinationWeights.set(segId, map);
                        }
                        // Sum over HS2s if multiple exist (unlikely for dumb particle but safe)
                        map[dest] = (map[dest] || 0) + kg;
                    }
                }
            }
        }
        console.log(`[MacroParticles] Destination data set: ${Object.keys(this.poeDestinationDistribution).length} POEs, ${this.segmentDestinationWeights.size} segments`);
    }

    /**
     * Set particle density multiplier (for narrative emphasis).
     * Higher values = more particles on screen.
     * @param {number} multiplier - 1.0 = normal, 2.0 = double, etc.
     */
    setDensityMultiplier(multiplier) {
        this._densityMultiplier = multiplier;
        this.spawnPerSecondBudget = this._baseBudget * multiplier;
        // Also increase max particles cap proportionally
        this.maxParticles = Math.round(this._baseMaxParticles * multiplier);
        console.log(`[MacroParticles] Density multiplier: ${multiplier}x (budget: ${this.spawnPerSecondBudget}, max: ${this.maxParticles})`);
    }

    /**
     * Toggle Pharr highlight mode (P key).
     * When on, Pharr particles are black, others are very faint grey.
     */
    togglePharrHighlight() {
        this.pharrHighlightMode = !this.pharrHighlightMode;
        console.log(`[MacroParticles] Pharr highlight: ${this.pharrHighlightMode ? 'ON' : 'OFF'}`);
        // Log POE distribution stats
        if (this.particles.length > 0) {
            const samplePoes = this.particles.slice(0, 10).map(p => p.poeId);
            console.log(`[MacroParticles] Sample particle POEs:`, samplePoes);
            const pharrCount = samplePoes.filter(poe => poe === this.highlightPoe).length;
            console.log(`[MacroParticles] Pharr particles in sample: ${pharrCount}/10`);
        }
        return this.pharrHighlightMode;
    }

    toggleDarkMode() {
        this.darkMode = !this.darkMode;
        console.log(`[MacroParticles] Dark mode: ${this.darkMode ? 'ON' : 'OFF'}`);
        return this.darkMode;
    }

    /**
     * Enable corridor highlight mode with magenta hierarchy.
     * Primary POE: full brightness magenta
     * Secondary POE: 0.7 brightness magenta
     * Others: dimmed white
     * @param {string} primaryPoe - POE ID for full brightness (e.g., 'NLD')
     * @param {string} secondaryPoe - POE ID for reduced brightness (e.g., 'hidalgo_pharr')
     */
    setCorridorHighlight(primaryPoe, secondaryPoe, equalBrightness = false) {
        this.corridorHighlightMode = true;
        this.corridorPrimaryPoe = primaryPoe;
        this.corridorSecondaryPoe = secondaryPoe;
        this.corridorEqualBrightness = equalBrightness;
        this.corridorHighlightPoes = new Set([primaryPoe, secondaryPoe]);
        console.log(`[MacroParticles] Corridor highlight ON: primary=${primaryPoe}, secondary=${secondaryPoe}, equalBrightness=${equalBrightness}`);
        // Log POE distribution stats (same as togglePharrHighlight)
        if (this.particles.length > 0) {
            const samplePoes = this.particles.slice(0, 50).map(p => p.poeId);
            console.log(`[MacroParticles] Sample particle POEs:`, samplePoes);
            const primaryCount = samplePoes.filter(poe => poe === primaryPoe).length;
            const secondaryCount = samplePoes.filter(poe => poe === secondaryPoe).length;
            console.log(`[MacroParticles] Primary (${primaryPoe}): ${primaryCount}/50, Secondary (${secondaryPoe}): ${secondaryCount}/50`);
        }
    }

    /**
     * Clear corridor highlight mode, restore normal white rendering.
     */
    clearCorridorHighlight() {
        this.corridorHighlightMode = false;
        this.corridorPrimaryPoe = null;
        this.corridorSecondaryPoe = null;
        this.corridorEqualBrightness = false;
        this.corridorHighlightPoes.clear();
        this.hideNonHighlightedParticles = false;
        this.nonHighlightedAlpha = 1.0;
        this.highlightedAlpha = 1.0;
        this.poeColorOverrides.clear();
        console.log('[MacroParticles] Corridor highlight OFF');
    }

    /**
     * Hide non-highlighted particles (only show primary/secondary POE particles).
     */
    hideNonHighlighted() {
        this.hideNonHighlightedParticles = true;
        console.log('[MacroParticles] Non-highlighted particles hidden');
    }

    /**
     * Show non-highlighted particles again.
     */
    showNonHighlighted() {
        this.hideNonHighlightedParticles = false;
        console.log('[MacroParticles] Non-highlighted particles shown');
    }

    /**
     * Dim non-highlighted corridors instead of hiding them completely.
     * @param {number} dimAlpha - Alpha value for non-highlighted corridors (0-1)
     * @param {number} highlightAlpha - Alpha value for highlighted corridors (0-1), default 1.0
     */
    dimNonHighlighted(dimAlpha, highlightAlpha = 1.0) {
        this.nonHighlightedAlpha = Math.max(0, Math.min(1, dimAlpha));
        this.highlightedAlpha = Math.max(0, Math.min(1, highlightAlpha));
        this.hideNonHighlightedParticles = false;  // Don't fully hide
        console.log(`[MacroParticles] Corridor alphas: highlighted=${this.highlightedAlpha}, dimmed=${this.nonHighlightedAlpha}`);
    }

    /**
     * Set color override for a specific POE corridor.
     * @param {string} poe - POE ID (e.g., 'laredo', 'hidalgo_pharr')
     * @param {string} color - Color name ('white', 'magenta', or null to clear)
     */
    setCorridorColor(poe, color) {
        if (color === null) {
            this.poeColorOverrides.delete(poe);
            console.log(`[MacroParticles] Cleared color override for ${poe}`);
        } else {
            this.poeColorOverrides.set(poe, color);
            console.log(`[MacroParticles] Set ${poe} corridor color to ${color}`);
        }
    }

    /**
     * Add or update a segment.
     * @param {string} segmentId
     * @param {Array<{x: number, y: number}>} polyline - Ordered points
     * @param {number} weight - Flow weight (normalized 0-1 or kg/hr)
     */
    addSegment(segmentId, polyline, weight) {
        if (polyline.length < 2) return;

        let seg = this.segments.get(segmentId);
        if (!seg) {
            seg = {
                id: segmentId,
                polyline,
                weight,
                lengths: [],
                cumLengths: [0],
                totalLength: 0,
                bbox: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
            };
            this.segments.set(segmentId, seg);
        } else {
            seg.weight = weight;
        }

        // Precompute geometry
        this._computeSegmentGeometry(seg);
        this._updateFlowRange();
    }

    /**
     * Update weights for all segments (smooth interpolation during scenario toggle).
     * @param {function(string): number | Map<string, number>} weightsOrFn - Map or function
     */
    updateWeights(weightsOrFn) {
        if (typeof weightsOrFn === 'function') {
            for (const [segId, seg] of this.segments) {
                seg.weight = weightsOrFn(segId);
            }
        } else if (weightsOrFn instanceof Map) {
            for (const [segId, seg] of this.segments) {
                seg.weight = weightsOrFn.get(segId) ?? 0;
            }
        } else {
            // Plain object
            for (const [segId, seg] of this.segments) {
                seg.weight = weightsOrFn[segId] ?? 0;
            }
        }
        this._updateFlowRange();
    }

    /**
     * Remove a segment and kill its particles.
     */
    removeSegment(segmentId) {
        this.segments.delete(segmentId);
        // Kill particles on this segment
        this.particles = this.particles.filter(p => p.segmentId !== segmentId);
    }

    /**
     * Clear all segments and particles.
     */
    clear() {
        this.segments.clear();
        this.particles = [];
        this._spawnResidual = 0;
    }

    /**
     * Immediately populate particles without viewport culling.
     * Call after adding all segments to ensure visibility on first frame.
     * @param {number} [count] - Target particle count (default: half of maxParticles, capped at 5000)
     */
    populateImmediate(count = null) {
        const targetCount = count ?? Math.min(this.maxParticles / 2, 10000);
        const allSegments = [...this.segments.values()].filter(s => s.weight > this.spawnEpsilon && s.totalLength > 0);
        if (allSegments.length === 0) {
            console.log('[MacroParticles] populateImmediate: no active segments');
            return;
        }

        // Build weight distribution from ALL segments (no viewport cull)
        let totalW = 0;
        for (const seg of allSegments) totalW += seg.weight;

        const toSpawn = Math.min(targetCount, this.maxParticles - this.particles.length);
        for (let i = 0; i < toSpawn; i++) {
            const seg = this._pickFromAll(allSegments, totalW);
            if (seg) this._spawnParticle(seg);
        }

        console.log(`[MacroParticles] populateImmediate: spawned ${toSpawn} particles across ${allSegments.length} segments`);
    }

    /**
     * Pick a segment from a list by weight (no viewport culling).
     * @private
     */
    _pickFromAll(segments, totalW) {
        if (totalW <= 0) return null;
        const r = Math.random() * totalW;
        let cumW = 0;
        for (const seg of segments) {
            cumW += seg.weight;
            if (cumW >= r) return seg;
        }
        return segments[segments.length - 1] || null;
    }

    /**
     * Update particle positions and spawn new ones.
     * @param {number} dt - Frame delta in seconds
     * @param {object} camera - Camera with viewportWorld bounds
     */
    update(dt, camera) {
        if (this.paused) return;

        const frameStart = performance.now();

        // Clamp dt to prevent massive bursts after frame drops (max 100ms)
        const clampedDt = Math.min(dt, 0.1);

        // Track elapsed time for spawn ramp-up
        this._spawnElapsedSec += clampedDt;

        // Disabled - too noisy. Uncomment for spawn debugging:
        // if (this._diagEnabled && this._diagFrame < 5) {
        //     console.log(`[SPAWN DEBUG] dt=${dt.toFixed(4)} spawnBudgetPerS=${this.spawnPerSecondBudget.toFixed(1)} multiplier=${this._spawnMultiplier.toFixed(2)}`);
        // }

        // Update existing particles
        const t1 = performance.now();
        this._updateParticles(clampedDt);
        const t2 = performance.now();

        // Spawn new particles (viewport-culled), distributed across active corridors by weight
        this._spawnParticlesBudgeted(clampedDt, camera);
        const t3 = performance.now();

        // Kill old particles
        this._cullDeadParticles();
        const t4 = performance.now();

        // Log probe particle advancement (throttled)
        this._logProbe(clampedDt);

        // Timing diagnostic (every 600 frames = ~10s at 60fps)
        if (this._diagEnabled && this._diagFrame % 600 === 0 && this._diagFrame > 0) {
            console.log(`[UPDATE TIMING] update=${(t2 - t1).toFixed(2)}ms spawn=${(t3 - t2).toFixed(2)}ms cull=${(t4 - t3).toFixed(2)}ms total=${(t4 - t1).toFixed(2)}ms`);
        }

        // Handoff debug logging (every 5s)
        if (this._handoffDbgCounts) {
            this._handoffDbgT = (this._handoffDbgT || 0) + clampedDt;
            if (this._handoffDbgT >= 5) {
                const c = this._handoffDbgCounts;
                if (c.totalFallback > 0) {
                    console.log(`[HANDOFF DBG] fallbacks=${c.totalFallback} noPoeDistCaused=${c.noPoeDistFallback} poeNotFoundCaused=${c.poeNotFoundFallback}`);
                }
                this._handoffDbgCounts = { noPoeDistFallback: 0, poeNotFoundFallback: 0, totalFallback: 0 };
                this._handoffDbgT = 0;
            }
        }

        // POE cone integrity stats (every 10s)
        this._coneStatsLogT += clampedDt;
        if (this._coneStatsLogT >= 10) {
            const s = this._coneStats;
            const total = s.onCone + s.offCone;
            if (total > 0) {
                const offPct = (s.offCone / total * 100).toFixed(1);
                const reentryRate = s.offCone > 0 ? (s.reentries / s.offCone * 100).toFixed(0) : 'n/a';
                console.log(`[CONE STATS] onCone=${s.onCone} offCone=${s.offCone} (${offPct}%) reentries=${s.reentries} (${reentryRate}%) budgetKills=${s.budgetKills}`);
            }
            this._coneStats = { onCone: 0, offCone: 0, budgetKills: 0, reentries: 0 };
            this._coneStatsLogT = 0;
        }

        // Adjust spawn rate based on frame time
        if (this._lastFrameStart > 0) {
            const frameTimeMs = frameStart - this._lastFrameStart;
            this._adjustSpawnRate(frameTimeMs);
        }
        this._lastFrameStart = frameStart;
    }

    /**
     * Dynamically adjust spawn rate based on frame time.
     * Throttles spawning when performance drops, recovers when headroom available.
     * @private
     */
    _adjustSpawnRate(frameTimeMs) {
        // EMA of frame time
        this._frameTimeEMA = this._perfAlpha * frameTimeMs + (1 - this._perfAlpha) * this._frameTimeEMA;

        // Target: 16ms (60fps). If above 20ms, throttle. If below 14ms, recover.
        if (this._frameTimeEMA > 20) {
            this._spawnMultiplier = Math.max(0.3, this._spawnMultiplier * 0.95);
        } else if (this._frameTimeEMA < 14 && this._spawnMultiplier < 1.0) {
            this._spawnMultiplier = Math.min(1.0, this._spawnMultiplier * 1.02);
        }
    }

    /**
     * Draw particles with lateral spread and trailing dots.
     * OPTIMIZED: Batched draw calls, skip trails at macro zoom, cached segment refs,
     * typed arrays for bucket data, inlined transforms, skip lateral at macro.
     * WebGL path: If _glRenderer is set, uses GPU for particle rendering.
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} camera - Camera with worldToScreen()
     * @param {object} [opts] - Options { color: '#000' }
     */
    draw(ctx, camera, opts = {}) {
        if (!camera?.worldToScreen) return;

        // WebGL path: GPU-accelerated particle rendering (includes corridor highlight)
        // Skip WebGL only when debug tracers active (need canvas for line drawing)
        if (this._glRenderer && this._glRenderer.isAvailable() && !this.debugTracers) {
            if (this.particlesVisible) {
                this._drawWebGL(camera);
            } else {
                // Clear WebGL canvas when particles hidden
                this.clearWebGL();
            }
            // Draw stable tracers on 2D canvas (after WebGL particles)
            if (this.debugTracersStable) {
                ctx.save();
                this._drawDebugTracersStable(ctx, camera);
                ctx.restore();
            }
            // Draw handoff failure markers (red circles) - also in WebGL path
            this._drawHandoffFailures(ctx, camera);
            // DEV: Ghost particles (green) - also in WebGL path
            this._drawDevGhosts(ctx, camera);
            return;
        }

        // Clear WebGL canvas when using canvas path (debug tracers only)
        if (this._glRenderer && this.debugTracers) {
            this.clearWebGL();
        }

        ctx.save();
        const color = this.devColorOverride ?? opts.color ?? (this.darkMode ? '#909090' : '#000');  // DEV override takes priority

        // Skip viewport culling at macro zoom (< 0.01) for visibility
        const zoom = camera.zoom || 0.02;
        const skipCull = zoom < 0.01;
        const vp = skipCull ? null : camera.viewportWorld;
        const pad = this._getViewportPadding(vp);
        const radius = this._particleRadius(camera);

        // Skip trails AND lateral offset at macro zoom (invisible, saves tons of math)
        const drawTrails = zoom > 0.005;
        const applyLateral = zoom > 0.003;

        // Size scaling by weight (minimal - all particles same tiny size)
        const sizeScaleMin = 1.0;
        const sizeScaleRange = 0.0;
        const flowMaxInv = 1 / (this.flowMax || 1);

        // Inline camera transform constants (avoid function call overhead)
        const camCenterX = camera.centerWorld.x;
        const camCenterY = camera.centerWorld.y;
        const canvasHalfW = camera.canvasWidth / 2;
        const canvasHalfH = camera.canvasHeight / 2;

        // Use persistent flat arrays (avoid GC pressure)
        // Format: [x0, y0, r0, x1, y1, r1, ...]
        const requiredSize = this.particles.length * 3;
        if (this._drawBufferSize < requiredSize) {
            // Only reallocate when we need more space (grows, never shrinks)
            this._drawBufferSize = Math.max(requiredSize, 30000);  // Min 10k particles
            this._drawBucketData = [
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
            ];
            // Allocate Pharr/primary buckets (same size)
            this._drawPharrBucketData = [
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
            ];
            // Allocate secondary POE buckets (same size)
            this._drawSecondaryBucketData = [
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
                new Float32Array(this._drawBufferSize),
            ];
        }
        const bucketData = this._drawBucketData;
        const bucketCounts = this._drawBucketCounts;
        bucketCounts[0] = bucketCounts[1] = bucketCounts[2] = bucketCounts[3] = bucketCounts[4] = 0;

        // Highlight mode: separate buckets for highlighted particles (Pharr or corridor)
        const pharrMode = this.pharrHighlightMode;
        const corridorMode = this.corridorHighlightMode;
        const anyHighlightMode = pharrMode || corridorMode;
        const primaryBucketData = this._drawPharrBucketData;
        const primaryBucketCounts = this._drawPharrBucketCounts;
        const secondaryBucketData = this._drawSecondaryBucketData;
        const secondaryBucketCounts = this._drawSecondaryBucketCounts;
        if (anyHighlightMode) {
            primaryBucketCounts[0] = primaryBucketCounts[1] = primaryBucketCounts[2] = primaryBucketCounts[3] = primaryBucketCounts[4] = 0;
            secondaryBucketCounts[0] = secondaryBucketCounts[1] = secondaryBucketCounts[2] = secondaryBucketCounts[3] = secondaryBucketCounts[4] = 0;
        }

        for (let pi = 0; pi < this.particles.length; pi++) {
            const p = this.particles[pi];
            const seg = p.seg;
            if (!seg) continue;

            // Viewport cull
            if (vp) {
                if (seg.bbox.maxX < vp.minX - pad || seg.bbox.minX > vp.maxX + pad ||
                    seg.bbox.maxY < vp.minY - pad || seg.bbox.minY > vp.maxY + pad) {
                    continue;
                }
            }

            // Full opacity - no fade at birth/death
            const len = seg.totalLength;
            const bucketIdx = 4;

            // Size by weight (sqrt for perceptual scaling)
            const w = seg.weight * flowMaxInv;
            const sizeScale = sizeScaleMin + Math.sqrt(w > 1 ? 1 : w) * sizeScaleRange;
            const particleR = radius * sizeScale;

            // Position on segment (inlined for speed)
            const sNorm = ((p.s % seg.totalLength) + seg.totalLength) % seg.totalLength;
            let lo = 0, hi = seg.cumLengths.length - 1;
            while (lo < hi - 1) {
                const mid = (lo + hi) >> 1;
                if (seg.cumLengths[mid] <= sNorm) lo = mid;
                else hi = mid;
            }
            const s0 = seg.cumLengths[lo];
            const s1 = seg.cumLengths[lo + 1];
            const t = s1 > s0 ? (sNorm - s0) / (s1 - s0) : 0;
            const p0 = seg.polyline[lo];
            const p1 = seg.polyline[lo + 1];
            let worldX = p0.x + t * (p1.x - p0.x);
            let worldY = p0.y + t * (p1.y - p0.y);

            // Lateral offset (skip at macro zoom)
            if (applyLateral && p.lateralSeed !== undefined) {
                const lateralOffset = Math.sin(p.lateralPhase) * p.lateralSeed * this.lateralSpreadM;
                if (lateralOffset > 1 || lateralOffset < -1) {
                    const dx = p1.x - p0.x;
                    const dy = p1.y - p0.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 1e-6) {
                        // Normal is (-dy, dx) / len
                        worldX += (-dy / len) * lateralOffset;
                        worldY += (dx / len) * lateralOffset;
                    }
                }
            }

            // Sample potential field for Z-displacement (gravity sink effect)
            let zOffset = 0;
            if (this.potentialField) {
                const z = this.potentialField.sampleZ(worldX, worldY);
                zOffset = z * this.zScale;
                // Debug: log once per 1000 particles
                if (i === 0 && this._diagFrame % 60 === 0) {
                    console.log(`[GravitySink] z=${z.toFixed(2)}, zOffset=${zOffset.toFixed(2)}, zScale=${this.zScale}`);
                }
            }

            // Inline worldToScreen (negative Z = pull down on screen)
            // Note: zOffset is in screen pixels, NOT multiplied by zoom
            const screenX = canvasHalfW + (worldX - camCenterX) * zoom;
            const screenY = canvasHalfH - (worldY - camCenterY) * zoom - zOffset;

            // Store in flat array (route to primary/secondary/regular bucket based on mode)
            // Three-way classification for corridor mode: primary (full magenta), secondary (0.7 magenta), other (dimmed white)
            let targetBucket = 'regular';
            if (corridorMode) {
                if (p.poeId === this.corridorPrimaryPoe) {
                    targetBucket = 'primary';
                } else if (p.poeId === this.corridorSecondaryPoe) {
                    targetBucket = 'secondary';
                }
            } else if (pharrMode && p.poeId === this.highlightPoe) {
                targetBucket = 'primary';
            }

            if (targetBucket === 'primary') {
                // Primary POE → full brightness magenta
                const arr = primaryBucketData[bucketIdx];
                const idx = primaryBucketCounts[bucketIdx] * 3;
                arr[idx] = screenX;
                arr[idx + 1] = screenY;
                arr[idx + 2] = particleR;
                primaryBucketCounts[bucketIdx]++;
            } else if (targetBucket === 'secondary') {
                // Secondary POE → 0.7 brightness magenta
                const arr = secondaryBucketData[bucketIdx];
                const idx = secondaryBucketCounts[bucketIdx] * 3;
                arr[idx] = screenX;
                arr[idx + 1] = screenY;
                arr[idx + 2] = particleR;
                secondaryBucketCounts[bucketIdx]++;
            } else {
                // Other particle → goes to regular bucket (dimmed white in corridor mode)
                const arr = bucketData[bucketIdx];
                const idx = bucketCounts[bucketIdx] * 3;
                arr[idx] = screenX;
                arr[idx + 1] = screenY;
                arr[idx + 2] = particleR;
                bucketCounts[bucketIdx]++;
            }
        }

        // Draw all buckets (skip if particles hidden)
        if (!this.particlesVisible) {
            // Skip particle drawing
        } else if (corridorMode) {
            // Corridor highlight mode with magenta hierarchy
            // Magenta = semantic signal (same as local congestion)
            // Brightness = hierarchy (Laredo=1.0, Pharr=0.7)

            // 1. Draw OTHER particles (dimmed white, or skip if fully hidden)
            if (!this.hideNonHighlightedParticles && this.nonHighlightedAlpha > 0) {
                ctx.fillStyle = color;  // Normal particle color (white)
                for (let i = 0; i < 5; i++) {
                    const count = bucketCounts[i];
                    if (count === 0) continue;
                    ctx.globalAlpha = ((i + 0.5) / 5) * this.nonHighlightedAlpha;
                    ctx.beginPath();
                    const arr = bucketData[i];
                    for (let j = 0; j < count; j++) {
                        const idx = j * 3;
                        const x = arr[idx];
                        const y = arr[idx + 1];
                        const r = arr[idx + 2];
                        ctx.moveTo(x + r, y);
                        ctx.arc(x, y, r, 0, 6.283185307);
                    }
                    ctx.fill();
                }
            }

            // Helper: get color for POE (check overrides, default to magenta)
            const getPoeFillStyle = (poe, defaultMagenta) => {
                const override = this.poeColorOverrides.get(poe);
                if (override === 'white') return color;  // Use normal white color
                return defaultMagenta;  // Use magenta
            };
            const getPoeIsWhite = (poe) => this.poeColorOverrides.get(poe) === 'white';

            // 2. Draw SECONDARY POE (Pharr) - magenta or white if overridden
            const secondaryIsWhite = getPoeIsWhite(this.corridorSecondaryPoe);
            ctx.fillStyle = secondaryIsWhite ? color : (this.corridorEqualBrightness ? '#ff00ff' : '#b300b3');
            ctx.globalAlpha = secondaryIsWhite
                ? this.nonHighlightedAlpha
                : this.highlightedAlpha * (this.corridorEqualBrightness ? 1.0 : 0.85);
            for (let i = 0; i < 5; i++) {
                const count = secondaryBucketCounts[i];
                if (count === 0) continue;
                ctx.beginPath();
                const arr = secondaryBucketData[i];
                for (let j = 0; j < count; j++) {
                    const idx = j * 3;
                    const x = arr[idx];
                    const y = arr[idx + 1];
                    const r = arr[idx + 2];
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, 6.283185307);
                }
                ctx.fill();
            }

            // 3. Draw PRIMARY POE (Laredo) - magenta at full alpha, or white with bucket alpha
            const primaryIsWhite = getPoeIsWhite(this.corridorPrimaryPoe);
            ctx.fillStyle = primaryIsWhite ? color : '#ff00ff';  // Magenta or white
            for (let i = 0; i < 5; i++) {
                const count = primaryBucketCounts[i];
                if (count === 0) continue;
                // When white, use same bucket-based alpha as other white particles
                // When magenta, use highlightedAlpha (same as secondary)
                ctx.globalAlpha = primaryIsWhite
                    ? ((i + 0.5) / 5) * this.nonHighlightedAlpha
                    : this.highlightedAlpha;
                ctx.beginPath();
                const arr = primaryBucketData[i];
                for (let j = 0; j < count; j++) {
                    const idx = j * 3;
                    const x = arr[idx];
                    const y = arr[idx + 1];
                    const r = arr[idx + 2];
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, 6.283185307);
                }
                ctx.fill();
            }
        } else if (pharrMode) {
            // Pharr highlight mode: hide non-Pharr particles, only draw Pharr
            // Pharr particles (contrasting color)
            ctx.fillStyle = this.darkMode ? '#e0e0e0' : '#000';
            for (let i = 0; i < 5; i++) {
                const count = primaryBucketCounts[i];
                if (count === 0) continue;
                ctx.globalAlpha = (i + 0.5) / 5;
                ctx.beginPath();
                const arr = primaryBucketData[i];
                for (let j = 0; j < count; j++) {
                    const idx = j * 3;
                    const x = arr[idx];
                    const y = arr[idx + 1];
                    const r = arr[idx + 2];
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, 6.283185307);
                }
                ctx.fill();
            }
        } else {
            // Normal mode: all particles black
            ctx.fillStyle = color;
            for (let i = 0; i < 5; i++) {
                const count = bucketCounts[i];
                if (count === 0) continue;
                ctx.globalAlpha = (i + 0.5) / 5;
                ctx.beginPath();
                const arr = bucketData[i];
                for (let j = 0; j < count; j++) {
                    const idx = j * 3;
                    const x = arr[idx];
                    const y = arr[idx + 1];
                    const r = arr[idx + 2];
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, 6.283185307);
                }
                ctx.fill();
            }
        }

        // Debug tracers stable (C key) - drawn after particles
        if (this.debugTracersStable) {
            this._drawDebugTracersStable(ctx, camera);
        }

        // DEV: Ghost particles (green, frozen positions from snapshot)
        this._drawDevGhosts(ctx, camera);

        // Debug tracers (X key) - drawn on top of everything
        if (this.debugTracers) {
            this._drawDebugTracers(ctx, camera);
        }

        // Draw handoff failure markers (red circles)
        this._drawHandoffFailures(ctx, camera);

        ctx.restore();
    }

    _drawHandoffFailures(ctx, camera) {
        if (this._handoffFailures.length === 0) return;
        const now = performance.now();
        const maxAgeMs = this._handoffFailureMaxAge * 1000;
        ctx.save();
        ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        ctx.beginPath();
        for (let i = this._handoffFailures.length - 1; i >= 0; i--) {
            const f = this._handoffFailures[i];
            const age = now - f.t;
            if (age > maxAgeMs) {
                this._handoffFailures.splice(i, 1);
                continue;
            }
            const screen = camera.worldToScreen(f.x, f.y);
            const r = 8 + (age / maxAgeMs) * 12;  // grows as it fades
            ctx.moveTo(screen.x + r, screen.y);
            ctx.arc(screen.x, screen.y, r, 0, 6.283185307);
        }
        ctx.fill();
        ctx.restore();
    }

    /**
     * DEV: Draw ghost particles (green, frozen positions from snapshot).
     * @private
     */
    _drawDevGhosts(ctx, camera) {
        if (!this._devGhostParticles || this._devGhostParticles.length === 0) return;
        // Debug: log once per second
        if (!this._devGhostLogT) this._devGhostLogT = 0;
        this._devGhostLogT++;
        if (this._devGhostLogT % 60 === 1) {
            console.log(`[DEV] Drawing ${this._devGhostParticles.length} ghosts`);
        }

        const zoom = camera.zoom || 0.02;
        const camCenterX = camera.centerWorld.x;
        const camCenterY = camera.centerWorld.y;
        const canvasHalfW = camera.canvasWidth / 2;
        const canvasHalfH = camera.canvasHeight / 2;
        const ghostRadius = this._particleRadius(camera);  // Same size as regular particles

        ctx.save();
        ctx.fillStyle = this._devGhostColor;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        for (const g of this._devGhostParticles) {
            const sx = canvasHalfW + (g.x - camCenterX) * zoom;
            const sy = canvasHalfH - (g.y - camCenterY) * zoom;
            ctx.moveTo(sx + ghostRadius, sy);
            ctx.arc(sx, sy, ghostRadius, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.restore();
    }

    /**
     * Draw debug tracers for all active segments with unified breathing.
     * All segments pulse together as one organism.
     * @private
     */
    _drawDebugTracers(ctx, camera) {
        const zoom = camera.zoom || 0.02;
        const cx = camera.centerWorld.x;
        const cy = camera.centerWorld.y;
        const hw = camera.canvasWidth / 2;
        const hh = camera.canvasHeight / 2;

        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.8;

        let drawn = 0;
        let skipped = 0;

        // Draw connected segments in cyan, skip noConn segments entirely
        ctx.strokeStyle = '#00ffff';
        for (const seg of this.segments.values()) {
            const conn = this._connectivity.get(seg.id);
            if (conn && conn.fromEnd.length === 0) {
                skipped++;
                continue; // skip noConn segments
            }

            const poly = seg.polyline;
            if (!poly || poly.length < 2) continue;

            ctx.beginPath();
            ctx.moveTo(hw + (poly[0].x - cx) * zoom, hh - (poly[0].y - cy) * zoom);
            for (let j = 1; j < poly.length; j++) {
                ctx.lineTo(hw + (poly[j].x - cx) * zoom, hh - (poly[j].y - cy) * zoom);
            }
            ctx.stroke();
            drawn++;
        }

        if (!this._tracerLoggedOnce) {
            console.log(`[DebugTracers] drawn=${drawn} segments, skipped=${skipped} noConn, zoom=${zoom}`);
            this._tracerLoggedOnce = true;
        }

        ctx.globalAlpha = 1;
    }

    /**
     * Draw stable debug tracers (no flicker, clean diagnostic view).
     * @private
     */
    _drawDebugTracersStable(ctx, camera) {
        // Reset state for clean rendering
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(2, camera.metersToPixels ? camera.metersToPixels(500) : 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const seg of this.segments.values()) {
            if (seg.totalLength === 0) continue;
            const w = seg.weight;
            // Show ALL segments for topology debugging
            // Zero-weight segments shown in gray

            // Color by weight: red = high, blue = low, gray = zero
            const hue = w > 0 ? (1 - Math.min(1, w)) * 240 : 0;  // 240 (blue) → 0 (red)
            const sat = w > 0 ? 80 : 0;  // gray for zero weight
            const lum = w > 0 ? 50 : 30;  // darker gray for zero weight
            ctx.strokeStyle = `hsl(${hue}, ${sat}%, ${lum}%)`;

            ctx.beginPath();
            for (let i = 0; i < seg.polyline.length; i++) {
                const pt = seg.polyline[i];
                const screen = camera.worldToScreen(pt.x, pt.y);
                if (i === 0) ctx.moveTo(screen.x, screen.y);
                else ctx.lineTo(screen.x, screen.y);
            }
            ctx.stroke();
        }

        // Draw stats overlay with background
        const activeCount = [...this.segments.values()].filter(s => s.weight > this.spawnEpsilon).length;
        const text = `[STABLE] Segments: ${activeCount} | Particles: ${this.particles.length} | Multiplier: ${this._spawnMultiplier.toFixed(2)}`;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(5, 5, ctx.measureText(text).width + 10, 22);

        ctx.fillStyle = '#0f0';
        ctx.font = '12px monospace';
        ctx.fillText(text, 10, 20);
    }

    /**
     * Clear the WebGL canvas (call when particles shouldn't be shown).
     */
    clearWebGL() {
        if (this._glRenderer && this._glRenderer.isAvailable()) {
            const gl = this._glRenderer.gl;
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
    }

    /**
     * WebGL rendering path - GPU-accelerated particles.
     * Supports corridor highlight mode with magenta coloring.
     * @private
     */
    _drawWebGL(camera) {
        const count = this.particles.length;
        if (count === 0) {
            this.clearWebGL();
            return;
        }

        // Ensure buffers are large enough
        if (!this._glPositions || this._glPositions.length < count * 2) {
            this._glPositions = new Float32Array(Math.max(count * 2, this.maxParticles * 2));
            this._glColors = new Float32Array(Math.max(count * 3, this.maxParticles * 3));
        }

        const positions = this._glPositions;
        const colors = this._glColors;

        // Base color (normalized 0-1)
        const baseR = this.darkMode ? 0.565 : 0;
        const baseG = this.darkMode ? 0.565 : 0;
        const baseB = this.darkMode ? 0.565 : 0;

        const pharrMode = this.pharrHighlightMode;
        const corridorMode = this.corridorHighlightMode;
        const applyLateral = false;  // Disabled - particles stay on path

        // Corridor mode colors (pre-multiplied by alpha for fake transparency)
        const dimAlpha = this.nonHighlightedAlpha;
        const highlightAlpha = this.highlightedAlpha;
        const equalBrightness = this.corridorEqualBrightness;

        let validCount = 0;
        for (let i = 0; i < count; i++) {
            const p = this.particles[i];
            const seg = p.seg;
            if (!seg) continue;

            // Skip non-Pharr particles in highlight mode
            if (pharrMode && p.poeId !== this.highlightPoe) continue;

            // Skip non-highlighted in corridor mode if hiding others
            if (corridorMode && this.hideNonHighlightedParticles) {
                if (p.poeId !== this.corridorPrimaryPoe && p.poeId !== this.corridorSecondaryPoe) {
                    continue;
                }
            }

            // Position on segment
            const sNorm = ((p.s % seg.totalLength) + seg.totalLength) % seg.totalLength;
            let lo = 0, hi = seg.cumLengths.length - 1;
            while (lo < hi - 1) {
                const mid = (lo + hi) >> 1;
                if (seg.cumLengths[mid] <= sNorm) lo = mid;
                else hi = mid;
            }
            const s0 = seg.cumLengths[lo];
            const s1 = seg.cumLengths[lo + 1];
            const t = s1 > s0 ? (sNorm - s0) / (s1 - s0) : 0;
            const p0 = seg.polyline[lo];
            const p1 = seg.polyline[lo + 1];
            let worldX = p0.x + t * (p1.x - p0.x);
            let worldY = p0.y + t * (p1.y - p0.y);

            // Lateral offset
            if (applyLateral && p.lateralSeed !== undefined) {
                const lateralOffset = Math.sin(p.lateralPhase) * p.lateralSeed * this.lateralSpreadM;
                if (Math.abs(lateralOffset) > 1) {
                    const dx = p1.x - p0.x;
                    const dy = p1.y - p0.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 1e-6) {
                        worldX += (-dy / len) * lateralOffset;
                        worldY += (dx / len) * lateralOffset;
                    }
                }
            }

            // Store position (world coords for WebGL)
            const posIdx = validCount * 2;
            positions[posIdx] = worldX;
            positions[posIdx + 1] = worldY;

            // Determine color
            const colIdx = validCount * 3;
            if (corridorMode) {
                const override = this.poeColorOverrides.get(p.poeId);
                if (p.poeId === this.corridorPrimaryPoe) {
                    if (override === 'white') {
                        // White with dim alpha
                        colors[colIdx] = baseR * dimAlpha;
                        colors[colIdx + 1] = baseG * dimAlpha;
                        colors[colIdx + 2] = baseB * dimAlpha;
                    } else {
                        // Full magenta
                        colors[colIdx] = 1.0 * highlightAlpha;
                        colors[colIdx + 1] = 0.0;
                        colors[colIdx + 2] = 1.0 * highlightAlpha;
                    }
                } else if (p.poeId === this.corridorSecondaryPoe) {
                    if (override === 'white') {
                        // White with dim alpha
                        colors[colIdx] = baseR * dimAlpha;
                        colors[colIdx + 1] = baseG * dimAlpha;
                        colors[colIdx + 2] = baseB * dimAlpha;
                    } else {
                        // Secondary magenta (0.7 brightness or equal)
                        const mag = equalBrightness ? 1.0 : 0.7;
                        colors[colIdx] = mag * highlightAlpha;
                        colors[colIdx + 1] = 0.0;
                        colors[colIdx + 2] = mag * highlightAlpha;
                    }
                } else {
                    // Non-highlighted: dimmed white
                    colors[colIdx] = baseR * dimAlpha;
                    colors[colIdx + 1] = baseG * dimAlpha;
                    colors[colIdx + 2] = baseB * dimAlpha;
                }
            } else {
                // Normal mode: solid base color
                colors[colIdx] = baseR;
                colors[colIdx + 1] = baseG;
                colors[colIdx + 2] = baseB;
            }

            validCount++;
        }

        if (validCount === 0) return;

        // Upload and draw
        this._glRenderer.updatePositions(positions, validCount);
        this._glRenderer.updateColors(colors, validCount);

        // Point size scales with zoom - microscopic particles
        const radius = this._particleRadius(camera);
        const pointSize = Math.max(1, radius * 2);
        this._glRenderer.draw(camera, pointSize);
    }

    // ───────────────────────────────────────────────────────────────────────────
    // INTERNAL
    // ───────────────────────────────────────────────────────────────────────────

    _computeSegmentGeometry(seg) {
        seg.lengths = [];
        seg.cumLengths = [0];
        let total = 0;

        for (let i = 0; i < seg.polyline.length - 1; i++) {
            const p0 = seg.polyline[i];
            const p1 = seg.polyline[i + 1];
            const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            seg.lengths.push(d);
            total += d;
            seg.cumLengths.push(total);
        }

        seg.totalLength = total;

        // Bounding box
        seg.bbox.minX = Infinity;
        seg.bbox.maxX = -Infinity;
        seg.bbox.minY = Infinity;
        seg.bbox.maxY = -Infinity;
        for (const pt of seg.polyline) {
            if (pt.x < seg.bbox.minX) seg.bbox.minX = pt.x;
            if (pt.x > seg.bbox.maxX) seg.bbox.maxX = pt.x;
            if (pt.y < seg.bbox.minY) seg.bbox.minY = pt.y;
            if (pt.y > seg.bbox.maxY) seg.bbox.maxY = pt.y;
        }
    }

    _updateFlowRange() {
        this.flowMin = 0;
        this.flowMax = 0;
        for (const seg of this.segments.values()) {
            const w = Number.isFinite(seg.weight) ? seg.weight : 0;
            if (w > this.flowMax) this.flowMax = w;
        }
        if (this.flowMax === 0) this.flowMax = 1;
    }

    /**
     * Build connectivity graph based on endpoint proximity.
     * Uses spatial hashing for O(n) instead of O(n²).
     * Call after all segments are added.
     */
    buildConnectivity() {
        const tol = this._connectTolerance;
        const tolSq = tol * tol;
        const cellSize = tol * 2; // Grid cells slightly larger than tolerance
        this._connectivity.clear();

        // Initialize empty connectivity for each segment
        for (const seg of this.segments.values()) {
            this._connectivity.set(seg.id, { fromStart: [], fromEnd: [] });
        }

        // Build spatial hash grid of endpoints
        const grid = new Map(); // "cellX,cellY" → [endpoints]
        const endpoints = [];

        const getCell = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;

        for (const seg of this.segments.values()) {
            if (seg.polyline.length < 2) continue;
            const start = seg.polyline[0];
            const end = seg.polyline[seg.polyline.length - 1];

            const startEp = { seg, isStart: true, x: start.x, y: start.y };
            const endEp = { seg, isStart: false, x: end.x, y: end.y };
            endpoints.push(startEp, endEp);

            // Add to grid
            for (const ep of [startEp, endEp]) {
                const cell = getCell(ep.x, ep.y);
                if (!grid.has(cell)) grid.set(cell, []);
                grid.get(cell).push(ep);
            }
        }

        // Find connections using spatial hash (check only neighboring cells)
        // Build both fromEnd and fromStart for bidirectional lookahead
        for (const a of endpoints) {
            const cx = Math.floor(a.x / cellSize);
            const cy = Math.floor(a.y / cellSize);

            // Check 3x3 neighborhood of cells
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const cell = `${cx + dx},${cy + dy}`;
                    const nearby = grid.get(cell);
                    if (!nearby) continue;

                    for (const b of nearby) {
                        if (a.seg.id === b.seg.id) continue; // No self-loops

                        const ddx = a.x - b.x;
                        const ddy = a.y - b.y;
                        if (ddx * ddx + ddy * ddy <= tolSq) {
                            const conn = this._connectivity.get(a.seg.id);
                            // fromEnd: connections reachable when leaving from segment's END
                            // fromStart: connections reachable when leaving from segment's START
                            if (a.isStart) {
                                conn.fromStart.push({ seg: b.seg, atStart: b.isStart });
                            } else {
                                conn.fromEnd.push({ seg: b.seg, atStart: b.isStart });
                            }
                        }
                    }
                }
            }
        }

        // Debug: connectivity stats
        let conn0 = 0, conn1 = 0, conn2plus = 0;
        const noConnIds = [];
        for (const [id, conn] of this._connectivity) {
            const n = conn.fromEnd.length;
            if (n === 0) {
                conn0++;
                noConnIds.push(id);
            }
            else if (n === 1) conn1++;
            else conn2plus++;
        }
        console.log(`[CONNECTIVITY] tolerance=${tol}m segments=${this.segments.size} noConn=${conn0} oneConn=${conn1} multiConn=${conn2plus}`);
        if (noConnIds.length > 0 && noConnIds.length <= 50) {
            console.log(`[CONNECTIVITY] unconnected segment IDs: ${noConnIds.join(', ')}`);
        }

        // Find source segments (nothing flows INTO their start)
        const hasIncoming = new Set();
        for (const [id, conn] of this._connectivity) {
            for (const c of conn.fromEnd) {
                hasIncoming.add(c.seg.id);
            }
        }

        this._sourceSegments = [];
        for (const seg of this.segments.values()) {
            if (!hasIncoming.has(seg.id) && seg.weight > this.spawnEpsilon) {
                this._sourceSegments.push(seg);
            }
        }

        // Minimal logging
        let totalConnections = 0, deadEnds = 0;
        for (const [, conn] of this._connectivity) {
            totalConnections += conn.fromEnd.length;
            if (conn.fromEnd.length === 0) deadEnds++;
        }
        console.log(`[MacroParticles] Connectivity: ${this.segments.size} segs, ${totalConnections} conns, ${this._sourceSegments.length} sources`);
        this._connectivityBuilt = true;
    }

    /**
     * Set Mexican origin coordinates for true source detection.
     * @param {Object} origins - { originName: { lat, lon } } from mexican_origins.json
     * @param {function} latLonToWorld - Transform function (lat, lon) → { x, y }
     */
    setOrigins(origins, latLonToWorld) {
        this._originCoords = new Map();
        for (const [name, coord] of Object.entries(origins)) {
            const world = latLonToWorld(coord.lat, coord.lon);
            this._originCoords.set(name, { x: world.x, y: world.y, name });
        }
        console.log(`[MacroParticles] Origins set: ${this._originCoords.size} Mexican origins`);
    }

    /**
     * Detect true source segments based on proximity to Mexican origins.
     * Call after setOrigins() and after all segments are added.
     */
    detectSourcesFromOrigins() {
        if (!this._originCoords || this._originCoords.size === 0) {
            console.warn('[MacroParticles] No origins set - call setOrigins() first');
            return;
        }

        const tolSq = this._originTolerance * this._originTolerance;
        const sourceSet = new Set();
        const originMatches = new Map(); // segmentId → closest origin name

        // For each segment, check if START point is near any origin
        for (const seg of this.segments.values()) {
            if (seg.polyline.length < 2) continue;
            if (seg.weight <= this.spawnEpsilon) continue;

            const start = seg.polyline[0];

            // Find closest origin
            let closestDist = Infinity;
            let closestOrigin = null;
            for (const [name, origin] of this._originCoords) {
                const dx = start.x - origin.x;
                const dy = start.y - origin.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < closestDist) {
                    closestDist = distSq;
                    closestOrigin = name;
                }
            }

            if (closestDist <= tolSq) {
                sourceSet.add(seg.id);
                originMatches.set(seg.id, closestOrigin);
            }
        }

        // Build source segments list
        this._sourceSegments = [];
        for (const seg of this.segments.values()) {
            if (sourceSet.has(seg.id)) {
                seg.originName = originMatches.get(seg.id);
                this._sourceSegments.push(seg);
            }
        }

        // Minimal logging
        console.log(`[MacroParticles] ${this._sourceSegments.length} sources from ${this._originCoords.size} origins`);
    }

    _updateParticles(dt) {
        for (const p of this.particles) {
            let seg = p.seg || this.segments.get(p.segmentId);
            if (!seg) {
                p.dead = true;
                continue;
            }

            // Kill if segment weight collapsed
            if (seg.weight < this.killWeightThreshold) {
                p.dead = true;
                continue;
            }

            // Advance along polyline (slow in queue mode)
            let speedMult = 1;
            if (this.queueMode) {
                speedMult = this.queueSpeedFactor;
            }
            p.s += p.speed * dt * speedMult;

            // DEBUG: Check if ANY particle is on segment 1345
            const segIdNum = parseInt(seg.id, 10);
            if (segIdNum === 1345 && !this._seen1345) {
                this._seen1345 = true;
                console.log(`[DEBUG 1345] PARTICLE EXISTS ON 1345! s=${p.s.toFixed(0)} totalLen=${seg.totalLength.toFixed(0)} weight=${seg.weight}`);
            }

            // Check if reached end of segment - loop to handle chaining through short segments
            let chainIter = 0;
            while (p.s > seg.totalLength && !p.dead && chainIter < 20) {
                chainIter++;
                let overflow = p.s - seg.totalLength;

                // Try to hand off to connected segment
                const conn = this._connectivity.get(seg.id);

                // DEBUG: Target location investigation - track segment 1345 specifically
                const endPt = seg.polyline[seg.polyline.length - 1];
                const segIdNum = parseInt(seg.id, 10);
                const isTargetLoc = false; // disabled: segIdNum >= 1340 && segIdNum <= 1360
                const is1345 = seg.id === '1345' || segIdNum === 1345;

                if (is1345 && !this._logged1345) {
                    this._logged1345 = true;
                    console.log(`[DEBUG 1345] PARTICLE ON SEG 1345! conn=${conn ? 'exists' : 'null'} fromEnd=${conn?.fromEnd?.length ?? 'N/A'} segLength=${seg.totalLength}`);
                }

                if (conn && conn.fromEnd.length > 0) {
                    // Pick next segment using POE cone integrity or destination routing
                    const result = this._pickNextSegment(conn.fromEnd, p.poeId, p.destinationId);

                    if (isTargetLoc) {
                        if (!this._targetLocLogCount5) this._targetLocLogCount5 = 0;
                        if (this._targetLocLogCount5 < 50) {
                            this._targetLocLogCount5++;
                            const nextId = result ? result.conn.seg.id : 'NONE';
                            const nextSeg = result ? result.conn.seg : null;
                            const nextInMap = nextSeg ? this.segments.has(nextSeg.id) : false;
                            const nextWeight = nextSeg?.weight ?? 'N/A';
                            console.log(`[DEBUG CHAIN #${this._targetLocLogCount5}] seg=${seg.id}→${nextId} inMap=${nextInMap} weight=${nextWeight} poe=${p.poeId}`);
                        }
                    }

                    if (result) {
                        const { conn: next, onCone } = result;

                        // Manage connector budget + track stats
                        if (onCone) {
                            this._coneStats.onCone++;
                            // Track re-entry from off-cone
                            if (p.offConeSteps < this._connectorBudget) {
                                this._coneStats.reentries++;
                            }
                            // On-cone: reset budget
                            p.offConeSteps = this._connectorBudget;
                        } else {
                            this._coneStats.offCone++;
                            // Off-cone: decrement budget
                            p.offConeSteps--;
                            if (p.offConeSteps <= 0) {
                                // Budget exhausted - kill particle
                                this._coneStats.budgetKills++;
                                p.dead = true;
                                continue;
                            }
                        }

                        // Transfer to next segment
                        seg = next.seg;  // Update local ref for while loop
                        p.seg = next.seg;
                        p.segmentId = next.seg.id;

                        // If connecting to start, continue forward; if to end, start from end
                        if (next.atStart) {
                            p.s = overflow;
                            // While loop continues if p.s > seg.totalLength
                        } else {
                            // Entering at end, traveling backwards
                            p.s = next.seg.totalLength - overflow;
                            if (p.s < 0) {
                                // Overshot backwards - would need to handle fromStart connections
                                // For now, clamp to 0 (particle stops at start)
                                p.s = 0;
                            }
                        }
                        // While loop will continue if p.s > seg.totalLength (chaining through short segments)
                        continue;
                    }
                }

                // No valid connection - particle reached destination (dead end/sink)
                p.dead = true;
                break;  // Exit while loop
            }


            // Lateral drift disabled - particles stay on path
        }
    }

    /**
     * Pick next segment using POE cone integrity with connector budget.
     *
     * Strategy:
     * 1. Prefer POE-supported segments (flow data for target POE) - "on-cone"
     * 2. If none, use 1-step lookahead to find connectors that re-enter cone
     * 3. Fall back to geometric weight if no cone re-entry found - "off-cone"
     *
     * Returns { conn, onCone } where:
     * - conn: the connection to take (or null if no options)
     * - onCone: true if segment has POE support, false if connector step
     *
     * @param {Array} connections - List of { seg, atStart }
     * @param {string} poeId - Particle's target POE (e.g., 'hidalgo_pharr')
     * @param {string} destinationId - Particle's target Destination (US routing)
     * @returns {{ conn: object, onCone: boolean } | null}
     */
    _pickNextSegment(connections, poeId, destinationId) {
        if (connections.length === 0) return null;

        const activeDist = this.scenarioAlpha < 0.5
            ? this.baselinePoeDistribution
            : this.interserranaPoeDistribution;

        // ═══════════════════════════════════════════════════════════════════════
        // PASS 0: Destination Routing (US Side)
        // ═══════════════════════════════════════════════════════════════════════
        if (destinationId && this.segmentDestinationWeights) {
            let destCount = 0;
            for (const c of connections) {
                if (destCount >= 32) break;

                const destMap = this.segmentDestinationWeights.get(c.seg.id);
                if (destMap) {
                    const w = destMap[destinationId];
                    if (w > 0) {
                        this._handoffValidConns[destCount] = c;
                        this._handoffWeights[destCount] = w;
                        destCount++;
                    }
                }
            }
            if (destCount > 0) {
                const picked = this._weightedPick(destCount);
                // Destination routing is considered "on-cone"
                return { conn: picked, onCone: true };
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PASS 1: Find POE-supported candidates (on-cone)
        // ═══════════════════════════════════════════════════════════════════════
        let onConeCount = 0;

        for (const c of connections) {
            if (onConeCount >= 32) break;

            if (!poeId || !activeDist) {
                // No POE info - treat all as on-cone
                this._handoffValidConns[onConeCount] = c;
                this._handoffWeights[onConeCount] = c.seg.weight || 0.001;
                onConeCount++;
                continue;
            }

            const poeDist = activeDist.get(c.seg.id);
            if (!poeDist) continue;

            // Check for flow to target POE
            for (let i = 0; i < poeDist.poes.length; i++) {
                const entry = poeDist.poes[i];
                if (entry.poe === poeId) {
                    const prevCum = i > 0 ? poeDist.poes[i - 1].cumWeight : 0;
                    const w = entry.cumWeight - prevCum;
                    if (w > 0) {
                        this._handoffValidConns[onConeCount] = c;
                        this._handoffWeights[onConeCount] = w;
                        onConeCount++;
                    }
                    break;
                }
            }
        }

        // If we have on-cone options, pick weighted and return
        if (onConeCount > 0) {
            const picked = this._weightedPick(onConeCount);
            return { conn: picked, onCone: true };
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PASS 2: 1-step lookahead - find connectors that re-enter cone
        // ═══════════════════════════════════════════════════════════════════════
        let connectorCount = 0;

        for (const c of connections) {
            if (connectorCount >= 32) break;

            // Check if ANY of c's outgoing connections have POE support
            const nextConn = this._connectivity.get(c.seg.id);
            if (!nextConn) continue;

            let reentersCone = false;
            const nextHops = c.atStart ? nextConn.fromEnd : nextConn.fromStart;

            for (const next of (nextHops || [])) {
                const nextPoeDist = activeDist?.get(next.seg.id);
                if (nextPoeDist) {
                    for (const entry of nextPoeDist.poes) {
                        if (entry.poe === poeId) {
                            reentersCone = true;
                            break;
                        }
                    }
                }
                if (reentersCone) break;
            }

            if (reentersCone) {
                // This connector leads back to cone - prefer it
                this._handoffValidConns[connectorCount] = c;
                this._handoffWeights[connectorCount] = (c.seg.weight || 0.001) * 10; // Boost
                connectorCount++;
            }
        }

        // If we found connectors that re-enter cone, pick weighted
        if (connectorCount > 0) {
            const picked = this._weightedPick(connectorCount);
            return { conn: picked, onCone: false };
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PASS 3: Geometric fallback (pure off-cone, budget will decrement)
        // ═══════════════════════════════════════════════════════════════════════
        let fallbackCount = 0;

        for (const c of connections) {
            if (fallbackCount >= 32) break;
            this._handoffValidConns[fallbackCount] = c;
            this._handoffWeights[fallbackCount] = c.seg.weight || 0.001;
            fallbackCount++;
        }

        if (fallbackCount > 0) {
            const picked = this._weightedPick(fallbackCount);
            return { conn: picked, onCone: false };
        }

        return null;
    }

    /**
     * Weighted random pick from pre-allocated buffers.
     * @param {number} count - Number of valid entries in buffers
     * @returns {object} - Selected connection
     */
    _weightedPick(count) {
        if (count === 1) return this._handoffValidConns[0];

        let totalW = 0;
        for (let i = 0; i < count; i++) totalW += this._handoffWeights[i];

        const r = Math.random() * totalW;
        let cumW = 0;
        for (let i = 0; i < count; i++) {
            cumW += this._handoffWeights[i];
            if (cumW >= r) return this._handoffValidConns[i];
        }
        return this._handoffValidConns[count - 1];
    }

    _spawnParticlesBudgeted(dt, camera) {
        this._rebuildSpawnDistribution(camera);
        const sources = this._sourceSegments || [];
        if (sources.length === 0 || this._spawnTotalW <= 0) {
            if (!this._spawnWarnLogged) {
                console.warn(`[MacroParticles] No spawning: sources=${sources.length}, totalW=${this._spawnTotalW}`);
                this._spawnWarnLogged = true;
            }
            this._logSpawnsPerSecond(dt);
            return;
        }

        // Apply dynamic throttle multiplier + ramp-up
        let rampMult = 1.0;
        if (this.spawnRampUpSec > 0 && this._spawnElapsedSec < this.spawnRampUpSec) {
            rampMult = this._spawnElapsedSec / this.spawnRampUpSec;
        }
        const desired = this.spawnPerSecondBudget * this._spawnMultiplier * rampMult * dt + this._spawnResidual;
        let toSpawn = Math.floor(desired);
        this._spawnResidual = desired - toSpawn;

        // Fill up to the hard ceiling
        const remaining = this.maxParticles - this.particles.length;
        toSpawn = Math.min(toSpawn, remaining);
        if (toSpawn <= 0) {
            this._logSpawnsPerSecond(dt);
            return;
        }

        // Disabled - too noisy. Uncomment for spawn debugging:
        // if (this._diagEnabled && this._diagSpawnLogs < 5) {
        //     console.log(`[SPAWN DEBUG] active=${this._spawnSegments.length} toSpawn=${toSpawn} totalW=${this._spawnTotalW.toFixed(3)}`);
        //     this._diagSpawnLogs++;
        // }

        for (let i = 0; i < toSpawn; i++) {
            const seg = this._pickSpawnSegment();
            if (!seg) break;
            this._spawnParticle(seg);
            this.spawnedThisFrame++;
        }

        // Diagnostic: force occasional spawn to prove motion (toggle manually)
        if (this._diagForceSpawn && Math.random() < 0.1 && this.particles.length < this.maxParticles) {
            const seg = this._pickSpawnSegment();
            if (seg) {
                this._spawnParticle(seg);
                this.spawnedThisFrame++;
            }
        }

        this._logSpawnsPerSecond(dt);
    }

    _logSpawnsPerSecond(dt) {
        this.spawnLogT += dt;
        if (this.spawnLogT >= 1.0) {
            if (this._diagEnabled) console.log(`[MacroParticles] spawns/sec=${this.spawnedThisFrame}`);
            this.spawnLogT = 0;
            this.spawnedThisFrame = 0;
        }
    }

    _rebuildSpawnDistribution(camera) {
        // Spawn ONLY at source segments - let map reveal itself over time
        // Particles flow from origins through the network

        if (!this._spawnCumWeights) this._spawnCumWeights = [];

        const sources = this._sourceSegments || [];
        this._spawnTotalW = 0;

        for (let i = 0; i < sources.length; i++) {
            const w = sources[i].weight;
            if (w > this.spawnEpsilon) {
                // Compress weight distribution to prevent heavy segments from dominating
                const compressed = Math.pow(w, this.spawnWeightPower);
                this._spawnTotalW += compressed;
            }
            this._spawnCumWeights[i] = this._spawnTotalW;
        }
        this._spawnCumWeights.length = sources.length;
    }

    _pickSpawnSegment() {
        const sources = this._sourceSegments || [];
        const total = this._spawnTotalW;
        if (total <= 0 || sources.length === 0) return null;

        const r = Math.random() * total;

        let lo = 0;
        let hi = sources.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (this._spawnCumWeights[mid] >= r) hi = mid;
            else lo = mid + 1;
        }
        return sources[lo] || null;
    }

    _spawnParticle(seg) {
        // Assign POE probabilistically based on segment's POE distribution
        let poeId = null;
        const activeDist = this.scenarioAlpha < 0.5
            ? this.baselinePoeDistribution
            : this.interserranaPoeDistribution;
        const poeDist = activeDist.get(seg.id);
        if (poeDist && poeDist.poes.length > 0) {
            const r = Math.random() * poeDist.totalWeight;
            for (const entry of poeDist.poes) {
                if (r <= entry.cumWeight) {
                    poeId = entry.poe;
                    break;
                }
            }
            if (!poeId) poeId = poeDist.poes[poeDist.poes.length - 1].poe;
        }

        // Assign Destination probabilistically based on POE's outbound distribution (US-side routing)
        let destinationId = null;
        if (poeId && this.poeDestinationDistribution) {
            const destDist = this.poeDestinationDistribution[poeId];
            if (destDist) {
                const r = Math.random();
                let cum = 0;
                for (const [dest, weight] of Object.entries(destDist)) {
                    cum += weight;
                    if (r <= cum) {
                        destinationId = dest;
                        break;
                    }
                }
                // Fallback to last key if rounding error
                if (!destinationId) destinationId = Object.keys(destDist).pop();
            }
        }

        // Reuse pooled particle or create new one (avoids GC pressure)
        let p;
        if (this._particlePool.length > 0) {
            p = this._particlePool.pop();
            p.seg = seg;
            p.segmentId = seg.id;
            p.s = 0;
            p.speed = this.particleSpeed;
            p.poeId = poeId;
            p.destinationId = destinationId;
            p.offConeSteps = this._connectorBudget; // Reset connector budget
            p.lateralSeed = Math.random() * 2 - 1;
            p.lateralPhase = Math.random() * Math.PI * 2;
            p.dead = false;
        } else {
            p = {
                seg,
                segmentId: seg.id,
                s: 0,
                speed: this.particleSpeed,
                poeId,
                offConeSteps: this._connectorBudget, // Connector budget for bridging gaps
                lateralSeed: Math.random() * 2 - 1,
                lateralPhase: Math.random() * Math.PI * 2,
                dead: false,
            };
        }
        this.particles.push(p);
    }

    _cullDeadParticles() {
        // In-place removal, returning dead particles to pool (avoids GC pressure)
        let writeIdx = 0;
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (!p.dead) {
                if (writeIdx !== i) {
                    this.particles[writeIdx] = p;
                }
                writeIdx++;
            } else if (this._particlePool.length < this._particlePoolMax) {
                // Return to pool for reuse (clear refs to avoid leaks)
                p.seg = null;
                this._particlePool.push(p);
            }
        }
        this.particles.length = writeIdx;
    }

    _getViewportPadding(vp) {
        if (!vp) return 50000;
        const vpWidth = vp.maxX - vp.minX;
        const vpHeight = vp.maxY - vp.minY;
        const vpSize = Math.max(vpWidth, vpHeight);
        return vpSize * this.viewportPaddingFraction;
    }

    _particleRadius(camera) {
        if (!camera?.zoom) return 0.75;
        // Small particles (1.5px dots)
        const r = camera.zoom * 60;
        return Math.min(1.5, Math.max(0.75, r));
    }

    _logProbe(dt) {
        // Reset probe if dead
        if (this.probe && this.probe.dead) {
            this.probe = null;
        }
        if (!this.probe && this.particles.length > 0) {
            this.probe = this.particles[0];
        }
        this.probeLogT += dt;
        if (this.probe && this.probeLogT >= 0.5) {
            const seg = this.probe.seg;
            if (seg) {
                console.log(`[PROBE] s=${this.probe.s.toFixed(2)} / ${seg.totalLength.toFixed(1)} (seg=${seg.id}, w=${seg.weight.toFixed(4)}) speed=${this.probe.speed.toFixed(0)}`);
            }
            this.probeLogT = 0;
        }
    }

    _positionOnSegment(seg, s) {
        // Handle negative or wrapped s values
        const sNorm = ((s % seg.totalLength) + seg.totalLength) % seg.totalLength;

        // Binary search in cumLengths
        let lo = 0;
        let hi = seg.cumLengths.length - 1;
        while (lo < hi - 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (seg.cumLengths[mid] <= sNorm) lo = mid;
            else hi = mid;
        }

        const i = lo;
        const s0 = seg.cumLengths[i];
        const s1 = seg.cumLengths[i + 1];
        const t = (s1 - s0) > 0 ? (sNorm - s0) / (s1 - s0) : 0;

        const p0 = seg.polyline[i];
        const p1 = seg.polyline[i + 1];

        return {
            x: p0.x + t * (p1.x - p0.x),
            y: p0.y + t * (p1.y - p0.y),
        };
    }

    /**
     * Get normalized tangent vector at position s on segment.
     * @private
     */
    _tangentAtS(seg, s) {
        // Handle negative or wrapped s values
        const sNorm = ((s % seg.totalLength) + seg.totalLength) % seg.totalLength;

        // Binary search in cumLengths
        let lo = 0;
        let hi = seg.cumLengths.length - 1;
        while (lo < hi - 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (seg.cumLengths[mid] <= sNorm) lo = mid;
            else hi = mid;
        }

        const i = lo;
        const p0 = seg.polyline[i];
        const p1 = seg.polyline[i + 1];

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy);

        if (len < 1e-6) return { x: 1, y: 0 };  // Fallback

        return { x: dx / len, y: dy / len };
    }
}

