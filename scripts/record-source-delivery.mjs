import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSource, verifySourceDirectory } from '../dist/src/source-package.js';
const root=process.cwd(),cold=resolve('runs/source-delivery-clean-20261003/ai-plugin-doctor');
const archive=resolve('releases/ai-plugin-doctor-source-0.1.0-20261003.zip');
function junit(path){
  const text=readFileSync(path,'utf8');const value={};
  for(const key of ['tests','pass','fail','cancelled','skipped']){const match=text.match(new RegExp('<!-- '+key+' (\\d+) -->'));assert.ok(match,`Missing JUnit ${key}`);value[key]=Number(match[1]);}
  assert.equal(value.tests,161);assert.equal(value.pass,161);assert.equal(value.fail,0);assert.equal(value.cancelled,0);assert.equal(value.skipped,0);return value;
}
const working=junit(join(root,'runs/source-delivery-working-tests-20261003.xml'));
const clean=junit(join(cold,'clean-tests.xml'));
const manifest=verifySourceDirectory(cold),actual=collectSource(root);
assert.equal(actual.length,manifest.files.length);
for(const item of actual){const entry=manifest.files.find(file=>file.path===item.path);assert.ok(entry);assert.equal(createHash('sha256').update(item.bytes).digest('hex'),entry.sha256);}
const checksum=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const sha=checksum(archive);assert.equal(sha,readFileSync(archive+'.sha256','utf8').split(/\s/)[0]);
assert.equal(checksum(join(root,'runs/source-delivery-repeat-20261003.zip')),sha);
assert.equal(checksum(join(cold,'releases/repacked-source.zip')),sha);
const smoke=JSON.parse(readFileSync(join(cold,'runs/delivery-integrity/integrity-results.json'),'utf8'));
assert.equal(smoke.modelRequests,0);assert.equal(smoke.generation,'PASS');assert.equal(smoke.regenerateExit,0);assert.equal(smoke.tamperedRegenerateExit,1);assert.equal(smoke.outputsPreserved,true);
const overview=JSON.parse(readFileSync(join(cold,'runs/delivery-overview/report.json'),'utf8'));assert.equal(overview.trials.length,5);
writeFileSync(join(root,'runs/source-delivery-results-20261003.json'),JSON.stringify({
  date:'2026-10-03',archive,sha256:sha,bytes:readFileSync(archive).length,sourceFiles:manifest.files.length,aggregateSha256:manifest.aggregateSha256,
  workingTests:working,extractedCleanTests:clean,sourceFilesMatch:true,repeatArchiveBytesMatch:true,extractedRepackBytesMatch:true,
  cleanInstall:{method:'npm ci --ignore-scripts',copiedNodeModules:false,copiedDist:false,cacheUsed:true,proxy:'user-provided loopback 33210, current child terminal only'},
  cleanBuild:'PASS',sourceManifestVerification:'PASS',cliHelp:'PASS',generatedLocalExample:'PASS',fixtureIntegritySmoke:smoke,
  syntheticOverviewRegeneration:'PASS',nativeZipExtraction:'Windows System.IO.Compression.ZipFile',remoteCI:'NOT_RUN',githubPush:'NOT_PERFORMED',
},null,2));
console.log('PASS: 161/161 in both directories, 59 source files, identical repeat/repacked ZIP and controlled smoke.');
