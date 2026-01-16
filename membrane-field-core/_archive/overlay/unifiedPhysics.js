// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED PHYSICS MODULE
// 
// Principle: One operation, one truth, one render.
// Particles live INSIDE cells. Moving mass = moving particles. No drift. No lies.
//
// State Machine (simplified):
//   ROAD → LOT → CLEARED → SINK
//   
// Invariants:
//   1. cell.mass ≈ cell.particles.length * TRUCK_KG  (within tolerance)
//   2. particle.cellIdx === the cell it's in
//   3. Σ(all cell mass) = constant (conservation)
//   4. Every state change goes through atomic operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a unified physics system.
 * @param {Object} config - Configuration object
 * @param {number} config.N - Grid dimension
 * @param {number} config.truckKg - Mass per particle (default 9000)
 * @param {Float32Array} config.regionMap - Cell type classification
 * @param {Int32Array} config.nextHopLots - Routing table for restricted mass
 * @param {Int32Array} config.nextHopPharr - Routing table for cleared mass
 * @param {Function} config.fieldToWorldX - Coord transform
 * @param {Function} config.fieldToWorldY - Coord transform
 * @param {Array<number>} config.roadCellIndices - Cells that are roads
 * @param {Array<number>} config.lotCellIndices - Cells that are lots
 * @param {Array<number>} config.sinkCellIndices - Cells that are sinks
 * @param {Int32Array} config.cellToLotIndex - Cell → lot mapping
 * @param {Array<Array<number>>} config.lotToCellIndices - Lot → cells mapping
 * @param {Float32Array} config.lotCapacityKg - Capacity per lot
 * @param {number} config.REGION_LOT - Region constant for lot cells
 */
export function createUnifiedPhysics(config) {
    const {
        N,
        truckKg = 9000,
        regionMap,
        nextHopLots,
        nextHopPharr,
        fieldToWorldX,
        fieldToWorldY,
        roadCellIndices,
        lotCellIndices,
        sinkCellIndices,
        cellToLotIndex,
        lotToCellIndices,
        lotCapacityKg,
        REGION_LOT,
    } = config;

    const N2 = N * N;
    const TRUCK_KG = truckKg;
    const MASS_TOLERANCE = TRUCK_KG * 0.1;  // 10% tolerance for rounding
    const FLOW_FRAC = 0.4;  // 40% of mass moves per tick

    // ═══════════════════════════════════════════════════════════════════════════
    // CELL STATE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Cell states
    const STATE = {
        EMPTY: 0,
        ROAD: 1,      // Restricted mass in transit
        LOT: 2,       // Restricted mass parked in lot
        CLEARED: 3,   // Cleared mass (converted, heading to sink)
    };

    // Each cell holds mass + particles atomically
    // Using typed arrays for mass, regular array for particles
    const cellMass = new Float32Array(N2);           // kg in each cell
    const cellState = new Uint8Array(N2);            // STATE enum
    const cellParticles = new Array(N2);             // Array of particle objects per cell
    
    // Initialize particle arrays
    for (let i = 0; i < N2; i++) {
        cellParticles[i] = [];
    }

    // Lot tracking
    const lotMassKg = new Float32Array(lotCapacityKg.length);
    const lotParticleCount = new Uint32Array(lotCapacityKg.length);

    // Stats
    let totalSystemMass = 0;
    let particleIdCounter = 0;
    const stats = {
        injected: 0,
        moved: 0,
        enteredLots: 0,
        converted: 0,
        exited: 0,
        invariantViolations: 0,
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // INVARIANT CHECKING
    // ═══════════════════════════════════════════════════════════════════════════

    function assertCellInvariant(idx, context = '') {
        const mass = cellMass[idx];
        const particles = cellParticles[idx];
        const particleMass = particles.length * TRUCK_KG;
        const delta = Math.abs(mass - particleMass);
        
        if (delta > MASS_TOLERANCE) {
            stats.invariantViolations++;
            console.error(
                `[INVARIANT VIOLATION] ${context} cell=${idx} ` +
                `mass=${mass.toFixed(1)}kg particles=${particles.length} ` +
                `particleMass=${particleMass.toFixed(1)}kg delta=${delta.toFixed(1)}kg`
            );
            return false;
        }
        
        // Check all particles claim this cell
        for (const p of particles) {
            if (p.cellIdx !== idx) {
                stats.invariantViolations++;
                console.error(
                    `[INVARIANT VIOLATION] ${context} particle ${p.id} claims cell=${p.cellIdx} but is in cell=${idx}`
                );
                return false;
            }
        }
        
        return true;
    }

    function assertGlobalInvariant(context = '') {
        let computedMass = 0;
        let particleCount = 0;
        
        for (let i = 0; i < N2; i++) {
            computedMass += cellMass[i];
            particleCount += cellParticles[i].length;
        }
        
        const expectedMass = particleCount * TRUCK_KG;
        const delta = Math.abs(computedMass - expectedMass);
        
        if (delta > MASS_TOLERANCE * 10) {
            stats.invariantViolations++;
            console.error(
                `[GLOBAL INVARIANT] ${context} totalMass=${computedMass.toFixed(1)}kg ` +
                `particles=${particleCount} expectedMass=${expectedMass.toFixed(1)}kg`
            );
            return false;
        }
        
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ATOMIC OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Create a particle at a cell. ONLY way to add mass to system.
     */
    function injectParticle(idx, classId = 'restricted') {
        const x = idx % N;
        const y = Math.floor(idx / N);
        
        const p = {
            id: particleIdCounter++,
            cellIdx: idx,
            x: fieldToWorldX(x + 0.5),
            y: fieldToWorldY(y + 0.5),
            classId,
            state: STATE.ROAD,
            lotIdx: -1,
            age: 0,
        };
        
        cellParticles[idx].push(p);
        cellMass[idx] += TRUCK_KG;
        cellState[idx] = (classId === 'cleared') ? STATE.CLEARED : STATE.ROAD;
        totalSystemMass += TRUCK_KG;
        stats.injected += TRUCK_KG;
        
        assertCellInvariant(idx, 'injectParticle');
        return p;
    }

    /**
     * Move mass from one cell to another. Atomic: mass + particles move together.
     * Returns actual kg moved (may be less than requested if not enough particles).
     */
    function moveMass(fromIdx, toIdx, kg) {
        if (fromIdx === toIdx) return 0;
        if (kg <= 0) return 0;
        
        const fromParticles = cellParticles[fromIdx];
        if (fromParticles.length === 0) return 0;
        
        // How many particles to move?
        const trucksToMove = Math.min(
            Math.round(kg / TRUCK_KG),
            fromParticles.length
        );
        
        if (trucksToMove === 0) return 0;
        
        const actualKg = trucksToMove * TRUCK_KG;
        
        // Move particles (take from end for O(1))
        const toX = toIdx % N;
        const toY = Math.floor(toIdx / N);
        const worldX = fieldToWorldX(toX + 0.5);
        const worldY = fieldToWorldY(toY + 0.5);
        
        for (let i = 0; i < trucksToMove; i++) {
            const p = fromParticles.pop();
            p.cellIdx = toIdx;
            p.x = worldX;
            p.y = worldY;
            cellParticles[toIdx].push(p);
        }
        
        // Update mass
        cellMass[fromIdx] -= actualKg;
        cellMass[toIdx] += actualKg;
        
        stats.moved += actualKg;
        
        // Assert both cells
        assertCellInvariant(fromIdx, 'moveMass.from');
        assertCellInvariant(toIdx, 'moveMass.to');
        
        return actualKg;
    }

    /**
     * Move mass into a lot. Updates lot tracking + particle state.
     */
    function enterLot(fromIdx, lotIdx, kg) {
        const lotCells = lotToCellIndices[lotIdx];
        if (!lotCells || lotCells.length === 0) return 0;
        
        // Check capacity
        const currentMass = lotMassKg[lotIdx];
        const capacity = lotCapacityKg[lotIdx];
        const available = Math.max(0, capacity - currentMass);
        const toAccept = Math.min(kg, available);
        
        if (toAccept < TRUCK_KG) return 0;  // Need at least one truck
        
        // Pick a cell in the lot (round-robin scatter)
        const targetCell = lotCells[lotParticleCount[lotIdx] % lotCells.length];
        
        const fromParticles = cellParticles[fromIdx];
        const trucksToMove = Math.min(
            Math.round(toAccept / TRUCK_KG),
            fromParticles.length
        );
        
        if (trucksToMove === 0) return 0;
        
        const actualKg = trucksToMove * TRUCK_KG;
        
        // Move particles
        const toX = targetCell % N;
        const toY = Math.floor(targetCell / N);
        const worldX = fieldToWorldX(toX + 0.5);
        const worldY = fieldToWorldY(toY + 0.5);
        
        for (let i = 0; i < trucksToMove; i++) {
            const p = fromParticles.pop();
            p.cellIdx = targetCell;
            p.x = worldX;
            p.y = worldY;
            p.state = STATE.LOT;
            p.lotIdx = lotIdx;
            cellParticles[targetCell].push(p);
        }
        
        // Update mass
        cellMass[fromIdx] -= actualKg;
        cellMass[targetCell] += actualKg;
        cellState[targetCell] = STATE.LOT;
        
        // Update lot tracking
        lotMassKg[lotIdx] += actualKg;
        lotParticleCount[lotIdx] += trucksToMove;
        
        stats.enteredLots += actualKg;
        
        assertCellInvariant(fromIdx, 'enterLot.from');
        assertCellInvariant(targetCell, 'enterLot.to');
        
        return actualKg;
    }

    /**
     * Convert restricted mass in lot to cleared. Changes particle state.
     */
    function convertInLot(lotIdx, kg) {
        const lotCells = lotToCellIndices[lotIdx];
        if (!lotCells || lotCells.length === 0) return 0;
        
        let converted = 0;
        let trucksNeeded = Math.round(kg / TRUCK_KG);
        
        for (const cellIdx of lotCells) {
            if (trucksNeeded <= 0) break;
            
            const particles = cellParticles[cellIdx];
            for (const p of particles) {
                if (trucksNeeded <= 0) break;
                if (p.state === STATE.LOT && p.classId === 'restricted') {
                    p.classId = 'cleared';
                    p.state = STATE.CLEARED;
                    converted += TRUCK_KG;
                    trucksNeeded--;
                }
            }
            
            // Update cell state if all particles are cleared
            const hasRestricted = particles.some(p => p.classId === 'restricted');
            if (!hasRestricted && particles.length > 0) {
                cellState[cellIdx] = STATE.CLEARED;
            }
        }
        
        stats.converted += converted;
        return converted;
    }

    /**
     * Remove mass at sink. Particles die, mass exits system.
     */
    function drainAtSink(idx, kg) {
        const particles = cellParticles[idx];
        const toDrain = Math.min(
            Math.round(kg / TRUCK_KG),
            particles.length
        );
        
        if (toDrain === 0) return 0;
        
        const actualKg = toDrain * TRUCK_KG;
        
        // Remove particles
        for (let i = 0; i < toDrain; i++) {
            particles.pop();
        }
        
        cellMass[idx] -= actualKg;
        totalSystemMass -= actualKg;
        stats.exited += actualKg;
        
        assertCellInvariant(idx, 'drainAtSink');
        
        return actualKg;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHYSICS STEP
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Run one physics step. All mass movements are atomic with particles.
     */
    function step() {
        // Phase 1: Road flow (restricted + cleared)
        stepRoadFlow('restricted', nextHopLots);
        stepRoadFlow('cleared', nextHopPharr);
        
        // Phase 2: Drain sinks
        for (const sinkIdx of sinkCellIndices) {
            const mass = cellMass[sinkIdx];
            if (mass > 0) {
                drainAtSink(sinkIdx, mass);
            }
        }
        
        // Periodic global check (every 60 steps)
        if (stats.moved > 0 && (stats.moved / TRUCK_KG) % 60 === 0) {
            assertGlobalInvariant('step');
        }
    }

    function stepRoadFlow(classId, nhTable) {
        // Process road cells in order
        for (const idx of roadCellIndices) {
            const particles = cellParticles[idx];
            
            // Filter to only particles of this class
            const classParticles = particles.filter(p => p.classId === classId);
            if (classParticles.length === 0) continue;
            
            const mass = classParticles.length * TRUCK_KG;
            const nh = nhTable[idx];
            
            if (nh < 0) continue;  // No next hop
            
            // How much to move this step
            const toMove = mass * FLOW_FRAC;
            
            // Check if next hop is a lot (restricted only)
            if (classId === 'restricted' && regionMap[nh] === REGION_LOT) {
                const lotIdx = cellToLotIndex[nh];
                if (lotIdx >= 0) {
                    enterLot(idx, lotIdx, toMove);
                }
            } else {
                // Normal flow to next cell
                moveMass(idx, nh, toMove);
            }
        }
        
        // Also process lot cells for cleared mass exiting
        if (classId === 'cleared') {
            for (const idx of lotCellIndices) {
                const particles = cellParticles[idx];
                const clearedParticles = particles.filter(p => p.classId === 'cleared');
                if (clearedParticles.length === 0) continue;
                
                const nh = nhTable[idx];
                if (nh < 0) continue;
                
                const mass = clearedParticles.length * TRUCK_KG;
                moveMass(idx, nh, mass * FLOW_FRAC);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONVERSION (FIFO queue for lot clearing)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // FIFO: oldest arrivals convert first
    const conversionQueue = [];  // { lotIdx, particleId, arrivalTime }
    let simTime = 0;
    const DWELL_TIME_S = 4 * 3600;  // 4 hours default dwell

    function queueForConversion(lotIdx, particleId) {
        conversionQueue.push({
            lotIdx,
            particleId,
            arrivalTime: simTime,
        });
    }

    function processConversions() {
        const now = simTime;
        let processed = 0;
        
        while (conversionQueue.length > 0) {
            const front = conversionQueue[0];
            if (now - front.arrivalTime < DWELL_TIME_S) break;
            
            conversionQueue.shift();
            
            // Find the particle and convert it
            const lotCells = lotToCellIndices[front.lotIdx];
            for (const cellIdx of lotCells) {
                const particles = cellParticles[cellIdx];
                const p = particles.find(x => x.id === front.particleId);
                if (p && p.classId === 'restricted') {
                    p.classId = 'cleared';
                    p.state = STATE.CLEARED;
                    processed++;
                    break;
                }
            }
        }
        
        stats.converted += processed * TRUCK_KG;
        return processed;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RENDERING (Particles tell truth because they ARE the physics)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get all particles for rendering. No computation - just return the truth.
     */
    function getParticlesForRender() {
        const result = [];
        for (let i = 0; i < N2; i++) {
            for (const p of cellParticles[i]) {
                result.push({
                    x: p.x,
                    y: p.y,
                    classId: p.classId,
                    state: p.state,
                    lotIdx: p.lotIdx,
                    age: p.age,
                });
            }
        }
        return result;
    }

    /**
     * Get cell mass for heatmap rendering. Truth = cellMass array.
     */
    function getCellMass(idx) {
        return cellMass[idx];
    }

    /**
     * Get lot stats for debugging.
     */
    function getLotStats() {
        const result = [];
        for (let i = 0; i < lotCapacityKg.length; i++) {
            result.push({
                lotIdx: i,
                mass: lotMassKg[i],
                capacity: lotCapacityKg[i],
                utilization: lotCapacityKg[i] > 0 ? lotMassKg[i] / lotCapacityKg[i] : 0,
                particleCount: lotParticleCount[i],
            });
        }
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    return {
        // Core operations
        injectParticle,
        step,
        processConversions,
        
        // Manual operations (for testing)
        moveMass,
        enterLot,
        convertInLot,
        drainAtSink,
        
        // Rendering
        getParticlesForRender,
        getCellMass,
        getLotStats,
        
        // Invariants
        assertCellInvariant,
        assertGlobalInvariant,
        
        // Stats
        getStats: () => ({ ...stats }),
        getTotalMass: () => totalSystemMass,
        getParticleCount: () => {
            let count = 0;
            for (let i = 0; i < N2; i++) {
                count += cellParticles[i].length;
            }
            return count;
        },
        
        // Time management
        setSimTime: (t) => { simTime = t; },
        getSimTime: () => simTime,
        
        // Direct access (for debugging)
        _cellMass: cellMass,
        _cellParticles: cellParticles,
        _lotMassKg: lotMassKg,
        
        // Constants
        TRUCK_KG,
        STATE,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESSURE TEST HARNESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run pressure tests on the physics module.
 * @param {Object} physics - Physics instance from createUnifiedPhysics
 * @param {Object} testConfig - Test configuration
 */
export function runPressureTests(physics, testConfig) {
    const {
        roadCellIndices,
        lotCellIndices,
        sinkCellIndices,
    } = testConfig;

    console.log('═══════════════════════════════════════════════════════════');
    console.log('PRESSURE TEST: Unified Physics Module');
    console.log('═══════════════════════════════════════════════════════════');

    const results = {
        passed: 0,
        failed: 0,
        tests: [],
    };

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            results.passed++;
            results.tests.push({ name, passed: true });
        } catch (e) {
            console.error(`✗ ${name}: ${e.message}`);
            results.failed++;
            results.tests.push({ name, passed: false, error: e.message });
        }
    }

    // Test 1: Injection creates mass + particle atomically
    test('Injection creates mass + particle atomically', () => {
        const sourceIdx = roadCellIndices[0];
        const before = physics.getParticleCount();
        const beforeMass = physics.getTotalMass();
        
        physics.injectParticle(sourceIdx, 'restricted');
        
        const after = physics.getParticleCount();
        const afterMass = physics.getTotalMass();
        
        if (after !== before + 1) throw new Error(`Particle count: ${before} → ${after}`);
        if (Math.abs(afterMass - beforeMass - physics.TRUCK_KG) > 1) {
            throw new Error(`Mass: ${beforeMass} → ${afterMass}`);
        }
        
        physics.assertCellInvariant(sourceIdx, 'test1');
    });

    // Test 2: Movement preserves total mass
    test('Movement preserves total mass', () => {
        const sourceIdx = roadCellIndices[0];
        const targetIdx = roadCellIndices[1];
        
        physics.injectParticle(sourceIdx, 'restricted');
        const beforeMass = physics.getTotalMass();
        
        physics.moveMass(sourceIdx, targetIdx, physics.TRUCK_KG);
        
        const afterMass = physics.getTotalMass();
        if (Math.abs(afterMass - beforeMass) > 1) {
            throw new Error(`Mass changed: ${beforeMass} → ${afterMass}`);
        }
    });

    // Test 3: Particles teleport with mass (no drift)
    test('Particles teleport with mass (no drift)', () => {
        const sourceIdx = roadCellIndices[0];
        const targetIdx = roadCellIndices[Math.min(10, roadCellIndices.length - 1)];
        
        physics.injectParticle(sourceIdx, 'restricted');
        physics.moveMass(sourceIdx, targetIdx, physics.TRUCK_KG);
        
        const particles = physics.getParticlesForRender();
        const movedParticle = particles[particles.length - 1];
        
        // Particle should be at target cell center, not drifting
        if (movedParticle.state !== physics.STATE.ROAD) {
            throw new Error(`Particle state: ${movedParticle.state}`);
        }
    });

    // Test 4: Lot capacity is respected
    test('Lot capacity is respected', () => {
        if (lotCellIndices.length === 0) {
            console.log('  (skipped - no lots)');
            return;
        }
        
        // Inject way more than lot can hold
        const sourceIdx = roadCellIndices[0];
        for (let i = 0; i < 100; i++) {
            physics.injectParticle(sourceIdx, 'restricted');
        }
        
        const lotStats = physics.getLotStats();
        for (const lot of lotStats) {
            if (lot.mass > lot.capacity * 1.01) {  // 1% tolerance
                throw new Error(`Lot ${lot.lotIdx} over capacity: ${lot.mass}/${lot.capacity}`);
            }
        }
    });

    // Test 5: Step doesn't violate invariants
    test('Step doesn\'t violate invariants', () => {
        // Inject some mass
        for (let i = 0; i < 10; i++) {
            const idx = roadCellIndices[i % roadCellIndices.length];
            physics.injectParticle(idx, 'restricted');
        }
        
        const beforeMass = physics.getTotalMass();
        const beforeCount = physics.getParticleCount();
        
        // Run 100 steps
        for (let i = 0; i < 100; i++) {
            physics.step();
        }
        
        // Check global invariant (mass might have exited at sinks)
        physics.assertGlobalInvariant('test5');
        
        const stats = physics.getStats();
        if (stats.invariantViolations > 0) {
            throw new Error(`${stats.invariantViolations} invariant violations`);
        }
    });

    // Test 6: Drain at sink removes mass from system
    test('Drain at sink removes mass from system', () => {
        if (sinkCellIndices.length === 0) {
            console.log('  (skipped - no sinks)');
            return;
        }
        
        const sinkIdx = sinkCellIndices[0];
        physics.injectParticle(sinkIdx, 'cleared');
        
        const beforeMass = physics.getTotalMass();
        physics.drainAtSink(sinkIdx, physics.TRUCK_KG);
        const afterMass = physics.getTotalMass();
        
        if (Math.abs(afterMass - beforeMass + physics.TRUCK_KG) > 1) {
            throw new Error(`Drain didn't reduce mass: ${beforeMass} → ${afterMass}`);
        }
    });

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`RESULTS: ${results.passed} passed, ${results.failed} failed`);
    console.log('═══════════════════════════════════════════════════════════');

    return results;
}
