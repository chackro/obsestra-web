import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScenariosParallel, computeDeltas } from './parallelRunner.js';
import { validateScenarioName, getAvailableToggles } from './scenarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Catch unhandled errors/rejections to ensure they're always visible
process.on('uncaughtException', (err) => {
  console.error('\n[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('\n[FATAL] Unhandled promise rejection:', reason);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════
// RUN CONFIG — 7 DAY WINDOW
// ═══════════════════════════════════════════════════════════════

const DAYS = 7;
const HOUR = 3600;

const RUN_OPTS = {
  bundlePath: path.resolve(__dirname, '../test/bundle_baseline.json'),
  duration: DAYS * 24 * HOUR,     // 7 days
  warmupSeconds: 24 * HOUR,       // 24 hour warmup
  dt: 10,                         // 10 sec/step (validated dt-invariant)
  sampleInterval: 300,            // sample every 5 minutes
  resultsDir: './results',        // heatmap PNG export directory
};

// ═══════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
let maxWorkers = Infinity;
let durationDays = DAYS;
let dt = 10;
let animate = false;
let noWarmup = false;
const scenarioNames = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-workers' || args[i] === '-w') {
    maxWorkers = parseInt(args[++i], 10);
  } else if (args[i] === '--days' || args[i] === '-D') {
    durationDays = parseFloat(args[++i]);
  } else if (args[i] === '--dt' || args[i] === '-d') {
    dt = parseInt(args[++i], 10);
  } else if (args[i] === '--quick' || args[i] === '-q') {
    // Quick test mode: 6 hours total, 1 hour warmup, dt=30
    durationDays = 0.25;
    dt = 30;
  } else if (args[i] === '--animate' || args[i] === '-a') {
    animate = true;
  } else if (args[i] === '--no-warmup') {
    noWarmup = true;
  } else {
    scenarioNames.push(args[i]);
  }
}

if (scenarioNames.length < 2) {
  console.error('Usage: node runComparison.js [options] <scenario1> <scenario2> [scenario3] ...');
  console.error('');
  console.error('Options:');
  console.error('  --max-workers, -w N   Max concurrent workers (default: unlimited)');
  console.error('  --days, -D N          Duration in days (default: 7, supports decimals)');
  console.error('  --dt, -d N            Time step in seconds (default: 10)');
  console.error('  --quick, -q           Quick test mode: 6 hours, dt=30');
  console.error('  --animate, -a         Generate animated GIFs showing congestion evolution');
  console.error('');
  console.error('Scenarios use PascalCase naming. Available toggles:');
  console.error(`  ${getAvailableToggles().join(', ')}`);
  console.error('');
  console.error('Examples:');
  console.error('  node runComparison.js Baseline Inovus');
  console.error('  node runComparison.js --quick Baseline Twinspan        # fast test run');
  console.error('  node runComparison.js --days 1 --dt 20 Baseline Inovus # 1 day, dt=20s');
  console.error('  node runComparison.js -w 2 Baseline Inovus Interserrana');
  process.exit(1);
}

// Validate all scenario names
for (const name of scenarioNames) {
  const validation = validateScenarioName(name);
  if (!validation.valid) {
    console.error(validation.error);
    process.exit(1);
  }
}

// Create timestamped results folder (yymmdd_hhmm format)
const now = new Date();
const yy = String(now.getFullYear()).slice(-2);
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const hh = String(now.getHours()).padStart(2, '0');
const min = String(now.getMinutes()).padStart(2, '0');
const resultsFolder = `./results/${yy}${mm}${dd}_${hh}${min}`;
fs.mkdirSync(resultsFolder, { recursive: true });

// Override RUN_OPTS with CLI values
const warmupHours = noWarmup ? 0 : 24;  // 24h warmup unless --no-warmup
const runOpts = {
  ...RUN_OPTS,
  duration: durationDays * 24 * HOUR,
  warmupSeconds: warmupHours * HOUR,
  dt,
  resultsDir: resultsFolder,
  captureHeatmapFrames: animate,
};

console.log(`\n${'═'.repeat(60)}`);
console.log(`N-WAY COMPARISON: ${scenarioNames.join(', ')}`);
console.log(`${'═'.repeat(60)}`);
console.log(`Scenarios: ${scenarioNames.length}`);
console.log(`Max workers: ${maxWorkers === Infinity ? 'unlimited' : maxWorkers}`);
console.log(`Duration: ${durationDays} days (${(durationDays * 24).toFixed(1)}h), Warmup: ${warmupHours.toFixed(1)}h`);
console.log(`dt: ${dt}s, sampleInterval: ${runOpts.sampleInterval}s${animate ? ', animate: on' : ''}`);
console.log(`${'═'.repeat(60)}`);

// ═══════════════════════════════════════════════════════════════
// RUN COMPARISON (PARALLEL)
// ═══════════════════════════════════════════════════════════════

let results;
try {
  results = await runScenariosParallel(scenarioNames, { ...runOpts, maxWorkers });
} catch (error) {
  console.error('\n════════════════════════════════════════════════════════════');
  console.error('RUN FAILED');
  console.error('════════════════════════════════════════════════════════════');
  console.error(error.message);
  console.error('\nStack trace:', error.stack);
  process.exit(1);
}

// Compute deltas vs first scenario (baseline)
const deltas = computeDeltas(results, 0);

// ═══════════════════════════════════════════════════════════════
// OUTPUT: Per-Scenario Results
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log('SCENARIO RESULTS');
console.log(`${'═'.repeat(60)}`);

for (const r of results) {
  console.log(`\n${r.scenarioName}:`);
  console.log(`  knobs: ${JSON.stringify(r.knobs)}`);
  console.log(`  truckHoursLost_final: ${r.summary.truckHoursLost_final.toFixed(2)}`);
  console.log(`    └─ congestion: ${r.summary.truckHoursLostCongestion_final.toFixed(2)}`);
  console.log(`    └─ lotWait: ${r.summary.truckHoursLostLotWait_final.toFixed(2)}`);
  console.log(`    └─ bridgeQueue: ${r.summary.truckHoursLostBridgeQueue_final.toFixed(2)}`);
  console.log(`  exitedKgPerHour_mean: ${r.summary.exitedKgPerHour_mean.toFixed(0)}`);
  console.log(`  truckHoursLostPerHour_mean: ${r.summary.truckHoursLostPerHour_mean.toFixed(4)}`);
  console.log(`  avgDelayPerTruck: ${r.summary.avgDelayPerTruck.toFixed(3)} hr`);
  console.log(`    └─ congestion: ${r.summary.avgCongestionPerTruck.toFixed(3)} hr`);
  console.log(`    └─ lotWait: ${r.summary.avgLotWaitPerTruck.toFixed(3)} hr`);
  console.log(`    └─ bridgeQueue: ${r.summary.avgBridgeQueuePerTruck.toFixed(3)} hr`);
  console.log(`  clearance: ${(r.summary.exitedKg_final / r.summary.injectedKg_final * 100).toFixed(1)}%`);
  console.log(`  bridgeUtilization: ${(r.summary.cbpLanesInUse_mean / 7 * 100).toFixed(1)}%`);
  console.log(`  stallTonHoursSlope: ${r.summary.stallTonHoursSlope.toFixed(2)}`);
  console.log(`  sinkQueueCount_mean: ${r.summary.sinkQueueCount_mean.toFixed(1)}`);
  console.log(`  cbpLanesInUse_mean: ${r.summary.cbpLanesInUse_mean.toFixed(2)}`);
  console.log(`  lotExclusions: ${r.summary.lotExclusions_final}`);
  console.log(`  cbpCompletions: ${r.summary.cbpCompletions_final}`);
  console.log(`  injectedKg_final: ${(r.summary.injectedKg_final/1e6).toFixed(1)}M`);
  console.log(`  exitedKg_final: ${(r.summary.exitedKg_final/1e6).toFixed(1)}M`);
  console.log(`  activeParticles_final: ${r.summary.activeParticles_final}`);
  console.log(`  massBalanceError: ${r.summary.massBalanceError.toFixed(0)} kg`);
  console.log(`  spawns: ${r.final.spawns} departed: ${r.final.departedCount} departing: ${r.final.departingCount}`);
  console.log(`    check: spawns=${r.final.spawns} should equal departed+active=${r.final.departedCount + r.summary.activeParticles_final}`);
  console.log(`  violations: ${r.violations.length}`);
}

// ═══════════════════════════════════════════════════════════════
// OUTPUT: Deltas vs Baseline
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`DELTAS (vs ${results[0].scenarioName})`);
console.log(`${'═'.repeat(60)}`);

for (const d of deltas) {
  const sign = (val) => val >= 0 ? '+' : '';
  const pct = d.truckHoursLostPctChange;
  const headline = pct < 0
    ? `Congestion reduced by ${Math.abs(pct).toFixed(1)}%`
    : pct > 0
    ? `Congestion increased by ${pct.toFixed(1)}%`
    : 'No change';

  console.log(`\n${d.treatment}:`);
  console.log(`  truckHoursLost: ${sign(d.truckHoursLost)}${d.truckHoursLost.toFixed(2)} (${sign(pct)}${pct.toFixed(1)}%)`);
  console.log(`    └─ congestion: ${sign(d.truckHoursLostCongestion)}${d.truckHoursLostCongestion.toFixed(2)}`);
  console.log(`    └─ lotWait: ${sign(d.truckHoursLostLotWait)}${d.truckHoursLostLotWait.toFixed(2)}`);
  console.log(`    └─ bridgeQueue: ${sign(d.truckHoursLostBridgeQueue)}${d.truckHoursLostBridgeQueue.toFixed(2)}`);
  console.log(`  avgDelayPerTruck: ${sign(d.avgDelayPerTruck)}${d.avgDelayPerTruck.toFixed(3)} hr`);
  console.log(`    └─ congestion: ${sign(d.avgCongestionPerTruck)}${d.avgCongestionPerTruck.toFixed(3)} hr`);
  console.log(`    └─ lotWait: ${sign(d.avgLotWaitPerTruck)}${d.avgLotWaitPerTruck.toFixed(3)} hr`);
  console.log(`    └─ bridgeQueue: ${sign(d.avgBridgeQueuePerTruck)}${d.avgBridgeQueuePerTruck.toFixed(3)} hr`);
  console.log(`  exitedKgPerHour_mean: ${sign(d.exitedKgPerHour_mean)}${d.exitedKgPerHour_mean.toFixed(0)}`);
  console.log(`  throughputKg: ${sign(d.throughputKg)}${d.throughputKg.toFixed(0)}`);
  console.log(`  sinkQueueCount_mean: ${sign(d.sinkQueueCount_mean)}${d.sinkQueueCount_mean.toFixed(1)}`);
  console.log(`  cbpLanesInUse_mean: ${sign(d.cbpLanesInUse_mean)}${d.cbpLanesInUse_mean.toFixed(2)}`);
  console.log(`  lotExclusions: ${sign(d.lotExclusions)}${d.lotExclusions}`);
  console.log(`  cbpCompletions: ${sign(d.cbpCompletions)}${d.cbpCompletions}`);
  console.log(`  injectedKg: ${sign(d.injectedKg)}${(d.injectedKg/1e6).toFixed(1)}M (${sign(d.injectedKgPctChange)}${d.injectedKgPctChange.toFixed(1)}%)`);
  console.log(`  activeParticles: ${sign(d.activeParticles)}${d.activeParticles}`);
  console.log(`  HEADLINE: ${headline}`);
}

// ═══════════════════════════════════════════════════════════════
// SAVE RESULTS
// ═══════════════════════════════════════════════════════════════

// Strip heatmapData before JSON export (already rendered to PNGs, too large to serialize)
const scenariosForExport = results.map(r => {
  const { heatmapData, ...rest } = r;
  return rest;
});

const output = {
  meta: {
    timestamp: new Date().toISOString(),
    scenarioNames,
    runOpts,
  },
  scenarios: scenariosForExport,
  deltas,
};

const durationLabel = durationDays >= 1 ? `${durationDays}d` : `${(durationDays * 24).toFixed(0)}h`;
const outPath = `${resultsFolder}/comparison_${scenarioNames.join('_')}_${durationLabel}.json`;
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`\n${'═'.repeat(60)}`);
console.log(`Written: ${outPath}`);
console.log(`${'═'.repeat(60)}`);

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

const allPassed = results.every(r => r.passed);
if (!allPassed) {
  console.warn('\n⚠️  INVARIANT VIOLATIONS DETECTED');
  for (const r of results) {
    if (r.violations.length > 0) {
      console.warn(`  ${r.scenarioName}: ${r.violations.length} violations`);
      console.warn(`    First: ${JSON.stringify(r.violations[0])}`);
    }
  }
  process.exit(1);
}

// Check for zero deltas (scenario toggle may not be wired)
const allZero = deltas.every(d => d.truckHoursLost === 0 && d.throughputKg === 0);
if (allZero && deltas.length > 0) {
  console.warn('\n⚠️  ALL DELTAS ARE ZERO — scenario toggles may not be wired');
  process.exit(1);
}

console.log('\n✓ All invariants passed');
process.exit(0);
