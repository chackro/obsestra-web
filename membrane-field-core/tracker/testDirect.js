// Direct test - bypasses worker threads
import path from 'path';
import { fileURLToPath } from 'url';
import { HeadlessSim } from './headlessSim.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Starting direct test...');

const sim = new HeadlessSim({
  bundlePath: path.resolve(__dirname, '../test/bundle_baseline.json'),
  scenarioName: 'DirectTest'
});

console.log('Calling init...');
await sim.init(0);
console.log('Init complete!');
