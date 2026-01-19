// ═══════════════════════════════════════════════════════════════════════════════
// PARTICLE COLORS — Color modes and color functions for particle rendering
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Pure functions for particle color computation based on state and source type.
//

// Particle color mode (M key cycles)
// 0 = OFF (default white/black)
// 1 = STALL (normal colors, yellow when stalled)
// 2 = SOURCE (corridor origin colors)
// 3 = STATE (restricted=orange, cleared=cyan)
let _particleColorMode = 0;
const PARTICLE_COLOR_MODE_NAMES = ['OFF', 'STALL', 'SOURCE', 'STATE'];

// Enums injected from orchestrator
let STATE = null;
let SOURCE_TYPE = null;

/**
 * Initialize particle colors module with enums from orchestrator.
 * Must be called before any color functions are used.
 */
export function initParticleColors(stateEnum, sourceTypeEnum) {
    STATE = stateEnum;
    SOURCE_TYPE = sourceTypeEnum;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEX COLOR FUNCTIONS (for Canvas 2D)
// ═══════════════════════════════════════════════════════════════════════════════

// MODE 1: CLASS - Simple class colors (hex for canvas)
export function getParticleClassColor(p) {
    if (p.state === STATE.CLEARED) return '#00cc00';  // Green
    if (p.state === STATE.LOT || p.state === STATE.PARK) return '#ff8800';  // Orange
    if (p.state === STATE.ROAD) return '#0088ff';  // Blue
    return '#888888';
}

// MODE 2: STALL - Class + stall overlays (hex for canvas)
export function getParticleStallColor(p) {
    if (p.state === STATE.CLEARED) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return '#ff0000';
            if (p.stallReason === 'road_full') return '#ff8800';
            return '#ffcc00';
        }
        return '#00cc00';
    }
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return '#ff8800';
    }
    if (p.state === STATE.ROAD) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return '#ff0000';
            if (p.stallReason === 'lot_full') return '#ff6600';
            if (p.stallReason === 'road_full') return '#ff9900';
            return '#ffcc00';
        }
        return '#0088ff';
    }
    return '#888888';
}

// Legacy function (kept for compatibility)
export function getParticleDebugColor(p) {
    return getParticleStallColor(p);
}

export function getParticleSourceColor(p) {
    switch (p.sourceType) {
        case SOURCE_TYPE.CORRIDOR_WEST:
            return '#ff3333';  // Red - SW/West corridor
        case SOURCE_TYPE.CORRIDOR_EAST:
            return '#3366ff';  // Blue - East corridor
        case SOURCE_TYPE.INDUSTRIAL:
            return '#33cc33';  // Green - Industrial parks
        default:
            return '#888888';  // Grey - Unknown
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RGB COLOR FUNCTIONS (for WebGL)
// ═══════════════════════════════════════════════════════════════════════════════

// MODE 1: CLASS - Simple class colors (no stall overlays)
// ROAD=blue, CLEARED=green, LOT/INDUSTRIAL/PARK=orange
export function getParticleClassColorRGB(p) {
    if (p.state === STATE.CLEARED) {
        return { r: 0, g: 0.8, b: 0 };  // Green
    }
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return { r: 1, g: 0.533, b: 0 };  // Orange (all waiting states)
    }
    if (p.state === STATE.ROAD) {
        return { r: 0, g: 0.533, b: 1 };  // Blue
    }
    return { r: 0.533, g: 0.533, b: 0.533 };
}

// MODE 2: STALL - Class colors + stall reason overlays
export function getParticleStallColorRGB(p) {
    // Cleared particles → green (stalls shown)
    if (p.state === STATE.CLEARED) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return { r: 1, g: 0, b: 0 };
            if (p.stallReason === 'road_full') return { r: 1, g: 0.5, b: 0 };
            return { r: 1, g: 0.8, b: 0 };  // Gold generic
        }
        return { r: 0, g: 0.8, b: 0 };
    }
    // Waiting states → orange (uniform)
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return { r: 1, g: 0.533, b: 0 };
    }
    // ROAD with stall reasons
    if (p.state === STATE.ROAD) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return { r: 1, g: 0, b: 0 };     // Red
            if (p.stallReason === 'lot_full') return { r: 1, g: 0.4, b: 0 };   // Orange-red
            if (p.stallReason === 'road_full') return { r: 1, g: 0.6, b: 0 };  // Orange
            return { r: 1, g: 0.8, b: 0 };  // Gold generic
        }
        return { r: 0, g: 0.533, b: 1 };  // Blue
    }
    return { r: 0.533, g: 0.533, b: 0.533 };
}

// RGB version for WebGL source colors
export function getParticleSourceColorRGB(p) {
    switch (p.sourceType) {
        case SOURCE_TYPE.CORRIDOR_WEST:
            return { r: 1, g: 0.2, b: 0.2 };
        case SOURCE_TYPE.CORRIDOR_EAST:
            return { r: 0.2, g: 0.4, b: 1 };
        case SOURCE_TYPE.INDUSTRIAL:
            return { r: 0.2, g: 0.8, b: 0.2 };
        default:
            return { r: 0.533, g: 0.533, b: 0.533 };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLOR MODE API
// ═══════════════════════════════════════════════════════════════════════════════

export function cycleParticleColorMode() {
    _particleColorMode = (_particleColorMode + 1) % 4;
    const modeName = PARTICLE_COLOR_MODE_NAMES[_particleColorMode];
    console.log(`[PARTICLE] Color mode: ${modeName} (${_particleColorMode}/3)`);
    if (_particleColorMode === 1) {
        console.log('  BLUE=queue, RED=dead_end(NO ROUTE), MAGENTA=lot_full, ORANGE=road_full, CYAN=pre_lot_hold, YELLOW=congested');
    } else if (_particleColorMode === 2) {
        console.log('  RED=West corridor, BLUE=East corridor, GREEN=Industrial parks');
    } else if (_particleColorMode === 3) {
        console.log('  ORANGE=restricted (ROAD/LOT/PARK), CYAN=cleared (heading to bridge)');
    }
    return _particleColorMode;
}

export function getParticleColorMode() {
    return _particleColorMode;
}

export function getParticleColorModeName() {
    return PARTICLE_COLOR_MODE_NAMES[_particleColorMode];
}

// Legacy compatibility
export function toggleParticleDebugClassColors() {
    return cycleParticleColorMode();
}

export function isParticleDebugColors() {
    return _particleColorMode > 0;
}

export function toggleParticleSourceColors() {
    _particleColorMode = 2;  // Jump to source mode
    console.log('[PARTICLE] Color mode: SOURCE');
    return _particleColorMode;
}

export function isParticleSourceColors() {
    return _particleColorMode === 2;
}
