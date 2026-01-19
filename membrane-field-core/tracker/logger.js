// ═══════════════════════════════════════════════════════════════════════════════
// TRACKER LOGGER — 3-layer telemetry for headless simulation runs
// ═══════════════════════════════════════════════════════════════════════════════
//
// Layer 1: Heartbeat (HB) — operational status every N sim-hours
// Layer 2: Control-loop (CTRL) — state transitions only
// Layer 3: Debug (DBG) — verbose exhaust, off by default
//
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────────────────────────────────────

let _scenarioId = '';
let _simTime = 0;
let _totalDuration = 0;

// Heartbeat interval (sim-seconds)
const HEARTBEAT_INTERVAL_S = 6 * 3600;  // 6 sim-hours
let _lastHeartbeatSimS = -HEARTBEAT_INTERVAL_S;  // Emit first heartbeat immediately
let _pendingHeartbeat = true;  // Edge-triggered flag

// Phi state detection (limit cycle detector)
let _admitLotsHistory = [];
const PHI_HISTORY_SIZE = 8;
const PHI_OSCILLATION_THRESHOLD = 3;  // direction changes in window to be "oscillating"

// Phi state tracking for regime classification
let _phiStateHistory = [];  // track phi states over time for summary

// Rebuild windowing
let _rebuildTimestamps = [];
const REBUILD_WINDOW_S = 6 * 3600;  // 6 sim-hours

// Lots constraint tracking for regime classification
let _lotsBlockedSamples = 0;
let _lotsTotalSamples = 0;
const LOTS_CONSTRAINED_THRESHOLD = 0.3;  // >30% blocked = constrained

// Rebuild rate thresholds
const ROUTING_THRASHING_RATE = 4.0;  // rebuilds/hr threshold for "thrashing"

// Debug flags (off by default)
let _debugLots = false;
let _debugRouting = false;
let _debugParticles = false;

// Quiet mode - suppresses CTRL logs (keeps HB and summary)
let _quietMode = false;
export function setQuietMode(q) { _quietMode = q; }

// ───────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ───────────────────────────────────────────────────────────────────────────────

export function initLogger(scenarioId, totalDuration = 0) {
    _scenarioId = scenarioId || 'sim';
    _totalDuration = totalDuration;
    _simTime = 0;
    _lastHeartbeatSimS = -HEARTBEAT_INTERVAL_S;
    _pendingHeartbeat = true;
    _admitLotsHistory = [];
    _phiStateHistory = [];
    _rebuildTimestamps = [];
    _lotsBlockedSamples = 0;
    _lotsTotalSamples = 0;
}

/**
 * Update sim time. Edge-triggers heartbeat when interval crossed.
 * Asserts monotonic time advancement.
 */
export function setSimTime(t) {
    // Invariant: monotonic sim-time
    if (t < _simTime) {
        emit('CTRL', 'TIME', `non-monotonic simTime: ${t} < ${_simTime}`);
    }

    _simTime = t;

    // Edge-trigger heartbeat
    if (_simTime - _lastHeartbeatSimS >= HEARTBEAT_INTERVAL_S) {
        _lastHeartbeatSimS = _simTime;
        _pendingHeartbeat = true;
    }
}

export function setDebugFlags({ lots, routing, particles } = {}) {
    if (lots !== undefined) _debugLots = lots;
    if (routing !== undefined) _debugRouting = routing;
    if (particles !== undefined) _debugParticles = particles;
}

export function getScenarioId() {
    return _scenarioId;
}

// ───────────────────────────────────────────────────────────────────────────────
// LAYER 1: HEARTBEAT
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Consume heartbeat flag. Returns true once per trigger, then false until next interval.
 * This is clock-driven (via setSimTime), not caller-driven.
 */
export function consumeHeartbeatFlag() {
    if (!_pendingHeartbeat) return false;
    _pendingHeartbeat = false;
    return true;
}

// Legacy alias for compatibility
export function shouldEmitHeartbeat() {
    return consumeHeartbeatFlag();
}

/**
 * Emit heartbeat with operational KPIs.
 * @param {Object} metrics
 * @param {number} metrics.day - Current sim day (fractional)
 * @param {number} metrics.totalDays - Total duration in days
 * @param {number} metrics.particles - Active particle count
 * @param {number} metrics.throughputMt - Exited mass in megatons
 * @param {number} metrics.avgDelay - Average delay per truck (hours)
 * @param {Object} metrics.lots - { available, draining, blocked }
 * @param {number} metrics.rebuildsLastWindow - Rebuilds in last window
 * @param {number} metrics.sinkQueue - Particles waiting for CBP
 * @param {number} metrics.sinkCapKgPerHour - Current sink capacity
 * @param {number} metrics.drainKgPerHour - Instantaneous drain rate
 * @param {number} metrics.cbpLanesInUse - CBP lanes in use
 * @param {boolean} metrics.sinkOpen - Bridge open flag
 * @param {Object} metrics.stalls - { total, dead_end, lot_full, road_full, pre_lot_hold, moving }
 */
export function heartbeat(metrics) {
    const phiState = detectPhiState();
    const lots = metrics.lots || { available: 0, draining: 0, blocked: 0 };

    // Track phi state for regime classification
    _phiStateHistory.push(phiState);

    // Track lots constraint for regime classification
    const totalLots = lots.available + lots.draining + lots.blocked;
    if (totalLots > 0) {
        _lotsTotalSamples++;
        if (lots.blocked / totalLots > LOTS_CONSTRAINED_THRESHOLD) {
            _lotsBlockedSamples++;
        }
    }

    // Compute rebuild rate (per sim-hour)
    const rebuildsInWindow = metrics.rebuildsLastWindow;
    const windowHours = REBUILD_WINDOW_S / 3600;
    const rebuildRate = rebuildsInWindow / windowHours;

    // Sink status
    const sinkOpen = metrics.sinkOpen;
    const sinkQueue = metrics.sinkQueue ?? 0;
    const sinkCap = metrics.sinkCapKgPerHour ?? 0;
    const drain = metrics.drainKgPerHour ?? 0;
    const lanes = metrics.cbpLanesInUse ?? 0;
    const drainPct = sinkCap > 0 ? ((drain / sinkCap) * 100).toFixed(0) : '-';
    const sinkStatus = sinkOpen
        ? `sink:{q=${sinkQueue} drain=${(drain/1000).toFixed(0)}t/h (${drainPct}%) lanes=${lanes}}`
        : `sink:CLOSED`;

    // Stall breakdown
    const stalls = metrics.stalls || { total: 0, dead_end: 0, lot_full: 0, road_full: 0, pre_lot_hold: 0, moving: 0 };
    const stalledCount = stalls.dead_end + stalls.lot_full + stalls.road_full + stalls.pre_lot_hold;
    const stallStatus = stalledCount > 0
        ? `stall:{${stalledCount} de=${stalls.dead_end} lf=${stalls.lot_full} rf=${stalls.road_full}}`
        : `stall:0`;

    const line = [
        `day=${metrics.day.toFixed(2)}/${metrics.totalDays}`,
        `particles=${metrics.particles}`,
        `throughput=${metrics.throughputMt.toFixed(1)}Mt`,
        `avg_delay=${metrics.avgDelay.toFixed(1)}h`,
        `lots:{avail=${lots.available} drain=${lots.draining} block=${lots.blocked}}`,
        sinkStatus,
        stallStatus,
        `phi=${phiState}`,
        `rebuilds=${rebuildsInWindow} (${rebuildRate.toFixed(1)}/hr)`,
    ].join(' ');

    console.log(`[HB][${_scenarioId}] ${line}`);
}

// ───────────────────────────────────────────────────────────────────────────────
// LAYER 2: CONTROL-LOOP DIAGNOSTICS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Log phi/lot admission state change.
 */
export function ctrlPhi(event, details = {}) {
    if (_quietMode) return;
    const parts = [event];
    if (details.from !== undefined && details.to !== undefined) {
        parts.push(`${details.from}→${details.to}`);
    }
    if (details.delta !== undefined) {
        const sign = details.delta >= 0 ? '+' : '';
        parts.push(`delta=${sign}${details.delta}`);
    }
    if (details.phiState) {
        parts.push(`state=${details.phiState}`);
    }
    console.log(`[CTRL][PHI][${_scenarioId}] ${parts.join(' ')}`);
}

/**
 * Log routing/rebuild events.
 */
export function ctrlRouting(event, details = {}) {
    if (_quietMode) return;
    const parts = [event];
    if (details.version !== undefined) {
        parts.push(`v=${details.version}`);
    }
    if (details.reason) {
        parts.push(`reason=${details.reason}`);
    }
    if (details.available !== undefined) {
        parts.push(`lots:{avail=${details.available} drain=${details.draining || 0} block=${details.blocked || 0}}`);
    }
    console.log(`[CTRL][ROUTING][${_scenarioId}] ${parts.join(' ')}`);
}

/**
 * Log lot state changes.
 */
export function ctrlLot(event, details = {}) {
    if (_quietMode) return;
    const parts = [event];
    if (details.lotId !== undefined) parts.push(`lot=${details.lotId}`);
    if (details.fill !== undefined) parts.push(`fill=${(details.fill * 100).toFixed(0)}%`);
    if (details.reason) parts.push(`reason=${details.reason}`);
    console.log(`[CTRL][LOT][${_scenarioId}] ${parts.join(' ')}`);
}

/**
 * Log sink/bridge events.
 */
export function ctrlSink(event, details = {}) {
    if (_quietMode) return;
    const parts = [event];
    if (details.queueCount !== undefined) parts.push(`queue=${details.queueCount}`);
    if (details.lanes !== undefined) parts.push(`lanes=${details.lanes}`);
    console.log(`[CTRL][SINK][${_scenarioId}] ${parts.join(' ')}`);
}

// ───────────────────────────────────────────────────────────────────────────────
// LAYER 3: DEBUG EXHAUST
// ───────────────────────────────────────────────────────────────────────────────

export function dbgLots(...args) {
    if (_debugLots) emit('DBG', 'LOTS', args.join(' '));
}

export function dbgRouting(...args) {
    if (_debugRouting) emit('DBG', 'ROUTING', args.join(' '));
}

export function dbgParticles(...args) {
    if (_debugParticles) emit('DBG', 'PARTICLES', args.join(' '));
}

// ───────────────────────────────────────────────────────────────────────────────
// STRUCTURAL: EPOCHS AND SUMMARY
// ───────────────────────────────────────────────────────────────────────────────

export function epochDayStart(day) {
    console.log(`===== [${_scenarioId}] SIM_DAY_${day} =====`);
}

/**
 * Classify regime from accumulated observations.
 * Returns { phi, routing, lots } with state strings.
 */
function classifyRegime() {
    // PHI regime: oscillating if >50% of samples were oscillating
    let oscillatingCount = 0;
    for (const state of _phiStateHistory) {
        if (state === 'oscillating') oscillatingCount++;
    }
    const phiRegime = _phiStateHistory.length > 0 && oscillatingCount / _phiStateHistory.length > 0.5
        ? 'oscillating'
        : 'stable';

    // Routing regime: thrashing if current rebuild rate exceeds threshold
    const rebuildsInWindow = getRebuildsInWindow();
    const rebuildRate = rebuildsInWindow / (REBUILD_WINDOW_S / 3600);
    const routingRegime = rebuildRate > ROUTING_THRASHING_RATE ? 'thrashing' : 'stable';

    // Lots regime: constrained if blocked fraction exceeded threshold for >50% of samples
    const lotsRegime = _lotsTotalSamples > 0 && _lotsBlockedSamples / _lotsTotalSamples > 0.5
        ? 'constrained'
        : 'nominal';

    return { phi: phiRegime, routing: routingRegime, lots: lotsRegime };
}

/**
 * Emit end-of-scenario summary with regime classification.
 */
export function endSummary(stats) {
    const wallTimeStr = formatWallTime(stats.wallTime);
    const regime = classifyRegime();

    console.log(`${'═'.repeat(60)}`);
    console.log(`[${_scenarioId}] SCENARIO COMPLETE`);
    console.log(`  sim_days: ${stats.simDays.toFixed(1)}`);
    console.log(`  wall_time: ${wallTimeStr}`);
    console.log(`  throughput: ${stats.throughputMt.toFixed(1)}Mt`);
    console.log(`  truck_hours_lost: ${Math.round(stats.totalTruckHoursLost)}`);
    console.log(`  avg_delay: ${stats.avgDelayPerTruck.toFixed(2)}h/truck`);
    console.log(`  violations: ${stats.violations}`);
    console.log(`  regime:`);
    console.log(`    phi: ${regime.phi}`);
    console.log(`    routing: ${regime.routing}`);
    console.log(`    lots: ${regime.lots}`);
    console.log(`${'═'.repeat(60)}`);
}

function formatWallTime(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${m}m`;
}

// ───────────────────────────────────────────────────────────────────────────────
// PHI STATE DETECTION (limit cycle detector)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Record lot admission count and return phi state.
 * @param {number} admittedCount - Current number of admitted lots
 * @returns {'stable' | 'oscillating' | 'transient'}
 */
export function recordAdmitLots(admittedCount) {
    _admitLotsHistory.push(admittedCount);
    if (_admitLotsHistory.length > PHI_HISTORY_SIZE) {
        _admitLotsHistory.shift();
    }
    return detectPhiState();
}

/**
 * Detect phi state from admission history.
 * @returns {'stable' | 'oscillating' | 'transient'}
 */
function detectPhiState() {
    // Not enough samples to determine state
    if (_admitLotsHistory.length < 4) return 'transient';

    // Count direction changes (limit cycle detection)
    let changes = 0;
    for (let i = 1; i < _admitLotsHistory.length; i++) {
        if (_admitLotsHistory[i] !== _admitLotsHistory[i - 1]) {
            changes++;
        }
    }

    return changes >= PHI_OSCILLATION_THRESHOLD ? 'oscillating' : 'stable';
}

// ───────────────────────────────────────────────────────────────────────────────
// REBUILD WINDOWING
// ───────────────────────────────────────────────────────────────────────────────

export function recordRebuild(simTime) {
    _rebuildTimestamps.push(simTime);
    // Prune old timestamps outside window
    const cutoff = simTime - REBUILD_WINDOW_S;
    _rebuildTimestamps = _rebuildTimestamps.filter(t => t >= cutoff);
}

export function getRebuildsInWindow() {
    // Prune on read as well
    const cutoff = _simTime - REBUILD_WINDOW_S;
    _rebuildTimestamps = _rebuildTimestamps.filter(t => t >= cutoff);
    return _rebuildTimestamps.length;
}

// ───────────────────────────────────────────────────────────────────────────────
// INTERNAL
// ───────────────────────────────────────────────────────────────────────────────

function emit(layer, subsystem, msg) {
    console.log(`[${layer}][${subsystem}][${_scenarioId}] ${msg}`);
}
