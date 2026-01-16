import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  onAttach,
  reset,
  step,
  setSimTime,
  getMetricsPhase1,
  setVerbose,
  setQuietMode,
} from '../overlay/reynosaOverlay_v2.js';

import {
  loadBundle,
  createScenarioAdapter,
  createFieldGeometryProvider,
  getPharrWorldCoords,
} from '../overlay/bundleConsumer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('[TEST] Starting service time audit test...');

  setVerbose(false);
  setQuietMode(true);

  // Load bundle
  const bundlePath = path.resolve(__dirname, '../test/bundle_baseline.json');
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
  const scenario = createScenarioAdapter(bundle);
  const fieldGeometry = createFieldGeometryProvider(bundle);
  const pharrWorld = getPharrWorldCoords(bundle);

  // Attach and reset
  onAttach({
    scenario,
    geometry: { fieldGeometry, poePoints: { PHARR: pharrWorld } },
  });
  reset();

  // Run for 2 days to get CBP completions
  const dt = 10;
  const duration = 2 * 24 * 3600;  // 2 days
  let simTime = 0;

  console.log('[TEST] Running simulation for 2 days...');
  while (simTime < duration) {
    setSimTime(simTime);
    await step(dt);
    simTime += dt;

    // Progress indicator every 6 hours
    if (simTime % (6 * 3600) === 0) {
      const days = (simTime / 86400).toFixed(2);
      const metrics = getMetricsPhase1();
      console.log(`[TEST] Day ${days}: cbpCompletions=${metrics.cbpCompletions}, serviceTimeStats.count=${metrics.serviceTimeStats?.count || 0}`);
    }
  }

  // Get final metrics
  const final = getMetricsPhase1();

  console.log('\n[TEST] === FINAL METRICS ===');
  console.log('cbpCompletions:', final.cbpCompletions);
  console.log('truckHoursLostBridgeService:', final.truckHoursLostBridgeService);
  console.log('currentServiceTimeS:', final.currentServiceTimeS);
  console.log('effectiveLanes:', final.effectiveLanes);
  console.log('\n[TEST] === SERVICE TIME STATS ===');
  console.log(JSON.stringify(final.serviceTimeStats, null, 2));

  // Sanity checks
  if (final.serviceTimeStats && final.serviceTimeStats.count > 0) {
    const stats = final.serviceTimeStats;
    console.log('\n[TEST] === SANITY CHECKS ===');
    console.log(`Actual service time (mean): ${stats.actual.mean.toFixed(1)}s`);
    console.log(`Expected service time (mean): ${stats.expected.mean.toFixed(1)}s`);
    console.log(`Ratio actual/expected: ${(stats.actual.mean / stats.expected.mean).toFixed(2)}x`);

    // Conservation check
    const avgServiceHours = final.truckHoursLostBridgeService / final.cbpCompletions;
    const avgServiceSeconds = avgServiceHours * 3600;
    console.log(`\n[TEST] === CONSERVATION CHECK ===`);
    console.log(`avgBridgeServicePerTruck (from accumulator): ${avgServiceSeconds.toFixed(1)}s`);
    console.log(`actualServiceTime (from per-completion): ${stats.actual.mean.toFixed(1)}s`);
    console.log(`Difference: ${Math.abs(avgServiceSeconds - stats.actual.mean).toFixed(1)}s`);
  }

  console.log('\n[TEST] Done.');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
