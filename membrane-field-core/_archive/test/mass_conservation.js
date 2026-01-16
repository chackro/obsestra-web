// ═══════════════════════════════════════════════════════════════════════════════
// MASS CONSERVATION TEST
// Verifies that reynosaOverlay physics conserves mass correctly.
// Tests the ACTIVE physics engine (not the deprecated fieldPhysics.js).
// ═══════════════════════════════════════════════════════════════════════════════

import { ReynosaEastOverlay, getMetrics, getClassDensities, forceRebuildPhiBase } from '../overlay/reynosaOverlay.js';
import { createTestRendererContext, createMockCamera, createMockTime } from './stubGeometryProvider.js';

// ───────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ───────────────────────────────────────────────────────────────────────────────

const results = [];

function test(name, fn) {
    try {
        fn();
        results.push({ name, passed: true });
        console.log(`✓ ${name}`);
    } catch (e) {
        results.push({ name, passed: false, error: e.message });
        console.log(`✗ ${name}: ${e.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        results.push({ name, passed: true });
        console.log(`✓ ${name}`);
    } catch (e) {
        results.push({ name, passed: false, error: e.message });
        console.log(`✗ ${name}: ${e.message}`);
    }
}

function assertEqual(actual, expected, msg, tolerance = 0) {
    if (tolerance > 0) {
        if (Math.abs(actual - expected) > tolerance) {
            throw new Error(`${msg}: expected ${expected} ± ${tolerance}, got ${actual}`);
        }
    } else {
        if (actual !== expected) {
            throw new Error(`${msg}: expected ${expected}, got ${actual}`);
        }
    }
}

function assertInRange(actual, min, max, msg) {
    if (actual < min || actual > max) {
        throw new Error(`${msg}: expected [${min}, ${max}], got ${actual}`);
    }
}

function assertGreater(actual, threshold, msg) {
    if (actual <= threshold) {
        throw new Error(`${msg}: expected > ${threshold}, got ${actual}`);
    }
}

function assertLess(actual, threshold, msg) {
    if (actual >= threshold) {
        throw new Error(`${msg}: expected < ${threshold}, got ${actual}`);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// HELPER: Run physics ticks
// ───────────────────────────────────────────────────────────────────────────────

function runTicks(camera, time, ticks) {
    for (let i = 0; i < ticks; i++) {
        ReynosaEastOverlay.onFrame(camera, time);
    }
}

function getTotalMass() {
    const metrics = getMetrics();
    return metrics.total;
}

function sumDensityArrays() {
    const { restricted, cleared } = getClassDensities();
    let total = 0;
    for (let i = 0; i < restricted.length; i++) {
        total += restricted[i] + cleared[i];
    }
    return total;
}

// ───────────────────────────────────────────────────────────────────────────────
// TESTS
// ───────────────────────────────────────────────────────────────────────────────

export async function runTests() {
    console.log('\n=== MASS CONSERVATION TESTS (reynosaOverlay) ===\n');

    // Create test context with no inflow (for pure conservation tests)
    const context = createTestRendererContext({
        inflowKgPerHour: 0,
        capacityKgPerHour: 10000,
    });
    const camera = createMockCamera();
    const time = createMockTime();

    // Attach overlay
    ReynosaEastOverlay.onAttach(context);

    // Build potential field
    await testAsync('Potential field builds successfully', async () => {
        await forceRebuildPhiBase();
    });

    test('Initial mass is zero (no injection)', () => {
        const mass = getTotalMass();
        assertEqual(mass, 0, 'Initial mass', 0.001);
    });

    // Now test with injection
    await testAsync('Injection increases mass', async () => {
        // Reattach with injection enabled
        ReynosaEastOverlay.onDetach();
        const ctxWithInflow = createTestRendererContext({
            inflowKgPerHour: 10000,
            capacityKgPerHour: 50000, // High capacity so sink doesn't limit
        });
        ReynosaEastOverlay.onAttach(ctxWithInflow);
        await forceRebuildPhiBase();

        const massBefore = getTotalMass();

        // Run 100 ticks
        runTicks(camera, time, 100);

        const massAfter = getTotalMass();

        // Mass should have increased
        assertGreater(massAfter, massBefore, 'Mass after injection');

        console.log(`  Injected ${(massAfter - massBefore).toFixed(2)} kg in 100 ticks`);
    });

    await testAsync('Metrics match density array sum', async () => {
        const metricsTotal = getTotalMass();
        const arraySum = sumDensityArrays();

        // Should be equal (within floating point tolerance)
        assertEqual(metricsTotal, arraySum, 'Metrics vs array sum', 0.01);
    });

    await testAsync('Mass never goes negative after many ticks', async () => {
        // Run many more ticks
        runTicks(camera, time, 500);

        const { restricted, cleared } = getClassDensities();

        // Check no negative values
        for (let i = 0; i < restricted.length; i++) {
            if (restricted[i] < -0.0001) {
                throw new Error(`Negative restricted mass at cell ${i}: ${restricted[i]}`);
            }
            if (cleared[i] < -0.0001) {
                throw new Error(`Negative cleared mass at cell ${i}: ${cleared[i]}`);
            }
        }
    });

    await testAsync('Drain removes mass when at sink', async () => {
        // Reattach with high injection, limited capacity
        ReynosaEastOverlay.onDetach();
        const ctxDrain = createTestRendererContext({
            inflowKgPerHour: 50000,
            capacityKgPerHour: 10000, // Limited capacity creates backlog
        });
        ReynosaEastOverlay.onAttach(ctxDrain);
        await forceRebuildPhiBase();

        // Run to build up mass
        runTicks(camera, time, 200);

        const metrics = getMetrics();

        // Should have throughput > 0
        assertGreater(metrics.throughput_kg_per_hr, 0, 'Throughput rate');

        console.log(`  Throughput: ${(metrics.throughput_kg_per_hr / 1000).toFixed(1)} t/hr`);
        console.log(`  Total mass: ${(metrics.total / 1000).toFixed(1)} t`);
    });

    await testAsync('Steady state: mass stabilizes', async () => {
        // Continue running
        runTicks(camera, time, 300);
        const mass1 = getTotalMass();

        // Run more
        runTicks(camera, time, 100);
        const mass2 = getTotalMass();

        // Mass should be relatively stable (within 20% change - relaxed for graph flow)
        const change = Math.abs(mass2 - mass1) / Math.max(mass1, 1);
        assertInRange(change, 0, 0.2, 'Mass stability at steady state');

        console.log(`  Steady state mass: ${(mass2 / 1000).toFixed(1)} t (change: ${(change * 100).toFixed(1)}%)`);
    });

    // Cleanup
    ReynosaEastOverlay.onDetach();

    // Summary
    console.log('\n=== SUMMARY ===');
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`${passed} passed, ${failed} failed\n`);

    return { passed, failed, results };
}

// Auto-run if loaded directly
if (typeof window !== 'undefined') {
    window.runMassConservationTests = runTests;
    console.log('Mass conservation tests loaded. Run: runMassConservationTests()');
}
