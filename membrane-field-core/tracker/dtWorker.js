// ═══════════════════════════════════════════════════════════════════════════════
// DT WORKER — Runs a single dt value in isolation
// ═══════════════════════════════════════════════════════════════════════════════

import { parentPort, workerData } from 'worker_threads';
import { HeadlessSim } from './headlessSim.js';

// Redirect console to parentPort
console.log = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'log', msg: args.join(' ') });
};
console.warn = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'warn', msg: args.join(' ') });
};
console.error = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'error', msg: args.join(' ') });
};

const HOUR = 3600;
const {
  dt,
  bundlePath,
  duration,
  warmupSeconds,
  sampleInterval,
} = workerData;

async function run() {
  // Create sim with baseline scenario
  const sim = new HeadlessSim({
    bundlePath,
    applyScenario: async () => {},  // baseline - no toggles
    scenarioName: `dt=${dt}`,
  });
  await sim.init(0);

  // Run simulation using unified loop
  const result = await sim.run({
    duration,
    dt,
    sampleInterval,
    warmupSeconds,
  });

  // Compute dt-specific metrics
  const postWarmupDays = (duration - warmupSeconds) / (24 * HOUR);
  const truckHoursLostPerDay = result.final.truckHoursLost / postWarmupDays;
  const throughputKgPerHour = result.final.exitedKg / ((duration - warmupSeconds) / HOUR);

  parentPort.postMessage({
    type: 'result',
    dt,
    elapsed: result.elapsedSeconds.toFixed(1),
    steps: Math.ceil(duration / dt),
    truckHoursLostPerDay,
    throughputKgPerHour,
    truckHoursLostRate_mean: result.summary.truckHoursLostPerHour_mean,
    peakLossRate: Math.max(...result.samples.map(s => s.truckHoursLostPerHour || 0)),
    violations: result.violations.length,
    final: result.final,
  });
}

run().catch(err => {
  console.error(`FAILED: ${err.message}`);
  parentPort.postMessage({ type: 'error', error: err.message });
});
