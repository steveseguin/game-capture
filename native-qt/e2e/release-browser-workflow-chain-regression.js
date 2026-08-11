#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const paths = {
  package: path.join(root, 'package.json'),
  readiness: path.join(root, 'qa', 'run-release-readiness.ps1'),
  fast: path.join(root, 'qa', 'run-fast-gate.ps1'),
  nightly: path.join(root, 'qa', 'run-nightly-soak.ps1'),
  publish: path.join(root, 'qa', 'release-and-publish.ps1'),
  fastWorkflow: path.join(root, '..', '.github', 'workflows', 'qa-fast-gate.yml'),
  nightlyWorkflow: path.join(root, '..', '.github', 'workflows', 'qa-nightly-soak.yml')
};

function readInputs(overrides = {}) {
  return Object.fromEntries(Object.entries(paths).map(([name, filePath]) => [
    name,
    Object.prototype.hasOwnProperty.call(overrides, name)
      ? overrides[name]
      : fs.readFileSync(filePath, 'utf8')
  ]));
}

function count(text, token) {
  return text.split(token).length - 1;
}

function evaluate(input) {
  let pkg;
  try {
    pkg = JSON.parse(input.package);
  } catch {
    pkg = { scripts: {} };
  }
  const scripts = pkg.scripts || {};
  const aliasContract = {
    'gate:local-candidate-send-outcomes':
      'powershell -NoProfile -ExecutionPolicy Bypass -File e2e/local-candidate-send-outcome-policy-mutations.ps1',
    'gate:signaling-spout-artifact-bindings':
      'node e2e/signaling-spout-artifact-binding-regression.js',
    'gate:director-packaged-identity':
      'node e2e/director-packaged-identity-regression.js',
    'gate:signaling-media-fixture': 'node e2e/signaling-media-fixture-regression.js',
    'gate:installed-firefox-bidi': 'node e2e/installed-firefox-bidi-regression.js',
    'e2e:signaling-regressions:edge':
      'node e2e/signaling-regressions-e2e.js --browser=edge',
    'e2e:signaling-regressions:firefox':
      'node e2e/signaling-regressions-e2e.js --browser=firefox',
    'e2e:signaling-regressions:firefox-installed':
      'node e2e/signaling-regressions-e2e.js --browser=firefox-installed',
    'e2e:control-center:edge':
      'node e2e/director-room-e2e.js --browser=edge --strict-negotiation --require-packaged-artifact',
    'e2e:control-center:firefox':
      'node e2e/director-room-e2e.js --browser=firefox --video-codec=vp9 --disable-room-lq --strict-negotiation --require-packaged-artifact',
    'e2e:control-center:firefox-installed':
      'node e2e/director-room-e2e.js --browser=firefox-installed --video-codec=vp9 --disable-room-lq --strict-negotiation --require-packaged-artifact'
  };
  const aliasOk = Object.entries(aliasContract).every(([name, command]) =>
    scripts[name] === command
  );

  const requiredOrder = [
    'gate:local-candidate-send-outcomes',
    'gate:signaling-spout-artifact-bindings',
    'gate:director-packaged-identity',
    'gate:signaling-media-fixture',
    'gate:installed-firefox-bidi',
    'e2e:signaling-regressions:edge',
    'e2e:signaling-regressions:firefox',
    'e2e:signaling-regressions:firefox-installed',
    'e2e:control-center:edge',
    'e2e:control-center:firefox',
    'e2e:control-center:firefox-installed'
  ];
  const readinessOrderTokens = requiredOrder.map((token) => `"${token}"`);
  const orderOffsets = readinessOrderTokens.map((token) => input.readiness.indexOf(token));
  const orderOk = orderOffsets.every((offset) => offset >= 0) &&
    orderOffsets.every((offset, index) => index === 0 || offset > orderOffsets[index - 1]) &&
    readinessOrderTokens.every((token) => count(input.readiness, token) === 1);

  const identityOk = /\[string\]\$FirefoxPath/.test(input.readiness) &&
    /bin[\\/]\$Configuration[\\/]spout_test_sender\.exe/.test(input.readiness) &&
    !/build-test[\\/]bin[\\/]spout_test_sender\.exe/.test(input.readiness) &&
    /-Name firefoxPathBinding -Scope Script -Option Constant/.test(input.readiness) &&
    /-Name firefoxSha256Binding -Scope Script -Option Constant/.test(input.readiness) &&
    /-Name spoutSenderPathBinding -Scope Script -Option Constant/.test(input.readiness) &&
    /-Name spoutSenderSha256Binding -Scope Script -Option Constant/.test(input.readiness) &&
    count(input.readiness, '--spout-sender-path=$script:spoutSenderPathBinding') === 6 &&
    count(input.readiness, '--expected-spout-sender-sha256=$script:spoutSenderSha256Binding') === 6 &&
    count(input.readiness, '--firefox-path=$script:firefoxPathBinding') === 3 &&
    count(input.readiness, '--expected-firefox-sha256=$script:firefoxSha256Binding') === 3;

  const reportOk = /function Assert-FreshBrowserWorkflowReport/.test(input.readiness) &&
    count(input.readiness, '--report-dir=') >= 6 &&
    /signaling-regressions-\*\.json/.test(input.readiness) &&
    /director-room-e2e-\*\.json/.test(input.readiness) &&
    /\.ok/.test(input.readiness) &&
    /packagedArtifactManifest/.test(input.readiness) &&
    /spoutSenderArtifact|sourceFixtureArtifact/.test(input.readiness) &&
    /browserArtifact/.test(input.readiness);

  const callers = [input.fast, input.nightly, input.publish];
  const workflows = [input.fastWorkflow, input.nightlyWorkflow];
  const forwardingOk = callers.every((text) =>
    /\[string\]\$FirefoxPath/.test(text) &&
      (/(?:^|\s)FirefoxPath\s*=\s*\$FirefoxPath/m.test(text) ||
        /["']-FirefoxPath["']\s*,\s*\$FirefoxPath/.test(text))
  ) && workflows.every((text) =>
    /firefox\.exe/i.test(text) && /-FirefoxPath/.test(text)
  );

  return [
    { id: 'RELEASE_BROWSER_ALIASES_ARE_EXACT', ok: aliasOk },
    { id: 'RELEASE_BROWSER_CHAIN_ORDER_IS_EXACT', ok: orderOk },
    { id: 'RELEASE_BROWSER_ARTIFACT_IDENTITIES_ARE_BOUND', ok: identityOk },
    { id: 'RELEASE_BROWSER_REPORTS_ARE_FRESH_AND_VERIFIED', ok: reportOk },
    { id: 'RELEASE_FIREFOX_IDENTITY_IS_FORWARDED_BY_ALL_CALLERS', ok: forwardingOk }
  ];
}

function replaceOnce(text, before, after) {
  if (count(text, before) !== 1) throw new Error(`Expected one mutation anchor: ${before}`);
  return text.replace(before, after);
}

function runMutations(input) {
  if (!evaluate(input).every((entry) => entry.ok)) return [];
  const mutations = [
    ['installed-signaling-alias-removed', 'package',
      '"e2e:signaling-regressions:firefox-installed"',
      '"e2e:signaling-regressions:firefox-installed-disabled"',
      'RELEASE_BROWSER_ALIASES_ARE_EXACT'],
    ['installed-control-center-loses-packaged-mode', 'package',
      '--strict-negotiation --require-packaged-artifact",\n    "e2e:remote-control-contract',
      '--strict-negotiation",\n    "e2e:remote-control-contract',
      'RELEASE_BROWSER_ALIASES_ARE_EXACT'],
    ['installed-firefox-signaling-order-is-swapped', 'readiness',
      'e2e:signaling-regressions:firefox-installed',
      'e2e:control-center:firefox-installed',
      'RELEASE_BROWSER_CHAIN_ORDER_IS_EXACT'],
    ['spout-hash-binding-is-dropped', 'readiness',
      '-Name spoutSenderSha256Binding -Scope Script -Option Constant',
      '-Name discardedSpoutSenderSha256Binding -Scope Script -Option Constant',
      'RELEASE_BROWSER_ARTIFACT_IDENTITIES_ARE_BOUND'],
    ['fresh-report-verifier-is-renamed', 'readiness',
      'function Assert-FreshBrowserWorkflowReport',
      'function Skip-FreshBrowserWorkflowReport',
      'RELEASE_BROWSER_REPORTS_ARE_FRESH_AND_VERIFIED'],
    ['fast-gate-drops-firefox', 'fast', 'FirefoxPath = $FirefoxPath', '',
      'RELEASE_FIREFOX_IDENTITY_IS_FORWARDED_BY_ALL_CALLERS'],
    ['nightly-drops-firefox', 'nightly', 'FirefoxPath = $FirefoxPath', '',
      'RELEASE_FIREFOX_IDENTITY_IS_FORWARDED_BY_ALL_CALLERS'],
    ['publish-drops-firefox', 'publish', '"-FirefoxPath", $FirefoxPath', '',
      'RELEASE_FIREFOX_IDENTITY_IS_FORWARDED_BY_ALL_CALLERS']
  ];
  return mutations.map(([name, file, before, after, target]) => {
    const mutated = { ...input, [file]: replaceOnce(input[file], before, after) };
    const failed = evaluate(mutated).filter((entry) => !entry.ok).map((entry) => entry.id);
    return { name, target, failed, ok: failed.length === 1 && failed[0] === target };
  });
}

const input = readInputs();
const policies = evaluate(input);
const mutations = runMutations(input);
for (const policy of policies) {
  console.log(`[RELEASE BROWSER POLICY ${policy.ok ? 'PASS' : 'FAIL'}] ${policy.id}`);
}
for (const mutation of mutations) {
  console.log(`[RELEASE BROWSER MUTATION ${mutation.ok ? 'PASS' : 'FAIL'}] ${mutation.name}: ${mutation.failed.join(',') || 'none'}`);
}
const ok = policies.every((entry) => entry.ok) &&
  mutations.length === 8 && mutations.every((entry) => entry.ok);
console.log(`[RELEASE BROWSER SUMMARY] policies=${policies.filter((entry) => entry.ok).length}/${policies.length} mutations=${mutations.length}/8`);
if (!ok) process.exitCode = 1;
