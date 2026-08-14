'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium, firefox } = require('playwright');
const { launchInstalledFirefox } = require('./firefox-bidi-adapter');

const TURN_ENDPOINT_PROBE_ATTEMPTS = 2;
const BROWSER_RTC_READINESS_TIMEOUT_MS = 15000;
const BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS = 1000;
const BROWSER_RTC_READINESS_POLL_INTERVAL_MS = 50;
const BROWSER_RTC_READINESS_PEER_CLOSE_TIMEOUT_MS = 250;
const BROWSER_RTC_READINESS_CLEANUP_TIMEOUT_MS = 2000;
const BROWSER_RTC_READINESS_DOCUMENT_MARKER = 'game-capture-rtc-readiness-v1';
const BROWSER_RTC_READINESS_DOCUMENT_URL = 'data:text/html,%3Chtml%20data-game-capture-rtc-readiness%3D%22game-capture-rtc-readiness-v1%22%3E%3Ctitle%3Ertc%20readiness%3C%2Ftitle%3E%3C%2Fhtml%3E';
const TURN_REGISTRY_CONFIG_V1_PREFIX = 'game-capture-turn-registry-config-v1';
const TURN_CONSUMED_CONFIG_V1_PREFIX = 'game-capture-consumed-turn-config-v1';
const TURN_ENDPOINT_IDENTITY_V1_PREFIX = 'game-capture-turn-endpoint-identity-v1';
const RELEASE_ARTIFACT_MANIFEST_FILENAME = 'release-artifact-manifest.json';
const RELEASE_ARTIFACT_MANIFEST_SCHEMA = 'game-capture-release-artifact/v1';
const RELEASE_SOURCE_SNAPSHOT_ALGORITHM =
  'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2';

const DIRECT_BROWSER_RTC_CONFIG = { iceServers: [], iceTransportPolicy: 'all' };

function browserTurnServer(server) {
  return {
    urls: server.urls,
    username: server.username,
    credential: server.credential
  };
}

function validateTurnRegistryResponse(status, payload) {
  if (status !== 200) {
    throw new Error('TURN registry must return HTTP 200');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('TURN registry payload must be an object');
  }
  if (!Number.isInteger(payload.version) || payload.version !== 1) {
    throw new Error('TURN registry version must be integer 1');
  }
  if (!Array.isArray(payload.servers) || payload.servers.length === 0) {
    throw new Error('TURN registry servers must be nonempty');
  }

  const servers = payload.servers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error('TURN registry server must be an object');
    }
    if (Object.prototype.hasOwnProperty.call(server, 'url')) {
      throw new Error('Legacy TURN registry url is forbidden');
    }
    const urls = typeof server.urls === 'string'
      ? [server.urls]
      : Array.isArray(server.urls) ? server.urls : [];
    if (urls.length === 0 || urls.some((url) =>
      typeof url !== 'string' ||
      !/^turns?:[^\s]+$/iu.test(url) ||
      [...url].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      }))) {
      throw new Error('TURN registry urls are invalid');
    }
    const invalidIdentity = (value) =>
      [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      });
    if (typeof server.username !== 'string' ||
        server.username.trim().length === 0 ||
        typeof server.credential !== 'string' ||
        server.credential.trim().length === 0 ||
        invalidIdentity(server.username) ||
        invalidIdentity(server.credential) ||
        typeof server.udp !== 'boolean') {
      throw new Error('TURN registry credentials or udp are invalid');
    }
    return {
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      username: server.username,
      credential: server.credential,
      udp: server.udp
    };
  });

  return { ...payload, servers };
}

function flattenValidatedTurnRegistryEndpoints(registry) {
  const endpoints = [];
  for (let registryServerIndex = 0;
    registryServerIndex < registry.servers.length;
    registryServerIndex++) {
    const server = registry.servers[registryServerIndex];
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (let registryUrlIndex = 0; registryUrlIndex < urls.length; registryUrlIndex++) {
      const registryEndpointIndex = endpoints.length;
      const endpoint = {
        ...server,
        urls: urls[registryUrlIndex],
        username: server.username,
        credential: server.credential,
        udp: server.udp,
        registryServerIndex,
        registryUrlIndex,
        registryEndpointIndex
      };
      endpoint.registryEndpointIdentity = turnRegistryEndpointIdentity(endpoint);
      endpoints.push(endpoint);
    }
  }
  return endpoints;
}

function turnRegistryIceServers(response) {
  return response.servers.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential,
    udp: server.udp
  }));
}

function canonicalTurnRegistryResponseV1(servers) {
  return TURN_REGISTRY_CONFIG_V1_PREFIX + '\n' + JSON.stringify(
    servers.map(({ urls, username, credential, udp }) => ({
      urls,
      username,
      credential,
      udp
    }))
  );
}

function turnRegistryEndpointIdentity(endpoint) {
  return sha256Text(TURN_ENDPOINT_IDENTITY_V1_PREFIX + '\n' + JSON.stringify({
    registryServerIndex: endpoint.registryServerIndex,
    registryUrlIndex: endpoint.registryUrlIndex,
    registryEndpointIndex: endpoint.registryEndpointIndex,
    urls: endpoint.urls,
    username: endpoint.username,
    credential: endpoint.credential,
    udp: endpoint.udp
  }));
}

function turnRegistryResponseSha256(servers) {
  return sha256Text(canonicalTurnRegistryResponseV1(servers));
}

function matchPackagedTurnResponse(
  responses,
  transactionId,
  responseSha256,
  fetchStartedAtMs,
  fetchCompletedAtMs
) {
  const matches = responses.filter((entry) =>
    entry.transactionId === transactionId &&
    entry.responseSha256 === responseSha256 &&
    entry.observedAtMs >= fetchStartedAtMs &&
    entry.observedAtMs <= fetchCompletedAtMs
  );
  return matches.length === 1 ? matches[0] : null;
}

function redactTurnSecrets(servers, rawResponse, value) {
  let redacted = String(value);
  const secrets = [
    rawResponse,
    ...servers.flatMap((server) => [server.username, server.credential])
  ];
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted;
}

async function fetchValidatedTurnRegistryResponse(
  endpoint = 'https://turnservers.vdo.ninja/',
  expectedResponseSha256 = ''
) {
  const fetchTimeoutMs = 5000;
  const matchTimeoutMs = 10000;
  const matchRetryMs = 100;
  const registryEndpoint = endpoint || 'https://turnservers.vdo.ninja/';
  const deadline = Date.now() + matchTimeoutMs;
  const expectedResponseIsDynamic = typeof expectedResponseSha256 === 'function';
  let observedCount = 0;
  do {
    const sourceUrl = registryEndpoint + '?ts=' + (Date.now() - 1653305816700);
    const response = await fetch(sourceUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
    if (response.status !== 200) {
      throw new Error('TURN registry HTTP status was not 200');
    }
    const rawResponse = await response.text();
    const payload = JSON.parse(rawResponse);
    const validated = validateTurnRegistryResponse(response.status, payload);
    const responseSha256 = sha256Text(rawResponse);
    const observedAtMs = Date.now();
    observedCount += 1;
    const expectedSha256 = String(
      expectedResponseIsDynamic ? expectedResponseSha256() : expectedResponseSha256
    ).toLowerCase();
    if ((!expectedResponseIsDynamic && !expectedSha256) ||
        (/^[0-9a-f]{64}$/.test(expectedSha256) && responseSha256 === expectedSha256)) {
      return {
        ...validated,
        sourceUrl,
        rawResponse,
        responseSha256,
        configSha256: turnRegistryResponseSha256(validated.servers),
        observedAtMs,
        observedCount
      };
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, matchRetryMs));
    }
  } while (Date.now() <= deadline);

  throw new Error('No unique live TURN registry response matched the native response fingerprint');
}

async function resolveBrowserTurnConfiguration(turnRegistryResponse) {
  const fetchedEndpoints = flattenValidatedTurnRegistryEndpoints(turnRegistryResponse);
  const fetchedEndpointIdentities = fetchedEndpoints.map(
    (endpoint) => endpoint.registryEndpointIdentity
  );
  const resolvedEndpoints = [];
  for (const endpoint of fetchedEndpoints) {
    const resolution = await resolveTurnEndpointAddresses(endpoint);
    resolvedEndpoints.push({ ...endpoint, ...resolution });
  }
  return {
    turnRegistryResponse,
    fetchedEndpointIdentities,
    fetchedEndpoints: resolvedEndpoints,
    rtcConfig: {
      iceServers: turnRegistryIceServers(turnRegistryResponse),
      iceTransportPolicy: 'relay'
    }
  };
}

function parseTurnUrl(url) {
  const match = String(url || '').match(
    /^(turns?):(?:\[([^\]]+)\]|([^:?]+))(?::(\d+))?(.*)$/i
  );
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    hostname: match[2] || match[3],
    port: Number(match[4] || (match[1].toLowerCase() === 'turns' ? 5349 : 3478)),
    suffix: match[5] || ''
  };
}

async function resolveTurnEndpointAddresses(server) {
  const parsed = parseTurnUrl(server.urls);
  if (!parsed) {
    return { parsed: null, addresses: [], dnsErrors: ['invalid-turn-url'] };
  }
  if (net.isIP(parsed.hostname)) {
    return { parsed, addresses: [parsed.hostname], dnsErrors: [] };
  }
  const lookups = await Promise.allSettled([
    dns.resolve4(parsed.hostname),
    dns.resolve6(parsed.hostname)
  ]);
  const addresses = [...new Set(lookups.flatMap((lookup) =>
    lookup.status === 'fulfilled' ? lookup.value : []
  ))];
  const dnsErrors = lookups.flatMap((lookup) =>
    lookup.status === 'rejected' ? [String(lookup.reason)] : []
  );
  return { parsed, addresses, dnsErrors };
}

function turnUrlForAddress(parsed, address) {
  const host = net.isIP(address) === 6 ? `[${address}]` : address;
  return `${parsed.scheme}:${host}:${parsed.port}${parsed.suffix}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const config = {
    publisherPath: '',
    artifactManifestPath: '',
    artifactManifestSha256: '',
    browser: 'edge',
    firefoxPath: '',
    expectedFirefoxSha256: '',
    spoutSenderPath: '',
    expectedSpoutSenderSha256: '',
    headful: false,
    scenario: 'all',
    offerTimeoutMs: 7000,
    failureTimeoutMs: 55000,
    delayedRestartMs: 46000,
    stressRestarts: 3,
    reportDir: path.resolve(__dirname, 'reports')
  };
  const explicitArtifactArgumentCounts = {
    publisherPath: 0,
    artifactManifestPath: 0,
    artifactManifestSha256: 0
  };
  const browserIdentityArgumentCounts = {
    firefoxPath: 0,
    expectedFirefoxSha256: 0
  };
  const fixtureIdentityArgumentCounts = {
    spoutSenderPath: 0,
    expectedSpoutSenderSha256: 0
  };
  const args = argv.slice(2);
  for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
    const arg = args[argIndex];
    if (arg === '--publisher-path') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      explicitArtifactArgumentCounts.publisherPath += 1;
      config.publisherPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--publisher-path=')) {
      const value = arg.slice('--publisher-path='.length).trim();
      explicitArtifactArgumentCounts.publisherPath += 1;
      config.publisherPath = value ? path.resolve(value) : '';
    } else if (arg === '--artifact-manifest-path') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      explicitArtifactArgumentCounts.artifactManifestPath += 1;
      config.artifactManifestPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--artifact-manifest-path=')) {
      const value = arg.slice('--artifact-manifest-path='.length).trim();
      explicitArtifactArgumentCounts.artifactManifestPath += 1;
      config.artifactManifestPath = value ? path.resolve(value) : '';
    } else if (arg === '--artifact-manifest-sha256') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      explicitArtifactArgumentCounts.artifactManifestSha256 += 1;
      config.artifactManifestSha256 = value;
    } else if (arg.startsWith('--artifact-manifest-sha256=')) {
      const value = arg.slice('--artifact-manifest-sha256='.length).trim();
      explicitArtifactArgumentCounts.artifactManifestSha256 += 1;
      config.artifactManifestSha256 = value;
    } else if (arg.startsWith('--browser=')) {
      config.browser = arg.slice('--browser='.length).trim().toLowerCase();
    } else if (arg === '--firefox-path') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      browserIdentityArgumentCounts.firefoxPath += 1;
      config.firefoxPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--firefox-path=')) {
      const value = arg.slice('--firefox-path='.length).trim();
      browserIdentityArgumentCounts.firefoxPath += 1;
      config.firefoxPath = value ? path.resolve(value) : '';
    } else if (arg === '--expected-firefox-sha256') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      browserIdentityArgumentCounts.expectedFirefoxSha256 += 1;
      config.expectedFirefoxSha256 = value;
    } else if (arg.startsWith('--expected-firefox-sha256=')) {
      const value = arg.slice('--expected-firefox-sha256='.length).trim();
      browserIdentityArgumentCounts.expectedFirefoxSha256 += 1;
      config.expectedFirefoxSha256 = value;
    } else if (arg === '--spout-sender-path') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      fixtureIdentityArgumentCounts.spoutSenderPath += 1;
      config.spoutSenderPath = value ? path.resolve(value) : '';
    } else if (arg.startsWith('--spout-sender-path=')) {
      const value = arg.slice('--spout-sender-path='.length).trim();
      fixtureIdentityArgumentCounts.spoutSenderPath += 1;
      config.spoutSenderPath = value ? path.resolve(value) : '';
    } else if (arg === '--expected-spout-sender-sha256') {
      const value = typeof args[argIndex + 1] === 'string' &&
        !args[argIndex + 1].startsWith('--')
        ? args[++argIndex].trim()
        : '';
      fixtureIdentityArgumentCounts.expectedSpoutSenderSha256 += 1;
      config.expectedSpoutSenderSha256 = value;
    } else if (arg.startsWith('--expected-spout-sender-sha256=')) {
      const value = arg.slice('--expected-spout-sender-sha256='.length).trim();
      fixtureIdentityArgumentCounts.expectedSpoutSenderSha256 += 1;
      config.expectedSpoutSenderSha256 = value;
    } else if (arg.startsWith('--scenario=')) {
      config.scenario = arg.slice('--scenario='.length).trim().toLowerCase();
    } else if (arg.startsWith('--offer-timeout-ms=')) {
      config.offerTimeoutMs = Number(arg.slice('--offer-timeout-ms='.length)) || config.offerTimeoutMs;
    } else if (arg.startsWith('--failure-timeout-ms=')) {
      config.failureTimeoutMs = Number(arg.slice('--failure-timeout-ms='.length)) || config.failureTimeoutMs;
    } else if (arg.startsWith('--delayed-restart-ms=')) {
      config.delayedRestartMs = Number(arg.slice('--delayed-restart-ms='.length)) || config.delayedRestartMs;
    } else if (arg.startsWith('--stress-restarts=')) {
      config.stressRestarts = Number(arg.slice('--stress-restarts='.length)) || config.stressRestarts;
    } else if (arg.startsWith('--report-dir=')) {
      config.reportDir = path.resolve(arg.slice('--report-dir='.length));
    } else if (arg === '--headful') {
      config.headful = true;
    }
  }
  for (const [name, count] of Object.entries(explicitArtifactArgumentCounts)) {
    if (count !== 1 || !config[name]) {
      const cliName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(
        `Exactly one explicit --${cliName} value is required ` +
        `(either --${cliName}=value or --${cliName} value)`
      );
    }
  }
  if (!/^[0-9a-f]{64}$/.test(config.artifactManifestSha256)) {
    throw new Error('--artifact-manifest-sha256 must be exactly 64 lowercase hexadecimal characters');
  }
  for (const [name, count] of Object.entries(fixtureIdentityArgumentCounts)) {
    if (count !== 1 || !config[name]) {
      const cliName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(`Exactly one explicit --${cliName} value is required`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(config.expectedSpoutSenderSha256)) {
    throw new Error(
      '--expected-spout-sender-sha256 must be exactly 64 lowercase hexadecimal characters'
    );
  }
  if (![
    'all', 'negotiation', 'recovery', 'direct', 'auto', 'relay', 'lifecycle'
  ].includes(config.scenario)) {
    throw new Error(
      `Unknown scenario '${config.scenario}'; expected all, negotiation, recovery, direct, auto, relay, or lifecycle`
    );
  }
  if (!['edge', 'chromium', 'firefox', 'firefox-installed'].includes(config.browser)) {
    throw new Error(
      `Unknown browser '${config.browser}'; expected edge, chromium, firefox, or firefox-installed`
    );
  }
  if (config.browser === 'firefox-installed') {
    for (const [name, count] of Object.entries(browserIdentityArgumentCounts)) {
      if (count !== 1 || !config[name]) {
        const cliName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        throw new Error(
          `Exactly one explicit --${cliName} value is required for firefox-installed`
        );
      }
    }
    if (!/^[0-9a-f]{64}$/.test(config.expectedFirefoxSha256)) {
      throw new Error(
        '--expected-firefox-sha256 must be exactly 64 lowercase hexadecimal characters'
      );
    }
  } else if (Object.values(browserIdentityArgumentCounts).some((count) => count !== 0)) {
    throw new Error(
      '--firefox-path and --expected-firefox-sha256 are valid only with --browser=firefox-installed'
    );
  }
  if (config.delayedRestartMs <= 45000) {
    throw new Error('--delayed-restart-ms must be greater than VDO.Ninja\'s 45000ms connecting watchdog');
  }
  config.stressRestarts = Math.max(3, Math.floor(config.stressRestarts));
  return config;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Buffer(value) {
  const hash = crypto.createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function comparableRealPath(filePath) {
  const realPath = fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
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

  return { executable, manifestPath, manifestSha256, manifest };
}

function validateSpoutSenderArtifact(config) {
  if (!fs.existsSync(config.spoutSenderPath) ||
      !fs.statSync(config.spoutSenderPath).isFile()) {
    throw new Error(`Explicit Spout sender does not exist: ${config.spoutSenderPath}`);
  }
  const executable = fs.realpathSync.native
    ? fs.realpathSync.native(config.spoutSenderPath)
    : fs.realpathSync(config.spoutSenderPath);
  const observedSha256 = sha256File(executable);
  if (observedSha256 !== config.expectedSpoutSenderSha256) {
    throw new Error(
      `Spout sender SHA-256 mismatch: expected ${config.expectedSpoutSenderSha256}, ` +
      `observed ${observedSha256}`
    );
  }
  return Object.freeze({ executable, sha256: observedSha256 });
}

function assertSpoutSenderArtifactUnchanged(artifact) {
  if (!artifact || !fs.existsSync(artifact.executable) ||
      !fs.statSync(artifact.executable).isFile()) {
    throw new Error(`Validated Spout sender disappeared: ${artifact?.executable || 'missing'}`);
  }
  const observedSha256 = sha256File(artifact.executable);
  if (observedSha256 !== artifact.sha256) {
    throw new Error(
      `Spout sender identity changed: expected ${artifact.sha256}, observed ${observedSha256}`
    );
  }
  return artifact.executable;
}

async function launchBrowser(config) {
  if (config.browser === 'firefox-installed') {
    return launchInstalledFirefox({
      executablePath: config.firefoxPath,
      expectedSha256: config.expectedFirefoxSha256,
      headless: !config.headful
    });
  }
  if (config.browser === 'firefox') {
    return firefox.launch({
      headless: !config.headful,
      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.peerconnection.ice.obfuscate_host_addresses': false
      }
    });
  }
  const options = {
    headless: !config.headful,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns'
    ]
  };
  if (config.browser === 'edge') {
    options.channel = 'msedge';
  }
  return chromium.launch(options);
}

async function ensureBrowserRtcReadiness(browser, report) {
  const startedAt = Date.now();
  const absoluteDeadlineAtMs = startedAt + BROWSER_RTC_READINESS_TIMEOUT_MS;
  const runnerObservation = {
    absoluteDeadlineAtMs,
    operationAttempts: 0,
    operationCompletions: 0,
    operationFailures: 0,
    operationTimeouts: 0,
    peerCreationRequests: 0,
    peerCreationConfirmations: 0,
    snapshotRequests: 0,
    snapshotResponses: 0,
    operations: [],
    cleanup: {
      peerCloseRequests: 0,
      peerCloseResponses: 0,
      contextCloseRequests: 0,
      contextCloseResponses: 0,
      contextCloseTimeouts: 0
    }
  };
  const runBoundedOperation = async (name, deadlineAtMs, operation) => {
    runnerObservation.operationAttempts += 1;
    const operationStartedAtMs = Date.now();
    const remainingMs = deadlineAtMs - operationStartedAtMs;
    if (remainingMs <= 0) {
      runnerObservation.operationTimeouts += 1;
      const result = {
        ok: false,
        timedOut: true,
        error: `${name} did not start before the runner deadline`,
        elapsedMs: 0
      };
      runnerObservation.operations.push({ name, ...result });
      return result;
    }
    let timer = null;
    const operationPromise = Promise.resolve().then(operation);
    operationPromise.catch(() => {});
    const outcome = await Promise.race([
      operationPromise.then(
        (value) => ({ kind: 'completed', value }),
        (error) => ({
          kind: 'failed',
          error: String(error && error.message ? error.message : error)
        })
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: 'timed-out' }),
          Math.max(1, remainingMs)
        );
      })
    ]);
    if (timer) clearTimeout(timer);
    const elapsedMs = Date.now() - operationStartedAtMs;
    if (outcome.kind === 'completed') {
      runnerObservation.operationCompletions += 1;
      const result = { ok: true, value: outcome.value, elapsedMs };
      runnerObservation.operations.push({ name, ok: true, elapsedMs });
      return result;
    }
    if (outcome.kind === 'failed') {
      runnerObservation.operationFailures += 1;
      const result = {
        ok: false,
        timedOut: false,
        error: outcome.error,
        elapsedMs
      };
      runnerObservation.operations.push({ name, ...result });
      return result;
    }
    runnerObservation.operationTimeouts += 1;
    const result = {
      ok: false,
      timedOut: true,
      error: `${name} exceeded the runner deadline`,
      elapsedMs
    };
    runnerObservation.operations.push({ name, ...result });
    return result;
  };
  const preProbeSettle = {
    requestedMs: BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS,
    elapsedMs: 0,
    completedBeforePeerCreation: false
  };
  let context = null;
  let page = null;
  let peerCreationConfirmed = false;
  let lastSnapshot = null;
  let readiness = {
    ok: false,
    documentContext: null,
    initialState: 'unobserved',
    finalState: 'unobserved',
    reason: 'runner-not-started',
    observedTransitions: [],
    configuredIceServerCount: -1,
    operationError: ''
  };
  try {
    const contextResult = await runBoundedOperation(
      'new-context',
      absoluteDeadlineAtMs,
      () => browser.newContext()
    );
    if (!contextResult.ok) {
      readiness.reason = contextResult.timedOut
        ? 'runner-context-deadline'
        : 'runner-context-error';
      readiness.operationError = contextResult.error;
    } else {
      context = contextResult.value;
    }

    if (context) {
      const pageResult = await runBoundedOperation(
        'new-page',
        absoluteDeadlineAtMs,
        () => context.newPage()
      );
      if (!pageResult.ok) {
        readiness.reason = pageResult.timedOut
          ? 'runner-page-deadline'
          : 'runner-page-error';
        readiness.operationError = pageResult.error;
      } else {
        page = pageResult.value;
      }
    }

    if (page) {
      const navigationResult = await runBoundedOperation(
        'readiness-navigation',
        absoluteDeadlineAtMs,
        () => page.goto(BROWSER_RTC_READINESS_DOCUMENT_URL, { waitUntil: 'load' })
      );
      if (!navigationResult.ok) {
        readiness.reason = navigationResult.timedOut
          ? 'runner-navigation-deadline'
          : 'runner-navigation-error';
        readiness.operationError = navigationResult.error;
        page = null;
      }
    }

    if (page) {
      const preProbeSettleStartedAt = Date.now();
      const settleWouldExceedDeadline = preProbeSettleStartedAt +
        BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS > absoluteDeadlineAtMs;
      if (!settleWouldExceedDeadline) {
        await wait(BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS);
      }
      const preProbeSettleElapsedMs = Date.now() - preProbeSettleStartedAt;
      preProbeSettle.elapsedMs = preProbeSettleElapsedMs;
      preProbeSettle.completedBeforePeerCreation = !settleWouldExceedDeadline;
      if (!preProbeSettle.completedBeforePeerCreation) {
        readiness.reason = 'runner-pre-probe-settle-deadline';
      }
    }

    if (page && preProbeSettle.completedBeforePeerCreation) {
      runnerObservation.peerCreationRequests += 1;
      const launchResult = await runBoundedOperation(
        'peer-creation',
        absoluteDeadlineAtMs,
        () => page.evaluate(({ expectedDocumentMarker }) => {
          const documentContext = {
            protocol: location.protocol,
            origin: location.origin,
            marker: document.documentElement.getAttribute(
              'data-game-capture-rtc-readiness'
            ),
            readyState: document.readyState
          };
          const pc = new RTCPeerConnection({
            iceServers: [],
            iceTransportPolicy: 'all'
          });
          const initialState = pc.iceGatheringState;
          const state = {
            pc,
            documentContext,
            initialState,
            lastObservedState: initialState,
            observedTransitions: [],
            configuredIceServerCount: (pc.getConfiguration().iceServers || []).length,
            operationError: '',
            operationCompleted: false,
            createDataChannelCount: 0,
            createOfferCount: 0,
            setLocalDescriptionCount: 0,
            closed: false
          };
          const observe = (source) => {
            const currentState = pc.iceGatheringState;
            if (currentState !== state.lastObservedState) {
              state.observedTransitions.push({
                source,
                from: state.lastObservedState,
                to: currentState
              });
              state.lastObservedState = currentState;
            }
          };
          const onIceGatheringStateChange = () =>
            observe('ice-gathering-state-change');
          pc.addEventListener('icegatheringstatechange', onIceGatheringStateChange);
          state.onIceGatheringStateChange = onIceGatheringStateChange;
          Object.defineProperty(
            document.documentElement,
            '__gameCaptureRtcReadinessStateV1',
            { configurable: true, value: state }
          );
          void (async () => {
            try {
              state.createDataChannelCount += 1;
              pc.createDataChannel('game-capture-rtc-readiness');
              state.createOfferCount += 1;
              const offer = await pc.createOffer();
              state.setLocalDescriptionCount += 1;
              await pc.setLocalDescription(offer);
              observe('post-local-description');
            } catch (error) {
              state.operationError = String(
                error && error.message ? error.message : error
              );
            } finally {
              state.operationCompleted = true;
            }
          })();
          return {
            pcCreated: true,
            documentContext,
            initialState,
            configuredIceServerCount: state.configuredIceServerCount,
            expectedDocumentMarker
          };
        }, {
          expectedDocumentMarker: BROWSER_RTC_READINESS_DOCUMENT_MARKER
        })
      );
      if (!launchResult.ok) {
        readiness.reason = launchResult.timedOut
          ? 'runner-peer-creation-deadline'
          : 'runner-peer-creation-error';
        readiness.operationError = launchResult.error;
      } else {
        const initialProof = launchResult.value;
        peerCreationConfirmed = !!(initialProof && initialProof.pcCreated === true);
        runnerObservation.peerCreationConfirmations += peerCreationConfirmed ? 1 : 0;
        readiness.documentContext = initialProof.documentContext || null;
        readiness.initialState = initialProof.initialState || 'unobserved';
        readiness.finalState = readiness.initialState;
        readiness.configuredIceServerCount =
          Number.isInteger(initialProof.configuredIceServerCount)
            ? initialProof.configuredIceServerCount
            : -1;
        readiness.reason = peerCreationConfirmed
          ? 'runner-awaiting-transition'
          : 'runner-peer-creation-unconfirmed';
      }
    }

    while (page && peerCreationConfirmed && Date.now() < absoluteDeadlineAtMs) {
      runnerObservation.snapshotRequests += 1;
      const snapshotResult = await runBoundedOperation(
        `readiness-snapshot-${runnerObservation.snapshotRequests}`,
        absoluteDeadlineAtMs,
        () => page.evaluate(() => {
          const state = document.documentElement.__gameCaptureRtcReadinessStateV1;
          if (!state || !state.pc) {
            throw new Error('readiness peer state is missing');
          }
          const currentState = state.pc.iceGatheringState;
          if (currentState !== state.lastObservedState) {
            state.observedTransitions.push({
              source: 'runner-snapshot',
              from: state.lastObservedState,
              to: currentState
            });
            state.lastObservedState = currentState;
          }
          return {
            finalState: currentState,
            observedTransitions: state.observedTransitions.map((entry) => ({ ...entry })),
            configuredIceServerCount: state.configuredIceServerCount,
            operationError: state.operationError,
            operationCompleted: state.operationCompleted,
            createDataChannelCount: state.createDataChannelCount,
            createOfferCount: state.createOfferCount,
            setLocalDescriptionCount: state.setLocalDescriptionCount
          };
        })
      );
      if (!snapshotResult.ok) {
        readiness.reason = snapshotResult.timedOut
          ? 'runner-snapshot-deadline'
          : 'runner-snapshot-error';
        readiness.operationError = snapshotResult.error;
        break;
      }
      runnerObservation.snapshotResponses += 1;
      lastSnapshot = snapshotResult.value;
      readiness.finalState = lastSnapshot.finalState;
      readiness.observedTransitions = lastSnapshot.observedTransitions;
      readiness.configuredIceServerCount = lastSnapshot.configuredIceServerCount;
      readiness.operationError = lastSnapshot.operationError;
      const validDocumentContext =
        readiness.documentContext &&
        readiness.documentContext.protocol === 'data:' &&
        readiness.documentContext.origin === 'null' &&
        readiness.documentContext.marker === BROWSER_RTC_READINESS_DOCUMENT_MARKER &&
        readiness.documentContext.readyState === 'complete';
      const genuineTransition = readiness.initialState === 'new' &&
        readiness.finalState !== 'new' && readiness.observedTransitions.length > 0;
      const exactRtcOperations = lastSnapshot.createDataChannelCount === 1 &&
        lastSnapshot.createOfferCount === 1 &&
        lastSnapshot.setLocalDescriptionCount === 1;
      if (lastSnapshot.operationCompleted && validDocumentContext && genuineTransition &&
          exactRtcOperations && readiness.configuredIceServerCount === 0 &&
          !readiness.operationError) {
        readiness.ok = true;
        readiness.reason = 'runner-observed-transition';
        break;
      }
      if (lastSnapshot.operationCompleted &&
          (readiness.operationError || !validDocumentContext)) {
        readiness.reason = readiness.operationError
          ? 'rtc-operation-error'
          : 'invalid-readiness-document';
        break;
      }
      const remainingMs = absoluteDeadlineAtMs - Date.now();
      if (remainingMs > 0) {
        await wait(Math.min(BROWSER_RTC_READINESS_POLL_INTERVAL_MS, remainingMs));
      }
    }
    if (!readiness.ok && readiness.reason === 'runner-awaiting-transition') {
      readiness.reason = 'runner-readiness-deadline';
    }
  } catch (error) {
    readiness.ok = false;
    readiness.reason = 'runner-readiness-error';
    readiness.operationError = String(error && error.message ? error.message : error);
  } finally {
    const cleanupDeadlineAtMs = Date.now() + BROWSER_RTC_READINESS_CLEANUP_TIMEOUT_MS;
    if (page && peerCreationConfirmed) {
      runnerObservation.cleanup.peerCloseRequests += 1;
      const peerCloseResult = await runBoundedOperation(
        'peer-close',
        Math.min(
          cleanupDeadlineAtMs,
          Date.now() + BROWSER_RTC_READINESS_PEER_CLOSE_TIMEOUT_MS
        ),
        () => page.evaluate(() => {
          const state = document.documentElement.__gameCaptureRtcReadinessStateV1;
          if (!state || !state.pc) return { closed: false, missing: true };
          state.pc.removeEventListener(
            'icegatheringstatechange',
            state.onIceGatheringStateChange
          );
          state.pc.close();
          state.closed = true;
          delete document.documentElement.__gameCaptureRtcReadinessStateV1;
          return { closed: true, missing: false };
        })
      );
      if (peerCloseResult.ok && peerCloseResult.value.closed === true) {
        runnerObservation.cleanup.peerCloseResponses += 1;
      }
    }
    if (context) {
      runnerObservation.cleanup.contextCloseRequests += 1;
      const contextCloseResult = await runBoundedOperation(
        'context-close',
        cleanupDeadlineAtMs,
        () => context.close()
      );
      if (contextCloseResult.ok) {
        runnerObservation.cleanup.contextCloseResponses += 1;
      } else if (contextCloseResult.timedOut) {
        runnerObservation.cleanup.contextCloseTimeouts += 1;
      }
    }
  }
  const preProbeTimingValid = preProbeSettle.requestedMs === 1000 &&
    preProbeSettle.elapsedMs >= preProbeSettle.requestedMs &&
    preProbeSettle.completedBeforePeerCreation === true;
  const externalObservationValid =
    runnerObservation.peerCreationRequests === 1 &&
    runnerObservation.peerCreationConfirmations === 1 &&
    runnerObservation.snapshotRequests >= 1 &&
    runnerObservation.snapshotResponses >= 1 &&
    runnerObservation.snapshotResponses <= runnerObservation.snapshotRequests;
  const cleanupValid = runnerObservation.cleanup.peerCloseRequests === 1 &&
    runnerObservation.cleanup.peerCloseResponses === 1 &&
    runnerObservation.cleanup.contextCloseRequests === 1 &&
    runnerObservation.cleanup.contextCloseResponses === 1 &&
    runnerObservation.cleanup.contextCloseTimeouts === 0;
  if (readiness.ok && !preProbeTimingValid) {
    readiness.ok = false;
    readiness.reason = 'runner-pre-probe-settle-invalid';
  } else if (readiness.ok && !externalObservationValid) {
    readiness.ok = false;
    readiness.reason = 'runner-observation-invalid';
  } else if (readiness.ok && !cleanupValid) {
    readiness.ok = false;
    readiness.reason = 'runner-cleanup-incomplete';
  }
  const elapsedMs = Date.now() - startedAt;
  const result = {
    ...readiness,
    lastSnapshot,
    preProbeSettle,
    preProbeTimingValid,
    externalObservationValid,
    cleanupValid,
    elapsedMs,
    timeoutMs: BROWSER_RTC_READINESS_TIMEOUT_MS,
    runnerObservation
  };
  requireHarnessFixture(
    report,
    'browser-rtc-readiness-before-turn-registry',
    result.ok,
    result
  );
  addEvidence(report, 'browser-rtc-readiness-barrier-completed', result);
}

async function createBrowserPeerPage(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.evaluate(() => {
    window.__gameCapturePeers = new Map();
    window.__retiredGameCapturePeers = [];
    window.__gameCapturePeerSequence = 0;

    window.__waitForIceGathering = (pc, timeoutMs = 8000) => new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      const listener = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', listener);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', listener);
    });

    // An existing PeerConnection can still report `complete` immediately
    // after setLocalDescription while the ICE-restart gathering task is only
    // queued. Waiting on that stale state caused the old harness to send an
    // answer with zero restart candidates. Observe the new candidate
    // generation itself and return after it settles briefly (trickle ICE).
    window.__waitForIceGeneration = (pc, state, candidateStart, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const startedAt = Date.now();
        let lastCount = state.localCandidates.length;
        let lastChangedAt = startedAt;
        const timer = setInterval(() => {
          const count = state.localCandidates.length;
          if (count !== lastCount) {
            lastCount = count;
            lastChangedAt = Date.now();
          }
          const hasNewCandidate = count > candidateStart;
          const settled = hasNewCandidate &&
            (pc.iceGatheringState === 'complete' || Date.now() - lastChangedAt >= 750);
          if (settled || Date.now() - startedAt >= timeoutMs) {
            clearInterval(timer);
            resolve();
          }
        }, 25);
      });

    window.__bindGameCapturePeer = (name, pc) => {
      const peerInstanceId = ++window.__gameCapturePeerSequence;
      const state = {
        pc,
        peerInstanceId,
        wireSession: '',
        droppedPublisherCandidates: [],
        dataChannel: null,
        dataMessages: [],
        dataChannelOpened: false,
        tracks: [],
        localCandidates: [],
        transportEvents: []
      };
      const recordTransport = (kind, detail = {}) => {
        state.transportEvents.push({
          at: Date.now(),
          kind,
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
          ...detail
        });
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          state.localCandidates.push({
            wire: JSON.parse(JSON.stringify(event.candidate)),
            directUsernameFragment: String(event.candidate.usernameFragment || ''),
            capturedAt: Date.now(),
            sourceCandidateIndex: state.localCandidates.length
          });
        }
      };
      pc.onconnectionstatechange = () => recordTransport('connection-state');
      pc.oniceconnectionstatechange = () => recordTransport('ice-connection-state');
      pc.onicegatheringstatechange = () => recordTransport('ice-gathering-state');
      pc.onicecandidateerror = (event) => recordTransport('ice-candidate-error', {
        address: event.address || '',
        port: event.port || 0,
        url: event.url || '',
        errorCode: event.errorCode || 0,
        errorText: event.errorText || ''
      });
      pc.ondatachannel = (event) => {
        state.dataChannel = event.channel;
        event.channel.onopen = () => { state.dataChannelOpened = true; };
        event.channel.onclose = () => { state.dataChannelOpened = false; };
        event.channel.onmessage = (message) => { state.dataMessages.push(String(message.data)); };
        if (event.channel.readyState === 'open') {
          state.dataChannelOpened = true;
        }
      };
      pc.ontrack = (event) => {
        const media = document.createElement(event.track.kind === 'video' ? 'video' : 'audio');
        media.autoplay = true;
        // Keep remote audio rendering enabled so RTCInboundRtpStreamStats
        // reports totalAudioEnergy. The deterministic loopback tone is the
        // source, and browser autoplay is explicitly enabled at launch.
        media.muted = event.track.kind === 'video';
        media.srcObject = new MediaStream([event.track]);
        document.body.appendChild(media);
        state.tracks.push({ track: event.track, transceiver: event.transceiver, media });
        media.play().catch(() => {});
      };
      window.__gameCapturePeers.set(name, state);
      return state;
    };

    window.__answerGameCaptureOffer = async (
      name,
      sdp,
      renegotiate,
      rtcConfig,
      wireSession
    ) => {
      let state = window.__gameCapturePeers.get(name);
      if (!renegotiate || !state) {
        if (state) {
          state.retiredAt = Date.now();
          state.pc.close();
          window.__retiredGameCapturePeers.push({ name, state });
        }
        state = window.__bindGameCapturePeer(
          name,
          new RTCPeerConnection(rtcConfig || { iceServers: [], iceTransportPolicy: 'all' })
        );
      } else if (rtcConfig) {
        state.pc.setConfiguration(rtcConfig);
      }
      state.wireSession = wireSession;
      const candidateStart = state.localCandidates.length;
      await state.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await window.__waitForIceGeneration(state.pc, state, candidateStart);
      const candidateEnd = state.localCandidates.length;
      const localDescriptionSdp = state.pc.localDescription.sdp;
      const ufragMatch = localDescriptionSdp.match(
        /(?:^|\r?\n)a=ice-ufrag:([^\r\n]+)/m
      );
      const localDescriptionUfrag = ufragMatch ? ufragMatch[1].trim() : '';
      return {
        sdp: localDescriptionSdp,
        signalingState: state.pc.signalingState,
        mids: state.pc.getTransceivers().map((transceiver) => transceiver.mid || ''),
        wireSession: state.wireSession,
        peerInstanceId: state.peerInstanceId,
        candidateStart,
        candidateEnd,
        candidates: state.localCandidates.slice(candidateStart, candidateEnd).map((candidate) => ({
          ...candidate,
          sourcePeerInstanceId: state.peerInstanceId,
          sourceGenerationUfrag: localDescriptionUfrag
        }))
      };
    };

    window.__retiredGameCapturePeerState = (name, peerInstanceId) => {
      const retired = window.__retiredGameCapturePeers.find((entry) =>
        entry.name === name && entry.state.peerInstanceId === peerInstanceId
      );
      if (!retired) {
        return { found: false, name, peerInstanceId };
      }
      return {
        found: true,
        name,
        peerInstanceId,
        retiredAt: retired.state.retiredAt || 0,
        connectionState: retired.state.pc.connectionState,
        iceConnectionState: retired.state.pc.iceConnectionState,
        signalingState: retired.state.pc.signalingState,
        dataChannelOpen: !!retired.state.dataChannel &&
          retired.state.dataChannel.readyState === 'open'
      };
    };

    window.__setGameCapturePeerConfiguration = (name, rtcConfig) => {
      const state = window.__gameCapturePeers.get(name);
      if (!state) {
        return { ok: false, error: 'peer-not-found' };
      }
      try {
        state.pc.setConfiguration(rtcConfig);
        return { ok: true, configuration: state.pc.getConfiguration() };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    };

    window.__probeRelayCandidate = async (rtcConfig, timeoutMs = 12000) => {
      const pc = new RTCPeerConnection(rtcConfig);
      const candidates = [];
      const errors = [];
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate.toJSON());
        }
      };
      pc.onicecandidateerror = (event) => {
        errors.push({
          address: event.address || '',
          port: event.port || 0,
          url: event.url || '',
          errorCode: event.errorCode || 0,
          errorText: event.errorText || ''
        });
      };
      pc.createDataChannel('turn-probe');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await window.__waitForIceGathering(pc, timeoutMs);
      pc.close();
      return { candidates, errors };
    };

    window.__addGameCaptureCandidate = async (name, candidate, messageSession) => {
      const state = window.__gameCapturePeers.get(name);
      if (!state) {
        return { ok: false, error: 'peer-not-found' };
      }
      if (messageSession !== state.wireSession) {
        state.droppedPublisherCandidates.push({
          messageSession: messageSession || '',
          activeWireSession: state.wireSession || '',
          candidate: candidate && candidate.candidate ? candidate.candidate : ''
        });
        return { ok: false, error: 'stale-wire-session' };
      }
      try {
        await state.pc.addIceCandidate(candidate);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    };

    window.__sendGameCaptureData = (name, payload) => {
      const state = window.__gameCapturePeers.get(name);
      if (!state || !state.dataChannel || state.dataChannel.readyState !== 'open') {
        return false;
      }
      state.dataChannel.send(JSON.stringify(payload));
      return true;
    };

    window.__gameCapturePeerState = async (name) => {
      const state = window.__gameCapturePeers.get(name);
      if (!state) {
        return null;
      }
      const inboundVideo = [];
      const inboundAudio = [];
      const candidatePairs = [];
      const localCandidates = [];
      const remoteCandidates = [];
      let selectedCandidatePairId = '';
      const stats = await state.pc.getStats();
      stats.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && !entry.isRemote && entry.kind === 'video') {
          const framesDecodedAvailable = Object.prototype.hasOwnProperty.call(
            entry, 'framesDecoded'
          ) && Number.isFinite(Number(entry.framesDecoded));
          inboundVideo.push({
            mid: entry.mid || '',
            bytesReceived: Number(entry.bytesReceived || 0),
            packetsReceived: Number(entry.packetsReceived || 0),
            framesDecoded: framesDecodedAvailable ? Number(entry.framesDecoded) : 0,
            framesDecodedAvailable
          });
        } else if (entry.type === 'inbound-rtp' && !entry.isRemote && entry.kind === 'audio') {
          inboundAudio.push({
            mid: entry.mid || '',
            bytesReceived: Number(entry.bytesReceived || 0),
            packetsReceived: Number(entry.packetsReceived || 0),
            packetsLost: Number(entry.packetsLost || 0),
            totalAudioEnergy: Number(entry.totalAudioEnergy || 0),
            totalAudioEnergyPresent: Object.prototype.hasOwnProperty.call(
              entry, 'totalAudioEnergy'
            ),
            audioLevel: Number(entry.audioLevel || 0),
            totalSamplesReceived: Number(entry.totalSamplesReceived || 0),
            concealedSamples: Number(entry.concealedSamples || 0)
          });
        }
        if (entry.type === 'candidate-pair') {
          candidatePairs.push({
            id: entry.id,
            state: entry.state || '',
            nominated: !!entry.nominated,
            selected: !!entry.selected,
            bytesSent: Number(entry.bytesSent || 0),
            bytesReceived: Number(entry.bytesReceived || 0),
            localCandidateId: entry.localCandidateId || '',
            remoteCandidateId: entry.remoteCandidateId || ''
          });
        } else if (entry.type === 'transport' && entry.selectedCandidatePairId) {
          selectedCandidatePairId = entry.selectedCandidatePairId;
        } else if (entry.type === 'local-candidate') {
          localCandidates.push({
            id: entry.id,
            address: entry.address || entry.ip || '',
            port: entry.port || 0,
            candidateType: entry.candidateType || '',
            protocol: entry.protocol || ''
          });
        } else if (entry.type === 'remote-candidate') {
          remoteCandidates.push({
            id: entry.id,
            address: entry.address || entry.ip || '',
            port: entry.port || 0,
            candidateType: entry.candidateType || '',
            protocol: entry.protocol || ''
          });
        }
      });
      const candidateById = new Map(
        [...localCandidates, ...remoteCandidates].map((candidate) => [candidate.id, candidate])
      );
      let selectedCandidatePair = candidatePairs.find((pair) =>
        selectedCandidatePairId && pair.id === selectedCandidatePairId
      );
      if (!selectedCandidatePair) {
        selectedCandidatePair = candidatePairs
          .filter((pair) => pair.selected || pair.nominated)
          .sort((a, b) =>
            (b.bytesSent + b.bytesReceived) - (a.bytesSent + a.bytesReceived)
          )[0] || null;
      }
      const selectedPair = selectedCandidatePair ? {
        ...selectedCandidatePair,
        localCandidate: candidateById.get(selectedCandidatePair.localCandidateId) || null,
        remoteCandidate: candidateById.get(selectedCandidatePair.remoteCandidateId) || null
      } : null;
      return {
        peerInstanceId: state.peerInstanceId,
        wireSession: state.wireSession,
        droppedPublisherCandidates: state.droppedPublisherCandidates.slice(-20),
        connectionState: state.pc.connectionState,
        iceConnectionState: state.pc.iceConnectionState,
        signalingState: state.pc.signalingState,
        remoteDescriptionUfrag: state.pc.remoteDescription
          ? ((state.pc.remoteDescription.sdp.match(/^a=ice-ufrag:([^\r\n]+)/m) || [])[1] || '')
          : '',
        dataChannelOpen: state.dataChannelOpened ||
          (state.dataChannel && state.dataChannel.readyState === 'open'),
        dataMessages: state.dataMessages.slice(-10),
        transportEvents: state.transportEvents.slice(-30),
        candidatePairs,
        selectedCandidatePairId,
        selectedPair,
        localCandidates,
        remoteCandidates,
        mids: state.pc.getTransceivers().map((transceiver) => transceiver.mid || ''),
        tracks: state.tracks.map((entry) => ({
          kind: entry.track.kind,
          mid: entry.transceiver.mid || '',
          readyState: entry.track.readyState,
          videoWidth: entry.media.videoWidth || 0,
          videoHeight: entry.media.videoHeight || 0
        })),
        inboundVideo,
        inboundAudio
      };
    };

    window.__closeGameCapturePeer = (name) => {
      const state = window.__gameCapturePeers.get(name);
      if (state) {
        state.pc.close();
        window.__gameCapturePeers.delete(name);
      }
    };
  });
  return { context, page };
}

async function startSignalServer() {
  const events = [];
  const sentEvents = [];
  const sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const raw = data.toString();
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        message = null;
      }
      events.push({ at: Date.now(), raw, message });
    });
  });

  const address = server.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    events,
    sentEvents,
    send(message) {
      const payload = JSON.stringify(message);
      const openSocket = Array.from(sockets).find((socket) => socket.readyState === socket.OPEN);
      if (!openSocket) {
        throw new Error('Publisher signaling socket is not connected');
      }
      const sentEvent = { at: Date.now(), raw: payload, message: JSON.parse(payload) };
      sentEvents.push(sentEvent);
      openSocket.send(payload);
      return sentEvent;
    },
    async waitFor(predicate, afterIndex, timeoutMs) {
      const started = Date.now();
      let cursor = Math.max(0, afterIndex || 0);
      while (Date.now() - started < timeoutMs) {
        while (cursor < events.length) {
          const index = cursor++;
          const entry = events[index];
          if (entry.message && predicate(entry.message, entry)) {
            return { ...entry, index };
          }
        }
        await wait(25);
      }
      return null;
    },
    async close() {
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function startPublisher(executable, signalUrl, options) {
  const streamId = options.streamId;
  const args = [
    '--headless',
    `--stream=${streamId}`,
    '--password=false',
    `--server=${signalUrl}`,
    `--audio-source=${options.audioSource || 'none'}`,
    `--ice-mode=${options.iceMode}`,
    `--duration-ms=${options.durationMs || 240000}`,
    '--width=640',
    '--height=360',
    '--fps=30',
    '--bitrate-kbps=1800'
  ];
  if (options.videoCodec) {
    args.push(`--video-codec=${options.videoCodec}`);
  }
  if (options.source) {
    args.push(`--source=${options.source}`);
  }
  if (options.spoutSender) {
    args.push(`--spout-sender=${options.spoutSender}`);
  }
  if (options.alpha) {
    if (!options.videoCodec) {
      args.push('--video-codec=vp9');
    }
    args.push('--alpha-workflow');
  }
  if (options.diagnosticsOut) {
    args.push(`--diagnostics-out=${options.diagnosticsOut}`);
  }
  if (options.localControlDiscovery && options.localControlToken) {
    args.push(
      '--local-control',
      '--local-control-port=0',
      `--local-control-discovery=${options.localControlDiscovery}`
    );
  }
  const childEnv = { ...process.env };
  if (options.localControlToken) {
    childEnv.GAME_CAPTURE_LOCAL_CONTROL_TOKEN = options.localControlToken;
  }
  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString(); });
  return {
    child,
    executable,
    args,
    output() {
      return `${child.stdoutText}\n${child.stderrText}`;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const gracefulExit = await waitForChildExit(child, 750);
        if (gracefulExit.exited) {
          return gracefulExit;
        }
        child.kill('SIGKILL');
        return waitForChildExit(child, 2000);
      }
      return { exited: true, exitCode: child.exitCode, signalCode: child.signalCode };
    }
  };
}

function startOutputFixture(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString(); });
  return {
    child,
    command,
    args,
    output() { return `${child.stdoutText}\n${child.stderrText}`; },
    async waitForText(pattern, timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (pattern.test(this.output())) {
          return true;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          return false;
        }
        await wait(50);
      }
      return false;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const gracefulExit = await waitForChildExit(child, 500);
        if (gracefulExit.exited) {
          return gracefulExit;
        }
        child.kill('SIGKILL');
        return waitForChildExit(child, 2000);
      }
      return { exited: true, exitCode: child.exitCode, signalCode: child.signalCode };
    }
  };
}

function startSignalingMediaFixture(durationMs, spoutArtifact) {
  const spoutPath = assertSpoutSenderArtifactUnchanged(spoutArtifact);
  const senderName = `Game Capture Signaling Media ${process.pid} ${Date.now()}`;
  const spout = startOutputFixture(spoutPath, [
    `--name=${senderName}`,
    '--width=640',
    '--height=360',
    '--fps=30',
    '--pattern=alpha-moving-edge',
    `--duration-ms=${durationMs}`
  ], path.dirname(spoutPath));
  return {
    ok: true,
    senderName,
    spoutPath,
    spout,
    hashes: { spoutSenderSha256: sha256File(spoutPath) },
    async stop() {
      return spout.stop();
    }
  };
}

function startLifecycleMediaFixtures(durationMs, spoutArtifact) {
  const spoutPath = assertSpoutSenderArtifactUnchanged(spoutArtifact);
  const tonePath = path.resolve(__dirname, 'audio-test-tone.ps1');
  if (!fs.existsSync(tonePath)) {
    return {
      ok: false,
      missing: [tonePath]
    };
  }
  const senderName = `Game Capture Signaling Lifecycle ${process.pid} ${Date.now()}`;
  const spout = startOutputFixture(spoutPath, [
    `--name=${senderName}`,
    '--width=640',
    '--height=360',
    '--fps=30',
    '--pattern=alpha-moving-edge',
    `--duration-ms=${durationMs}`
  ], path.dirname(spoutPath));
  const tone = startOutputFixture('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    tonePath,
    '-DurationMs',
    String(durationMs)
  ], path.dirname(tonePath));
  return {
    ok: true,
    senderName,
    spoutPath,
    tonePath,
    spout,
    tone,
    hashes: {
      spoutSenderSha256: sha256File(spoutPath),
      audioToneScriptSha256: sha256File(tonePath)
    },
    async stop() {
      const [spoutTermination, toneTermination] =
        await Promise.all([spout.stop(), tone.stop()]);
      return { spoutTermination, toneTermination };
    }
  };
}

function isOfferFor(uuid) {
  return (message) => message.UUID === uuid &&
    message.description && message.description.type === 'offer' &&
    typeof message.description.sdp === 'string';
}

function requestOffer(signal, uuid, streamId, session) {
  const message = { request: 'offerSDP', UUID: uuid, streamID: streamId };
  if (session !== undefined && session !== null && session !== '') {
    message.session = session;
  }
  signal.send(message);
}

function sendAnswer(signal, uuid, streamId, session, sdp) {
  return signal.send({
    UUID: uuid,
    session,
    streamID: streamId,
    description: { type: 'answer', sdp }
  });
}

function sendSessionlessAnswer(signal, uuid, streamId, sdp) {
  const message = {
    UUID: uuid,
    streamID: streamId,
    description: { type: 'answer', sdp }
  };
  if (Object.prototype.hasOwnProperty.call(message, 'session')) {
    throw new Error('Sessionless answer fixture unexpectedly owns a session property');
  }
  return signal.send(message);
}

async function waitForPublisherOutput(publisher, afterOffset, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = publisher.output().slice(afterOffset);
    if (predicate(output)) {
      return { ok: true, elapsedMs: Date.now() - startedAt, output };
    }
    await wait(25);
  }
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    output: publisher.output().slice(afterOffset)
  };
}

function browserCandidateWire(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return {};
  }
  return candidate.wire && typeof candidate.wire === 'object'
    ? candidate.wire
    : candidate;
}

function canonicalBrowserCandidateWire(candidate) {
  return JSON.stringify(browserCandidateWire(candidate));
}

const CANDIDATE_FINGERPRINT_FIELDS = [
  'candidate',
  'sdpMid',
  'sdpMLineIndex',
  'usernameFragment'
];

function canonicalCandidateFingerprintScalar(value) {
  if (value === undefined) {
    return 'u0:';
  }
  if (value === null) {
    return 'n0:';
  }
  const tag = typeof value === 'number'
    ? 'd'
    : (typeof value === 'boolean' ? 'b' : 's');
  const text = String(value);
  return `${tag}${Buffer.byteLength(text, 'utf8')}:${text}`;
}

function canonicalBrowserCandidateFingerprint(candidate) {
  const wire = browserCandidateWire(candidate);
  return CANDIDATE_FINGERPRINT_FIELDS.map((field) =>
    `${Buffer.byteLength(field, 'utf8')}:${field}=` +
      canonicalCandidateFingerprintScalar(wire[field])
  ).join('|');
}

function browserCandidateFingerprintCoversWire(candidate) {
  const wire = browserCandidateWire(candidate);
  return Object.keys(wire).every((field) =>
    CANDIDATE_FINGERPRINT_FIELDS.includes(field)
  ) &&
    typeof wire.candidate === 'string' && wire.candidate.length > 0 &&
    (wire.sdpMid === null || typeof wire.sdpMid === 'string') &&
    (wire.sdpMLineIndex === null || Number.isInteger(wire.sdpMLineIndex)) &&
    (wire.usernameFragment === undefined || wire.usernameFragment === null ||
      typeof wire.usernameFragment === 'string');
}

function browserCandidateWireSha256(candidate) {
  return crypto.createHash('sha256')
    .update(canonicalBrowserCandidateFingerprint(candidate), 'utf8')
    .digest('hex');
}

function sendBrowserCandidates(signal, uuid, session, candidates) {
  for (const candidate of candidates || []) {
    signal.send({
      UUID: uuid,
      session,
      type: 'remote',
      candidate: browserCandidateWire(candidate)
    });
  }
}

function sendExactBrowserCandidate(signal, uuid, session, candidate) {
  const wire = browserCandidateWire(candidate);
  signal.send({
    UUID: uuid,
    session,
    type: 'remote',
    candidate: wire
  });
}

function sendSessionlessBrowserCandidate(signal, uuid, candidate) {
  const wire = browserCandidateWire(candidate);
  const message = {
    UUID: uuid,
    type: 'remote',
    candidate: wire
  };
  if (Object.prototype.hasOwnProperty.call(message, 'session')) {
    throw new Error('Sessionless candidate fixture unexpectedly owns a session property');
  }
  return signal.send(message);
}

async function answerOffer(
  page,
  peerName,
  offer,
  renegotiate = false,
  rtcConfig = DIRECT_BROWSER_RTC_CONFIG
) {
  return page.evaluate(
    ({ name, sdp, isRenegotiation, peerRtcConfig, wireSession }) =>
      window.__answerGameCaptureOffer(
        name,
        sdp,
        isRenegotiation,
        peerRtcConfig,
        wireSession
      ),
    {
      name: peerName,
      sdp: offer.description.sdp,
      isRenegotiation: renegotiate,
      peerRtcConfig: rtcConfig,
      wireSession: offer.session
    }
  );
}

async function forwardPublisherCandidates(signal, page, uuid, peerName, forwarded, afterIndex = 0) {
  for (let index = Math.max(0, afterIndex); index < signal.events.length; index++) {
    if (forwarded.has(index)) {
      continue;
    }
    const message = signal.events[index].message;
    if (!message || message.UUID !== uuid || !message.candidate || !message.candidate.candidate) {
      continue;
    }
    forwarded.add(index);
    await page.evaluate(
      ({ name, candidate, messageSession }) =>
        window.__addGameCaptureCandidate(name, candidate, messageSession),
      {
        name: peerName,
        candidate: message.candidate,
        messageSession: message.session
      }
    );
  }
}

async function waitForPeerState(
  signal,
  page,
  uuid,
  peerName,
  predicate,
  timeoutMs,
  candidateAfterIndex = 0
) {
  const forwarded = new Set();
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeoutMs) {
    await forwardPublisherCandidates(
      signal,
      page,
      uuid,
      peerName,
      forwarded,
      candidateAfterIndex
    );
    state = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
    if (state && predicate(state)) {
      return { ok: true, state };
    }
    await wait(100);
  }
  return { ok: false, state };
}

async function waitForAlphaActivationOrOffer({
  signal,
  page,
  uuid,
  peerName,
  afterIndex,
  timeoutMs,
  activationPredicate,
  activationSettleMs = 1000
}) {
  const forwarded = new Set();
  const started = Date.now();
  let cursor = Math.max(0, afterIndex || 0);
  let activatedAt = 0;
  let activatedState = null;
  let state = null;
  while (Date.now() - started < timeoutMs) {
    while (cursor < signal.events.length) {
      const index = cursor++;
      const entry = signal.events[index];
      if (entry.message && isOfferFor(uuid)(entry.message)) {
        return { kind: 'offer', offer: { ...entry, index }, state };
      }
    }
    await forwardPublisherCandidates(
      signal,
      page,
      uuid,
      peerName,
      forwarded,
      afterIndex
    );
    state = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
    if (!activatedAt && state && activationPredicate(state)) {
      activatedAt = Date.now();
      activatedState = state;
    }
    if (activatedAt && Date.now() - activatedAt >= activationSettleMs) {
      // Close the small observation gap between the scan at the top of this
      // iteration and declaring that activation needed no follow-up offer.
      while (cursor < signal.events.length) {
        const index = cursor++;
        const entry = signal.events[index];
        if (entry.message && isOfferFor(uuid)(entry.message)) {
          return { kind: 'offer', offer: { ...entry, index }, state };
        }
      }
      return {
        kind: 'activated-without-offer',
        offer: null,
        state: activatedState,
        activationSettleMs
      };
    }
    await wait(100);
  }
  return { kind: 'timeout', offer: null, state, activationSettleMs };
}

function mediaTotals(state) {
  const inboundVideo = state && state.inboundVideo ? state.inboundVideo : [];
  return inboundVideo.reduce(
    (totals, entry) => ({
      bytes: totals.bytes + Number(entry.bytesReceived || 0),
      packets: totals.packets + Number(entry.packetsReceived || 0),
      frames: totals.frames + Number(entry.framesDecoded || 0),
      framesDecodedAvailable: totals.framesDecodedAvailable ||
        entry.framesDecodedAvailable === true
    }),
    { bytes: 0, packets: 0, frames: 0, framesDecodedAvailable: false }
  );
}

function requiredMediaCounters(state) {
  const videoByMid = {};
  for (const entry of state && state.inboundVideo ? state.inboundVideo : []) {
    const mid = entry.mid || 'video';
    videoByMid[mid] = {
      bytes: Number(entry.bytesReceived || 0),
      packets: Number(entry.packetsReceived || 0),
      frames: Number(entry.framesDecoded || 0),
      framesDecodedAvailable: entry.framesDecodedAvailable === true
    };
  }
  const audio = (state && state.inboundAudio ? state.inboundAudio : []).reduce(
    (total, entry) => ({
      bytes: total.bytes + Number(entry.bytesReceived || 0),
      packets: total.packets + Number(entry.packetsReceived || 0),
      energy: total.energy + Number(entry.totalAudioEnergy || 0),
      energyPresent: total.energyPresent || !!entry.totalAudioEnergyPresent,
      audioLevel: Math.max(total.audioLevel, Number(entry.audioLevel || 0)),
      samples: total.samples + Number(entry.totalSamplesReceived || 0)
    }),
    { bytes: 0, packets: 0, energy: 0, energyPresent: false, audioLevel: 0, samples: 0 }
  );
  return { videoByMid, audio };
}

function allRequiredMediaAdvanced(before, after) {
  const requiredVideoMids = ['video', 'video-alpha'];
  return requiredVideoMids.every((mid) =>
    before.videoByMid[mid] && after.videoByMid[mid] &&
    before.videoByMid[mid].framesDecodedAvailable &&
    after.videoByMid[mid].framesDecodedAvailable &&
    after.videoByMid[mid].bytes > before.videoByMid[mid].bytes &&
    after.videoByMid[mid].packets > before.videoByMid[mid].packets &&
    after.videoByMid[mid].frames > before.videoByMid[mid].frames
  ) && after.audio.bytes > before.audio.bytes &&
    after.audio.packets > before.audio.packets &&
    before.audio.energyPresent && after.audio.energyPresent &&
    after.audio.energy > before.audio.energy;
}

function requiredMediaIsNonzero(counters) {
  return ['video', 'video-alpha'].every((mid) =>
    counters.videoByMid[mid] && counters.videoByMid[mid].framesDecodedAvailable &&
    counters.videoByMid[mid].bytes > 0 &&
    counters.videoByMid[mid].packets > 0 && counters.videoByMid[mid].frames > 0
  ) && counters.audio.bytes > 0 && counters.audio.packets > 0 &&
    counters.audio.energyPresent && counters.audio.energy > 0;
}

function requiredVideoIsNonzero(counters) {
  return ['video', 'video-alpha'].every((mid) =>
    counters.videoByMid[mid] && counters.videoByMid[mid].framesDecodedAvailable &&
      counters.videoByMid[mid].bytes > 0 && counters.videoByMid[mid].packets > 0 &&
      counters.videoByMid[mid].frames > 0
  );
}

function allRequiredVideoAdvanced(before, after) {
  return ['video', 'video-alpha'].every((mid) =>
    before.videoByMid[mid] && after.videoByMid[mid] &&
      before.videoByMid[mid].framesDecodedAvailable &&
      after.videoByMid[mid].framesDecodedAvailable &&
      after.videoByMid[mid].bytes > before.videoByMid[mid].bytes &&
      after.videoByMid[mid].packets > before.videoByMid[mid].packets &&
      after.videoByMid[mid].frames > before.videoByMid[mid].frames
  );
}

async function waitForRequiredMediaAdvance(
  signal,
  page,
  uuid,
  peerName,
  timeoutMs,
  candidateAfterIndex = 0,
  baseline = null
) {
  const initialState = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
  const initial = baseline || requiredMediaCounters(initialState);
  const result = await waitForPeerState(
    signal,
    page,
    uuid,
    peerName,
    (state) => allRequiredMediaAdvanced(initial, requiredMediaCounters(state)),
    timeoutMs,
    candidateAfterIndex
  );
  return {
    ...result,
    initial,
    final: requiredMediaCounters(result.state)
  };
}

async function waitForRequiredVideoAdvance(
  signal,
  page,
  uuid,
  peerName,
  timeoutMs,
  candidateAfterIndex = 0,
  baseline = null
) {
  const initialState = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
  const initial = baseline || requiredMediaCounters(initialState);
  const result = await waitForPeerState(
    signal,
    page,
    uuid,
    peerName,
    (state) => allRequiredVideoAdvanced(initial, requiredMediaCounters(state)),
    timeoutMs,
    candidateAfterIndex
  );
  return {
    ...result,
    initial,
    final: requiredMediaCounters(result.state)
  };
}

async function waitForFreshVideo(signal, page, uuid, peerName, timeoutMs, candidateAfterIndex = 0) {
  const initialState = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
  const initial = mediaTotals(initialState);
  const result = await waitForPeerState(
    signal,
    page,
    uuid,
    peerName,
    (state) => {
      const current = mediaTotals(state);
      return current.bytes > initial.bytes && current.packets > initial.packets &&
        current.framesDecodedAvailable && current.frames > initial.frames;
    },
    timeoutMs,
    candidateAfterIndex
  );
  return {
    ...result,
    initial,
    final: mediaTotals(result.state)
  };
}

function selectedPairUsesRelay(state) {
  const pair = state && state.selectedPair;
  if (!pair || !pair.localCandidate || !pair.remoteCandidate) {
    return null;
  }
  return pair.localCandidate.candidateType === 'relay' ||
    pair.remoteCandidate.candidateType === 'relay';
}

function signaledCandidateTypes(signal, uuid, afterIndex = 0, beforeIndex = Number.MAX_SAFE_INTEGER) {
  return signal.events
    .slice(Math.max(0, afterIndex), Math.min(signal.events.length, beforeIndex))
    .map((entry) => entry.message)
    .filter((message) => message && message.UUID === uuid && message.candidate &&
      typeof message.candidate.candidate === 'string')
    .map((message) => {
      const match = message.candidate.candidate.match(/ typ ([a-z]+)/i);
      return match ? match[1].toLowerCase() : 'unknown';
    });
}

function extractIceUfrag(sdp) {
  const match = String(sdp || '').match(/^a=ice-ufrag:([^\r\n]+)/m);
  return match ? match[1] : '';
}

function sdpMediaLayout(sdp) {
  const layout = [];
  let current = null;
  for (const rawLine of String(sdp || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/);
      const kind = parts[0] || '';
      current = { kind, mid: '', codecs: [] };
      layout.push(current);
    } else if (current && line.startsWith('a=mid:')) {
      current.mid = line.slice('a=mid:'.length);
    } else if (current && line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
      if (match) {
        current.codecs.push({ payloadType: Number(match[1]), name: match[2].toUpperCase() });
      }
    }
  }
  return layout;
}

function vp9DualTrackContract(sdp) {
  const layout = sdpMediaLayout(sdp);
  const videoSections = layout.filter((section) => section.kind === 'video');
  const expectedMids = ['video', 'video-alpha'];
  return {
    ok: videoSections.length === expectedMids.length && expectedMids.every((mid) => {
      const section = videoSections.find((candidate) => candidate.mid === mid);
      return !!section && section.codecs.some((codec) => codec.name === 'VP9');
    }),
    videoSections
  };
}

function canonicalAlphaMediaOrder(sdp) {
  const layout = sdpMediaLayout(sdp);
  const order = layout.map((section) =>
    section.kind === 'video' && section.mid === 'video-alpha'
      ? 'video-alpha'
      : section.kind
  );
  return {
    ok: JSON.stringify(order) ===
      JSON.stringify(['video', 'audio', 'video-alpha', 'application']),
    layout,
    order
  };
}

function extractCandidateLineUfrag(candidate) {
  const wire = browserCandidateWire(candidate);
  const match = String(wire && wire.candidate ? wire.candidate : '')
    .match(/(?:^|\s)ufrag\s+([^\s]+)/i);
  return match ? match[1] : '';
}

function deepFreezeDiagnosticsSnapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeDiagnosticsSnapshot(child);
  }
  return Object.freeze(value);
}

let liveDiagnosticsContext = null;

function diagnosticsPeerSnapshot(document, uuid, observedAtMs) {
    const matches = deepFreezeDiagnosticsSnapshot(
      (Array.isArray(document.peers) ? document.peers : []).filter((entry) =>
        entry && entry.uuid === uuid
      )
    );
    const common = {
      generatedSteadyMs: Number(document.generated_steady_ms || 0),
      fileMtimeMs: observedAtMs,
      peerCount: matches.length,
      ambiguous: matches.length > 1
    };
    if (matches.length !== 1) {
      return deepFreezeDiagnosticsSnapshot({
        ...common,
        found: false,
        logicalSession: '',
        uuidOwnerHighWatermark: 0,
        activeWireSession: '',
        activeWireSessionSource: '',
        alphaAllowed: false,
        alphaReceiveMode: '',
        signaling: {},
        transport: {},
        lastConnectionState: '',
        lastOfferReason: '',
        lastAnswerSource: '',
        timeline: []
      });
    }
    const peer = matches[0];
    const signaling = deepFreezeDiagnosticsSnapshot({
      ...(peer.signaling || {})
    });
    const activeWireSessionSource = signaling.active_wire_session
      ? 'signaling.active_wire_session'
      : (peer.active_wire_session ? 'peer.active_wire_session' : 'peer.session');
    const activeWireSession = String(
      signaling.active_wire_session || peer.active_wire_session || peer.session || ''
    );
    return deepFreezeDiagnosticsSnapshot({
      ...common,
      found: true,
      logicalSession: String(peer.owner_session || peer.session || ''),
      uuidOwnerHighWatermark: Number(peer.uuid_owner_high_watermark || 0),
      activeWireSession,
      activeWireSessionSource,
      alphaAllowed: (peer.media && peer.media.alpha_allowed === true) ||
        peer.alpha_allowed === true,
      alphaReceiveMode: String(peer.alpha_receive_mode || ''),
      signaling,
      transport: peer.transport || {},
      lastConnectionState: peer.last_connection_state || '',
      lastOfferReason: peer.last_offer_reason || '',
      lastAnswerSource: peer.last_answer_source || '',
      timeline: Array.isArray(peer.timeline) ? peer.timeline.slice(-20) : []
    });
}

function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {
  try {
    const document = deepFreezeDiagnosticsSnapshot(
      JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'))
    );
    return diagnosticsPeerSnapshot(document, uuid, fs.statSync(diagnosticsPath).mtimeMs);
  } catch {
    // The packaged app rewrites this file in place. A transient partial read
    // is retried by waitForDiagnosticsPeerSnapshot instead of being mistaken
    // for product behavior.
    return null;
  }
}

async function readCurrentDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {
  if (liveDiagnosticsContext) {
    try {
      const document = deepFreezeDiagnosticsSnapshot(
        await getLocalControlDiagnostics(
          liveDiagnosticsContext.discovery,
          liveDiagnosticsContext.token
        )
      );
      return diagnosticsPeerSnapshot(document, uuid, Date.now());
    } catch {
      // Fall through to the periodic artifact below.
    }
  }
  return readDiagnosticsPeerSnapshot(diagnosticsPath, uuid);
}

async function waitForJsonFile(filePath, predicate, timeoutMs) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!predicate || predicate(lastValue)) {
        return { ok: true, elapsedMs: Date.now() - startedAt, value: lastValue };
      }
    } catch {
      // The producer may not have created or finished replacing the file yet.
    }
    await wait(25);
  }
  return { ok: false, elapsedMs: Date.now() - startedAt, value: lastValue };
}

async function postLocalControlCommand(discovery, token, command) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${discovery.base_url}/commands`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      elapsedMs: Date.now() - startedAt,
      error: String(error && error.message ? error.message : error)
    };
  }
}

async function getLocalControlDiagnostics(discovery, token) {
  const response = await fetch(`${discovery.base_url}/diagnostics`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2000)
  });
  if (!response.ok) {
    throw new Error(`Local diagnostics request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function sessionlessWssDownstreamState(snapshot) {
  if (!snapshot) {
    return null;
  }
  return {
    peerCount: snapshot.peerCount,
    activeWireSession: snapshot.activeWireSession,
    pendingRemoteCandidates: Number(snapshot.signaling.pending_remote_candidates || 0),
    answerCount: Number(snapshot.signaling.answer_count || 0),
    answerReceived: snapshot.signaling.answer_received,
    remoteCandidatesApplied: Number(
      snapshot.signaling.remote_candidates_applied || 0
    ),
    activeOfferGeneration: Number(snapshot.signaling.active_offer_generation || 0),
    activeTransportGeneration: Number(
      snapshot.signaling.active_transport_generation || 0
    ),
    clientTransportGeneration: Number(
      snapshot.signaling.client_transport_generation || 0
    ),
    offerDispatched: snapshot.signaling.offer_dispatched,
    offerCreationInProgress: snapshot.signaling.offer_creation_in_progress,
    transportRetired: snapshot.transport.transport_retired,
    dataChannelOpen: snapshot.transport.data_channel_open,
    lastConnectionState: snapshot.lastConnectionState
  };
}

function diagnosticsShowsRetiredGeneration(snapshot, expectedOfferGeneration) {
  if (!snapshot) {
    return false;
  }
  const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  const hasClosedOrFailedState = timeline.some((entry) =>
    /\bconnection-state (?:closed|failed)\b/i.test(String(entry))
  );
  return Number(snapshot.signaling.active_offer_generation || 0) === expectedOfferGeneration &&
    snapshot.transport.transport_retired === true && hasClosedOrFailedState;
}

async function waitForDiagnosticsPeerSnapshot(
  diagnosticsPath,
  uuid,
  predicate,
  afterGeneratedSteadyMs = 0,
  timeoutMs = 8000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await readCurrentDiagnosticsPeerSnapshot(diagnosticsPath, uuid);
    if (snapshot && snapshot.generatedSteadyMs > afterGeneratedSteadyMs && predicate(snapshot)) {
      return snapshot;
    }
    await wait(100);
  }
  return null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logHasExactToken(line, token) {
  if (!token) {
    return false;
  }
  const pattern = new RegExp(
    `(?:^|[\\s\\[({,])${escapeRegExp(token)}(?=$|[\\s\\])},;])`
  );
  return pattern.test(String(line || ''));
}

function exactIceSummaryToken(line, name) {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(name)}=([^\\s]+)(?=\\s|$)`,
    'g'
  );
  const matches = [...String(line || '').matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] : '';
}

function signalLineIdentifiesPeer(line, uuid, wireSession) {
  return logHasExactToken(line, `${uuid}:${wireSession}`) ||
    (logHasExactToken(line, `uuid=${uuid}`) &&
      logHasExactToken(line, `session=${wireSession}`));
}

function signalLineIdentifiesSha256(line, payloadSha256) {
  const expected = String(payloadSha256 || '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(expected) &&
    logHasExactToken(String(line || '').toLowerCase(), `sha256=${expected}`);
}

function explicitStaleCandidateRejectionLines(output, uuid, wireSession, candidateSha256) {
  return String(output || '').split(/\r?\n/).filter((line) =>
    /(?:ICE\s+)?candidate/i.test(line) &&
    /(?:ignor(?:e|ed|ing)|drop(?:ped|ping)?|reject(?:ed|ing)?)/i.test(line) &&
    /(?:stale|older|superseded|generation|ufrag|usernamefragment|mismatch)/i.test(line) &&
    signalLineIdentifiesPeer(line, uuid, wireSession) &&
    signalLineIdentifiesSha256(line, candidateSha256)
  );
}

function explicitStaleAnswerRejectionLines(output, uuid, wireSession) {
  return String(output || '').split(/\r?\n/).filter((line) =>
    /answer/i.test(line) &&
    !/(?:ICE\s+)?candidate/i.test(line) &&
    /(?:ignor(?:e|ed|ing)|drop(?:ped|ping)?|reject(?:ed|ing)?|no matching)/i.test(line) &&
    /(?:stale|older|superseded|replay|generation|identity|mismatch|no matching)/i.test(line) &&
    signalLineIdentifiesPeer(line, uuid, wireSession)
  );
}

function explicitSessionlessWssAnswerRejectionLines(
  output,
  uuid,
  activeWireSession,
  answerSdpSha256
) {
  const expectedSha256 = String(answerSdpSha256 || '').toLowerCase();
  return String(output || '').split(/\r?\n/).filter((line) =>
    /\[Signaling\] Rejecting publisher WebSocket answer\b/.test(line) &&
    logHasExactToken(line, 'reason=missing-session') &&
    logHasExactToken(line, `uuid=${uuid}`) &&
    logHasExactToken(line, 'source=signaling-wss') &&
    logHasExactToken(line, 'receivedSession=missing') &&
    logHasExactToken(line, `activeSession=${activeWireSession}`) &&
    /^[0-9a-f]{64}$/.test(expectedSha256) &&
    logHasExactToken(
      String(line || '').toLowerCase(),
      `answersdpsha256=${expectedSha256}`
    )
  );
}

function explicitSessionlessWssCandidateRejectionLines(
  output,
  uuid,
  activeWireSession,
  candidateSha256
) {
  const expectedSha256 = String(candidateSha256 || '').toLowerCase();
  return String(output || '').split(/\r?\n/).filter((line) =>
    /\[Signaling\] Rejecting publisher WebSocket remote ICE candidate\b/.test(line) &&
    logHasExactToken(line, 'reason=missing-session') &&
    logHasExactToken(line, `uuid=${uuid}`) &&
    logHasExactToken(line, 'source=signaling-wss') &&
    logHasExactToken(line, 'receivedSession=missing') &&
    logHasExactToken(line, `activeSession=${activeWireSession}`) &&
    /^[0-9a-f]{64}$/.test(expectedSha256) &&
    logHasExactToken(
      String(line || '').toLowerCase(),
      `candidatesha256=${expectedSha256}`
    )
  );
}

function exactDuplicateOfferRecheckLines(
  output,
  disposition,
  uuid,
  activeWireSession,
  identity,
  reason
) {
  const prefixes = {
    scheduled: '[Signaling] Scheduled unresolved duplicate offer recheck',
    coalesced: '[Signaling] Coalesced unresolved duplicate offer recheck',
    replacing: '[Signaling] Duplicate offer recheck replacing unresolved transport',
    canceled: '[Signaling] Duplicate offer recheck canceled'
  };
  const prefix = prefixes[disposition] || '';
  if (!prefix || !identity) {
    return [];
  }
  return String(output || '').split(/\r?\n/).filter((line) =>
    line.includes(prefix) &&
    logHasExactToken(line, `uuid=${uuid}`) &&
    logHasExactToken(line, `activeSession=${activeWireSession}`) &&
    logHasExactToken(line, `offerGeneration=${identity.offerGeneration}`) &&
    logHasExactToken(line, `transportGeneration=${identity.transportGeneration}`) &&
    logHasExactToken(line, `clientGeneration=${identity.clientGeneration}`) &&
    (disposition !== 'scheduled' || logHasExactToken(line, 'delayMs=1000')) &&
    logHasExactToken(line, `reason=${reason}`)
  );
}

async function setPeerRtcConfiguration(page, peerName, rtcConfig) {
  return page.evaluate(
    ({ name, config }) => window.__setGameCapturePeerConfiguration(name, config),
    { name: peerName, config: rtcConfig }
  );
}

async function probeBrowserTurn(page, rtcConfig) {
  return page.evaluate(
    (probeConfig) => window.__probeRelayCandidate(probeConfig, 12000),
    rtcConfig
  );
}

function summarizeTurnBrowserProbe(probe) {
  const relayCandidates = probe.candidates.filter((candidate) =>
    / typ relay/i.test(String(candidate.candidate || ''))
  );
  return {
    ok: relayCandidates.length > 0,
    relayCandidateCount: relayCandidates.length,
    candidateTypes: probe.candidates.map((candidate) => {
      const match = String(candidate.candidate || '').match(/ typ ([a-z]+)/i);
      return match ? match[1].toLowerCase() : 'unknown';
    }),
    errors: probe.errors
  };
}

async function probeTurnSocketAddress(parsed, address) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (ok, error = '', details = {}) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      resolve({ ok, error, ...details });
    };
    try {
      if (parsed.scheme === 'turns') {
        socket = tls.connect({
          host: address,
          port: parsed.port,
          servername: parsed.hostname,
          rejectUnauthorized: true
        });
        socket.once('secureConnect', () => finish(
          socket.authorized,
          socket.authorized ? '' : String(socket.authorizationError || 'tls-not-authorized'),
          {
            authorized: socket.authorized,
            protocol: socket.getProtocol() || '',
            peerSubject: socket.getPeerCertificate().subject || null
          }
        ));
      } else {
        socket = net.connect({ host: address, port: parsed.port });
        socket.once('connect', () => finish(true));
      }
      socket.setTimeout(8000, () => finish(false, 'socket-timeout'));
      socket.once('error', (error) => finish(false, String(error)));
    } catch (error) {
      finish(false, String(error));
    }
  });
}

async function probeSelectedTurnEndpoint(page, endpoint) {
  const nonUdpAddressCoverageUnambiguous = endpoint.udp ||
    endpoint.addresses.length === 1;
  const hostnameAttempts = [];
  const endpointRtcConfig = {
    iceServers: [browserTurnServer(endpoint)],
    iceTransportPolicy: 'relay'
  };
  for (let attempt = 1; attempt <= TURN_ENDPOINT_PROBE_ATTEMPTS; attempt++) {
    const probe = await probeBrowserTurn(page, endpointRtcConfig);
    hostnameAttempts.push({ attempt, ...summarizeTurnBrowserProbe(probe) });
  }

  const addressAttempts = [];
  for (const address of endpoint.addresses) {
    for (let attempt = 1; attempt <= TURN_ENDPOINT_PROBE_ATTEMPTS; attempt++) {
      if (endpoint.udp) {
        const addressServer = {
          ...browserTurnServer(endpoint),
          urls: turnUrlForAddress(endpoint.parsed, address)
        };
        const probe = await probeBrowserTurn(page, {
          iceServers: [addressServer],
          iceTransportPolicy: 'relay'
        });
        addressAttempts.push({
          address,
          attempt,
          transport: 'turn-allocation',
          ...summarizeTurnBrowserProbe(probe)
        });
      } else {
        const socketProbe = await probeTurnSocketAddress(endpoint.parsed, address);
        addressAttempts.push({
          address,
          attempt,
          transport: endpoint.parsed.scheme === 'turns' ? 'tls-with-sni' : 'tcp',
          ...socketProbe
        });
      }
    }
  }

  return {
    url: endpoint.urls,
    registryEndpointIdentity: endpoint.registryEndpointIdentity,
    locale: endpoint.locale,
    udp: endpoint.udp,
    addresses: endpoint.addresses,
    dnsErrors: endpoint.dnsErrors,
    nonUdpAddressCoverageUnambiguous,
    hostnameAttempts,
    addressAttempts
  };
}

async function connectNewPeer({
  config,
  signal,
  page,
  streamId,
  uuid,
  session: requestSessionHint,
  peerName,
  rtcConfig = DIRECT_BROWSER_RTC_CONFIG
}) {
  const searchStart = signal.events.length;
  requestOffer(signal, uuid, streamId, requestSessionHint);
  const offer = await signal.waitFor(isOfferFor(uuid), searchStart, config.offerTimeoutMs);
  if (!offer) {
    return {
      ok: false,
      reason: 'offer-timeout',
      requestSessionHint,
      activeSession: '',
      offer: null,
      state: null
    };
  }
  const activeSession = offer.message.session;
  if (!activeSession) {
    return {
      ok: false,
      reason: 'initial-offer-session-missing',
      requestSessionHint,
      activeSession,
      offer,
      state: null
    };
  }
  const sessionContractOk = !!activeSession && (
    requestSessionHint ? activeSession === requestSessionHint : true
  );
  const sessionContractReason = !sessionContractOk
    ? (requestSessionHint
      ? 'initial-offer-did-not-echo-request-session'
      : 'initial-offer-session-missing')
    : '';
  const answer = await answerOffer(page, peerName, offer.message, false, rtcConfig);
  sendBrowserCandidates(signal, uuid, offer.message.session, answer.candidates);
  sendAnswer(signal, uuid, streamId, offer.message.session, answer.sdp);
  const connected = await waitForPeerState(
    signal,
    page,
    uuid,
    peerName,
    (state) => state.connectionState === 'connected' && state.dataChannelOpen,
    15000,
    offer.index + 1
  );
  if (!connected.ok) {
    return {
      ok: false,
      reason: 'connection-timeout',
      sessionContractOk,
      sessionContractReason,
      requestSessionHint,
      activeSession,
      offer,
      answer,
      state: connected.state
    };
  }
  const media = await waitForFreshVideo(
    signal,
    page,
    uuid,
    peerName,
    12000,
    offer.index + 1
  );
  return {
    ok: connected.ok && media.ok,
    reason: media.ok ? '' : 'media-did-not-advance',
    sessionContractOk,
    sessionContractReason,
    requestSessionHint,
    activeSession,
    offer,
    answer,
    state: media.state || connected.state,
    media
  };
}

async function recoverScenarioPeer({
  config,
  report,
  signal,
  page,
  publisher,
  streamId,
  uuid,
  peerName,
  brokenSession,
  requestSessionHint,
  rtcConfig,
  fixtureLabel
}) {
  const removalOffset = publisher.output().length;
  signal.send({
    bye: true,
    UUID: uuid,
    session: brokenSession,
    streamID: streamId
  });
  const removalStarted = Date.now();
  let removedBrokenPeer = false;
  while (Date.now() - removalStarted < 8000) {
    const output = publisher.output().slice(removalOffset);
    if (new RegExp(`Removed peer session ${uuid}:`).test(output)) {
      removedBrokenPeer = true;
      break;
    }
    await wait(50);
  }
  requireHarnessFixture(
    report,
    `${fixtureLabel}-removes-broken-peer`,
    removedBrokenPeer,
    {
      uuid,
      brokenSession,
      outputTail: publisher.output().slice(removalOffset).slice(-4000)
    }
  );

  const recovery = await connectNewPeer({
    config,
    signal,
    page,
    streamId,
    uuid,
    session: requestSessionHint,
    peerName,
    rtcConfig
  });
  const liveState = await page.evaluate(
    (name) => window.__gameCapturePeerState(name),
    peerName
  );
  requireHarnessFixture(
    report,
    `${fixtureLabel}-establishes-distinct-live-peer`,
    recovery.ok && !!recovery.activeSession &&
      recovery.activeSession !== brokenSession &&
      !!liveState && liveState.wireSession === recovery.activeSession,
    {
      uuid,
      brokenSession,
      requestSessionHint,
      recoveryReason: recovery.reason,
      recoveryActiveSession: recovery.activeSession,
      liveWireSession: liveState ? liveState.wireSession : '',
      state: recovery.state
    }
  );
  return recovery;
}

async function remoteFirstRestart({
  config,
  report,
  signal,
  page,
  streamId,
  uuid,
  session: previousActiveSession,
  requestSessionHint = previousActiveSession,
  peerName,
  rtcConfig,
  expectedRelay = null
}) {
  const before = await page.evaluate((name) => window.__gameCapturePeerState(name), peerName);
  const previousBrowserWireSession = before && before.wireSession;
  requireHarnessFixture(
    report,
    `${peerName}-browser-active-wire-session-matches-restart-caller`,
    !!before && !!previousBrowserWireSession &&
      previousBrowserWireSession === previousActiveSession,
    {
      callerSession: previousActiveSession,
      browserWireSession: previousBrowserWireSession,
      peerInstanceId: before ? before.peerInstanceId : null
    }
  );
  const previousUfrag = before && before.remoteDescriptionUfrag;
  const searchStart = signal.events.length;
  signal.send({
    UUID: uuid,
    session: requestSessionHint,
    streamID: streamId,
    iceRestartRequest: true
  });
  const offer = await signal.waitFor(isOfferFor(uuid), searchStart, config.offerTimeoutMs);
  if (!offer) {
    return { ok: false, reason: 'restart-offer-timeout', before, offer: null };
  }
  const activeSession = offer.message.session;
  const offerUfrag = extractIceUfrag(offer.message.description.sdp);
  if (!activeSession) {
    return {
      ok: false,
      workflowOk: false,
      sessionContractOk: false,
      sessionRotated: false,
      reason: 'restart-wire-session-missing',
      before,
      previousSession: previousBrowserWireSession,
      requestSessionHint,
      activeSession,
      previousUfrag,
      offer,
      offerUfrag
    };
  }
  const sessionRotated = !!activeSession && activeSession !== previousBrowserWireSession;
  const reuseBrowserPeer = !sessionRotated;
  let answer = null;
  try {
    answer = await answerOffer(page, peerName, offer.message, reuseBrowserPeer, rtcConfig);
  } catch (error) {
    return {
      ok: false,
      workflowOk: false,
      sessionContractOk: false,
      sessionRotated,
      reason: 'browser-rejected-restart-offer',
      error: String(error && error.message ? error.message : error),
      before,
      previousSession: previousBrowserWireSession,
      requestSessionHint,
      activeSession,
      previousUfrag,
      offer,
      offerUfrag,
      state: await page.evaluate((name) => window.__gameCapturePeerState(name), peerName)
    };
  }
  const replacedBrowserPeer = !!before &&
    answer.peerInstanceId !== before.peerInstanceId;
  const browserPeerDispositionMatchesSession = sessionRotated
    ? replacedBrowserPeer
    : !!before && answer.peerInstanceId === before.peerInstanceId;
  if (!browserPeerDispositionMatchesSession) {
    return {
      ok: false,
      workflowOk: false,
      sessionContractOk: false,
      sessionRotated,
      reason: 'restart-browser-peer-disposition-mismatched-session',
      before,
      previousSession: previousBrowserWireSession,
      requestSessionHint,
      activeSession,
      previousUfrag,
      offer,
      offerUfrag,
      answer
    };
  }
  sendBrowserCandidates(signal, uuid, activeSession, answer.candidates);
  sendAnswer(signal, uuid, streamId, activeSession, answer.sdp);
  const connected = await waitForPeerState(
    signal,
    page,
    uuid,
    peerName,
    (state) => state.connectionState === 'connected' && state.dataChannelOpen &&
      state.signalingState === 'stable' &&
      (expectedRelay === null || selectedPairUsesRelay(state) === expectedRelay),
    18000,
    offer.index + 1
  );
  const media = connected.ok ? await waitForFreshVideo(
    signal,
    page,
    uuid,
    peerName,
    12000,
    offer.index + 1
  ) : { ok: false, state: connected.state, initial: {}, final: {} };
  const workflowOk = connected.ok && media.ok;
  const sessionContractOk = sessionRotated && replacedBrowserPeer;
  return {
    ok: sessionContractOk && workflowOk,
    workflowOk,
    sessionContractOk,
    sessionRotated,
    reason: !sessionRotated
      ? 'restart-wire-session-not-rotated'
      : (!connected.ok
        ? 'restart-connection-timeout'
        : (!media.ok ? 'restart-media-did-not-advance' : '')),
    before,
    previousSession: previousBrowserWireSession,
    requestSessionHint,
    activeSession,
    replacedBrowserPeer,
    previousUfrag,
    offer,
    offerUfrag,
    answer,
    state: media.state || connected.state,
    media
  };
}

function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

function makeTransportFailureAnswer(sdp) {
  const invalidFingerprint = Array(32).fill('00').join(':');
  return sdp.replace(/^a=fingerprint:sha-256 [0-9A-F:]+$/gmi,
    `a=fingerprint:sha-256 ${invalidFingerprint}`);
}

function addCheck(report, name, ok, state) {
  report.checks.push({ name, ok: !!ok, classification: 'behavior', state: state || {} });
  console.log(`[SIGNAL-E2E] ${name} ${ok ? 'PASS' : 'FAIL'}`);
}

function addEvidence(report, name, state) {
  report.evidence.push({ name, state: state || {} });
  console.log(`[SIGNAL-E2E] ${name} EVIDENCE`);
}

function requireHarnessFixture(report, name, ok, state) {
  const requirement = { name, ok: !!ok, classification: 'harness-prerequisite', state: state || {} };
  report.harnessRequirements.push(requirement);
  console.log(`[SIGNAL-E2E] ${name} ${ok ? 'READY' : 'BLOCKED'}`);
  if (!ok) {
    const error = new Error(`Harness prerequisite failed: ${name}`);
    error.harnessRequirement = requirement;
    throw error;
  }
}

async function waitForPublisherReady(
  signal,
  publisher,
  report,
  checkName = 'packaged-publisher-connects-and-seeds',
  mediaFixture = null
) {
  const binding = await waitForPublisherSpoutBinding(publisher, mediaFixture, 15000);
  requireHarnessFixture(
    report,
    `${checkName}-publisher-binds-explicit-spout-source`,
    binding.ok,
    binding
  );
  const seed = await signal.waitFor(
    (message) => message.request === 'seed' && typeof message.streamID === 'string',
    0,
    15000
  );
  addCheck(report, checkName, !!seed, {
    publisher: publisher.executable,
    args: publisher.args,
    outputTail: publisher.output().slice(-3000)
  });
  return seed;
}

async function waitForPublisherSpoutBinding(publisher, mediaFixture, timeoutMs) {
  const expectedSender = mediaFixture && mediaFixture.senderName
    ? mediaFixture.senderName
    : '';
  const expectedSourceArgument = '--source=spout';
  const expectedSenderArgument = expectedSender
    ? `--spout-sender=${expectedSender}`
    : '';
  const startedAt = Date.now();
  let output = '';
  while (Date.now() - startedAt < timeoutMs) {
    output = publisher.output();
    const fixtureAlive = !!(mediaFixture && mediaFixture.spout &&
      mediaFixture.spout.child.exitCode === null &&
      mediaFixture.spout.child.signalCode === null);
    const sourceArgumentExact = publisher.args.includes(expectedSourceArgument);
    const senderArgumentExact = !!expectedSenderArgument &&
      publisher.args.includes(expectedSenderArgument);
    const selectedExactSender = !!expectedSender &&
      output.includes(`capturing: ${expectedSender} [`);
    const openedExactSender = !!expectedSender &&
      output.includes(`[SpoutCapture] Started sender='${expectedSender}'`);
    if (fixtureAlive && sourceArgumentExact && senderArgumentExact &&
        selectedExactSender && openedExactSender) {
      return {
        ok: true,
        fixtureAlive,
        expectedSender,
        sourceArgumentExact,
        senderArgumentExact,
        selectedExactSender,
        openedExactSender,
        elapsedMs: Date.now() - startedAt,
        outputTail: output.slice(-3000)
      };
    }
    if (!fixtureAlive || publisher.child.exitCode !== null || publisher.child.signalCode !== null) {
      return {
        ok: false,
        fixtureAlive,
        expectedSender,
        sourceArgumentExact,
        senderArgumentExact,
        selectedExactSender,
        openedExactSender,
        publisherExitCode: publisher.child.exitCode,
        publisherSignalCode: publisher.child.signalCode,
        elapsedMs: Date.now() - startedAt,
        outputTail: output.slice(-3000)
      };
    }
    await wait(50);
  }
  const fixtureAlive = !!(mediaFixture && mediaFixture.spout &&
    mediaFixture.spout.child.exitCode === null &&
    mediaFixture.spout.child.signalCode === null);
  return {
    ok: false,
    fixtureAlive,
    expectedSender,
    sourceArgumentExact: publisher.args.includes(expectedSourceArgument),
    senderArgumentExact: !!expectedSenderArgument && publisher.args.includes(expectedSenderArgument),
    selectedExactSender: !!expectedSender && output.includes(`capturing: ${expectedSender} [`),
    openedExactSender: !!expectedSender &&
      output.includes(`[SpoutCapture] Started sender='${expectedSender}'`),
    publisherExitCode: publisher.child.exitCode,
    publisherSignalCode: publisher.child.signalCode,
    elapsedMs: Date.now() - startedAt,
    outputTail: output.slice(-3000)
  };
}

async function enableAlphaAndVerifyMedia({
  config,
  report,
  signal,
  page,
  streamId,
  uuid,
  session,
  peerName,
  rtcConfig = DIRECT_BROWSER_RTC_CONFIG,
  afterIndex = 0,
  initialOffer = null,
  allowVideoOnlyWorkflow = false,
  validateFullMedia = true
}) {
  const liveAlphaState = await page.evaluate(
    (name) => window.__gameCapturePeerState(name),
    peerName
  );
  requireHarnessFixture(
    report,
    `${peerName}-alpha-browser-session-matches-caller-and-initial-offer`,
    !!liveAlphaState && !!liveAlphaState.peerInstanceId &&
      liveAlphaState.wireSession === session &&
      !!initialOffer && !!initialOffer.message &&
      session === initialOffer.message.session,
    {
      callerSession: session,
      browserWireSession: liveAlphaState ? liveAlphaState.wireSession : '',
      initialOfferSession: initialOffer && initialOffer.message
        ? initialOffer.message.session
        : '',
      peerInstanceId: liveAlphaState ? liveAlphaState.peerInstanceId : null
    }
  );
  const initialAlphaLayout = canonicalAlphaMediaOrder(
    initialOffer && initialOffer.message && initialOffer.message.description
      ? initialOffer.message.description.sdp
      : ''
  );
  const alphaCapability = {
    audio: true,
    video: true,
    broadcast: false,
    info: {
      label: 'Lifecycle Alpha Receiver',
      platform: 'OBS',
      Browser: 'OBS VDO.Ninja Native Receiver',
      alpha_receive: 'vp9-dualtrack-v1'
    }
  };
  const searchStart = signal.events.length;
  const workflowMediaIsNonzero = (state) => {
    const counters = requiredMediaCounters(state);
    return allowVideoOnlyWorkflow
      ? requiredVideoIsNonzero(counters)
      : requiredMediaIsNonzero(counters);
  };
  const sent = await page.evaluate(
    ({ name, payload }) => window.__sendGameCaptureData(name, payload),
    { name: peerName, payload: alphaCapability }
  );
  if (!sent) {
    return {
      ok: false,
      reason: 'alpha-capability-datachannel-send-failed',
      offer: initialOffer,
      initialAlphaReserved: initialAlphaLayout.ok,
      initialMediaLayout: initialAlphaLayout.layout,
      usedLateAlphaOffer: false
    };
  }
  const transition = await waitForAlphaActivationOrOffer({
    signal,
    page,
    uuid,
    peerName,
    afterIndex: searchStart,
    timeoutMs: 20000,
    activationPredicate: (state) => state.connectionState === 'connected' &&
      state.dataChannelOpen && state.signalingState === 'stable' &&
      state.mids.includes('video-alpha') &&
      workflowMediaIsNonzero(state)
  });
  const lateOffer = transition.offer;
  let mediaPresent = transition.kind === 'activated-without-offer'
    ? { ok: true, state: transition.state }
    : null;
  let candidateAfterIndex = Math.max(afterIndex, searchStart);
  if (lateOffer) {
    if (!initialOffer || !initialOffer.message || !initialOffer.message.session ||
        !lateOffer.message.session ||
        lateOffer.message.session !== initialOffer.message.session) {
      return {
        ok: false,
        reason: 'alpha-renegotiation-rotated-or-omitted-wire-session',
        offer: lateOffer,
        lateOffer,
        state: transition.state,
        initialAlphaReserved: initialAlphaLayout.ok,
        initialMediaLayout: initialAlphaLayout.layout,
        usedLateAlphaOffer: true
      };
    }
    const answer = await answerOffer(page, peerName, lateOffer.message, true, rtcConfig);
    sendBrowserCandidates(signal, uuid, lateOffer.message.session, answer.candidates);
    sendAnswer(
      signal,
      uuid,
      streamId,
      lateOffer.message.session,
      answer.sdp
    );
    candidateAfterIndex = Math.max(candidateAfterIndex, lateOffer.index + 1);
    mediaPresent = await waitForPeerState(
      signal,
      page,
      uuid,
      peerName,
      (state) => state.connectionState === 'connected' && state.dataChannelOpen &&
        state.signalingState === 'stable' && state.mids.includes('video-alpha') &&
        workflowMediaIsNonzero(state),
      20000,
      candidateAfterIndex
    );
  } else if (!mediaPresent) {
    return {
      ok: false,
      reason: 'alpha-activation-or-legacy-renegotiation-timeout',
      offer: initialOffer,
      lateOffer: null,
      state: transition.state,
      counters: requiredMediaCounters(transition.state),
      initialAlphaReserved: initialAlphaLayout.ok,
      initialMediaLayout: initialAlphaLayout.layout,
      usedLateAlphaOffer: false
    };
  }
  if (!mediaPresent.ok) {
    return {
      ok: false,
      reason: 'required-audio-primary-alpha-media-not-present',
      offer: lateOffer || initialOffer,
      lateOffer,
      state: mediaPresent.state,
      counters: requiredMediaCounters(mediaPresent.state),
      initialAlphaReserved: initialAlphaLayout.ok,
      initialMediaLayout: initialAlphaLayout.layout,
      usedLateAlphaOffer: !!lateOffer
    };
  }
  const fullMediaBaseline = requiredMediaCounters(mediaPresent.state);
  const fullMediaAdvancing = validateFullMedia
    ? await waitForRequiredMediaAdvance(
      signal,
      page,
      uuid,
      peerName,
      12000,
      candidateAfterIndex,
      fullMediaBaseline
    )
    : {
      ok: false,
      state: mediaPresent.state,
      initial: fullMediaBaseline,
      final: fullMediaBaseline,
      skippedBecausePriorAudioProductFailure: true
    };
  const workflowAdvancing = allowVideoOnlyWorkflow && !fullMediaAdvancing.ok
    ? await waitForRequiredVideoAdvance(
      signal,
      page,
      uuid,
      peerName,
      12000,
      candidateAfterIndex,
      fullMediaBaseline
    )
    : fullMediaAdvancing;
  return {
    ok: fullMediaAdvancing.ok,
    workflowOk: workflowAdvancing.ok,
    reason: fullMediaAdvancing.ok
      ? ''
      : (workflowAdvancing.ok
        ? 'required-audio-media-did-not-advance'
        : 'required-media-counters-did-not-advance'),
    offer: lateOffer || initialOffer,
    lateOffer,
    state: workflowAdvancing.state || fullMediaAdvancing.state || mediaPresent.state,
    initial: fullMediaAdvancing.initial,
    final: fullMediaAdvancing.final,
    workflowInitial: workflowAdvancing.initial,
    workflowFinal: workflowAdvancing.final,
    initialAlphaReserved: initialAlphaLayout.ok,
    initialMediaLayout: initialAlphaLayout.layout,
    usedLateAlphaOffer: !!lateOffer
  };
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, exitCode: child.exitCode, signalCode: child.signalCode };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve({ exited: false, exitCode: child.exitCode, signalCode: child.signalCode });
    }, timeoutMs);
    const onExit = (exitCode, signalCode) => {
      clearTimeout(timer);
      resolve({ exited: true, exitCode, signalCode });
    };
    child.once('exit', onExit);
  });
}

async function runNegotiationScenario(config, executable, browser, report, mediaFixture) {
  const signal = await startSignalServer();
  const streamId = `signal_regression_${Date.now()}`;
  fs.mkdirSync(config.reportDir, { recursive: true });
  const diagnosticsPath = path.join(
    config.reportDir,
    `signaling-negotiation-diagnostics-${process.pid}-${Date.now()}.json`
  );
  const localControlDiscoveryPath = path.join(
    config.reportDir,
    `signaling-negotiation-local-control-${process.pid}-${Date.now()}.json`
  );
  const localControlToken = crypto.randomBytes(24).toString('hex');
  const publisher = startPublisher(executable, signal.url, {
    streamId,
    iceMode: 'host-only',
    alpha: true,
    source: 'spout',
    spoutSender: mediaFixture.senderName,
    diagnosticsOut: diagnosticsPath,
    localControlDiscovery: localControlDiscoveryPath,
    localControlToken
  });
  report.negotiationDiagnosticsPath = diagnosticsPath;
  report.negotiationLocalControlDiscoveryPath = localControlDiscoveryPath;
  const { context, page } = await createBrowserPeerPage(browser);
  try {
    const seed = await waitForPublisherReady(
      signal,
      publisher,
      report,
      'packaged-publisher-connects-and-seeds',
      mediaFixture
    );
    if (!seed) {
      return;
    }

    const duplicateUuid = 'duplicate-offer-viewer';
    const duplicateRequestSessionA = 'ignored-request-session-a';
    const duplicateRequestSessionB = 'ignored-request-session-b';
    const duplicateRequestSessionC = 'ignored-request-session-c';
    const requestAt = Date.now();
    const duplicateSearchStart = signal.events.length;
    requestOffer(signal, duplicateUuid, streamId, duplicateRequestSessionA);
    const first = await signal.waitFor(
      isOfferFor(duplicateUuid), duplicateSearchStart, config.offerTimeoutMs
    );
    addCheck(report, 'initial-offer-arrives', !!first, { elapsedMs: Date.now() - requestAt });
    if (first) {
      const firstUfrag = extractIceUfrag(first.message.description.sdp);
      addCheck(report, 'initial-offer-does-not-hit-two-second-fallback', first.at - requestAt < 1000, {
        elapsedMs: first.at - requestAt,
        session: first.message.session
      });
      addCheck(report, 'initial-offer-echoes-viewer-request-session',
        first.message.session === duplicateRequestSessionA,
        {
          requestSession: duplicateRequestSessionA,
          offerSession: first.message.session,
          offerUfrag: firstUfrag
        });

      const preDuplicatePeerSnapshot = await waitForDiagnosticsPeerSnapshot(
        diagnosticsPath,
        duplicateUuid,
        (snapshot) => snapshot.peerCount === 1 && !snapshot.ambiguous &&
          snapshot.activeWireSession === first.message.session &&
          Number(snapshot.signaling.active_offer_generation) > 0 &&
          Number(snapshot.signaling.active_transport_generation) > 0 &&
          Number(snapshot.signaling.client_transport_generation) > 0,
        0,
        8000
      );
      requireHarnessFixture(report, 'duplicate-peer-diagnostics-baseline-is-current',
        !!preDuplicatePeerSnapshot && !!firstUfrag,
        {
          expectedWireSession: first.message.session,
          offerUfrag: firstUfrag,
          snapshot: preDuplicatePeerSnapshot
        });
      const duplicateAIdentity = {
        offerGeneration: Number(
          preDuplicatePeerSnapshot.signaling.active_offer_generation
        ),
        transportGeneration: Number(
          preDuplicatePeerSnapshot.signaling.active_transport_generation
        ),
        clientGeneration: Number(
          preDuplicatePeerSnapshot.signaling.client_transport_generation
        )
      };
      const duplicateTransitionOutputOffset = publisher.output().length;
      const duplicateRequestAt = Date.now();
      const duplicateReplacementSearchStart = signal.events.length;
      requestOffer(signal, duplicateUuid, streamId, duplicateRequestSessionB);
      await wait(150);
      requestOffer(signal, duplicateUuid, streamId, duplicateRequestSessionC);

      const duplicateNoEarlyOfferObservationMs = 750;
      const remainingNoEarlyObservationMs = Math.max(
        0,
        duplicateNoEarlyOfferObservationMs - (Date.now() - duplicateRequestAt)
      );
      if (remainingNoEarlyObservationMs > 0) {
        await wait(remainingNoEarlyObservationMs);
      }
      const earlyDuplicateOffers = signal.events
        .slice(duplicateReplacementSearchStart)
        .map((entry, offset) => ({
          ...entry,
          index: duplicateReplacementSearchStart + offset
        }))
        .filter((entry) => entry.message && isOfferFor(duplicateUuid)(entry.message));
      let second = earlyDuplicateOffers[0] || await signal.waitFor(
        isOfferFor(duplicateUuid),
        duplicateReplacementSearchStart,
        3500
      );
      const duplicateReplacementElapsedMs = second
        ? second.at - duplicateRequestAt
        : null;
      const duplicatePostReplacementQuiescenceMs = 1000;
      await wait(duplicatePostReplacementQuiescenceMs);
      const duplicateReplacementOffers = signal.events
        .slice(duplicateReplacementSearchStart)
        .map((entry, offset) => ({
          ...entry,
          index: duplicateReplacementSearchStart + offset
        }))
        .filter((entry) => entry.message && isOfferFor(duplicateUuid)(entry.message));
      if (!second && duplicateReplacementOffers.length > 0) {
        second = duplicateReplacementOffers[0];
      }
      const secondUfrag = second
        ? extractIceUfrag(second.message.description.sdp)
        : '';
      const duplicateFreshReplacementShape = !!second &&
        !!second.message.session &&
        second.message.session !== first.message.session &&
        second.message.session !== duplicateRequestSessionA &&
        second.message.session !== duplicateRequestSessionB &&
        second.message.session !== duplicateRequestSessionC &&
        second.message.session !== 'default' &&
        second.message.description.sdp !== first.message.description.sdp &&
        !!secondUfrag && secondUfrag !== firstUfrag;
      const unresolvedDuplicateReplacementVerdict =
        earlyDuplicateOffers.length === 0 &&
        duplicateReplacementOffers.length === 1 &&
        duplicateFreshReplacementShape &&
        Number.isFinite(duplicateReplacementElapsedMs) &&
        duplicateReplacementElapsedMs >= duplicateNoEarlyOfferObservationMs &&
        duplicateReplacementElapsedMs <= 2500;
      addCheck(
        report,
        'unresolved-duplicate-waits-then-creates-exactly-one-fresh-offer',
        unresolvedDuplicateReplacementVerdict,
        {
          minimumDelayMs: duplicateNoEarlyOfferObservationMs,
          maximumDelayMs: 2500,
          elapsedMs: duplicateReplacementElapsedMs,
          postReplacementQuiescenceMs: duplicatePostReplacementQuiescenceMs,
          earlyOfferCount: earlyDuplicateOffers.length,
          replacementOfferCount: duplicateReplacementOffers.length,
          firstRequestSession: duplicateRequestSessionA,
          secondRequestSession: duplicateRequestSessionB,
          coalescedRequestSession: duplicateRequestSessionC,
          firstSession: first.message.session,
          secondSession: second ? second.message.session : '',
          firstUfrag,
          secondUfrag,
          sameSdp: second
            ? second.message.description.sdp === first.message.description.sdp
            : null
        }
      );

      const duplicateTransitionOutput = publisher.output()
        .slice(duplicateTransitionOutputOffset);
      const scheduledDuplicateRechecks = exactDuplicateOfferRecheckLines(
        duplicateTransitionOutput,
        'scheduled',
        duplicateUuid,
        first.message.session,
        duplicateAIdentity,
        'duplicate-offer-request'
      );
      const coalescedDuplicateRechecks = exactDuplicateOfferRecheckLines(
        duplicateTransitionOutput,
        'coalesced',
        duplicateUuid,
        first.message.session,
        duplicateAIdentity,
        'duplicate-offer-request'
      );
      const replacingDuplicateRechecks = exactDuplicateOfferRecheckLines(
        duplicateTransitionOutput,
        'replacing',
        duplicateUuid,
        first.message.session,
        duplicateAIdentity,
        'duplicate-offer-request'
      );
      const duplicateConnectedCancellations = exactDuplicateOfferRecheckLines(
        duplicateTransitionOutput,
        'canceled',
        duplicateUuid,
        first.message.session,
        duplicateAIdentity,
        'connected'
      );
      const duplicateTransitionLines = duplicateTransitionOutput.split(/\r?\n/);
      const scheduledLineIndex = duplicateTransitionLines.indexOf(
        scheduledDuplicateRechecks[0]
      );
      const coalescedLineIndex = duplicateTransitionLines.indexOf(
        coalescedDuplicateRechecks[0]
      );
      const replacingLineIndex = duplicateTransitionLines.indexOf(
        replacingDuplicateRechecks[0]
      );
      const duplicateRecheckLogVerdict =
        scheduledDuplicateRechecks.length === 1 &&
        coalescedDuplicateRechecks.length === 1 &&
        replacingDuplicateRechecks.length === 1 &&
        duplicateConnectedCancellations.length === 0 &&
        scheduledLineIndex >= 0 &&
        coalescedLineIndex > scheduledLineIndex &&
        replacingLineIndex > coalescedLineIndex;
      addCheck(
        report,
        'unresolved-duplicate-recheck-binds-and-revalidates-exact-offer-a-identity',
        duplicateRecheckLogVerdict,
        {
          identity: duplicateAIdentity,
          scheduledLines: scheduledDuplicateRechecks,
          coalescedLines: coalescedDuplicateRechecks,
          replacingLines: replacingDuplicateRechecks,
          connectedCancellationLines: duplicateConnectedCancellations,
          outputTail: duplicateTransitionOutput.slice(-6000)
        }
      );

      const activeDuplicateOffer = duplicateFreshReplacementShape ? second : first;
      const duplicatePeerSnapshot = await waitForDiagnosticsPeerSnapshot(
        diagnosticsPath,
        duplicateUuid,
        (snapshot) => snapshot.peerCount === 1 &&
          snapshot.generatedSteadyMs > preDuplicatePeerSnapshot.generatedSteadyMs &&
          snapshot.activeWireSession === activeDuplicateOffer.message.session,
        preDuplicatePeerSnapshot.generatedSteadyMs,
        8000
      );
      addCheck(report, 'duplicate-offer-request-keeps-one-uuid-scoped-publisher-peer',
        !!duplicatePeerSnapshot && duplicatePeerSnapshot.peerCount === 1 &&
          duplicatePeerSnapshot.ambiguous === false &&
          duplicatePeerSnapshot.uuidOwnerHighWatermark === 1 &&
          duplicatePeerSnapshot.logicalSession === preDuplicatePeerSnapshot.logicalSession &&
          duplicatePeerSnapshot.activeWireSession === activeDuplicateOffer.message.session &&
          (!duplicateFreshReplacementShape ||
            (Number(duplicatePeerSnapshot.signaling.active_transport_generation) >
                duplicateAIdentity.transportGeneration &&
              Number(duplicatePeerSnapshot.signaling.client_transport_generation) >
                duplicateAIdentity.clientGeneration)),
        {
          expectedWireSession: activeDuplicateOffer.message.session,
          expectedLogicalSession: preDuplicatePeerSnapshot.logicalSession,
          replacementContractOk: unresolvedDuplicateReplacementVerdict,
          snapshot: duplicatePeerSnapshot
        });

      const beforeAnswers = publisher.output().length;
      const duplicateAnswer = await answerOffer(
        page, 'duplicate-peer', activeDuplicateOffer.message, false, DIRECT_BROWSER_RTC_CONFIG
      );
      sendBrowserCandidates(
        signal, duplicateUuid, activeDuplicateOffer.message.session, duplicateAnswer.candidates
      );
      sendAnswer(
        signal,
        duplicateUuid,
        streamId,
        activeDuplicateOffer.message.session,
        duplicateAnswer.sdp
      );
      const duplicateConnected = await waitForPeerState(
        signal,
        page,
        duplicateUuid,
        'duplicate-peer',
        (state) => state.connectionState === 'connected' && state.dataChannelOpen,
        15000,
        activeDuplicateOffer.index + 1
      );
      const duplicateMedia = duplicateConnected.ok ? await waitForFreshVideo(
        signal,
        page,
        duplicateUuid,
        'duplicate-peer',
        12000,
        activeDuplicateOffer.index + 1
      ) : { ok: false, state: duplicateConnected.state };
      addCheck(report, 'duplicate-request-offer-establishes-data-and-media',
        duplicateConnected.ok && duplicateMedia.ok, {
          state: duplicateMedia.state || duplicateConnected.state,
          media: { initial: duplicateMedia.initial, final: duplicateMedia.final }
        });

      sendAnswer(
        signal,
        duplicateUuid,
        streamId,
        activeDuplicateOffer.message.session,
        duplicateAnswer.sdp
      );
      await wait(750);
      const replayOutput = publisher.output().slice(beforeAnswers);
      const replayIgnored = /Ignoring stale or replayed answer/i.test(replayOutput);
      const replayMedia = await waitForFreshVideo(
        signal,
        page,
        duplicateUuid,
        'duplicate-peer',
        8000,
        activeDuplicateOffer.index + 1
      );
      addCheck(report, 'exact-answer-replay-is-ignored-with-transport-intact',
        replayIgnored &&
          countOccurrences(replayOutput, '[App] Applying peer answer') === 1 &&
          replayMedia.ok, {
          replayIgnored,
          applyingAnswerCount: countOccurrences(replayOutput, '[App] Applying peer answer'),
          media: { initial: replayMedia.initial, final: replayMedia.final },
          outputTail: replayOutput.slice(-5000)
        });

      const localControlDiscovery = await waitForJsonFile(
        localControlDiscoveryPath,
        (value) => value && value.schema === 'game-capture-local-control-v1' &&
          typeof value.base_url === 'string' && value.base_url.startsWith('http://127.0.0.1:'),
        5000
      );
      requireHarnessFixture(
        report,
        'packaged-local-control-discovery-is-ready',
        localControlDiscovery.ok,
        {
          path: localControlDiscoveryPath,
          elapsedMs: localControlDiscovery.elapsedMs,
          discovery: localControlDiscovery.value
        }
      );
      if (localControlDiscovery.ok) {
        liveDiagnosticsContext = {
          discovery: localControlDiscovery.value,
          token: localControlToken
        };
      }
      let liveDiagnostics = null;
      try {
        liveDiagnostics = liveDiagnosticsContext
          ? await getLocalControlDiagnostics(
            liveDiagnosticsContext.discovery,
            liveDiagnosticsContext.token
          )
          : null;
      } catch {
        liveDiagnostics = null;
      }
      requireHarnessFixture(
        report,
        'packaged-local-control-live-diagnostics-is-ready',
        !!liveDiagnostics && liveDiagnostics.schema === 'game-capture-diagnostics-v1' &&
          Number(liveDiagnostics.generated_steady_ms || 0) > 0,
        { schema: liveDiagnostics ? liveDiagnostics.schema : '' }
      );
      const localRefreshOfferSearchStart = signal.events.length;
      const localRefreshOutputOffset = publisher.output().length;
      const localRefreshResponse = await postLocalControlCommand(
        localControlDiscovery.value,
        localControlToken,
        'refresh_peer_transports'
      );
      addCheck(
        report,
        'local-control-refresh-is-accepted-without-blocking-http-response',
        localRefreshResponse.ok && localRefreshResponse.status === 200 &&
          localRefreshResponse.body &&
          localRefreshResponse.body.command === 'refresh_peer_transports' &&
          localRefreshResponse.body.accepted_peer_count === 1 &&
          localRefreshResponse.elapsedMs < 500,
        {
          response: localRefreshResponse,
          maximumResponseMs: 500,
          outputTail: publisher.output().slice(localRefreshOutputOffset).slice(-4000)
        }
      );
      const localRefreshOffer = await signal.waitFor(
        isOfferFor(duplicateUuid),
        localRefreshOfferSearchStart,
        config.offerTimeoutMs
      );
      addCheck(
        report,
        'local-control-refresh-rotates-the-live-peer-transport',
        !!localRefreshOffer &&
          localRefreshOffer.message.session !== activeDuplicateOffer.message.session &&
          localRefreshOffer.message.description.sdp !==
            activeDuplicateOffer.message.description.sdp,
        {
          previousSession: activeDuplicateOffer.message.session,
          activeSession: localRefreshOffer ? localRefreshOffer.message.session : '',
          response: localRefreshResponse,
          outputTail: publisher.output().slice(localRefreshOutputOffset).slice(-5000)
        }
      );
      if (localRefreshOffer) {
        const localRefreshAnswer = await answerOffer(
          page,
          'duplicate-peer',
          localRefreshOffer.message,
          false,
          DIRECT_BROWSER_RTC_CONFIG
        );
        sendBrowserCandidates(
          signal,
          duplicateUuid,
          localRefreshOffer.message.session,
          localRefreshAnswer.candidates
        );
        sendAnswer(
          signal,
          duplicateUuid,
          streamId,
          localRefreshOffer.message.session,
          localRefreshAnswer.sdp
        );
        const localRefreshConnected = await waitForPeerState(
          signal,
          page,
          duplicateUuid,
          'duplicate-peer',
          (state) => state.connectionState === 'connected' && state.dataChannelOpen,
          15000,
          localRefreshOffer.index + 1
        );
        const localRefreshMedia = localRefreshConnected.ok
          ? await waitForFreshVideo(
            signal,
            page,
            duplicateUuid,
            'duplicate-peer',
            12000,
            localRefreshOffer.index + 1
          )
          : { ok: false, state: localRefreshConnected.state };
        addCheck(
          report,
          'local-control-refreshed-peer-reconnects-with-live-media',
          localRefreshConnected.ok && localRefreshMedia.ok,
          {
            state: localRefreshMedia.state || localRefreshConnected.state,
            media: localRefreshMedia
          }
        );
      }
    }

    const connectedDuringRecheckUuid = 'duplicate-connects-before-recheck-viewer';
    const connectedDuringRecheckStart = signal.events.length;
    requestOffer(
      signal,
      connectedDuringRecheckUuid,
      streamId,
      'ignored-connect-before-recheck-request'
    );
    const connectedDuringRecheckOffer = await signal.waitFor(
      isOfferFor(connectedDuringRecheckUuid),
      connectedDuringRecheckStart,
      config.offerTimeoutMs
    );
    addCheck(
      report,
      'connected-before-recheck-initial-offer-arrives',
      !!connectedDuringRecheckOffer,
      {}
    );
    if (connectedDuringRecheckOffer) {
      const connectedDuringRecheckAnswer = await answerOffer(
        page,
        'duplicate-connects-before-recheck-peer',
        connectedDuringRecheckOffer.message,
        false,
        DIRECT_BROWSER_RTC_CONFIG
      );
      const connectedDuringRecheckBaseline = await waitForDiagnosticsPeerSnapshot(
        diagnosticsPath,
        connectedDuringRecheckUuid,
        (snapshot) => snapshot.peerCount === 1 &&
          snapshot.activeWireSession === connectedDuringRecheckOffer.message.session &&
          Number(snapshot.signaling.active_offer_generation) > 0 &&
          Number(snapshot.signaling.active_transport_generation) > 0 &&
          Number(snapshot.signaling.client_transport_generation) > 0,
        0,
        8000
      );
      requireHarnessFixture(
        report,
        'connected-before-recheck-diagnostics-baseline-is-current',
        !!connectedDuringRecheckBaseline,
        { snapshot: connectedDuringRecheckBaseline }
      );
      const connectedDuringRecheckIdentity = {
        offerGeneration: Number(
          connectedDuringRecheckBaseline.signaling.active_offer_generation
        ),
        transportGeneration: Number(
          connectedDuringRecheckBaseline.signaling.active_transport_generation
        ),
        clientGeneration: Number(
          connectedDuringRecheckBaseline.signaling.client_transport_generation
        )
      };
      const connectedDuringRecheckOutputOffset = publisher.output().length;
      const connectedDuringRecheckOfferSearchStart = signal.events.length;
      const connectedDuringRecheckRequestedAt = Date.now();
      requestOffer(
        signal,
        connectedDuringRecheckUuid,
        streamId,
        'ignored-connect-before-recheck-duplicate'
      );
      sendBrowserCandidates(
        signal,
        connectedDuringRecheckUuid,
        connectedDuringRecheckOffer.message.session,
        connectedDuringRecheckAnswer.candidates
      );
      sendAnswer(
        signal,
        connectedDuringRecheckUuid,
        streamId,
        connectedDuringRecheckOffer.message.session,
        connectedDuringRecheckAnswer.sdp
      );
      const connectedBeforeRecheckDeadlineMs = 850;
      const connectedBeforeRecheck = await waitForPeerState(
        signal,
        page,
        connectedDuringRecheckUuid,
        'duplicate-connects-before-recheck-peer',
        (state) => state.connectionState === 'connected' && state.dataChannelOpen,
        connectedBeforeRecheckDeadlineMs,
        connectedDuringRecheckOffer.index + 1
      );
      const connectedRecheckQuiescenceMs = 1800;
      const remainingConnectedRecheckQuiescenceMs = Math.max(
        0,
        connectedRecheckQuiescenceMs -
          (Date.now() - connectedDuringRecheckRequestedAt)
      );
      if (remainingConnectedRecheckQuiescenceMs > 0) {
        await wait(remainingConnectedRecheckQuiescenceMs);
      }
      const connectedDuringRecheckOffers = signal.events
        .slice(connectedDuringRecheckOfferSearchStart)
        .filter((entry) => entry.message && isOfferFor(connectedDuringRecheckUuid)(entry.message));
      const connectedDuringRecheckOutput = publisher.output()
        .slice(connectedDuringRecheckOutputOffset);
      const connectedRecheckSchedules = exactDuplicateOfferRecheckLines(
        connectedDuringRecheckOutput,
        'scheduled',
        connectedDuringRecheckUuid,
        connectedDuringRecheckOffer.message.session,
        connectedDuringRecheckIdentity,
        'duplicate-offer-request'
      );
      const connectedRecheckCancellations = exactDuplicateOfferRecheckLines(
        connectedDuringRecheckOutput,
        'canceled',
        connectedDuringRecheckUuid,
        connectedDuringRecheckOffer.message.session,
        connectedDuringRecheckIdentity,
        'connected'
      );
      const connectedRecheckReplacements = exactDuplicateOfferRecheckLines(
        connectedDuringRecheckOutput,
        'replacing',
        connectedDuringRecheckUuid,
        connectedDuringRecheckOffer.message.session,
        connectedDuringRecheckIdentity,
        'duplicate-offer-request'
      );
      const connectedDuringRecheckSnapshot = await waitForDiagnosticsPeerSnapshot(
        diagnosticsPath,
        connectedDuringRecheckUuid,
        (snapshot) => snapshot.peerCount === 1 &&
          snapshot.activeWireSession === connectedDuringRecheckOffer.message.session &&
          snapshot.lastConnectionState === 'connected',
        connectedDuringRecheckBaseline.generatedSteadyMs,
        8000
      );
      const connectedDuringRecheckMedia = connectedBeforeRecheck.ok
        ? await waitForFreshVideo(
          signal,
          page,
          connectedDuringRecheckUuid,
          'duplicate-connects-before-recheck-peer',
          12000,
          connectedDuringRecheckOffer.index + 1
        )
        : { ok: false, state: connectedBeforeRecheck.state };
      const connectedBeforeRecheckVerdict =
        connectedBeforeRecheck.ok &&
        connectedDuringRecheckMedia.ok &&
        connectedDuringRecheckOffers.length === 0 &&
        connectedRecheckSchedules.length === 1 &&
        connectedRecheckCancellations.length === 1 &&
        connectedRecheckReplacements.length === 0 &&
        !!connectedDuringRecheckSnapshot &&
        connectedDuringRecheckSnapshot.peerCount === 1 &&
        connectedDuringRecheckSnapshot.activeWireSession ===
          connectedDuringRecheckOffer.message.session &&
        Number(connectedDuringRecheckSnapshot.signaling.active_transport_generation) ===
          connectedDuringRecheckIdentity.transportGeneration &&
        Number(connectedDuringRecheckSnapshot.signaling.client_transport_generation) ===
          connectedDuringRecheckIdentity.clientGeneration;
      addCheck(
        report,
        'duplicate-connected-before-deadline-is-ignored-after-same-instance-recheck',
        connectedBeforeRecheckVerdict,
        {
          deadlineMs: connectedBeforeRecheckDeadlineMs,
          quiescenceMs: connectedRecheckQuiescenceMs,
          connectedState: connectedBeforeRecheck.state,
          media: connectedDuringRecheckMedia,
          observedReplacementOffers: connectedDuringRecheckOffers.length,
          scheduledLines: connectedRecheckSchedules,
          cancellationLines: connectedRecheckCancellations,
          replacementLines: connectedRecheckReplacements,
          baseline: connectedDuringRecheckBaseline,
          snapshot: connectedDuringRecheckSnapshot,
          outputTail: connectedDuringRecheckOutput.slice(-6000)
        }
      );
    }

    // VDO.Ninja treats an explicit ICE restart as a request for a fresh
    // PeerConnection even while offer A is unanswered. The replacement must
    // rotate every wire identity, and delayed A traffic must remain unable to
    // enter B before B establishes a real data/media path.
    const preAnswerRestartUuid = 'pre-answer-restart-viewer';
    const preAnswerRestartSession = 'pre-answer-restart-session';
    const preAnswerRestartStart = signal.events.length;
    requestOffer(
      signal,
      preAnswerRestartUuid,
      streamId,
      preAnswerRestartSession
    );
    const preAnswerOfferA = await signal.waitFor(
      isOfferFor(preAnswerRestartUuid),
      preAnswerRestartStart,
      config.offerTimeoutMs
    );
    addCheck(report, 'pre-answer-restart-offer-a-arrives', !!preAnswerOfferA, {});
    if (preAnswerOfferA) {
      const preAnswerOfferAUfrag = extractIceUfrag(
        preAnswerOfferA.message.description.sdp
      );
      const preAnswerOfferUsable = !!preAnswerOfferAUfrag &&
        !!preAnswerOfferA.message.session;
      addCheck(
        report,
        'pre-answer-restart-offer-a-has-an-ice-generation',
        preAnswerOfferUsable,
        {
          requestSession: preAnswerRestartSession,
          session: preAnswerOfferA.message.session,
          offerAUfrag: preAnswerOfferAUfrag
        }
      );
      addCheck(
        report,
        'pre-answer-restart-offer-a-echoes-viewer-request-session',
        preAnswerOfferA.message.session === preAnswerRestartSession,
        {
          requestSession: preAnswerRestartSession,
          activeSession: preAnswerOfferA.message.session
        }
      );

      if (preAnswerOfferUsable) {
        const preAnswerA = await answerOffer(
          page,
          'pre-answer-restart-peer',
          preAnswerOfferA.message,
          false,
          DIRECT_BROWSER_RTC_CONFIG
        );
        const preAnswerCandidateA = preAnswerA.candidates.find((candidate) =>
          typeof browserCandidateWire(candidate).candidate === 'string' &&
          browserCandidateWire(candidate).candidate.length > 0
        );
        requireHarnessFixture(
          report,
          'pre-answer-restart-offer-a-has-real-browser-answer-and-candidate',
          !!preAnswerA.peerInstanceId && !!preAnswerCandidateA,
          {
            peerInstanceId: preAnswerA.peerInstanceId,
            answerSdpSha256: sha256Text(preAnswerA.sdp),
            candidateSha256: preAnswerCandidateA
              ? sha256Text(String(browserCandidateWire(preAnswerCandidateA).candidate || ''))
              : ''
          }
        );

        const restartRequestAt = Date.now();
        const preAnswerRestartImmediateDeadlineMs = 750;
        const restartOfferSearchStart = signal.events.length;
        const restartOutputOffset = publisher.output().length;
        const ignoredPreAnswerRestartHint =
          `${preAnswerOfferA.message.session}-ignored-restart-hint`;
        signal.send({
          UUID: preAnswerRestartUuid,
          session: ignoredPreAnswerRestartHint,
          streamID: streamId,
          iceRestartRequest: true
        });
        const productRestartOfferB = await signal.waitFor(
          isOfferFor(preAnswerRestartUuid),
          restartOfferSearchStart,
          config.offerTimeoutMs
        );
        const productRestartOfferBUfrag = productRestartOfferB
          ? extractIceUfrag(productRestartOfferB.message.description.sdp)
          : '';
        const productRestartOfferBElapsedMs = productRestartOfferB
          ? productRestartOfferB.at - restartRequestAt
          : null;
        const preAnswerRestartObservationMs = 1000;
        await wait(preAnswerRestartObservationMs);
        const productRestartOffers = signal.events
          .slice(restartOfferSearchStart)
          .map((entry, offset) => ({
            ...entry,
            index: restartOfferSearchStart + offset
          }))
          .filter((entry) => entry.message && isOfferFor(preAnswerRestartUuid)(entry.message));
        const restartOutput = publisher.output().slice(restartOutputOffset);
        const productRestartRebuildLines = restartOutput.split(/\r?\n/).filter((line) =>
          /\[App\] Rebuilt peer transport\b/.test(line) &&
          logHasExactToken(line, `uuid=${preAnswerRestartUuid}`) &&
          logHasExactToken(line, `retiredSession=${preAnswerOfferA.message.session}`) &&
          !!productRestartOfferB &&
          logHasExactToken(line, `activeSession=${productRestartOfferB.message.session}`) &&
          logHasExactToken(line, 'reason=signaling-ice-restart')
        );
        const forbiddenCachedRestartLines = restartOutput.split(/\r?\n/).filter((line) =>
          /Replaying outstanding offer for duplicate request|offer-restart-replay|offer-restart-satisfied-by-current/.test(line)
        );
        const freshPreAnswerRestartVerdict =
          productRestartOffers.length === 1 &&
          !!productRestartOfferB &&
          Number.isFinite(productRestartOfferBElapsedMs) &&
          productRestartOfferBElapsedMs < preAnswerRestartImmediateDeadlineMs &&
          !!productRestartOfferB.message.session &&
          productRestartOfferB.message.session !== preAnswerOfferA.message.session &&
          productRestartOfferB.message.session !== ignoredPreAnswerRestartHint &&
          productRestartOfferB.message.description.sdp !==
            preAnswerOfferA.message.description.sdp &&
          !!productRestartOfferBUfrag &&
          productRestartOfferBUfrag !== preAnswerOfferAUfrag &&
          productRestartRebuildLines.length === 1 &&
          forbiddenCachedRestartLines.length === 0;
        addCheck(
          report,
          'pre-answer-wss-ice-restart-creates-one-fresh-offer-b-generation',
          freshPreAnswerRestartVerdict,
          {
            requestSessionHint: ignoredPreAnswerRestartHint,
            observationMs: preAnswerRestartObservationMs,
            immediateDeadlineMs: preAnswerRestartImmediateDeadlineMs,
            responseCount: productRestartOffers.length,
            elapsedMs: productRestartOfferBElapsedMs,
            offerASession: preAnswerOfferA.message.session,
            offerBSession: productRestartOfferB
              ? productRestartOfferB.message.session
              : '',
            offerAUfrag: preAnswerOfferAUfrag,
            offerBUfrag: productRestartOfferBUfrag,
            sameSdp: productRestartOfferB
              ? productRestartOfferB.message.description.sdp ===
                preAnswerOfferA.message.description.sdp
              : null,
            rebuildLines: productRestartRebuildLines,
            forbiddenCachedRestartLines,
            outputTail: restartOutput.slice(-6000)
          }
        );

        let activePreAnswerOfferB = productRestartOfferB;
        let preAnswerRestartFixtureRecoveryUsed = false;
        if (!freshPreAnswerRestartVerdict) {
          preAnswerRestartFixtureRecoveryUsed = true;
          const brokenPreAnswerSession = productRestartOfferB &&
              productRestartOfferB.message.session
            ? productRestartOfferB.message.session
            : preAnswerOfferA.message.session;
          const recoveryRemovalOutputOffset = publisher.output().length;
          signal.send({
            bye: true,
            UUID: preAnswerRestartUuid,
            session: brokenPreAnswerSession,
            streamID: streamId
          });
          const recoveryRemoval = await waitForPublisherOutput(
            publisher,
            recoveryRemovalOutputOffset,
            (output) => new RegExp(`Removed peer session ${preAnswerRestartUuid}:`).test(output),
            8000
          );
          requireHarnessFixture(
            report,
            'pre-answer-restart-product-failure-recovery-removes-broken-owner',
            recoveryRemoval.ok,
            {
              brokenPreAnswerSession,
              removal: recoveryRemoval,
              outputTail: publisher.output().slice(recoveryRemovalOutputOffset).slice(-5000)
            }
          );
          const recoveryOfferSearchStart = signal.events.length;
          requestOffer(
            signal,
            preAnswerRestartUuid,
            streamId,
            `${preAnswerOfferA.message.session}-fixture-recovery`
          );
          activePreAnswerOfferB = await signal.waitFor(
            isOfferFor(preAnswerRestartUuid),
            recoveryOfferSearchStart,
            config.offerTimeoutMs
          );
          requireHarnessFixture(
            report,
            'pre-answer-restart-product-failure-recovery-restores-distinct-offer-b',
            !!activePreAnswerOfferB &&
              activePreAnswerOfferB.message.session !== preAnswerOfferA.message.session &&
              activePreAnswerOfferB.message.description.sdp !==
                preAnswerOfferA.message.description.sdp &&
              extractIceUfrag(activePreAnswerOfferB.message.description.sdp) !==
                preAnswerOfferAUfrag,
            {
              retiredSession: preAnswerOfferA.message.session,
              recoverySession: activePreAnswerOfferB
                ? activePreAnswerOfferB.message.session
                : '',
              recoveryUfrag: activePreAnswerOfferB
                ? extractIceUfrag(activePreAnswerOfferB.message.description.sdp)
                : ''
            }
          );
          addEvidence(
            report,
            'pre-answer-restart-fixture-recovery-does-not-hide-product-failure',
            {
              productFreshRestartOk: freshPreAnswerRestartVerdict,
              productSession: productRestartOfferB
                ? productRestartOfferB.message.session
                : '',
              recoverySession: activePreAnswerOfferB.message.session
            }
          );
        }

        if (activePreAnswerOfferB &&
            activePreAnswerOfferB.message.session !== preAnswerOfferA.message.session) {
          const offerBBaseline = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            preAnswerRestartUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === activePreAnswerOfferB.message.session &&
              snapshot.signaling.answer_received === false,
            0,
            8000
          );
          requireHarnessFixture(
            report,
            'pre-answer-restart-stale-a-probe-starts-with-unanswered-offer-b',
            !!offerBBaseline,
            {
              fixtureRecoveryUsed: preAnswerRestartFixtureRecoveryUsed,
              expectedSession: activePreAnswerOfferB.message.session,
              snapshot: offerBBaseline
            }
          );
          const offerBStateBeforeStaleA = sessionlessWssDownstreamState(offerBBaseline);
          const staleACandidateSha256 = sha256Text(
            String(browserCandidateWire(preAnswerCandidateA).candidate || '')
          );
          const staleAOutputOffset = publisher.output().length;
          sendExactBrowserCandidate(
            signal,
            preAnswerRestartUuid,
            preAnswerOfferA.message.session,
            preAnswerCandidateA
          );
          sendAnswer(
            signal,
            preAnswerRestartUuid,
            streamId,
            preAnswerOfferA.message.session,
            preAnswerA.sdp
          );
          const preAnswerStaleAQuiescenceMs = 1000;
          await wait(preAnswerStaleAQuiescenceMs);
          const staleAOutput = publisher.output().slice(staleAOutputOffset);
          const staleACandidateRejectionLines = explicitStaleCandidateRejectionLines(
            staleAOutput,
            preAnswerRestartUuid,
            preAnswerOfferA.message.session,
            staleACandidateSha256
          );
          const staleAAnswerRejectionLines = explicitStaleAnswerRejectionLines(
            staleAOutput,
            preAnswerRestartUuid,
            preAnswerOfferA.message.session
          );
          const staleAForbiddenCandidateRoutingLines = staleAOutput
            .split(/\r?\n/)
            .filter((line) =>
              (/\[Signaling\] Queued remote ICE candidate\b/.test(line) &&
                logHasExactToken(line, `uuid=${preAnswerRestartUuid}`)) ||
              /\[WebRTC\] (?:Queued|Drained queued|Adding|Added|Failed to add(?: queued)?) remote ICE candidate\b/.test(line)
            );
          const staleAForbiddenAnswerApplyLines = staleAOutput
            .split(/\r?\n/)
            .filter((line) =>
              /\[App\] (?:Applying|Failed to apply) peer answer\b/.test(line)
            );
          const offerBAfterStaleA = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            preAnswerRestartUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === activePreAnswerOfferB.message.session,
            offerBBaseline.generatedSteadyMs,
            8000
          );
          const offerBStateAfterStaleA = sessionlessWssDownstreamState(
            offerBAfterStaleA
          );
          const staleATrafficCannotCrossBVerdict =
            staleACandidateRejectionLines.length === 1 &&
            staleAAnswerRejectionLines.length === 1 &&
            staleAForbiddenCandidateRoutingLines.length === 0 &&
            staleAForbiddenAnswerApplyLines.length === 0 &&
            JSON.stringify(offerBStateAfterStaleA) ===
              JSON.stringify(offerBStateBeforeStaleA);
          addCheck(
            report,
            'pre-answer-restart-stale-offer-a-answer-and-candidate-cannot-cross-offer-b',
            staleATrafficCannotCrossBVerdict,
            {
              retiredSession: preAnswerOfferA.message.session,
              activeSession: activePreAnswerOfferB.message.session,
              quiescenceMs: preAnswerStaleAQuiescenceMs,
              candidateSha256: staleACandidateSha256,
              candidateRejectionLines: staleACandidateRejectionLines,
              answerRejectionLines: staleAAnswerRejectionLines,
              forbiddenCandidateRoutingLines: staleAForbiddenCandidateRoutingLines,
              forbiddenAnswerApplyLines: staleAForbiddenAnswerApplyLines,
              downstreamBefore: offerBStateBeforeStaleA,
              downstreamAfter: offerBStateAfterStaleA,
              outputTail: staleAOutput.slice(-6000)
            }
          );

          const preAnswerB = await answerOffer(
            page,
            'pre-answer-restart-peer',
            activePreAnswerOfferB.message,
            false,
            DIRECT_BROWSER_RTC_CONFIG
          );
          sendBrowserCandidates(
            signal,
            preAnswerRestartUuid,
            activePreAnswerOfferB.message.session,
            preAnswerB.candidates
          );
          sendAnswer(
            signal,
            preAnswerRestartUuid,
            streamId,
            activePreAnswerOfferB.message.session,
            preAnswerB.sdp
          );
          const preAnswerBConnected = await waitForPeerState(
            signal,
            page,
            preAnswerRestartUuid,
            'pre-answer-restart-peer',
            (state) => state.connectionState === 'connected' && state.dataChannelOpen,
            15000,
            activePreAnswerOfferB.index + 1
          );
          const preAnswerBMedia = preAnswerBConnected.ok ? await waitForFreshVideo(
            signal,
            page,
            preAnswerRestartUuid,
            'pre-answer-restart-peer',
            12000,
            activePreAnswerOfferB.index + 1
          ) : { ok: false, state: preAnswerBConnected.state };
          const exactOfferBWorkflowVerdict =
            preAnswerB.peerInstanceId !== preAnswerA.peerInstanceId &&
            preAnswerBConnected.ok &&
            preAnswerBMedia.ok;
          addCheck(
            report,
            'pre-answer-restart-exact-offer-b-establishes-data-and-fresh-video',
            exactOfferBWorkflowVerdict,
            {
              fixtureRecoveryUsed: preAnswerRestartFixtureRecoveryUsed,
              offerAPeerInstanceId: preAnswerA.peerInstanceId,
              offerBPeerInstanceId: preAnswerB.peerInstanceId,
              state: preAnswerBMedia.state || preAnswerBConnected.state,
              media: {
                initial: preAnswerBMedia.initial,
                final: preAnswerBMedia.final
              }
            }
          );
        }
      }
    }

    // Reproduce the unsafe sequence that the duplicate-offer check cannot:
    // offer A gets a syntactically valid but transport-invalid answer, the
    // failed logical peer is rebuilt into offer B, and the never-applied valid
    // answer for A arrives while B is outstanding. VDO.Ninja assigns a fresh
    // wire session to a replacement PeerConnection while the application keeps
    // the same logical peer/slot.
    const staleUuid = 'older-generation-viewer';
    const stalePeerName = 'older-generation-peer';
    const staleStart = signal.events.length;
    requestOffer(signal, staleUuid, streamId, 'older-generation-session');
    const offerA = await signal.waitFor(isOfferFor(staleUuid), staleStart, config.offerTimeoutMs);
    addCheck(report, 'older-generation-offer-a-arrives', !!offerA, {});
    if (offerA) {
      const validAnswerA = await answerOffer(
        page, stalePeerName, offerA.message, false, DIRECT_BROWSER_RTC_CONFIG
      );
      const invalidAnswerA = makeTransportFailureAnswer(validAnswerA.sdp);
      addCheck(report, 'older-generation-failure-fixture-mutates-only-fingerprint',
        invalidAnswerA !== validAnswerA.sdp &&
          /a=fingerprint:sha-256 (?:00:){31}00/i.test(invalidAnswerA), {});
      const answerACandidateSendStart = signal.sentEvents.length;
      sendBrowserCandidates(signal, staleUuid, offerA.message.session, validAnswerA.candidates);
      const answerACandidateSentEvents = signal.sentEvents
        .slice(answerACandidateSendStart)
        .filter((entry) => entry.message &&
          entry.message.UUID === staleUuid &&
          entry.message.session === offerA.message.session &&
          entry.message.type === 'remote' &&
          entry.message.candidate);
      const failureOutputOffset = publisher.output().length;
      sendAnswer(signal, staleUuid, streamId, offerA.message.session, invalidAnswerA);

      const failedAt = Date.now();
      const oldForwarded = new Set();
      let reachedFailure = false;
      let failureSnapshot = null;
      while (Date.now() - failedAt < config.failureTimeoutMs) {
        await forwardPublisherCandidates(
          signal,
          page,
          staleUuid,
          stalePeerName,
          oldForwarded,
          offerA.index + 1
        );
        failureSnapshot = await readCurrentDiagnosticsPeerSnapshot(
          diagnosticsPath,
          staleUuid
        );
        reachedFailure = diagnosticsShowsRetiredGeneration(failureSnapshot, 1);
        if (reachedFailure) {
          break;
        }
        await wait(100);
      }
      addCheck(report, 'offer-a-enters-real-terminal-transport-state', reachedFailure, {
        elapsedMs: Date.now() - failedAt,
        expectedOfferGeneration: 1,
        diagnosticsPath,
        snapshot: failureSnapshot,
        outputTail: publisher.output().slice(failureOutputOffset).slice(-4000)
      });

      if (reachedFailure) {
        const offerBSearchStart = signal.events.length;
        signal.send({
          UUID: staleUuid,
          session: offerA.message.session,
          streamID: streamId,
          iceRestartRequest: true
        });
        const productOfferB = await signal.waitFor(
          isOfferFor(staleUuid), offerBSearchStart, config.offerTimeoutMs
        );
        const distinctGenerations = !!productOfferB &&
          productOfferB.message.description.sdp !== offerA.message.description.sdp &&
          extractIceUfrag(productOfferB.message.description.sdp) !==
            extractIceUfrag(offerA.message.description.sdp);
        addCheck(report, 'fixture-creates-two-distinct-real-offer-generations',
          distinctGenerations, {
            offerAUfrag: extractIceUfrag(offerA.message.description.sdp),
            offerBUfrag: productOfferB
              ? extractIceUfrag(productOfferB.message.description.sdp)
              : '',
            sameSdp: productOfferB
              ? productOfferB.message.description.sdp === offerA.message.description.sdp
              : null
          });
        addCheck(report, 'full-peer-rebuild-rotates-wire-session',
          !!productOfferB &&
            productOfferB.message.session !== offerA.message.session, {
            offerASession: offerA.message.session,
            offerBSession: productOfferB ? productOfferB.message.session : '',
            sameLogicalUuid: !!productOfferB &&
              productOfferB.message.UUID === offerA.message.UUID
          });

        let offerB = productOfferB;
        let offerBFixtureRecoveryUsed = false;
        if (!productOfferB || !distinctGenerations ||
            productOfferB.message.session === offerA.message.session) {
          offerBFixtureRecoveryUsed = true;
          const brokenOfferBSession = productOfferB
            ? productOfferB.message.session
            : offerA.message.session;
          const offerBRecoveryRemovalOffset = publisher.output().length;
          signal.send({
            bye: true,
            UUID: staleUuid,
            session: brokenOfferBSession,
            streamID: streamId
          });
          const offerBRecoveryRemovalStarted = Date.now();
          let offerBRecoveryRemovedBrokenPeer = false;
          while (Date.now() - offerBRecoveryRemovalStarted < 8000) {
            const output = publisher.output().slice(offerBRecoveryRemovalOffset);
            if (new RegExp(`Removed peer session ${staleUuid}:`).test(output)) {
              offerBRecoveryRemovedBrokenPeer = true;
              break;
            }
            await wait(50);
          }
          requireHarnessFixture(
            report,
            'offer-b-label-fixture-recovery-removes-broken-peer',
            offerBRecoveryRemovedBrokenPeer,
            {
              brokenOfferBSession,
              outputTail: publisher.output()
                .slice(offerBRecoveryRemovalOffset)
                .slice(-4000)
            }
          );
          const offerBRecoverySearchStart = signal.events.length;
          const offerBRecoveryRequestHint =
            `${offerA.message.session}-generation-b-fixture-replacement`;
          requestOffer(
            signal,
            staleUuid,
            streamId,
            offerBRecoveryRequestHint
          );
          offerB = await signal.waitFor(
            isOfferFor(staleUuid),
            offerBRecoverySearchStart,
            config.offerTimeoutMs
          );
          addEvidence(report, 'offer-b-label-fixture-recovery-does-not-hide-product-failure', {
            productOfferBPresent: !!productOfferB,
            productDistinctGenerations: distinctGenerations,
            productOfferBSession: productOfferB ? productOfferB.message.session : '',
            retiredSession: offerA.message.session,
            recoveryRequestHint: offerBRecoveryRequestHint,
            recoveryActiveSession: offerB ? offerB.message.session : ''
          });
        }
        const activeOfferBDistinctGeneration = !!offerB &&
          offerB.message.description.sdp !== offerA.message.description.sdp &&
          extractIceUfrag(offerB.message.description.sdp) !==
            extractIceUfrag(offerA.message.description.sdp);
        requireHarnessFixture(
          report,
          'offer-b-label-probe-has-distinct-retired-and-active-sessions',
          activeOfferBDistinctGeneration &&
            offerB.message.session !== offerA.message.session,
          {
            retiredSession: offerA.message.session,
            activeSession: offerB ? offerB.message.session : '',
            productOfferBSession: productOfferB ? productOfferB.message.session : '',
            activeOfferBDistinctGeneration
          }
        );

        const ownsOnlyActiveOfferB = (snapshot) => !!snapshot &&
          snapshot.peerCount === 1 &&
          snapshot.activeWireSession === offerB.message.session &&
          snapshot.signaling.answer_received === false;
        const preSessionlessOfferBOwner = await waitForDiagnosticsPeerSnapshot(
          diagnosticsPath,
          staleUuid,
          ownsOnlyActiveOfferB,
          0,
          8000
        );
        requireHarnessFixture(
          report,
          'sessionless-probe-starts-with-one-active-offer-b-owner',
          ownsOnlyActiveOfferB(preSessionlessOfferBOwner),
          {
            expectedActiveSession: offerB ? offerB.message.session : '',
            snapshot: preSessionlessOfferBOwner
          }
        );

        if (offerB && activeOfferBDistinctGeneration) {
          const answerASdpSha256 = sha256Text(validAnswerA.sdp);
          const sessionlessCandidateA = validAnswerA.candidates.find((candidate) =>
            candidate.sourcePeerInstanceId === validAnswerA.peerInstanceId &&
            candidate.sourceCandidateIndex >= validAnswerA.candidateStart &&
            candidate.sourceCandidateIndex < validAnswerA.candidateEnd &&
            answerACandidateSentEvents.some((entry) =>
              JSON.stringify(entry.message.candidate) ===
                canonicalBrowserCandidateWire(candidate)
            )
          );
          const sessionlessCandidateWire = browserCandidateWire(sessionlessCandidateA);
          const sessionlessCandidateSha256 = sha256Text(
            String(sessionlessCandidateWire.candidate || '')
          );
          requireHarnessFixture(
            report,
            'sessionless-wss-probe-uses-real-generation-a-candidate',
            !!sessionlessCandidateA &&
              sessionlessCandidateA.sourcePeerInstanceId === validAnswerA.peerInstanceId &&
              typeof sessionlessCandidateWire.candidate === 'string' &&
              sessionlessCandidateWire.candidate.length > 0 &&
              /^[0-9a-f]{64}$/.test(sessionlessCandidateSha256),
            {
              sourcePeerInstanceId: sessionlessCandidateA
                ? sessionlessCandidateA.sourcePeerInstanceId
                : null,
              expectedPeerInstanceId: validAnswerA.peerInstanceId,
              candidateSha256: sessionlessCandidateSha256,
              candidateWire: sessionlessCandidateA ? sessionlessCandidateWire : null
            }
          );

          const sessionlessCounterBaseline = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === offerB.message.session &&
              snapshot.signaling.answer_received === false &&
              Number.isFinite(Number(snapshot.signaling.pending_remote_candidates)) &&
              Number.isFinite(Number(snapshot.signaling.answer_count)) &&
              Number.isFinite(Number(snapshot.signaling.remote_candidates_applied)) &&
              Number.isFinite(Number(snapshot.signaling.active_offer_generation)) &&
              Number.isFinite(Number(snapshot.signaling.active_transport_generation)) &&
              Number.isFinite(Number(snapshot.signaling.client_transport_generation)),
            0,
            8000
          );
          requireHarnessFixture(
            report,
            'sessionless-wss-probe-starts-with-observable-unanswered-offer-b-state',
            !!sessionlessCounterBaseline &&
              sessionlessCounterBaseline.peerCount === 1 &&
              sessionlessCounterBaseline.activeWireSession === offerB.message.session &&
              sessionlessCounterBaseline.signaling.answer_received === false,
            {
              diagnosticsPath,
              expectedActiveSession: offerB.message.session,
              snapshot: sessionlessCounterBaseline
            }
          );

          const sessionlessBaselineDownstreamState = sessionlessWssDownstreamState(
            sessionlessCounterBaseline
          );
          const sessionlessObservationTimeoutMs = 4000;
          const sessionlessPostEventQuiescenceMs = 1000;

          const sessionlessCandidateOutputOffset = publisher.output().length;
          const sessionlessCandidateSentEvent = sendSessionlessBrowserCandidate(
            signal,
            staleUuid,
            sessionlessCandidateA
          );
          const sessionlessCandidateRawMessage = JSON.parse(
            sessionlessCandidateSentEvent.raw
          );
          requireHarnessFixture(
            report,
            'sessionless-generation-a-candidate-wire-truly-omits-session',
            sessionlessCandidateSentEvent.message.UUID === staleUuid &&
              sessionlessCandidateSentEvent.message.type === 'remote' &&
              !Object.prototype.hasOwnProperty.call(
                sessionlessCandidateSentEvent.message,
                'session'
              ) &&
              !Object.prototype.hasOwnProperty.call(
                sessionlessCandidateRawMessage,
                'session'
              ) &&
              JSON.stringify(sessionlessCandidateSentEvent.message.candidate) ===
                canonicalBrowserCandidateWire(sessionlessCandidateA) &&
              sha256Text(
                String(sessionlessCandidateSentEvent.message.candidate.candidate || '')
              ) === sessionlessCandidateSha256,
            {
              raw: sessionlessCandidateSentEvent.raw,
              sentMessage: sessionlessCandidateSentEvent.message,
              candidateSha256: sessionlessCandidateSha256
            }
          );
          const sessionlessCandidateObservation = await waitForPublisherOutput(
            publisher,
            sessionlessCandidateOutputOffset,
            (output) => explicitSessionlessWssCandidateRejectionLines(
              output,
              staleUuid,
              offerB.message.session,
              sessionlessCandidateSha256
            ).length > 0,
            sessionlessObservationTimeoutMs
          );
          await wait(sessionlessPostEventQuiescenceMs);
          const sessionlessCandidateCounterAfter =
            await waitForDiagnosticsPeerSnapshot(
              diagnosticsPath,
              staleUuid,
              (snapshot) => snapshot.peerCount === 1 &&
                snapshot.activeWireSession === offerB.message.session,
              sessionlessCounterBaseline.generatedSteadyMs,
              8000
            );
          const sessionlessCandidateOutput = publisher.output()
            .slice(sessionlessCandidateOutputOffset);
          const sessionlessCandidateRejectionLines =
            explicitSessionlessWssCandidateRejectionLines(
              sessionlessCandidateOutput,
              staleUuid,
              offerB.message.session,
              sessionlessCandidateSha256
            );
          const sessionlessCandidateForbiddenRoutingLines =
            sessionlessCandidateOutput.split(/\r?\n/).filter((line) =>
              (/\[Signaling\] Queued remote ICE candidate\b/.test(line) &&
                logHasExactToken(line, `uuid=${staleUuid}`)) ||
              /\[WebRTC\] (?:Queued|Drained queued|Adding|Added|Failed to add(?: queued)?) remote ICE candidate\b/.test(line)
            );
          const sessionlessCandidateDownstreamState = sessionlessWssDownstreamState(
            sessionlessCandidateCounterAfter
          );
          const sessionlessCandidateStateUnchanged =
            JSON.stringify(sessionlessCandidateDownstreamState) ===
              JSON.stringify(sessionlessBaselineDownstreamState);
          const sessionlessCandidateQuiescent =
            sessionlessCandidateForbiddenRoutingLines.length === 0;
          const sessionlessCandidateSafelyRejected =
            sessionlessCandidateObservation.ok &&
            sessionlessCandidateRejectionLines.length === 1 &&
            !!sessionlessCandidateCounterAfter &&
            sessionlessCandidateStateUnchanged &&
            sessionlessCandidateQuiescent;
          addCheck(
            report,
            'sessionless-generation-a-candidate-is-rejected-before-offer-b-routing',
            sessionlessCandidateSafelyRejected,
            {
              retiredGenerationSession: offerA.message.session,
              outstandingActiveSession: offerB.message.session,
              candidateSha256: sessionlessCandidateSha256,
              observation: sessionlessCandidateObservation,
              explicitRejectionLines: sessionlessCandidateRejectionLines,
              postEventQuiescenceMs: sessionlessPostEventQuiescenceMs,
              forbiddenRoutingLines: sessionlessCandidateForbiddenRoutingLines,
              downstreamBefore: sessionlessBaselineDownstreamState,
              downstreamAfter: sessionlessCandidateDownstreamState,
              outputTail: sessionlessCandidateOutput.slice(-5000)
            }
          );

          const sessionlessAnswerOutputOffset = publisher.output().length;
          const sessionlessAnswerSentEvent = sendSessionlessAnswer(
            signal,
            staleUuid,
            streamId,
            validAnswerA.sdp
          );
          const sessionlessAnswerRawMessage = JSON.parse(sessionlessAnswerSentEvent.raw);
          requireHarnessFixture(
            report,
            'sessionless-generation-a-answer-wire-truly-omits-session',
            sessionlessAnswerSentEvent.message.UUID === staleUuid &&
              sessionlessAnswerSentEvent.message.streamID === streamId &&
              !Object.prototype.hasOwnProperty.call(
                sessionlessAnswerSentEvent.message,
                'session'
              ) &&
              !Object.prototype.hasOwnProperty.call(
                sessionlessAnswerRawMessage,
                'session'
              ) &&
              sessionlessAnswerSentEvent.message.description.type === 'answer' &&
              sessionlessAnswerSentEvent.message.description.sdp === validAnswerA.sdp &&
              sha256Text(sessionlessAnswerSentEvent.message.description.sdp) ===
                answerASdpSha256,
            {
              raw: sessionlessAnswerSentEvent.raw,
              sentMessage: sessionlessAnswerSentEvent.message,
              answerSdpSha256: answerASdpSha256
            }
          );
          const sessionlessAnswerObservation = await waitForPublisherOutput(
            publisher,
            sessionlessAnswerOutputOffset,
            (output) => explicitSessionlessWssAnswerRejectionLines(
              output,
              staleUuid,
              offerB.message.session,
              answerASdpSha256
            ).length > 0,
            sessionlessObservationTimeoutMs
          );
          await wait(sessionlessPostEventQuiescenceMs);
          const sessionlessAnswerCounterAfter = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === offerB.message.session,
            sessionlessCandidateCounterAfter
              ? sessionlessCandidateCounterAfter.generatedSteadyMs
              : sessionlessCounterBaseline.generatedSteadyMs,
            8000
          );
          const sessionlessAnswerOutput = publisher.output()
            .slice(sessionlessAnswerOutputOffset);
          const sessionlessAnswerRejectionLines =
            explicitSessionlessWssAnswerRejectionLines(
              sessionlessAnswerOutput,
              staleUuid,
              offerB.message.session,
              answerASdpSha256
            );
          const sessionlessAnswerForbiddenApplyLines =
            sessionlessAnswerOutput.split(/\r?\n/).filter((line) =>
              /\[App\] (?:Applying|Failed to apply) peer answer\b/.test(line)
            );
          const sessionlessAnswerDownstreamState = sessionlessWssDownstreamState(
            sessionlessAnswerCounterAfter
          );
          const sessionlessAnswerStateUnchanged =
            JSON.stringify(sessionlessAnswerDownstreamState) ===
              JSON.stringify(sessionlessCandidateDownstreamState);
          const sessionlessAnswerQuiescent =
            sessionlessAnswerForbiddenApplyLines.length === 0;
          const sessionlessAnswerSafelyRejected =
            sessionlessAnswerObservation.ok &&
            sessionlessAnswerRejectionLines.length === 1 &&
            !!sessionlessAnswerCounterAfter &&
            sessionlessAnswerStateUnchanged &&
            sessionlessAnswerQuiescent;
          addCheck(
            report,
            'sessionless-generation-a-answer-is-rejected-before-offer-b-routing',
            sessionlessAnswerSafelyRejected,
            {
              retiredGenerationSession: offerA.message.session,
              outstandingActiveSession: offerB.message.session,
              answerSdpSha256: answerASdpSha256,
              observation: sessionlessAnswerObservation,
              explicitRejectionLines: sessionlessAnswerRejectionLines,
              postEventQuiescenceMs: sessionlessPostEventQuiescenceMs,
              forbiddenApplyLines: sessionlessAnswerForbiddenApplyLines,
              downstreamBefore: sessionlessCandidateDownstreamState,
              downstreamAfter: sessionlessAnswerDownstreamState,
              outputTail: sessionlessAnswerOutput.slice(-5000)
            }
          );

          const sessionlessOfferStatePreserved =
            sessionlessCandidateSafelyRejected && sessionlessAnswerSafelyRejected;
          if (!sessionlessOfferStatePreserved) {
            const brokenSessionlessOffer = offerB;
            const sessionlessRecoveryOutputOffset = publisher.output().length;
            signal.send({
              bye: true,
              UUID: staleUuid,
              session: brokenSessionlessOffer.message.session,
              streamID: streamId
            });
            const sessionlessRecoveryRemovalObservation = await waitForPublisherOutput(
              publisher,
              sessionlessRecoveryOutputOffset,
              (output) => new RegExp(`Removed peer session ${staleUuid}:`).test(output),
              8000
            );
            const sessionlessRecoveryRemovalSnapshot =
              await waitForDiagnosticsPeerSnapshot(
                diagnosticsPath,
                staleUuid,
                (snapshot) => snapshot.peerCount === 0,
                sessionlessAnswerCounterAfter
                  ? sessionlessAnswerCounterAfter.generatedSteadyMs
                  : sessionlessCounterBaseline.generatedSteadyMs,
                8000
              );
            requireHarnessFixture(
              report,
              'sessionless-wss-product-failure-recovery-removes-broken-offer-b',
              sessionlessRecoveryRemovalObservation.ok &&
                !!sessionlessRecoveryRemovalSnapshot &&
                sessionlessRecoveryRemovalSnapshot.peerCount === 0,
              {
                brokenSession: brokenSessionlessOffer.message.session,
                removalObservation: sessionlessRecoveryRemovalObservation,
                removalSnapshot: sessionlessRecoveryRemovalSnapshot,
                outputTail: publisher.output()
                  .slice(sessionlessRecoveryOutputOffset)
                  .slice(-5000)
              }
            );
            const sessionlessRecoverySearchStart = signal.events.length;
            requestOffer(
              signal,
              staleUuid,
              streamId,
              `${brokenSessionlessOffer.message.session}-sessionless-fixture-recovery`
            );
            offerB = await signal.waitFor(
              isOfferFor(staleUuid),
              sessionlessRecoverySearchStart,
              config.offerTimeoutMs
            );
            requireHarnessFixture(
              report,
              'sessionless-wss-product-failure-recovery-restores-distinct-offer-b',
              !!offerB &&
                offerB.message.session !== offerA.message.session &&
                offerB.message.session !== brokenSessionlessOffer.message.session &&
                offerB.message.description.sdp !== offerA.message.description.sdp,
              {
                retiredSession: offerA.message.session,
                brokenSession: brokenSessionlessOffer.message.session,
                recoverySession: offerB ? offerB.message.session : '',
                recoverySdpSha256: offerB
                  ? sha256Text(offerB.message.description.sdp)
                  : ''
              }
            );
            offerBFixtureRecoveryUsed = true;
            addEvidence(
              report,
              'sessionless-wss-fixture-recovery-does-not-hide-product-failure',
              {
                sessionlessCandidateSafelyRejected,
                sessionlessAnswerSafelyRejected,
                brokenSession: brokenSessionlessOffer.message.session,
                recoverySession: offerB.message.session
              }
            );
          }

          const validAnswerB = await answerOffer(
            page, stalePeerName, offerB.message, false, DIRECT_BROWSER_RTC_CONFIG
          );
          const activeOfferBBrowserState = await page.evaluate(
            (name) => window.__gameCapturePeerState(name),
            stalePeerName
          );
          requireHarnessFixture(
            report,
            'offer-b-browser-peer-owns-distinct-active-wire-session',
            offerB.message.session !== offerA.message.session &&
              !!activeOfferBBrowserState &&
              activeOfferBBrowserState.wireSession === offerB.message.session,
            {
              retiredSession: offerA.message.session,
              activeSession: offerB.message.session,
              browserWireSession: activeOfferBBrowserState
                ? activeOfferBBrowserState.wireSession
                : ''
            }
          );
          const retiredBrowserPeerA = await page.evaluate(
            ({ name, peerInstanceId }) =>
              window.__retiredGameCapturePeerState(name, peerInstanceId),
            { name: stalePeerName, peerInstanceId: validAnswerA.peerInstanceId }
          );
          addCheck(report, 'generation-a-browser-peer-is-closed-before-offer-b-answer',
            validAnswerB.peerInstanceId !== validAnswerA.peerInstanceId &&
              retiredBrowserPeerA.found &&
              retiredBrowserPeerA.signalingState === 'closed' &&
              retiredBrowserPeerA.dataChannelOpen === false,
            {
              generationAPeerInstanceId: validAnswerA.peerInstanceId,
              generationBPeerInstanceId: validAnswerB.peerInstanceId,
              retiredBrowserPeerA
            });
          const offerAUfrag = extractIceUfrag(offerA.message.description.sdp);
          const offerBUfrag = extractIceUfrag(offerB.message.description.sdp);
          const answerAUfrag = extractIceUfrag(validAnswerA.sdp);
          const answerBUfrag = extractIceUfrag(validAnswerB.sdp);
          const answerBSdpSha256 = sha256Text(validAnswerB.sdp);
          const activeCandidateB = validAnswerB.candidates.find((candidate) =>
            candidate.sourcePeerInstanceId === validAnswerB.peerInstanceId &&
            candidate.sourceGenerationUfrag === answerBUfrag &&
            candidate.sourceCandidateIndex >= validAnswerB.candidateStart &&
            candidate.sourceCandidateIndex < validAnswerB.candidateEnd
          );
          const activeCandidateBWireSha256 = browserCandidateWireSha256(
            activeCandidateB
          );
          const activeCandidateBCandidateSha256 = sha256Text(String(
            browserCandidateWire(activeCandidateB).candidate || ''
          ));
          requireHarnessFixture(
            report,
            'offer-b-session-label-probe-has-real-generation-b-candidate',
            !!activeCandidateB,
            {
              peerInstanceId: validAnswerB.peerInstanceId,
              answerBUfrag,
              candidateWireSha256: activeCandidateB
                ? activeCandidateBWireSha256
                : ''
            }
          );
          const answerASentWire = new Set(answerACandidateSentEvents.map((entry) =>
            JSON.stringify(entry.message.candidate)
          ));
          const answerBWire = new Set(validAnswerB.candidates.map((candidate) =>
            canonicalBrowserCandidateWire(candidate)
          ));
          const staleCandidateA = validAnswerA.candidates.find((candidate) =>
            candidate.sourcePeerInstanceId === validAnswerA.peerInstanceId &&
            candidate.sourceGenerationUfrag === answerAUfrag &&
            candidate.sourceCandidateIndex >= validAnswerA.candidateStart &&
            candidate.sourceCandidateIndex < validAnswerA.candidateEnd &&
            answerASentWire.has(canonicalBrowserCandidateWire(candidate)) &&
            !answerBWire.has(canonicalBrowserCandidateWire(candidate))
          );
          const staleCandidateWire = browserCandidateWire(staleCandidateA);
          const staleCandidateLineUfrag = extractCandidateLineUfrag(staleCandidateA);
          const staleCandidateWireUfrag = String(
            staleCandidateWire.usernameFragment || staleCandidateLineUfrag || ''
          );
          const candidateIsUniqueToA = !!staleCandidateA &&
            !validAnswerB.candidates.some((candidate) =>
              canonicalBrowserCandidateWire(candidate) ===
                canonicalBrowserCandidateWire(staleCandidateA)
            );
          const candidateWasSentDuringA = !!staleCandidateA &&
            answerASentWire.has(canonicalBrowserCandidateWire(staleCandidateA));
          const staleCandidateAWireSha256 = browserCandidateWireSha256(
            staleCandidateA
          );
          const staleCandidateACandidateSha256 = sha256Text(String(
            staleCandidateWire.candidate || ''
          ));

          requireHarnessFixture(
            report,
            'stale-candidate-fixture-has-distinct-a-b-ice-generations',
            !!offerAUfrag && !!offerBUfrag && offerAUfrag !== offerBUfrag &&
              !!answerAUfrag && !!answerBUfrag && answerAUfrag !== answerBUfrag,
            { offerAUfrag, offerBUfrag, answerAUfrag, answerBUfrag }
          );
          requireHarnessFixture(
            report,
            'stale-answer-fixture-has-distinct-a-b-payload-fingerprints',
            /^[0-9a-f]{64}$/.test(answerASdpSha256) &&
              /^[0-9a-f]{64}$/.test(answerBSdpSha256) &&
              answerASdpSha256 !== answerBSdpSha256,
            { answerASdpSha256, answerBSdpSha256 }
          );
          requireHarnessFixture(
            report,
            'stale-candidate-fixture-has-distinct-a-b-payload-fingerprints',
            !!staleCandidateA && !!activeCandidateB &&
              browserCandidateFingerprintCoversWire(staleCandidateA) &&
              browserCandidateFingerprintCoversWire(activeCandidateB) &&
              /^[0-9a-f]{64}$/.test(staleCandidateAWireSha256) &&
              /^[0-9a-f]{64}$/.test(activeCandidateBWireSha256) &&
              staleCandidateAWireSha256 !== activeCandidateBWireSha256 &&
              /^[0-9a-f]{64}$/.test(staleCandidateACandidateSha256) &&
              /^[0-9a-f]{64}$/.test(activeCandidateBCandidateSha256) &&
              staleCandidateACandidateSha256 !== activeCandidateBCandidateSha256,
            {
              staleCandidateAWireSha256,
              activeCandidateBWireSha256,
              staleCandidateACandidateSha256,
              activeCandidateBCandidateSha256,
              staleCanonicalFingerprint: canonicalBrowserCandidateFingerprint(
                staleCandidateA
              ),
              activeCanonicalFingerprint: canonicalBrowserCandidateFingerprint(
                activeCandidateB
              ),
              staleWireKeys: Object.keys(browserCandidateWire(staleCandidateA)),
              activeWireKeys: Object.keys(browserCandidateWire(activeCandidateB))
            }
          );
          requireHarnessFixture(
            report,
            'injected-candidate-is-a-real-generation-a-candidate',
            !!staleCandidateA &&
              staleCandidateA.sourcePeerInstanceId === validAnswerA.peerInstanceId &&
              staleCandidateA.sourceGenerationUfrag === answerAUfrag &&
              staleCandidateA.sourceCandidateIndex >= validAnswerA.candidateStart &&
              staleCandidateA.sourceCandidateIndex < validAnswerA.candidateEnd &&
              candidateWasSentDuringA &&
              candidateIsUniqueToA,
            {
              answerAUfrag,
              answerBUfrag,
              sourcePeerInstanceId: staleCandidateA
                ? staleCandidateA.sourcePeerInstanceId
                : null,
              expectedPeerInstanceId: validAnswerA.peerInstanceId,
              sourceCandidateIndex: staleCandidateA
                ? staleCandidateA.sourceCandidateIndex
                : null,
              candidateStart: validAnswerA.candidateStart,
              candidateEnd: validAnswerA.candidateEnd,
              sourceGenerationUfrag: staleCandidateA
                ? staleCandidateA.sourceGenerationUfrag || ''
                : '',
              directUsernameFragment: staleCandidateA
                ? staleCandidateA.directUsernameFragment || ''
                : '',
              wireUsernameFragment: staleCandidateWire.usernameFragment || '',
              candidateLineUfrag: staleCandidateLineUfrag,
              candidateWasSentDuringA,
              candidateIsUniqueToA,
              candidateWire: staleCandidateA ? staleCandidateWire : null,
              candidateWireSha256: staleCandidateA
                ? staleCandidateAWireSha256
                : ''
            }
          );
          requireHarnessFixture(
            report,
            'stale-candidate-wire-fidelity-preserves-browser-serialization',
            !!staleCandidateA && candidateWasSentDuringA &&
              canonicalBrowserCandidateWire(staleCandidateA) ===
                JSON.stringify(staleCandidateWire),
            {
              wire: staleCandidateA ? staleCandidateWire : null,
              wireSha256: staleCandidateA
                ? staleCandidateAWireSha256
                : '',
              sourceGenerationUfrag: staleCandidateA
                ? staleCandidateA.sourceGenerationUfrag || ''
                : '',
              wireUfrag: staleCandidateWireUfrag
            }
          );

          const expectedActiveOfferCount = offerBFixtureRecoveryUsed ? 1 : 2;
          const candidateCounterBefore = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => snapshot.activeWireSession === offerB.message.session &&
              Number(snapshot.signaling.offer_count || 0) === expectedActiveOfferCount &&
              snapshot.signaling.answer_received === false,
            0,
            8000
          );
          requireHarnessFixture(
            report,
            'packaged-diagnostics-exposes-pre-injection-candidate-counter',
            !!candidateCounterBefore &&
              candidateCounterBefore.activeWireSession === offerB.message.session &&
              Number(candidateCounterBefore.signaling.offer_count || 0) ===
                expectedActiveOfferCount &&
              candidateCounterBefore.signaling.answer_received === false &&
              Number.isFinite(Number(
                candidateCounterBefore.signaling.remote_candidates_applied
              )),
            {
              diagnosticsPath,
              offerBFixtureRecoveryUsed,
              expectedActiveSession: offerB.message.session,
              expectedActiveOfferCount,
              snapshot: candidateCounterBefore
            }
          );

          const staleCandidateOffset = publisher.output().length;
          sendExactBrowserCandidate(
            signal,
            staleUuid,
            offerA.message.session,
            staleCandidateA
          );
          await wait(250);
          const candidateCounterAfter = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            () => true,
            candidateCounterBefore.generatedSteadyMs,
            8000
          );
          requireHarnessFixture(
            report,
            'packaged-diagnostics-exposes-post-injection-candidate-counter',
            !!candidateCounterAfter &&
              Number.isFinite(Number(
                candidateCounterAfter.signaling.remote_candidates_applied
              )),
            { diagnosticsPath, snapshot: candidateCounterAfter }
          );

          const staleCandidateOutput = publisher.output().slice(staleCandidateOffset);
          const rejectionLines = explicitStaleCandidateRejectionLines(
            staleCandidateOutput,
            staleUuid,
            offerA.message.session,
            staleCandidateACandidateSha256
          );
          const candidateAppliedBefore = Number(
            candidateCounterBefore.signaling.remote_candidates_applied
          );
          const candidateAppliedAfter = Number(
            candidateCounterAfter.signaling.remote_candidates_applied
          );
          const webRtcQueuedCount = countOccurrences(
            staleCandidateOutput,
            '[WebRTC] Queued remote ICE candidate until remote description is set'
          );
          const signalingQueuedCount = countOccurrences(
            staleCandidateOutput,
            '[Signaling] Queued remote ICE candidate uuid='
          );
          const oldSessionCandidateQueuedCount = countOccurrences(
            staleCandidateOutput,
            `[Signaling] Queued remote ICE candidate uuid=${staleUuid} ` +
              `session=${offerA.message.session}`
          );
          const candidateRejectedBeforeAnswerB = rejectionLines.length > 0 &&
            candidateAppliedAfter === candidateAppliedBefore &&
            webRtcQueuedCount === 0 && oldSessionCandidateQueuedCount === 0;
          addCheck(
            report,
            'generation-a-candidate-is-explicitly-rejected-while-offer-b-is-outstanding',
            candidateRejectedBeforeAnswerB && signalingQueuedCount === 0,
            {
              offerBUfrag,
              sourceGenerationUfrag: answerAUfrag,
              injectedCandidateWireUfrag: staleCandidateWireUfrag,
              injectedCandidateWireSha256: staleCandidateAWireSha256,
              injectedCandidateSha256: staleCandidateACandidateSha256,
              explicitRejectionLines: rejectionLines,
              remoteCandidatesAppliedBefore: candidateAppliedBefore,
              remoteCandidatesAppliedAfter: candidateAppliedAfter,
              currentGenerationRemoteCandidateApplyIncrement:
                candidateAppliedAfter - candidateAppliedBefore,
              webRtcQueuedCount,
              signalingQueuedCount,
              oldSessionCandidateQueuedCount,
              failedAddCount: countOccurrences(
                staleCandidateOutput,
                '[WebRTC] Failed to add remote ICE candidate'
              ),
              outputTail: staleCandidateOutput.slice(-5000)
            }
          );

          const mislabeledActiveCandidateOffset = publisher.output().length;
          sendExactBrowserCandidate(
            signal,
            staleUuid,
            offerA.message.session,
            activeCandidateB
          );
          await wait(250);
          const counterAfterMislabeledActiveCandidate =
            await waitForDiagnosticsPeerSnapshot(
              diagnosticsPath,
              staleUuid,
              () => true,
              candidateCounterAfter.generatedSteadyMs,
              8000
            );
          requireHarnessFixture(
            report,
            'diagnostics-refreshes-after-mislabeled-offer-b-candidate',
            !!counterAfterMislabeledActiveCandidate,
            { diagnosticsPath, snapshot: counterAfterMislabeledActiveCandidate }
          );
          const mislabeledActiveCandidateOutput = publisher.output()
            .slice(mislabeledActiveCandidateOffset);
          const mislabeledActiveCandidateRejections =
            explicitStaleCandidateRejectionLines(
              mislabeledActiveCandidateOutput,
                staleUuid,
                offerA.message.session,
                activeCandidateBCandidateSha256
            );
          const appliedAfterMislabeledActiveCandidate = Number(
            counterAfterMislabeledActiveCandidate.signaling.remote_candidates_applied
          );
          const activeCandidateRejectedUnderRetiredLabel =
            mislabeledActiveCandidateRejections.length > 0 &&
            appliedAfterMislabeledActiveCandidate === candidateAppliedAfter &&
            countOccurrences(
              mislabeledActiveCandidateOutput,
              `[Signaling] Queued remote ICE candidate uuid=${staleUuid} ` +
                `session=${offerA.message.session}`
            ) === 0;
          addCheck(
            report,
            'offer-b-candidate-labeled-as-retired-a-is-rejected-before-content-routing',
            activeCandidateRejectedUnderRetiredLabel,
            {
              retiredSession: offerA.message.session,
              activeSession: offerB.message.session,
              candidateWireSha256: activeCandidateBWireSha256,
              candidateSha256: activeCandidateBCandidateSha256,
              explicitRejectionLines: mislabeledActiveCandidateRejections,
              remoteCandidatesAppliedBefore: candidateAppliedAfter,
              remoteCandidatesAppliedAfter: appliedAfterMislabeledActiveCandidate,
              outputTail: mislabeledActiveCandidateOutput.slice(-5000)
            }
          );

          const staleAnswerObservationTimeoutMs = 4000;
          const mislabeledActiveAnswerOffset = publisher.output().length;
          const mislabeledActiveAnswerSentEvent = sendAnswer(
            signal,
            staleUuid,
            streamId,
            offerA.message.session,
            validAnswerB.sdp
          );
          requireHarnessFixture(
            report,
            'mislabeled-active-answer-wire-matches-exact-browser-sdp-fixture',
            !!mislabeledActiveAnswerSentEvent &&
              mislabeledActiveAnswerSentEvent.message.UUID === staleUuid &&
              mislabeledActiveAnswerSentEvent.message.session === offerA.message.session &&
              mislabeledActiveAnswerSentEvent.message.description.type === 'answer' &&
              mislabeledActiveAnswerSentEvent.message.description.sdp === validAnswerB.sdp &&
              sha256Text(mislabeledActiveAnswerSentEvent.message.description.sdp) ===
                answerBSdpSha256,
            {
              expectedSdpSha256: answerBSdpSha256,
              sentSdpSha256: mislabeledActiveAnswerSentEvent
                ? sha256Text(mislabeledActiveAnswerSentEvent.message.description.sdp)
                : '',
              sentMessage: mislabeledActiveAnswerSentEvent
                ? mislabeledActiveAnswerSentEvent.message
                : null
            }
          );
          const mislabeledActiveAnswerObservation = await waitForPublisherOutput(
            publisher,
            mislabeledActiveAnswerOffset,
            (output) => explicitStaleAnswerRejectionLines(
              output,
              staleUuid,
              offerA.message.session
            ).length > 0,
            staleAnswerObservationTimeoutMs
          );
          const mislabeledActiveAnswerCounterFloor = await readCurrentDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid
          );
          requireHarnessFixture(
            report,
            'mislabeled-active-answer-observation-establishes-current-counter-floor',
            !!mislabeledActiveAnswerCounterFloor &&
              mislabeledActiveAnswerCounterFloor.peerCount === 1 &&
              mislabeledActiveAnswerCounterFloor.activeWireSession === offerB.message.session,
            { snapshot: mislabeledActiveAnswerCounterFloor }
          );
          const mislabeledActiveAnswerCounterAfter = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === offerB.message.session,
            mislabeledActiveAnswerCounterFloor.generatedSteadyMs,
            8000
          );
          requireHarnessFixture(
            report,
            'mislabeled-active-answer-observation-has-fresh-diagnostics',
            !!mislabeledActiveAnswerCounterAfter,
            { snapshot: mislabeledActiveAnswerCounterAfter }
          );
          const mislabeledActiveAnswerOutput = publisher.output()
            .slice(mislabeledActiveAnswerOffset);
          const mislabeledActiveAnswerRejections = explicitStaleAnswerRejectionLines(
            mislabeledActiveAnswerOutput,
            staleUuid,
            offerA.message.session
          );
          addCheck(
            report,
            'offer-b-answer-labeled-as-retired-a-is-rejected-before-sdp-routing',
            mislabeledActiveAnswerObservation.ok &&
              mislabeledActiveAnswerRejections.length > 0 &&
              countOccurrences(
                mislabeledActiveAnswerOutput,
                '[App] Applying peer answer'
              ) === 0 &&
              Number(mislabeledActiveAnswerCounterAfter.signaling.answer_count || 0) ===
                Number(counterAfterMislabeledActiveCandidate.signaling.answer_count || 0) &&
              mislabeledActiveAnswerCounterAfter.signaling.answer_received === false,
            {
              retiredSession: offerA.message.session,
              activeSession: offerB.message.session,
              answerSdpSha256: answerBSdpSha256,
              observation: mislabeledActiveAnswerObservation,
              counterBefore: counterAfterMislabeledActiveCandidate,
              counterAfter: mislabeledActiveAnswerCounterAfter,
              explicitRejectionLines: mislabeledActiveAnswerRejections,
              outputTail: mislabeledActiveAnswerOutput.slice(-5000)
            }
          );

          const staleApplyOffset = publisher.output().length;
          const staleAnswerSentEvent = sendAnswer(
            signal,
            staleUuid,
            streamId,
            offerA.message.session,
            validAnswerA.sdp
          );
          requireHarnessFixture(
            report,
            'never-applied-answer-wire-matches-exact-browser-sdp-fixture',
            !!staleAnswerSentEvent &&
              staleAnswerSentEvent.message.UUID === staleUuid &&
              staleAnswerSentEvent.message.session === offerA.message.session &&
              staleAnswerSentEvent.message.description.type === 'answer' &&
              staleAnswerSentEvent.message.description.sdp === validAnswerA.sdp &&
              sha256Text(staleAnswerSentEvent.message.description.sdp) === answerASdpSha256,
            {
              expectedSdpSha256: answerASdpSha256,
              sentSdpSha256: staleAnswerSentEvent
                ? sha256Text(staleAnswerSentEvent.message.description.sdp)
                : '',
              sentMessage: staleAnswerSentEvent ? staleAnswerSentEvent.message : null
            }
          );
          const staleAnswerObservation = await waitForPublisherOutput(
            publisher,
            staleApplyOffset,
            (output) => explicitStaleAnswerRejectionLines(
              output,
              staleUuid,
              offerA.message.session
            ).length > 0,
            staleAnswerObservationTimeoutMs
          );
          const staleAnswerCounterFloor = await readCurrentDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid
          );
          requireHarnessFixture(
            report,
            'never-applied-answer-observation-establishes-current-counter-floor',
            !!staleAnswerCounterFloor && staleAnswerCounterFloor.peerCount === 1 &&
              staleAnswerCounterFloor.activeWireSession === offerB.message.session,
            { snapshot: staleAnswerCounterFloor }
          );
          const staleAnswerCounterAfter = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => snapshot.peerCount === 1 &&
              snapshot.activeWireSession === offerB.message.session,
            staleAnswerCounterFloor.generatedSteadyMs,
            8000
          );
          requireHarnessFixture(
            report,
            'never-applied-answer-observation-has-fresh-diagnostics',
            !!staleAnswerCounterAfter,
            { snapshot: staleAnswerCounterAfter }
          );
          const staleApplyOutput = publisher.output().slice(staleApplyOffset);
          const staleAnswerRejections = explicitStaleAnswerRejectionLines(
            staleApplyOutput,
            staleUuid,
            offerA.message.session
          );
          const staleExplicitlyRejected = staleAnswerRejections.length > 0;
          addCheck(report, 'never-applied-answer-a-is-rejected-while-offer-b-is-outstanding',
            staleAnswerObservation.ok && staleExplicitlyRejected &&
              countOccurrences(staleApplyOutput, '[App] Applying peer answer') === 0 &&
              Number(staleAnswerCounterAfter.signaling.answer_count || 0) ===
                Number(mislabeledActiveAnswerCounterAfter.signaling.answer_count || 0) &&
              staleAnswerCounterAfter.signaling.answer_received === false, {
              staleExplicitlyRejected,
              observation: staleAnswerObservation,
              counterBefore: mislabeledActiveAnswerCounterAfter,
              counterAfter: staleAnswerCounterAfter,
              explicitRejectionLines: staleAnswerRejections,
              applyingAnswerCount: countOccurrences(
                staleApplyOutput, '[App] Applying peer answer'
              ),
              outputTail: staleApplyOutput.slice(-5000)
            });

          // Keep the accepted generation-B candidate within the publisher's
          // bounded pending-candidate lifetime. The stale-answer probes above
          // intentionally wait for fresh diagnostics and must complete before
          // this candidate is queued.
          const correctlyLabeledActiveCandidateOffset = publisher.output().length;
          sendExactBrowserCandidate(
            signal,
            staleUuid,
            offerB.message.session,
            activeCandidateB
          );
          await wait(250);
          const counterAfterCorrectlyLabeledActiveCandidate =
            await waitForDiagnosticsPeerSnapshot(
              diagnosticsPath,
              staleUuid,
              () => true,
              staleAnswerCounterAfter.generatedSteadyMs,
              8000
            );
          requireHarnessFixture(
            report,
            'diagnostics-refreshes-after-correctly-labeled-offer-b-candidate',
            !!counterAfterCorrectlyLabeledActiveCandidate,
            { diagnosticsPath, snapshot: counterAfterCorrectlyLabeledActiveCandidate }
          );
          const correctlyLabeledActiveCandidateOutput = publisher.output()
            .slice(correctlyLabeledActiveCandidateOffset);
          const activeCandidateQueuedUnderActiveLabel = countOccurrences(
            correctlyLabeledActiveCandidateOutput,
            `[Signaling] Queued remote ICE candidate uuid=${staleUuid} ` +
              `session=${offerB.message.session}`
          ) === 1;
          const activeCandidateRejectedUnderActiveLabel =
            explicitStaleCandidateRejectionLines(
              correctlyLabeledActiveCandidateOutput,
              staleUuid,
              offerB.message.session,
              activeCandidateBCandidateSha256
            ).length > 0;
          const activeCandidateAcceptedBeforeAnswer =
            activeCandidateQueuedUnderActiveLabel &&
            !activeCandidateRejectedUnderActiveLabel &&
            Number(
              counterAfterCorrectlyLabeledActiveCandidate.signaling.remote_candidates_applied
            ) === appliedAfterMislabeledActiveCandidate;

          const recoveryOutputOffset = publisher.output().length;
          const remainingActiveCandidatesB = validAnswerB.candidates.filter((candidate) =>
            canonicalBrowserCandidateWire(candidate) !==
              canonicalBrowserCandidateWire(activeCandidateB)
          );
          sendAnswer(signal, staleUuid, streamId, offerB.message.session, validAnswerB.sdp);
          const isolatedActiveCandidateAppliedSnapshot = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            (snapshot) => Number(
              snapshot.signaling.remote_candidates_applied
            ) === appliedAfterMislabeledActiveCandidate + 1,
            counterAfterCorrectlyLabeledActiveCandidate.generatedSteadyMs,
            8000
          );
          const isolatedActiveCandidateApplied = isolatedActiveCandidateAppliedSnapshot
            ? Number(
              isolatedActiveCandidateAppliedSnapshot.signaling.remote_candidates_applied
            )
            : Number.NaN;
          sendBrowserCandidates(
            signal,
            staleUuid,
            offerB.message.session,
            remainingActiveCandidatesB
          );
          const generationBConnected = await waitForPeerState(
            signal,
            page,
            staleUuid,
            stalePeerName,
            (state) => state.connectionState === 'connected' && state.dataChannelOpen,
            15000,
            offerB.index + 1
          );
          const generationBMedia = generationBConnected.ok ? await waitForFreshVideo(
            signal,
            page,
            staleUuid,
            stalePeerName,
            12000,
            offerB.index + 1
          ) : { ok: false, state: generationBConnected.state };
          const postRecoveryCandidateSnapshot = await waitForDiagnosticsPeerSnapshot(
            diagnosticsPath,
            staleUuid,
            () => true,
            isolatedActiveCandidateAppliedSnapshot
              ? isolatedActiveCandidateAppliedSnapshot.generatedSteadyMs
              : counterAfterCorrectlyLabeledActiveCandidate.generatedSteadyMs,
            8000
          );
          const postRecoveryApplied = postRecoveryCandidateSnapshot
            ? Number(postRecoveryCandidateSnapshot.signaling.remote_candidates_applied)
            : Number.NaN;
          const recoveryOutput = publisher.output().slice(recoveryOutputOffset);
          const oldSessionQueuedAfterInjection = countOccurrences(
            publisher.output().slice(staleCandidateOffset),
            `[Signaling] Queued remote ICE candidate uuid=${staleUuid} ` +
              `session=${offerA.message.session}`
          );
          addCheck(
            report,
            'offer-b-candidate-identical-bytes-are-accepted-under-active-b-session',
            activeCandidateAcceptedBeforeAnswer &&
              Number.isFinite(isolatedActiveCandidateApplied) &&
              isolatedActiveCandidateApplied === appliedAfterMislabeledActiveCandidate + 1,
            {
              retiredSession: offerA.message.session,
              activeSession: offerB.message.session,
              candidateWireSha256: activeCandidateBWireSha256,
              candidateSha256: activeCandidateBCandidateSha256,
              queuedUnderActiveSession: activeCandidateQueuedUnderActiveLabel,
              rejectedUnderActiveSession: activeCandidateRejectedUnderActiveLabel,
              appliedBeforeAnswer: appliedAfterMislabeledActiveCandidate,
              appliedAfterIsolatedAnswer: isolatedActiveCandidateApplied,
              isolatedSnapshot: isolatedActiveCandidateAppliedSnapshot,
              appliedAfterRemainingCandidates: postRecoveryApplied,
              outputTail: recoveryOutput.slice(-5000)
            }
          );
          addCheck(
            report,
            'offer-b-answer-identical-sdp-is-accepted-under-active-b-session',
            generationBConnected.ok && generationBMedia.ok &&
              countOccurrences(recoveryOutput, '[App] Applying peer answer') === 1,
            {
              retiredSession: offerA.message.session,
              activeSession: offerB.message.session,
              answerSdpSha256: sha256Text(validAnswerB.sdp),
              applyingAnswerCount: countOccurrences(
                recoveryOutput,
                '[App] Applying peer answer'
              ),
              state: generationBMedia.state || generationBConnected.state
            }
          );
          addCheck(
            report,
            'generation-a-candidate-is-not-drained-or-applied-to-offer-b',
            candidateRejectedBeforeAnswerB &&
              oldSessionCandidateQueuedCount === 0 &&
              oldSessionQueuedAfterInjection === 0 &&
              candidateAppliedAfter === candidateAppliedBefore &&
              generationBConnected.ok && generationBMedia.ok,
            {
              candidateRejectedBeforeAnswerB,
              oldSessionCandidateQueuedCount,
              oldSessionQueuedAfterInjection,
              remoteCandidatesAppliedBefore: candidateAppliedBefore,
              remoteCandidatesAppliedAfterRecovery: postRecoveryApplied,
              generationBCandidateCount: validAnswerB.candidates.length,
              candidateWireSha256: staleCandidateAWireSha256,
              candidateSha256: staleCandidateACandidateSha256,
              snapshot: postRecoveryCandidateSnapshot,
              recoveryOutputTail: recoveryOutput.slice(-5000)
            }
          );
          addCheck(report, 'offer-b-establishes-fresh-data-and-media-after-old-answer',
            generationBConnected.ok && generationBMedia.ok, {
              state: generationBMedia.state || generationBConnected.state,
              media: { initial: generationBMedia.initial, final: generationBMedia.final }
            });
        }
      }
    }

    const alphaUuid = 'ninja-plugin-alpha-viewer';
    const alphaRequestAt = Date.now();
    const alphaSearchStart = signal.events.length;
    requestOffer(signal, alphaUuid, streamId, '');
    const initialAlphaPeerOffer = await signal.waitFor(
      isOfferFor(alphaUuid), alphaSearchStart, config.offerTimeoutMs
    );
    addCheck(report, 'plugin-peer-initial-offer-arrives', !!initialAlphaPeerOffer, {
      elapsedMs: Date.now() - alphaRequestAt
    });
    if (!initialAlphaPeerOffer) {
      return;
    }
    const initialAlphaSdp = initialAlphaPeerOffer.message.description.sdp;
    const initialAlphaLayout = canonicalAlphaMediaOrder(initialAlphaSdp);
    addCheck(
      report,
      'vp9-alpha-initial-offer-reserves-canonical-media-order',
      initialAlphaLayout.ok,
      {
        order: initialAlphaLayout.order,
        layout: initialAlphaLayout.layout,
        session: initialAlphaPeerOffer.message.session
      }
    );

    const initialAnswer = await answerOffer(
      page, 'alpha-peer', initialAlphaPeerOffer.message, false, DIRECT_BROWSER_RTC_CONFIG
    );
    sendBrowserCandidates(
      signal,
      alphaUuid,
      initialAlphaPeerOffer.message.session,
      initialAnswer.candidates
    );
    sendAnswer(
      signal,
      alphaUuid,
      streamId,
      initialAlphaPeerOffer.message.session,
      initialAnswer.sdp
    );
    const connected = await waitForPeerState(
      signal,
      page,
      alphaUuid,
      'alpha-peer',
      (state) => state.connectionState === 'connected' && state.dataChannelOpen,
      12000,
      initialAlphaPeerOffer.index + 1
    );
    addCheck(report, 'packaged-signal-chain-opens-real-datachannel', connected.ok, connected.state);
    if (!connected.ok) {
      return;
    }

    // Rebuild the transport before the native receiver advertises alpha
    // support. The reserved alpha section is a transport invariant; receiver
    // capability gates packets only and must not alter the SDP shape.
    const restartBeforeCapability = await remoteFirstRestart({
      config,
      report,
      signal,
      page,
      streamId,
      uuid: alphaUuid,
      session: initialAlphaPeerOffer.message.session,
      peerName: 'alpha-peer',
      rtcConfig: DIRECT_BROWSER_RTC_CONFIG,
      expectedRelay: false
    });
    const restartAlphaLayout = canonicalAlphaMediaOrder(
      restartBeforeCapability.offer && restartBeforeCapability.offer.message &&
        restartBeforeCapability.offer.message.description
        ? restartBeforeCapability.offer.message.description.sdp
        : ''
    );
    addCheck(
      report,
      'vp9-alpha-restart-before-capability-preserves-canonical-media-order',
      restartBeforeCapability.ok && restartAlphaLayout.ok,
      {
        reason: restartBeforeCapability.reason,
        order: restartAlphaLayout.order,
        layout: restartAlphaLayout.layout,
        state: restartBeforeCapability.state
      }
    );
    let activeAlphaBaseOffer = restartBeforeCapability.offer || initialAlphaPeerOffer;
    let activeAlphaBaseState = restartBeforeCapability.state;
    if (!restartBeforeCapability.ok) {
      const brokenAlphaSession = restartBeforeCapability.activeSession ||
        initialAlphaPeerOffer.message.session;
      const alphaRecoveryRemovalOffset = publisher.output().length;
      signal.send({
        bye: true,
        UUID: alphaUuid,
        session: brokenAlphaSession,
        streamID: streamId
      });
      const alphaRecoveryRemovalStarted = Date.now();
      let alphaRecoveryRemovedBrokenPeer = false;
      while (Date.now() - alphaRecoveryRemovalStarted < 8000) {
        const output = publisher.output().slice(alphaRecoveryRemovalOffset);
        if (new RegExp(`Removed peer session ${alphaUuid}:`).test(output)) {
          alphaRecoveryRemovedBrokenPeer = true;
          break;
        }
        await wait(50);
      }
      requireHarnessFixture(
        report,
        'alpha-reset-fixture-recovery-removes-broken-peer',
        alphaRecoveryRemovedBrokenPeer,
        {
          brokenAlphaSession,
          outputTail: publisher.output().slice(alphaRecoveryRemovalOffset).slice(-4000)
        }
      );
      const alphaFixtureRecovery = await connectNewPeer({
        config,
        signal,
        page,
        streamId,
        uuid: alphaUuid,
        session: `${initialAlphaPeerOffer.message.session}-fixture-replacement`,
        peerName: 'alpha-peer',
        rtcConfig: DIRECT_BROWSER_RTC_CONFIG
      });
      requireHarnessFixture(
        report,
        'alpha-reset-fixture-recovery-establishes-measurable-peer',
        alphaFixtureRecovery.ok,
        {
          reason: alphaFixtureRecovery.reason,
          state: alphaFixtureRecovery.state
        }
      );
      addEvidence(report, 'alpha-restart-fixture-recovery-does-not-hide-product-failure', {
        originalRestartOk: restartBeforeCapability.ok,
        originalRestartReason: restartBeforeCapability.reason,
        brokenSession: brokenAlphaSession,
        recoveryRequestHint: alphaFixtureRecovery.requestSessionHint,
        recoveryActiveSession: alphaFixtureRecovery.activeSession
      });
      activeAlphaBaseOffer = alphaFixtureRecovery.offer;
      activeAlphaBaseState = alphaFixtureRecovery.state;
    }
    const alphaBeforeCapability = (activeAlphaBaseState.inboundVideo || [])
      .find((entry) => entry.mid === 'video-alpha');
    addCheck(
      report,
      'reserved-alpha-track-sends-no-packets-before-capability',
      !alphaBeforeCapability || Number(alphaBeforeCapability.packetsReceived || 0) === 0,
      { alphaStats: alphaBeforeCapability || null }
    );
    const alphaNegativeCapabilityVariants = [
      {
        id: 'camel-case-alias',
        info: { alphaReceive: 'vp9-dualtrack-v1' }
      },
      {
        id: 'boolean-true',
        info: { alpha_receive: true }
      },
      {
        id: 'wrong-version',
        info: { alpha_receive: 'vp9-dualtrack-v2' }
      },
      {
        id: 'wrong-case',
        info: { alpha_receive: 'VP9-DUALTRACK-V1' }
      },
      {
        id: 'null',
        info: { alpha_receive: null }
      },
      {
        id: 'object',
        info: { alpha_receive: { mode: 'vp9-dualtrack-v1' } }
      },
      {
        id: 'number',
        info: { alpha_receive: 1 }
      }
    ];
    let alphaNegativeSnapshot = await waitForDiagnosticsPeerSnapshot(
      diagnosticsPath,
      alphaUuid,
      (snapshot) => snapshot.peerCount === 1 &&
        snapshot.activeWireSession === activeAlphaBaseOffer.message.session &&
        snapshot.alphaAllowed === false &&
        snapshot.alphaReceiveMode === '',
      0,
      8000
    );
    requireHarnessFixture(
      report,
      'plugin-alpha-negative-matrix-starts-from-disabled-diagnostics',
      !!alphaNegativeSnapshot,
      {
        expectedSession: activeAlphaBaseOffer.message.session,
        snapshot: alphaNegativeSnapshot
      }
    );
    let allNegativeAlphaCapabilitiesRejected = true;
    const alphaNegativeObservations = [];
    const alphaNegativePostMessageQuiescenceMs = 750;
    for (const variant of alphaNegativeCapabilityVariants) {
      const beforeNegativeState = await page.evaluate(
        (name) => window.__gameCapturePeerState(name),
        'alpha-peer'
      );
      requireHarnessFixture(
        report,
        `plugin-alpha-negative-${variant.id}-uses-live-connected-peer`,
        !!beforeNegativeState && beforeNegativeState.connectionState === 'connected' &&
          beforeNegativeState.dataChannelOpen &&
          beforeNegativeState.wireSession === activeAlphaBaseOffer.message.session,
        { state: beforeNegativeState }
      );
      const beforeNegativeAlpha = (beforeNegativeState && beforeNegativeState.inboundVideo || [])
        .find((entry) => entry.mid === 'video-alpha');
      const beforeNegativeAlphaPackets = Number(
        beforeNegativeAlpha ? beforeNegativeAlpha.packetsReceived || 0 : 0
      );
      const negativeOfferSearchStart = signal.events.length;
      const negativePayload = {
        audio: true,
        video: true,
        broadcast: false,
        info: {
          label: 'OBS VDO.Ninja Viewer Negative Capability Probe',
          platform: 'OBS',
          Browser: 'OBS VDO.Ninja Native Receiver',
          ...variant.info
        }
      };
      const negativeSent = await page.evaluate(
        ({ name, payload }) => window.__sendGameCaptureData(name, payload),
        { name: 'alpha-peer', payload: negativePayload }
      );
      requireHarnessFixture(
        report,
        `plugin-alpha-negative-${variant.id}-message-sent`,
        negativeSent,
        { payload: negativePayload }
      );
      await wait(alphaNegativePostMessageQuiescenceMs);
      const negativeSnapshotAfter = await waitForDiagnosticsPeerSnapshot(
        diagnosticsPath,
        alphaUuid,
        (snapshot) => snapshot.peerCount === 1 &&
          snapshot.activeWireSession === activeAlphaBaseOffer.message.session,
        alphaNegativeSnapshot.generatedSteadyMs,
        7000
      );
      const afterNegativeState = await page.evaluate(
        (name) => window.__gameCapturePeerState(name),
        'alpha-peer'
      );
      const afterNegativeAlpha = (afterNegativeState && afterNegativeState.inboundVideo || [])
        .find((entry) => entry.mid === 'video-alpha');
      const afterNegativeAlphaPackets = Number(
        afterNegativeAlpha ? afterNegativeAlpha.packetsReceived || 0 : 0
      );
      const negativeCapabilityOffers = signal.events
        .slice(negativeOfferSearchStart)
        .filter((entry) => entry.message && isOfferFor(alphaUuid)(entry.message));
      const negativeCapabilityRejected =
        !!negativeSnapshotAfter &&
        negativeSnapshotAfter.alphaAllowed === false &&
        negativeSnapshotAfter.alphaReceiveMode === '' &&
        beforeNegativeAlphaPackets === 0 &&
        afterNegativeAlphaPackets === 0 &&
        negativeCapabilityOffers.length === 0 &&
        !!afterNegativeState &&
        afterNegativeState.peerInstanceId === beforeNegativeState.peerInstanceId &&
        afterNegativeState.wireSession === activeAlphaBaseOffer.message.session &&
        afterNegativeState.connectionState === 'connected' &&
        afterNegativeState.dataChannelOpen;
      addCheck(
        report,
        `plugin-alpha-negative-${variant.id}-remains-disabled`,
        negativeCapabilityRejected,
        {
          variant: variant.id,
          info: variant.info,
          quiescenceMs: alphaNegativePostMessageQuiescenceMs,
          alphaPacketsBefore: beforeNegativeAlphaPackets,
          alphaPacketsAfter: afterNegativeAlphaPackets,
          observedOfferCount: negativeCapabilityOffers.length,
          snapshot: negativeSnapshotAfter,
          browserState: afterNegativeState
        }
      );
      allNegativeAlphaCapabilitiesRejected =
        allNegativeAlphaCapabilitiesRejected && negativeCapabilityRejected;
      alphaNegativeObservations.push({
        id: variant.id,
        rejected: negativeCapabilityRejected,
        alphaPacketsBefore: beforeNegativeAlphaPackets,
        alphaPacketsAfter: afterNegativeAlphaPackets,
        observedOfferCount: negativeCapabilityOffers.length,
        alphaAllowed: negativeSnapshotAfter
          ? negativeSnapshotAfter.alphaAllowed
          : null,
        alphaReceiveMode: negativeSnapshotAfter
          ? negativeSnapshotAfter.alphaReceiveMode
          : null
      });
      if (negativeSnapshotAfter) {
        alphaNegativeSnapshot = negativeSnapshotAfter;
      }
    }
    const alphaNegativeMatrixVerdict =
      alphaNegativeCapabilityVariants.length === 7 &&
      allNegativeAlphaCapabilitiesRejected;
    addCheck(
      report,
      'plugin-alpha-only-exact-snake-case-version-string-is-admitted',
      alphaNegativeMatrixVerdict,
      { observations: alphaNegativeObservations }
    );
    const pluginInfo = {
      audio: true,
      video: true,
      broadcast: false,
      degrade: 'maintain-resolution',
      bitrate: 2500,
      targetBitrate: 2500,
      requestResolution: { w: 640, h: 360 },
      info: {
        label: 'OBS VDO.Ninja Viewer',
        platform: 'OBS',
        Browser: 'OBS VDO.Ninja Native Receiver',
        alpha_receive: 'vp9-dualtrack-v1'
      }
    };
    const alphaCapabilityAt = Date.now();
    const alphaCapabilitySearchStart = signal.events.length;
    const sent = await page.evaluate(
      ({ name, payload }) => window.__sendGameCaptureData(name, payload),
      { name: 'alpha-peer', payload: pluginInfo }
    );
    addCheck(report, 'ninja-plugin-alpha-capability-message-sent', sent, {});
    const alphaTransition = await waitForAlphaActivationOrOffer({
      signal,
      page,
      uuid: alphaUuid,
      peerName: 'alpha-peer',
      afterIndex: alphaCapabilitySearchStart,
      timeoutMs: 15000,
      activationPredicate: (state) => state.connectionState === 'connected' &&
        state.signalingState === 'stable' && state.mids.includes('video-alpha') &&
        requiredVideoIsNonzero(requiredMediaCounters(state))
    });
    const exactAlphaCapabilitySnapshot = await waitForDiagnosticsPeerSnapshot(
      diagnosticsPath,
      alphaUuid,
      (snapshot) => snapshot.peerCount === 1 &&
        snapshot.activeWireSession === activeAlphaBaseOffer.message.session &&
        snapshot.alphaAllowed === true &&
        snapshot.alphaReceiveMode === 'vp9-dualtrack-v1',
      alphaNegativeSnapshot.generatedSteadyMs,
      8000
    );
    const exactAlphaCapabilityDiagnosticsVerdict =
      !!exactAlphaCapabilitySnapshot &&
      exactAlphaCapabilitySnapshot.alphaAllowed === true &&
      exactAlphaCapabilitySnapshot.alphaReceiveMode === 'vp9-dualtrack-v1';
    addCheck(
      report,
      'plugin-alpha-exact-snake-case-version-string-activates-diagnostics',
      exactAlphaCapabilityDiagnosticsVerdict,
      { snapshot: exactAlphaCapabilitySnapshot }
    );
    const alphaOffer = alphaTransition.offer;
    addEvidence(report, 'plugin-alpha-compatibility-path', {
      path: alphaOffer ? 'legacy-late-alpha-offer' : 'initial-alpha-reservation',
      transition: alphaTransition.kind
    });

    let candidateAfterIndex = Math.max(
      activeAlphaBaseOffer.index + 1,
      alphaCapabilitySearchStart
    );
    if (alphaOffer) {
      const alphaAnswer = await answerOffer(
        page, 'alpha-peer', alphaOffer.message, true, DIRECT_BROWSER_RTC_CONFIG
      );
      sendBrowserCandidates(signal, alphaUuid, alphaOffer.message.session, alphaAnswer.candidates);
      sendAnswer(signal, alphaUuid, streamId, alphaOffer.message.session, alphaAnswer.sdp);
      candidateAfterIndex = Math.max(candidateAfterIndex, alphaOffer.index + 1);
    }

    const alphaSdp = alphaOffer
      ? alphaOffer.message.description.sdp
      : activeAlphaBaseOffer.message.description.sdp;
    const vp9Contract = vp9DualTrackContract(alphaSdp);
    addCheck(report, 'ninja-plugin-vp9-dual-track-sdp-contract',
      vp9Contract.ok,
      {
        videoSections: vp9Contract.videoSections,
        session: alphaOffer
          ? alphaOffer.message.session
          : activeAlphaBaseOffer.message.session,
        source: alphaOffer ? 'legacy-late-alpha-offer' : 'initial-offer'
      });
    addCheck(report, 'alpha-capability-keeps-current-wire-session',
      !alphaOffer || alphaOffer.message.session === activeAlphaBaseOffer.message.session,
      {
        initialSession: initialAlphaPeerOffer.message.session,
        restartSession: activeAlphaBaseOffer.message.session,
        alphaSession: alphaOffer ? alphaOffer.message.session : activeAlphaBaseOffer.message.session,
        usedLateAlphaOffer: !!alphaOffer
      });

    const alphaStable = await waitForPeerState(
      signal,
      page,
      alphaUuid,
      'alpha-peer',
      (state) => state.connectionState === 'connected' &&
        state.signalingState === 'stable' &&
        state.mids.includes('video-alpha'),
      12000,
      candidateAfterIndex
    );
    addCheck(report, 'plugin-alpha-capability-stays-connected', alphaStable.ok, alphaStable.state);

    const decoded = await waitForPeerState(
      signal,
      page,
      alphaUuid,
      'alpha-peer',
      (state) => requiredVideoIsNonzero(requiredMediaCounters(state)),
      15000,
      candidateAfterIndex
    );
    addCheck(report, 'plugin-alpha-both-video-tracks-receive-packets', decoded.ok, {
      counters: requiredMediaCounters(decoded.state),
      state: decoded.state
    });

    const decodedBaseline = requiredMediaCounters(decoded.state);
    const decodedAdvance = decoded.ok ? await waitForRequiredVideoAdvance(
      signal,
      page,
      alphaUuid,
      'alpha-peer',
      15000,
      candidateAfterIndex,
      decodedBaseline
    ) : { ok: false, initial: decodedBaseline, final: {}, state: decoded.state };
    addCheck(report, 'plugin-alpha-primary-and-alpha-advance-after-capability',
      decodedAdvance.ok, {
        initial: decodedAdvance.initial,
        final: decodedAdvance.final,
        state: decodedAdvance.state
      });

    const noOfferObservationMs = 3000;
    const remainingNoOfferObservationMs = Math.max(
      0,
      noOfferObservationMs - (Date.now() - alphaCapabilityAt)
    );
    if (alphaTransition.kind === 'activated-without-offer' && remainingNoOfferObservationMs > 0) {
      await wait(remainingNoOfferObservationMs);
    }
    const capabilityOffers = signal.events
      .slice(alphaCapabilitySearchStart)
      .map((entry, offset) => ({ entry, index: alphaCapabilitySearchStart + offset }))
      .filter(({ entry }) => entry.message && isOfferFor(alphaUuid)(entry.message))
      .map(({ entry, index }) => ({
        index,
        elapsedMs: entry.at - alphaCapabilityAt,
        session: entry.message.session || '',
        ufrag: extractIceUfrag(entry.message.description.sdp)
      }));
    addCheck(
      report,
      'plugin-alpha-capability-activates-without-second-offer',
      initialAlphaLayout.ok && alphaTransition.kind === 'activated-without-offer' &&
        capabilityOffers.length === 0,
      {
        transition: alphaTransition.kind,
        elapsedMs: Date.now() - alphaCapabilityAt,
        minimumObservationMs: noOfferObservationMs,
        initialOrder: initialAlphaLayout.order,
        observedOffers: capabilityOffers
      }
    );
  } finally {
    liveDiagnosticsContext = null;
    report.negotiationPublisherOutputTail = publisher.output().split(/\r?\n/).slice(-120);
    await context.close().catch(() => {});
    const publisherTermination = await publisher.stop();
    report.negotiationDiagnosticsArtifact = fs.existsSync(diagnosticsPath) ? {
      path: diagnosticsPath,
      sha256: sha256File(diagnosticsPath),
      size: fs.statSync(diagnosticsPath).size,
      publisherTermination
    } : {
      path: diagnosticsPath,
      missing: true,
      publisherTermination
    };
    await signal.close();
  }
}

async function runDirectStunScenario(config, executable, browser, report, mediaFixture) {
  const signal = await startSignalServer();
  const streamId = `ice_direct_${Date.now()}`;
  fs.mkdirSync(config.reportDir, { recursive: true });
  const diagnosticsPath = path.join(
    config.reportDir,
    `signaling-direct-diagnostics-${process.pid}-${Date.now()}.json`
  );
  const publisher = startPublisher(executable, signal.url, {
    streamId,
    iceMode: 'stun-only',
    alpha: false,
    videoCodec: 'vp9',
    source: 'spout',
    spoutSender: mediaFixture.senderName,
    diagnosticsOut: diagnosticsPath,
    durationMs: Math.max(180000, config.delayedRestartMs + config.failureTimeoutMs + 90000)
  });
  report.directStunDiagnosticsPath = diagnosticsPath;
  const { context, page } = await createBrowserPeerPage(browser);
  try {
    const seed = await waitForPublisherReady(
      signal,
      publisher,
      report,
      'direct-stun-publisher-connects-and-seeds',
      mediaFixture
    );
    if (!seed) {
      return;
    }

    const steady = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      uuid: 'direct-steady-viewer',
      session: 'direct-steady-session',
      peerName: 'direct-steady-peer'
    });
    addCheck(report, 'direct-stun-establishes-real-data-and-media', steady.ok, {
      reason: steady.reason,
      state: steady.state,
      media: steady.media
    });
    if (!steady.ok) {
      return;
    }
    requireHarnessFixture(
      report,
      'browser-exposes-selected-candidate-pair-stats',
      !!steady.state.selectedPair,
      { selectedPair: steady.state.selectedPair, candidatePairs: steady.state.candidatePairs }
    );
    addCheck(report, 'direct-stun-selects-a-non-relay-pair',
      selectedPairUsesRelay(steady.state) === false, {
        selectedPair: steady.state.selectedPair
      });

    const uuid = 'delayed-direct-failure-viewer';
    const delayedPeerName = 'delayed-recovery-peer';
    const searchStart = signal.events.length;
    requestOffer(signal, uuid, streamId, 'delayed-direct-session');
    const initialOffer = await signal.waitFor(isOfferFor(uuid), searchStart, config.offerTimeoutMs);
    addCheck(report, 'delayed-recovery-peer-initial-offer-arrives', !!initialOffer, {});
    if (!initialOffer) {
      return;
    }

    const browserAnswer = await answerOffer(
      page, delayedPeerName, initialOffer.message, false, DIRECT_BROWSER_RTC_CONFIG
    );
    const failingAnswer = makeTransportFailureAnswer(browserAnswer.sdp);
    addCheck(report, 'delayed-recovery-fixture-has-invalid-transport-fingerprint',
      /a=fingerprint:sha-256 (?:00:){31}00/i.test(failingAnswer), {});
    const retentionBaselineAt = Date.now();
    const retentionStartState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name), 'direct-steady-peer'
    );
    const retentionStartTotals = mediaTotals(retentionStartState);
    sendBrowserCandidates(signal, uuid, initialOffer.message.session, browserAnswer.candidates);
    const failureOutputOffset = publisher.output().length;
    sendAnswer(signal, uuid, streamId, initialOffer.message.session, failingAnswer);

    const failureStarted = Date.now();
    const failedForwarded = new Set();
    let failed = false;
    let failureSnapshot = null;
    while (Date.now() - failureStarted < config.failureTimeoutMs) {
      await forwardPublisherCandidates(
        signal,
        page,
        uuid,
        delayedPeerName,
        failedForwarded,
        initialOffer.index + 1
      );
      failureSnapshot = await readCurrentDiagnosticsPeerSnapshot(
        diagnosticsPath,
        uuid
      );
      failed = diagnosticsShowsRetiredGeneration(failureSnapshot, 1);
      if (failed) break;
      await wait(250);
    }
    const failureObservedAt = Date.now();
    addCheck(report, 'direct-stun-peer-enters-terminal-transport-state', failed, {
      elapsedMs: Date.now() - failureStarted,
      expectedOfferGeneration: 1,
      diagnosticsPath,
      snapshot: failureSnapshot,
      outputTail: publisher.output().slice(failureOutputOffset).slice(-5000)
    });
    if (!failed) {
      return;
    }

    // A new peer created after the failure proves whether the configured
    // Direct STUN mode was silently mutated to All/TURN.
    await wait(1500);
    const observer = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      uuid: 'post-failure-direct-viewer',
      session: 'post-failure-direct-session',
      peerName: 'post-failure-direct-peer'
    });
    await wait(2500);
    const observerCandidateTypes = observer.offer
      ? signaledCandidateTypes(signal, 'post-failure-direct-viewer', observer.offer.index + 1)
      : [];
    addCheck(report, 'direct-stun-remains-strict-after-peer-failure',
      observer.ok && observerCandidateTypes.length > 0 &&
        !observerCandidateTypes.includes('relay') &&
        selectedPairUsesRelay(observer.state) === false, {
        reason: observer.reason,
        signaledCandidateTypes: observerCandidateTypes,
        selectedPair: observer.state && observer.state.selectedPair,
        outputTail: publisher.output().slice(-5000)
      });

    const remainingDelay = Math.max(
      0,
      config.delayedRestartMs - (Date.now() - failureObservedAt)
    );
    await wait(remainingDelay);
    const restartSearchStart = signal.events.length;
    const restartOutputOffset = publisher.output().length;
    signal.send({
      UUID: uuid,
      session: initialOffer.message.session,
      streamID: streamId,
      iceRestartRequest: true
    });
    const recoveryOffer = await signal.waitFor(
      isOfferFor(uuid), restartSearchStart, config.offerTimeoutMs
    );
    const restartOutput = publisher.output().slice(restartOutputOffset);
    const retentionEndState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name), 'direct-steady-peer'
    );
    const retentionEndTotals = mediaTotals(retentionEndState);
    addCheck(report, 'unrelated-media-continues-through-vdo-watchdog-and-restart-request',
      Date.now() - retentionBaselineAt > 45000 &&
        retentionEndTotals.bytes > retentionStartTotals.bytes &&
        retentionEndTotals.packets > retentionStartTotals.packets &&
        retentionEndTotals.framesDecodedAvailable &&
        retentionEndTotals.frames > retentionStartTotals.frames, {
        evidenceIntervalMs: Date.now() - retentionBaselineAt,
        initial: retentionStartTotals,
        final: retentionEndTotals
      });
    addCheck(report, 'failed-peer-is-retained-past-vdo-45s-watchdog',
      !!recoveryOffer && !/No matching peer for ICE restart/i.test(restartOutput),
      {
        delayAfterFailureObservedMs: Date.now() - failureObservedAt,
        recoveryOfferObserved: !!recoveryOffer,
        outputTail: restartOutput.slice(-5000)
      });
    const initialOfferUfrag = extractIceUfrag(initialOffer.message.description.sdp);
    const recoveryOfferUfrag = recoveryOffer
      ? extractIceUfrag(recoveryOffer.message.description.sdp)
      : '';
    const freshRecoveryGeneration = !!recoveryOffer && !!initialOfferUfrag &&
      !!recoveryOfferUfrag && recoveryOfferUfrag !== initialOfferUfrag &&
      recoveryOffer.message.session !== initialOffer.message.session &&
      recoveryOffer.message.description.sdp !== initialOffer.message.description.sdp;
    addCheck(report, 'retained-direct-peer-restart-uses-fresh-ice-generation',
      freshRecoveryGeneration, {
        initialOfferUfrag,
        recoveryOfferUfrag,
        initialSession: initialOffer.message.session,
        recoverySession: recoveryOffer ? recoveryOffer.message.session : '',
        sameSdp: recoveryOffer
          ? recoveryOffer.message.description.sdp === initialOffer.message.description.sdp
          : null,
        recoveryOfferObserved: !!recoveryOffer
      });
    if (!recoveryOffer) {
      return;
    }

    const recoveryAnswer = await answerOffer(
      page, delayedPeerName, recoveryOffer.message, false, DIRECT_BROWSER_RTC_CONFIG
    );
    const retiredFailedBrowserPeer = await page.evaluate(
      ({ name, peerInstanceId }) =>
        window.__retiredGameCapturePeerState(name, peerInstanceId),
      { name: delayedPeerName, peerInstanceId: browserAnswer.peerInstanceId }
    );
    addCheck(report, 'failed-browser-peer-is-closed-before-delayed-recovery-answer',
      recoveryAnswer.peerInstanceId !== browserAnswer.peerInstanceId &&
        retiredFailedBrowserPeer.found &&
        retiredFailedBrowserPeer.signalingState === 'closed' &&
        retiredFailedBrowserPeer.dataChannelOpen === false,
      {
        failedPeerInstanceId: browserAnswer.peerInstanceId,
        recoveryPeerInstanceId: recoveryAnswer.peerInstanceId,
        retiredFailedBrowserPeer
      });
    sendBrowserCandidates(signal, uuid, recoveryOffer.message.session, recoveryAnswer.candidates);
    sendAnswer(signal, uuid, streamId, recoveryOffer.message.session, recoveryAnswer.sdp);
    const recovered = await waitForPeerState(
      signal,
      page,
      uuid,
      delayedPeerName,
      (state) => state.connectionState === 'connected' && state.dataChannelOpen,
      15000,
      recoveryOffer.index + 1
    );
    const recoveredMedia = recovered.ok ? await waitForFreshVideo(
      signal,
      page,
      uuid,
      delayedPeerName,
      12000,
      recoveryOffer.index + 1
    ) : { ok: false, state: recovered.state };
    await wait(1500);
    const delayedCandidateTypes = signaledCandidateTypes(
      signal, uuid, recoveryOffer.index + 1
    );
    addCheck(report, 'delayed-direct-stun-restart-restores-data-and-media-without-turn',
      freshRecoveryGeneration && recovered.ok && recoveredMedia.ok &&
        !delayedCandidateTypes.includes('relay') &&
        selectedPairUsesRelay(recoveredMedia.state || recovered.state) === false, {
        signaledCandidateTypes: delayedCandidateTypes,
        state: recoveredMedia.state || recovered.state,
        media: { initial: recoveredMedia.initial, final: recoveredMedia.final }
      });
  } finally {
    report.directStunPublisherOutputTail = publisher.output().split(/\r?\n/).slice(-160);
    await context.close().catch(() => {});
    const publisherTermination = await publisher.stop();
    report.directStunDiagnosticsArtifact = fs.existsSync(diagnosticsPath) ? {
      path: diagnosticsPath,
      sha256: sha256File(diagnosticsPath),
      size: fs.statSync(diagnosticsPath).size,
      publisherTermination
    } : {
      path: diagnosticsPath,
      missing: true,
      publisherTermination
    };
    await signal.close();
  }
}

async function runAutoIceScenario(config, executable, browser, report, mediaFixture) {
  const signal = await startSignalServer();
  const streamId = `ice_auto_${Date.now()}`;
  const publisher = startPublisher(executable, signal.url, {
    streamId,
    iceMode: 'all',
    alpha: false,
    videoCodec: 'vp9',
    source: 'spout',
    spoutSender: mediaFixture.senderName
  });
  const { context, page } = await createBrowserPeerPage(browser);
  try {
    const seed = await waitForPublisherReady(
      signal,
      publisher,
      report,
      'auto-ice-publisher-connects-and-seeds',
      mediaFixture
    );
    if (!seed) {
      return;
    }

    const peers = [
      {
        uuid: 'auto-viewer-a',
        session: 'auto-session-a',
        peerName: 'auto-peer-a'
      },
      {
        uuid: 'auto-viewer-b',
        session: 'auto-session-b',
        peerName: 'auto-peer-b'
      }
    ];
    for (const peer of peers) {
      peer.connection = await connectNewPeer({
        config,
        signal,
        page,
        streamId,
        ...peer
      });
      addCheck(report, `${peer.peerName}-connects-with-active-media`, peer.connection.ok, {
        reason: peer.connection.reason,
        state: peer.connection.state,
        media: peer.connection.media
      });
      if (!peer.connection.ok) {
        return;
      }
      addCheck(report, `${peer.peerName}-initial-wire-session-honors-viewer-request`,
        peer.connection.sessionContractOk,
        {
          requestSessionHint: peer.connection.requestSessionHint,
          activeSession: peer.connection.activeSession,
          reason: peer.connection.sessionContractReason
        });
      peer.session = peer.connection.activeSession;
      peer.initialActiveSession = peer.connection.activeSession;
      addCheck(report, `${peer.peerName}-auto-initially-selects-direct-pair`,
        selectedPairUsesRelay(peer.connection.state) === false, {
          selectedPair: peer.connection.state.selectedPair
        });
    }

    const cycleResults = [];
    for (let cycle = 0; cycle < config.stressRestarts; cycle++) {
      const target = peers[cycle % peers.length];
      const unaffected = peers[(cycle + 1) % peers.length];
      // First prove forced TURN on each logical peer; any extra cycles alternate
      // back to direct and then relay to stress both rebuild configurations.
      const expectRelay = cycle < 2 ? true : (cycle % 2 === 1);
      const rtcConfig = expectRelay
        ? config.relayRtcConfig
        : DIRECT_BROWSER_RTC_CONFIG;
      if (cycle >= peers.length) {
        const retiredHintBrowserState = await page.evaluate(
          (name) => window.__gameCapturePeerState(name),
          target.peerName
        );
        requireHarnessFixture(
          report,
          `auto-cycle-${cycle + 1}-initial-session-is-proven-retired`,
          !!target.initialActiveSession &&
            target.initialActiveSession !== target.session &&
            !!retiredHintBrowserState &&
            retiredHintBrowserState.wireSession === target.session,
          {
            target: target.peerName,
            initialActiveSession: target.initialActiveSession,
            currentActiveSession: target.session,
            browserWireSession: retiredHintBrowserState
              ? retiredHintBrowserState.wireSession
              : ''
          }
        );
      }
      const requestSessionHint = cycle === 0
        ? `${target.session}-ignored-restart-hint`
        : (cycle >= peers.length ? target.initialActiveSession : target.session);
      const priorTargetSession = target.session;
      const restart = await remoteFirstRestart({
        config,
        report,
        signal,
        page,
        streamId,
        uuid: target.uuid,
        session: target.session,
        requestSessionHint,
        peerName: target.peerName,
        rtcConfig,
        expectedRelay: expectRelay
      });
      await wait(1500);
      const publisherCandidateTypes = restart.offer
        ? signaledCandidateTypes(signal, target.uuid, restart.offer.index + 1)
        : [];
      const freshIceGeneration = !!restart.offerUfrag &&
        restart.offerUfrag !== restart.previousUfrag;
      const selectedRelay = selectedPairUsesRelay(restart.state);
      const targetPass = restart.ok && restart.replacedBrowserPeer &&
        restart.activeSession !== restart.previousSession && freshIceGeneration &&
        selectedRelay === expectRelay &&
        (!expectRelay || publisherCandidateTypes.includes('relay'));
      addCheck(report, `auto-remote-first-restart-${cycle + 1}-uses-fresh-selected-pair`,
        targetPass, {
          target: target.peerName,
          expectedRelay: expectRelay,
          selectedRelay,
          previousUfrag: restart.previousUfrag,
          restartUfrag: restart.offerUfrag,
          previousSession: restart.previousSession,
          activeSession: restart.activeSession,
          replacedBrowserPeer: restart.replacedBrowserPeer,
          publisherCandidateTypes,
          reason: restart.reason,
          selectedPair: restart.state && restart.state.selectedPair,
          media: restart.media
        });
      if (cycle === peers.length) {
        addCheck(report, 'auto-restart-with-retired-session-hint-is-uuid-scoped',
          target.initialActiveSession !== restart.previousSession &&
            restart.requestSessionHint === target.initialActiveSession &&
            restart.ok && restart.activeSession !== restart.previousSession,
          {
            target: target.peerName,
            retiredRequestHint: target.initialActiveSession,
            previousActiveSession: restart.previousSession,
            replacementActiveSession: restart.activeSession,
            reason: restart.reason
          });
      }

      if (!restart.ok) {
        const brokenAutoSession = restart.activeSession || priorTargetSession;
        const autoFixtureRecovery = await recoverScenarioPeer({
          config,
          report,
          signal,
          page,
          publisher,
          streamId,
          uuid: target.uuid,
          peerName: target.peerName,
          brokenSession: brokenAutoSession,
          requestSessionHint:
            `${priorTargetSession}-auto-fixture-replacement-${cycle + 1}`,
          rtcConfig,
          fixtureLabel: `auto-restart-${cycle + 1}-fixture-recovery`
        });
        addEvidence(
          report,
          `auto-restart-${cycle + 1}-fixture-recovery-does-not-hide-product-failure`,
          {
            originalRestartOk: restart.ok,
            originalRestartReason: restart.reason,
            previousSession: priorTargetSession,
            brokenSession: brokenAutoSession,
            recoveryActiveSession: autoFixtureRecovery.activeSession
          }
        );
        target.session = autoFixtureRecovery.activeSession;
        target.connection = autoFixtureRecovery;
      } else {
        target.session = restart.activeSession;
        target.connection = restart;
      }

      const unaffectedMedia = await waitForFreshVideo(
        signal,
        page,
        unaffected.uuid,
        unaffected.peerName,
        12000,
        unaffected.connection.offer.index + 1
      );
      addCheck(report, `auto-restart-${cycle + 1}-does-not-stall-other-peer`,
        unaffectedMedia.ok, {
          unaffected: unaffected.peerName,
          initial: unaffectedMedia.initial,
          final: unaffectedMedia.final,
          state: unaffectedMedia.state
        });
      cycleResults.push(targetPass && unaffectedMedia.ok);
    }

    addCheck(report, 'auto-multi-peer-active-media-restart-stress-completes',
      cycleResults.length === config.stressRestarts && cycleResults.every(Boolean), {
        requestedCycles: config.stressRestarts,
        cycleResults,
        publisherExited: publisher.child.exitCode !== null,
        exitCode: publisher.child.exitCode
      });
  } finally {
    report.autoIcePublisherOutputTail = publisher.output().split(/\r?\n/).slice(-180);
    await context.close().catch(() => {});
    await publisher.stop();
    await signal.close();
  }
}

async function runRelayIceScenario(
  config,
  executable,
  browser,
  report,
  mediaFixture
) {
  const signal = await startSignalServer();
  const scenarioLabel = 'relay-only';
  const streamId = 'ice_relay_only_' + Date.now();
  let publisher = null;
  let context = null;
  let page = null;
  let redactionServers = [];
  let redactionRawResponse = '';
  try {
    await ensureBrowserRtcReadiness(browser, report);
    publisher = startPublisher(executable, signal.url, {
      streamId,
      iceMode: 'relay',
      alpha: false,
      videoCodec: 'vp9',
      source: 'spout',
      spoutSender: mediaFixture.senderName
    });
    const nativeRegistryFingerprint = () => {
      const line = publisher.output().split(/\r?\n/).find((candidate) =>
        /\[ICE\] TurnRegistryFetch(?:\s|$)/.test(candidate)
      ) || '';
      return {
        line,
        transactionId: exactIceSummaryToken(line, 'turnRegistryTransactionId'),
        responseSha256: exactIceSummaryToken(
          line,
          'turnRegistryResponseSha256'
        ).toLowerCase()
      };
    };

    const turnRegistryFetchStartedAtMs = Date.now();
    const turnRegistryResponse = await fetchValidatedTurnRegistryResponse(
      'https://turnservers.vdo.ninja/',
      () => nativeRegistryFingerprint().responseSha256
    );
    const turnRegistryFetchCompletedAtMs = Date.now();
    redactionServers = turnRegistryResponse.servers;
    redactionRawResponse = turnRegistryResponse.rawResponse;

    const turnFixture = await resolveBrowserTurnConfiguration(turnRegistryResponse);
    await ensureTurnFixture(config, browser, report, turnFixture);
    addEvidence(report, 'packaged-turn-live-registry-response-accepted', {
      sourceUrl: turnRegistryResponse.sourceUrl,
      responseSha256: turnRegistryResponse.responseSha256,
      configSha256: turnRegistryResponse.configSha256,
      responseServerCount: turnRegistryResponse.servers.length,
      responseUrlCount: turnFixture.fetchedEndpoints.length,
      boundedFetchObservationCount: turnRegistryResponse.observedCount
    });

    if (publisher.child) {
      ({ context, page } = await createBrowserPeerPage(browser));
      const seed = await waitForPublisherReady(
        signal,
        publisher,
        report,
        scenarioLabel + '-publisher-connects-and-seeds',
        mediaFixture
      );
      if (!seed) {
        return;
      }
    }

    const viewerPrefix = 'relay-only';
    const relay = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      uuid: viewerPrefix + '-viewer',
      session: viewerPrefix + '-session',
      peerName: viewerPrefix + '-peer',
      rtcConfig: turnFixture.rtcConfig
    });
    if (publisher.child) {
      await wait(2000);
    }

    const publisherOutputLines = publisher.output().split(/\r?\n/);
    const nativeTurnRegistryFetchLines = publisherOutputLines.filter((line) =>
      /\[ICE\] TurnRegistryFetch(?:\s|$)/.test(line)
    );
    const consumedIceConfigLines = publisherOutputLines.filter((line) =>
      /\[WebRTC\] ConsumedIceConfig(?:\s|$)/.test(line)
    );
    const nativeTurnRegistryFetch = nativeTurnRegistryFetchLines.length === 1
      ? nativeTurnRegistryFetchLines[0]
      : '';
    const consumedIceConfig = consumedIceConfigLines.length === 1
      ? consumedIceConfigLines[0]
      : '';
    const turnRegistryTransactionId = exactIceSummaryToken(
      nativeTurnRegistryFetch,
      'turnRegistryTransactionId'
    );
    const nativeTurnRegistryResponseSha256 = exactIceSummaryToken(
      nativeTurnRegistryFetch,
      'turnRegistryResponseSha256'
    ).toLowerCase();
    const observedNativeTransactionId = exactIceSummaryToken(
      nativeTurnRegistryFetch,
      'turnRegistryTransactionId'
    );
    const observedNativeResponseSha256 = exactIceSummaryToken(
      nativeTurnRegistryFetch,
      'turnRegistryResponseSha256'
    ).toLowerCase();
    const turnRegistryResponses = [{
      ...turnRegistryResponse,
      transactionId: turnRegistryTransactionId,
      responseSha256: turnRegistryResponse.responseSha256 ||
        nativeTurnRegistryResponseSha256,
      configSha256: turnRegistryResponse.configSha256 ||
        turnRegistryResponseSha256(turnRegistryResponse.servers),
      observedAtMs: turnRegistryResponse.observedAtMs || turnRegistryFetchCompletedAtMs
    }];
    const matchedTurnResponse = matchPackagedTurnResponse(
      turnRegistryResponses,
      turnRegistryTransactionId,
      nativeTurnRegistryResponseSha256,
      turnRegistryFetchStartedAtMs,
      turnRegistryFetchCompletedAtMs
    );
    addCheck(
      report,
      'packaged-turn-registry-fetch-is-unique',
      nativeTurnRegistryFetchLines.length === 1 &&
        /^[0-9a-f]{64}$/.test(nativeTurnRegistryResponseSha256) &&
        observedNativeTransactionId === turnRegistryTransactionId &&
        observedNativeResponseSha256 === nativeTurnRegistryResponseSha256 &&
        nativeTurnRegistryResponseSha256 === turnRegistryResponse.responseSha256 &&
        !!matchedTurnResponse,
      {
        observedDiagnosticCount: nativeTurnRegistryFetchLines.length,
        transactionMatched: observedNativeTransactionId === turnRegistryTransactionId,
        responseSha256Matched:
          observedNativeResponseSha256 === nativeTurnRegistryResponseSha256,
        boundedResponseMatched: !!matchedTurnResponse
      }
    );

    const observedConsumedTransactionId = exactIceSummaryToken(
      consumedIceConfig,
      'turnRegistryTransactionId'
    );
    const observedConsumedResponseSha256 = exactIceSummaryToken(
      consumedIceConfig,
      'turnRegistryResponseSha256'
    ).toLowerCase();
    const observedConsumedTurnSha256 = exactIceSummaryToken(
      consumedIceConfig,
      'turnConfigV1Sha256'
    ).toLowerCase();
    const observedConsumedConfigSha256 = exactIceSummaryToken(
      consumedIceConfig,
      'consumedConfigSha256'
    ).toLowerCase();
    const observedConsumedTurnCount = Number(exactIceSummaryToken(
      consumedIceConfig,
      'turnConfigV1Count'
    ));
    const observedConsumedTurnUrlCount = Number(exactIceSummaryToken(
      consumedIceConfig,
      'turnUrlCount'
    ));
    const observedConsumedIceServerCount = Number(exactIceSummaryToken(
      consumedIceConfig,
      'iceServerCount'
    ));
    const expectedConsumedConfigSha256 = publisher.child
      ? sha256Text(
        TURN_CONSUMED_CONFIG_V1_PREFIX + '\n' + JSON.stringify(
          turnFixture.fetchedEndpoints.map(({ urls, username, credential, udp }) => ({
            url: urls,
            username,
            credential,
            udp
          }))
        )
      )
      : '';
    addCheck(report, 'packaged-turn-consumed-config-matches-fetched-response',
      consumedIceConfigLines.length === 1 &&
        !!matchedTurnResponse &&
        observedConsumedTransactionId === matchedTurnResponse.transactionId &&
        observedConsumedResponseSha256 === matchedTurnResponse.responseSha256 &&
        observedConsumedTurnSha256 === matchedTurnResponse.configSha256 &&
        observedConsumedTurnCount === matchedTurnResponse.servers.length &&
        observedConsumedTurnUrlCount === turnFixture.fetchedEndpoints.length &&
        observedConsumedIceServerCount === turnFixture.fetchedEndpoints.length + 2 &&
        observedConsumedConfigSha256 === expectedConsumedConfigSha256,
      {
        observedDiagnosticCount: consumedIceConfigLines.length,
        transactionMatched: !!matchedTurnResponse &&
          observedConsumedTransactionId === matchedTurnResponse.transactionId,
        rawResponseMatched: !!matchedTurnResponse &&
          observedConsumedResponseSha256 === matchedTurnResponse.responseSha256,
        orderedRegistryConfigMatched: !!matchedTurnResponse &&
          observedConsumedTurnSha256 === matchedTurnResponse.configSha256,
        registryServerCountMatched: !!matchedTurnResponse &&
          observedConsumedTurnCount === matchedTurnResponse.servers.length,
        flattenedUrlCountMatched:
          observedConsumedTurnUrlCount === turnFixture.fetchedEndpoints.length,
        consumedConfigMatched:
          observedConsumedConfigSha256 === expectedConsumedConfigSha256
      }
    );

    if (publisher.child) {
      const publisherCandidateTypes = relay.offer
        ? signaledCandidateTypes(signal, viewerPrefix + '-viewer', relay.offer.index + 1)
        : [];
      const selected = relay.state && relay.state.selectedPair;
      const bothSidesRelay = selected && selected.localCandidate && selected.remoteCandidate &&
        selected.localCandidate.candidateType === 'relay' &&
        selected.remoteCandidate.candidateType === 'relay';
      addCheck(report, scenarioLabel + '-selects-relay-pair-and-delivers-data-media',
        relay.ok && publisherCandidateTypes.length > 0 &&
          publisherCandidateTypes.every((type) => type === 'relay') &&
          bothSidesRelay, {
          reason: relay.reason,
          publisherCandidateTypes,
          selectedPair: selected,
          media: relay.media,
          state: relay.state
        });
    }
  } finally {
    const redactedOutput = redactTurnSecrets(
      redactionServers,
      redactionRawResponse,
      publisher ? publisher.output() : ''
    );
    report.relayIcePublisherOutputTail = redactedOutput.split(/\r?\n/).slice(-160);
    if (context) {
      await context.close().catch(() => {});
    }
    if (publisher && publisher.stop) {
      await publisher.stop();
    }
    if (signal.close) {
      await signal.close();
    }
  }
}
async function runActiveMediaLifecycleScenario(
  config, executable, browser, report, spoutSenderArtifact
) {
  const publisherDurationMs = 120000;
  const fixtures = startLifecycleMediaFixtures(
    publisherDurationMs + 30000,
    spoutSenderArtifact
  );
  requireHarnessFixture(report, 'lifecycle-media-fixture-files-exist', fixtures.ok, {
    missing: fixtures.missing || []
  });

  let signal = null;
  let publisher = null;
  let context = null;
  const fixtureStartedAt = Date.now();
  fs.mkdirSync(config.reportDir, { recursive: true });
  const lifecycleDiagnosticsPath = path.join(
    config.reportDir,
    `signaling-lifecycle-diagnostics-${process.pid}-${Date.now()}.json`
  );
  report.lifecycleDiagnosticsPath = lifecycleDiagnosticsPath;
  try {
    const [spoutReady, toneReady] = await Promise.all([
      fixtures.spout.waitForText(
        /SPOUT_TEST_SENDER_READY[^\r\n]*pattern=alpha-moving-edge/i, 10000
      ),
      fixtures.tone.waitForText(/AUDIO_TEST_TONE_READY/i, 10000)
    ]);
    requireHarnessFixture(report, 'moving-alpha-spout-fixture-is-ready', spoutReady, {
      command: fixtures.spout.command,
      args: fixtures.spout.args,
      output: fixtures.spout.output().slice(-3000)
    });
    assertSpoutSenderArtifactUnchanged(spoutSenderArtifact);
    requireHarnessFixture(report, 'system-audio-tone-fixture-is-ready', toneReady, {
      command: fixtures.tone.command,
      args: fixtures.tone.args,
      output: fixtures.tone.output().slice(-3000)
    });
    report.lifecycleFixtures = {
      senderName: fixtures.senderName,
      spoutSenderPath: fixtures.spoutPath,
      audioToneScriptPath: fixtures.tonePath,
      ...fixtures.hashes,
      spoutArgs: fixtures.spout.args,
      toneArgs: fixtures.tone.args
    };

    signal = await startSignalServer();
    const streamId = `active_media_lifecycle_${Date.now()}`;
    publisher = startPublisher(executable, signal.url, {
      streamId,
      iceMode: 'host-only',
      alpha: true,
      videoCodec: 'vp9',
      audioSource: 'default-output',
      source: 'spout',
      spoutSender: fixtures.senderName,
      durationMs: publisherDurationMs,
      diagnosticsOut: lifecycleDiagnosticsPath
    });
    const publisherStartedAt = Date.now();
    ({ context } = await createBrowserPeerPage(browser));
    const pages = context.pages();
    const page = pages[0];

    const seed = await waitForPublisherReady(
      signal,
      publisher,
      report,
      'active-media-lifecycle-publisher-connects-and-seeds',
      fixtures
    );
    if (!seed) {
      return;
    }

    const primary = {
      uuid: 'active-media-primary-viewer',
      session: 'active-media-primary-session',
      peerName: 'active-media-primary-peer'
    };
    const primaryConnection = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      ...primary
    });
    addCheck(report, 'active-media-primary-initial-connection', primaryConnection.ok, {
      reason: primaryConnection.reason,
      state: primaryConnection.state,
      media: primaryConnection.media
    });
    if (!primaryConnection.ok) {
      return;
    }
    primary.session = primaryConnection.activeSession;

    const primaryAlpha = await enableAlphaAndVerifyMedia({
      config,
      report,
      signal,
      page,
      streamId,
      ...primary,
      afterIndex: primaryConnection.offer.index + 1,
      initialOffer: primaryConnection.offer,
      allowVideoOnlyWorkflow: true
    });
    addCheck(
      report,
      'active-media-initial-offer-reserves-canonical-alpha-layout',
      primaryAlpha.initialAlphaReserved,
      {
        layout: primaryAlpha.initialMediaLayout,
        usedLateAlphaOffer: primaryAlpha.usedLateAlphaOffer
      }
    );
    addCheck(
      report,
      'active-media-alpha-capability-needs-no-second-offer',
      primaryAlpha.initialAlphaReserved && !primaryAlpha.usedLateAlphaOffer,
      {
        layout: primaryAlpha.initialMediaLayout,
        lateOfferSession: primaryAlpha.lateOffer
          ? primaryAlpha.lateOffer.message.session
          : ''
      }
    );
    addEvidence(report, 'active-media-alpha-compatibility-path', {
      path: primaryAlpha.usedLateAlphaOffer
        ? 'legacy-late-alpha-offer'
        : 'initial-alpha-reservation',
      mediaOk: primaryAlpha.ok
    });
    const primaryCounters = requiredMediaCounters(primaryAlpha.state);
    const primaryVideosPresent = ['video', 'video-alpha'].every((mid) =>
      primaryCounters.videoByMid[mid] && primaryCounters.videoByMid[mid].packets > 0 &&
        primaryCounters.videoByMid[mid].frames > 0
    );
    if (!primaryVideosPresent) {
      addCheck(report, 'moving-primary-and-alpha-fixtures-produce-packets', false, {
        reason: primaryAlpha.reason,
        counters: primaryCounters,
        state: primaryAlpha.state,
        publisherOutputTail: publisher.output().slice(-6000)
      });
      return;
    }
    const lifecycleRequiresAudio = primaryCounters.audio.bytes > 0 &&
      primaryCounters.audio.packets > 0 && primaryCounters.audio.energy > 0;
    addCheck(report, 'default-output-tone-is-captured-as-nonzero-audio',
      lifecycleRequiresAudio, {
        counters: primaryCounters,
        toneOutput: fixtures.tone.output().slice(-3000),
        publisherOutputTail: publisher.output().slice(-6000)
      });
    if (!lifecycleRequiresAudio) {
      addEvidence(
        report,
        'zero-audio-product-failure-does-not-hide-lifecycle-signaling-coverage',
        {
          workflowMedia: 'primary-video-and-alpha',
          primaryWorkflowOk: primaryAlpha.workflowOk,
          counters: primaryCounters
        }
      );
    }
    const lifecycleMediaIsNonzero = (counters) => lifecycleRequiresAudio
      ? requiredMediaIsNonzero(counters)
      : requiredVideoIsNonzero(counters);
    const waitForLifecycleMediaAdvance = (...args) => lifecycleRequiresAudio
      ? waitForRequiredMediaAdvance(...args)
      : waitForRequiredVideoAdvance(...args);
    addCheck(report, 'baseline-audio-primary-video-and-alpha-all-advance', primaryAlpha.ok, {
      reason: primaryAlpha.reason,
      initial: primaryAlpha.initial,
      final: primaryAlpha.final,
      state: primaryAlpha.state
    });
    if (!primaryAlpha.workflowOk) {
      return;
    }

    let activePrimary = primary;
    let activeCandidateIndex = primaryAlpha.offer.index + 1;

    const beforeReset = requiredMediaCounters(primaryAlpha.state);
    const reset = await remoteFirstRestart({
      config,
      report,
      signal,
      page,
      streamId,
      ...primary,
      rtcConfig: DIRECT_BROWSER_RTC_CONFIG,
      expectedRelay: false
    });
    if (reset.activeSession) {
      activePrimary = { ...primary, session: reset.activeSession };
    }
    const replacementMediaReady = reset.workflowOk && reset.offer ? await waitForPeerState(
      signal,
      page,
      primary.uuid,
      primary.peerName,
      (state) => lifecycleMediaIsNonzero(requiredMediaCounters(state)),
      15000,
      reset.offer.index + 1
    ) : { ok: false, state: reset.state };
    const replacementBaseline = requiredMediaCounters(replacementMediaReady.state);
    const afterReset = replacementMediaReady.ok && reset.offer ? await waitForLifecycleMediaAdvance(
      signal,
      page,
      primary.uuid,
      primary.peerName,
      15000,
      reset.offer.index + 1,
      replacementBaseline
    ) : { ok: false, initial: beforeReset, final: {}, state: reset.state };
    addCheck(report, 'active-audio-video-alpha-survive-remote-first-reset',
      lifecycleRequiresAudio && reset.ok && replacementMediaReady.ok && afterReset.ok &&
        reset.replacedBrowserPeer && reset.activeSession !== reset.previousSession &&
        reset.offerUfrag !== reset.previousUfrag, {
        reason: reset.reason,
        previousSession: reset.previousSession,
        activeSession: reset.activeSession,
        replacedBrowserPeer: reset.replacedBrowserPeer,
        previousUfrag: reset.previousUfrag,
        restartUfrag: reset.offerUfrag,
        error: reset.error || '',
        selectedPair: reset.state && reset.state.selectedPair,
        before: beforeReset,
        after: afterReset.final,
        state: afterReset.state
      });
    if (!reset.ok || !replacementMediaReady.ok || !afterReset.ok) {
      // Keep executing the independent removal/re-add/shutdown cases after
      // recording the reset failure. The failed peer has an outstanding offer,
      // so remove it and establish a fresh fully-active primary peer.
      signal.send({
        bye: true,
        UUID: activePrimary.uuid,
        session: activePrimary.session,
        streamID: streamId
      });
      await wait(500);
      activePrimary = {
        uuid: 'active-media-post-reset-viewer',
        session: 'active-media-post-reset-session',
        peerName: 'active-media-post-reset-peer'
      };
      const replacementConnection = await connectNewPeer({
        config,
        signal,
        page,
        streamId,
        ...activePrimary
      });
      if (replacementConnection.ok) {
        activePrimary.session = replacementConnection.activeSession;
      }
      const replacementAlpha = replacementConnection.ok ? await enableAlphaAndVerifyMedia({
        config,
        report,
        signal,
        page,
        streamId,
        ...activePrimary,
        afterIndex: replacementConnection.offer.index + 1,
        initialOffer: replacementConnection.offer,
        allowVideoOnlyWorkflow: true,
        validateFullMedia: lifecycleRequiresAudio
      }) : {
        ok: false,
        workflowOk: false,
        reason: replacementConnection.reason,
        state: replacementConnection.state
      };
      addCheck(report, 'fresh-active-peer-allows-lifecycle-validation-after-reset-failure',
        replacementConnection.ok && replacementAlpha.ok, {
          connectionReason: replacementConnection.reason,
          alphaReason: replacementAlpha.reason,
          initial: replacementAlpha.initial,
          final: replacementAlpha.final,
          state: replacementAlpha.state
        });
      if (!replacementConnection.ok || !replacementAlpha.workflowOk) {
        return;
      }
      activeCandidateIndex = replacementAlpha.offer.index + 1;
    } else {
      activeCandidateIndex = reset.offer.index + 1;
    }

    const secondary = {
      uuid: 'active-media-removal-viewer',
      session: 'active-media-removal-session',
      peerName: 'active-media-removal-peer'
    };
    const secondaryConnection = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      ...secondary
    });
    if (secondaryConnection.ok) {
      secondary.session = secondaryConnection.activeSession;
    }
    let secondaryAlpha = secondaryConnection.ok ? await enableAlphaAndVerifyMedia({
      config,
      report,
      signal,
      page,
      streamId,
      ...secondary,
      afterIndex: secondaryConnection.offer.index + 1,
      initialOffer: secondaryConnection.offer,
      allowVideoOnlyWorkflow: true,
      validateFullMedia: lifecycleRequiresAudio
    }) : {
      ok: false,
      workflowOk: false,
      reason: secondaryConnection.reason,
      state: secondaryConnection.state
    };
    addCheck(report, 'removal-target-has-active-audio-video-alpha-before-cleanup',
      secondaryConnection.ok && secondaryAlpha.ok, {
        connectionReason: secondaryConnection.reason,
        alphaReason: secondaryAlpha.reason,
        initial: secondaryAlpha.initial,
        final: secondaryAlpha.final,
        state: secondaryAlpha.state
      });
    if (!secondaryConnection.ok || !secondaryAlpha.workflowOk) {
      return;
    }

    const cleanupRetiredSession = secondary.session;
    const cleanupSetupBaseline = await waitForDiagnosticsPeerSnapshot(
      lifecycleDiagnosticsPath,
      secondary.uuid,
      (snapshot) => snapshot.peerCount === 1 &&
        snapshot.activeWireSession === cleanupRetiredSession,
      0,
      8000
    );
    requireHarnessFixture(
      report,
      'cleanup-retired-session-setup-baseline-is-current',
      !!cleanupSetupBaseline,
      {
        expectedActiveWireSession: cleanupRetiredSession,
        snapshot: cleanupSetupBaseline
      }
    );
    const cleanupSetupOutputOffset = publisher.output().length;
    signal.send({
      bye: true,
      UUID: secondary.uuid,
      session: cleanupRetiredSession,
      streamID: streamId
    });
    let cleanupSetupRemovalLogObserved = false;
    const cleanupSetupRemovalStarted = Date.now();
    while (Date.now() - cleanupSetupRemovalStarted < 8000) {
      const output = publisher.output().slice(cleanupSetupOutputOffset);
      if (new RegExp(`Removed peer session ${secondary.uuid}:`).test(output)) {
        cleanupSetupRemovalLogObserved = true;
        break;
      }
      await wait(50);
    }
    const cleanupSetupRemovedSnapshot = await waitForDiagnosticsPeerSnapshot(
      lifecycleDiagnosticsPath,
      secondary.uuid,
      (snapshot) => snapshot.peerCount === 0,
      cleanupSetupBaseline.generatedSteadyMs,
      8000
    );
    const cleanupSetupRemoved = cleanupSetupRemovalLogObserved &&
      !!cleanupSetupRemovedSnapshot && cleanupSetupRemovedSnapshot.peerCount === 0;
    addCheck(report, 'cleanup-setup-removes-original-active-session', cleanupSetupRemoved, {
      retiredSession: cleanupRetiredSession,
      removalLogObserved: cleanupSetupRemovalLogObserved,
      snapshot: cleanupSetupRemovedSnapshot,
      outputTail: publisher.output().slice(cleanupSetupOutputOffset).slice(-4000)
    });
    if (!cleanupSetupRemoved) {
      return;
    }

    const cleanupReplacementRequestHint = `${cleanupRetiredSession}-replacement-request`;
    const cleanupActiveConnection = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      uuid: secondary.uuid,
      session: cleanupReplacementRequestHint,
      peerName: secondary.peerName,
      rtcConfig: DIRECT_BROWSER_RTC_CONFIG
    });
    if (cleanupActiveConnection.activeSession) {
      secondary.session = cleanupActiveConnection.activeSession;
    }
    addCheck(report, 'cleanup-target-remove-readd-creates-known-retired-session',
      cleanupActiveConnection.ok && cleanupActiveConnection.sessionContractOk &&
        cleanupRetiredSession !== cleanupActiveConnection.activeSession,
      {
        retiredSession: cleanupRetiredSession,
        replacementRequestHint: cleanupReplacementRequestHint,
        activeSession: cleanupActiveConnection.activeSession,
        sessionContractOk: cleanupActiveConnection.sessionContractOk,
        reason: cleanupActiveConnection.reason,
        state: cleanupActiveConnection.state
      });
    if (!cleanupActiveConnection.ok) {
      return;
    }
    secondaryAlpha = await enableAlphaAndVerifyMedia({
      config,
      report,
      signal,
      page,
      streamId,
      ...secondary,
      afterIndex: cleanupActiveConnection.offer.index + 1,
      initialOffer: cleanupActiveConnection.offer,
      allowVideoOnlyWorkflow: true,
      validateFullMedia: lifecycleRequiresAudio
    });
    addCheck(report, 'cleanup-target-retains-all-media-after-remove-readd',
      secondaryAlpha.ok,
      {
        reason: secondaryAlpha.reason,
        retiredSession: cleanupRetiredSession,
        activeSession: secondary.session,
        state: secondaryAlpha.state
      });
    if (!secondaryAlpha.workflowOk) {
      return;
    }

    const cleanupHintBrowserState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name),
      secondary.peerName
    );
    requireHarnessFixture(
      report,
      'cleanup-retired-session-hint-is-distinct-from-live-browser-session',
      cleanupRetiredSession !== secondary.session &&
        !!cleanupHintBrowserState &&
        cleanupHintBrowserState.wireSession === secondary.session,
      {
        retiredSession: cleanupRetiredSession,
        activeSession: secondary.session,
        browserWireSession: cleanupHintBrowserState
          ? cleanupHintBrowserState.wireSession
          : ''
      }
    );

    const beforeRemovalState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name), activePrimary.peerName
    );
    const beforeRemoval = requiredMediaCounters(beforeRemovalState);
    const removalOutputOffset = publisher.output().length;
    const removedActiveSession = secondary.session;
    const removedPeerInstanceId = cleanupActiveConnection.answer.peerInstanceId;
    const preCleanupSnapshot = await waitForDiagnosticsPeerSnapshot(
      lifecycleDiagnosticsPath,
      secondary.uuid,
      (snapshot) => snapshot.peerCount === 1 &&
        snapshot.activeWireSession === removedActiveSession,
      0,
      8000
    );
    requireHarnessFixture(report, 'cleanup-target-diagnostics-baseline-is-current',
      !!preCleanupSnapshot,
      {
        expectedActiveWireSession: removedActiveSession,
        snapshot: preCleanupSnapshot
      });
    signal.send({
      bye: true,
      UUID: secondary.uuid,
      session: cleanupRetiredSession,
      streamID: streamId
    });
    let removed = false;
    const removalStarted = Date.now();
    while (Date.now() - removalStarted < 8000) {
      const output = publisher.output().slice(removalOutputOffset);
      if (new RegExp(`Removed peer session ${secondary.uuid}:`).test(output)) {
        removed = true;
        break;
      }
      await wait(50);
    }
    const uuidScopedCleanupRemoved = removed &&
      cleanupRetiredSession !== removedActiveSession;
    addCheck(report, 'wss-cleanup-is-uuid-scoped', uuidScopedCleanupRemoved, {
      uuid: secondary.uuid,
      activeSession: removedActiveSession,
      retiredRequestHint: cleanupRetiredSession,
      outputTail: publisher.output().slice(removalOutputOffset).slice(-4000)
    });
    let cleanupFixtureRecoveryUsed = false;
    if (!removed) {
      // Keep the UUID-scoped cleanup verdict RED, then retire the peer using
      // the legacy package's active-session lookup so re-add remains measured.
      cleanupFixtureRecoveryUsed = true;
      signal.send({
        bye: true,
        UUID: secondary.uuid,
        session: removedActiveSession,
        streamID: streamId
      });
      const recoveryRemovalStarted = Date.now();
      while (Date.now() - recoveryRemovalStarted < 8000) {
        const output = publisher.output().slice(removalOutputOffset);
        if (new RegExp(`Removed peer session ${secondary.uuid}:`).test(output)) {
          removed = true;
          break;
        }
        await wait(50);
      }
    }
    const postCleanupSnapshot = await waitForDiagnosticsPeerSnapshot(
      lifecycleDiagnosticsPath,
      secondary.uuid,
      (snapshot) => snapshot.peerCount === 0 &&
        snapshot.fileMtimeMs >= removalStarted,
      preCleanupSnapshot.generatedSteadyMs,
      8000
    );
    addCheck(report, 'cleanup-removes-all-native-owners-for-logical-uuid',
      !!postCleanupSnapshot && postCleanupSnapshot.peerCount === 0,
      {
        removedLogObserved: removed,
        snapshot: postCleanupSnapshot,
        diagnosticsPath: lifecycleDiagnosticsPath
      });
    const afterRemoval = await waitForLifecycleMediaAdvance(
      signal,
      page,
      activePrimary.uuid,
      activePrimary.peerName,
      12000,
      activeCandidateIndex,
      beforeRemoval
    );
    addCheck(report, 'removing-active-audio-video-alpha-peer-keeps-other-peer-advancing',
      lifecycleRequiresAudio && removed && afterRemoval.ok &&
        publisher.child.exitCode === null, {
        removed,
        uuidScopedCleanupRemoved,
        cleanupFixtureRecoveryUsed,
        publisherExitCode: publisher.child.exitCode,
        before: beforeRemoval,
        after: afterRemoval.final,
        state: afterRemoval.state,
        outputTail: publisher.output().slice(removalOutputOffset).slice(-5000)
      });
    if (!removed || !afterRemoval.ok || publisher.child.exitCode !== null) {
      return;
    }

    const beforeReaddState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name), activePrimary.peerName
    );
    const beforeReaddPrimary = requiredMediaCounters(beforeReaddState);
    const readdRequestSession = `${removedActiveSession}-readd-request`;
    const readdedConnection = await connectNewPeer({
      config,
      signal,
      page,
      streamId,
      ...secondary,
      session: readdRequestSession
    });
    if (readdedConnection.ok) {
      secondary.session = readdedConnection.activeSession;
    }
    const readdedAlpha = readdedConnection.ok ? await enableAlphaAndVerifyMedia({
      config,
      report,
      signal,
      page,
      streamId,
      ...secondary,
      afterIndex: readdedConnection.offer.index + 1,
      initialOffer: readdedConnection.offer,
      allowVideoOnlyWorkflow: true,
      validateFullMedia: lifecycleRequiresAudio
    }) : {
      ok: false,
      workflowOk: false,
      reason: readdedConnection.reason,
      state: readdedConnection.state
    };
    const postReaddSnapshot = readdedConnection.offer
      ? await waitForDiagnosticsPeerSnapshot(
        lifecycleDiagnosticsPath,
        secondary.uuid,
        (snapshot) => snapshot.peerCount > 0 &&
          snapshot.fileMtimeMs >= readdedConnection.offer.at,
        postCleanupSnapshot
          ? postCleanupSnapshot.generatedSteadyMs
          : preCleanupSnapshot.generatedSteadyMs,
        8000
      )
      : null;
    const postReaddSingleOwner = !!postReaddSnapshot &&
      postReaddSnapshot.peerCount === 1 &&
      postReaddSnapshot.ambiguous === false &&
      postReaddSnapshot.activeWireSession === readdedConnection.activeSession;
    addCheck(report, 'readd-creates-one-native-owner-for-new-active-wire-session',
      postReaddSingleOwner,
      {
        expectedActiveWireSession: readdedConnection.activeSession,
        snapshot: postReaddSnapshot,
        diagnosticsPath: lifecycleDiagnosticsPath
      });
    const primaryDuringReadd = await waitForLifecycleMediaAdvance(
      signal,
      page,
      activePrimary.uuid,
      activePrimary.peerName,
      12000,
      activeCandidateIndex,
      beforeReaddPrimary
    );
    addCheck(report, 'removed-logical-peer-readds-with-all-media-and-primary-stays-healthy',
      readdedConnection.ok && readdedConnection.sessionContractOk &&
        readdedConnection.activeSession !== removedActiveSession &&
        readdedConnection.answer.peerInstanceId !== removedPeerInstanceId &&
        postReaddSingleOwner &&
        readdedAlpha.ok && primaryDuringReadd.ok, {
        sameUuid: secondary.uuid,
        retiredSession: removedActiveSession,
        readdRequestSession,
        readdedSession: secondary.session,
        removedPeerInstanceId,
        readdedPeerInstanceId: readdedConnection.answer
          ? readdedConnection.answer.peerInstanceId
          : null,
        sessionContractReason: readdedConnection.sessionContractReason,
        reconnectReason: readdedConnection.reason,
        alphaReason: readdedAlpha.reason,
        readdedInitial: readdedAlpha.initial,
        readdedFinal: readdedAlpha.final,
        primaryBefore: beforeReaddPrimary,
        primaryAfter: primaryDuringReadd.final,
        readdedState: readdedAlpha.state,
        primaryState: primaryDuringReadd.state
      });
    if (!readdedConnection.ok || !readdedAlpha.workflowOk || !primaryDuringReadd.ok) {
      return;
    }

    const beforeShutdownState = await page.evaluate(
      (name) => window.__gameCapturePeerState(name), activePrimary.peerName
    );
    const beforeShutdown = requiredMediaCounters(beforeShutdownState);
    const beforeShutdownAdvance = await waitForLifecycleMediaAdvance(
      signal,
      page,
      activePrimary.uuid,
      activePrimary.peerName,
      12000,
      activeCandidateIndex,
      beforeShutdown
    );
    addCheck(report, 'all-media-remains-active-immediately-before-graceful-shutdown',
      lifecycleRequiresAudio && beforeShutdownAdvance.ok, {
        before: beforeShutdown,
        after: beforeShutdownAdvance.final,
        state: beforeShutdownAdvance.state
      });

    const remainingUntilTimeout = Math.max(
      1000,
      publisherDurationMs - (Date.now() - publisherStartedAt) + 15000
    );
    const naturalExit = await waitForChildExit(publisher.child, remainingUntilTimeout);
    const shutdownOutput = publisher.output();
    const cleanShutdownLogs = /\[Headless\] Timeout, exiting/i.test(shutdownOutput) &&
      /\[EncodeThread\] Stopped/i.test(shutdownOutput) &&
      /\[AlphaEncodeThread\] Stopped/i.test(shutdownOutput) &&
      !/(?:access violation|stack overflow|terminate called|unhandled exception)/i.test(shutdownOutput);
    addCheck(report, 'natural-timeout-cleanly-shuts-down-with-active-audio-video-alpha',
      lifecycleRequiresAudio && beforeShutdownAdvance.ok &&
        naturalExit.exited && naturalExit.exitCode === 0 &&
        cleanShutdownLogs, {
        naturalExit,
        cleanShutdownLogs,
        activeCountersBeforeShutdown: beforeShutdownAdvance.final,
        elapsedMs: Date.now() - publisherStartedAt,
        outputTail: shutdownOutput.split(/\r?\n/).slice(-180)
      });
  } finally {
    if (publisher) {
      report.activeMediaLifecyclePublisherOutputTail = publisher.output().split(/\r?\n/).slice(-220);
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (publisher) {
      await publisher.stop();
    }
    report.lifecycleDiagnosticsArtifact = fs.existsSync(lifecycleDiagnosticsPath) ? {
      path: lifecycleDiagnosticsPath,
      sha256: sha256File(lifecycleDiagnosticsPath),
      size: fs.statSync(lifecycleDiagnosticsPath).size
    } : {
      path: lifecycleDiagnosticsPath,
      missing: true
    };
    if (signal) {
      await signal.close();
    }
    const fixtureTermination = await fixtures.stop();
    addEvidence(report, 'lifecycle-fixtures-stopped', {
      elapsedMs: Date.now() - fixtureStartedAt,
      spoutTermination: fixtureTermination.spoutTermination,
      toneTermination: fixtureTermination.toneTermination
    });
  }
}

async function ensureTurnFixture(config, browser, report, turnFixture) {
  const fetchedEndpoints = turnFixture.fetchedEndpoints;
  const fetchedEndpointIdentities = turnFixture.fetchedEndpointIdentities;
  config.relayRtcConfig = turnFixture.rtcConfig;
  const probe = await createBrowserPeerPage(browser);
  const endpointProbes = [];
  const endpointSets = [{ name: 'live-registry', endpoints: fetchedEndpoints }];
  try {
    for (const endpointSet of endpointSets) {
      for (const endpoint of endpointSet.endpoints) {
        endpointProbes.push({
          fixtureSet: endpointSet.name,
          ...await probeSelectedTurnEndpoint(probe.page, endpoint)
        });
      }
    }

    const everyOriginalHostnameAttemptAllocated = endpointProbes.length > 0 &&
      endpointProbes.every((endpoint) =>
        endpoint.hostnameAttempts.length === TURN_ENDPOINT_PROBE_ATTEMPTS &&
        endpoint.hostnameAttempts.every((attempt) => attempt.ok)
      );
    const everyResolvedAddressPassed = endpointProbes.length > 0 &&
      endpointProbes.every((endpoint) =>
        endpoint.nonUdpAddressCoverageUnambiguous &&
        endpoint.addresses.length > 0 &&
        endpoint.addressAttempts.length ===
          endpoint.addresses.length * TURN_ENDPOINT_PROBE_ATTEMPTS &&
        endpoint.addressAttempts.every((attempt) => attempt.ok)
      );
    const rtcConfiguredEndpointUrls = [];
    for (const server of config.relayRtcConfig.iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) {
        rtcConfiguredEndpointUrls.push(url);
      }
    }
    const rtcConfigRetainsOriginalHostnames =
      endpointProbes.length === fetchedEndpoints.length &&
      rtcConfiguredEndpointUrls.length === fetchedEndpoints.length &&
      rtcConfiguredEndpointUrls.every((url, index) =>
        url === fetchedEndpoints[index].urls
      );
    const resolvedEndpointIdentities = fetchedEndpoints.map(
      (endpoint) => endpoint.registryEndpointIdentity
    );
    const probedEndpointIdentities = endpointProbes.map(
      (endpoint) => endpoint.registryEndpointIdentity
    );
    const endpointIdentityChainExact =
      Array.isArray(fetchedEndpointIdentities) &&
      fetchedEndpointIdentities.length === fetchedEndpoints.length &&
      resolvedEndpointIdentities.length === fetchedEndpointIdentities.length &&
      probedEndpointIdentities.length === fetchedEndpointIdentities.length &&
      fetchedEndpointIdentities.every((identity, index) =>
        /^[0-9a-f]{64}$/.test(identity) &&
        identity === resolvedEndpointIdentities[index] &&
        identity === probedEndpointIdentities[index]
      ) &&
      new Set(fetchedEndpointIdentities).size === fetchedEndpointIdentities.length;

    const turnRegistryResponse = turnFixture.turnRegistryResponse || {};

    requireHarnessFixture(
      report,
      'every-live-registry-turn-endpoint-is-probed',
      everyOriginalHostnameAttemptAllocated &&
        everyResolvedAddressPassed &&
        rtcConfigRetainsOriginalHostnames &&
        endpointIdentityChainExact,
      {
        source: 'live-registry',
        sourceUrl: turnRegistryResponse.sourceUrl || '',
        responseSha256: turnRegistryResponse.responseSha256 || '',
        configSha256: turnRegistryResponse.configSha256 || '',
        expectedEndpointCount: fetchedEndpoints.length,
        observedEndpointCount: endpointProbes.length,
        probeAttemptsPerTarget: TURN_ENDPOINT_PROBE_ATTEMPTS,
        everyOriginalHostnameAttemptAllocated,
        everyResolvedAddressPassed,
        nonUdpMultiAddressPolicy: 'fail-closed',
        rtcConfigRetainsOriginalHostnames,
        endpointIdentityChainExact,
        fetchedEndpointIdentities,
        resolvedEndpointIdentities,
        probedEndpointIdentities,
        endpointProbes
      }
    );

    if (report.configuration) {
      report.configuration.browserTurnSource = 'live-registry';
      report.configuration.browserTurnSourceUrl = turnRegistryResponse.sourceUrl || '';
      report.configuration.browserTurnResponseSha256 = turnRegistryResponse.responseSha256 || '';
      report.configuration.browserTurnConfigSha256 = turnRegistryResponse.configSha256 || '';
      report.configuration.selectedBrowserTurnUrls = fetchedEndpoints.map(
        (server) => server.urls
      );
      report.configuration.selectedBrowserTurnEndpointIdentities =
        [...fetchedEndpointIdentities];
    }
  } finally {
    await probe.context.close().catch(() => {});
  }
}
async function runRecoveryScenario(
  config, executable, browser, report, mediaFixture, spoutSenderArtifact
) {
  if (['recovery', 'all', 'auto', 'relay'].includes(config.scenario)) {
    addEvidence(report, 'packaged-turn-live-registry-workflow-entered', {
      scenario: config.scenario
    });
    await runRelayIceScenario(config, executable, browser, report, mediaFixture);
  }
  if (config.scenario === 'recovery' || config.scenario === 'all' || config.scenario === 'direct') {
    await runDirectStunScenario(config, executable, browser, report, mediaFixture);
  }
  if (config.scenario === 'recovery' || config.scenario === 'all' || config.scenario === 'auto') {
    await runAutoIceScenario(config, executable, browser, report, mediaFixture);
  }
  if (config.scenario === 'recovery' || config.scenario === 'all' || config.scenario === 'lifecycle') {
    await runActiveMediaLifecycleScenario(
      config,
      executable,
      browser,
      report,
      spoutSenderArtifact
    );
  }
}

async function run() {
  const config = parseArgs(process.argv);
  const packagedArtifact = validatePackagedPublisherArtifact(config);
  const spoutSenderArtifact = validateSpoutSenderArtifact(config);
  const { executable, manifestPath, manifestSha256, manifest } = packagedArtifact;
  const report = {
    startedAt: new Date().toISOString(),
    packagedPublisher: executable,
    packagedPublisherSha256: manifest.artifact.sha256,
    packagedPublisherSize: manifest.artifact.size,
    spoutSenderArtifact: {
      path: spoutSenderArtifact.executable,
      sha256: spoutSenderArtifact.sha256
    },
    packagedArtifactManifest: {
      path: manifestPath,
      sha256: manifestSha256,
      schema: manifest.schema,
      version: manifest.version,
      packagedAtUtc: manifest.packagedAtUtc,
      buildConfiguration: manifest.build.configuration,
      source: manifest.source
    },
    browser: config.browser,
    scenario: config.scenario,
    configuration: {
      offerTimeoutMs: config.offerTimeoutMs,
      failureTimeoutMs: config.failureTimeoutMs,
      delayedRestartMs: config.delayedRestartMs,
      stressRestarts: config.stressRestarts
    },
    checks: [],
    evidence: [],
    harnessRequirements: [],
    harnessErrors: []
  };
  addCheck(
    report,
    'packaged-artifact-manifest-binds-executable',
    true,
    {
      executable,
      manifestPath,
      manifestSha256,
      manifestArtifactRelativePath: manifest.artifact.relativePath,
      manifestArtifactSize: manifest.artifact.size,
      manifestArtifactSha256: manifest.artifact.sha256
    }
  );
  let browser = null;
  let signalingMediaFixture = null;
  try {
    signalingMediaFixture = startSignalingMediaFixture(
      15 * 60 * 1000,
      spoutSenderArtifact
    );
    requireHarnessFixture(
      report,
      'signaling-media-fixture-file-exists',
      signalingMediaFixture.ok,
      { missing: signalingMediaFixture.missing || [] }
    );
    const signalingMediaReady = await signalingMediaFixture.spout.waitForText(
      /SPOUT_TEST_SENDER_READY/i,
      10000
    );
    requireHarnessFixture(
      report,
      'signaling-media-fixture-is-ready',
      signalingMediaReady,
      {
        senderName: signalingMediaFixture.senderName,
        command: signalingMediaFixture.spout.command,
        args: signalingMediaFixture.spout.args,
        output: signalingMediaFixture.spout.output().slice(-3000),
        ...signalingMediaFixture.hashes
      }
    );
    assertSpoutSenderArtifactUnchanged(spoutSenderArtifact);
    addEvidence(report, 'signaling-media-fixture-started', {
      senderName: signalingMediaFixture.senderName,
      command: signalingMediaFixture.spout.command,
      args: signalingMediaFixture.spout.args,
      ...signalingMediaFixture.hashes
    });
    browser = await launchBrowser(config);
    report.browserVersion = browser.version();
    if (config.browser === 'firefox-installed') {
      report.browserArtifact = {
        path: browser.executablePath,
        sha256: browser.executableSha256,
        automation: browser.automation,
        version: browser.version()
      };
    }
    const metadataContext = await browser.newContext();
    try {
      const metadataPage = await metadataContext.newPage();
      await metadataPage.goto('about:blank');
      report.browserUserAgent = await metadataPage.evaluate(() => navigator.userAgent);
    } finally {
      await metadataContext.close().catch(() => {});
    }
    if (config.scenario === 'all' || config.scenario === 'negotiation') {
      await runNegotiationScenario(
        config, executable, browser, report, signalingMediaFixture
      );
    }
    if ([
      'all', 'recovery', 'direct', 'auto', 'relay', 'lifecycle'
    ].includes(config.scenario)) {
      await runRecoveryScenario(
        config,
        executable,
        browser,
        report,
        signalingMediaFixture,
        spoutSenderArtifact
      );
    }
    if (config.scenario === 'relay') {
      requireHarnessFixture(
        report,
        'relay-scenario-executed-live-registry-chain',
        report.evidence.some((entry) =>
          entry.name === 'packaged-turn-live-registry-workflow-entered'
        ) && report.evidence.some((entry) =>
          entry.name === 'packaged-turn-live-registry-response-accepted'
        ) && report.checks.some((check) =>
          check.name === 'packaged-turn-registry-fetch-is-unique'
        ) && report.checks.some((check) =>
          check.name === 'packaged-turn-consumed-config-matches-fetched-response'
        ) && report.checks.some((check) =>
          check.name === 'relay-only-selects-relay-pair-and-delivers-data-media'
        ),
        {
          evidenceNames: report.evidence.map((entry) => entry.name),
          checkNames: report.checks.map((check) => check.name)
        }
      );
    }
  } catch (error) {
    report.harnessErrors.push({
      message: String(error && error.message ? error.message : error),
      stack: error && error.stack ? error.stack : '',
      harnessRequirement: error && error.harnessRequirement
        ? error.harnessRequirement
        : null
    });
    console.error(`[SIGNAL-E2E] HARNESS ERROR: ${error && error.stack ? error.stack : error}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (signalingMediaFixture && signalingMediaFixture.ok) {
      const fixtureTermination = await signalingMediaFixture.stop();
      addEvidence(report, 'signaling-media-fixture-stopped', {
        senderName: signalingMediaFixture.senderName,
        fixtureTermination,
        outputTail: signalingMediaFixture.spout.output().slice(-3000)
      });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.harnessErrors.length === 0 &&
    report.checks.length > 0 &&
    report.checks.every((check) => check.ok);
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(
    config.reportDir,
    `signaling-regressions-${config.browser}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[SIGNAL-E2E] Report: ${reportPath}`);
  console.log(`[SIGNAL-E2E] ${report.ok ? 'PASS' : 'FAIL'}`);
  if (report.harnessErrors.length > 0) {
    process.exitCode = 2;
  } else if (!report.ok) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`[SIGNAL-E2E] HARNESS ERROR: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 2;
});
