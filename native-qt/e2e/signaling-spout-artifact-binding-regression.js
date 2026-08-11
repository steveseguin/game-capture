#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, 'signaling-regressions-e2e.js');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function occurrences(source, token) {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = source.indexOf(token, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + token.length;
  }
}

function evaluate(source) {
  return [
    {
      id: 'SIGNALING_SPOUT_ARGUMENT_CONTRACT',
      ok: /spoutSenderPath:\s*''/.test(source) &&
        /expectedSpoutSenderSha256:\s*''/.test(source) &&
        /const fixtureIdentityArgumentCounts = \{\s*spoutSenderPath: 0,\s*expectedSpoutSenderSha256: 0\s*\};/.test(
          source
        ) && occurrences(source, "arg === '--spout-sender-path'") === 1 &&
        occurrences(source, "arg.startsWith('--spout-sender-path=')") === 1 &&
        occurrences(source, "arg === '--expected-spout-sender-sha256'") === 1 &&
        occurrences(source, "arg.startsWith('--expected-spout-sender-sha256=')") === 1 &&
        /for \(const \[name, count\] of Object\.entries\(fixtureIdentityArgumentCounts\)\) \{\s*if \(count !== 1 \|\| !config\[name\]\)/.test(
          source
        ) && /if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(config\.expectedSpoutSenderSha256\)\) \{/.test(
          source
        )
    },
    {
      id: 'SIGNALING_SPOUT_ARTIFACT_IDENTITY',
      ok: /function validateSpoutSenderArtifact\(config\) \{[\s\S]{0,300}!fs\.existsSync\(config\.spoutSenderPath\) \|\|\s*!fs\.statSync\(config\.spoutSenderPath\)\.isFile\(\)[\s\S]{0,500}const executable = fs\.realpathSync\.native[\s\S]{0,420}const observedSha256 = sha256File\(executable\);[\s\S]{0,220}if \(observedSha256 !== config\.expectedSpoutSenderSha256\) \{[\s\S]{0,320}return Object\.freeze\(\{\s*executable,\s*sha256: observedSha256\s*\}\);/.test(
        source
      ) && /function assertSpoutSenderArtifactUnchanged\(artifact\) \{[\s\S]{0,260}const observedSha256 = sha256File\(artifact\.executable\);[\s\S]{0,180}if \(observedSha256 !== artifact\.sha256\) \{[\s\S]{0,260}return artifact\.executable;/.test(
        source
      )
    },
    {
      id: 'SIGNALING_SPOUT_FIXTURE_USAGE',
      ok: !/[.][.]\/build-test\/bin\/spout_test_sender\.exe/.test(source) &&
        /function startSignalingMediaFixture\(durationMs, spoutArtifact\) \{\s*const spoutPath = assertSpoutSenderArtifactUnchanged\(spoutArtifact\);/.test(
          source
        ) && /function startLifecycleMediaFixtures\(durationMs, spoutArtifact\) \{\s*const spoutPath = assertSpoutSenderArtifactUnchanged\(spoutArtifact\);/.test(
          source
        ) && /const spoutSenderArtifact = validateSpoutSenderArtifact\(config\);[\s\S]{0,1500}spoutSenderArtifact:\s*\{\s*path: spoutSenderArtifact\.executable,\s*sha256: spoutSenderArtifact\.sha256\s*\}/.test(
          source
        ) && /startSignalingMediaFixture\(\s*15 \* 60 \* 1000,\s*spoutSenderArtifact\s*\)/.test(
          source
        ) && /signalingMediaReady[\s\S]{0,900}assertSpoutSenderArtifactUnchanged\(spoutSenderArtifact\)/.test(
          source
        ) && /runRecoveryScenario\([\s\S]{0,240}spoutSenderArtifact\s*\)/.test(source) &&
        /runActiveMediaLifecycleScenario\([\s\S]{0,240}spoutSenderArtifact\s*\)/.test(source) &&
        /startLifecycleMediaFixtures\([\s\S]{0,120}spoutSenderArtifact\s*\)/.test(source)
    }
  ];
}

function replaceOnce(source, before, after) {
  if (occurrences(source, before) !== 1) {
    throw new Error(`Expected exactly one mutation anchor: ${before}`);
  }
  return source.replace(before, after);
}

function runMutations(source) {
  const baseline = evaluate(source);
  if (!baseline.every((check) => check.ok)) return [];
  const mutations = [
    {
      name: 'duplicate-spout-identity-is-accepted',
      target: 'SIGNALING_SPOUT_ARGUMENT_CONTRACT',
      source: replaceOnce(
        source,
        'for (const [name, count] of Object.entries(fixtureIdentityArgumentCounts)) {\n    if (count !== 1 || !config[name]) {',
        'for (const [name, count] of Object.entries(fixtureIdentityArgumentCounts)) {\n    if (count < 1 || !config[name]) {'
      )
    },
    {
      name: 'spout-hash-argument-is-discarded',
      target: 'SIGNALING_SPOUT_ARGUMENT_CONTRACT',
      source: replaceOnce(
        source,
        "arg.startsWith('--expected-spout-sender-sha256=')",
        "arg.startsWith('--discarded-spout-sender-sha256=')"
      )
    },
    {
      name: 'spout-hash-format-check-is-bypassed',
      target: 'SIGNALING_SPOUT_ARGUMENT_CONTRACT',
      source: replaceOnce(
        source,
        "if (!/^[0-9a-f]{64}$/.test(config.expectedSpoutSenderSha256)) {",
        "if (false && !/^[0-9a-f]{64}$/.test(config.expectedSpoutSenderSha256)) {"
      )
    },
    {
      name: 'spout-path-leaf-check-is-bypassed',
      target: 'SIGNALING_SPOUT_ARTIFACT_IDENTITY',
      source: replaceOnce(
        source,
        '!fs.existsSync(config.spoutSenderPath) ||\n      !fs.statSync(config.spoutSenderPath).isFile()',
        '!fs.existsSync(config.spoutSenderPath)'
      )
    },
    {
      name: 'spout-prelaunch-hash-check-is-bypassed',
      target: 'SIGNALING_SPOUT_ARTIFACT_IDENTITY',
      source: replaceOnce(
        source,
        'if (observedSha256 !== config.expectedSpoutSenderSha256) {',
        'if (false && observedSha256 !== config.expectedSpoutSenderSha256) {'
      )
    },
    {
      name: 'spout-postready-hash-check-is-bypassed',
      target: 'SIGNALING_SPOUT_ARTIFACT_IDENTITY',
      source: replaceOnce(
        source,
        'if (observedSha256 !== artifact.sha256) {',
        'if (false && observedSha256 !== artifact.sha256) {'
      )
    },
    {
      name: 'signaling-spout-reverts-to-build-test',
      target: 'SIGNALING_SPOUT_FIXTURE_USAGE',
      source: replaceOnce(
        source,
        'function startSignalingMediaFixture(durationMs, spoutArtifact) {\n' +
          '  const spoutPath = assertSpoutSenderArtifactUnchanged(spoutArtifact);',
        'function startSignalingMediaFixture(durationMs, spoutArtifact) {\n' +
          "  const spoutPath = path.resolve(__dirname, '../build-test/bin/spout_test_sender.exe');"
      )
    },
    {
      name: 'top-level-spout-identity-binding-is-removed',
      target: 'SIGNALING_SPOUT_FIXTURE_USAGE',
      source: replaceOnce(
        source,
        'const spoutSenderArtifact = validateSpoutSenderArtifact(config);',
        'const spoutSenderArtifact = Object.freeze({ executable: config.spoutSenderPath, sha256: config.expectedSpoutSenderSha256 });'
      )
    }
  ];
  return mutations.map((mutation) => {
    const failed = evaluate(mutation.source)
      .filter((check) => !check.ok)
      .map((check) => check.id);
    return {
      name: mutation.name,
      target: mutation.target,
      failed,
      ok: failed.length === 1 && failed[0] === mutation.target
    };
  });
}

function run() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const baseline = evaluate(source);
  const mutations = runMutations(source);
  const baselineReady = baseline.every((check) => check.ok);
  const ok = baselineReady && mutations.length === 8 && mutations.every((entry) => entry.ok);
  for (const check of baseline) {
    console.log(`[SPOUT POLICY ${check.ok ? 'PASS' : 'FAIL'}] ${check.id}`);
  }
  for (const mutation of mutations) {
    console.log(
      `[SPOUT MUTATION ${mutation.ok ? 'PASS' : 'FAIL'}] ${mutation.name}: ` +
      `${mutation.failed.join(',') || 'none'}`
    );
  }
  console.log(
    `[SPOUT SUMMARY] sourceSha256=${sha256(source)} baseline=${baselineReady ? 'pass' : 'fail'} ` +
    `mutations=${mutations.length}/8`
  );
  if (!ok) process.exitCode = 1;
}

run();
