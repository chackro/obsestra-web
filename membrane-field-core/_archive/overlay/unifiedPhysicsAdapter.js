// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED PHYSICS ADAPTER
// 
// Bridges the new unified physics module with the existing reynosaOverlay renderer.
// Provides drop-in replacement for the old particle layer + graphFlowClass.
//
// Usage:
//   1. Import this adapter into reynosaOverlay.js
//   2. Replace createParticleLayer with createUnifiedAdapter
//   3. Replace graphFlowClass calls with adapter.step()
//   4. Rendering uses adapter.getParticlesForRender()
// ═══════════════════════════════════════════════════════════════════════════════

import { createUnifiedPhysics, runPressureTests } from './unifiedPhysics.js';

/**
 * Create an adapter that makes unified physics work with existing renderer.
 * @param {Object} config - Same config structure as old particle layer
 */
export function createUnifiedAdapter(config) {
    const {
        N,
        regionMap,
        nextHop_lots,
        nextHop_pharr,
        fieldToWorldX,
        fieldToWorldY,
        worldToFieldX,
        worldToFieldY,
        roadCellIndices,
        lotCellIndices,
        sinkCellIndices,
        cellToLotIndex,
        lotToCellIndices,
        lotCapacityKg,
        REGION_LOT,
        G,  // Sink gradient (legacy)
        TRUCK_KG = 9000,
    } = config;

    // Create unified physics instance
    const physics = createUnifiedPhysics({
        N,
        truckKg: TRUCK_KG,
        regionMap,
        nextHopLots: nextHop_lots,
        nextHopPharr: nextHop_pharr,
        fieldToWorldX,
        fieldToWorldY,
        roadCellIndices,
        lotCellIndices,
        sinkCellIndices,
        cellToLotIndex,
        lotToCellIndices,
        lotCapacityKg,
        REGION_LOT,
    });

    // Accumulator for sub-truck mass injection (preserves old behavior)
    const injectionAccumulator = new Map();  // sourceIdx → kg

    // ═══════════════════════════════════════════════════════════════════════════
    // API MATCHING OLD PARTICLE LAYER
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Inject mass at a source cell. Matches old emitParticleByMass signature.
     * @param {number} sourceIdx - Cell index
     * @param {number} kg - Mass to inject
     * @param {string} classId - 'restricted' or 'cleared'
     */
    function injectMass(sourceIdx, kg, classId = 'restricted') {
        let acc = injectionAccumulator.get(sourceIdx) || 0;
        acc += kg;
        
        while (acc >= TRUCK_KG) {
            physics.injectParticle(sourceIdx, classId);
            acc -= TRUCK_KG;
        }
        
        injectionAccumulator.set(sourceIdx, acc);
    }

    /**
     * Step physics forward. Replaces graphFlowClass.
     * @param {number} dt - Time delta in seconds
     */
    function step(dt) {
        physics.setSimTime(physics.getSimTime() + dt);
        physics.step();
        physics.processConversions();
    }

    /**
     * Get particles for rendering. Returns format compatible with old renderer.
     */
    function getParticlesForRender() {
        const raw = physics.getParticlesForRender();
        
        // Map to old format expected by render code
        return raw.map(p => ({
            x: p.x,
            y: p.y,
            classId: p.classId,
            waitingInLot: p.state === physics.STATE.LOT,
            lotParked: p.state === physics.STATE.LOT,
            age: p.age,
            life: 1,  // All alive
        }));
    }

    /**
     * Get rho array for heatmap. Sums mass across all states.
     * @param {string} classId - 'restricted' or 'cleared'
     */
    function getRhoArray(classId) {
        const N2 = N * N;
        const result = new Float32Array(N2);
        
        for (let i = 0; i < N2; i++) {
            for (const p of physics._cellParticles[i]) {
                if (p.classId === classId) {
                    result[i] += TRUCK_KG;
                }
            }
        }
        
        return result;
    }

    /**
     * Get lot utilization stats. Matches old format.
     */
    function getLotUtilization() {
        return physics.getLotStats().map(s => ({
            lotIdx: s.lotIdx,
            utilization: s.utilization,
            massKg: s.mass,
            capacityKg: s.capacity,
            particleCount: s.particleCount,
        }));
    }

    /**
     * Reset all state.
     */
    function reset() {
        // Clear all cells
        const N2 = N * N;
        for (let i = 0; i < N2; i++) {
            physics._cellMass[i] = 0;
            physics._cellParticles[i].length = 0;
        }
        
        // Clear lot tracking
        for (let i = 0; i < physics._lotMassKg.length; i++) {
            physics._lotMassKg[i] = 0;
        }
        
        // Clear accumulators
        injectionAccumulator.clear();
    }

    /**
     * Run pressure tests. Returns test results.
     */
    function runTests() {
        return runPressureTests(physics, {
            roadCellIndices,
            lotCellIndices,
            sinkCellIndices,
        });
    }

    /**
     * Debug: Assert all invariants now.
     */
    function assertAllInvariants() {
        const N2 = N * N;
        let violations = 0;
        
        for (let i = 0; i < N2; i++) {
            if (physics._cellMass[i] > 0 || physics._cellParticles[i].length > 0) {
                if (!physics.assertCellInvariant(i, 'manualCheck')) {
                    violations++;
                }
            }
        }
        
        if (!physics.assertGlobalInvariant('manualCheck')) {
            violations++;
        }
        
        return violations;
    }

    /**
     * Get stats for logging.
     */
    function getStats() {
        const pStats = physics.getStats();
        return {
            totalMass: physics.getTotalMass(),
            particleCount: physics.getParticleCount(),
            ...pStats,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER INTEGRATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Render particles to canvas. Self-contained - no external state needed.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} camera - Camera with worldToScreen method
     */
    function render(ctx, camera) {
        const particles = physics.getParticlesForRender();
        const particleR = Math.max(1, camera.metersToPixels(6));
        
        ctx.fillStyle = '#000';
        ctx.beginPath();
        
        for (const p of particles) {
            const screen = camera.worldToScreen({ x: p.x, y: p.y });
            ctx.moveTo(screen.x + particleR, screen.y);
            ctx.arc(screen.x, screen.y, particleR, 0, Math.PI * 2);
        }
        
        ctx.fill();
    }

    /**
     * Render particles with debug coloring by state.
     */
    function renderDebug(ctx, camera) {
        const particles = physics.getParticlesForRender();
        const particleR = Math.max(2, camera.metersToPixels(8));
        
        // Group by state for batch rendering
        const byState = {
            [physics.STATE.ROAD]: [],
            [physics.STATE.LOT]: [],
            [physics.STATE.CLEARED]: [],
        };
        
        for (const p of particles) {
            byState[p.state]?.push(p);
        }
        
        // ROAD = blue
        ctx.fillStyle = 'rgba(0, 100, 255, 0.8)';
        ctx.beginPath();
        for (const p of byState[physics.STATE.ROAD]) {
            const screen = camera.worldToScreen({ x: p.x, y: p.y });
            ctx.moveTo(screen.x + particleR, screen.y);
            ctx.arc(screen.x, screen.y, particleR, 0, Math.PI * 2);
        }
        ctx.fill();
        
        // LOT = orange
        ctx.fillStyle = 'rgba(255, 140, 0, 0.8)';
        ctx.beginPath();
        for (const p of byState[physics.STATE.LOT]) {
            const screen = camera.worldToScreen({ x: p.x, y: p.y });
            ctx.moveTo(screen.x + particleR, screen.y);
            ctx.arc(screen.x, screen.y, particleR, 0, Math.PI * 2);
        }
        ctx.fill();
        
        // CLEARED = green
        ctx.fillStyle = 'rgba(0, 200, 0, 0.8)';
        ctx.beginPath();
        for (const p of byState[physics.STATE.CLEARED]) {
            const screen = camera.worldToScreen({ x: p.x, y: p.y });
            ctx.moveTo(screen.x + particleR, screen.y);
            ctx.arc(screen.x, screen.y, particleR, 0, Math.PI * 2);
        }
        ctx.fill();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RETURN PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    return {
        // Core operations
        injectMass,
        step,
        reset,
        
        // Rendering
        getParticlesForRender,
        getRhoArray,
        render,
        renderDebug,
        
        // Stats & debug
        getLotUtilization,
        getStats,
        assertAllInvariants,
        runTests,
        
        // Direct physics access (for advanced use)
        physics,
        
        // Constants
        TRUCK_KG,
        STATE: physics.STATE,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLE TEST (run in browser dev tools)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quick test you can run from browser console.
 * Usage: window.testUnifiedPhysics()
 */
export function installConsoleTest(adapter) {
    window.testUnifiedPhysics = () => {
        console.log('Running unified physics pressure tests...');
        const results = adapter.runTests();
        console.log('Results:', results);
        return results;
    };
    
    window.checkInvariants = () => {
        const violations = adapter.assertAllInvariants();
        console.log(`Invariant check: ${violations} violations`);
        return violations;
    };
    
    window.physicsStats = () => {
        const stats = adapter.getStats();
        console.table(stats);
        return stats;
    };
    
    window.lotStats = () => {
        const lots = adapter.getLotUtilization();
        console.table(lots);
        return lots;
    };
    
    console.log('Unified physics test functions installed:');
    console.log('  testUnifiedPhysics() - Run pressure tests');
    console.log('  checkInvariants()    - Check all invariants');
    console.log('  physicsStats()       - Show physics stats');
    console.log('  lotStats()           - Show lot utilization');
}
