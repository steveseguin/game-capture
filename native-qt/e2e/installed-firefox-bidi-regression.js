#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  launchInstalledFirefox,
  installedFirefoxPath,
  sha256File
} = require('./firefox-bidi-adapter');

const ADAPTER_PATH = path.resolve(__dirname, 'firefox-bidi-adapter.js');
const DIRECTOR_PATH = path.resolve(__dirname, 'director-room-e2e.js');
const SIGNALING_PATH = path.resolve(__dirname, 'signaling-regressions-e2e.js');
const GATE_PATH = path.resolve(__dirname, 'installed-firefox-bidi-regression.js');

const SIGNALING_POLICY_IDS = new Set([
  'INSTALLED_FIREFOX_SIGNALING_NATIVE_BIDI_BRANCH',
  'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
  'INSTALLED_FIREFOX_SIGNALING_EXPECTED_IDENTITY_BINDING',
  'INSTALLED_FIREFOX_SIGNALING_ARTIFACT_PROVENANCE'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const config = {
    staticOnly: false,
    reportDir: path.resolve(__dirname, 'reports', 'installed-firefox-bidi'),
    firefoxPath: '',
    expectedFirefoxSha256: ''
  };
  const counts = {
    staticOnly: 0,
    reportDir: 0,
    firefoxPath: 0,
    expectedFirefoxSha256: 0
  };

  for (const arg of argv) {
    if (arg === '--static-only') {
      counts.staticOnly += 1;
      config.staticOnly = true;
      continue;
    }
    if (arg.startsWith('--report-dir=')) {
      counts.reportDir += 1;
      const value = arg.slice('--report-dir='.length);
      if (!value) throw new Error('--report-dir requires a nonempty path');
      config.reportDir = path.resolve(value);
      continue;
    }
    if (arg.startsWith('--firefox-path=')) {
      counts.firefoxPath += 1;
      const value = arg.slice('--firefox-path='.length);
      config.firefoxPath = value ? path.resolve(value) : '';
      continue;
    }
    if (arg.startsWith('--expected-firefox-sha256=')) {
      counts.expectedFirefoxSha256 += 1;
      config.expectedFirefoxSha256 = arg.slice('--expected-firefox-sha256='.length);
      continue;
    }
    throw new Error(`Unknown installed-Firefox gate argument: ${arg}`);
  }

  for (const [name, count] of Object.entries(counts)) {
    if (count > 1) throw new Error(`Installed-Firefox gate argument must appear once: ${name}`);
  }
  const browserIdentityArgumentCount = counts.firefoxPath + counts.expectedFirefoxSha256;
  if (browserIdentityArgumentCount > 0) {
    if (counts.firefoxPath !== 1 || counts.expectedFirefoxSha256 !== 1 ||
        !config.firefoxPath || !config.expectedFirefoxSha256) {
      throw new Error('Installed Firefox requires one nonempty path and one SHA-256 argument');
    }
    if (!/^[0-9a-f]{64}$/.test(config.expectedFirefoxSha256)) {
      throw new Error('Expected Firefox SHA-256 must be 64 lowercase hexadecimal characters');
    }
  }
  return config;
}

function evaluateGateArgumentContract(parse) {
  const fixturePath = path.resolve(__dirname, 'fixture-firefox.exe');
  const reportPath = path.resolve(__dirname, 'fixture-report-dir');
  const fixtureSha256 = 'a'.repeat(64);
  const cases = [];
  const accept = (name, argv, predicate) => {
    try {
      const config = parse(argv);
      cases.push({ name, ok: predicate(config), outcome: 'accepted' });
    } catch (error) {
      cases.push({ name, ok: false, outcome: String(error.message || error) });
    }
  };
  const reject = (name, argv) => {
    try {
      parse(argv);
      cases.push({ name, ok: false, outcome: 'accepted' });
    } catch (error) {
      cases.push({ name, ok: true, outcome: String(error.message || error) });
    }
  };

  accept('default-local-discovery', [], (config) =>
    config.staticOnly === false && config.firefoxPath === '' &&
      config.expectedFirefoxSha256 === '');
  accept('static-only', ['--static-only'], (config) => config.staticOnly === true);
  accept('explicit-report-directory', [`--report-dir=${reportPath}`], (config) =>
    config.reportDir === reportPath);
  accept('exact-browser-identity-pair', [
    `--firefox-path=${fixturePath}`,
    `--expected-firefox-sha256=${fixtureSha256}`
  ], (config) => config.firefoxPath === fixturePath &&
    config.expectedFirefoxSha256 === fixtureSha256);

  reject('unknown-option', ['--firefox-pth=typo']);
  reject('empty-report-directory', ['--report-dir=']);
  reject('empty-firefox-path', [
    '--firefox-path=',
    `--expected-firefox-sha256=${fixtureSha256}`
  ]);
  reject('empty-firefox-hash', [
    `--firefox-path=${fixturePath}`,
    '--expected-firefox-sha256='
  ]);
  reject('path-without-hash', [`--firefox-path=${fixturePath}`]);
  reject('hash-without-path', [`--expected-firefox-sha256=${fixtureSha256}`]);
  reject('uppercase-hash', [
    `--firefox-path=${fixturePath}`,
    `--expected-firefox-sha256=${fixtureSha256.toUpperCase()}`
  ]);
  reject('malformed-hash', [
    `--firefox-path=${fixturePath}`,
    '--expected-firefox-sha256=abc'
  ]);
  reject('duplicate-static-only', ['--static-only', '--static-only']);
  reject('duplicate-report-directory', [
    `--report-dir=${reportPath}`,
    `--report-dir=${reportPath}`
  ]);
  reject('duplicate-firefox-path', [
    `--firefox-path=${fixturePath}`,
    `--firefox-path=${fixturePath}`,
    `--expected-firefox-sha256=${fixtureSha256}`
  ]);
  reject('duplicate-firefox-hash', [
    `--firefox-path=${fixturePath}`,
    `--expected-firefox-sha256=${fixtureSha256}`,
    `--expected-firefox-sha256=${fixtureSha256}`
  ]);
  return { cases, ok: cases.length === 16 && cases.every((entry) => entry.ok) };
}

function loadParseArgsFromSource(source) {
  const candidateModule = { exports: {} };
  const executableSource = source.replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  const compile = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    executableSource
  );
  compile(require, candidateModule, candidateModule.exports, GATE_PATH, __dirname);
  if (typeof candidateModule.exports.parseArgs !== 'function') {
    throw new Error('Mutated installed-Firefox gate did not export parseArgs');
  }
  return candidateModule.exports.parseArgs;
}

function evaluateGateArgumentContractSource(source) {
  try {
    return evaluateGateArgumentContract(loadParseArgsFromSource(source));
  } catch (error) {
    return { cases: [], ok: false, error: String(error.message || error) };
  }
}

function installedFirefoxGateFunctionSlices(source) {
  const runtimeStart = source.lastIndexOf('async function runRuntimeProbe(config) {');
  const runStart = source.lastIndexOf('async function run() {');
  const runEnd = source.lastIndexOf('module.exports = {');
  if (runtimeStart < 0 || runStart <= runtimeStart || runEnd <= runStart) {
    return { ok: false, runtime: '', run: '' };
  }
  return {
    ok: true,
    runtime: source.slice(runtimeStart, runStart),
    run: source.slice(runStart, runEnd)
  };
}

function evaluatePolicy(adapterSource, directorSource, signalingSource, gateSource) {
  const gateArgumentContract = evaluateGateArgumentContractSource(gateSource);
  const gateFunctions = installedFirefoxGateFunctionSlices(gateSource);
  return [
    {
      id: 'INSTALLED_FIREFOX_DIRECTOR_NATIVE_BIDI_BRANCH',
      ok: /async function launchDirectorBrowser\(config, exactFirefoxArtifact = null\)/.test(
        directorSource
      ) && /config\.browser === 'firefox-installed'[\s\S]{0,260}!exactFirefoxArtifact[\s\S]{0,300}const beforeLaunch = revalidateExpectedFileArtifact\(/.test(
        directorSource
      ) && /browser = await launchInstalledFirefox\(\{\s*executablePath:\s*beforeLaunch\.path,\s*expectedSha256:\s*beforeLaunch\.sha256,\s*headless:\s*!config\.headful\s*\}\);/.test(
        directorSource
      ) && /const postLaunch = validateLaunchedFirefoxArtifact\(browser, beforeLaunch\);[\s\S]{0,260}browser\.artifactReceipt = Object\.freeze\(\{[\s\S]{0,240}return browser;/.test(
        directorSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_DIRECTOR_ARTIFACT_PROVENANCE',
      ok: /const browserLaunchArtifact = browser\.artifactReceipt\.postLaunch;[\s\S]{0,180}report\.browserArtifact\s*=\s*\{\s*\.\.\.artifactEvidence\(browserLaunchArtifact\),\s*expectedSha256:\s*preparedArtifacts\.firefox\.sha256,\s*automation:\s*browser\.automation,\s*version:\s*browser\.version\(\)/.test(
        directorSource
      ) && /verifyDirectorArtifactsStable\(config, preparedArtifacts, runtimeArtifacts\)/.test(
        directorSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_PROFILE_PERMISSION_PATH',
      ok: /return browserName === 'firefox' \|\| browserName === 'firefox-installed';/.test(
        directorSource
      ) && /grantPermissions\(\)\s*\{[\s\S]{0,220}silent grant fallback is forbidden/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_REAL_POINTER_INPUT',
      ok: (adapterSource.match(/command\('input\.performActions'/g) || []).length === 2 &&
        /type:\s*'pointerDown'[\s\S]{0,120}type:\s*'pointerUp'/.test(adapterSource)
    },
    {
      id: 'INSTALLED_FIREFOX_SCREENSHOT_SCOPE_DISCLOSED',
      ok: /fallbackReason:\s*options\.fullPage && !documentOriginUsable/.test(adapterSource) &&
        /report\.screenshotEvidence\s*=\s*page\.lastScreenshotEvidence/.test(directorSource)
    },
    {
      id: 'INSTALLED_FIREFOX_LONG_RUN_PIPE_DRAIN',
      ok: /child\.stdout\.resume\(\);[\s\S]{0,80}child\.stderr\.resume\(\);/.test(adapterSource)
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_WAIT_BOUNDARY',
      ok: /class BidiPage[\s\S]{0,1800}async waitForTimeout\(milliseconds\)\s*\{[\s\S]{0,120}await wait\(milliseconds\);/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_ICE_CANDIDATE_VISIBILITY',
      ok: /\['media\.peerconnection\.ice\.obfuscate_host_addresses', false\]/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_PROFILE_CLEANUP',
      ok: /async close\(\)[\s\S]{0,1600}fs\.rmSync\(this\.profilePath, \{ recursive: true, force: true \}\)/.test(
        adapterSource
      ) && /catch \(error\)[\s\S]{0,500}fs\.rmSync\(profilePath, \{ recursive: true, force: true \}\)/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_EXPLICIT_IDENTITY_FAILS_CLOSED',
      ok: /const requireFirefoxFile = \(candidate, source\) => \{[\s\S]{0,220}!fs\.existsSync\(resolved\) \|\| !fs\.statSync\(resolved\)\.isFile\(\)[\s\S]{0,160}throw new Error\(`\$\{source\} Firefox executable was not found: \$\{resolved\}`\);[\s\S]{0,240}if \(explicitPath\) \{\s*return requireFirefoxFile\(explicitPath, 'Explicit'\);\s*\}/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_EXPECTED_SHA256_ENFORCED',
      ok: /const expectedSha256 = String\(options\.expectedSha256 \|\| ''\)\.trim\(\)\.toLowerCase\(\);[\s\S]{0,220}const executableSha256BeforeLaunch = sha256File\(executablePath\);[\s\S]{0,180}if \(expectedSha256 && executableSha256BeforeLaunch !== expectedSha256\) \{[\s\S]{0,260}const profilePath = fs\.mkdtempSync/.test(
        adapterSource
      ) && /const executableSha256AfterConnect = sha256File\(executablePath\);[\s\S]{0,200}if \(executableSha256AfterConnect !== executableSha256BeforeLaunch \|\|\s*\(expectedSha256 && executableSha256AfterConnect !== expectedSha256\)\) \{[\s\S]{0,320}executableSha256: executableSha256AfterConnect/.test(
        adapterSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_NATIVE_BIDI_BRANCH',
      ok: /const\s*\{\s*launchInstalledFirefox\s*\}\s*=\s*require\('\.\/firefox-bidi-adapter'\);/.test(
        signalingSource
      ) && /if \(config\.browser === 'firefox-installed'\)\s*\{[\s\S]{0,320}\breturn\b/.test(
        signalingSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
      ok: /firefoxPath:\s*''/.test(signalingSource) &&
        /expectedFirefoxSha256:\s*''/.test(signalingSource) &&
        /browserIdentityArgumentCounts\s*=\s*\{\s*firefoxPath:\s*0,\s*expectedFirefoxSha256:\s*0\s*\}/.test(
          signalingSource
        ) && /arg\.startsWith\('--firefox-path='\)[\s\S]{0,220}browserIdentityArgumentCounts\.firefoxPath\s*\+=\s*1[\s\S]{0,180}config\.firefoxPath\s*=\s*value\s*\?\s*path\.resolve\(value\)\s*:\s*''/.test(
          signalingSource
        ) && /arg\.startsWith\('--expected-firefox-sha256='\)[\s\S]{0,220}browserIdentityArgumentCounts\.expectedFirefoxSha256\s*\+=\s*1[\s\S]{0,160}config\.expectedFirefoxSha256\s*=\s*value/.test(
          signalingSource
        ) && /if \(config\.browser === 'firefox-installed'\) \{\s*for \(const \[name, count\] of Object\.entries\(browserIdentityArgumentCounts\)\) \{\s*if \(count !== 1 \|\| !config\[name\]\)/.test(
          signalingSource
        ) && /if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(config\.expectedFirefoxSha256\)\) \{/.test(
          signalingSource
        ) && /\} else if \(Object\.values\(browserIdentityArgumentCounts\)\.some\(\(count\) => count !== 0\)\) \{/.test(
          signalingSource
        ) && /\['edge', 'chromium', 'firefox', 'firefox-installed'\]\.includes\(config\.browser\)/.test(
          signalingSource
        )
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_EXPECTED_IDENTITY_BINDING',
      ok: /if \(config\.browser === 'firefox-installed'\)\s*\{[\s\S]{0,320}return launchInstalledFirefox\(\{[\s\S]{0,180}executablePath:\s*config\.firefoxPath,[\s\S]{0,160}expectedSha256:\s*config\.expectedFirefoxSha256,[\s\S]{0,120}headless:\s*!config\.headful/.test(
        signalingSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_SIGNALING_ARTIFACT_PROVENANCE',
      ok: /report\.browserArtifact\s*=\s*\{[\s\S]{0,300}path:\s*browser\.executablePath,[\s\S]{0,200}sha256:\s*browser\.executableSha256,[\s\S]{0,200}automation:\s*browser\.automation,[\s\S]{0,200}version:\s*browser\.version\(\)/.test(
        signalingSource
      )
    },
    {
      id: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      ok: gateArgumentContract.ok && gateFunctions.ok &&
        /function\s+parseArgs\(argv\)/.test(gateSource) &&
        /runRuntimeProbe\(config\)/.test(gateFunctions.run) &&
        /installedFirefoxPath\(config\.firefoxPath\)/.test(gateFunctions.runtime) &&
        /const\s+expectedFirefoxSha256\s*=\s*config\.expectedFirefoxSha256\s*\|\|\s*exactFirefoxSha256/.test(
          gateFunctions.runtime
        ) &&
        /expectedSha256:\s*expectedFirefoxSha256/.test(gateFunctions.runtime) &&
        /requestedBrowserArtifact:\s*\{\s*path:\s*config\.firefoxPath,\s*sha256:\s*config\.expectedFirefoxSha256/.test(
          gateFunctions.run
        ) && /fs\.mkdirSync\(config\.reportDir/.test(gateFunctions.run) &&
        /argumentContract\.ok\s*&&/.test(gateFunctions.run)
    }
  ];
}

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one mutation anchor: ${before}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceFirst(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Expected mutation anchor: ${before}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceLast(source, before, after) {
  const index = source.lastIndexOf(before);
  if (index < 0) throw new Error(`Expected mutation anchor: ${before}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function runMutations(adapterSource, directorSource, signalingSource, gateSource) {
  const baseline = evaluatePolicy(adapterSource, directorSource, signalingSource, gateSource);
  const baselineById = new Map(baseline.map((check) => [check.id, check.ok]));
  const signalingBaselineReady = baseline
    .filter((check) => SIGNALING_POLICY_IDS.has(check.id))
    .every((check) => check.ok);
  const mutations = [
    {
      name: 'gate-firefox-path-argument-is-discarded',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceFirst(
        gateSource,
        "config.firefoxPath = value ? path.resolve(value) : '';",
        "config.firefoxPath = '';"
      )
    },
    {
      name: 'gate-firefox-hash-argument-is-discarded',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceFirst(
        gateSource,
        "config.expectedFirefoxSha256 = arg.slice('--expected-firefox-sha256='.length);",
        "config.expectedFirefoxSha256 = '';"
      )
    },
    {
      name: 'gate-duplicate-arguments-are-accepted',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceFirst(gateSource, 'if (count > 1) throw', 'if (false && count > 1) throw')
    },
    {
      name: 'gate-partial-browser-identity-is-accepted',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceFirst(
        gateSource,
        'if (browserIdentityArgumentCount > 0) {',
        'if (false && browserIdentityArgumentCount > 0) {'
      )
    },
    {
      name: 'gate-unknown-options-are-ignored',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceFirst(
        gateSource,
        'throw new Error(`Unknown installed-Firefox gate argument: ${arg}`);',
        'continue;'
      )
    },
    {
      name: 'gate-runtime-discards-explicit-firefox-path',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceLast(
        gateSource,
        'const exactFirefoxPath = installedFirefoxPath(config.firefoxPath);',
        'const exactFirefoxPath = installedFirefoxPath();'
      )
    },
    {
      name: 'gate-runtime-discards-expected-firefox-hash',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceLast(
        gateSource,
        'const expectedFirefoxSha256 = config.expectedFirefoxSha256 || exactFirefoxSha256;',
        'const expectedFirefoxSha256 = exactFirefoxSha256;'
      )
    },
    {
      name: 'gate-report-forges-requested-firefox-path',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceLast(gateSource, 'path: config.firefoxPath,', "path: '',")
    },
    {
      name: 'gate-report-directory-ignores-config',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceLast(
        gateSource,
        'fs.mkdirSync(config.reportDir, { recursive: true });',
        "fs.mkdirSync(path.resolve(__dirname, 'reports'), { recursive: true });"
      )
    },
    {
      name: 'gate-argument-contract-is-not-load-bearing',
      target: 'INSTALLED_FIREFOX_GATE_ARGUMENT_CONTRACT',
      adapter: adapterSource,
      director: directorSource,
      signaling: signalingSource,
      gate: replaceLast(gateSource, 'argumentContract.ok &&', 'true &&')
    },
    {
      name: 'playwright-fallback-replaces-native-bidi',
      target: 'INSTALLED_FIREFOX_DIRECTOR_NATIVE_BIDI_BRANCH',
      adapter: adapterSource,
      director: replaceOnce(
        directorSource,
        'browser = await launchInstalledFirefox({',
        'browser = await firefox.launch({'
      )
    },
    {
      name: 'browser-path-provenance-is-blank',
      target: 'INSTALLED_FIREFOX_DIRECTOR_ARTIFACT_PROVENANCE',
      adapter: adapterSource,
      director: replaceOnce(
        directorSource,
        '...artifactEvidence(browserLaunchArtifact),',
        "path: '', sha256: '',"
      )
    },
    {
      name: 'installed-firefox-loses-profile-permission-route',
      target: 'INSTALLED_FIREFOX_PROFILE_PERMISSION_PATH',
      adapter: adapterSource,
      director: replaceOnce(
        directorSource,
        "return browserName === 'firefox' || browserName === 'firefox-installed';",
        "return browserName === 'firefox';"
      )
    },
    {
      name: 'one-real-input-boundary-is-removed',
      target: 'INSTALLED_FIREFOX_REAL_POINTER_INPUT',
      adapter: adapterSource.replace(
        "command('input.performActions'",
        "command('script.callFunction'"
      ),
      director: directorSource
    },
    {
      name: 'screenshot-fallback-disclosure-is-forged',
      target: 'INSTALLED_FIREFOX_SCREENSHOT_SCOPE_DISCLOSED',
      adapter: replaceOnce(
        adapterSource,
        'fallbackReason: options.fullPage && !documentOriginUsable',
        'fallbackReason: false && !documentOriginUsable'
      ),
      director: directorSource
    },
    {
      name: 'long-run-stderr-drain-is-removed',
      target: 'INSTALLED_FIREFOX_LONG_RUN_PIPE_DRAIN',
      adapter: replaceOnce(adapterSource, '      child.stderr.resume();\n', ''),
      director: directorSource
    },
    {
      name: 'signaling-wait-boundary-is-removed',
      target: 'INSTALLED_FIREFOX_SIGNALING_WAIT_BOUNDARY',
      adapter: replaceOnce(
        adapterSource,
        '  async waitForTimeout(milliseconds) {\n    await wait(milliseconds);\n  }\n\n',
        ''
      ),
      director: directorSource
    },
    {
      name: 'signaling-ice-candidate-visibility-is-reobfuscated',
      target: 'INSTALLED_FIREFOX_SIGNALING_ICE_CANDIDATE_VISIBILITY',
      adapter: replaceOnce(
        adapterSource,
        "    ['media.peerconnection.ice.obfuscate_host_addresses', false],\n",
        "    ['media.peerconnection.ice.obfuscate_host_addresses', true],\n"
      ),
      director: directorSource
    },
    {
      name: 'normal-close-profile-cleanup-is-removed',
      target: 'INSTALLED_FIREFOX_PROFILE_CLEANUP',
      adapter: replaceOnce(
        adapterSource,
        "      fs.rmSync(this.profilePath, { recursive: true, force: true });\n",
        ''
      ),
      director: directorSource
    },
    {
      name: 'dead-explicit-firefox-path-falls-through',
      target: 'INSTALLED_FIREFOX_EXPLICIT_IDENTITY_FAILS_CLOSED',
      adapter: replaceOnce(
        adapterSource,
        "  if (explicitPath) {\n    return requireFirefoxFile(explicitPath, 'Explicit');\n  }",
        "  if (explicitPath && fs.existsSync(explicitPath)) {\n    return requireFirefoxFile(explicitPath, 'Explicit');\n  }"
      ),
      director: directorSource
    },
    {
      name: 'explicit-firefox-leaf-check-is-removed',
      target: 'INSTALLED_FIREFOX_EXPLICIT_IDENTITY_FAILS_CLOSED',
      adapter: replaceOnce(
        adapterSource,
        'if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {',
        'if (!fs.existsSync(resolved)) {'
      ),
      director: directorSource
    },
    {
      name: 'pre-launch-firefox-hash-check-is-bypassed',
      target: 'INSTALLED_FIREFOX_EXPECTED_SHA256_ENFORCED',
      adapter: replaceOnce(
        adapterSource,
        'if (expectedSha256 && executableSha256BeforeLaunch !== expectedSha256) {',
        'if (false && expectedSha256 && executableSha256BeforeLaunch !== expectedSha256) {'
      ),
      director: directorSource
    },
    {
      name: 'post-connect-firefox-hash-check-is-bypassed',
      target: 'INSTALLED_FIREFOX_EXPECTED_SHA256_ENFORCED',
      adapter: replaceOnce(
        adapterSource,
        'if (executableSha256AfterConnect !== executableSha256BeforeLaunch ||\n        (expectedSha256 && executableSha256AfterConnect !== expectedSha256)) {',
        'if (false && (executableSha256AfterConnect !== executableSha256BeforeLaunch ||\n        (expectedSha256 && executableSha256AfterConnect !== expectedSha256))) {'
      ),
      director: directorSource
    }
  ];

  if (signalingBaselineReady) {
    mutations.push(
      {
        name: 'signaling-playwright-fallback-replaces-native-bidi',
        target: 'INSTALLED_FIREFOX_SIGNALING_EXPECTED_IDENTITY_BINDING',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          'return launchInstalledFirefox({',
          'return firefox.launch({'
        )
      },
      {
        name: 'signaling-native-bidi-import-is-removed',
        target: 'INSTALLED_FIREFOX_SIGNALING_NATIVE_BIDI_BRANCH',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          "const { launchInstalledFirefox } = require('./firefox-bidi-adapter');",
          "const { launchInstalledFirefox: launchFirefox } = require('./firefox-bidi-adapter');"
        )
      },
      {
        name: 'signaling-firefox-path-argument-is-discarded',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          '  const browserIdentityArgumentCounts = {\n    firefoxPath: 0,\n    expectedFirefoxSha256: 0\n  };',
          '  const browserIdentityArgumentCounts = {\n    discardedFirefoxPath: 0,\n    expectedFirefoxSha256: 0\n  };'
        )
      },
      {
        name: 'signaling-firefox-hash-argument-is-discarded',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          "arg.startsWith('--expected-firefox-sha256=')",
          "arg.startsWith('--discarded-firefox-sha256=')"
        )
      },
      {
        name: 'signaling-duplicate-firefox-identity-is-accepted',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          "if (config.browser === 'firefox-installed') {\n    for (const [name, count] of Object.entries(browserIdentityArgumentCounts)) {\n      if (count !== 1 || !config[name]) {",
          "if (config.browser === 'firefox-installed') {\n    for (const [name, count] of Object.entries(browserIdentityArgumentCounts)) {\n      if (count < 1 || !config[name]) {"
        )
      },
      {
        name: 'signaling-firefox-hash-format-check-is-bypassed',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          "if (!/^[0-9a-f]{64}$/.test(config.expectedFirefoxSha256)) {",
          "if (false && !/^[0-9a-f]{64}$/.test(config.expectedFirefoxSha256)) {"
        )
      },
      {
        name: 'signaling-noninstalled-browser-accepts-firefox-identity',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          '} else if (Object.values(browserIdentityArgumentCounts).some((count) => count !== 0)) {',
          '} else if (false && Object.values(browserIdentityArgumentCounts).some((count) => count !== 0)) {'
        )
      },
      {
        name: 'signaling-expected-firefox-hash-is-not-forwarded',
        target: 'INSTALLED_FIREFOX_SIGNALING_EXPECTED_IDENTITY_BINDING',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          'expectedSha256: config.expectedFirefoxSha256,',
          "expectedSha256: '',"
        )
      },
      {
        name: 'signaling-installed-firefox-browser-route-is-removed',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARGUMENT_CONTRACT',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          "['edge', 'chromium', 'firefox', 'firefox-installed']",
          "['edge', 'chromium', 'firefox']"
        )
      },
      {
        name: 'signaling-browser-artifact-path-is-blank',
        target: 'INSTALLED_FIREFOX_SIGNALING_ARTIFACT_PROVENANCE',
        adapter: adapterSource,
        director: directorSource,
        signaling: replaceOnce(
          signalingSource,
          'path: browser.executablePath,',
          "path: '',"
        )
      }
    );
  }

  return {
    signalingBaselineReady,
    expectedSignalingMutationCount: 10,
    results: mutations.map((mutation) => {
      const checks = evaluatePolicy(
        mutation.adapter,
        mutation.director,
        mutation.signaling || signalingSource,
        mutation.gate || gateSource
      );
      const failed = checks
        .filter((check) => baselineById.get(check.id) === true && !check.ok)
        .map((check) => check.id);
      return {
      name: mutation.name,
      target: mutation.target,
      failed,
      ok: failed.length === 1 && failed[0] === mutation.target,
      adapterSha256: sha256(mutation.adapter),
        directorSha256: sha256(mutation.director),
        signalingSha256: sha256(mutation.signaling || signalingSource),
        gateSha256: sha256(mutation.gate || gateSource)
      };
    })
  };
}

function profileNames() {
  return fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('game-capture-firefox-bidi-'))
    .map((entry) => entry.name)
    .sort();
}

async function runRuntimeProbe(config) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-bidi-gate-'));
  const screenshotPath = path.join(temporaryRoot, 'installed-firefox.png');
  const profilesBefore = profileNames();
  let browser = null;
  let mismatchBrowser = null;
  let evidence = {};
  try {
    const exactFirefoxPath = installedFirefoxPath(config.firefoxPath);
    const exactFirefoxSha256 = sha256File(exactFirefoxPath);
    const expectedFirefoxSha256 = config.expectedFirefoxSha256 || exactFirefoxSha256;
    const deadExplicitPath = path.join(temporaryRoot, 'missing-firefox.exe');
    let deadExplicitPathRejected = false;
    let expectedShaMismatchRejected = false;
    try {
      installedFirefoxPath(deadExplicitPath);
    } catch {
      deadExplicitPathRejected = true;
    }
    try {
      mismatchBrowser = await launchInstalledFirefox({
        executablePath: exactFirefoxPath,
        expectedSha256: '0'.repeat(64)
      });
    } catch {
      expectedShaMismatchRejected = true;
    } finally {
      if (mismatchBrowser) await mismatchBrowser.close().catch(() => {});
      mismatchBrowser = null;
    }
    browser = await launchInstalledFirefox({
      executablePath: exactFirefoxPath,
      expectedSha256: expectedFirefoxSha256
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 720 } });
    const page = await context.newPage();
    const html = [
      '<!doctype html><html style="height:0;overflow:hidden"><body style="position:fixed;inset:0">',
      '<button id="action">Click</button><input id="value" value="before">',
      '<script>window.result={clicks:0,trusted:false};',
      'document.querySelector("#action").addEventListener("click",event=>{',
      'window.result.clicks++;window.result.trusted=event.isTrusted;});</script>',
      '</body></html>'
    ].join('');
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.locator('#action').click();
    await page.locator('#value').fill('after');
    const pageState = await page.evaluate(() => ({
      ...window.result,
      value: document.querySelector('#value').value,
      userAgent: navigator.userAgent
    }));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshot = {
      size: fs.statSync(screenshotPath).size,
      sha256: sha256File(screenshotPath),
      ...page.lastScreenshotEvidence
    };
    evidence = {
      browser: {
        path: browser.executablePath,
        sha256: browser.executableSha256,
        expectedPath: exactFirefoxPath,
        expectedSha256: expectedFirefoxSha256,
        version: browser.version(),
        automation: browser.automation
      },
      pageState,
      screenshot,
      checks: {
        exactInstalledPath: browser.executablePath === exactFirefoxPath,
        exactInstalledSha256: browser.executableSha256 === expectedFirefoxSha256 &&
          browser.executableSha256 === sha256File(browser.executablePath),
        deadExplicitPathRejected,
        expectedShaMismatchRejected,
        firefoxUserAgent: /Firefox\//.test(pageState.userAgent),
        realTrustedClick: pageState.clicks === 1 && pageState.trusted === true,
        filledValueObserved: pageState.value === 'after',
        screenshotCaptured: screenshot.size > 0 && /^[0-9a-f]{64}$/.test(screenshot.sha256),
        screenshotScopeDisclosed: screenshot.requestedFullPage === true &&
          ['document', 'viewport'].includes(screenshot.capturedOrigin)
      }
    };
    await context.close();
  } finally {
    if (mismatchBrowser) await mismatchBrowser.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fs.existsSync(temporaryRoot)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  evidence.profilesBefore = profilesBefore;
  evidence.profilesAfter = profileNames();
  evidence.checks.profileCleanup =
    JSON.stringify(evidence.profilesBefore) === JSON.stringify(evidence.profilesAfter);
  evidence.ok = Object.values(evidence.checks).every(Boolean);
  return evidence;
}

async function run() {
  const config = parseArgs(process.argv.slice(2));
  const adapterSource = fs.readFileSync(ADAPTER_PATH, 'utf8');
  const directorSource = fs.readFileSync(DIRECTOR_PATH, 'utf8');
  const signalingSource = fs.readFileSync(SIGNALING_PATH, 'utf8');
  const gateSource = fs.readFileSync(GATE_PATH, 'utf8');
  const baseline = evaluatePolicy(adapterSource, directorSource, signalingSource, gateSource);
  const mutationRun = runMutations(adapterSource, directorSource, signalingSource, gateSource);
  const mutations = mutationRun.results;
  const argumentContract = evaluateGateArgumentContract(parseArgs);
  const runtime = config.staticOnly ? null : await runRuntimeProbe(config);
  const report = {
    generatedAt: new Date().toISOString(),
    sources: {
      adapter: { path: ADAPTER_PATH, sha256: sha256(adapterSource) },
      director: { path: DIRECTOR_PATH, sha256: sha256(directorSource) },
      signaling: { path: SIGNALING_PATH, sha256: sha256(signalingSource) },
      gate: { path: GATE_PATH, sha256: sha256(gateSource) }
    },
    baseline,
    mutations,
    mutationCoverage: {
      signalingBaselineReady: mutationRun.signalingBaselineReady,
      expectedSignalingMutationCount: mutationRun.expectedSignalingMutationCount,
      observedSignalingMutationCount: mutations.filter((mutation) =>
        SIGNALING_POLICY_IDS.has(mutation.target)
      ).length
    },
    requestedBrowserArtifact: {
      path: config.firefoxPath,
      sha256: config.expectedFirefoxSha256
    },
    argumentContract,
    runtime,
    ok: baseline.every((check) => check.ok) &&
      mutations.every((mutation) => mutation.ok) &&
      mutationRun.signalingBaselineReady &&
      mutations.filter((mutation) => SIGNALING_POLICY_IDS.has(mutation.target)).length ===
        mutationRun.expectedSignalingMutationCount &&
      argumentContract.ok &&
      (config.staticOnly || runtime?.ok === true)
  };
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `installed-firefox-bidi-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const check of baseline) {
    console.log(`[BIDI POLICY ${check.ok ? 'PASS' : 'FAIL'}] ${check.id}`);
  }
  for (const mutation of mutations) {
    console.log(`[BIDI MUTATION ${mutation.ok ? 'PASS' : 'FAIL'}] ${mutation.name}: ${mutation.failed.join(',')}`);
  }
  if (!mutationRun.signalingBaselineReady) {
    console.log('[BIDI MUTATION BLOCKED] installed-Firefox signaling baseline is not implemented');
  }
  if (runtime) {
    for (const [name, ok] of Object.entries(runtime.checks)) {
      console.log(`[BIDI RUNTIME ${ok ? 'PASS' : 'FAIL'}] ${name}`);
    }
  }
  console.log(`[BIDI REPORT] ${reportPath}`);
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  parseArgs,
  evaluateGateArgumentContract,
  evaluateGateArgumentContractSource,
  evaluatePolicy
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`[BIDI GATE ERROR] ${error && error.stack ? error.stack : error}`);
    process.exitCode = 2;
  });
}
