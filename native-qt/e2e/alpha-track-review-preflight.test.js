'use strict';
// CLI gates only; packaged browser/OBS workflows provide application validation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const script=path.join(__dirname,'alpha-track-review.js');
const base=[`--publisher=${__filename}`,`--sender=${__filename}`,'--reports=unused-preflight-output',
  `--obs-plugin-repo=${__dirname}`,'--expected-plugin-sha256='+'1'.repeat(64)];
function rejects(args,reason) {
  const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,reason);
  assert.doesNotMatch(result.stdout,/Artifacts:/);
}
test('requires an explicit publisher path',()=>rejects(base.slice(1),/Explicit --publisher=PATH is required/));
test('requires a publisher hash',()=>rejects(base,/expected-publisher-sha256 must be/));
test('rejects malformed publisher hashes',()=>rejects([...base,'--expected-publisher-sha256=bad'],/64 hexadecimal/));
test('rejects a different executable identity',()=>rejects([...base,'--expected-publisher-sha256='+'0'.repeat(64)],/Publisher SHA-256 mismatch.*expected .*actual/));
test('requires the plugin hash before launch',()=>rejects([...base.filter(a=>!a.startsWith('--expected-plugin-sha256=')),
  '--expected-publisher-sha256='+'0'.repeat(64)],/expected-plugin-sha256 must be/));
test('rejects duplicate publisher selection',()=>rejects([...base,'--publisher=other.exe'],/Duplicate option: --publisher/));
test('rejects duplicate expected identity',()=>rejects([...base,'--expected-publisher-sha256='+'0'.repeat(64),
  '--expected-publisher-sha256='+'1'.repeat(64)],/Duplicate option: --expected-publisher-sha256/));
test('rejects an option without equals',()=>rejects(['--publisher'],/Unknown or malformed option/));
test('rejects a misspelled option',()=>rejects(['--publiser=other.exe'],/Unknown or malformed option/));
