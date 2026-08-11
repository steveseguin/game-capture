'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE_TERMINAL_PREFIX = 'NATIVE_TURN_FALLBACK_INSTRUMENT_RESULT ';
const PHASE_TERMINAL_PREFIX = 'NATIVE_TURN_FALLBACK_PHASE1_RESULT ';
const TURN_EPOCH_OFFSET_MS = 1653305816700;
const LIVE_TIMEOUT_MS = 10000;
const CMAKE_PROBE_TIMEOUT_MS = 5000;
const CMAKE_PROBE_MAX_BYTES = 64 * 1024;
const SOURCE_URL = 'https://turnservers.vdo.ninja/';
const gateScript = path.resolve(__dirname, 'native-turn-fallback-instrument-regression.js');
const nativeRoot = path.resolve(__dirname, '..');
const defaultBuildDir = path.resolve(
  __dirname,
  '..',
  `build-phase1-fresh-${process.pid}-${Date.now()}`,
);

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileIdentity(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    return { path: absolute, exists: false, size: 0, mtimeMs: 0, sha256: null };
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    return { path: absolute, exists: false, size: 0, mtimeMs: 0, sha256: null };
  }
  return {
    path: absolute,
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(fs.readFileSync(absolute)),
  };
}

function identityShapeValid(identity) {
  return Boolean(
    identity &&
      typeof identity.path === 'string' &&
      identity.exists === true &&
      Number.isFinite(identity.size) &&
      identity.size > 0 &&
      Number.isFinite(identity.mtimeMs) &&
      identity.mtimeMs > 0 &&
      /^[0-9a-f]{64}$/.test(identity.sha256 || ''),
  );
}

function identityEqual(left, right) {
  return (
    identityShapeValid(left) &&
    identityShapeValid(right) &&
    pathKey(left.path) === pathKey(right.path) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function canonicalFileIdentity(filePath) {
  const canonical = fs.realpathSync.native(path.resolve(filePath));
  const identity = fileIdentity(canonical);
  if (!identity.exists) throw new Error(`executable identity is unavailable: ${canonical}`);
  return identity;
}

function parseCmakeVersion(stdout) {
  if (Buffer.byteLength(String(stdout || ''), 'utf8') > CMAKE_PROBE_MAX_BYTES) return null;
  const match = String(stdout || '').match(/^cmake version ([0-9]+(?:\.[0-9]+)+)\r?(?:\n|$)/);
  return match ? match[1] : null;
}

function discoverTrustedCmake() {
  const executableName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
  const pathKeyName = Object.keys(process.env).find(
    (name) => name.toUpperCase() === 'PATH',
  );
  const pathValue = pathKeyName ? process.env[pathKeyName] : '';
  const seen = new Set();
  for (const entry of String(pathValue).split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const canonical = fs.realpathSync.native(path.resolve(candidate));
      if (path.basename(canonical).toLowerCase() !== executableName) continue;
      const canonicalKey = pathKey(canonical);
      if (seen.has(canonicalKey)) continue;
      seen.add(canonicalKey);
      const beforeProbe = canonicalFileIdentity(canonical);
      const probe = spawnSync(canonical, ['--version'], {
        encoding: 'utf8',
        timeout: CMAKE_PROBE_TIMEOUT_MS,
        maxBuffer: CMAKE_PROBE_MAX_BYTES,
        windowsHide: true,
        shell: false,
      });
      const afterProbe = canonicalFileIdentity(canonical);
      const version =
        !probe.error && probe.status === 0 && identityEqual(beforeProbe, afterProbe)
          ? parseCmakeVersion(probe.stdout)
          : null;
      if (version) return { path: canonical, version, identity: afterProbe };
    } catch {
      // Continue to the next canonical PATH candidate when probing or identity capture fails.
    }
  }
  throw new Error('a trusted CMake executable was not found on PATH');
}

function discoverCmakeExecutable() {
  return discoverTrustedCmake().path;
}

function cmakeExecutableEvidence(discovery) {
  return {
    path: discovery.path,
    version: discovery.version,
    probeTimeoutMs: CMAKE_PROBE_TIMEOUT_MS,
    probeMaxBytes: CMAKE_PROBE_MAX_BYTES,
    discovered: { ...discovery.identity },
    beforeConfigure: { ...discovery.identity },
    afterConfigure: { ...discovery.identity },
    beforeBuild: { ...discovery.identity },
    afterBuild: { ...discovery.identity },
  };
}

function cmakeExecutableEvidenceValid(evidence, trusted) {
  if (
    !evidence ||
    typeof evidence.path !== 'string' ||
    pathKey(evidence.path) !== pathKey(trusted.path) ||
    evidence.version !== trusted.version ||
    evidence.probeTimeoutMs !== CMAKE_PROBE_TIMEOUT_MS ||
    evidence.probeMaxBytes !== CMAKE_PROBE_MAX_BYTES
  ) {
    return false;
  }
  return [
    'discovered',
    'beforeConfigure',
    'afterConfigure',
    'beforeBuild',
    'afterBuild',
  ].every((name) => identityEqual(evidence[name], trusted.identity));
}

function windowsShortPath(value) {
  if (process.platform !== 'win32') return value;
  const command = `for %I in ("${value.replaceAll('"', '""')}") do @echo %~sI`;
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const shortPath = String(result.stdout || '').trim();
  if (result.status !== 0 || !shortPath || !fs.existsSync(shortPath)) {
    throw new Error('CMake 8.3 path alias could not be resolved');
  }
  return shortPath;
}

function plausibleArtifactCandidates(buildDir) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const configurations = ['Release', 'Debug', 'RelWithDebInfo', 'MinSizeRel'];
  return [
    path.join(buildDir, `test_ice_config${suffix}`),
    ...configurations.map((configuration) =>
      path.join(buildDir, configuration, `test_ice_config${suffix}`),
    ),
    path.join(buildDir, 'bin', `test_ice_config${suffix}`),
    ...configurations.map((configuration) =>
      path.join(buildDir, 'bin', configuration, `test_ice_config${suffix}`),
    ),
  ];
}

function absentIdentity(pathValue) {
  return { path: pathValue, exists: false, size: 0, mtimeMs: 0, sha256: null };
}

function absentIdentityValid(identity, expectedPath) {
  return (
    identity &&
    pathKey(identity.path || '') === pathKey(expectedPath) &&
    identity.exists === false &&
    identity.size === 0 &&
    identity.mtimeMs === 0 &&
    identity.sha256 === null
  );
}

function validateFailedBuildArtifactEvidence(result, buildDir) {
  const expected = plausibleArtifactCandidates(buildDir);
  if (
    !Array.isArray(result.artifact?.candidates) ||
    result.artifact.candidates.length !== expected.length ||
    !result.artifact.candidates.every(
      (candidate, index) => pathKey(candidate) === pathKey(expected[index]),
    )
  ) {
    return 'candidate-list';
  }
  if (
    !Array.isArray(result.artifact.pre) ||
    result.artifact.pre.length !== expected.length ||
    !result.artifact.pre.every((identity, index) => absentIdentityValid(identity, expected[index]))
  ) {
    return 'pre-identities';
  }
  if (
    !Array.isArray(result.artifact.post) ||
    result.artifact.post.length !== expected.length ||
    !result.artifact.post.every((identity, index) => absentIdentityValid(identity, expected[index]))
  ) {
    return 'post-identities';
  }
  if (result.artifact.selected !== null || result.artifact.executed !== false) {
    return 'selection-execution';
  }
  if (
    result.freshConfigure?.required !== true ||
    result.freshConfigure.buildDirExistedBefore !== false ||
    result.freshConfigure.cacheExistedBefore !== false ||
    result.freshConfigure.configureInvocationCount !== 1 ||
    result.freshConfigure.configuredFromScratch !== true ||
    result.configure?.invocationCount !== 1 ||
    !(result.configure.timeoutMs > 120000 && result.configure.timeoutMs <= 300000) ||
    result.build?.invocationCount !== 1 ||
    !(result.build.timeoutMs > 0 && result.build.timeoutMs <= 300000) ||
    result.cmakeGenerator?.generator !== 'Ninja' ||
    result.cmakeGenerator.buildType !== 'Release' ||
    !/^[0-9a-f]{64}$/.test(result.cmakeGenerator.makeProgramSha256 || '')
  ) {
    return 'fresh-configure';
  }
  return null;
}

function validateBuildCommandEvidence(result, buildDir) {
  const command = result.build?.command;
  const configureCommand = result.configure?.command;
  if (
    !Array.isArray(command) ||
    command.length !== 5 ||
    typeof command[0] !== 'string' ||
    !path.isAbsolute(command[0]) ||
    command[1] !== '--build' ||
    typeof command[2] !== 'string' ||
    !path.isAbsolute(command[2]) ||
    command[3] !== '--target' ||
    command[4] !== 'test_ice_config'
  ) {
    return 'build-command';
  }
  if (
    !Array.isArray(configureCommand) ||
    typeof configureCommand[0] !== 'string' ||
    !path.isAbsolute(configureCommand[0])
  ) {
    return 'build-command';
  }
  let canonicalBuildDir;
  let canonicalCommandBuildDir;
  let canonicalBuildExecutable;
  let canonicalConfigureExecutable;
  try {
    canonicalBuildDir = fs.realpathSync.native(path.resolve(buildDir));
    canonicalCommandBuildDir = fs.realpathSync.native(path.resolve(command[2]));
    canonicalBuildExecutable = fs.realpathSync.native(path.resolve(command[0]));
    canonicalConfigureExecutable = fs.realpathSync.native(path.resolve(configureCommand[0]));
  } catch {
    return 'build-command';
  }
  if (pathKey(canonicalBuildDir) !== pathKey(canonicalCommandBuildDir)) {
    return 'build-command';
  }
  const cmakeNames = new Set(['cmake', 'cmake.exe']);
  if (
    !cmakeNames.has(path.basename(canonicalBuildExecutable).toLowerCase()) ||
    !cmakeNames.has(path.basename(canonicalConfigureExecutable).toLowerCase()) ||
    pathKey(canonicalBuildExecutable) !== pathKey(canonicalConfigureExecutable)
  ) {
    return 'build-command';
  }
  let trustedCmake;
  let currentBuildExecutable;
  let currentConfigureExecutable;
  try {
    trustedCmake = discoverTrustedCmake();
    currentBuildExecutable = canonicalFileIdentity(canonicalBuildExecutable);
    currentConfigureExecutable = canonicalFileIdentity(canonicalConfigureExecutable);
  } catch {
    return 'build-command';
  }
  if (
    pathKey(canonicalBuildExecutable) !== pathKey(trustedCmake.path) ||
    !identityEqual(currentBuildExecutable, trustedCmake.identity) ||
    !identityEqual(currentConfigureExecutable, trustedCmake.identity) ||
    !cmakeExecutableEvidenceValid(result.cmakeExecutable, trustedCmake)
  ) {
    return 'build-command';
  }
  const configurePathValid = (flag, expectedDirectory) => {
    const exactIndices = [];
    let attachedCount = 0;
    for (let index = 1; index < configureCommand.length; index += 1) {
      const part = configureCommand[index];
      if (part === flag) exactIndices.push(index);
      else if (typeof part === 'string' && part.startsWith(flag) && part.length > flag.length) {
        attachedCount += 1;
      }
    }
    if (exactIndices.length !== 1 || attachedCount !== 0) return false;
    const value = configureCommand[exactIndices[0] + 1];
    if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
    try {
      return (
        pathKey(fs.realpathSync.native(path.resolve(value))) ===
        pathKey(fs.realpathSync.native(path.resolve(expectedDirectory)))
      );
    } catch {
      return false;
    }
  };
  if (
    !configurePathValid('-B', buildDir) ||
    !configurePathValid('-S', nativeRoot)
  ) {
    return 'build-command';
  }
  return null;
}

function validateLiveSchemaEvidence(result) {
  const live = result.liveRegistry;
  if (!live || live.passed !== true || live.endpointHealthProbed !== false) return 'live-schema';
  if (
    !Number.isSafeInteger(live.requestTimestampUnixMs) ||
    live.requestTimestampUnixMs <= TURN_EPOCH_OFFSET_MS ||
    live.sourceUrl !== `${SOURCE_URL}?ts=${live.requestTimestampUnixMs - TURN_EPOCH_OFFSET_MS}` ||
    typeof live.transactionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      live.transactionId,
    ) ||
    live.timeoutMs !== LIVE_TIMEOUT_MS ||
    !Number.isFinite(live.durationMs) ||
    live.durationMs < 0 ||
    live.httpStatus !== 200 ||
    live.version !== 1 ||
    !Number.isSafeInteger(live.serverCount) ||
    live.serverCount <= 0 ||
    !Number.isSafeInteger(live.urlCount) ||
    live.urlCount < live.serverCount ||
    !/^[0-9a-f]{64}$/.test(live.rawResponseSha256 || '') ||
    !/^[0-9a-f]{64}$/.test(live.canonicalConfigSha256 || '') ||
    typeof live.endpointHealthLimitation !== 'string' ||
    !live.endpointHealthLimitation.includes('does not establish TURN endpoint health')
  ) {
    return 'live-schema';
  }
  return null;
}

function parseArgs(argv) {
  let buildDir = defaultBuildDir;
  let round2ControlsOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build-dir') {
      index += 1;
      if (index >= argv.length) throw new Error('--build-dir requires a value');
      buildDir = path.resolve(argv[index]);
    } else if (arg.startsWith('--build-dir=')) {
      buildDir = path.resolve(arg.slice('--build-dir='.length));
    } else if (arg === '--round2-controls-only') {
      round2ControlsOnly = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { buildDir, round2ControlsOnly };
}

function emit(status, detail, exitCode) {
  process.stdout.write(
    `${PHASE_TERMINAL_PREFIX}${JSON.stringify({
      version: 1,
      status,
      purpose: 'tests-first-current-red-verifier',
      ...detail,
    })}\n`,
  );
  process.exit(exitCode);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  emit('HARNESS_ERROR', { reason: 'arguments', error: error.message }, 2);
}

if (options.round2ControlsOnly) {
  const candidates = plausibleArtifactCandidates(options.buildDir);
  const requestTimestampUnixMs = TURN_EPOCH_OFFSET_MS + 123456789;
  const baseline = {
    artifact: {
      candidates: [...candidates],
      pre: candidates.map(absentIdentity),
      post: candidates.map(absentIdentity),
      selected: null,
      executed: false,
    },
    freshConfigure: {
      required: true,
      buildDirExistedBefore: false,
      cacheExistedBefore: false,
      configureInvocationCount: 1,
      configuredFromScratch: true,
    },
    configure: { invocationCount: 1, timeoutMs: 240000 },
    build: { invocationCount: 1, timeoutMs: 300000 },
    cmakeGenerator: {
      generator: 'Ninja',
      buildType: 'Release',
      makeProgramSha256: 'a'.repeat(64),
    },
    liveRegistry: {
      sourceUrl: `${SOURCE_URL}?ts=${requestTimestampUnixMs - TURN_EPOCH_OFFSET_MS}`,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      requestTimestampUnixMs,
      timeoutMs: LIVE_TIMEOUT_MS,
      durationMs: 1,
      passed: true,
      httpStatus: 200,
      version: 1,
      serverCount: 1,
      urlCount: 1,
      rawResponseSha256: 'b'.repeat(64),
      canonicalConfigSha256: 'c'.repeat(64),
      endpointHealthProbed: false,
      endpointHealthLimitation:
        'This schema/provenance fetch does not establish TURN endpoint health.',
    },
  };
  if (validateFailedBuildArtifactEvidence(baseline, options.buildDir) !== null) {
    emit('HARNESS_ERROR', { reason: 'valid-artifact-control-rejected' }, 2);
  }
  const controls = [
    {
      name: 'missing-bin-candidate',
      expected: 'candidate-list',
      mutate: (value) => value.artifact.candidates.splice(5, 1),
    },
    {
      name: 'unrelated-pre-identity',
      expected: 'pre-identities',
      mutate: (value) => {
        value.artifact.pre[0] = absentIdentity(
          path.resolve(options.buildDir, '..', 'unrelated', 'test_ice_config.exe'),
        );
      },
    },
    {
      name: 'claimed-post-artifact',
      expected: 'post-identities',
      mutate: (value) => {
        value.artifact.post[0] = {
          path: candidates[0],
          exists: true,
          size: 1,
          mtimeMs: 1,
          sha256: 'a'.repeat(64),
        };
      },
    },
    {
      name: 'selected-stale-artifact',
      expected: 'selection-execution',
      mutate: (value) => {
        value.artifact.selected = value.artifact.post[0];
      },
    },
    {
      name: 'resumed-configure',
      expected: 'fresh-configure',
      mutate: (value) => {
        value.freshConfigure.buildDirExistedBefore = true;
      },
    },
    {
      name: 'live-schema-failure',
      expected: 'live-schema',
      validator: (value) => validateLiveSchemaEvidence(value),
      mutate: (value) => {
        value.liveRegistry.passed = false;
      },
    },
    {
      name: 'live-source-provenance-failure',
      expected: 'live-schema',
      validator: (value) => validateLiveSchemaEvidence(value),
      mutate: (value) => {
        value.liveRegistry.sourceUrl = SOURCE_URL;
      },
    },
    {
      name: 'live-request-contract-failure',
      expected: 'live-schema',
      validator: (value) => validateLiveSchemaEvidence(value),
      mutate: (value) => {
        value.liveRegistry.transactionId = 'not-a-uuid';
      },
    },
    {
      name: 'live-count-coherence-failure',
      expected: 'live-schema',
      validator: (value) => validateLiveSchemaEvidence(value),
      mutate: (value) => {
        value.liveRegistry.urlCount = 0;
      },
    },
    {
      name: 'live-endpoint-scope-failure',
      expected: 'live-schema',
      validator: (value) => validateLiveSchemaEvidence(value),
      mutate: (value) => {
        delete value.liveRegistry.endpointHealthProbed;
      },
    },
  ];
  for (const control of controls) {
    const value = structuredClone(baseline);
    control.mutate(value);
    const observed = control.validator
      ? control.validator(value)
      : validateFailedBuildArtifactEvidence(value, options.buildDir);
    if (observed !== control.expected) {
      emit(
        'HARNESS_ERROR',
        { name: control.name, expected: control.expected, observed },
        2,
      );
    }
    process.stdout.write(`[ROUND2 CONTROL PASS] ${control.name}: ${observed}\n`);
  }
  const commandRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-phase-command-'));
  const pathEnvironmentName =
    Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = String(process.env[pathEnvironmentName] || '');
  let validCommandObserved;
  let staleCommandObserved;
  try {
    const selectedBuildDir = path.join(commandRoot, 'selected-build');
    const unrelatedBuildDir = path.join(commandRoot, 'unrelated-stale-build');
    const unrelatedSourceDir = path.join(commandRoot, 'unrelated-source');
    const aliasTools = path.join(commandRoot, 'alias-tools');
    const otherTools = path.join(commandRoot, 'other-tools');
    const cmakeName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
    fs.mkdirSync(selectedBuildDir, { recursive: true });
    fs.mkdirSync(unrelatedBuildDir, { recursive: true });
    fs.mkdirSync(unrelatedSourceDir, { recursive: true });
    fs.mkdirSync(otherTools, { recursive: true });
    const trustedCmake = discoverTrustedCmake();
    const realCmake = trustedCmake.path;
    const otherCmake = path.join(otherTools, cmakeName);
    const notCmake = path.join(
      otherTools,
      process.platform === 'win32' ? 'not-cmake.exe' : 'not-cmake',
    );
    fs.writeFileSync(otherCmake, 'phase-other-cmake');
    fs.writeFileSync(notCmake, 'phase-not-cmake');
    fs.symlinkSync(
      path.dirname(realCmake),
      aliasTools,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const commandResult = {
      cmakeExecutable: cmakeExecutableEvidence(trustedCmake),
      configure: {
        command: [
          path.join(aliasTools, cmakeName),
          '-S',
          nativeRoot,
          '-B',
          selectedBuildDir,
        ],
      },
      build: {
        command: [realCmake, '--build', selectedBuildDir, '--target', 'test_ice_config'],
      },
    };
    validCommandObserved = validateBuildCommandEvidence(commandResult, selectedBuildDir);
    commandResult.build.command[2] = unrelatedBuildDir;
    staleCommandObserved = validateBuildCommandEvidence(commandResult, selectedBuildDir);
    commandResult.build.command[2] = selectedBuildDir;
    commandResult.build.command[0] = 'definitely-not-cmake.exe';
    const bogusExecutableObserved = validateBuildCommandEvidence(commandResult, selectedBuildDir);
    if (bogusExecutableObserved !== 'build-command') {
      throw new Error(`phase bogus executable escaped: ${String(bogusExecutableObserved)}`);
    }
    commandResult.build.command[0] = otherCmake;
    const mismatchedExecutableObserved = validateBuildCommandEvidence(
      commandResult,
      selectedBuildDir,
    );
    if (mismatchedExecutableObserved !== 'build-command') {
      throw new Error(`phase mismatched executable escaped: ${String(mismatchedExecutableObserved)}`);
    }
    commandResult.configure.command[0] = notCmake;
    commandResult.build.command[0] = notCmake;
    const nonCmakeObserved = validateBuildCommandEvidence(commandResult, selectedBuildDir);
    if (nonCmakeObserved !== 'build-command') {
      throw new Error(`phase non-CMake executable escaped: ${String(nonCmakeObserved)}`);
    }
    if (process.platform === 'win32') {
      commandResult.configure.command[0] = realCmake.toUpperCase();
      commandResult.build.command[0] = realCmake;
      const caseAliasObserved = validateBuildCommandEvidence(commandResult, selectedBuildDir);
      if (caseAliasObserved !== null) {
        throw new Error(`phase CMake case alias rejected: ${String(caseAliasObserved)}`);
      }
    }
    const round6Baseline = {
      cmakeExecutable: cmakeExecutableEvidence(trustedCmake),
      configure: {
        command: [realCmake, '-S', nativeRoot, '-B', selectedBuildDir],
      },
      build: {
        command: [realCmake, '--build', selectedBuildDir, '--target', 'test_ice_config'],
      },
    };
    if (validateBuildCommandEvidence(round6Baseline, selectedBuildDir) !== null) {
      throw new Error('phase Round 6 separate -S/-B baseline rejected');
    }
    const expectRound6Rejection = (name, candidate) => {
      const observed = validateBuildCommandEvidence(candidate, selectedBuildDir);
      if (observed !== 'build-command') {
        throw new Error(`phase Round 6 ${name} escaped: ${String(observed)}`);
      }
    };
    const replaceSeparated = (candidate, flag, replacement) => {
      const index = candidate.configure.command.indexOf(flag);
      if (index < 0) throw new Error(`phase Round 6 baseline omitted ${flag}`);
      candidate.configure.command.splice(index, 2, ...replacement);
    };
    const staleConfigureBuild = structuredClone(round6Baseline);
    replaceSeparated(staleConfigureBuild, '-B', ['-B', unrelatedBuildDir]);
    expectRound6Rejection('stale configure -B', staleConfigureBuild);
    const staleConfigureSource = structuredClone(round6Baseline);
    replaceSeparated(staleConfigureSource, '-S', ['-S', unrelatedSourceDir]);
    expectRound6Rejection('stale configure -S', staleConfigureSource);
    const duplicateConfigureBuild = structuredClone(round6Baseline);
    duplicateConfigureBuild.configure.command.push('-B', selectedBuildDir);
    expectRound6Rejection('duplicate configure -B', duplicateConfigureBuild);
    const duplicateConfigureSource = structuredClone(round6Baseline);
    duplicateConfigureSource.configure.command.push('-S', unrelatedSourceDir);
    expectRound6Rejection('conflicting configure -S', duplicateConfigureSource);
    const missingConfigureBuild = structuredClone(round6Baseline);
    replaceSeparated(missingConfigureBuild, '-B', []);
    expectRound6Rejection('missing configure -B', missingConfigureBuild);
    const missingConfigureSource = structuredClone(round6Baseline);
    replaceSeparated(missingConfigureSource, '-S', []);
    expectRound6Rejection('missing configure -S', missingConfigureSource);
    for (const [name, flag, token] of [
      ['attached -B', '-B', `-B${selectedBuildDir}`],
      ['equals -B', '-B', `-B=${selectedBuildDir}`],
      ['attached -S', '-S', `-S${nativeRoot}`],
      ['equals -S', '-S', `-S=${nativeRoot}`],
    ]) {
      const candidate = structuredClone(round6Baseline);
      replaceSeparated(candidate, flag, [token]);
      expectRound6Rejection(name, candidate);
    }
    const selectedBuildAlias = path.join(commandRoot, 'selected-build-alias');
    const nativeSourceAlias = path.join(commandRoot, 'native-source-alias');
    fs.symlinkSync(
      selectedBuildDir,
      selectedBuildAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.symlinkSync(nativeRoot, nativeSourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalDirectoryAliases = structuredClone(round6Baseline);
    replaceSeparated(canonicalDirectoryAliases, '-B', ['-B', selectedBuildAlias]);
    replaceSeparated(canonicalDirectoryAliases, '-S', ['-S', nativeSourceAlias]);
    if (validateBuildCommandEvidence(canonicalDirectoryAliases, selectedBuildDir) !== null) {
      throw new Error('phase Round 6 canonical directory aliases rejected');
    }
    if (process.platform === 'win32') {
      const cmakePathAliases = structuredClone(round6Baseline);
      cmakePathAliases.configure.command[0] = windowsShortPath(realCmake);
      cmakePathAliases.build.command[0] = realCmake;
      if (validateBuildCommandEvidence(cmakePathAliases, selectedBuildDir) !== null) {
        throw new Error('phase Round 6 CMake long/8.3 alias rejected');
      }
    }
    const counterfeitRoot = path.join(commandRoot, 'counterfeit-small');
    const sameSizeRoot = path.join(commandRoot, 'counterfeit-same-size');
    const versionSpoofRoot = path.join(commandRoot, 'version-spoof');
    fs.mkdirSync(counterfeitRoot, { recursive: true });
    fs.mkdirSync(sameSizeRoot, { recursive: true });
    fs.mkdirSync(versionSpoofRoot, { recursive: true });
    const counterfeit = path.join(counterfeitRoot, cmakeName);
    const sameSizeCounterfeit = path.join(sameSizeRoot, cmakeName);
    const versionSpoof = path.join(versionSpoofRoot, cmakeName);
    fs.writeFileSync(counterfeit, 'arbitrary text, not CMake');
    fs.writeFileSync(sameSizeCounterfeit, 'not CMake');
    fs.truncateSync(sameSizeCounterfeit, fs.statSync(realCmake).size);
    fs.writeFileSync(versionSpoof, 'cmake version 99.99.99\nnot an executable\n');
    for (const [name, candidatePath] of [
      ['same-name arbitrary-text CMake', counterfeit],
      ['same-name same-size counterfeit CMake', sameSizeCounterfeit],
      ['missing CMake', path.join(commandRoot, 'missing', cmakeName)],
    ]) {
      const candidate = structuredClone(round6Baseline);
      candidate.configure.command[0] = candidatePath;
      candidate.build.command[0] = candidatePath;
      const observed = validateBuildCommandEvidence(candidate, selectedBuildDir);
      if (observed !== 'build-command') {
        throw new Error(`phase Round 7 ${name} escaped: ${String(observed)}`);
      }
    }

    const withPath = (directories, callback) => {
      process.env[pathEnvironmentName] = [...directories, originalPath].join(path.delimiter);
      try {
        return callback();
      } finally {
        process.env[pathEnvironmentName] = originalPath;
      }
    };
    const expectPoisonSkipped = (name, directory, fakeExecutable) => {
      withPath([directory, path.dirname(realCmake)], () => {
        const discovered = discoverTrustedCmake();
        if (pathKey(discovered.path) !== pathKey(realCmake)) {
          throw new Error(`phase ${name} selected ${discovered.path}`);
        }
        if (validateBuildCommandEvidence(round6Baseline, selectedBuildDir) !== null) {
          throw new Error(`phase ${name} rejected real CMake evidence`);
        }
        const fakeEvidence = structuredClone(round6Baseline);
        fakeEvidence.configure.command[0] = fakeExecutable;
        fakeEvidence.build.command[0] = fakeExecutable;
        if (validateBuildCommandEvidence(fakeEvidence, selectedBuildDir) !== 'build-command') {
          throw new Error(`phase ${name} accepted fake CMake evidence`);
        }
      });
      process.stdout.write(`[ROUND8 CONTROL PASS] phase-${name}\n`);
    };
    expectPoisonSkipped('path-arbitrary-text-first-real-next', counterfeitRoot, counterfeit);
    expectPoisonSkipped('path-version-spoof-first-real-next', versionSpoofRoot, versionSpoof);
    expectPoisonSkipped('path-same-size-first-real-next', sameSizeRoot, sameSizeCounterfeit);

    withPath([aliasTools], () => {
      const aliasEvidence = structuredClone(round6Baseline);
      aliasEvidence.configure.command[0] = path.join(aliasTools, cmakeName);
      if (validateBuildCommandEvidence(aliasEvidence, selectedBuildDir) !== null) {
        throw new Error('phase PATH actual CMake alias rejected');
      }
    });
    process.stdout.write('[ROUND8 CONTROL PASS] phase-path-actual-alias\n');

    const copiedRoot = path.join(commandRoot, 'byte-identical-runnable-copy');
    fs.mkdirSync(copiedRoot, { recursive: true });
    const copiedCmake = path.join(copiedRoot, cmakeName);
    fs.copyFileSync(realCmake, copiedCmake);
    const copiedIdentity = canonicalFileIdentity(copiedCmake);
    if (
      copiedIdentity.size !== trustedCmake.identity.size ||
      copiedIdentity.sha256 !== trustedCmake.identity.sha256
    ) {
      throw new Error('phase byte-identical CMake copy identity mismatch');
    }
    withPath([copiedRoot, path.dirname(realCmake)], () => {
      const copiedDiscovery = discoverTrustedCmake();
      if (pathKey(copiedDiscovery.path) === pathKey(copiedCmake)) {
        const copiedEvidence = structuredClone(round6Baseline);
        copiedEvidence.configure.command[0] = copiedCmake;
        copiedEvidence.build.command[0] = copiedCmake;
        copiedEvidence.cmakeExecutable = cmakeExecutableEvidence(copiedDiscovery);
        if (validateBuildCommandEvidence(copiedEvidence, selectedBuildDir) !== null) {
          throw new Error('phase byte-identical runnable CMake copy rejected');
        }
        fs.writeFileSync(copiedCmake, 'TOCTOU replacement, not CMake');
        if (validateBuildCommandEvidence(copiedEvidence, selectedBuildDir) !== 'build-command') {
          throw new Error('phase in-place CMake replacement escaped');
        }
        process.stdout.write('[ROUND8 CONTROL PASS] phase-byte-identical-copy-and-toctou\n');
      } else {
        process.stdout.write(
          '[ROUND8 CONTROL PASS] phase-byte-identical-copy-not-independently-runnable\n',
        );
      }
    });

    const identityMutation = structuredClone(round6Baseline);
    identityMutation.cmakeExecutable.afterBuild.sha256 = '0'.repeat(64);
    if (validateBuildCommandEvidence(identityMutation, selectedBuildDir) !== 'build-command') {
      throw new Error('phase recorded CMake identity mutation escaped');
    }
    process.stdout.write('[ROUND8 CONTROL PASS] phase-recorded-cmake-identity-mutation\n');
  } finally {
    process.env[pathEnvironmentName] = originalPath;
    if (!path.basename(commandRoot).startsWith('game-capture-phase-command-')) {
      throw new Error('phase command-control path safety check failed');
    }
    fs.rmSync(commandRoot, { recursive: true, force: true });
  }
  if (validCommandObserved !== null) {
    emit('HARNESS_ERROR', { reason: 'valid-build-command-control-rejected' }, 2);
  }
  if (staleCommandObserved !== 'build-command') {
    emit(
      'HARNESS_ERROR',
      {
        reason: 'stale-build-command-control-escaped',
        expected: 'build-command',
        observed: staleCommandObserved,
      },
      2,
    );
  }
  process.stdout.write('[ROUND4 CONTROL PASS] phase-build-command-coherence: build-command\n');
  process.stdout.write('[ROUND5 CONTROL PASS] phase-build-executable-identity\n');
  process.stdout.write('[ROUND6 CONTROL PASS] phase-configure-S-B-coherence\n');
  process.stdout.write('[ROUND7 CONTROL PASS] phase-discovered-cmake-identity\n');
  process.stdout.write('[ROUND8 CONTROL PASS] phase-trusted-cmake-identity\n');
  process.stdout.write('[ROUND2 CONTROL SUMMARY] phase artifact controls passed\n');
  process.exit(0);
}

if (fs.existsSync(options.buildDir)) {
  emit(
    'HARNESS_ERROR',
    { reason: 'fresh-build-directory-already-exists', buildDir: options.buildDir },
    2,
  );
}

const child = spawnSync(
  process.execPath,
  [
    gateScript,
    `--build-dir=${options.buildDir}`,
    '--expect-current-red',
    '--require-fresh-build-dir',
  ],
  {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: 660000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  },
);

const stdout = String(child.stdout || '');
const stderr = String(child.stderr || '');
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

if (child.error) {
  emit('HARNESS_ERROR', { reason: 'gate-process', error: child.error.message }, 2);
}

const terminalLines = stdout
  .split(/\r?\n/)
  .filter((line) => line.startsWith(GATE_TERMINAL_PREFIX));
if (terminalLines.length !== 1) {
  emit(
    'HARNESS_ERROR',
    { reason: 'gate-terminal-count', observed: terminalLines.length },
    2,
  );
}

let result;
try {
  result = JSON.parse(terminalLines[0].slice(GATE_TERMINAL_PREFIX.length));
} catch (error) {
  emit('HARNESS_ERROR', { reason: 'gate-terminal-json', error: error.message }, 2);
}

const invariants = {
  childExitedRed: child.status === 1,
  exactBuildRed: result.status === 'RED' && result.stage === 'build',
  expectationConfirmed: result.currentRedExpectation?.passed === true,
  configureSucceeded: result.configure?.attempted === true && result.configure.exitCode === 0,
  buildFailed:
    result.build?.attempted === true &&
    Number.isInteger(result.build.exitCode) &&
    result.build.exitCode !== 0,
  buildCommandExact: validateBuildCommandEvidence(result, options.buildDir) === null,
  noArtifactExecution:
    result.flags?.artifactExecuted === false && result.artifact?.executed === false,
  noFunctionsExecution:
    result.flags?.functionsInvoked === false && result.functions?.invoked === false,
  noCtestExecution:
    result.flags?.ctestInvoked === false &&
    result.registration?.invoked === false &&
    result.runtime?.invoked === false,
  liveSchemaValidated: validateLiveSchemaEvidence(result) === null,
  artifactEvidenceExact:
    validateFailedBuildArtifactEvidence(result, options.buildDir) === null,
};

const combinedOutput = `${stdout}\n${stderr}`;
const seamMarkers = ['IceConfigDependencies', 'resolveIceConfigWithDependencies'];
const observedSeamMarkers = seamMarkers.filter((marker) => combinedOutput.includes(marker));
invariants.missingPublicSeamProven = observedSeamMarkers.length === seamMarkers.length;

const failedInvariants = Object.entries(invariants)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

if (failedInvariants.length > 0) {
  emit(
    'RED',
    {
      reason: 'current-red-contract-mismatch',
      failedInvariants,
      observedGateStatus: result.status,
      observedGateStage: result.stage,
      observedGateExit: child.status,
      observedSeamMarkers,
    },
    1,
  );
}

emit(
  'GREEN',
  {
    verifiedGateStatus: result.status,
    verifiedGateStage: result.stage,
    verifiedBuildExit: result.build.exitCode,
    buildOutputSha256: result.build.outputSha256,
    observedSeamMarkers,
    artifactExecuted: false,
    functionsInvoked: false,
    ctestInvoked: false,
    limitation:
      'This helper proves the expected tests-first compile RED and stale-artifact non-execution; it does not claim the production implementation or shipped application is tested.',
  },
  0,
);
