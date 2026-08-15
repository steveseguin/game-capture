#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, firefox } = require('playwright');
const { launchInstalledFirefox } = require('./firefox-bidi-adapter');

const RELEASE_ARTIFACT_MANIFEST_FILENAME = 'release-artifact-manifest.json';
const RELEASE_ARTIFACT_MANIFEST_SCHEMA = 'game-capture-release-artifact/v1';
const RELEASE_SOURCE_SNAPSHOT_ALGORITHM =
  'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAudioSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['default-output', 'output', 'system', 'system-output'].includes(normalized)) {
    return 'default-output';
  }
  if (['communications-output', 'communication-output', 'communications', 'voip'].includes(normalized)) {
    return 'communications-output';
  }
  if (['default-microphone', 'microphone', 'mic', 'input', 'default-input'].includes(normalized)) {
    return 'default-microphone';
  }
  if (['none', 'off', 'disabled'].includes(normalized)) {
    return 'none';
  }
  return 'selected-window';
}

function parseArgs(argv) {
  const stamp = Date.now();
  const args = {
    baseUrl: 'https://vdo.ninja/',
    streamId: `director_pub_${stamp}`,
    room: `director_room_${stamp}`,
    password: `director-pass-${stamp}`,
    label: 'director-room-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    audioSource: 'selected-window',
    source: 'spout',
    spoutSender: `Game Capture Control E2E ${stamp}`,
    spoutSenderPath: '',
    useTestSpoutSender: true,
    videoCodec: '',
    disableRoomLq: false,
    includeMicrophone: false,
    microphoneDeviceId: '',
    startupDelayMs: 7000,
    timeoutMs: 90000,
    disconnectTimeoutMs: 45000,
    holdMs: 3000,
    publisherDurationMs: 0,
    stopLifecycleOnly: false,
    verifyNaturalStop: false,
    previewBitrateKbps: 500,
    previewAudioBitrateKbps: 16,
    qualityHighBitrateKbps: 1200,
    audioRateLimitKbps: 32,
    targetBitrateKbps: 3500,
    requestWidth: 320,
    requestHeight: 180,
    publisherPath: '',
    artifactManifestPath: '',
    artifactManifestSha256: '',
    requirePackagedArtifact: false,
    expectedSpoutSenderSha256: '',
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../e2e/reports'),
    headful: false,
    browser: 'chromium',
    firefoxPath: '',
    expectedFirefoxSha256: '',
    strictNegotiation: false,
    remoteControlEnabled: true,
    remoteControlContract: ''
  };
  const explicitArgumentCounts = {
    publisherPath: 0,
    artifactManifestPath: 0,
    artifactManifestSha256: 0,
    spoutSenderPath: 0,
    expectedSpoutSenderSha256: 0,
    firefoxPath: 0,
    expectedFirefoxSha256: 0,
    browser: 0,
    requirePackagedArtifact: 0
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--stream=')) {
      args.streamId = arg.slice('--stream='.length);
    } else if (arg.startsWith('--room=')) {
      args.room = arg.slice('--room='.length);
    } else if (arg.startsWith('--password=')) {
      args.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--label=')) {
      args.label = arg.slice('--label='.length);
    } else if (arg.startsWith('--server=')) {
      args.server = arg.slice('--server='.length);
    } else if (arg.startsWith('--salt=')) {
      args.salt = arg.slice('--salt='.length);
    } else if (arg.startsWith('--audio-source=')) {
      args.audioSource = normalizeAudioSource(arg.slice('--audio-source='.length) || args.audioSource);
    } else if (arg.startsWith('--source=')) {
      args.source = arg.slice('--source='.length).trim().toLowerCase();
    } else if (arg.startsWith('--spout-sender=')) {
      args.spoutSender = arg.slice('--spout-sender='.length);
    } else if (arg === '--spout-sender-path') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.spoutSenderPath += 1;
      args.spoutSenderPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--spout-sender-path=')) {
      const value = arg.slice('--spout-sender-path='.length).trim();
      explicitArgumentCounts.spoutSenderPath += 1;
      args.spoutSenderPath = value ? path.resolve(value) : '';
    } else if (arg === '--expected-spout-sender-sha256') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.expectedSpoutSenderSha256 += 1;
      args.expectedSpoutSenderSha256 = value;
    } else if (arg.startsWith('--expected-spout-sender-sha256=')) {
      explicitArgumentCounts.expectedSpoutSenderSha256 += 1;
      args.expectedSpoutSenderSha256 = arg.slice('--expected-spout-sender-sha256='.length).trim();
    } else if (arg === '--no-test-spout-sender') {
      args.useTestSpoutSender = false;
    } else if (arg.startsWith('--video-codec=')) {
      args.videoCodec = arg.slice('--video-codec='.length).trim().toLowerCase();
    } else if (arg === '--disable-room-lq') {
      args.disableRoomLq = true;
    } else if (arg === '--include-microphone' || arg === '--include-mic') {
      args.includeMicrophone = true;
    } else if (arg.startsWith('--microphone-device=')) {
      args.microphoneDeviceId = arg.slice('--microphone-device='.length);
      args.includeMicrophone = true;
    } else if (arg.startsWith('--mic-device=')) {
      args.microphoneDeviceId = arg.slice('--mic-device='.length);
      args.includeMicrophone = true;
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs;
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs;
    } else if (arg.startsWith('--disconnect-timeout-ms=')) {
      args.disconnectTimeoutMs = Number(arg.slice('--disconnect-timeout-ms='.length)) || args.disconnectTimeoutMs;
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Number(arg.slice('--hold-ms='.length)) || args.holdMs;
    } else if (arg.startsWith('--publisher-duration-ms=')) {
      args.publisherDurationMs = Number(arg.slice('--publisher-duration-ms='.length)) || args.publisherDurationMs;
    } else if (arg.startsWith('--preview-bitrate-kbps=')) {
      args.previewBitrateKbps = Number(arg.slice('--preview-bitrate-kbps='.length)) || args.previewBitrateKbps;
    } else if (arg.startsWith('--preview-audio-bitrate-kbps=')) {
      args.previewAudioBitrateKbps = Number(arg.slice('--preview-audio-bitrate-kbps='.length)) || args.previewAudioBitrateKbps;
    } else if (arg.startsWith('--quality-high-bitrate-kbps=')) {
      args.qualityHighBitrateKbps = Number(arg.slice('--quality-high-bitrate-kbps='.length)) || args.qualityHighBitrateKbps;
    } else if (arg.startsWith('--audio-rate-limit-kbps=')) {
      args.audioRateLimitKbps = Number(arg.slice('--audio-rate-limit-kbps='.length)) || args.audioRateLimitKbps;
    } else if (arg.startsWith('--target-bitrate-kbps=')) {
      args.targetBitrateKbps = Number(arg.slice('--target-bitrate-kbps='.length)) || args.targetBitrateKbps;
    } else if (arg.startsWith('--request-resolution=')) {
      const match = /^(\d+)x(\d+)$/i.exec(arg.slice('--request-resolution='.length).trim());
      if (match) {
        args.requestWidth = Number(match[1]);
        args.requestHeight = Number(match[2]);
      }
    } else if (arg === '--publisher-path') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.publisherPath += 1;
      args.publisherPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--publisher-path=')) {
      const value = arg.slice('--publisher-path='.length).trim();
      explicitArgumentCounts.publisherPath += 1;
      args.publisherPath = value ? path.resolve(value) : '';
    } else if (arg === '--artifact-manifest-path') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.artifactManifestPath += 1;
      args.artifactManifestPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--artifact-manifest-path=')) {
      const value = arg.slice('--artifact-manifest-path='.length).trim();
      explicitArgumentCounts.artifactManifestPath += 1;
      args.artifactManifestPath = value ? path.resolve(value) : '';
    } else if (arg === '--artifact-manifest-sha256') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.artifactManifestSha256 += 1;
      args.artifactManifestSha256 = value;
    } else if (arg.startsWith('--artifact-manifest-sha256=')) {
      explicitArgumentCounts.artifactManifestSha256 += 1;
      args.artifactManifestSha256 = arg.slice('--artifact-manifest-sha256='.length).trim();
    } else if (arg === '--require-packaged-artifact') {
      explicitArgumentCounts.requirePackagedArtifact += 1;
      args.requirePackagedArtifact = true;
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    } else if (arg.startsWith('--browser=')) {
      explicitArgumentCounts.browser += 1;
      args.browser = arg.slice('--browser='.length).trim().toLowerCase();
    } else if (arg === '--firefox-path') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.firefoxPath += 1;
      args.firefoxPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--firefox-path=')) {
      const value = arg.slice('--firefox-path='.length).trim();
      explicitArgumentCounts.firefoxPath += 1;
      args.firefoxPath = value ? path.resolve(value) : '';
    } else if (arg === '--expected-firefox-sha256') {
      const value = typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')
        ? argv[++i].trim()
        : '';
      explicitArgumentCounts.expectedFirefoxSha256 += 1;
      args.expectedFirefoxSha256 = value;
    } else if (arg.startsWith('--expected-firefox-sha256=')) {
      explicitArgumentCounts.expectedFirefoxSha256 += 1;
      args.expectedFirefoxSha256 = arg.slice('--expected-firefox-sha256='.length).trim();
    } else if (arg === '--strict-negotiation') {
      args.strictNegotiation = true;
    } else if (arg.startsWith('--remote-control-contract=')) {
      args.remoteControlContract = arg.slice('--remote-control-contract='.length).trim().toLowerCase();
      if (!['disabled', 'enabled'].includes(args.remoteControlContract)) {
        throw new Error("--remote-control-contract must be 'disabled' or 'enabled'");
      }
      args.remoteControlEnabled = args.remoteControlContract === 'enabled';
    } else if (arg === '--disable-remote-control') {
      args.remoteControlEnabled = false;
    } else if (arg === '--enable-remote-control') {
      args.remoteControlEnabled = true;
    } else if (arg === '--stop-lifecycle-only') {
      args.stopLifecycleOnly = true;
      args.verifyNaturalStop = true;
    } else if (arg === '--verify-natural-stop') {
      args.verifyNaturalStop = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.baseUrl.endsWith('/')) {
    args.baseUrl += '/';
  }
  if (!['chromium', 'edge', 'firefox', 'firefox-installed'].includes(args.browser)) {
    throw new Error(
      `Unknown browser '${args.browser}'; expected chromium, edge, firefox, or firefox-installed`
    );
  }
  if (!['window', 'camera', 'spout'].includes(args.source)) {
    throw new Error(`Unknown source '${args.source}'; expected window, camera, or spout`);
  }
  for (const [name, count] of Object.entries(explicitArgumentCounts)) {
    if (count > 1) {
      const cliName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(`Exactly one explicit --${cliName} value is allowed`);
    }
  }
  const requireExactlyOne = (name, cliName) => {
    if (explicitArgumentCounts[name] !== 1 || !args[name]) {
      throw new Error(`Exactly one explicit --${cliName} value is required`);
    }
  };
  if (!args.requirePackagedArtifact && [
    'artifactManifestPath',
    'artifactManifestSha256',
    'expectedSpoutSenderSha256'
  ].some((name) => explicitArgumentCounts[name] !== 0)) {
    throw new Error(
      'Packaged artifact identity arguments require --require-packaged-artifact'
    );
  }
  if (args.requirePackagedArtifact) {
    for (const [name, cliName] of [
      ['publisherPath', 'publisher-path'],
      ['artifactManifestPath', 'artifact-manifest-path'],
      ['artifactManifestSha256', 'artifact-manifest-sha256'],
      ['spoutSenderPath', 'spout-sender-path'],
      ['expectedSpoutSenderSha256', 'expected-spout-sender-sha256']
    ]) {
      requireExactlyOne(name, cliName);
    }
    if (args.source !== 'spout' || !args.useTestSpoutSender) {
      throw new Error('Packaged Control Center validation requires the explicit Spout sender fixture');
    }
    if (!/^[0-9a-f]{64}$/.test(args.artifactManifestSha256)) {
      throw new Error('--artifact-manifest-sha256 must be exactly 64 lowercase hexadecimal characters');
    }
    if (!/^[0-9a-f]{64}$/.test(args.expectedSpoutSenderSha256)) {
      throw new Error('--expected-spout-sender-sha256 must be exactly 64 lowercase hexadecimal characters');
    }
  }
  if (args.browser === 'firefox-installed') {
    requireExactlyOne('firefoxPath', 'firefox-path');
    requireExactlyOne('expectedFirefoxSha256', 'expected-firefox-sha256');
    if (!/^[0-9a-f]{64}$/.test(args.expectedFirefoxSha256)) {
      throw new Error('--expected-firefox-sha256 must be exactly 64 lowercase hexadecimal characters');
    }
  } else if (explicitArgumentCounts.firefoxPath !== 0 ||
      explicitArgumentCounts.expectedFirefoxSha256 !== 0) {
    throw new Error(
      'Installed Firefox identity arguments require --browser=firefox-installed'
    );
  }
  args.audioSource = normalizeAudioSource(args.audioSource);
  return args;
}

async function launchDirectorBrowser(config, exactFirefoxArtifact = null) {
  if (config.browser === 'firefox-installed') {
    if (!exactFirefoxArtifact) {
      throw new Error('Installed Firefox launch requires a prepared exact artifact identity');
    }
    const beforeLaunch = revalidateExpectedFileArtifact(
      exactFirefoxArtifact,
      'Installed Firefox',
      'before launch'
    );
    let browser = null;
    try {
      browser = await launchInstalledFirefox({
        executablePath: beforeLaunch.path,
        expectedSha256: beforeLaunch.sha256,
        headless: !config.headful
      });
      const postLaunch = validateLaunchedFirefoxArtifact(browser, beforeLaunch);
      browser.artifactReceipt = Object.freeze({
        label: 'Installed Firefox',
        expected: exactFirefoxArtifact,
        beforeLaunch,
        postLaunch
      });
      return browser;
    } catch (error) {
      if (browser && typeof browser.close === 'function') {
        await browser.close().catch(() => {});
      }
      throw error;
    }
  }
  if (config.browser === 'firefox') {
    return firefox.launch({
      headless: !config.headful,
      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true
      }
    });
  }
  const options = {
    headless: !config.headful,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ]
  };
  if (config.browser === 'edge') {
    options.channel = 'msedge';
  }
  return chromium.launch(options);
}

function isFirefoxBrowser(browserName) {
  return browserName === 'firefox' || browserName === 'firefox-installed';
}

function negotiationRegressionState(publisher) {
  const output = `${publisher.stdoutText}\n${publisher.stderrText}`;
  const forbidden = [
    'Timed out waiting for initial local description',
    'Unexpected remote answer description in signaling state stable',
    'No matching peer for ICE restart',
    'PeerConnection state: failed',
    'Using stable default session ID'
  ];
  const matches = forbidden.filter((pattern) => output.includes(pattern));
  return {
    ok: matches.length === 0,
    state: {
      browser: publisher.browserName || '',
      matches,
      outputTail: output.split(/\r?\n/).slice(-100)
    }
  };
}

function detectQtPluginPath() {
  const candidates = [
    process.env.QT_PLUGIN_PATH,
    'C:/vcpkg/installed/x64-windows/Qt6/plugins',
    'C:/Users/Steve/code/obs-studio/.deps/obs-deps-qt6-2025-08-23-x64/plugins'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'platforms', 'qwindows.dll')) ||
        fs.existsSync(path.join(candidate, 'platforms', 'qoffscreen.dll'))) {
      return candidate;
    }
  }
  return '';
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function comparableRealPath(filePath) {
  const realPath = fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

function requireExplicitLeafFile(explicitPath, label) {
  const resolved = path.resolve(String(explicitPath || ''));
  if (!explicitPath || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${resolved}`);
  }
  return fs.realpathSync.native
    ? fs.realpathSync.native(resolved)
    : fs.realpathSync(resolved);
}

function validateExpectedFileArtifact(explicitPath, expectedSha256, label) {
  const normalizedExpectedSha256 = String(expectedSha256 || '').trim();
  if (!/^[0-9a-f]{64}$/.test(normalizedExpectedSha256)) {
    throw new Error(`${label} expected SHA-256 must be 64 lowercase hexadecimal characters`);
  }
  const resolved = requireExplicitLeafFile(explicitPath, label);
  const observedSha256 = sha256File(resolved);
  if (observedSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${normalizedExpectedSha256}, observed ${observedSha256}`
    );
  }
  const stat = fs.statSync(resolved);
  return Object.freeze({
    path: resolved,
    sha256: observedSha256,
    size: stat.size,
    modifiedUtc: stat.mtime.toISOString()
  });
}

function assertSameArtifactIdentity(expectedArtifact, observedArtifact, label, phase) {
  if (!expectedArtifact || !observedArtifact ||
      comparableRealPath(observedArtifact.path) !== comparableRealPath(expectedArtifact.path) ||
      observedArtifact.sha256 !== expectedArtifact.sha256 ||
      observedArtifact.size !== expectedArtifact.size) {
    throw new Error(`${label} identity changed ${phase}`);
  }
  return observedArtifact;
}

function revalidateExpectedFileArtifact(expectedArtifact, label, phase) {
  if (!expectedArtifact) {
    throw new Error(`${label} has no prepared exact artifact identity ${phase}`);
  }
  const observedArtifact = validateExpectedFileArtifact(
    expectedArtifact.path,
    expectedArtifact.sha256,
    label
  );
  return assertSameArtifactIdentity(expectedArtifact, observedArtifact, label, phase);
}

function validatePackagedPublisherArtifact(config) {
  if (!fs.existsSync(config.publisherPath) || !fs.statSync(config.publisherPath).isFile()) {
    throw new Error(`Explicit packaged publisher does not exist: ${config.publisherPath}`);
  }
  if (!fs.existsSync(config.artifactManifestPath) ||
      !fs.statSync(config.artifactManifestPath).isFile()) {
    throw new Error(`Explicit release artifact manifest does not exist: ${config.artifactManifestPath}`);
  }
  if (path.basename(config.artifactManifestPath) !== RELEASE_ARTIFACT_MANIFEST_FILENAME) {
    throw new Error(`Release artifact manifest must be named ${RELEASE_ARTIFACT_MANIFEST_FILENAME}`);
  }

  const manifestBytes = fs.readFileSync(config.artifactManifestPath);
  const manifestSha256 = sha256Buffer(manifestBytes);
  if (manifestSha256 !== config.artifactManifestSha256) {
    throw new Error(
      `Release artifact manifest SHA-256 mismatch: expected ${config.artifactManifestSha256}, observed ${manifestSha256}`
    );
  }
  if (manifestBytes.length >= 3 && manifestBytes[0] === 0xef &&
      manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
    throw new Error('Release artifact manifest must be UTF-8 without a byte-order mark');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Release artifact manifest is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release artifact manifest root must be an object');
  }
  if (manifest.schema !== RELEASE_ARTIFACT_MANIFEST_SCHEMA) {
    throw new Error(`Unexpected release artifact manifest schema: ${manifest.schema}`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Release artifact manifest version must be numeric semantic version text');
  }
  if (typeof manifest.packagedAtUtc !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(manifest.packagedAtUtc) ||
      !Number.isFinite(Date.parse(manifest.packagedAtUtc))) {
    throw new Error('Release artifact manifest packagedAtUtc must be an ISO-8601 UTC timestamp');
  }
  if (!manifest.artifact || typeof manifest.artifact !== 'object' ||
      manifest.artifact.relativePath !== 'game-capture.exe') {
    throw new Error('Release artifact manifest must bind artifact.relativePath exactly to game-capture.exe');
  }
  if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1) {
    throw new Error('Release artifact manifest artifact.size must be a positive safe integer');
  }
  if (typeof manifest.artifact.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)) {
    throw new Error('Release artifact manifest artifact.sha256 must be lowercase SHA-256');
  }
  if (!manifest.build || typeof manifest.build !== 'object' ||
      manifest.build.configuration !== 'Release') {
    throw new Error('Release artifact manifest build.configuration must be exactly Release');
  }
  if (!manifest.source || typeof manifest.source !== 'object') {
    throw new Error('Release artifact manifest source provenance is required');
  }
  if (typeof manifest.source.gitCommit !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.source.gitCommit)) {
    throw new Error('Release artifact manifest source.gitCommit must be a lowercase Git object id');
  }
  if (typeof manifest.source.dirty !== 'boolean') {
    throw new Error('Release artifact manifest source.dirty must be boolean');
  }
  if (typeof manifest.source.snapshotSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.source.snapshotSha256)) {
    throw new Error('Release artifact manifest source.snapshotSha256 must be lowercase SHA-256');
  }
  if (!Number.isSafeInteger(manifest.source.snapshotFileCount) ||
      manifest.source.snapshotFileCount < 1) {
    throw new Error('Release artifact manifest source.snapshotFileCount must be positive');
  }
  if (manifest.source.snapshotAlgorithm !== RELEASE_SOURCE_SNAPSHOT_ALGORITHM) {
    throw new Error('Release artifact manifest source.snapshotAlgorithm is unsupported');
  }

  const executable = fs.realpathSync.native
    ? fs.realpathSync.native(config.publisherPath)
    : fs.realpathSync(config.publisherPath);
  const manifestPath = fs.realpathSync.native
    ? fs.realpathSync.native(config.artifactManifestPath)
    : fs.realpathSync(config.artifactManifestPath);
  const manifestRelativeExecutable = path.resolve(
    path.dirname(manifestPath),
    manifest.artifact.relativePath
  );
  if (comparableRealPath(executable) !== comparableRealPath(manifestRelativeExecutable)) {
    throw new Error('Explicit publisher path does not exactly match the manifest-relative executable');
  }
  if (comparableRealPath(path.dirname(executable)) !== comparableRealPath(path.dirname(manifestPath))) {
    throw new Error('Release artifact manifest must be co-located with the packaged publisher');
  }

  const executableBytes = fs.readFileSync(executable);
  const executableSha256 = sha256Buffer(executableBytes);
  if (executableBytes.length !== manifest.artifact.size) {
    throw new Error(
      `Packaged publisher size mismatch: manifest ${manifest.artifact.size}, observed ${executableBytes.length}`
    );
  }
  if (executableSha256 !== manifest.artifact.sha256) {
    throw new Error(
      `Packaged publisher SHA-256 mismatch: manifest ${manifest.artifact.sha256}, observed ${executableSha256}`
    );
  }

  const executableStat = fs.statSync(executable);
  const manifestStat = fs.statSync(manifestPath);
  return Object.freeze({
    executable,
    path: executable,
    sha256: executableSha256,
    size: executableStat.size,
    modifiedUtc: executableStat.mtime.toISOString(),
    manifestPath,
    manifestSha256,
    manifestSize: manifestStat.size,
    manifestModifiedUtc: manifestStat.mtime.toISOString(),
    manifest
  });
}

function revalidatePackagedPublisherArtifact(config, expectedArtifact, phase) {
  if (!expectedArtifact) {
    throw new Error(`Packaged publisher has no prepared exact artifact identity ${phase}`);
  }
  const observedArtifact = validatePackagedPublisherArtifact(config);
  assertSameArtifactIdentity(expectedArtifact, observedArtifact, 'Packaged publisher', phase);
  if (comparableRealPath(observedArtifact.manifestPath) !==
        comparableRealPath(expectedArtifact.manifestPath) ||
      observedArtifact.manifestSha256 !== expectedArtifact.manifestSha256 ||
      observedArtifact.manifestSize !== expectedArtifact.manifestSize) {
    throw new Error(`Release artifact manifest identity changed ${phase}`);
  }
  return observedArtifact;
}

function prepareDirectorArtifacts(config) {
  const packagedArtifact = config.requirePackagedArtifact
    ? validatePackagedPublisherArtifact(config)
    : null;
  const spoutSender = config.requirePackagedArtifact
    ? validateExpectedFileArtifact(
      config.spoutSenderPath,
      config.expectedSpoutSenderSha256,
      'Packaged Spout sender fixture'
    )
    : null;
  const firefox = config.browser === 'firefox-installed'
    ? validateExpectedFileArtifact(
      config.firefoxPath,
      config.expectedFirefoxSha256,
      'Installed Firefox'
    )
    : null;
  return { packagedArtifact, spoutSender, firefox };
}

function validateLaunchedFirefoxArtifact(browser, expectedArtifact) {
  if (!expectedArtifact) {
    throw new Error('Installed Firefox launch has no expected artifact identity');
  }
  if (!browser || typeof browser.executablePath !== 'string' ||
      typeof browser.executableSha256 !== 'string') {
    throw new Error('Installed Firefox launch did not report an executable identity');
  }
  const observedArtifact = validateExpectedFileArtifact(
    browser.executablePath,
    expectedArtifact.sha256,
    'Launched installed Firefox'
  );
  if (comparableRealPath(observedArtifact.path) !== comparableRealPath(expectedArtifact.path) ||
      browser.executableSha256 !== observedArtifact.sha256) {
    throw new Error(
      'Launched Firefox path/SHA-256 does not match the prevalidated installed executable'
    );
  }
  return observedArtifact;
}

function detectSpoutTestSender(explicitPath) {
  if (explicitPath) {
    return requireExplicitLeafFile(explicitPath, 'Explicit Spout test sender');
  }
  return [
    path.resolve(__dirname, '../build-review2/bin/Release/spout_test_sender.exe'),
    path.resolve(__dirname, '../build-test/bin/spout_test_sender.exe'),
    path.resolve(__dirname, '../build/bin/Release/spout_test_sender.exe')
  ].find((candidate) => fs.existsSync(candidate)) || '';
}

function publisherDurationMs(config) {
  return config.publisherDurationMs > 0
    ? config.publisherDurationMs
    : Math.max(180000, config.startupDelayMs + config.timeoutMs + config.holdMs + 30000);
}

function terminateSpawnedChild(child) {
  if (child && typeof child.kill === 'function' &&
      child.exitCode === null && child.signalCode === null && !child.killed) {
    child.kill('SIGKILL');
  }
}

function attachChildProcessErrorGuard(child, label) {
  if (!child || typeof child.on !== 'function') {
    throw new Error(`${label} did not return an observable child process`);
  }
  let observedError = null;
  let resolveFailure = null;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const guard = Object.freeze({
    failure,
    get error() {
      return observedError;
    }
  });
  child.on('error', (cause) => {
    if (observedError) return;
    observedError = new Error(
      `${label} process error: ${cause && cause.message ? cause.message : String(cause)}`,
      { cause }
    );
    terminateSpawnedChild(child);
    resolveFailure(observedError);
  });
  child.workflowErrorGuard = guard;
  return guard;
}

function runtimeProcessErrorGuards(runtimeArtifacts) {
  return [
    runtimeArtifacts && runtimeArtifacts.sourceFixture,
    runtimeArtifacts && runtimeArtifacts.publisher,
    runtimeArtifacts && runtimeArtifacts.browser
  ]
    .map((artifact) => artifact && artifact.workflowErrorGuard)
    .filter(Boolean);
}

function assertNoRuntimeProcessFailure(runtimeArtifacts) {
  for (const guard of runtimeProcessErrorGuards(runtimeArtifacts)) {
    if (guard.error) throw guard.error;
  }
}

async function awaitWithRuntimeProcessFailures(operation, runtimeArtifacts) {
  assertNoRuntimeProcessFailure(runtimeArtifacts);
  const operationPromise = typeof operation === 'function'
    ? Promise.resolve().then(operation)
    : Promise.resolve(operation);
  const guardedFailures = runtimeProcessErrorGuards(runtimeArtifacts)
    .map((guard) => guard.failure.then((error) => { throw error; }));
  const result = await Promise.race([operationPromise, ...guardedFailures]);
  assertNoRuntimeProcessFailure(runtimeArtifacts);
  return result;
}

async function stopAdmittedChild(child, gracefulSignal, graceMs, forcedWaitMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.killed) child.kill(gracefulSignal);
  if (graceMs > 0) await waitForProcessExit(child, graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForProcessExit(child, forcedWaitMs);
  }
  if (child.exitCode === null && child.signalCode === null && Number.isInteger(child.pid)) {
    throw new Error(`Child process ${child.pid} did not terminate after SIGKILL`);
  }
}

async function cleanupDirectorRuntime(runtimeArtifacts, options = {}) {
  const browser = runtimeArtifacts && runtimeArtifacts.browser;
  const publisher = runtimeArtifacts && runtimeArtifacts.publisher;
  const sourceFixture = runtimeArtifacts && runtimeArtifacts.sourceFixture;
  const cleanupErrors = [];
  if (browser && typeof browser.close === 'function') {
    try {
      await browser.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await stopAdmittedChild(publisher, 'SIGTERM', options.publisherGraceMs ?? 1000);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await stopAdmittedChild(sourceFixture, 'SIGTERM', options.sourceFixtureGraceMs ?? 500);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Director runtime cleanup failed');
  }
}

function createArtifactLaunchReceipt(label, expected, beforeSpawn, afterSpawn) {
  return Object.freeze({
    label,
    expected,
    beforeSpawn,
    afterSpawn
  });
}

function spawnSpoutTestSender(config, exactArtifact = null) {
  if (config.source !== 'spout' || !config.useTestSpoutSender) {
    return null;
  }
  let beforeSpawn = null;
  let command = '';
  if (config.requirePackagedArtifact) {
    if (!exactArtifact) {
      throw new Error('Packaged Spout sender launch requires a prepared exact artifact identity');
    }
    beforeSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'before spawn');
    command = beforeSpawn.path;
  } else {
    command = detectSpoutTestSender(config.spoutSenderPath);
  }
  if (!command) {
    throw new Error('A deterministic spout_test_sender.exe is required for Control Center E2E');
  }
  const args = [
    `--name=${config.spoutSender}`,
    '--width=1280',
    '--height=720',
    '--fps=30',
    '--pattern=animated',
    `--duration-ms=${publisherDurationMs(config) + 30000}`
  ];
  const child = spawn(command, args, {
    cwd: path.dirname(command),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  attachChildProcessErrorGuard(child, 'Packaged Spout sender fixture');
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString(); });
  child.command = command;
  child.args = args;
  if (beforeSpawn) {
    try {
      const afterSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'after spawn');
      child.artifactReceipt = createArtifactLaunchReceipt(
        'Packaged Spout sender fixture',
        exactArtifact,
        beforeSpawn,
        afterSpawn
      );
    } catch (error) {
      terminateSpawnedChild(child);
      throw error;
    }
  }
  return child;
}

function detectPublisherBinary(explicitPath) {
  if (explicitPath) {
    return requireExplicitLeafFile(explicitPath, 'Explicit game-capture publisher');
  }

  const distDir = path.resolve(__dirname, '../dist');
  if (fs.existsSync(distDir)) {
    const packaged = fs.readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^game-capture-\d+\.\d+\.\d+-win64$/i.test(entry.name))
      .map((entry) => {
        const executable = path.join(distDir, entry.name, 'game-capture.exe');
        return fs.existsSync(executable)
          ? { executable, modified: fs.statSync(executable).mtimeMs }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified)
      .map((entry) => entry.executable)[0];
    if (packaged) {
      return packaged;
    }
  }

  const candidates = [
    path.resolve(__dirname, '../build-review2/bin/Release/game-capture.exe'),
    path.resolve(__dirname, '../build/bin/Release/game-capture.exe')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function buildDirectorUrl(config) {
  const query = new URLSearchParams();
  query.set('director', config.room);
  query.set('password', config.password);
  query.set('cleandirector', '');
  return `${config.baseUrl}?${query.toString()}`;
}

function spawnPublisher(config, exactArtifact = null) {
  let beforeSpawn = null;
  let command = '';
  if (config.requirePackagedArtifact) {
    if (!exactArtifact) {
      throw new Error('Packaged publisher launch requires a prepared exact artifact identity');
    }
    beforeSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'before publisher spawn');
    command = beforeSpawn.executable;
  } else {
    command = detectPublisherBinary(config.publisherPath);
  }
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build Release first or pass --publisher-path.');
  }

  const durationMs = publisherDurationMs(config);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--room=${config.room}`,
    `--password=${config.password}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    `--audio-source=${config.audioSource}`
  ];
  if (config.remoteControlEnabled) {
    args.push('--remote-control', '--remote-token=control-token');
  }
  args.push(`--source=${config.source}`);
  if (config.source === 'spout' && config.spoutSender) {
    args.push(`--spout-sender=${config.spoutSender}`);
  }
  if (config.includeMicrophone) {
    args.push('--include-microphone');
  }
  if (config.microphoneDeviceId) {
    args.push(`--microphone-device=${config.microphoneDeviceId}`);
  }
  if (config.videoCodec) {
    args.push(`--video-codec=${config.videoCodec}`);
  }
  if (config.disableRoomLq) {
    args.push('--disable-room-lq');
  }

  const env = { ...process.env };
  const qtPluginPath = detectQtPluginPath();
  if (qtPluginPath) {
    env.QT_PLUGIN_PATH = qtPluginPath;
  }
  env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ||
    (qtPluginPath && fs.existsSync(path.join(qtPluginPath, 'platforms', 'qoffscreen.dll'))
      ? 'offscreen'
      : 'windows');

  const child = spawn(command, args, {
    cwd: path.dirname(command),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  attachChildProcessErrorGuard(child, 'Packaged publisher');
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString(); });
  child.command = command;
  child.args = args;
  if (beforeSpawn) {
    try {
      const afterSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'after publisher spawn');
      child.artifactReceipt = createArtifactLaunchReceipt(
        'Packaged publisher',
        exactArtifact,
        beforeSpawn,
        afterSpawn
      );
    } catch (error) {
      terminateSpawnedChild(child);
      throw error;
    }
  }
  return child;
}

async function collectDirectorState(page, streamId) {
  return page.evaluate((expectedStreamId) => {
    const sessionObj = window.session || {};
    const rpcIds = Object.keys(sessionObj.rpcs || {});
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      id: video.id,
      sid: video.dataset.sid || '',
      uuid: video.dataset.UUID || '',
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended
    }));
    const decodedVideo = videos.find((video) =>
      video.sid === expectedStreamId &&
      video.readyState >= 2 &&
      video.width > 0 &&
      video.height > 0 &&
      video.currentTime > 0 &&
      !video.ended
    ) || null;
    const rpcs = {};
    for (const uuid of rpcIds) {
      const rpc = sessionObj.rpcs[uuid];
      rpcs[uuid] = {
        streamID: rpc && rpc.streamID,
        statsInfo: rpc && rpc.stats && rpc.stats.info ? rpc.stats.info : null,
        allowGraphs: rpc ? rpc.allowGraphs : null,
        videoElement: !!(rpc && rpc.videoElement)
      };
    }
    return {
      href: location.href,
      director: sessionObj.director,
      roomid: sessionObj.roomid,
      rpcIds,
      videos,
      decodedVideo,
      rpcs,
      bodyText: document.body ? document.body.innerText.slice(0, 800) : ''
    };
  }, streamId);
}

async function collectBlockingUiState(page) {
  return page.evaluate(() => {
    const selectors = [
      '.alertModal',
      '.promptModal',
      '[role="dialog"]',
      '[aria-modal="true"]'
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
    const blockers = candidates.flatMap((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = !element.hidden &&
        !element.classList.contains('hidden') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 1 && rect.height > 1;
      if (!visible) {
        return [];
      }
      return [{
        tag: element.tagName,
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className : '',
        role: element.getAttribute('role') || '',
        ariaModal: element.getAttribute('aria-modal') || '',
        text: String(element.innerText || element.textContent || '').trim().slice(0, 500),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      }];
    });
    return { ok: blockers.length === 0, blockers };
  });
}

async function waitForAndDismissUnsupportedAlert(page, timeoutMs, required = true) {
  const modal = page.locator('.alertModal:visible').last();
  try {
    await modal.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return required
      ? { ok: false, stage: 'unsupported-alert-not-visible' }
      : { ok: true, state: { visible: false } };
  }
  const text = String(await modal.innerText()).trim();
  if (!/request failed|did not recognize you as the director/i.test(text)) {
    return { ok: false, stage: 'unexpected-alert', state: { text } };
  }
  const close = modal.locator('.modalClose, .close, button, [role="button"]').first();
  if (await close.count() === 0) {
    return { ok: false, stage: 'unsupported-alert-has-no-close-control', state: { text } };
  }
  await close.click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
  return { ok: true, state: { visible: true, text } };
}

async function settleUnsupportedAlerts(page, settleMs = 6000) {
  const deadline = Date.now() + settleMs;
  const dismissed = [];
  while (Date.now() < deadline) {
    const result = await waitForAndDismissUnsupportedAlert(
      page,
      Math.min(500, Math.max(1, deadline - Date.now())),
      false
    );
    if (!result.ok) return result;
    if (result.state && result.state.visible) dismissed.push(result.state.text);
    await wait(100);
  }
  const blockingUi = await collectBlockingUiState(page);
  return {
    ok: blockingUi.ok,
    state: { dismissedCount: dismissed.length, dismissed, blockingUi }
  };
}

async function waitForDirectorPeer(page, config) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < config.timeoutMs) {
    last = await collectDirectorState(page, config.streamId);
    const uuid = last.rpcIds.find((id) => last.rpcs[id] && last.rpcs[id].streamID === config.streamId);
    if (last.director === true && uuid) {
      return { ok: true, uuid, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'director-peer', state: last };
}

async function waitForDecodedDirectorVideo(page, config) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < config.timeoutMs) {
    last = await collectDirectorState(page, config.streamId);
    if (last.decodedVideo) {
      return { ok: true, state: last };
    }
    await wait(1000);
  }
  return { ok: false, stage: 'director-decoded-video', state: last };
}

async function readDirectorMediaProgress(page, uuid, streamId) {
  const video = await page.evaluate(({ peerUuid, expectedStreamId }) => {
    const candidates = Array.from(document.querySelectorAll('video'));
    const element = candidates.find((candidate) =>
      candidate.dataset.sid === expectedStreamId ||
      candidate.dataset.UUID === peerUuid ||
      candidate.id === `videosource_${peerUuid}`
    ) || null;
    if (!element) {
      return null;
    }
    return {
      id: element.id || '',
      sid: element.dataset.sid || '',
      uuid: element.dataset.UUID || '',
      readyState: element.readyState,
      currentTime: Number(element.currentTime || 0),
      width: element.videoWidth,
      height: element.videoHeight,
      paused: element.paused,
      ended: element.ended
    };
  }, { peerUuid: uuid, expectedStreamId: streamId });
  const stats = await readInboundVideoStats(page, uuid);
  return {
    ok: !!video && video.readyState >= 2 && video.width > 0 && video.height > 0 &&
      !video.ended && stats && stats.ok,
    video,
    framesDecoded: Number(stats && stats.framesDecoded || 0),
    bytesReceived: Number(stats && stats.bytesReceived || 0),
    packetsReceived: Number(stats && stats.packetsReceived || 0),
    stats: stats && stats.stats ? stats.stats : []
  };
}

async function waitForFreshDirectorMedia(page, uuid, config, baseline, timeoutMs) {
  if (!baseline || !baseline.ok || !baseline.video) {
    return { ok: false, stage: 'invalid-media-baseline', state: { baseline } };
  }

  const start = Date.now();
  let current = null;
  while (Date.now() - start < timeoutMs) {
    current = await readDirectorMediaProgress(page, uuid, config.streamId);
    const videoTimeDelta = current && current.video
      ? Number(current.video.currentTime || 0) - Number(baseline.video.currentTime || 0)
      : 0;
    const frameDelta = Number(current && current.framesDecoded || 0) - Number(baseline.framesDecoded || 0);
    const byteDelta = Number(current && current.bytesReceived || 0) - Number(baseline.bytesReceived || 0);
    if (current && current.ok && videoTimeDelta > 0.05 && frameDelta > 0 && byteDelta > 0) {
      return {
        ok: true,
        state: { baseline, current, deltas: { videoTime: videoTimeDelta, framesDecoded: frameDelta, bytesReceived: byteDelta } }
      };
    }
    await wait(250);
  }
  return {
    ok: false,
    stage: 'fresh-director-media',
    state: {
      baseline,
      current,
      deltas: {
        videoTime: current && current.video
          ? Number(current.video.currentTime || 0) - Number(baseline.video.currentTime || 0)
          : 0,
        framesDecoded: Number(current && current.framesDecoded || 0) - Number(baseline.framesDecoded || 0),
        bytesReceived: Number(current && current.bytesReceived || 0) - Number(baseline.bytesReceived || 0)
      }
    }
  };
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      ok: child.exitCode === 0,
      exitCode: child.exitCode,
      signalCode: child.signalCode
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        exitCode: child.exitCode,
        signalCode: child.signalCode
      });
    }, timeoutMs);

    const onExit = (code, signal) => {
      cleanup();
      resolve({
        ok: code === 0,
        exitCode: code,
        signalCode: signal
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };

    child.on('exit', onExit);
  });
}

async function collectDirectorDisconnectState(page, uuid, streamId) {
  return page.evaluate(({ peerUuid, expectedStreamId }) => {
    const sessionObj = window.session || {};
    const rpc = sessionObj.rpcs && sessionObj.rpcs[peerUuid] ? sessionObj.rpcs[peerUuid] : null;
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      id: video.id,
      sid: video.dataset.sid || '',
      uuid: video.dataset.UUID || '',
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended
    }));
    const streamVideo = videos.find((video) =>
      video.sid === expectedStreamId || video.uuid === peerUuid || video.id === `videosource_${peerUuid}`
    ) || null;
    const decoded = streamVideo &&
      streamVideo.readyState >= 2 &&
      streamVideo.width > 0 &&
      streamVideo.height > 0 &&
      !streamVideo.ended;
    const container = document.getElementById(`container_${peerUuid}`);
    return {
      rpcExists: !!rpc,
      connectionState: rpc ? rpc.connectionState || '' : '',
      iceConnectionState: rpc ? rpc.iceConnectionState || '' : '',
      signalingState: rpc ? rpc.signalingState || '' : '',
      containerExists: !!container,
      streamVideo,
      decoded,
      videos
    };
  }, { peerUuid: uuid, expectedStreamId: streamId });
}

async function waitForDirectorPublisherStopped(page, uuid, config) {
  const start = Date.now();
  let last = null;
  let stillSince = 0;
  let previousVideoTime = null;

  while (Date.now() - start < config.disconnectTimeoutMs) {
    last = await collectDirectorDisconnectState(page, uuid, config.streamId);
    const state = String(last.connectionState || '').toLowerCase();
    const iceState = String(last.iceConnectionState || '').toLowerCase();
    const videoTime = last.streamVideo ? Number(last.streamVideo.currentTime || 0) : null;
    const videoAdvancing = previousVideoTime !== null &&
      videoTime !== null &&
      videoTime > previousVideoTime + 0.05;
    previousVideoTime = videoTime;

    if (!last.rpcExists && !last.streamVideo && !last.containerExists) {
      return { ok: true, state: last };
    }

    const peerNotConnected =
      !last.rpcExists ||
      ['closed', 'failed', 'disconnected'].includes(state) ||
      ['closed', 'failed', 'disconnected'].includes(iceState);

    if (peerNotConnected && !videoAdvancing) {
      if (stillSince === 0) {
        stillSince = Date.now();
      }
      if (Date.now() - stillSince >= 2500) {
        return { ok: true, state: last };
      }
    } else {
      stillSince = 0;
    }

    await wait(500);
  }
  return { ok: false, stage: 'director-publisher-stopped', state: last };
}

async function installMessageProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', uuid: peerUuid };
    }

    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__directorRoomE2EProbe || { messages: [] };
    if (!Array.isArray(probe.messages)) {
      probe.messages = [];
    }
    window.__directorRoomE2EProbe = probe;

    const parseMessage = (event, channelName) => {
      if (!event || typeof event.data !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        probe.messages.push({ ts: Date.now(), channel: channelName, message: parsed });
        if (probe.messages.length > 200) {
          probe.messages.shift();
        }
      } catch {
        // Ignore non-JSON VDO messages.
      }
    };

    const attach = (channel, channelName) => {
      if (!channel) {
        return false;
      }
      if (channel.__directorRoomE2EProbeAttached) {
        return true;
      }
      channel.__directorRoomE2EProbeAttached = true;
      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('message', (event) => parseMessage(event, channelName));
        return true;
      }
      const previous = channel.onmessage;
      channel.onmessage = (event) => {
        parseMessage(event, channelName);
        if (typeof previous === 'function') {
          return previous.call(channel, event);
        }
        return undefined;
      };
      return true;
    };

    return {
      ok: attach(rpc.receiveChannel, 'receiveChannel') || attach(rpc.sendChannel, 'sendChannel')
    };
  }, uuid);
}

async function waitForProbeMessage(page, predicateSource, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ source, minCount }) => {
      const predicate = new Function('entry', `return (${source})(entry);`);
      const probe = window.__directorRoomE2EProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const match = messages.slice(Math.max(0, minCount)).find((entry) => {
        try {
          return predicate(entry);
        } catch {
          return false;
        }
      }) || null;
      return {
        count: messages.length,
        latest: messages.length ? messages[messages.length - 1] : null,
        match
      };
    }, { source: predicateSource, minCount: minMessageCount });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'probe-message', state: last };
}

async function getDirectorProbeMessageCount(page) {
  return page.evaluate(() => {
    const probe = window.__directorRoomE2EProbe || { messages: [] };
    const messages = Array.isArray(probe.messages) ? probe.messages : [];
    return messages.length;
  });
}

async function waitForDirectorSettingsPayload(page, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((minCount) => {
      const probe = window.__directorRoomE2EProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const audioOptions = candidates.find((entry) =>
        entry && entry.message && Array.isArray(entry.message.audioOptions)) || null;
      const videoOptions = candidates.find((entry) =>
        entry && entry.message && entry.message.videoOptions &&
        typeof entry.message.videoOptions === 'object') || null;
      const mediaDevices = candidates.find((entry) =>
        entry && entry.message && Array.isArray(entry.message.mediaDevices)) || null;
      return {
        count: messages.length,
        latest: messages.length ? messages[messages.length - 1] : null,
        audioOptions,
        videoOptions,
        mediaDevices,
        ok: !!audioOptions && !!videoOptions && !!mediaDevices
      };
    }, minMessageCount);
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'director-settings-payload', state: last };
}

async function waitForDirectorVideoOptionsDimensions(page, expectedWidth, expectedHeight, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ width, height, minCount }) => {
      const probe = window.__directorRoomE2EProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const match = candidates.find((entry) => {
        const options = entry && entry.message ? entry.message.videoOptions : null;
        const current = options && options.currentCameraConstraints;
        if (!current) {
          return false;
        }
        const currentWidth = Number(current.width);
        const currentHeight = Number(current.height);
        const requestedWidth = Number(width);
        const requestedHeight = Number(height);
        if (!(currentWidth > 0) || !(currentHeight > 0) ||
            currentWidth > requestedWidth || currentHeight > requestedHeight) {
          return false;
        }

        // VDO.Ninja's authoritative setResolution implementation treats the
        // requested rectangle as a scale-to-fit bound and preserves the source
        // aspect ratio. One dimension should therefore meet the requested
        // bound while the other can be smaller (with even-pixel rounding).
        return Math.abs(currentWidth - requestedWidth) <= 2 ||
          Math.abs(currentHeight - requestedHeight) <= 2;
      }) || null;
      return {
        count: messages.length,
        latest: messages.length ? messages[messages.length - 1] : null,
        match
      };
    }, {
      width: expectedWidth,
      height: expectedHeight,
      minCount: minMessageCount
    });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'director-video-options-dimensions', state: last };
}

async function waitForStatsInfo(page, uuid, predicateSource, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ peerUuid, source }) => {
      const predicate = new Function('info', `return (${source})(info);`);
      const rpc = window.session && window.session.rpcs ? window.session.rpcs[peerUuid] : null;
      const info = rpc && rpc.stats && rpc.stats.info ? rpc.stats.info : null;
      let ok = false;
      if (info) {
        try {
          ok = !!predicate(info);
        } catch {
          ok = false;
        }
      }
      return { ok, info };
    }, { peerUuid: uuid, source: predicateSource });
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'stats-info', state: last };
}

async function sendDirectorRequest(page, uuid, payload) {
  return page.evaluate(({ peerUuid, message }) => {
    if (!window.session || typeof window.session.sendRequest !== 'function') {
      return { ok: false, reason: 'no_sendRequest' };
    }
    const sent = window.session.sendRequest(message, peerUuid);
    return { ok: sent !== false, sent, payload: message };
  }, {
    peerUuid: uuid,
    message: payload
  });
}

function cssAttributeSelector(name, value) {
  return `[${name}=${JSON.stringify(String(value))}]`;
}

async function clickDirectorQualityButton(page, uuid, actionType) {
  const container = page.locator(cssAttributeSelector('id', `container_${uuid}`));
  if (await container.count() !== 1) {
    return { ok: false, reason: 'no_unique_container', uuid, count: await container.count() };
  }
  const button = container.locator(`${cssAttributeSelector('data-action-type', actionType)}:visible`);
  if (await button.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_quality_button', action: actionType, count: await button.count() };
  }
  try {
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 10000 });
    return await button.evaluate((element, action) => ({
      ok: true,
      action,
      pressed: element.classList.contains('pressed'),
      ariaPressed: element.getAttribute('aria-pressed') || ''
    }), actionType);
  } catch (error) {
    return {
      ok: false,
      reason: 'quality_button_not_actionable',
      action: actionType,
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function applyVdoPreviewRate(page, uuid, config) {
  return page.evaluate(({ peerUuid, bitrate }) => {
    if (!window.session || typeof window.session.requestRateLimit !== 'function') {
      return { ok: false, reason: 'no_requestRateLimit' };
    }
    window.session.requestRateLimit(bitrate, peerUuid, true, false);
    return { ok: true };
  }, {
    peerUuid: uuid,
    bitrate: config.previewBitrateKbps
  });
}

async function requestVdoAudioRate(page, uuid, bitrateKbps) {
  return page.evaluate(({ peerUuid, bitrate }) => {
    if (!window.session || typeof window.session.requestAudioRateLimit !== 'function') {
      return { ok: false, reason: 'no_requestAudioRateLimit' };
    }
    const sent = window.session.requestAudioRateLimit(bitrate, peerUuid, false);
    return { ok: sent !== false, sent };
  }, {
    peerUuid: uuid,
    bitrate: bitrateKbps
  });
}

async function requestVdoResolution(page, uuid, config) {
  return page.evaluate(({ peerUuid, width, height }) => {
    if (!window.session || typeof window.session.requestResolution !== 'function') {
      return { ok: false, reason: 'no_requestResolution' };
    }
    window.session.requestResolution(peerUuid, width, height);
    return { ok: true };
  }, {
    peerUuid: uuid,
    width: config.requestWidth,
    height: config.requestHeight
  });
}

async function requestVdoKeyframe(page, uuid) {
  return page.evaluate((peerUuid) => {
    if (window.session && typeof window.session.requestKeyframe === 'function') {
      window.session.requestKeyframe(peerUuid);
      return { ok: true, method: 'requestKeyframe' };
    }
    if (window.session && typeof window.session.sendRequest === 'function') {
      const sent = window.session.sendRequest({ keyframe: true }, peerUuid);
      return { ok: sent !== false, method: 'sendRequest', sent };
    }
    return { ok: false, reason: 'no_keyframe_request' };
  }, uuid);
}

async function clickSceneStatsButton(page, uuid) {
  const container = page.locator(cssAttributeSelector('id', `container_${uuid}`));
  if (await container.count() !== 1) {
    return { ok: false, reason: 'no_unique_container', uuid, count: await container.count() };
  }
  let button = container.locator(`${cssAttributeSelector('data-action-type', 'stats-remote')}:visible`);
  let expandedSceneOptions = false;
  if (await button.count() === 0) {
    const sceneOptions = container.getByRole('button', { name: /scene options/i }).filter({ visible: true });
    if (await sceneOptions.count() !== 1) {
      return { ok: false, reason: 'no_unique_visible_scene_options_button', count: await sceneOptions.count() };
    }
    try {
      await sceneOptions.scrollIntoViewIfNeeded();
      await sceneOptions.click({ timeout: 10000 });
      expandedSceneOptions = true;
      button = container.locator(`${cssAttributeSelector('data-action-type', 'stats-remote')}:visible`);
    } catch (error) {
      return {
        ok: false,
        reason: 'scene_options_button_not_actionable',
        message: error && error.message ? error.message : String(error)
      };
    }
  }
  if (await button.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_stats_button', count: await button.count() };
  }
  try {
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 10000 });
    return { ok: true, expandedSceneOptions };
  } catch (error) {
    return {
      ok: false,
      reason: 'stats_button_not_actionable',
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function waitForSceneStatsUi(page, uuid, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((peerUuid) => {
      const container = document.getElementById(`container_${peerUuid}`);
      if (!container) {
        return { ok: false, reason: 'no_container' };
      }
      const requesting = Array.from(container.querySelectorAll('[data-no-scenes][data-message]'))
        .some((element) => /Requesting data/i.test(element.textContent || '') && !element.classList.contains('hidden'));
      const detailContainers = Array.from(container.querySelectorAll('[data-action-type="stats-graphs-details-container"][data-uid]'));
      const details = detailContainers.map((detail) => ({
        uid: detail.dataset.uid || '',
        hidden: detail.classList.contains('hidden'),
        bitrate: detail.querySelector('[data-bitrate]') ? detail.querySelector('[data-bitrate]').textContent.trim() : '',
        resolution: detail.querySelector('[data-resolution]') ? detail.querySelector('[data-resolution]').textContent.trim() : '',
        encoder: detail.querySelector('[data-video-codec]') ? detail.querySelector('[data-video-codec]').textContent.trim() : ''
      }));
      const populated = details.find((detail) =>
        !detail.hidden &&
        /video bitrate:\s*\d+/i.test(detail.bitrate) &&
        /\d+\s*x\s*\d+/i.test(detail.resolution) &&
        /video codec:/i.test(detail.encoder)
      ) || null;
      return { ok: !!populated && !requesting, requesting, details, populated };
    }, uuid);
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'scene-stats-ui', state: last };
}

async function clickStatsBitrateControl(page, uuid, targetBitrateKbps) {
  const container = page.locator(cssAttributeSelector('id', `container_${uuid}`));
  if (await container.count() !== 1) {
    return { ok: false, reason: 'no_unique_container', uuid, count: await container.count() };
  }
  const bitrateSpan = container.locator(
    `${cssAttributeSelector('data-action-type', 'stats-graphs-details-container')}[data-uid]:not(.hidden) [data-bitrate]:visible`
  );
  if (await bitrateSpan.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_bitrate_span', count: await bitrateSpan.count() };
  }
  try {
    await bitrateSpan.scrollIntoViewIfNeeded();
    await bitrateSpan.click({ timeout: 10000 });
    const modal = page.locator('.promptModal:visible');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    if (await modal.count() !== 1) {
      return { ok: false, reason: 'no_unique_visible_bitrate_prompt', count: await modal.count() };
    }
    const select = modal.locator('select:visible');
    if (await select.count() === 1) {
      const options = await select.locator('option').evaluateAll((elements) =>
        elements.map((element) => ({ value: element.value, label: element.textContent || '' })));
      const exact = options.find((option) => option.value === String(targetBitrateKbps));
      if (exact) {
        await select.selectOption(exact.value);
      } else {
        const custom = options.find((option) => /custom/i.test(option.value) || /custom/i.test(option.label));
        if (!custom) {
          return { ok: false, reason: 'bitrate_prompt_has_no_custom_option', options };
        }
        await select.selectOption(custom.value);
        const input = modal.locator('input:not([type="checkbox"]):visible').first();
        await input.waitFor({ state: 'visible', timeout: 10000 });
        await input.fill(String(targetBitrateKbps), { timeout: 10000 });
      }
    } else {
      const input = modal.locator('input:not([type="checkbox"]):visible').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.fill(String(targetBitrateKbps), { timeout: 10000 });
    }
    const submit = modal.locator('button[id^="submit_"]:visible');
    if (await submit.count() !== 1) {
      return { ok: false, reason: 'no_unique_visible_bitrate_prompt_submit', count: await submit.count() };
    }
    await submit.click({ timeout: 10000 });
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    const unsupportedAlert = await waitForAndDismissUnsupportedAlert(page, 1500, false);
    if (!unsupportedAlert.ok) {
      return unsupportedAlert;
    }
    return { ok: true, targetBitrateKbps, unsupportedAlert: unsupportedAlert.state };
  } catch (error) {
    await page.locator('.promptModal:visible button[id^="cancel_"]:visible')
      .click({ timeout: 1000 })
      .catch(() => {});
    return {
      ok: false,
      reason: 'bitrate_control_not_actionable',
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function readPeerStatsInfo(page, uuid) {
  return page.evaluate((peerUuid) => {
    const rpc = window.session && window.session.rpcs ? window.session.rpcs[peerUuid] : null;
    return rpc && rpc.stats && rpc.stats.info ? { ...rpc.stats.info } : null;
  }, uuid);
}

async function observeStatsFieldsUnchanged(page, uuid, baseline, fields, durationMs) {
  const started = Date.now();
  const samples = [];
  const changes = [];
  while (Date.now() - started < durationMs) {
    const info = await readPeerStatsInfo(page, uuid);
    samples.push({ elapsedMs: Date.now() - started, info });
    if (!info) {
      changes.push({ field: 'peer', expected: 'present', actual: 'missing' });
      break;
    }
    for (const field of fields) {
      const expected = baseline ? baseline[field] : undefined;
      const actual = info[field];
      if (String(actual) !== String(expected)) {
        changes.push({ field, expected, actual });
      }
    }
    if (changes.length > 0) {
      break;
    }
    await wait(250);
  }
  return {
    ok: changes.length === 0 && samples.length > 0,
    state: { baseline, fields, durationMs: Date.now() - started, changes, samples }
  };
}

function directorContainer(page, uuid) {
  return page.locator(cssAttributeSelector('id', `container_${uuid}`));
}

async function openDirectorVideoSettings(page, uuid) {
  const container = directorContainer(page, uuid);
  if (await container.count() !== 1) {
    return { ok: false, reason: 'no_unique_container', uuid, count: await container.count() };
  }
  const button = container.locator(
    `${cssAttributeSelector('data-action-type', 'advanced-camera-settings')}:visible`
  );
  if (await button.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_video_settings_button', count: await button.count() };
  }
  const pressed = await button.evaluate((element) =>
    element.classList.contains('pressed') || element.getAttribute('aria-pressed') === 'true');
  if (!pressed) {
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 10000 });
  }

  const settings = container.locator('.advancedVideoSettings:not(.hidden)');
  await settings.waitFor({ state: 'visible', timeout: 10000 });
  const widthInput = settings.locator('input.manualInput[data-keyname="width"]:visible');
  const heightInput = settings.locator('input.manualInput[data-keyname="height"]:visible');
  await widthInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await heightInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (await widthInput.count() !== 1 || await heightInput.count() !== 1) {
    return {
      ok: false,
      reason: 'no_unique_visible_resolution_inputs',
      widthCount: await widthInput.count(),
      heightCount: await heightInput.count()
    };
  }
  return {
    ok: true,
    state: {
      width: Number(await widthInput.inputValue()),
      height: Number(await heightInput.inputValue())
    }
  };
}

async function closeDirectorVideoSettings(page, uuid) {
  const container = directorContainer(page, uuid);
  const button = container.locator(
    `${cssAttributeSelector('data-action-type', 'advanced-camera-settings')}:visible`
  );
  if (await button.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_video_settings_button', count: await button.count() };
  }
  const pressed = await button.evaluate((element) =>
    element.classList.contains('pressed') || element.getAttribute('aria-pressed') === 'true');
  if (pressed) {
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 10000 });
  }
  return { ok: true };
}

async function changeDirectorResolutionThroughUi(page, uuid, width, height) {
  const opened = await openDirectorVideoSettings(page, uuid);
  if (!opened.ok) {
    return opened;
  }
  const container = directorContainer(page, uuid);
  const settings = container.locator('.advancedVideoSettings:not(.hidden)');
  const widthInput = settings.locator('input.manualInput[data-keyname="width"]:visible');
  const heightInput = settings.locator('input.manualInput[data-keyname="height"]:visible');
  try {
    await widthInput.fill(String(width));
    await widthInput.press('Tab');
    await wait(400);
    await heightInput.fill(String(height));
    await heightInput.press('Tab');
    return { ok: true, requested: { width, height } };
  } catch (error) {
    return {
      ok: false,
      reason: 'resolution_inputs_not_actionable',
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function refreshDirectorVideoSettings(page, uuid) {
  const closed = await closeDirectorVideoSettings(page, uuid);
  if (!closed.ok) {
    return closed;
  }
  await wait(250);
  return openDirectorVideoSettings(page, uuid);
}

async function clickDirectorHangupAndConfirm(page, uuid) {
  const container = directorContainer(page, uuid);
  if (await container.count() !== 1) {
    return { ok: false, reason: 'no_unique_container', uuid, count: await container.count() };
  }
  const hangup = container.locator(`${cssAttributeSelector('data-action-type', 'hangup')}:visible`);
  if (await hangup.count() !== 1) {
    return { ok: false, reason: 'no_unique_visible_hangup_button', count: await hangup.count() };
  }
  try {
    await hangup.scrollIntoViewIfNeeded();
    await hangup.click({ timeout: 10000 });
    const modal = page.locator('.promptModal:visible');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    if (await modal.count() !== 1) {
      return { ok: false, reason: 'no_unique_visible_hangup_confirmation', count: await modal.count() };
    }
    const submit = modal.locator('button[id^="submit_"]:visible');
    if (await submit.count() !== 1) {
      return { ok: false, reason: 'no_unique_visible_hangup_submit', count: await submit.count() };
    }
    await submit.click({ timeout: 10000 });
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'hangup_control_not_actionable',
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function observePublisherRemainsLive(page, uuid, config, baseline, durationMs) {
  await wait(durationMs);
  const connection = await collectDirectorDisconnectState(page, uuid, config.streamId);
  const media = await readDirectorMediaProgress(page, uuid, config.streamId);
  const videoTimeDelta = media && media.video && baseline && baseline.video
    ? Number(media.video.currentTime || 0) - Number(baseline.video.currentTime || 0)
    : 0;
  const frameDelta = Number(media && media.framesDecoded || 0) - Number(baseline && baseline.framesDecoded || 0);
  const byteDelta = Number(media && media.bytesReceived || 0) - Number(baseline && baseline.bytesReceived || 0);
  const connectionState = String(connection.connectionState || '').toLowerCase();
  const iceState = String(connection.iceConnectionState || '').toLowerCase();
  const connected = connection.rpcExists && connection.containerExists && connection.decoded &&
    !['closed', 'failed', 'disconnected'].includes(connectionState) &&
    !['closed', 'failed', 'disconnected'].includes(iceState);
  return {
    ok: connected && media.ok && videoTimeDelta > 0.05 && frameDelta > 0 && byteDelta > 0,
    state: {
      durationMs,
      connection,
      baseline,
      media,
      deltas: { videoTime: videoTimeDelta, framesDecoded: frameDelta, bytesReceived: byteDelta }
    }
  };
}

async function readInboundVideoStats(page, uuid) {
  return page.evaluate(async (peerUuid) => {
    const pc = window.session && window.session.rpcs ? window.session.rpcs[peerUuid] : null;
    if (!pc || typeof pc.getStats !== 'function') {
      return { ok: false, reason: 'no_peer_getStats' };
    }
    const report = await pc.getStats();
    const totals = {
      ok: true,
      framesDecoded: 0,
      keyFramesDecoded: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      stats: []
    };
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp') {
        return;
      }
      if (stat.kind !== 'video' && stat.mediaType !== 'video') {
        return;
      }
      const item = {
        id: stat.id,
        framesDecoded: Number(stat.framesDecoded || 0),
        keyFramesDecoded: Number(stat.keyFramesDecoded || 0),
        bytesReceived: Number(stat.bytesReceived || 0),
        packetsReceived: Number(stat.packetsReceived || 0)
      };
      totals.framesDecoded += item.framesDecoded;
      totals.keyFramesDecoded += item.keyFramesDecoded;
      totals.bytesReceived += item.bytesReceived;
      totals.packetsReceived += item.packetsReceived;
      totals.stats.push(item);
    });
    return totals;
  }, uuid);
}

async function waitForInboundVideoStats(page, uuid, predicateSource, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const stats = await readInboundVideoStats(page, uuid);
    last = stats;
    if (stats && stats.ok) {
      const ok = await page.evaluate(({ source, value }) => {
        const predicate = new Function('stats', `return (${source})(stats);`);
        try {
          return !!predicate(value);
        } catch {
          return false;
        }
      }, { source: predicateSource, value: stats });
      if (ok) {
        return { ok: true, state: stats };
      }
    }
    await wait(500);
  }
  return { ok: false, stage: 'inbound-video-stats', state: last };
}

async function runRemoteControlContract({ page, uuid, config, publisher, report, check }) {
  const mode = config.remoteControlContract;
  const enabled = mode === 'enabled';
  const prefix = `remote-control-${mode}`;
  const contractCheck = (name, fn) => check(`${prefix}-${name}`, fn, false);
  report.remoteControlContract = {
    mode,
    expectedEnabled: enabled,
    publisherFlagPresent: publisher.args.includes('--remote-control'),
    controls: ['bitrate', 'resolution', 'hangup']
  };

  await contractCheck('publisher-flag-contract', async () => ({
    ok: publisher.args.includes('--remote-control') === enabled,
    state: {
      expectedFlagPresent: enabled,
      actualFlagPresent: publisher.args.includes('--remote-control'),
      sanitizedArgs: publisher.args.map((arg) => arg.startsWith('--password=') ? '--password=<redacted>' : arg)
    }
  }));

  await contractCheck('reported-setting-contract', async () => {
    const info = await readPeerStatsInfo(page, uuid);
    return {
      ok: !!info && Boolean(info.remote) === enabled,
      state: { expectedRemote: enabled, info }
    };
  });

  const statsAction = await contractCheck('opens-scene-stats-control', () =>
    clickSceneStatsButton(page, uuid));
  if (statsAction.ok) {
    await contractCheck('scene-stats-populates', () => waitForSceneStatsUi(
      page,
      uuid,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));
  }

  const beforeBitrateInfo = await readPeerStatsInfo(page, uuid);
  const beforeBitrateMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
  const baselineBitrate = Number(beforeBitrateInfo && beforeBitrateInfo.quality_url || 0);
  const targetBitrate = baselineBitrate === config.targetBitrateKbps
    ? Math.max(500, config.targetBitrateKbps - 700)
    : config.targetBitrateKbps;
  const bitrateAction = await contractCheck('bitrate-visible-control-action', () =>
    clickStatsBitrateControl(page, uuid, targetBitrate));
  if (bitrateAction.ok) {
    if (enabled) {
      await contractCheck('shared-bitrate-target-applies', () => waitForProbeMessage(
        page,
        `(entry) => {
          const msg = entry && entry.message;
          const stats = msg && msg.remoteStats && msg.remoteStats['${config.streamId}'];
          return stats && Number(stats.available_outgoing_bitrate_kbps) === ${targetBitrate};
        }`,
        Math.max(10000, Math.floor(config.timeoutMs / 3))
      ));
    } else {
      await contractCheck('bitrate-remains-unchanged', () => observeStatsFieldsUnchanged(
        page,
        uuid,
        beforeBitrateInfo,
        ['quality_url'],
        3500
      ));
    }
    await contractCheck('bitrate-action-keeps-fresh-media', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeBitrateMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
  }

  const openedSettings = await contractCheck('opens-video-settings-control', () =>
    openDirectorVideoSettings(page, uuid));
  if (openedSettings.ok) {
    const baselineResolution = openedSettings.state;
    const targetResolution = {
      width: baselineResolution.width === config.requestWidth && baselineResolution.height === config.requestHeight
        ? 640
        : config.requestWidth,
      height: baselineResolution.width === config.requestWidth && baselineResolution.height === config.requestHeight
        ? 360
        : config.requestHeight
    };
    report.remoteControlContract.baselineResolution = baselineResolution;
    report.remoteControlContract.requestedResolution = targetResolution;
    const beforeResolutionMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const resolutionAction = await contractCheck('resolution-visible-control-action', () =>
      changeDirectorResolutionThroughUi(
        page,
        uuid,
        targetResolution.width,
        targetResolution.height
      ));
    if (resolutionAction.ok) {
      await wait(2000);
      const refreshed = await contractCheck('resolution-settings-refresh', () =>
        refreshDirectorVideoSettings(page, uuid));
      if (refreshed.ok) {
        await contractCheck(
          enabled ? 'resolution-change-applies' : 'resolution-remains-unchanged',
          async () => {
            const expected = enabled ? targetResolution : baselineResolution;
            return {
              ok: refreshed.state.width === expected.width && refreshed.state.height === expected.height,
              state: { baseline: baselineResolution, requested: targetResolution, expected, actual: refreshed.state }
            };
          }
        );
      }
      await contractCheck('resolution-action-keeps-fresh-media', () => waitForFreshDirectorMedia(
        page,
        uuid,
        config,
        beforeResolutionMedia,
        Math.max(15000, Math.floor(config.timeoutMs / 2))
      ));
    }
  }

  await contractCheck('closes-video-settings-before-hangup', () =>
    closeDirectorVideoSettings(page, uuid));
  const beforeHangupMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
  const hangupAction = await contractCheck('hangup-visible-control-action', () =>
    clickDirectorHangupAndConfirm(page, uuid));
  if (hangupAction.ok) {
    if (enabled) {
      await contractCheck('hangup-stops-publisher', () =>
        waitForDirectorPublisherStopped(page, uuid, config));
    } else {
      await contractCheck('hangup-is-rejected', () => waitForProbeMessage(
        page,
        `(entry) => entry && entry.message && entry.message.rejected === 'hangup'`,
        5000
      ));
      await contractCheck('hangup-leaves-publisher-live', () => observePublisherRemainsLive(
        page,
        uuid,
        config,
        beforeHangupMedia,
        4000
      ));
    }
  }

  if (config.strictNegotiation) {
    await contractCheck('negotiation-clean-through-end', async () =>
      negotiationRegressionState(publisher));
  }

  const failures = report.checks.filter((entry) =>
    entry.name.startsWith(`${prefix}-`) && !entry.ok);
  if (failures.length > 0) {
    const error = new Error(`${prefix} contract failed (${failures.length} checks)`);
    error.result = {
      ok: false,
      stage: 'remote-control-contract',
      state: { mode, failures }
    };
    throw error;
  }

  return { ok: true, state: { mode, checks: report.checks.filter((entry) => entry.name.startsWith(`${prefix}-`)) } };
}

function artifactEvidence(artifact) {
  return artifact ? {
    path: artifact.path,
    sha256: artifact.sha256,
    size: artifact.size,
    modifiedUtc: artifact.modifiedUtc
  } : null;
}

function requireRuntimeReceipt(runtimeArtifact, label) {
  if (!runtimeArtifact || !runtimeArtifact.artifactReceipt) {
    throw new Error(`${label} launch did not produce an exact artifact receipt`);
  }
  return runtimeArtifact.artifactReceipt;
}

function verifyDirectorArtifactsStable(config, preparedArtifacts, runtimeArtifacts) {
  const state = {
    ok: true,
    publisher: null,
    spoutSender: null,
    firefox: null
  };
  if (config.requirePackagedArtifact) {
    const publisherReceipt = requireRuntimeReceipt(runtimeArtifacts.publisher, 'Packaged publisher');
    assertSameArtifactIdentity(
      preparedArtifacts.packagedArtifact,
      publisherReceipt.beforeSpawn,
      'Packaged publisher',
      'at its before-spawn receipt'
    );
    assertSameArtifactIdentity(
      preparedArtifacts.packagedArtifact,
      publisherReceipt.afterSpawn,
      'Packaged publisher',
      'at its after-spawn receipt'
    );
    const publisherAtEnd = revalidatePackagedPublisherArtifact(
      config,
      preparedArtifacts.packagedArtifact,
      'at successful completion'
    );
    state.publisher = {
      expected: artifactEvidence(preparedArtifacts.packagedArtifact),
      beforeSpawn: artifactEvidence(publisherReceipt.beforeSpawn),
      afterSpawn: artifactEvidence(publisherReceipt.afterSpawn),
      atEnd: artifactEvidence(publisherAtEnd),
      manifest: {
        path: publisherAtEnd.manifestPath,
        sha256: publisherAtEnd.manifestSha256,
        size: publisherAtEnd.manifestSize,
        modifiedUtc: publisherAtEnd.manifestModifiedUtc
      }
    };

    const spoutReceipt = requireRuntimeReceipt(runtimeArtifacts.sourceFixture, 'Packaged Spout sender fixture');
    assertSameArtifactIdentity(
      preparedArtifacts.spoutSender,
      spoutReceipt.beforeSpawn,
      'Packaged Spout sender fixture',
      'at its before-spawn receipt'
    );
    assertSameArtifactIdentity(
      preparedArtifacts.spoutSender,
      spoutReceipt.afterSpawn,
      'Packaged Spout sender fixture',
      'at its after-spawn receipt'
    );
    const spoutAtEnd = revalidateExpectedFileArtifact(
      preparedArtifacts.spoutSender,
      'Packaged Spout sender fixture',
      'at successful completion'
    );
    state.spoutSender = {
      expected: artifactEvidence(preparedArtifacts.spoutSender),
      beforeSpawn: artifactEvidence(spoutReceipt.beforeSpawn),
      afterSpawn: artifactEvidence(spoutReceipt.afterSpawn),
      atEnd: artifactEvidence(spoutAtEnd)
    };
  }

  if (config.browser === 'firefox-installed') {
    const firefoxReceipt = requireRuntimeReceipt(runtimeArtifacts.browser, 'Installed Firefox');
    assertSameArtifactIdentity(
      preparedArtifacts.firefox,
      firefoxReceipt.beforeLaunch,
      'Installed Firefox',
      'at its before-launch receipt'
    );
    assertSameArtifactIdentity(
      preparedArtifacts.firefox,
      firefoxReceipt.postLaunch,
      'Installed Firefox',
      'at its post-launch receipt'
    );
    const firefoxAtEnd = revalidateExpectedFileArtifact(
      preparedArtifacts.firefox,
      'Installed Firefox',
      'at successful completion'
    );
    state.firefox = {
      expected: artifactEvidence(preparedArtifacts.firefox),
      beforeLaunch: artifactEvidence(firefoxReceipt.beforeLaunch),
      postLaunch: artifactEvidence(firefoxReceipt.postLaunch),
      atEnd: artifactEvidence(firefoxAtEnd)
    };
  }

  return state;
}

function finalizeSuccessfulReport(report, config, preparedArtifacts, runtimeArtifacts) {
  const started = Date.now();
  report.ok = false;
  assertNoRuntimeProcessFailure(runtimeArtifacts);
  const artifactStability = verifyDirectorArtifactsStable(
    config,
    preparedArtifacts,
    runtimeArtifacts
  );
  report.artifactStability = artifactStability;
  report.checks.push({
    name: 'artifact-identities-stable-through-end',
    ok: artifactStability.ok,
    durationMs: Date.now() - started,
    state: artifactStability
  });
  report.ok = artifactStability.ok && report.checks.every((entry) => entry.ok);
  if (!report.ok) {
    throw new Error('Successful Director workflow contains a failed check');
  }
  return artifactStability;
}

async function run() {
  const config = parseArgs(process.argv);
  const preparedArtifacts = prepareDirectorArtifacts(config);
  const directorUrl = buildDirectorUrl(config);
  const expectedAudioSource = config.source === 'spout' ? 'none' : config.audioSource;
  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    streamId: config.streamId,
    room: config.room,
    audioSource: config.audioSource,
    expectedEffectiveAudioSource: expectedAudioSource,
    videoCodec: config.videoCodec || 'default',
    roomModeLqEnabled: !config.disableRoomLq,
    includeMicrophone: config.includeMicrophone,
    microphoneDeviceId: config.microphoneDeviceId ? '(selected)' : '',
    browser: config.browser,
    strictNegotiation: config.strictNegotiation,
    packagedArtifactIdentityRequired: config.requirePackagedArtifact,
    remoteControlEnabled: config.remoteControlEnabled,
    remoteControlContractMode: config.remoteControlContract || '',
    publisherRemoteControlFlagPresent: false,
    permissionsPregranted: ['camera', 'microphone'],
    permissionGrantMethod: isFirefoxBrowser(config.browser)
      ? `${config.browser}-profile-media.navigator.permission.disabled`
      : 'playwright-browser-context',
    source: config.source,
    spoutSender: config.source === 'spout' ? config.spoutSender : '',
    publisherArtifact: null,
    packagedArtifactManifest: preparedArtifacts.packagedArtifact ? {
      path: preparedArtifacts.packagedArtifact.manifestPath,
      sha256: preparedArtifacts.packagedArtifact.manifestSha256,
      schema: preparedArtifacts.packagedArtifact.manifest.schema,
      version: preparedArtifacts.packagedArtifact.manifest.version,
      packagedAtUtc: preparedArtifacts.packagedArtifact.manifest.packagedAtUtc,
      buildConfiguration: preparedArtifacts.packagedArtifact.manifest.build.configuration,
      source: preparedArtifacts.packagedArtifact.manifest.source
    } : null,
    sourceFixtureArtifact: null,
    stopLifecycleOnly: config.stopLifecycleOnly,
    checks: []
  };

  let sourceFixture = null;
  let publisher = null;
  let browser = null;
  let page = null;
  let failure = null;

  const check = async (name, fn, fatal = true) => {
    const started = Date.now();
    let result = await awaitWithRuntimeProcessFailures(
      () => fn(),
      { sourceFixture, publisher, browser }
    );
    if (result.ok && page) {
      const blockingUi = await awaitWithRuntimeProcessFailures(
        () => collectBlockingUiState(page),
        { sourceFixture, publisher, browser }
      );
      if (!blockingUi.ok) {
        result = {
          ok: false,
          stage: 'visible-blocking-ui',
          state: {
            actionResult: result.state || result,
            blockingUi
          }
        };
      }
    }
    report.checks.push({
      name,
      ok: !!result.ok,
      durationMs: Date.now() - started,
      state: result.state || result
    });
    if (!result.ok) {
      console.error(`[DIRECTOR-E2E] ${name} FAIL`);
      if (!fatal) {
        return result;
      }
      const error = new Error(`${name} failed`);
      error.result = result;
      throw error;
    }
    console.log(`[DIRECTOR-E2E] ${name} PASS`);
    return result;
  };

  try {
    sourceFixture = spawnSpoutTestSender(config, preparedArtifacts.spoutSender);
    publisher = spawnPublisher(config, preparedArtifacts.packagedArtifact);
    assertNoRuntimeProcessFailure({ sourceFixture, publisher, browser });
    report.publisherRemoteControlFlagPresent = publisher.args.includes('--remote-control');
    const publisherLaunchArtifact = publisher.artifactReceipt
      ? publisher.artifactReceipt.afterSpawn
      : validateExpectedFileArtifact(
        publisher.command,
        sha256File(publisher.command),
        'Director publisher'
      );
    report.publisherArtifact = {
      ...artifactEvidence(publisherLaunchArtifact),
      expectedSha256: preparedArtifacts.packagedArtifact
        ? preparedArtifacts.packagedArtifact.sha256
        : null
    };
    if (sourceFixture) {
      const sourceFixtureLaunchArtifact = sourceFixture.artifactReceipt
        ? sourceFixture.artifactReceipt.afterSpawn
        : validateExpectedFileArtifact(
          sourceFixture.command,
          sha256File(sourceFixture.command),
          'Director source fixture'
        );
      report.sourceFixtureArtifact = {
        ...artifactEvidence(sourceFixtureLaunchArtifact),
        expectedSha256: preparedArtifacts.spoutSender
          ? preparedArtifacts.spoutSender.sha256
          : null
      };
    }
    console.log(`[DIRECTOR-E2E] Base URL: ${config.baseUrl}`);
    console.log(`[DIRECTOR-E2E] Director URL: ${directorUrl}`);
    console.log(`[DIRECTOR-E2E] Publisher: ${publisher.command} ${publisher.args.join(' ')}`);
    await awaitWithRuntimeProcessFailures(
      () => wait(config.startupDelayMs),
      { sourceFixture, publisher, browser }
    );

    browser = await launchDirectorBrowser(config, preparedArtifacts.firefox);
    assertNoRuntimeProcessFailure({ sourceFixture, publisher, browser });
    publisher.browserName = config.browser;
    report.browserVersion = browser.version();
    if (config.browser === 'firefox-installed') {
      const browserLaunchArtifact = browser.artifactReceipt.postLaunch;
      report.browserArtifact = {
        ...artifactEvidence(browserLaunchArtifact),
        expectedSha256: preparedArtifacts.firefox.sha256,
        automation: browser.automation,
        version: browser.version()
      };
    }
    const contextOptions = {
      viewport: { width: 1600, height: 900 },
      ignoreHTTPSErrors: true
    };
    if (!isFirefoxBrowser(config.browser)) {
      contextOptions.permissions = ['camera', 'microphone'];
    }
    const context = await browser.newContext(contextOptions);
    if (!isFirefoxBrowser(config.browser)) {
      await context.grantPermissions(
        ['camera', 'microphone'],
        { origin: new URL(config.baseUrl).origin }
      );
    }
    page = await context.newPage();
    report.browserUserAgent = await page.evaluate(() => navigator.userAgent);
    await page.goto(directorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peer = await check('director-loads-room-publisher', () => waitForDirectorPeer(page, config));
    const uuid = peer.uuid;
    await check('director-decodes-publisher-video', () => waitForDecodedDirectorVideo(page, config));
    const initialMediaBaseline = await readDirectorMediaProgress(page, uuid, config.streamId);
    await check('director-video-frames-and-bytes-advance', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      initialMediaBaseline,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    if (config.strictNegotiation) {
      await check('publisher-negotiation-has-no-known-regressions', async () =>
        negotiationRegressionState(publisher));
    }

    const probe = await installMessageProbe(page, uuid);
    if (!probe.ok) {
      throw Object.assign(new Error('install-message-probe failed'), { result: probe });
    }

    await check('director-peer-init-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.room_init_received === true && String(info.assigned_role || '').toLowerCase() === 'director'`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    await check('director-audio-source-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => String(info.audio_source || '') === '${expectedAudioSource}'`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    if (config.includeMicrophone) {
      await check('director-additional-microphone-info', () => waitForStatsInfo(
        page,
        uuid,
        `(info) => info.include_microphone === true && String(info.additional_audio_source || '') !== 'none'`,
        Math.max(10000, Math.floor(config.timeoutMs / 3))
      ));
    }

    if (config.remoteControlContract) {
      await runRemoteControlContract({ page, uuid, config, publisher, report, check });
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(
        config.screenshotDir,
        `director-room-remote-control-${config.remoteControlContract}-pass-${config.streamId}-${nowStamp()}.png`
      );
      await page.screenshot({ path: shot, fullPage: true });
      report.screenshot = shot;
      finalizeSuccessfulReport(
        report,
        config,
        preparedArtifacts,
        { publisher, sourceFixture, browser }
      );
      console.log(`[DIRECTOR-E2E] PASS screenshot: ${shot}`);
      return;
    }

    if (config.stopLifecycleOnly) {
      const publisherExit = await waitForProcessExit(
        publisher,
        Math.max(config.disconnectTimeoutMs, config.publisherDurationMs + 20000)
      );
      report.publisherExit = publisherExit;
      if (!publisherExit.ok) {
        throw Object.assign(new Error('publisher did not exit cleanly'), { result: publisherExit });
      }
      console.log('[DIRECTOR-E2E] publisher-natural-exit PASS');
      await check('director-observes-publisher-stop', () => waitForDirectorPublisherStopped(page, uuid, config));
      if (config.strictNegotiation) {
        await check('publisher-negotiation-clean-through-end', async () =>
          negotiationRegressionState(publisher));
      }

      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(config.screenshotDir, `director-room-stop-pass-${config.streamId}-${nowStamp()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      report.screenshot = shot;
      finalizeSuccessfulReport(
        report,
        config,
        preparedArtifacts,
        { publisher, sourceFixture, browser }
      );
      console.log(`[DIRECTOR-E2E] PASS screenshot: ${shot}`);
      return;
    }

    const pingToken = `director-ping-${Date.now()}`;
    const pingRequest = await sendDirectorRequest(page, uuid, { ping: pingToken });
    if (!pingRequest.ok) {
      throw Object.assign(new Error('director ping sendRequest failed'), { result: pingRequest });
    }
    await check('director-ping-pong', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.pong === '${pingToken}';
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const settingsMessageCount = await getDirectorProbeMessageCount(page);
    const directorSettingsRequest = await sendDirectorRequest(page, uuid, {
      getAudioSettings: true,
      getVideoSettings: true
    });
    if (!directorSettingsRequest.ok) {
      throw Object.assign(new Error('director settings sendRequest failed'), { result: directorSettingsRequest });
    }
    await check('director-settings-payload', () => waitForDirectorSettingsPayload(
      page,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      settingsMessageCount
    ));

    const oneShotStatsRequest = await sendDirectorRequest(page, uuid, {
      requestStats: true
    });
    if (!oneShotStatsRequest.ok) {
      throw Object.assign(new Error('one-shot stats sendRequest failed'), { result: oneShotStatsRequest });
    }
    await check('director-one-shot-stats-response', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        const stats = msg && msg.remoteStats && msg.remoteStats['${config.streamId}'];
        return stats &&
          /\\d+\\s*x\\s*\\d+/i.test(String(stats.resolution || '')) &&
          String(stats.video_codec || '').length > 0;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const continuousStatsRequest = await sendDirectorRequest(page, uuid, { requestStatsContinuous: true });
    if (!continuousStatsRequest.ok) {
      throw Object.assign(new Error('continuous stats sendRequest failed'), { result: continuousStatsRequest });
    }
    await check('director-continuous-remote-stats', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        const stats = msg && msg.remoteStats && msg.remoteStats['${config.streamId}'];
        return stats &&
          /\\d+\\s*x\\s*\\d+/i.test(String(stats.resolution || '')) &&
          String(stats.video_codec || '').length > 0;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await sendDirectorRequest(page, uuid, { requestStatsContinuous: false });

    const qualityOffClick = await clickDirectorQualityButton(page, uuid, 'change-quality1');
    if (!qualityOffClick.ok) {
      throw Object.assign(new Error('quality off button click failed'), { result: qualityOffClick });
    }
    await check('director-quality-off-button-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === 0`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const beforeQualityRestoreMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const qualityHighProbeStart = await getDirectorProbeMessageCount(page);
    const qualityHighClick = await clickDirectorQualityButton(page, uuid, 'change-quality3');
    if (!qualityHighClick.ok) {
      throw Object.assign(new Error('quality high button click failed'), { result: qualityHighClick });
    }
    await check('director-quality-high-shows-unsupported-alert', () =>
      waitForAndDismissUnsupportedAlert(
        page,
        Math.max(5000, Math.floor(config.timeoutMs / 3)),
        true
      ));
    await check('director-quality-high-button-restores-assigned-tier', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === -1`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('director-quality-high-is-explicitly-unsupported', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && (msg.rejected === 'bitrate' || msg.rejected === 'optimizedBitrate');
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      qualityHighProbeStart
    ));
    await check('post-quality-button-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeQualityRestoreMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const beforePreviewRateMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const previewRateProbeStart = await getDirectorProbeMessageCount(page);
    const previewRateRequest = await applyVdoPreviewRate(page, uuid, config);
    if (!previewRateRequest.ok) {
      throw Object.assign(new Error('applyVdoPreviewRate failed'), { result: previewRateRequest });
    }
    await check('vdo-preview-rate-unsupported-alert-handled', () =>
      waitForAndDismissUnsupportedAlert(page, 1500, false));
    await check('vdo-preview-rate-message-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === -1 && Number(info.requested_audio_bitrate_kbps) === ${config.previewAudioBitrateKbps}`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('vdo-preview-video-rate-is-explicitly-unsupported', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.rejected === 'bitrate';
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      previewRateProbeStart
    ));
    await check('post-preview-rate-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforePreviewRateMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('unsupported-quality-alert-queue-settles', () =>
      settleUnsupportedAlerts(page, 6000));

    const beforeAudioRateMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const audioRateRequest = await requestVdoAudioRate(page, uuid, config.audioRateLimitKbps);
    if (!audioRateRequest.ok) {
      throw Object.assign(new Error('requestVdoAudioRate failed'), { result: audioRateRequest });
    }
    await check('vdo-audio-rate-message-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_audio_bitrate_kbps) === ${config.audioRateLimitKbps}`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-audio-rate-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeAudioRateMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const beforeAudioRateRestoreMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const audioRateRestore = await requestVdoAudioRate(page, uuid, config.previewAudioBitrateKbps);
    if (!audioRateRestore.ok) {
      throw Object.assign(new Error('restore VDO audio rate failed'), { result: audioRateRestore });
    }
    await check('post-audio-rate-restore-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeAudioRateRestoreMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const beforeResolutionMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const resolutionRequest = await requestVdoResolution(page, uuid, config);
    if (!resolutionRequest.ok) {
      throw Object.assign(new Error('requestVdoResolution failed'), { result: resolutionRequest });
    }
    const resolutionRefreshMessageCount = await getDirectorProbeMessageCount(page);
    const resolutionRefreshRequest = await sendDirectorRequest(page, uuid, { refreshVideo: true });
    if (!resolutionRefreshRequest.ok) {
      throw Object.assign(new Error('refreshVideo after requestResolution failed'), { result: resolutionRefreshRequest });
    }
    await check('vdo-request-resolution-video-options', () => waitForDirectorVideoOptionsDimensions(
      page,
      config.requestWidth,
      config.requestHeight,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      resolutionRefreshMessageCount
    ));
    await check('post-resolution-control-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeResolutionMedia,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));

    const beforeStatsUiMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const statsClick = await clickSceneStatsButton(page, uuid);
    if (!statsClick.ok) {
      throw Object.assign(new Error('clickSceneStatsButton failed'), { result: statsClick });
    }
    await check('director-scene-stats-ui-populates', () => waitForSceneStatsUi(
      page,
      uuid,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));
    await check('post-stats-ui-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeStatsUiMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const beforeStatsBitrateMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const beforeStatsBitrateInfo = await readPeerStatsInfo(page, uuid);
    const statsBitrateClick = await clickStatsBitrateControl(page, uuid, config.targetBitrateKbps);
    if (!statsBitrateClick.ok) {
      throw Object.assign(new Error('clickStatsBitrateControl failed'), { result: statsBitrateClick });
    }
    await check('director-stats-shared-bitrate-target-applies', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        const stats = msg && msg.remoteStats && msg.remoteStats['${config.streamId}'];
        return stats && Number(stats.available_outgoing_bitrate_kbps) === ${config.targetBitrateKbps};
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const expectedStatsBitrateInfo = {
      ...beforeStatsBitrateInfo,
      quality_url: beforeStatsBitrateInfo && beforeStatsBitrateInfo.assigned_tier === 'hq'
        ? config.targetBitrateKbps
        : beforeStatsBitrateInfo.quality_url
    };
    await check('director-stats-per-peer-tier-remains-assigned', () => observeStatsFieldsUnchanged(
      page,
      uuid,
      expectedStatsBitrateInfo,
      ['assigned_tier', 'quality_url'],
      3500
    ));
    await check('post-stats-bitrate-control-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeStatsBitrateMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-stats-quality-alert-queue-settles', () =>
      settleUnsupportedAlerts(page, 6000));

    const beforeDirectorAudioMuteMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const directorAudioMuteClick = await clickDirectorQualityButton(page, uuid, 'mute-guest');
    if (!directorAudioMuteClick.ok) {
      throw Object.assign(new Error('director audio mute button click failed'), { result: directorAudioMuteClick });
    }
    await check('director-audio-mute-button-state', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.muteState === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-director-audio-mute-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeDirectorAudioMuteMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const beforeDirectorAudioUnmuteMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const directorAudioUnmuteClick = await clickDirectorQualityButton(page, uuid, 'mute-guest');
    if (!directorAudioUnmuteClick.ok) {
      throw Object.assign(new Error('director audio unmute button click failed'), { result: directorAudioUnmuteClick });
    }
    await check('director-audio-unmute-button-state', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.muteState === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-director-audio-unmute-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeDirectorAudioUnmuteMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const directorVideoMuteClick = await clickDirectorQualityButton(page, uuid, 'mute-video-guest');
    if (!directorVideoMuteClick.ok) {
      throw Object.assign(new Error('director video mute button click failed'), { result: directorVideoMuteClick });
    }
    await check('director-video-mute-button-state', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.videoMuted === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const beforeDirectorVideoUnmuteMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const directorVideoUnmuteProbeStart = await getDirectorProbeMessageCount(page);
    const directorVideoUnmuteClick = await clickDirectorQualityButton(page, uuid, 'mute-video-guest');
    if (!directorVideoUnmuteClick.ok) {
      throw Object.assign(new Error('director video unmute button click failed'), { result: directorVideoUnmuteClick });
    }
    await check('director-video-unmute-reapplied-quality-shows-unsupported-alert', () =>
      waitForAndDismissUnsupportedAlert(
        page,
        Math.max(5000, Math.floor(config.timeoutMs / 3)),
        true
      ));
    await check('director-video-unmute-reapplied-quality-is-explicitly-unsupported', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && (msg.rejected === 'bitrate' || msg.rejected === 'optimizedBitrate');
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      directorVideoUnmuteProbeStart
    ));
    await check('director-video-unmute-button-state', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.videoMuted === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-director-video-unmute-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeDirectorVideoUnmuteMedia,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));

    const beforeAudioOffMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const audioOffRequest = await sendDirectorRequest(page, uuid, { audio: false });
    if (!audioOffRequest.ok) {
      throw Object.assign(new Error('audio off sendRequest failed'), { result: audioOffRequest });
    }
    await check('director-audio-off-media-update-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.muted === true`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-audio-off-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeAudioOffMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const beforeAudioOnMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const audioOnRequest = await sendDirectorRequest(page, uuid, { audio: true });
    if (!audioOnRequest.ok) {
      throw Object.assign(new Error('audio on sendRequest failed'), { result: audioOnRequest });
    }
    await check('director-audio-on-media-update-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.muted === false`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-audio-on-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeAudioOnMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const videoOffRequest = await sendDirectorRequest(page, uuid, { video: false });
    if (!videoOffRequest.ok) {
      throw Object.assign(new Error('video off sendRequest failed'), { result: videoOffRequest });
    }
    await check('director-video-off-media-update-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.video_muted_init === true`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const beforeVideoOnMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const videoOnProbeStart = await getDirectorProbeMessageCount(page);
    const videoOnRequest = await sendDirectorRequest(page, uuid, { video: true });
    if (!videoOnRequest.ok) {
      throw Object.assign(new Error('video on sendRequest failed'), { result: videoOnRequest });
    }
    await check('director-video-on-reapplied-quality-shows-unsupported-alert', () =>
      waitForAndDismissUnsupportedAlert(
        page,
        Math.max(5000, Math.floor(config.timeoutMs / 3)),
        true
      ));
    await check('director-video-on-reapplied-quality-is-explicitly-unsupported', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && (msg.rejected === 'bitrate' || msg.rejected === 'optimizedBitrate');
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      videoOnProbeStart
    ));
    await check('director-video-on-media-update-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.video_muted_init === false`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-video-on-director-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeVideoOnMedia,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));

    const beforeKeyframeMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    const beforeKeyframeStats = await readInboundVideoStats(page, uuid);
    const keyframeRequest = await requestVdoKeyframe(page, uuid);
    if (!keyframeRequest.ok) {
      throw Object.assign(new Error('requestVdoKeyframe failed'), { result: keyframeRequest });
    }
    const baselineKeyframes = Number(beforeKeyframeStats.keyFramesDecoded || 0);
    await check('director-keyframe-request-increases-decoded-keyframes', () => waitForInboundVideoStats(
      page,
      uuid,
      `(stats) => Number(stats.keyFramesDecoded || 0) > ${baselineKeyframes}`,
      Math.max(20000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-keyframe-request-video-is-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeKeyframeMedia,
      Math.max(20000, Math.floor(config.timeoutMs / 3))
    ));

    const beforeHoldMedia = await readDirectorMediaProgress(page, uuid, config.streamId);
    await awaitWithRuntimeProcessFailures(
      () => wait(config.holdMs),
      { sourceFixture, publisher, browser }
    );
    await check('post-control-director-video-remains-fresh', () => waitForFreshDirectorMedia(
      page,
      uuid,
      config,
      beforeHoldMedia,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    if (config.strictNegotiation) {
      await check('publisher-negotiation-clean-through-end', async () =>
        negotiationRegressionState(publisher));
    }

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shot = path.join(config.screenshotDir, `director-room-pass-${config.streamId}-${nowStamp()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    report.screenshot = shot;
    if (page.lastScreenshotEvidence) {
      report.screenshotEvidence = page.lastScreenshotEvidence;
    }
    finalizeSuccessfulReport(
      report,
      config,
      preparedArtifacts,
      { publisher, sourceFixture, browser }
    );
    console.log(`[DIRECTOR-E2E] PASS screenshot: ${shot}`);
  } catch (error) {
    failure = error;
    report.ok = false;
    if (config.strictNegotiation && publisher &&
        !report.checks.some((entry) => entry.name === 'publisher-negotiation-clean-through-end')) {
      const strictState = negotiationRegressionState(publisher);
      report.checks.push({
        name: 'publisher-negotiation-clean-at-failure-boundary',
        ok: strictState.ok,
        durationMs: 0,
        state: strictState.state
      });
      console.error(`[DIRECTOR-E2E] publisher-negotiation-clean-at-failure-boundary ${strictState.ok ? 'PASS' : 'FAIL'}`);
    }
    report.failure = {
      message: error && error.message ? error.message : String(error),
      result: error && error.result ? error.result : undefined
    };
    if (page) {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(config.screenshotDir, `director-room-fail-${config.streamId}-${nowStamp()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      report.screenshot = shot;
      if (page.lastScreenshotEvidence) {
        report.screenshotEvidence = page.lastScreenshotEvidence;
      }
      console.error(`[DIRECTOR-E2E] FAIL screenshot: ${shot}`);
    }
    console.error(`[DIRECTOR-E2E] FAIL: ${report.failure.message}`);
    if (report.failure.result) {
      console.error(JSON.stringify(report.failure.result, null, 2));
    }
  } finally {
    try {
      await cleanupDirectorRuntime({ browser, publisher, sourceFixture });
    } catch (error) {
      report.ok = false;
      report.cleanupFailure = {
        message: error && error.message ? error.message : String(error)
      };
      if (!failure) {
        failure = error;
        report.failure = report.cleanupFailure;
        console.error(`[DIRECTOR-E2E] FAIL: ${report.failure.message}`);
      }
    }
    try {
      assertNoRuntimeProcessFailure({ browser, publisher, sourceFixture });
    } catch (error) {
      if (!failure) {
        failure = error;
        report.ok = false;
        report.failure = {
          message: error && error.message ? error.message : String(error)
        };
        console.error(`[DIRECTOR-E2E] FAIL: ${report.failure.message}`);
      }
    }
    report.publisherOutputTail = publisher
      ? `${publisher.stdoutText}\n${publisher.stderrText}`.trim().split(/\r?\n/).slice(-80)
      : [];
    report.sourceFixtureOutputTail = sourceFixture
      ? `${sourceFixture.stdoutText}\n${sourceFixture.stderrText}`.trim().split(/\r?\n/).slice(-40)
      : [];
    fs.mkdirSync(config.reportDir, { recursive: true });
    const reportPath = path.join(config.reportDir, `director-room-e2e-${config.streamId}-${nowStamp()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[DIRECTOR-E2E] Report: ${reportPath}`);
  }

  if (failure) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  prepareDirectorArtifacts,
  validatePackagedPublisherArtifact,
  revalidatePackagedPublisherArtifact,
  validateExpectedFileArtifact,
  revalidateExpectedFileArtifact,
  requireExplicitLeafFile,
  validateLaunchedFirefoxArtifact,
  launchDirectorBrowser,
  spawnPublisher,
  spawnSpoutTestSender,
  awaitWithRuntimeProcessFailures,
  assertNoRuntimeProcessFailure,
  cleanupDirectorRuntime,
  verifyDirectorArtifactsStable,
  finalizeSuccessfulReport,
  detectPublisherBinary,
  detectSpoutTestSender
};
