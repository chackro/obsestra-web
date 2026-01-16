import path from 'path';
import { fileURLToPath } from 'url';
import { runScenario } from './masterTracker.js';
import {
  togglePhasesAsLots,
  isPhasesAsLots,
  setInovusCapacityMultiplier,
} from '../overlay/reynosaOverlay_v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
let dt = 10;  // default

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dt' || args[i] === '-d') {
    dt = parseInt(args[++i], 10);
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node determinismTest.js [--dt N]');
    console.log('');
    console.log('Options:');
    console.log('  --dt, -d N    Time step in seconds (default: 10)');
    console.log('');
    console.log('Examples:');
    console.log('  node determinismTest.js --dt 40');
    console.log('  node determinismTest.js -d 20');
    process.exit(0);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const HOUR = 3600;
const DAYS = 3;  // 1 day warmup + 2 days measurement

const RUN_OPTS = {
  duration: DAYS * 24 * HOUR,
  warmupSeconds: 24 * HOUR,
  dt,
  sampleInterval: 300,
};

const bundlePath = path.resolve(__dirname, '../test/bundle_baseline.json');

const applyScenario = async () => {
  if (isPhasesAsLots()) await togglePhasesAsLots();
  setInovusCapacityMultiplier(1.0);
};

// ═══════════════════════════════════════════════════════════════
// RUN SAME SCENARIO TWICE
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`DETERMINISM TEST: baseline vs baseline @ dt=${dt}`);
console.log(`${'═'.repeat(60)}`);
console.log(`Duration: ${DAYS} days (${RUN_OPTS.warmupSeconds / HOUR}h warmup + ${(RUN_OPTS.duration - RUN_OPTS.warmupSeconds) / HOUR}h measurement)`);
console.log(`dt: ${RUN_OPTS.dt}s`);
console.log(`${'═'.repeat(60)}\n`);

console.log('>>> Run A...');
const runA = await runScenario({
  bundlePath,
  ...RUN_OPTS,
  scenarioName: 'baseline_A',
  applyScenario,
});

console.log('\n>>> Run B...');
const runB = await runScenario({
  bundlePath,
  ...RUN_OPTS,
  scenarioName: 'baseline_B',
  applyScenario,
});

// ═══════════════════════════════════════════════════════════════
// COMPARE
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log('COMPARISON');
console.log(`${'═'.repeat(60)}`);

const metrics = [
  'truckHoursLost_final',
  'exitedKgPerHour_mean',
  'truckHoursLostPerHour_mean',
  'throughputKgPerHour',
  'stallTonHoursSlope',
];

let allMatch = true;

for (const m of metrics) {
  const a = runA.summary[m];
  const b = runB.summary[m];
  const diff = Math.abs(a - b);
  const pctDiff = a !== 0 ? (diff / Math.abs(a)) * 100 : (b !== 0 ? 100 : 0);
  const match = diff < 1e-6 || pctDiff < 0.001;

  console.log(`${m}:`);
  console.log(`  A: ${a.toFixed(6)}`);
  console.log(`  B: ${b.toFixed(6)}`);
  console.log(`  diff: ${diff.toFixed(6)} (${pctDiff.toFixed(4)}%) ${match ? '✓' : '✗ MISMATCH'}`);

  if (!match) allMatch = false;
}

// Compare final raw metrics
console.log(`\nFinal metrics:`);
console.log(`  A: injected=${runA.final.injectedKg.toFixed(0)} exited=${runA.final.exitedKg.toFixed(0)} particles=${runA.final.activeParticles}`);
console.log(`  B: injected=${runB.final.injectedKg.toFixed(0)} exited=${runB.final.exitedKg.toFixed(0)} particles=${runB.final.activeParticles}`);

const injectedMatch = runA.final.injectedKg === runB.final.injectedKg;
const exitedMatch = runA.final.exitedKg === runB.final.exitedKg;
const particlesMatch = runA.final.activeParticles === runB.final.activeParticles;

if (!injectedMatch || !exitedMatch || !particlesMatch) {
  allMatch = false;
  console.log(`  ✗ RAW METRICS MISMATCH`);
} else {
  console.log(`  ✓ Raw metrics match`);
}

// Compare instrumentation counters if available
const rawA = runA.samples.at(-1);
const rawB = runB.samples.at(-1);

console.log(`\n${'═'.repeat(60)}`);
if (allMatch) {
  console.log(`✓ DETERMINISM TEST PASSED @ dt=${dt}: Both runs produced identical results`);
} else {
  console.log(`✗ DETERMINISM TEST FAILED @ dt=${dt}: Runs diverged`);
  process.exit(1);
}
console.log(`${'═'.repeat(60)}`);

process.exit(0);
