import { HeadlessSim } from './headlessSim.js';

/**
 * Run a single scenario using HeadlessSim's unified run() method.
 * This is a thin wrapper that sets up the sim and delegates to run().
 */
export async function runScenario({
  duration,
  dt,
  sampleInterval,
  warmupSeconds,
  bundlePath,
  applyScenario,
  scenarioName,
  getKnobs = () => ({}),
}) {
  const sim = new HeadlessSim({ bundlePath, applyScenario, scenarioName });
  await sim.init(0);  // Start at midnight

  // Capture knobs AFTER scenario is applied
  const knobs = getKnobs();

  // Delegate to HeadlessSim's unified run() method
  return sim.run({
    duration,
    dt,
    sampleInterval,
    warmupSeconds,
    knobs,
  });
}

export async function compare(base, treat) {
  const baseline = await runScenario(base);
  const treatment = await runScenario(treat);

  const deltaRate = treatment.summary.truckHoursLostPerHour_mean - baseline.summary.truckHoursLostPerHour_mean;
  const pctChange = baseline.summary.truckHoursLostPerHour_mean !== 0
    ? (deltaRate / baseline.summary.truckHoursLostPerHour_mean) * 100
    : 0;

  const headline = deltaRate < 0
    ? `Congestion reduced by ${Math.abs(pctChange).toFixed(1)}% (delta rate)`
    : deltaRate > 0
    ? `Congestion increased by ${pctChange.toFixed(1)}% (delta rate)`
    : 'No change in congestion rate';

  return {
    baseline,
    treatment,
    delta: {
      truckHoursLost: treatment.final.truckHoursLost - baseline.final.truckHoursLost,
      truckHoursLostPerHour_mean: deltaRate,
      exitedKgPerHour_mean: treatment.summary.exitedKgPerHour_mean - baseline.summary.exitedKgPerHour_mean,
      throughputKg: treatment.final.exitedKg - baseline.final.exitedKg,
    },
    headline,
  };
}
