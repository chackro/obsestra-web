import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
let dtValues = [];
let maxWorkers = Infinity;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dt' || args[i] === '-d') {
    // Collect all following numbers until next flag
    // Supports both space-separated (--dt 1 10 20) and comma-separated (--dt 1,10,20)
    while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
      const val = args[++i];
      if (val.includes(',')) {
        // Comma-separated: split and parse each
        val.split(',').forEach(v => {
          const n = parseInt(v.trim(), 10);
          if (!isNaN(n)) dtValues.push(n);
        });
      } else {
        dtValues.push(parseInt(val, 10));
      }
    }
  } else if (args[i] === '--max-workers' || args[i] === '-w') {
    maxWorkers = parseInt(args[++i], 10);
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node dtSensitivity.js [--dt N...] [--max-workers N]');
    console.log('');
    console.log('Options:');
    console.log('  --dt, -d N...       Time step values to test (default: 10 20 30)');
    console.log('  --max-workers, -w N Max concurrent workers (default: unlimited)');
    console.log('');
    console.log('Examples:');
    console.log('  node dtSensitivity.js --dt 1,10,20,30');
    console.log('  node dtSensitivity.js --dt 1 10 20 30');
    console.log('  node dtSensitivity.js -d 5,10,15,20 -w 2');
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    // Positional args treated as dt values
    dtValues.push(parseInt(args[i], 10));
  }
}

// Default dt values if none specified
if (dtValues.length === 0) {
  dtValues = [10, 20, 30];
}

// Sort for consistent output
dtValues.sort((a, b) => a - b);

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const DAYS = 2;  // 1 day warmup + 1 day measurement
const HOUR = 3600;
const DURATION = DAYS * 24 * HOUR;
const WARMUP = 24 * HOUR;
const SAMPLE_INTERVAL = 300;

const bundlePath = path.resolve(__dirname, '../test/bundle_baseline.json');
const workerPath = path.join(__dirname, 'dtWorker.js');

// Acceptance gates
const STRICT_THRESHOLD = 0.02;    // 2%
const PRACTICAL_THRESHOLD = 0.05; // 5%

// ═══════════════════════════════════════════════════════════════
// WORKER SPAWNER
// ═══════════════════════════════════════════════════════════════

function runDtWorker(dt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        dt,
        bundlePath,
        duration: DURATION,
        warmupSeconds: WARMUP,
        sampleInterval: SAMPLE_INTERVAL,
      },
    });

    worker.on('message', msg => {
      if (msg.type === 'log') {
        const prefix = `[dt=${dt}] `;
        if (msg.level === 'error') {
          console.error(prefix + msg.msg);
        } else if (msg.level === 'warn') {
          console.warn(prefix + msg.msg);
        } else {
          console.log(prefix + msg.msg);
        }
      } else if (msg.type === 'result') {
        resolve(msg);
      } else if (msg.type === 'error') {
        reject(new Error(msg.error));
      }
    });

    worker.on('error', err => {
      reject(new Error(`Worker dt=${dt} error: ${err.message}`));
    });

    worker.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`Worker dt=${dt} exited with code ${code}`));
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// PARALLEL RUNNER
// ═══════════════════════════════════════════════════════════════

async function runAllParallel(dtList, maxConcurrent) {
  const results = new Array(dtList.length);
  let nextIdx = 0;
  let activeCount = 0;
  let completedCount = 0;

  return new Promise((resolve, reject) => {
    function spawnNext() {
      while (activeCount < maxConcurrent && nextIdx < dtList.length) {
        const idx = nextIdx++;
        const dt = dtList[idx];
        activeCount++;

        console.log(`[SPAWN] dt=${dt} (active: ${activeCount})`);

        runDtWorker(dt)
          .then(result => {
            results[idx] = result;
            activeCount--;
            completedCount++;
            console.log(`[DONE] dt=${dt} in ${result.elapsed}s (${completedCount}/${dtList.length} complete)`);
            spawnNext();
          })
          .catch(err => {
            reject(err);
          });
      }

      if (completedCount === dtList.length) {
        resolve(results);
      }
    }

    spawnNext();
  });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log('DT SENSITIVITY TEST (PARALLEL)');
console.log(`${'═'.repeat(60)}`);
console.log(`Duration: ${DAYS} days (${WARMUP / HOUR}h warmup + ${(DURATION - WARMUP) / HOUR}h measurement)`);
console.log(`dt values: ${dtValues.join(', ')}`);
console.log(`Max workers: ${maxWorkers === Infinity ? 'unlimited' : maxWorkers}`);
console.log(`${'═'.repeat(60)}\n`);

const startTime = Date.now();
let results;

try {
  results = await runAllParallel(dtValues, maxWorkers);
} catch (error) {
  console.error('\n════════════════════════════════════════════════════════════');
  console.error('RUN FAILED');
  console.error('════════════════════════════════════════════════════════════');
  console.error(error.message);
  process.exit(1);
}

const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// ═══════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════

// Use smallest dt as baseline (most accurate)
const baseline = results.reduce((a, b) => a.dt < b.dt ? a : b);

console.log(`\n${'═'.repeat(60)}`);
console.log('RESULTS');
console.log(`${'═'.repeat(60)}`);
console.log(`Total time: ${totalElapsed}s (parallel)\n`);

console.log(`${'─'.repeat(100)}`);
console.log(`${'dt'.padStart(4)} | ${'steps'.padStart(8)} | ${'time'.padStart(6)} | ${'truckHrs/day'.padStart(12)} | ${'drift'.padStart(8)} | ${'throughput'.padStart(10)} | ${'drift'.padStart(8)} | ${'pass?'.padStart(8)}`);
console.log(`${'─'.repeat(100)}`);

for (const r of results) {
  const driftTHL = (r.truckHoursLostPerDay - baseline.truckHoursLostPerDay) / baseline.truckHoursLostPerDay;
  const driftTP = (r.throughputKgPerHour - baseline.throughputKgPerHour) / baseline.throughputKgPerHour;

  const isBaseline = r.dt === baseline.dt;
  const strictPass = Math.abs(driftTHL) <= STRICT_THRESHOLD;
  const practicalPass = Math.abs(driftTHL) <= PRACTICAL_THRESHOLD && Math.abs(driftTP) <= PRACTICAL_THRESHOLD;
  const passLabel = isBaseline ? 'baseline' : strictPass ? 'STRICT' : practicalPass ? 'practical' : 'FAIL';

  console.log(
    `${r.dt.toString().padStart(4)} | ` +
    `${r.steps.toLocaleString().padStart(8)} | ` +
    `${(r.elapsed + 's').padStart(6)} | ` +
    `${r.truckHoursLostPerDay.toFixed(2).padStart(12)} | ` +
    `${(isBaseline ? '—' : (driftTHL * 100).toFixed(2) + '%').padStart(8)} | ` +
    `${r.throughputKgPerHour.toFixed(0).padStart(10)} | ` +
    `${(isBaseline ? '—' : (driftTP * 100).toFixed(2) + '%').padStart(8)} | ` +
    `${passLabel.padStart(8)}`
  );
}

console.log(`${'─'.repeat(100)}`);

// ═══════════════════════════════════════════════════════════════
// RECOMMENDATION
// ═══════════════════════════════════════════════════════════════

const strictPassing = results.filter(r => {
  if (r.dt === baseline.dt) return false;
  const driftTHL = (r.truckHoursLostPerDay - baseline.truckHoursLostPerDay) / baseline.truckHoursLostPerDay;
  return Math.abs(driftTHL) <= STRICT_THRESHOLD;
});

const practicalPassing = results.filter(r => {
  if (r.dt === baseline.dt) return false;
  const driftTHL = (r.truckHoursLostPerDay - baseline.truckHoursLostPerDay) / baseline.truckHoursLostPerDay;
  const driftTP = (r.throughputKgPerHour - baseline.throughputKgPerHour) / baseline.throughputKgPerHour;
  return Math.abs(driftTHL) <= PRACTICAL_THRESHOLD && Math.abs(driftTP) <= PRACTICAL_THRESHOLD;
});

console.log(`\nBASELINE: dt=${baseline.dt} (smallest dt tested)`);
console.log(`\nACCEPTANCE GATES:`);
console.log(`  Strict (≤2% truckHoursLostPerDay): ${strictPassing.length > 0 ? strictPassing.map(r => `dt=${r.dt}`).join(', ') : 'NONE'}`);
console.log(`  Practical (≤5% both metrics): ${practicalPassing.length > 0 ? practicalPassing.map(r => `dt=${r.dt}`).join(', ') : 'NONE'}`);

const recommended = strictPassing.length > 0
  ? strictPassing.reduce((a, b) => a.dt > b.dt ? a : b)
  : practicalPassing.length > 0
    ? practicalPassing.reduce((a, b) => a.dt > b.dt ? a : b)
    : null;

if (recommended) {
  const speedup = (parseFloat(baseline.elapsed) / parseFloat(recommended.elapsed)).toFixed(1);
  console.log(`\nRECOMMENDED: dt=${recommended.dt}s (${speedup}× faster than dt=${baseline.dt})`);
} else {
  console.log(`\nRECOMMENDED: dt=${baseline.dt}s (no larger dt passes acceptance gate)`);
}

// ═══════════════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════════════

const output = {
  timestamp: new Date().toISOString(),
  config: { days: DAYS, warmupHours: WARMUP / HOUR, sampleInterval: SAMPLE_INTERVAL },
  thresholds: { strict: STRICT_THRESHOLD, practical: PRACTICAL_THRESHOLD },
  baseline: baseline.dt,
  results,
  recommendation: recommended ? `dt=${recommended.dt}` : `dt=${baseline.dt}`,
  totalElapsedSeconds: parseFloat(totalElapsed),
};

fs.mkdirSync('./results', { recursive: true });
const outPath = `./results/dt_sensitivity_${dtValues.join('_')}.json`;
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWritten: ${outPath}`);

process.exit(0);
