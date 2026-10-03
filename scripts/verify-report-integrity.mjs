import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSuite } from '../dist/src/runner.js';
import { writeReport, verifyEvidence } from '../dist/src/report.js';
import { createExample, loadConfig } from '../dist/src/config.js';

// Only our local fixture probe runs. Empty client selection prevents model requests.
const out = resolve(process.argv[2] ?? 'runs/polish-evidence-smoke-20261002');
const configPath = out + '.doctor.yaml';
mkdirSync(dirname(configPath),{recursive:true});
createExample(configPath);
const config = loadConfig(configPath);
config.server = { command: process.execPath, args: [resolve('dist/fixtures/release-server.js')], cwd: process.cwd() };
const report = await runSuite(config, configPath, out, []);
assert.equal(report.trials.length, 0);
assert.deepEqual(Object.keys(report.runEvidenceHashes).sort(), ['config.snapshot.json', 'probe.json', 'static.json']);
verifyEvidence(out, report);
writeReport(out, report);
const cli = resolve('dist/src/cli.js');
const success = spawnSync(process.execPath, [cli, 'report', out], { encoding: 'utf8', windowsHide: true });
assert.equal(success.status, 0, success.stderr);
assert.match(readFileSync(join(out, 'report.html'), 'utf8'), new RegExp(report.runEvidenceHashes['probe.json']));
const html = readFileSync(join(out, 'report.html'), 'utf8');
const json = readFileSync(join(out, 'report.json'), 'utf8');
const probePath = join(out, 'probe.json');
const original = readFileSync(probePath);
let rejected;
try {
  writeFileSync(probePath, 'synthetic tampering');
  rejected = spawnSync(process.execPath, [cli, 'report', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Evidence integrity check failed: run\/probe.json/);
  assert.equal(readFileSync(join(out, 'report.html'), 'utf8'), html);
  assert.equal(readFileSync(join(out, 'report.json'), 'utf8'), json);
} finally { writeFileSync(probePath, original); }
verifyEvidence(out, report);
writeFileSync(join(out, 'integrity-results.json'), JSON.stringify({
  modelRequests: 0, trials: 0, fixtureProbe: true, generation: 'PASS',
  regenerateExit: success.status, tamperedRegenerateExit: rejected.status,
  outputsPreserved: true, originalProbeRestored: true,
}, null, 2));
console.log('PASS: fixture generation, regeneration and tamper rejection; no model requests.');
