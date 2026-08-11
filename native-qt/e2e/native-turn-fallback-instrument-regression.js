'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TERMINAL_PREFIX = 'NATIVE_TURN_FALLBACK_INSTRUMENT_RESULT ';
const GATE_NAME = 'native-turn-fallback-instrument';
const TERMINAL_VERSION = 1;
const TURN_EPOCH_OFFSET_MS = 1653305816700;
const LIVE_TIMEOUT_MS = 10000;
const LIVE_MAX_BYTES = 2 * 1024 * 1024;
const CTEST_TIMEOUT_SECONDS = 30;
const CONFIGURE_TIMEOUT_MS = 240000;
const BUILD_TIMEOUT_MS = 300000;
const CMAKE_PROBE_TIMEOUT_MS = 5000;
const CMAKE_PROBE_MAX_BYTES = 64 * 1024;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NATIVE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUILD_DIR = path.join(NATIVE_ROOT, 'build-test');
const SOURCE_URL = 'https://turnservers.vdo.ninja/';

const EXPECTED_FUNCTIONS = Object.freeze([
  'testModeRoutingFetchCountsAndRequestContract',
  'testHttpStatusAndVersionContract',
  'testSchemaValidationIsAtomic',
  'testScalarAndArrayUrlsWithAdditiveMetadata',
  'testFlattenPreservesEveryUrlOrderAndValue',
  'testFailureOutcomesPublishNoTurnAndNoFallback',
  'testDynamicResponseCounts',
  'testFullOrderedConfigFingerprintSensitivity',
  'testPeerBindingRequiresExactRegistryConsumption',
  'testDiagnosticsRedactCredentialsAndRawPayload',
  'testIndependentResolutionCyclesRefetchAndReplace',
  'testMissingDependenciesFailClosed',
  'testFilterSessionDescriptionForHostOnly',
  'testFilterSessionDescriptionForStunOnly',
  'testCandidateAllowedForMode',
]);
const EXPECTED_QT_PASSES = EXPECTED_FUNCTIONS.length + 2; // initTestCase + cleanupTestCase

const MANIFEST_PATHS = Object.freeze([
  'native-qt/include/versus/webrtc/ice_config.h',
  'native-qt/src/webrtc/ice_config.cpp',
  'native-qt/tests/test_ice_config.cpp',
  'native-qt/CMakeLists.txt',
  'native-qt/e2e/native-turn-fallback-instrument-regression.js',
  'native-qt/e2e/native-turn-fallback-phase1-known-bad-regression.js',
  'native-qt/package.json',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  return path.resolve(value);
}

function pathKey(value) {
  const resolved = normalizePath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
  const relative = path.relative(normalizePath(parent), normalizePath(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalExistingPath(value) {
  return fs.realpathSync.native(normalizePath(value));
}

function parseArgs(argv) {
  const result = {
    buildDir: DEFAULT_BUILD_DIR,
    selfCheckOnly: false,
    round2ControlsOnly: false,
    round3ControlsOnly: false,
    round4ControlsOnly: false,
    round5ControlsOnly: false,
    round6ControlsOnly: false,
    round7ControlsOnly: false,
    round8ControlsOnly: false,
    expectCurrentRed: false,
    requireFreshBuildDir: false,
    internalFakeChild: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-check-only') {
      result.selfCheckOnly = true;
    } else if (arg === '--round2-controls-only') {
      result.round2ControlsOnly = true;
    } else if (arg === '--round3-controls-only') {
      result.round3ControlsOnly = true;
    } else if (arg === '--round4-controls-only') {
      result.round4ControlsOnly = true;
    } else if (arg === '--round5-controls-only') {
      result.round5ControlsOnly = true;
    } else if (arg === '--round6-controls-only') {
      result.round6ControlsOnly = true;
    } else if (arg === '--round7-controls-only') {
      result.round7ControlsOnly = true;
    } else if (arg === '--round8-controls-only') {
      result.round8ControlsOnly = true;
    } else if (arg === '--expect-current-red') {
      result.expectCurrentRed = true;
    } else if (arg === '--require-fresh-build-dir') {
      result.requireFreshBuildDir = true;
    } else if (arg === '--build-dir') {
      index += 1;
      if (index >= argv.length) throw new Error('--build-dir requires a value');
      result.buildDir = normalizePath(argv[index]);
    } else if (arg.startsWith('--build-dir=')) {
      result.buildDir = normalizePath(arg.slice('--build-dir='.length));
    } else if (arg.startsWith('--internal-fake-child=')) {
      result.internalFakeChild = arg.slice('--internal-fake-child='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  result.buildDir = normalizePath(result.buildDir);
  return result;
}

function findExecutable(name, fixedCandidates = []) {
  for (const candidate of fixedCandidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(finder, [name], { encoding: 'utf8', timeout: 5000 });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  throw new Error(`required executable not found: ${name}`);
}

function parseCmakeVersion(stdout) {
  if (Buffer.byteLength(String(stdout || ''), 'utf8') > CMAKE_PROBE_MAX_BYTES) return null;
  const match = String(stdout || '').match(/^cmake version ([0-9]+(?:\.[0-9]+)+)\r?(?:\n|$)/);
  return match ? match[1] : null;
}

function canonicalFileIdentity(filePath) {
  const canonical = canonicalExistingPath(filePath);
  const identity = fileIdentity(canonical);
  if (!identity.exists) throw new Error(`executable identity is unavailable: ${canonical}`);
  return identity;
}

function discoverTrustedCmake() {
  const executableName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
  const pathValue = environmentValue(process.env, 'PATH');
  const candidates = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => path.join(entry, executableName));
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const canonical = canonicalExistingPath(candidate);
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
      if (version) {
        return { path: canonical, version, identity: afterProbe };
      }
    } catch {
      // Continue to the next canonical PATH candidate when probing or identity capture fails.
    }
  }
  throw new Error('a trusted CMake executable was not found on PATH');
}

function discoverCmakeExecutable() {
  return discoverTrustedCmake().path;
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

function loadToolchainEnvironment(buildDir = DEFAULT_BUILD_DIR) {
  if (process.platform !== 'win32') {
    return {
      env: { ...process.env },
      provenance: { source: 'inherited-process-environment', targetArchitecture: process.arch },
    };
  }

  const candidates = [];
  const cachePaths = [path.join(buildDir, 'CMakeCache.txt')];
  if (pathKey(buildDir) !== pathKey(DEFAULT_BUILD_DIR)) {
    cachePaths.push(path.join(DEFAULT_BUILD_DIR, 'CMakeCache.txt'));
  }
  for (const cachePath of cachePaths) {
    if (!fs.existsSync(cachePath)) continue;
    const cache = fs.readFileSync(cachePath, 'utf8');
    const compiler = cache.match(/^CMAKE_CXX_COMPILER(?::[^=]*)?=(.+)$/m)?.[1]?.trim();
    if (compiler) {
      const compilerNative = compiler.replaceAll('/', path.sep);
      const marker = compilerNative
        .toLowerCase()
        .lastIndexOf(`${path.sep}vc${path.sep}tools${path.sep}`);
      if (marker > 0) {
        candidates.push(
          path.join(compilerNative.slice(0, marker), 'Common7', 'Tools', 'VsDevCmd.bat'),
        );
      }
    }
  }
  if (process.env.VSINSTALLDIR) {
    candidates.push(path.join(process.env.VSINSTALLDIR, 'Common7', 'Tools', 'VsDevCmd.bat'));
  }
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const located = spawnSync(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    );
    if (located.status === 0) {
      const installation = String(located.stdout).split(/\r?\n/).find(Boolean);
      if (installation) {
        candidates.push(path.join(installation.trim(), 'Common7', 'Tools', 'VsDevCmd.bat'));
      }
    }
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  for (const edition of ['Community', 'Professional', 'Enterprise', 'BuildTools']) {
    candidates.push(
      path.join(programFiles, 'Microsoft Visual Studio', '2022', edition, 'Common7', 'Tools', 'VsDevCmd.bat'),
    );
  }
  const script = candidates.find((candidate) => fs.existsSync(candidate));
  if (!script) throw new Error('Visual Studio x64 developer environment script was not found');

  const command = `call "${script}" -no_logo -arch=x64 -host_arch=x64 >nul && set`;
  const captured = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (captured.status !== 0 || captured.error) {
    throw new Error(
      `Visual Studio developer environment failed: ${captured.error?.message || captured.stderr || captured.status}`,
    );
  }
  const environment = {};
  for (const line of String(captured.stdout).split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals > 0) environment[line.slice(0, equals)] = line.slice(equals + 1);
  }
  const valueFor = (name) => {
    const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name);
    return key ? environment[key] : '';
  };
  const includeValue = valueFor('INCLUDE');
  const pathValue = valueFor('PATH');
  if (!includeValue || !pathValue) {
    throw new Error('Visual Studio developer environment omitted INCLUDE or PATH');
  }
  return {
    env: environment,
    provenance: {
      source: script,
      sourceSha256: fileIdentity(script).sha256,
      targetArchitecture: valueFor('VSCMD_ARG_TGT_ARCH') || 'unknown',
      includeEntryCount: includeValue.split(';').filter(Boolean).length,
      pathEntryCount: pathValue.split(';').filter(Boolean).length,
    },
  };
}

function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? environment[key] : '';
}

function setEnvironmentValue(environment, name, value) {
  const existing = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  if (existing && existing !== name) delete environment[existing];
  environment[name] = value;
}

function cacheValue(cachePath, name) {
  if (!fs.existsSync(cachePath)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fs
    .readFileSync(cachePath, 'utf8')
    .match(new RegExp(`^${escaped}(?::[^=]*)?=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function loadQtEnvironment(buildDir, baseEnvironment) {
  const candidates = [];
  const inherited = environmentValue(process.env, 'Qt6_DIR');
  if (inherited) candidates.push({ value: inherited, source: 'process-environment:Qt6_DIR' });
  for (const cachePath of [
    path.join(buildDir, 'CMakeCache.txt'),
    path.join(DEFAULT_BUILD_DIR, 'CMakeCache.txt'),
  ]) {
    const value = cacheValue(cachePath, 'Qt6_DIR');
    if (value) candidates.push({ value, source: `cmake-cache:${cachePath}` });
  }
  candidates.push({
    value: 'C:\\vcpkg\\installed\\x64-windows\\share\\Qt6',
    source: 'validated-vcpkg-default',
  });

  let selected = null;
  for (const candidate of candidates) {
    const directory = normalizePath(candidate.value);
    const configPath = path.join(directory, 'Qt6Config.cmake');
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      selected = { ...candidate, directory, configPath };
      break;
    }
  }
  if (!selected) throw new Error('a valid Qt6_DIR with Qt6Config.cmake was not found');

  const canonicalDirectory = fs.realpathSync.native(selected.directory);
  const prefixPath = path.resolve(canonicalDirectory, '..', '..');
  const runtimeBin = path.join(prefixPath, 'bin');
  const environment = { ...baseEnvironment };
  setEnvironmentValue(environment, 'Qt6_DIR', canonicalDirectory);
  const existingPrefix = environmentValue(environment, 'CMAKE_PREFIX_PATH');
  setEnvironmentValue(
    environment,
    'CMAKE_PREFIX_PATH',
    existingPrefix ? `${prefixPath}${path.delimiter}${existingPrefix}` : prefixPath,
  );
  if (fs.existsSync(runtimeBin)) {
    const existingPath = environmentValue(environment, 'PATH');
    setEnvironmentValue(
      environment,
      'PATH',
      existingPath ? `${runtimeBin}${path.delimiter}${existingPath}` : runtimeBin,
    );
  }
  return {
    env: environment,
    cmakeArgument: `-DQt6_DIR=${canonicalDirectory}`,
    provenance: {
      source: selected.source,
      qt6Dir: selected.directory,
      canonicalQt6Dir: canonicalDirectory,
      qt6ConfigPath: fs.realpathSync.native(selected.configPath),
      qt6ConfigSha256: fileIdentity(selected.configPath).sha256,
      prefixPath,
      runtimeBin,
      runtimeBinExists: fs.existsSync(runtimeBin),
    },
  };
}

function loadCmakeGenerator(buildDir) {
  for (const cachePath of [
    path.join(buildDir, 'CMakeCache.txt'),
    path.join(DEFAULT_BUILD_DIR, 'CMakeCache.txt'),
  ]) {
    const generator = cacheValue(cachePath, 'CMAKE_GENERATOR');
    const makeProgram = cacheValue(cachePath, 'CMAKE_MAKE_PROGRAM');
    const buildType = cacheValue(cachePath, 'CMAKE_BUILD_TYPE') || 'Release';
    if (!generator || !makeProgram || !fs.existsSync(makeProgram)) continue;
    const canonicalMakeProgram = canonicalExistingPath(makeProgram);
    return {
      arguments: [
        '-G',
        generator,
        `-DCMAKE_MAKE_PROGRAM=${canonicalMakeProgram}`,
        `-DCMAKE_BUILD_TYPE=${buildType}`,
      ],
      provenance: {
        sourceCache: cachePath,
        generator,
        buildType,
        makeProgram: normalizePath(makeProgram),
        canonicalMakeProgram,
        makeProgramSha256: fileIdentity(canonicalMakeProgram).sha256,
      },
    };
  }
  throw new Error('a validated CMake generator and make program were not found');
}

function runCommand(command, args, options = {}) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    windowsHide: options.windowsHide !== false,
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  return {
    command: [command, ...args],
    attempted: true,
    exitCode: Number.isInteger(child.status) ? child.status : null,
    signal: child.signal || null,
    timedOut: Boolean(child.error && child.error.code === 'ETIMEDOUT'),
    spawnError: child.error ? String(child.error.message || child.error) : null,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    outputSha256: sha256(`${stdout}\n${stderr}`),
  };
}

function publicCommandResult(result) {
  return {
    command: result.command,
    attempted: result.attempted,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    outputSha256: result.outputSha256,
  };
}

function publishCommand(label, result) {
  process.stdout.write(
    `[${label}] exit=${String(result.exitCode)} timeout=${result.timedOut} output_sha256=${result.outputSha256}\n`,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function fileIdentity(filePath) {
  const absolute = normalizePath(filePath);
  if (!fs.existsSync(absolute)) {
    return { path: absolute, exists: false, size: 0, mtimeMs: 0, sha256: null };
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    return { path: absolute, exists: false, size: 0, mtimeMs: 0, sha256: null };
  }
  const content = fs.readFileSync(absolute);
  return {
    path: absolute,
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(content),
  };
}

function artifactCandidates(buildDir) {
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

function identityShapeValid(identity) {
  if (!identity || typeof identity.path !== 'string' || typeof identity.exists !== 'boolean') {
    return false;
  }
  if (identity.exists) {
    return (
      Number.isFinite(identity.size) &&
      identity.size > 0 &&
      Number.isFinite(identity.mtimeMs) &&
      identity.mtimeMs > 0 &&
      /^[0-9a-f]{64}$/.test(identity.sha256 || '')
    );
  }
  return identity.size === 0 && identity.mtimeMs === 0 && identity.sha256 === null;
}

function identityEqual(left, right) {
  return (
    identityShapeValid(left) &&
    identityShapeValid(right) &&
    pathKey(left.path) === pathKey(right.path) &&
    left.exists === right.exists &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function cmakeExecutableEvidence(discovery, snapshots = {}) {
  const snapshot = (name) => ({ ...(snapshots[name] || discovery.identity) });
  return {
    path: discovery.path,
    version: discovery.version,
    probeTimeoutMs: CMAKE_PROBE_TIMEOUT_MS,
    probeMaxBytes: CMAKE_PROBE_MAX_BYTES,
    discovered: { ...discovery.identity },
    beforeConfigure: snapshot('beforeConfigure'),
    afterConfigure: snapshot('afterConfigure'),
    beforeBuild: snapshot('beforeBuild'),
    afterBuild: snapshot('afterBuild'),
  };
}

function cmakeExecutableEvidenceReason(evidence, trusted) {
  if (
    !evidence ||
    typeof evidence.path !== 'string' ||
    pathKey(evidence.path) !== pathKey(trusted.path) ||
    evidence.version !== trusted.version ||
    evidence.probeTimeoutMs !== CMAKE_PROBE_TIMEOUT_MS ||
    evidence.probeMaxBytes !== CMAKE_PROBE_MAX_BYTES
  ) {
    return 'cmake-executable-provenance';
  }
  for (const name of [
    'discovered',
    'beforeConfigure',
    'afterConfigure',
    'beforeBuild',
    'afterBuild',
  ]) {
    if (!identityEqual(evidence[name], trusted.identity)) {
      return `cmake-executable-${name}`;
    }
  }
  return null;
}

function identityListMatchesCandidates(identities, buildDir) {
  const candidates = artifactCandidates(buildDir);
  return (
    Array.isArray(identities) &&
    identities.length === candidates.length &&
    identities.every(
      (identity, index) =>
        identityShapeValid(identity) && pathKey(identity.path) === pathKey(candidates[index]),
    )
  );
}

function sourceManifest() {
  const entries = MANIFEST_PATHS.map((relativePath) => {
    const identity = fileIdentity(path.join(REPO_ROOT, relativePath));
    if (!identity.exists) throw new Error(`manifest source is missing: ${relativePath}`);
    return {
      path: relativePath.replaceAll('\\', '/'),
      size: identity.size,
      sha256: identity.sha256,
    };
  });
  const canonical = entries
    .map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return { entries, sha256: sha256(canonical) };
}

function decodeCppString(body) {
  let output = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      output += character;
      continue;
    }
    index += 1;
    if (index >= body.length) break;
    const escaped = body[index];
    const simple = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", 0: '\0' };
    if (Object.hasOwn(simple, escaped)) {
      output += simple[escaped];
    } else if (escaped === 'x') {
      const match = body.slice(index + 1).match(/^[0-9a-fA-F]+/);
      if (match) {
        output += String.fromCodePoint(Number.parseInt(match[0], 16));
        index += match[0].length;
      }
    } else if (/[0-7]/.test(escaped)) {
      const match = body.slice(index).match(/^[0-7]{1,3}/);
      output += String.fromCodePoint(Number.parseInt(match[0], 8));
      index += match[0].length - 1;
    } else {
      output += escaped;
    }
  }
  return output;
}

function lexCpp(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const advance = (text) => {
    line += (text.match(/\n/g) || []).length;
    index += text.length;
  };
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      advance(whitespace[0]);
      continue;
    }
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      advance(end < 0 ? rest : rest.slice(0, end));
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      advance(end < 0 ? rest : rest.slice(0, end + 2));
      continue;
    }
    const rawStart = rest.match(/^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/);
    if (rawStart) {
      const delimiter = rawStart[1];
      const close = `)${delimiter}"`;
      const closeIndex = rest.indexOf(close, rawStart[0].length);
      if (closeIndex < 0) throw new Error(`unterminated raw C++ string on line ${line}`);
      const full = rest.slice(0, closeIndex + close.length);
      const value = rest.slice(rawStart[0].length, closeIndex);
      tokens.push({ type: 'string', value, line });
      advance(full);
      continue;
    }
    const characterStart = rest.match(/^(?:u8|u|U|L)?'/);
    const isDigitSeparator =
      characterStart &&
      characterStart[0] === "'" &&
      index > 0 &&
      /[0-9a-fA-F]/.test(source[index - 1]) &&
      /[0-9a-fA-F]/.test(rest[1] || '');
    if (characterStart && !isDigitSeparator) {
      let cursor = characterStart[0].length;
      let escaped = false;
      while (cursor < rest.length && rest[cursor] !== '\n') {
        if (!escaped && rest[cursor] === "'") break;
        if (!escaped && rest[cursor] === '\\') {
          escaped = true;
        } else {
          escaped = false;
        }
        cursor += 1;
      }
      if (cursor < rest.length && rest[cursor] === "'") {
        const full = rest.slice(0, cursor + 1);
        tokens.push({ type: 'character', value: full, line });
        advance(full);
        continue;
      }
    }
    const quoteStart = rest.match(/^(?:u8|u|U|L)?"/);
    if (quoteStart) {
      const startLine = line;
      let cursor = quoteStart[0].length;
      let escaped = false;
      while (cursor < rest.length) {
        if (!escaped && rest[cursor] === '"') break;
        if (!escaped && rest[cursor] === '\\') {
          escaped = true;
        } else {
          escaped = false;
        }
        cursor += 1;
      }
      if (cursor >= rest.length) throw new Error(`unterminated C++ string on line ${line}`);
      const body = rest.slice(quoteStart[0].length, cursor);
      const full = rest.slice(0, cursor + 1);
      tokens.push({ type: 'string', value: decodeCppString(body), line: startLine });
      advance(full);
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_]\w*/);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0], line });
      advance(identifier[0]);
      continue;
    }
    if (rest.startsWith('::')) {
      tokens.push({ type: 'symbol', value: '::', line });
      advance('::');
      continue;
    }
    tokens.push({ type: 'symbol', value: rest[0], line });
    advance(rest[0]);
  }
  return tokens;
}

function evaluateConstantExpression(
  tokens,
  aliases,
  functionMacros = new Map(),
  expansionStack = new Set(),
) {
  let index = 0;

  function parseExpression(closeSymbol = null) {
    let output = '';
    let consumed = false;
    let expectingTerm = true;
    while (index < tokens.length && (!closeSymbol || tokens[index].value !== closeSymbol)) {
      if (!expectingTerm) {
        if (tokens[index].value === '+') {
          index += 1;
          expectingTerm = true;
          continue;
        }
        if (
          tokens[index].type === 'string' ||
          (tokens[index].type === 'identifier' && aliases.has(tokens[index].value)) ||
          (tokens[index].type === 'identifier' && functionMacros.has(tokens[index].value))
        ) {
          expectingTerm = true;
        } else {
          return null;
        }
      }
      const term = parseTerm();
      if (term === null) return null;
      output += term;
      consumed = true;
      expectingTerm = false;
    }
    if (!consumed || expectingTerm) return null;
    return output;
  }

  function parseTerm() {
    const token = tokens[index];
    if (!token) return null;
    if (token.type === 'string') {
      index += 1;
      if (
        tokens[index] &&
        tokens[index].type === 'identifier' &&
        (tokens[index].value === 's' || tokens[index].value === 'sv')
      ) {
        index += 1;
      }
      return token.value;
    }
    if (token.value === '(' || token.value === '{') {
      const close = token.value === '(' ? ')' : '}';
      index += 1;
      const value = parseExpression(close);
      if (value === null || !tokens[index] || tokens[index].value !== close) return null;
      index += 1;
      return value;
    }
    if (token.type !== 'identifier') return null;

    const nameParts = [token.value];
    index += 1;
    while (
      tokens[index] && tokens[index].value === '::' &&
      tokens[index + 1] && tokens[index + 1].type === 'identifier'
    ) {
      nameParts.push(tokens[index + 1].value);
      index += 2;
    }
    const qualified = nameParts.join('::');
    if (
      functionMacros.has(qualified) &&
      tokens[index] &&
      tokens[index].value === '(' &&
      !expansionStack.has(qualified)
    ) {
      const macroDefinition = functionMacros.get(qualified);
      index += 1;
      const argumentTokenGroups = [];
      let current = [];
      let depth = 0;
      while (index < tokens.length) {
        const currentToken = tokens[index];
        if (currentToken.value === '(' || currentToken.value === '{') {
          depth += 1;
          current.push(currentToken);
          index += 1;
          continue;
        }
        if ((currentToken.value === ')' || currentToken.value === '}') && depth > 0) {
          depth -= 1;
          current.push(currentToken);
          index += 1;
          continue;
        }
        if (currentToken.value === ',' && depth === 0) {
          argumentTokenGroups.push(current);
          current = [];
          index += 1;
          continue;
        }
        if (currentToken.value === ')' && depth === 0) break;
        current.push(currentToken);
        index += 1;
      }
      if (!tokens[index] || tokens[index].value !== ')') return null;
      index += 1;
      argumentTokenGroups.push(current);
      if (argumentTokenGroups.length !== macroDefinition.parameters.length) return null;
      const macroAliases = new Map(aliases);
      for (let argumentIndex = 0; argumentIndex < argumentTokenGroups.length; argumentIndex += 1) {
        const argumentValue = evaluateConstantExpression(
          argumentTokenGroups[argumentIndex],
          aliases,
          functionMacros,
          expansionStack,
        );
        if (argumentValue === null) return null;
        macroAliases.set(macroDefinition.parameters[argumentIndex], argumentValue);
      }
      const nestedStack = new Set(expansionStack);
      nestedStack.add(qualified);
      return evaluateConstantExpression(
        macroDefinition.tokens,
        macroAliases,
        functionMacros,
        nestedStack,
      );
    }
    const wrappers = new Set([
      'std::string',
      'std::string_view',
      'QString',
      'QLatin1String',
      'QLatin1StringView',
    ]);
    if (wrappers.has(qualified) && tokens[index] && ['(', '{'].includes(tokens[index].value)) {
      const open = tokens[index].value;
      const close = open === '(' ? ')' : '}';
      index += 1;
      const value = parseExpression(close);
      if (value === null || !tokens[index] || tokens[index].value !== close) return null;
      index += 1;
      return value;
    }
    return aliases.has(qualified) ? aliases.get(qualified) : null;
  }

  const value = parseExpression();
  return value !== null && index === tokens.length ? value : null;
}

function disallowedTurnValues(value) {
  const findings = [];
  const pattern = /turns?:[^\s"',)\]}\\]+/gi;
  for (const match of value.matchAll(pattern)) {
    const token = match[0].replace(/[.;:]+$/g, '');
    const remainder = token.slice(token.indexOf(':') + 1);
    if (!remainder) continue;
    const authority = remainder.split(/[/?#]/, 1)[0];
    const withoutUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const host = withoutUser.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
    if (!host.endsWith('.invalid')) findings.push(token);
  }
  return findings;
}

function spliceCppLineContinuations(source) {
  // Translation phase 2 removes an immediately adjacent backslash plus an LF
  // or CRLF. Preserve string offsets so finding line attribution stays tied to
  // the original source while ordinary continued macros become logical lines.
  return source.replace(/\\(?:\r\n|\n)/g, (continuation) => ' '.repeat(continuation.length));
}

function scanCppSource(source, relativePath) {
  const logicalSource = spliceCppLineContinuations(source);
  const tokens = lexCpp(source);
  const findings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'string') continue;
    const line = tokens[index].line;
    let value = tokens[index].value;
    while (tokens[index + 1] && tokens[index + 1].type === 'string') {
      index += 1;
      value += tokens[index].value;
    }
    for (const endpoint of disallowedTurnValues(value)) {
      findings.push({ file: relativePath, line, valueSha256: sha256(endpoint) });
    }
  }

  const aliases = new Map();
  const functionMacros = new Map();
  const definitions = [];
  const functionMacro =
    /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\(([^)]*)\)[ \t]+([^\r\n]+)$/gm;
  for (const match of logicalSource.matchAll(functionMacro)) {
    const parameters = match[2]
      .split(',')
      .map((parameter) => parameter.trim())
      .filter(Boolean);
    if (parameters.some((parameter) => !/^[A-Za-z_]\w*$/.test(parameter))) continue;
    try {
      functionMacros.set(match[1], {
        parameters,
        tokens: lexCpp(match[3]),
      });
    } catch {
      // An unparseable macro replacement is outside this narrow constant-string gate.
    }
  }
  const macro = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([^\r\n]+)$/gm;
  for (const match of logicalSource.matchAll(macro)) {
    definitions.push({ name: match[1], expression: match[2], index: match.index });
  }
  const assignedDeclaration =
    /\b(?:constexpr|const)\b[^;=]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*=\s*([^;]+);/gs;
  for (const match of logicalSource.matchAll(assignedDeclaration)) {
    definitions.push({ name: match[1], expression: match[2], index: match.index });
  }
  const directListDeclaration =
    /\b(?:constexpr|const)\b[^;={]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\{([\s\S]*?)\}\s*;/g;
  for (const match of logicalSource.matchAll(directListDeclaration)) {
    definitions.push({ name: match[1], expression: match[2], index: match.index });
  }
  definitions.sort((left, right) => left.index - right.index);
  for (let pass = 0; pass <= definitions.length; pass += 1) {
    let changed = false;
    for (const definition of definitions) {
      const name = definition.name;
      if (aliases.has(name)) continue;
      let expressionTokens;
      try {
        expressionTokens = lexCpp(definition.expression);
      } catch {
        continue;
      }
      const value = evaluateConstantExpression(expressionTokens, aliases, functionMacros);
      if (value === null) continue;
      aliases.set(name, value);
      changed = true;
      const line = source.slice(0, definition.index).split('\n').length;
      for (const endpoint of disallowedTurnValues(value)) {
        findings.push({ file: relativePath, line, valueSha256: sha256(endpoint) });
      }
    }
    if (!changed) break;
  }

  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.file}:${finding.line}:${finding.valueSha256}`, finding);
  }
  return [...unique.values()];
}

function listCppFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...listCppFiles(absolute));
    } else if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.name)) {
      output.push(absolute);
    }
  }
  return output;
}

function runLiteralGate() {
  const roots = ['src', 'include', 'tests'].map((folder) => path.join(NATIVE_ROOT, folder));
  const files = roots.flatMap(listCppFiles).sort();
  const findings = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    findings.push(...scanCppSource(fs.readFileSync(file, 'utf8'), relative));
  }
  return {
    passed: findings.length === 0,
    scannedFiles: files.length,
    scope: ['native-qt/src', 'native-qt/include', 'native-qt/tests'],
    findings,
    limitation:
      'This narrow gate folds a C++ constant-string subset, including ordinary LF/CRLF backslash-spliced macro lines; it does not infer arbitrary macro metaprogramming, control flow, runtime values, schema behavior, or logging behavior.',
  };
}

function validateRegistryDocument(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    return { passed: false, reason: 'empty-body' };
  }
  let root;
  try {
    root = JSON.parse(body);
  } catch {
    return { passed: false, reason: 'invalid-json' };
  }
  if (!root || Array.isArray(root) || typeof root !== 'object') {
    return { passed: false, reason: 'root-not-object' };
  }
  if (root.version !== 1) return { passed: false, reason: 'unsupported-version' };
  if (!Array.isArray(root.servers) || root.servers.length === 0) {
    return { passed: false, reason: 'servers-not-nonempty-array' };
  }

  const canonical = [];
  let urlCount = 0;
  // The registry contract says control characters, so reject Unicode General
  // Category Cc (ASCII C0/DEL and C1 such as U+0085) in contract strings only.
  // Additive metadata remains opaque and is not constrained by this check.
  const containsControlCharacter = (value) => /\p{Cc}/u.test(value);
  for (const server of root.servers) {
    if (!server || Array.isArray(server) || typeof server !== 'object') {
      return { passed: false, reason: 'server-not-object' };
    }
    if (
      typeof server.username !== 'string' ||
      server.username.length === 0 ||
      containsControlCharacter(server.username)
    ) {
      return { passed: false, reason: 'invalid-username' };
    }
    if (
      typeof server.credential !== 'string' ||
      server.credential.length === 0 ||
      containsControlCharacter(server.credential)
    ) {
      return { passed: false, reason: 'invalid-credential' };
    }
    if (typeof server.udp !== 'boolean') return { passed: false, reason: 'invalid-udp' };
    const scalar = typeof server.urls === 'string';
    const urls = scalar ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return { passed: false, reason: 'invalid-urls' };
    }
    if (
      urls.some(
        (url) =>
          typeof url !== 'string' ||
          !/^turns?:[^\s\u0000-\u001f\u007f]+$/i.test(url) ||
          containsControlCharacter(url),
      )
    ) {
      return { passed: false, reason: 'invalid-turn-url' };
    }
    urlCount += urls.length;
    canonical.push({
      urls: scalar ? urls[0] : [...urls],
      username: server.username,
      credential: server.credential,
      udp: server.udp,
    });
  }

  const canonicalText = `game-capture-turn-registry-config-v1\n${JSON.stringify(canonical)}`;
  return {
    passed: true,
    version: 1,
    serverCount: root.servers.length,
    urlCount,
    rawResponseSha256: sha256(body),
    canonicalConfigSha256: sha256(canonicalText),
  };
}

function fetchLiveRegistry() {
  const requestTimestampUnixMs = Date.now();
  const transactionId = crypto.randomUUID();
  const requestUrl = `${SOURCE_URL}?ts=${requestTimestampUnixMs - TURN_EPOCH_OFFSET_MS}`;
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve({
        sourceUrl: requestUrl,
        transactionId,
        requestTimestampUnixMs,
        timeoutMs: LIVE_TIMEOUT_MS,
        durationMs: Date.now() - started,
        endpointHealthProbed: false,
        endpointHealthLimitation:
          'This schema/provenance fetch does not establish TURN endpoint health. Release acceptance requires the shipped Edge and Firefox workflows to probe every endpoint returned by this response.',
        ...value,
      });
    };
    const request = https.get(
      requestUrl,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'game-capture-native-gate/1' },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > LIVE_MAX_BYTES) {
            request.destroy(new Error('response exceeds 2 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            finish({ passed: false, reason: 'http-status', httpStatus: response.statusCode || 0 });
            return;
          }
          const checked = validateRegistryDocument(body);
          if (!checked.passed) {
            finish({ passed: false, reason: checked.reason, httpStatus: 200 });
            return;
          }
          finish({
            passed: true,
            httpStatus: 200,
            version: checked.version,
            serverCount: checked.serverCount,
            urlCount: checked.urlCount,
            rawResponseSha256: checked.rawResponseSha256,
            canonicalConfigSha256: checked.canonicalConfigSha256,
          });
        });
      },
    );
    request.setTimeout(LIVE_TIMEOUT_MS, () => request.destroy(new Error('request timeout')));
    request.on('error', (error) => finish({ passed: false, reason: 'transport', error: error.message }));
  });
}

function parseCtestRegistration(text, buildDir) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return { passed: false, reason: 'invalid-json', error: error.message };
  }
  if (!root || !Array.isArray(root.tests)) return { passed: false, reason: 'tests-missing' };
  if (root.tests.length !== 1 || root.tests[0].name !== 'IceConfigTest') {
    return {
      passed: false,
      reason: 'test-inventory',
      count: root.tests.length,
      names: root.tests.map((test) => test.name),
    };
  }
  const test = root.tests[0];
  const command = Array.isArray(test.command) ? test.command.map(String) : [];
  if (command.length === 0 || !path.isAbsolute(command[0])) {
    return { passed: false, reason: 'command-missing', count: 1 };
  }
  if (!artifactCandidates(buildDir).some((candidate) => pathKey(candidate) === pathKey(command[0]))) {
    return { passed: false, reason: 'command-not-candidate', count: 1, command };
  }
  let canonicalBuildDir;
  let canonicalCommand;
  try {
    canonicalBuildDir = canonicalExistingPath(buildDir);
    canonicalCommand = canonicalExistingPath(command[0]);
  } catch (error) {
    return { passed: false, reason: 'command-realpath-failed', count: 1, error: error.message };
  }
  if (!isInside(canonicalBuildDir, canonicalCommand)) {
    return { passed: false, reason: 'command-outside-build', count: 1, command };
  }
  const properties = new Map(
    (Array.isArray(test.properties) ? test.properties : []).map((property) => [
      property.name,
      property.value,
    ]),
  );
  const registeredTimeout = properties.has('TIMEOUT') ? Number(properties.get('TIMEOUT')) : null;
  if (
    registeredTimeout !== null &&
    (!Number.isFinite(registeredTimeout) || registeredTimeout <= 0 || registeredTimeout > CTEST_TIMEOUT_SECONDS)
  ) {
    return { passed: false, reason: 'unsafe-registered-timeout', count: 1, command };
  }
  const reportedWorkingDirectory =
    typeof properties.get('WORKING_DIRECTORY') === 'string'
      ? properties.get('WORKING_DIRECTORY')
      : buildDir;
  let canonicalWorkingDirectory;
  try {
    canonicalWorkingDirectory = canonicalExistingPath(reportedWorkingDirectory);
  } catch (error) {
    return { passed: false, reason: 'working-directory-realpath-failed', count: 1, error: error.message };
  }
  if (!isInside(canonicalBuildDir, canonicalWorkingDirectory)) {
    return { passed: false, reason: 'working-directory-outside-build', count: 1 };
  }
  return {
    passed: true,
    count: 1,
    names: ['IceConfigTest'],
    reportedCommand: command,
    command: [canonicalCommand, ...command.slice(1)],
    commandInsideBuildDir: true,
    canonicalBuildDir,
    canonicalCommand,
    registeredTimeoutSeconds: registeredTimeout,
    reportedWorkingDirectory,
    workingDirectory: canonicalWorkingDirectory,
    environment: properties.get('ENVIRONMENT') || [],
    environmentModification: properties.get('ENVIRONMENT_MODIFICATION') || [],
  };
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value !== '') return value.split(';');
  return [];
}

function registeredEnvironment(registration, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  for (const assignment of asList(registration.environment)) {
    const equals = assignment.indexOf('=');
    if (equals > 0) environment[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  for (const modification of asList(registration.environmentModification)) {
    const match = modification.match(/^([^=]+)=([^:]+):(.*)$/);
    if (!match) continue;
    const [, name, operation, value] = match;
    const current = environment[name] || '';
    if (operation === 'set') environment[name] = value;
    if (operation === 'unset') delete environment[name];
    if (operation === 'path_list_prepend') {
      environment[name] = current ? `${value}${path.delimiter}${current}` : value;
    }
    if (operation === 'path_list_append') {
      environment[name] = current ? `${current}${path.delimiter}${value}` : value;
    }
  }
  return environment;
}

function parseFunctions(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^([A-Za-z_]\w*)\(\)$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseQtTotals(output) {
  const matches = [...output.matchAll(/Totals:\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) skipped/gi)];
  if (matches.length !== 1) return null;
  return {
    passed: Number(matches[0][1]),
    failed: Number(matches[0][2]),
    skipped: Number(matches[0][3]),
  };
}

function validFakeResult(buildDir) {
  const candidates = artifactCandidates(buildDir);
  const artifactPath = path.join(
    buildDir,
    'bin',
    process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
  );
  const pre = candidates.map((candidate) => ({
    path: candidate,
    exists: false,
    size: 0,
    mtimeMs: 0,
    sha256: null,
  }));
  const post = candidates.map(fileIdentity);
  const identity = fileIdentity(artifactPath);
  const canonicalBuildDir = canonicalExistingPath(buildDir);
  const canonicalArtifact = canonicalExistingPath(artifactPath);
  const trustedCmake = discoverTrustedCmake();
  const canonicalCmake = trustedCmake.path;
  const fakeQtDir = path.join(buildDir, 'fake-qt', 'share', 'Qt6');
  const fakeRequestTimestamp = TURN_EPOCH_OFFSET_MS + 123456789;
  return {
    terminalVersion: TERMINAL_VERSION,
    gate: GATE_NAME,
    status: 'GREEN',
    stage: 'complete',
    buildDir,
    sourceManifest: {
      entries: [{ path: 'native-qt/tests/test_ice_config.cpp', size: 1, sha256: 'b'.repeat(64) }],
      sha256: 'c'.repeat(64),
    },
    toolchainEnvironment: {
      source: path.join(buildDir, 'VsDevCmd.bat'),
      sourceSha256: 'd'.repeat(64),
      targetArchitecture: 'x64',
      includeEntryCount: 1,
      pathEntryCount: 1,
    },
    qtEnvironment: {
      source: 'self-control',
      qt6Dir: fakeQtDir,
      canonicalQt6Dir: fakeQtDir,
      qt6ConfigPath: path.join(fakeQtDir, 'Qt6Config.cmake'),
      qt6ConfigSha256: 'e'.repeat(64),
      prefixPath: path.join(buildDir, 'fake-qt'),
      runtimeBin: path.join(buildDir, 'fake-qt', 'bin'),
      runtimeBinExists: true,
    },
    cmakeGenerator: {
      sourceCache: path.join(buildDir, 'reference-CMakeCache.txt'),
      generator: 'Ninja',
      buildType: 'Release',
      makeProgram: path.join(buildDir, 'ninja.exe'),
      canonicalMakeProgram: path.join(buildDir, 'ninja.exe'),
      makeProgramSha256: 'f'.repeat(64),
    },
    cmakeExecutable: cmakeExecutableEvidence(trustedCmake),
    freshConfigure: {
      required: true,
      buildDirExistedBefore: false,
      cacheExistedBefore: false,
      configureInvocationCount: 1,
      configuredFromScratch: true,
    },
    configure: {
      attempted: true,
      exitCode: 0,
      timeoutMs: CONFIGURE_TIMEOUT_MS,
      invocationCount: 1,
      command: [
        canonicalCmake,
        '-S',
        NATIVE_ROOT,
        '-B',
        buildDir,
        '-DVERSUS_BUILD_TESTS=ON',
        `-DQt6_DIR=${fakeQtDir}`,
        '-G',
        'Ninja',
        `-DCMAKE_MAKE_PROGRAM=${path.join(buildDir, 'ninja.exe')}`,
        '-DCMAKE_BUILD_TYPE=Release',
      ],
    },
    build: {
      attempted: true,
      exitCode: 0,
      timeoutMs: BUILD_TIMEOUT_MS,
      invocationCount: 1,
      command: [canonicalCmake, '--build', canonicalBuildDir, '--target', 'test_ice_config'],
    },
    registration: {
      invoked: true,
      passed: true,
      count: 1,
      names: ['IceConfigTest'],
      reportedCommand: [artifactPath],
      command: [canonicalArtifact],
      commandInsideBuildDir: true,
      canonicalBuildDir,
      canonicalCommand: canonicalArtifact,
    },
    functions: {
      invoked: true,
      passed: true,
      names: [...EXPECTED_FUNCTIONS],
      commandResult: {
        command: [canonicalArtifact, '-functions'],
        attempted: true,
        exitCode: 0,
        timedOut: false,
      },
    },
    runtime: {
      invoked: true,
      passed: true,
      timeoutSeconds: CTEST_TIMEOUT_SECONDS,
      ctestTestsPassed: 1,
      ctestTestsFailed: 0,
      totals: { passed: EXPECTED_QT_PASSES, failed: 0, skipped: 0 },
    },
    liveRegistry: {
      sourceUrl: `${SOURCE_URL}?ts=${fakeRequestTimestamp - TURN_EPOCH_OFFSET_MS}`,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      requestTimestampUnixMs: fakeRequestTimestamp,
      timeoutMs: LIVE_TIMEOUT_MS,
      durationMs: 1,
      endpointHealthProbed: false,
      endpointHealthLimitation:
        'This schema/provenance fetch does not establish TURN endpoint health.',
      passed: true,
      httpStatus: 200,
      version: 1,
      serverCount: 2,
      urlCount: 3,
      rawResponseSha256: '1'.repeat(64),
      canonicalConfigSha256: '2'.repeat(64),
    },
    literalGate: { passed: true },
    artifact: { candidates, pre, post, selected: identity, executed: true },
    flags: { artifactExecuted: true, functionsInvoked: true, ctestInvoked: true },
  };
}

function liveRegistryEvidenceReason(liveRegistry) {
  if (!liveRegistry || liveRegistry.passed !== true) return 'not-passed';
  if (liveRegistry.endpointHealthProbed !== false) return 'endpoint-health-scope';
  if (
    !Number.isSafeInteger(liveRegistry.requestTimestampUnixMs) ||
    liveRegistry.requestTimestampUnixMs <= TURN_EPOCH_OFFSET_MS
  ) {
    return 'request-timestamp';
  }
  const expectedUrl = `${SOURCE_URL}?ts=${
    liveRegistry.requestTimestampUnixMs - TURN_EPOCH_OFFSET_MS
  }`;
  if (liveRegistry.sourceUrl !== expectedUrl) return 'source-url';
  if (
    typeof liveRegistry.transactionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      liveRegistry.transactionId,
    )
  ) {
    return 'transaction-id';
  }
  if (liveRegistry.timeoutMs !== LIVE_TIMEOUT_MS) return 'timeout';
  if (!Number.isFinite(liveRegistry.durationMs) || liveRegistry.durationMs < 0) return 'duration';
  if (liveRegistry.httpStatus !== 200 || liveRegistry.version !== 1) return 'http-schema';
  if (
    !Number.isSafeInteger(liveRegistry.serverCount) ||
    liveRegistry.serverCount <= 0 ||
    !Number.isSafeInteger(liveRegistry.urlCount) ||
    liveRegistry.urlCount < liveRegistry.serverCount
  ) {
    return 'counts';
  }
  if (
    !/^[0-9a-f]{64}$/.test(liveRegistry.rawResponseSha256 || '') ||
    !/^[0-9a-f]{64}$/.test(liveRegistry.canonicalConfigSha256 || '')
  ) {
    return 'fingerprints';
  }
  if (
    typeof liveRegistry.endpointHealthLimitation !== 'string' ||
    !liveRegistry.endpointHealthLimitation.includes('does not establish TURN endpoint health')
  ) {
    return 'scope-limitation';
  }
  return null;
}

function buildProvenanceValid(result) {
  const fresh = result.freshConfigure;
  const freshShapeValid =
    typeof fresh?.required === 'boolean' &&
    typeof fresh.buildDirExistedBefore === 'boolean' &&
    typeof fresh.cacheExistedBefore === 'boolean' &&
    fresh.configureInvocationCount === 1 &&
    typeof fresh.configuredFromScratch === 'boolean';
  const requiredFreshValid =
    fresh?.required !== true ||
    (fresh.buildDirExistedBefore === false &&
      fresh.cacheExistedBefore === false &&
      fresh.configuredFromScratch === true);
  return (
    typeof result.toolchainEnvironment?.source === 'string' &&
    /^[0-9a-f]{64}$/.test(result.toolchainEnvironment.sourceSha256 || '') &&
    String(result.toolchainEnvironment.targetArchitecture).toLowerCase() === 'x64' &&
    result.toolchainEnvironment.includeEntryCount > 0 &&
    result.toolchainEnvironment.pathEntryCount > 0 &&
    typeof result.qtEnvironment?.source === 'string' &&
    typeof result.qtEnvironment.canonicalQt6Dir === 'string' &&
    typeof result.qtEnvironment.qt6ConfigPath === 'string' &&
    /^[0-9a-f]{64}$/.test(result.qtEnvironment.qt6ConfigSha256 || '') &&
    result.cmakeGenerator?.generator === 'Ninja' &&
    result.cmakeGenerator.buildType === 'Release' &&
    typeof result.cmakeGenerator.canonicalMakeProgram === 'string' &&
    /^[0-9a-f]{64}$/.test(result.cmakeGenerator.makeProgramSha256 || '') &&
    freshShapeValid &&
    requiredFreshValid &&
    result.configure?.attempted === true &&
    result.configure.timeoutMs === CONFIGURE_TIMEOUT_MS &&
    result.configure.timeoutMs > 120000 &&
    result.configure.timeoutMs <= 300000 &&
    result.configure.invocationCount === 1 &&
    Array.isArray(result.configure.command) &&
    result.configure.command.filter((part) => part === '-DVERSUS_BUILD_TESTS=ON').length === 1 &&
    result.configure.command.filter((part) => String(part).startsWith('-DQt6_DIR=')).length === 1 &&
    result.configure.command.filter((part) => part === '-G').length === 1 &&
    result.configure.command.filter((part) => part === 'Ninja').length === 1 &&
    result.configure.command.filter((part) =>
      String(part).startsWith('-DCMAKE_MAKE_PROGRAM='),
    ).length === 1 &&
    result.configure.command.filter((part) => part === '-DCMAKE_BUILD_TYPE=Release').length === 1 &&
    result.build?.timeoutMs === BUILD_TIMEOUT_MS &&
    result.build.invocationCount === 1
  );
}

function buildCommandEvidenceReason(result, buildDir) {
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
    return 'build-command-shape';
  }
  if (
    !Array.isArray(configureCommand) ||
    typeof configureCommand[0] !== 'string' ||
    !path.isAbsolute(configureCommand[0])
  ) {
    return 'configure-command-shape';
  }
  let canonicalExpectedBuild;
  let canonicalCommandBuild;
  let canonicalBuildExecutable;
  let canonicalConfigureExecutable;
  try {
    canonicalExpectedBuild = canonicalExistingPath(buildDir);
    canonicalCommandBuild = canonicalExistingPath(command[2]);
    canonicalBuildExecutable = canonicalExistingPath(command[0]);
    canonicalConfigureExecutable = canonicalExistingPath(configureCommand[0]);
  } catch {
    return 'build-command-realpath';
  }
  if (pathKey(canonicalCommandBuild) !== pathKey(canonicalExpectedBuild)) {
    return 'build-command-directory';
  }
  const cmakeNames = new Set(['cmake', 'cmake.exe']);
  if (
    !cmakeNames.has(path.basename(canonicalBuildExecutable).toLowerCase()) ||
    !cmakeNames.has(path.basename(canonicalConfigureExecutable).toLowerCase())
  ) {
    return 'build-command-not-cmake';
  }
  if (pathKey(canonicalBuildExecutable) !== pathKey(canonicalConfigureExecutable)) {
    return 'build-configure-executable-mismatch';
  }
  let trustedCmake;
  let currentBuildExecutable;
  let currentConfigureExecutable;
  try {
    trustedCmake = discoverTrustedCmake();
    currentBuildExecutable = canonicalFileIdentity(canonicalBuildExecutable);
    currentConfigureExecutable = canonicalFileIdentity(canonicalConfigureExecutable);
  } catch {
    return 'cmake-discovery';
  }
  if (pathKey(canonicalBuildExecutable) !== pathKey(trustedCmake.path)) {
    return 'build-command-counterfeit-cmake';
  }
  if (
    !identityEqual(currentBuildExecutable, trustedCmake.identity) ||
    !identityEqual(currentConfigureExecutable, trustedCmake.identity)
  ) {
    return 'build-command-cmake-identity';
  }
  const executableEvidenceReason = cmakeExecutableEvidenceReason(
    result.cmakeExecutable,
    trustedCmake,
  );
  if (executableEvidenceReason) return executableEvidenceReason;
  const configurePathReason = (flag, expectedDirectory) => {
    const exactIndices = [];
    let attachedCount = 0;
    for (let index = 1; index < configureCommand.length; index += 1) {
      const part = configureCommand[index];
      if (part === flag) exactIndices.push(index);
      else if (typeof part === 'string' && part.startsWith(flag) && part.length > flag.length) {
        attachedCount += 1;
      }
    }
    if (exactIndices.length !== 1 || attachedCount !== 0) return 'argument-form';
    const value = configureCommand[exactIndices[0] + 1];
    if (typeof value !== 'string' || !path.isAbsolute(value)) return 'argument-value';
    let canonicalValue;
    let canonicalExpected;
    try {
      canonicalValue = canonicalExistingPath(value);
      canonicalExpected = canonicalExistingPath(expectedDirectory);
    } catch {
      return 'argument-realpath';
    }
    return pathKey(canonicalValue) === pathKey(canonicalExpected)
      ? null
      : 'argument-directory';
  };
  const configureBuildReason = configurePathReason('-B', buildDir);
  if (configureBuildReason) return `configure-build-${configureBuildReason}`;
  const configureSourceReason = configurePathReason('-S', NATIVE_ROOT);
  if (configureSourceReason) return `configure-source-${configureSourceReason}`;
  return null;
}

function artifactEvidenceReason(result, buildDir, requireSelected) {
  const expectedCandidates = artifactCandidates(buildDir);
  if (
    !Array.isArray(result.artifact?.candidates) ||
    result.artifact.candidates.length !== expectedCandidates.length ||
    !result.artifact.candidates.every(
      (candidate, index) => pathKey(candidate) === pathKey(expectedCandidates[index]),
    ) ||
    !identityListMatchesCandidates(result.artifact.pre, buildDir) ||
    !identityListMatchesCandidates(result.artifact.post, buildDir)
  ) {
    return 'artifact-candidate-identities';
  }
  if (result.freshConfigure?.required && result.artifact.pre.some((identity) => identity.exists)) {
    return 'artifact-fresh-preexisting';
  }
  if (!requireSelected) {
    if (result.artifact.selected !== null) return 'artifact-unexpected-selection';
    return null;
  }
  if (!identityShapeValid(result.artifact.selected) || !result.artifact.selected.exists) {
    return 'artifact-selected-shape';
  }
  const selectedIndex = expectedCandidates.findIndex(
    (candidate) => pathKey(candidate) === pathKey(result.artifact.selected.path),
  );
  if (selectedIndex < 0 || !identityEqual(result.artifact.selected, result.artifact.post[selectedIndex])) {
    return 'artifact-selected-mismatch';
  }
  const current = fileIdentity(result.artifact.selected.path);
  if (!identityEqual(result.artifact.selected, current)) return 'artifact-selected-not-current';
  let canonicalBuild;
  let canonicalSelected;
  try {
    canonicalBuild = canonicalExistingPath(buildDir);
    canonicalSelected = canonicalExistingPath(result.artifact.selected.path);
  } catch {
    return 'artifact-selected-realpath';
  }
  if (!isInside(canonicalBuild, canonicalSelected)) return 'artifact-selected-outside-build';
  return null;
}

function selectedCommandEvidenceReason(result, buildDir) {
  if (!result.registration?.passed) return 'registration-not-passed';
  if (!result.artifact?.selected?.exists) return 'selected-artifact-missing';
  let canonicalBuild;
  let canonicalSelected;
  try {
    canonicalBuild = canonicalExistingPath(buildDir);
    canonicalSelected = canonicalExistingPath(result.artifact.selected.path);
  } catch {
    return 'selected-realpath';
  }
  if (!isInside(canonicalBuild, canonicalSelected)) return 'selected-outside-build';
  if (
    result.registration.commandInsideBuildDir !== true ||
    pathKey(result.registration.canonicalBuildDir || '') !== pathKey(canonicalBuild) ||
    pathKey(result.registration.canonicalCommand || '') !== pathKey(canonicalSelected)
  ) {
    return 'registration-canonical-fields';
  }
  const registeredPaths = [
    result.registration.command?.[0],
    result.registration.reportedCommand?.[0],
  ];
  const executedPath = result.functions?.commandResult?.command?.[0];
  if (result.functions?.invoked) registeredPaths.push(executedPath);
  if (registeredPaths.some((value) => typeof value !== 'string' || value.length === 0)) {
    return 'command-path-missing';
  }
  for (const commandPath of registeredPaths) {
    let canonicalCommand;
    try {
      canonicalCommand = canonicalExistingPath(commandPath);
    } catch {
      return 'command-realpath';
    }
    if (
      !isInside(canonicalBuild, canonicalCommand) ||
      pathKey(canonicalCommand) !== pathKey(canonicalSelected)
    ) {
      return 'command-outside-selected-build';
    }
  }
  return null;
}

function validateChildOutcome(child, expectedBuildDir) {
  if (child.timedOut) return { ok: false, reason: 'child-timeout' };
  const terminals = String(child.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(TERMINAL_PREFIX));
  if (terminals.length !== 1) return { ok: false, reason: 'terminal-count' };
  let result;
  try {
    result = JSON.parse(terminals[0].slice(TERMINAL_PREFIX.length));
  } catch {
    return { ok: false, reason: 'terminal-json' };
  }
  if (
    !result ||
    result.terminalVersion !== TERMINAL_VERSION ||
    result.gate !== GATE_NAME ||
    !['GREEN', 'RED', 'HARNESS_ERROR'].includes(result.status)
  ) {
    return { ok: false, reason: 'terminal-schema' };
  }
  const expectedExit = result.status === 'GREEN' ? 0 : result.status === 'RED' ? 1 : 2;
  if (child.exitCode !== expectedExit) return { ok: false, reason: 'status-exit' };
  if (
    !result.sourceManifest ||
    !Array.isArray(result.sourceManifest.entries) ||
    result.sourceManifest.entries.length === 0 ||
    !/^[0-9a-f]{64}$/.test(result.sourceManifest.sha256 || '')
  ) {
    return { ok: false, reason: 'source-manifest' };
  }
  if (pathKey(result.buildDir || '') !== pathKey(expectedBuildDir)) {
    return { ok: false, reason: 'build-directory' };
  }

  if (result.status !== 'HARNESS_ERROR' && !buildProvenanceValid(result)) {
    return {
      ok: false,
      reason: result.status === 'GREEN' ? 'green-build-provenance' : 'red-build-provenance',
    };
  }
  if (result.status === 'GREEN' || result.status === 'RED') {
    const buildCommandReason = buildCommandEvidenceReason(result, expectedBuildDir);
    if (buildCommandReason) {
      return {
        ok: false,
        reason:
          result.status === 'GREEN'
            ? 'green-build-command-evidence'
            : 'red-build-command-evidence',
        detail: buildCommandReason,
      };
    }
  }
  if (result.status === 'GREEN' || result.status === 'RED') {
    const liveReason = liveRegistryEvidenceReason(result.liveRegistry);
    if (liveReason) {
      return {
        ok: false,
        reason:
          result.status === 'GREEN'
            ? 'green-live-registry-evidence'
            : 'red-live-registry-evidence',
        detail: liveReason,
      };
    }
  }
  const derived = selectFailureStage(result);
  if (
    result.status === 'GREEN' &&
    result.stage !== 'complete'
  ) {
    return { ok: false, reason: 'green-stage-coherence' };
  }
  if (result.status === 'RED' && (derived[0] !== 'RED' || derived[1] !== result.stage)) {
    return { ok: false, reason: 'red-stage-coherence' };
  }
  if (result.status === 'HARNESS_ERROR') {
    const configureFailure =
      result.stage === 'configure' && derived[0] === 'HARNESS_ERROR' && derived[1] === 'configure';
    const expectationFailure =
      result.stage === 'current-red-expectation' &&
      result.currentRedExpectation?.passed === false;
    const terminalFailure =
      result.stage === 'terminal-validation' && typeof result.terminalValidationError === 'string';
    if (!configureFailure && !expectationFailure && !terminalFailure) {
      return { ok: false, reason: 'harness-stage-coherence' };
    }
  }

  const flagsCoherent =
    result.artifact?.executed === result.flags?.artifactExecuted &&
    result.functions?.invoked === result.flags?.functionsInvoked &&
    result.flags?.ctestInvoked === Boolean(result.registration?.invoked || result.runtime?.invoked) &&
    (!result.runtime?.invoked || result.functions?.passed === true) &&
    (!result.functions?.invoked || result.artifact?.executed === true);
  if (!flagsCoherent) return { ok: false, reason: 'execution-flag-coherence' };

  if (result.status === 'GREEN') {
    if (!result.configure?.attempted || result.configure.exitCode !== 0) {
      return { ok: false, reason: 'green-configure' };
    }
    if (!result.build?.attempted || result.build.exitCode !== 0) {
      return { ok: false, reason: 'green-build' };
    }
    if (
      !result.registration?.invoked ||
      !result.registration.passed ||
      result.registration.count !== 1 ||
      !arraysEqual(result.registration.names || [], ['IceConfigTest']) ||
      !Array.isArray(result.registration.command) ||
      !result.registration.command[0] ||
      !isInside(expectedBuildDir, result.registration.command[0]) ||
      !result.registration.commandInsideBuildDir ||
      pathKey(result.registration.command[0]) !== pathKey(result.artifact?.selected?.path || '')
    ) {
      return { ok: false, reason: 'green-registration' };
    }
    if (
      !result.functions?.invoked ||
      !result.functions.passed ||
      !arraysEqual(result.functions.names || [], EXPECTED_FUNCTIONS)
    ) {
      return { ok: false, reason: 'green-functions' };
    }
    if (
      !result.runtime?.invoked ||
      !result.runtime.passed ||
      result.runtime.timeoutSeconds !== CTEST_TIMEOUT_SECONDS ||
      result.runtime.ctestTestsPassed !== 1 ||
      result.runtime.ctestTestsFailed !== 0 ||
      result.runtime.totals?.passed !== EXPECTED_QT_PASSES ||
      result.runtime.totals?.failed !== 0 ||
      result.runtime.totals?.skipped !== 0
    ) {
      return { ok: false, reason: 'green-runtime' };
    }
    if (!result.liveRegistry?.passed) return { ok: false, reason: 'green-live-registry' };
    if (!result.literalGate?.passed) return { ok: false, reason: 'green-literal-gate' };
    const commandReason = selectedCommandEvidenceReason(result, expectedBuildDir);
    if (commandReason) {
      return { ok: false, reason: 'green-command-evidence', detail: commandReason };
    }
    const artifactReason = artifactEvidenceReason(result, expectedBuildDir, true);
    if (
      !result.flags?.artifactExecuted ||
      !result.flags.functionsInvoked ||
      !result.flags.ctestInvoked ||
      !result.artifact?.executed ||
      artifactReason
    ) {
      return { ok: false, reason: artifactReason ? 'green-artifact-identity' : 'green-artifact' };
    }
  }

  if (result.status === 'RED' && result.stage === 'build') {
    if (!result.build?.attempted || result.build.exitCode === 0 || result.build.exitCode === null) {
      return { ok: false, reason: 'red-build-status' };
    }
    if (
      result.flags?.artifactExecuted ||
      result.flags?.functionsInvoked ||
      result.flags?.ctestInvoked ||
      result.artifact?.executed ||
      result.registration?.invoked ||
      result.functions?.invoked ||
      result.runtime?.invoked
    ) {
      return { ok: false, reason: 'red-build-execution' };
    }
    if (
      Array.isArray(result.artifact?.post) &&
      result.artifact.post.some((identity) => identity?.exists === true)
    ) {
      return { ok: false, reason: 'red-build-post-artifact' };
    }
    if (artifactEvidenceReason(result, expectedBuildDir, false)) {
      return { ok: false, reason: 'red-build-artifact-identity' };
    }
  }
  if (result.status === 'RED' && result.stage !== 'build') {
    if (result.registration?.passed) {
      const commandReason = selectedCommandEvidenceReason(result, expectedBuildDir);
      if (commandReason) {
        return { ok: false, reason: 'red-command-evidence', detail: commandReason };
      }
    }
    if (artifactEvidenceReason(result, expectedBuildDir, result.flags.artifactExecuted)) {
      return { ok: false, reason: 'red-artifact-identity' };
    }
  }
  return { ok: true, reason: 'accepted', result };
}

function emitFakeChild(name, buildDir) {
  if (name === 'missing-terminal') {
    process.stdout.write('fake child omitted its terminal\n');
    process.exit(0);
  }
  if (name === 'malformed-json') {
    process.stdout.write(`${TERMINAL_PREFIX}{not-json\n`);
    process.exit(2);
  }
  if (name === 'stall-timeout') {
    setInterval(() => {}, 1000);
    return;
  }
  let result = validFakeResult(buildDir);
  let exitCode = 0;
  if (name === 'duplicate-terminal') {
    const line = `${TERMINAL_PREFIX}${JSON.stringify(result)}\n`;
    process.stdout.write(line + line);
    process.exit(0);
  }
  if (name === 'green-build-failure') result.build.exitCode = 1;
  if (name === 'green-missing-function') {
    result.functions.names = result.functions.names.slice(0, -1);
  }
  if (name === 'green-wrong-totals') {
    result.runtime.totals.passed = EXPECTED_QT_PASSES - 1;
  }
  if (name === 'green-nonzero-exit') exitCode = 1;
  if (name === 'red-zero-exit') {
    result.status = 'RED';
    result.stage = 'literal-gate';
    result.literalGate.passed = false;
  }
  if (name === 'ctest-outside-build-dir') {
    result.registration.command = [path.resolve(buildDir, '..', 'stale', 'test_ice_config.exe')];
    result.registration.commandInsideBuildDir = false;
  }
  if (name === 'stale-execution-after-build-failure') {
    result.status = 'RED';
    result.stage = 'build';
    result.build.exitCode = 1;
    exitCode = 1;
  }
  if (name === 'red-literal-contradiction') {
    result.status = 'RED';
    result.stage = 'literal-gate';
    exitCode = 1;
  }
  if (name === 'harness-complete-all-green') {
    result.status = 'HARNESS_ERROR';
    result.stage = 'complete';
    exitCode = 2;
  }
  if (name === 'green-unrelated-artifact-identities') {
    const unrelated = {
      path: path.resolve(buildDir, '..', 'unrelated', 'test_ice_config.exe'),
      exists: false,
      size: 0,
      mtimeMs: 0,
      sha256: null,
    };
    result.artifact.pre = [unrelated];
    result.artifact.post = [unrelated];
  }
  if (name === 'green-missing-build-provenance') {
    delete result.toolchainEnvironment;
    delete result.qtEnvironment;
    delete result.freshConfigure;
    delete result.cmakeGenerator;
    delete result.configure.timeoutMs;
    delete result.configure.invocationCount;
  }
  process.stdout.write(`${TERMINAL_PREFIX}${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function runRound2AdversarialControls(buildDir) {
  const failures = [];
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const requiredCandidates = [
    path.join(buildDir, `test_ice_config${suffix}`),
    path.join(buildDir, 'bin', `test_ice_config${suffix}`),
    path.join(buildDir, 'bin', 'Release', `test_ice_config${suffix}`),
  ].map(pathKey);
  const observedCandidates = new Set(artifactCandidates(buildDir).map(pathKey));
  if (requiredCandidates.some((candidate) => !observedCandidates.has(candidate))) {
    failures.push('artifact-candidate-layouts');
  }

  const childCases = [
    ['red-literal-contradiction', 'red-stage-coherence'],
    ['harness-complete-all-green', 'harness-stage-coherence'],
    ['green-unrelated-artifact-identities', 'green-artifact-identity'],
    ['green-missing-build-provenance', 'green-build-provenance'],
  ];
  const terminalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round2-terminal-'));
  const terminalBuildDir = path.join(terminalRoot, 'build');
  const terminalArtifact = path.join(
    terminalBuildDir,
    'bin',
    process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
  );
  try {
    fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
    fs.writeFileSync(terminalArtifact, 'round2-terminal-control');
    for (const [name, expectedReason] of childCases) {
      const child = spawnSync(
        process.execPath,
        [__filename, `--internal-fake-child=${name}`, `--build-dir=${terminalBuildDir}`],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      );
      const verdict = validateChildOutcome(
        {
          stdout: child.stdout,
          exitCode: Number.isInteger(child.status) ? child.status : null,
          timedOut: Boolean(child.error && child.error.code === 'ETIMEDOUT'),
        },
        terminalBuildDir,
      );
      if (verdict.ok || verdict.reason !== expectedReason) {
        failures.push(
          `${name}:expected=${expectedReason}:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
        );
      }
    }
  } finally {
    if (!path.basename(terminalRoot).startsWith('game-capture-round2-terminal-')) {
      throw new Error('Round 2 terminal-control path safety check failed');
    }
    fs.rmSync(terminalRoot, { recursive: true, force: true });
  }

  const literalControls = [
    [
      'direct-list-fragments',
      'const std::string endpoint{"turn:" + std::string{"relay.example:3478"}};',
      1,
    ],
    [
      'standard-string-s-composition',
      'using namespace std::string_literals; const auto endpoint = "turn:"s + "relay.example:3478"s;',
      1,
    ],
    [
      'macro-fragment-composition',
      '#define TURN_SCHEME "turn:"\n#define TURN_HOST "relay.example:3478"\nconst auto endpoint = std::string{TURN_SCHEME} + TURN_HOST;',
      1,
    ],
    [
      'reserved-invalid-fqdn',
      'constexpr auto endpoint = "turn:fixture.invalid.:3478";',
      0,
    ],
  ];
  for (const [name, source, expected] of literalControls) {
    const observed = scanCppSource(source, `${name}.cpp`).length;
    if (observed !== expected) failures.push(`${name}:expected=${expected}:observed=${observed}`);
  }

  const invalidRegistryDocuments = [
    [
      'empty-turn-address',
      JSON.stringify({
        version: 1,
        servers: [{ urls: 'turn:', username: 'u', credential: 'c', udp: true }],
      }),
    ],
    [
      'url-control-character',
      JSON.stringify({
        version: 1,
        servers: [
          { urls: 'turn:control.invalid:3478\u0000suffix', username: 'u', credential: 'c', udp: true },
        ],
      }),
    ],
    [
      'credential-control-character',
      JSON.stringify({
        version: 1,
        servers: [
          { urls: 'turn:control.invalid:3478', username: 'u', credential: 'c\u0007', udp: true },
        ],
      }),
    ],
  ];
  for (const [name, body] of invalidRegistryDocuments) {
    if (validateRegistryDocument(body).passed) failures.push(`${name}:accepted`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-ctest-path-'));
  try {
    const selectedBuild = path.join(temporaryRoot, 'build');
    const outside = path.join(temporaryRoot, 'outside');
    const link = path.join(selectedBuild, 'bin');
    fs.mkdirSync(selectedBuild, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const outsideExecutable = path.join(outside, `test_ice_config${suffix}`);
    fs.writeFileSync(outsideExecutable, 'self-control');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const registration = JSON.stringify({
      tests: [{ name: 'IceConfigTest', command: [path.join(link, `test_ice_config${suffix}`)] }],
    });
    if (parseCtestRegistration(registration, selectedBuild).passed) {
      failures.push('ctest-canonical-path-escape:accepted');
    }
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-ctest-path-')) {
      throw new Error('temporary self-control path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runRound3AdversarialControls(buildDir, suppliedToolchainEnvironment = null) {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND3 CONTROL PASS] ${name}\n`);
  const observe = (name, accepted, expectedReason, observedReason) => {
    if (!accepted && observedReason === expectedReason) {
      pass(`${name}: ${observedReason}`);
      return;
    }
    failures.push(
      `${name}:expected=${expectedReason}:observed=${accepted ? 'accepted' : observedReason}`,
    );
  };

  const toolchainEnvironment =
    suppliedToolchainEnvironment || loadToolchainEnvironment(buildDir).env;
  const compilerName = process.platform === 'win32' ? 'cl.exe' : 'c++';
  const compiler = environmentValue(toolchainEnvironment, 'PATH')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => path.join(entry, compilerName))
    .find((candidate) => fs.existsSync(candidate));
  if (!compiler) {
    failures.push(`macro-compiler:not-found:${compilerName}`);
    return failures;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round3-'));
  try {
    const macroControls = [
      {
        name: 'object-like-adjacent-macro',
        source: [
          '#include <string_view>',
          '#define TURN_HOST "relay.example:3478"',
          'constexpr auto endpoint = "turn:" TURN_HOST;',
          'static_assert(std::string_view{endpoint}.starts_with("turn:"));',
          'static_assert(std::string_view{endpoint}.substr(5) == "relay.example:3478");',
        ].join('\n'),
      },
      {
        name: 'function-like-macro',
        source: [
          '#include <string_view>',
          '#define TURN_ENDPOINT(host) "turn:" host',
          'constexpr auto endpoint = TURN_ENDPOINT("relay.example:3478");',
          'static_assert(std::string_view{endpoint}.starts_with("turn:"));',
          'static_assert(std::string_view{endpoint}.substr(5) == "relay.example:3478");',
        ].join('\n'),
      },
    ];
    for (const control of macroControls) {
      const sourcePath = path.join(temporaryRoot, `${control.name}.cpp`);
      fs.writeFileSync(sourcePath, `${control.source}\n`);
      const compilerArguments =
        process.platform === 'win32'
          ? ['/nologo', '/std:c++20', '/Zs', sourcePath]
          : ['-std=c++20', '-fsyntax-only', sourcePath];
      const compiled = runCommand(compiler, compilerArguments, {
        cwd: temporaryRoot,
        env: toolchainEnvironment,
        timeoutMs: 30000,
      });
      if (
        compiled.exitCode !== 0 ||
        compiled.timedOut ||
        compiled.spawnError
      ) {
        failures.push(
          `${control.name}:compile-exit=${String(compiled.exitCode)}:timeout=${compiled.timedOut}:spawn=${compiled.spawnError || 'none'}`,
        );
        continue;
      }
      const findings = scanCppSource(control.source, `${control.name}.cpp`);
      if (findings.length !== 1) {
        failures.push(`${control.name}:expected=1:observed=${findings.length}`);
        continue;
      }
      pass(`${control.name}: compiled-and-rejected`);
    }

    for (const [name, source] of [
      ['reserved-invalid-host', 'constexpr auto endpoint = "turn:fixture.invalid:3478";'],
      ['reserved-invalid-fqdn', 'constexpr auto endpoint = "turn:fixture.invalid.:3478";'],
    ]) {
      const observed = scanCppSource(source, `${name}.cpp`).length;
      if (observed !== 0) failures.push(`${name}:expected=0:observed=${observed}`);
      else pass(`${name}: accepted`);
    }
    const testFixtureFindings = runLiteralGate().findings.filter((finding) =>
      finding.file.startsWith('native-qt/tests/'),
    );
    if (testFixtureFindings.length > 0) {
      failures.push(`native-test-fixtures:unexpected-findings=${testFixtureFindings.length}`);
    } else {
      pass('native-test-fixtures: accepted');
    }

    const terminalBuildDir = path.join(temporaryRoot, 'build');
    const terminalArtifact = path.join(
      terminalBuildDir,
      'bin',
      process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
    );
    fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
    fs.writeFileSync(terminalArtifact, 'round3-terminal-control');
    const verdictFor = (result, exitCode) =>
      validateChildOutcome(
        {
          stdout: `${TERMINAL_PREFIX}${JSON.stringify(result)}\n`,
          exitCode,
          timedOut: false,
        },
        terminalBuildDir,
      );
    const acceptedBaseline = verdictFor(validFakeResult(terminalBuildDir), 0);
    if (!acceptedBaseline.ok) {
      failures.push(`valid-terminal-baseline:rejected=${acceptedBaseline.reason}`);
    } else {
      pass('valid-terminal-baseline: accepted');
    }

    const legacyGreen = validFakeResult(terminalBuildDir);
    legacyGreen.liveRegistry = {
      passed: true,
      httpStatus: 200,
      version: 1,
      serverCount: 2,
      urlCount: 3,
      rawResponseSha256: '1'.repeat(64),
      canonicalConfigSha256: '2'.repeat(64),
      endpointHealthProbed: false,
    };
    let verdict = verdictFor(legacyGreen, 0);
    observe(
      'green-incomplete-live-evidence',
      verdict.ok,
      'green-live-registry-evidence',
      verdict.reason,
    );

    const greenLiveMutations = [
      ['live-source-url', (live) => { live.sourceUrl = SOURCE_URL; }],
      ['live-request-timestamp', (live) => { live.requestTimestampUnixMs = TURN_EPOCH_OFFSET_MS; }],
      ['live-transaction-id', (live) => { live.transactionId = 'not-a-uuid'; }],
      ['live-timeout', (live) => { live.timeoutMs = LIVE_TIMEOUT_MS - 1; }],
      ['live-duration', (live) => { live.durationMs = -1; }],
      ['live-endpoint-scope', (live) => { delete live.endpointHealthProbed; }],
      ['live-http-status', (live) => { live.httpStatus = 503; }],
      ['live-version', (live) => { live.version = 2; }],
      ['live-server-count', (live) => { live.serverCount = 0; }],
      ['live-url-count', (live) => { live.urlCount = live.serverCount - 1; }],
      ['live-raw-hash', (live) => { live.rawResponseSha256 = 'not-a-hash'; }],
      ['live-config-hash', (live) => { live.canonicalConfigSha256 = 'not-a-hash'; }],
      ['live-scope-limitation', (live) => { delete live.endpointHealthLimitation; }],
    ];
    for (const [name, mutate] of greenLiveMutations) {
      const result = validFakeResult(terminalBuildDir);
      mutate(result.liveRegistry);
      verdict = verdictFor(result, 0);
      observe(name, verdict.ok, 'green-live-registry-evidence', verdict.reason);
    }

    const buildRed = validFakeResult(terminalBuildDir);
    buildRed.status = 'RED';
    buildRed.stage = 'build';
    buildRed.build.exitCode = 1;
    buildRed.registration = emptyRunState();
    buildRed.functions = emptyRunState();
    buildRed.runtime = emptyRunState();
    buildRed.artifact.selected = null;
    buildRed.artifact.executed = false;
    buildRed.flags = {
      artifactExecuted: false,
      functionsInvoked: false,
      ctestInvoked: false,
    };
    buildRed.liveRegistry.passed = false;
    verdict = verdictFor(buildRed, 1);
    observe(
      'build-red-live-failure',
      verdict.ok,
      'red-live-registry-evidence',
      verdict.reason,
    );

    const outsideArtifact = path.join(
      temporaryRoot,
      'outside',
      process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
    );
    fs.mkdirSync(path.dirname(outsideArtifact), { recursive: true });
    fs.writeFileSync(outsideArtifact, 'outside-round3-control');
    const commandMutations = [
      ['functions-red-outside-registration-command', (result) => {
        result.registration.command = [outsideArtifact];
      }],
      ['functions-red-outside-reported-command', (result) => {
        result.registration.reportedCommand = [outsideArtifact];
      }],
      ['functions-red-outside-executed-command', (result) => {
        result.functions.commandResult.command = [outsideArtifact, '-functions'];
      }],
    ];
    for (const [name, mutate] of commandMutations) {
      const result = validFakeResult(terminalBuildDir);
      result.status = 'RED';
      result.stage = 'functions';
      result.functions.passed = false;
      result.runtime = emptyRunState();
      mutate(result);
      verdict = verdictFor(result, 1);
      observe(name, verdict.ok, 'red-command-evidence', verdict.reason);
    }

    for (const [name, server] of [
      [
        'unicode-0085-url',
        { urls: 'turn:control.invalid:3478\u0085suffix', username: 'u', credential: 'c', udp: true },
      ],
      [
        'unicode-0085-username',
        { urls: 'turn:control.invalid:3478', username: 'u\u0085suffix', credential: 'c', udp: true },
      ],
      [
        'unicode-0085-credential',
        { urls: 'turn:control.invalid:3478', username: 'u', credential: 'c\u0085suffix', udp: true },
      ],
    ]) {
      if (validateRegistryDocument(JSON.stringify({ version: 1, servers: [server] })).passed) {
        failures.push(`${name}:accepted`);
      } else {
        pass(`${name}: rejected`);
      }
    }
    const additiveMetadata = validateRegistryDocument(
      JSON.stringify({
        version: 1,
        note: 'opaque\u0085metadata',
        servers: [
          {
            urls: 'turn:metadata.invalid:3478',
            username: 'u',
            credential: 'c',
            udp: true,
            future: { note: 'opaque\u0085metadata' },
          },
        ],
      }),
    );
    if (!additiveMetadata.passed) failures.push('unicode-0085-additive-metadata:rejected');
    else pass('unicode-0085-additive-metadata: accepted');
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-round3-')) {
      throw new Error('Round 3 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runRound4AdversarialControls(buildDir, suppliedToolchainEnvironment = null) {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND4 CONTROL PASS] ${name}\n`);
  const observe = (name, verdict, expectedReason) => {
    if (!verdict.ok && verdict.reason === expectedReason) {
      pass(`${name}: ${verdict.reason}`);
      return;
    }
    failures.push(
      `${name}:expected=${expectedReason}:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
    );
  };
  const toolchainEnvironment =
    suppliedToolchainEnvironment || loadToolchainEnvironment(buildDir).env;
  const compilerName = process.platform === 'win32' ? 'cl.exe' : 'c++';
  const compiler = environmentValue(toolchainEnvironment, 'PATH')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => path.join(entry, compilerName))
    .find((candidate) => fs.existsSync(candidate));
  if (!compiler) {
    failures.push(`continued-macro-compiler:not-found:${compilerName}`);
    return failures;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round4-'));
  try {
    const continuedMacroLf = [
      '#include <string_view>',
      '#define TURN_ENDPOINT(host) \\',
      '  "turn:" host',
      'constexpr auto endpoint = TURN_ENDPOINT("relay.example:3478");',
      'static_assert(std::string_view{endpoint}.starts_with("turn:"));',
      'static_assert(std::string_view{endpoint}.substr(5) == "relay.example:3478");',
      '',
    ].join('\n');
    for (const [name, source] of [
      ['continued-function-macro-lf', continuedMacroLf],
      ['continued-function-macro-crlf', continuedMacroLf.replace(/\n/g, '\r\n')],
    ]) {
      const sourcePath = path.join(temporaryRoot, `${name}.cpp`);
      fs.writeFileSync(sourcePath, source);
      const compilerArguments =
        process.platform === 'win32'
          ? ['/nologo', '/std:c++20', '/Zs', sourcePath]
          : ['-std=c++20', '-fsyntax-only', sourcePath];
      const compiled = runCommand(compiler, compilerArguments, {
        cwd: temporaryRoot,
        env: toolchainEnvironment,
        timeoutMs: 30000,
      });
      if (compiled.exitCode !== 0 || compiled.timedOut || compiled.spawnError) {
        failures.push(
          `${name}:compile-exit=${String(compiled.exitCode)}:timeout=${compiled.timedOut}:spawn=${compiled.spawnError || 'none'}`,
        );
        continue;
      }
      const findings = scanCppSource(source, `${name}.cpp`);
      if (findings.length !== 1) {
        failures.push(`${name}:expected=1:observed=${findings.length}`);
        continue;
      }
      pass(`${name}: compiled-and-rejected`);
    }

    const terminalBuildDir = path.join(temporaryRoot, 'selected-build');
    const terminalArtifact = path.join(
      terminalBuildDir,
      'bin',
      process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
    );
    const unrelatedBuildDir = path.join(temporaryRoot, 'unrelated-stale-build');
    fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
    fs.mkdirSync(unrelatedBuildDir, { recursive: true });
    fs.writeFileSync(terminalArtifact, 'round4-post-build-artifact');
    const toBuildRed = (result) => {
      result.status = 'RED';
      result.stage = 'build';
      result.build.exitCode = 1;
      result.registration = emptyRunState();
      result.functions = emptyRunState();
      result.runtime = emptyRunState();
      result.artifact.selected = null;
      result.artifact.executed = false;
      result.flags = {
        artifactExecuted: false,
        functionsInvoked: false,
        ctestInvoked: false,
      };
      return result;
    };
    const verdictFor = (result) =>
      validateChildOutcome(
        {
          stdout: `${TERMINAL_PREFIX}${JSON.stringify(result)}\n`,
          exitCode: 1,
          timedOut: false,
        },
        terminalBuildDir,
      );

    const postArtifactRed = toBuildRed(validFakeResult(terminalBuildDir));
    observe(
      'build-red-existing-post-artifact',
      verdictFor(postArtifactRed),
      'red-build-post-artifact',
    );

    const exactReviewerRed = toBuildRed(validFakeResult(terminalBuildDir));
    exactReviewerRed.build.command = [
      'cmake',
      '--build',
      unrelatedBuildDir,
      '--target',
      'test_ice_config',
    ];
    observe(
      'build-red-stale-command-existing-post',
      verdictFor(exactReviewerRed),
      'red-build-command-evidence',
    );

    const coherentBuildRed = toBuildRed(validFakeResult(terminalBuildDir));
    fs.rmSync(terminalArtifact);
    coherentBuildRed.artifact.post = coherentBuildRed.artifact.candidates.map(fileIdentity);
    const coherentVerdict = verdictFor(coherentBuildRed);
    if (!coherentVerdict.ok) {
      failures.push(`coherent-build-red:rejected=${coherentVerdict.reason}`);
    } else {
      pass('coherent-build-red: accepted');
    }
    const staleCommandOnly = structuredClone(coherentBuildRed);
    staleCommandOnly.build.command = [
      'cmake',
      '--build',
      unrelatedBuildDir,
      '--target',
      'test_ice_config',
    ];
    observe(
      'build-red-stale-command-only',
      verdictFor(staleCommandOnly),
      'red-build-command-evidence',
    );
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-round4-')) {
      throw new Error('Round 4 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runRound5AdversarialControls() {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND5 CONTROL PASS] ${name}\n`);
  const observe = (name, verdict, expectedReason) => {
    if (!verdict.ok && verdict.reason === expectedReason) {
      pass(`${name}: ${verdict.reason}`);
      return;
    }
    failures.push(
      `${name}:expected=${expectedReason}:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
    );
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round5-'));
  try {
    const terminalBuildDir = path.join(temporaryRoot, 'build');
    const terminalArtifact = path.join(
      terminalBuildDir,
      'bin',
      process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
    );
    fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
    fs.writeFileSync(terminalArtifact, 'round5-artifact');
    const result = validFakeResult(terminalBuildDir);
    result.status = 'RED';
    result.stage = 'build';
    result.build.exitCode = 1;
    result.registration = emptyRunState();
    result.functions = emptyRunState();
    result.runtime = emptyRunState();
    result.artifact.selected = null;
    result.artifact.executed = false;
    result.flags = {
      artifactExecuted: false,
      functionsInvoked: false,
      ctestInvoked: false,
    };
    fs.rmSync(terminalArtifact);
    result.artifact.post = result.artifact.candidates.map(fileIdentity);
    const verdictFor = (candidate) =>
      validateChildOutcome(
        {
          stdout: `${TERMINAL_PREFIX}${JSON.stringify(candidate)}\n`,
          exitCode: 1,
          timedOut: false,
        },
        terminalBuildDir,
      );

    const baseline = verdictFor(result);
    if (!baseline.ok) failures.push(`coherent-cmake-build-red:rejected=${baseline.reason}`);
    else pass('coherent-cmake-build-red: accepted');

    const bogusExecutable = structuredClone(result);
    bogusExecutable.build.command[0] = 'definitely-not-cmake.exe';
    observe(
      'build-red-bogus-build-executable',
      verdictFor(bogusExecutable),
      'red-build-command-evidence',
    );

    const cmakeName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
    const aliasTools = path.join(temporaryRoot, 'alias-tools');
    const otherTools = path.join(temporaryRoot, 'other-tools');
    fs.mkdirSync(otherTools, { recursive: true });
    const realCmake = discoverCmakeExecutable();
    const otherCmake = path.join(otherTools, cmakeName);
    const notCmake = path.join(
      otherTools,
      process.platform === 'win32' ? 'not-cmake.exe' : 'not-cmake',
    );
    fs.writeFileSync(otherCmake, 'round5-other-cmake');
    fs.writeFileSync(notCmake, 'round5-not-cmake');
    fs.symlinkSync(
      path.dirname(realCmake),
      aliasTools,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const mismatch = structuredClone(result);
    mismatch.build.command[0] = otherCmake;
    observe(
      'build-red-configure-build-executable-mismatch',
      verdictFor(mismatch),
      'red-build-command-evidence',
    );

    const sameNonCmake = structuredClone(result);
    sameNonCmake.configure.command[0] = notCmake;
    sameNonCmake.build.command[0] = notCmake;
    observe(
      'build-red-matching-non-cmake-executable',
      verdictFor(sameNonCmake),
      'red-build-command-evidence',
    );

    const canonicalAlias = structuredClone(result);
    canonicalAlias.configure.command[0] = path.join(aliasTools, cmakeName);
    canonicalAlias.build.command[0] = realCmake;
    const aliasVerdict = verdictFor(canonicalAlias);
    if (!aliasVerdict.ok) {
      failures.push(`canonical-cmake-alias:rejected=${aliasVerdict.reason}`);
    } else {
      pass('canonical-cmake-alias: accepted');
    }

    if (process.platform === 'win32') {
      const caseAlias = structuredClone(result);
      caseAlias.configure.command[0] = realCmake.toUpperCase();
      caseAlias.build.command[0] = realCmake;
      const caseVerdict = verdictFor(caseAlias);
      if (!caseVerdict.ok) failures.push(`cmake-case-alias:rejected=${caseVerdict.reason}`);
      else pass('cmake-case-alias: accepted');
    }
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-round5-')) {
      throw new Error('Round 5 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runRound6AdversarialControls() {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND6 CONTROL PASS] ${name}\n`);
  const observeRejected = (name, verdict) => {
    if (!verdict.ok && verdict.reason === 'red-build-command-evidence') {
      pass(`${name}: ${verdict.reason}`);
      return;
    }
    failures.push(
      `${name}:expected=red-build-command-evidence:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
    );
  };
  const observeAccepted = (name, verdict) => {
    if (verdict.ok) pass(`${name}: accepted`);
    else failures.push(`${name}:rejected=${verdict.reason}`);
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round6-'));
  try {
    const terminalBuildDir = path.join(temporaryRoot, 'selected-build');
    const staleBuildDir = path.join(temporaryRoot, 'unrelated-configure-build');
    const staleSourceDir = path.join(temporaryRoot, 'unrelated-source');
    const terminalArtifact = path.join(
      terminalBuildDir,
      'bin',
      process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
    );
    fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
    fs.mkdirSync(staleBuildDir, { recursive: true });
    fs.mkdirSync(staleSourceDir, { recursive: true });
    fs.writeFileSync(terminalArtifact, 'round6-artifact');
    const result = validFakeResult(terminalBuildDir);
    result.status = 'RED';
    result.stage = 'build';
    result.build.exitCode = 1;
    result.registration = emptyRunState();
    result.functions = emptyRunState();
    result.runtime = emptyRunState();
    result.artifact.selected = null;
    result.artifact.executed = false;
    result.flags = {
      artifactExecuted: false,
      functionsInvoked: false,
      ctestInvoked: false,
    };
    fs.rmSync(terminalArtifact);
    result.artifact.post = result.artifact.candidates.map(fileIdentity);
    const verdictFor = (candidate) =>
      validateChildOutcome(
        {
          stdout: `${TERMINAL_PREFIX}${JSON.stringify(candidate)}\n`,
          exitCode: 1,
          timedOut: false,
        },
        terminalBuildDir,
      );
    const mutateSeparatedArgument = (candidate, flag, replacement) => {
      const index = candidate.configure.command.indexOf(flag);
      if (index < 0) throw new Error(`Round 6 baseline omitted ${flag}`);
      candidate.configure.command.splice(index, 2, ...replacement);
    };

    observeAccepted('separate-long-path-S-B', verdictFor(result));

    const staleBuild = structuredClone(result);
    mutateSeparatedArgument(staleBuild, '-B', ['-B', staleBuildDir]);
    observeRejected('stale-configure-B', verdictFor(staleBuild));

    const staleSource = structuredClone(result);
    mutateSeparatedArgument(staleSource, '-S', ['-S', staleSourceDir]);
    observeRejected('stale-configure-S', verdictFor(staleSource));

    const duplicateBuild = structuredClone(result);
    duplicateBuild.configure.command.push('-B', terminalBuildDir);
    observeRejected('duplicate-configure-B', verdictFor(duplicateBuild));

    const conflictingSource = structuredClone(result);
    conflictingSource.configure.command.push('-S', staleSourceDir);
    observeRejected('conflicting-configure-S', verdictFor(conflictingSource));

    const missingBuild = structuredClone(result);
    mutateSeparatedArgument(missingBuild, '-B', []);
    observeRejected('missing-configure-B', verdictFor(missingBuild));

    const missingSource = structuredClone(result);
    mutateSeparatedArgument(missingSource, '-S', []);
    observeRejected('missing-configure-S', verdictFor(missingSource));

    for (const [name, flag, token] of [
      ['attached-configure-B', '-B', `-B${terminalBuildDir}`],
      ['equals-configure-B', '-B', `-B=${terminalBuildDir}`],
      ['attached-configure-S', '-S', `-S${NATIVE_ROOT}`],
      ['equals-configure-S', '-S', `-S=${NATIVE_ROOT}`],
    ]) {
      const attached = structuredClone(result);
      mutateSeparatedArgument(attached, flag, [token]);
      observeRejected(name, verdictFor(attached));
    }

    const buildAlias = path.join(temporaryRoot, 'selected-build-alias');
    const sourceAlias = path.join(temporaryRoot, 'native-source-alias');
    fs.symlinkSync(
      terminalBuildDir,
      buildAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.symlinkSync(NATIVE_ROOT, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalAliases = structuredClone(result);
    mutateSeparatedArgument(canonicalAliases, '-B', ['-B', buildAlias]);
    mutateSeparatedArgument(canonicalAliases, '-S', ['-S', sourceAlias]);
    observeAccepted('canonical-S-B-directory-aliases', verdictFor(canonicalAliases));

    if (process.platform === 'win32') {
      const shortAlias = structuredClone(result);
      shortAlias.configure.command[0] = windowsShortPath(discoverCmakeExecutable());
      observeAccepted('cmake-8dot3-long-path-alias', verdictFor(shortAlias));
    }
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-round6-')) {
      throw new Error('Round 6 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function buildRedCmakeControlFixture(temporaryRoot, artifactContents) {
  const terminalBuildDir = path.join(temporaryRoot, 'build');
  const terminalArtifact = path.join(
    terminalBuildDir,
    'bin',
    process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
  );
  fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
  fs.writeFileSync(terminalArtifact, artifactContents);
  const result = validFakeResult(terminalBuildDir);
  result.status = 'RED';
  result.stage = 'build';
  result.build.exitCode = 1;
  result.registration = emptyRunState();
  result.functions = emptyRunState();
  result.runtime = emptyRunState();
  result.artifact.selected = null;
  result.artifact.executed = false;
  result.flags = {
    artifactExecuted: false,
    functionsInvoked: false,
    ctestInvoked: false,
  };
  fs.rmSync(terminalArtifact);
  result.artifact.post = result.artifact.candidates.map(fileIdentity);
  const verdictFor = (candidate) =>
    validateChildOutcome(
      {
        stdout: `${TERMINAL_PREFIX}${JSON.stringify(candidate)}\n`,
        exitCode: 1,
        timedOut: false,
      },
      terminalBuildDir,
    );
  return { result, verdictFor };
}

function runRound7AdversarialControls() {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND7 CONTROL PASS] ${name}\n`);
  const observeRejected = (name, verdict) => {
    if (!verdict.ok && verdict.reason === 'red-build-command-evidence') {
      pass(`${name}: ${verdict.reason}`);
      return;
    }
    failures.push(
      `${name}:expected=red-build-command-evidence:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
    );
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round7-'));
  try {
    const actualCmakeDiscovery = discoverTrustedCmake();
    const actualCmake = actualCmakeDiscovery.path;
    const { result, verdictFor } = buildRedCmakeControlFixture(
      temporaryRoot,
      'round7-artifact',
    );
    const baseline = verdictFor(result);
    if (!baseline.ok) failures.push(`discovered-cmake-baseline:rejected=${baseline.reason}`);
    else pass('discovered-cmake-baseline: accepted');

    const cmakeName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
    const counterfeitRoot = path.join(temporaryRoot, 'counterfeit-small');
    const sameSizeRoot = path.join(temporaryRoot, 'counterfeit-same-size');
    fs.mkdirSync(counterfeitRoot, { recursive: true });
    fs.mkdirSync(sameSizeRoot, { recursive: true });
    const counterfeit = path.join(counterfeitRoot, cmakeName);
    const sameSizeCounterfeit = path.join(sameSizeRoot, cmakeName);
    fs.writeFileSync(counterfeit, 'arbitrary text, not CMake');
    fs.writeFileSync(sameSizeCounterfeit, 'not CMake');
    fs.truncateSync(sameSizeCounterfeit, actualCmakeDiscovery.identity.size);

    for (const [name, candidatePath] of [
      ['same-name-arbitrary-text-cmake', counterfeit],
      ['same-name-same-size-counterfeit-cmake', sameSizeCounterfeit],
      ['missing-cmake-command', path.join(temporaryRoot, 'missing', cmakeName)],
    ]) {
      const candidate = structuredClone(result);
      candidate.configure.command[0] = candidatePath;
      candidate.build.command[0] = candidatePath;
      observeRejected(name, verdictFor(candidate));
    }

    const aliasDirectory = path.join(temporaryRoot, 'actual-cmake-alias');
    fs.symlinkSync(
      path.dirname(actualCmake),
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const canonicalAlias = structuredClone(result);
    canonicalAlias.configure.command[0] = path.join(aliasDirectory, path.basename(actualCmake));
    canonicalAlias.build.command[0] = actualCmake;
    const aliasVerdict = verdictFor(canonicalAlias);
    if (!aliasVerdict.ok) failures.push(`actual-cmake-canonical-alias:rejected=${aliasVerdict.reason}`);
    else pass('actual-cmake-canonical-alias: accepted');
  } finally {
    if (!path.basename(temporaryRoot).startsWith('game-capture-round7-')) {
      throw new Error('Round 7 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runRound8AdversarialControls() {
  const failures = [];
  const pass = (name) => process.stdout.write(`[ROUND8 CONTROL PASS] ${name}\n`);
  const observeRejected = (name, verdict) => {
    if (!verdict.ok && verdict.reason === 'red-build-command-evidence') {
      pass(`${name}: ${verdict.reason}`);
      return;
    }
    failures.push(
      `${name}:expected=red-build-command-evidence:observed=${verdict.ok ? 'accepted' : verdict.reason}`,
    );
  };
  const observeAccepted = (name, verdict) => {
    if (verdict.ok) pass(`${name}: accepted`);
    else failures.push(`${name}:rejected=${verdict.reason}`);
  };
  const pathEnvironmentName =
    Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = String(process.env[pathEnvironmentName] || '');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-round8-'));
  try {
    const actualCmakeDiscovery = discoverTrustedCmake();
    const actualCmake = actualCmakeDiscovery.path;
    const { result, verdictFor } = buildRedCmakeControlFixture(
      temporaryRoot,
      'round8-artifact',
    );
    observeAccepted('trusted-cmake-baseline', verdictFor(result));

    const cmakeName = process.platform === 'win32' ? 'cmake.exe' : 'cmake';
    const counterfeitRoot = path.join(temporaryRoot, 'counterfeit-small');
    const sameSizeRoot = path.join(temporaryRoot, 'counterfeit-same-size');
    const versionSpoofRoot = path.join(temporaryRoot, 'version-spoof');
    fs.mkdirSync(counterfeitRoot, { recursive: true });
    fs.mkdirSync(sameSizeRoot, { recursive: true });
    fs.mkdirSync(versionSpoofRoot, { recursive: true });
    const counterfeit = path.join(counterfeitRoot, cmakeName);
    const sameSizeCounterfeit = path.join(sameSizeRoot, cmakeName);
    const versionSpoof = path.join(versionSpoofRoot, cmakeName);
    fs.writeFileSync(counterfeit, 'arbitrary text, not CMake');
    fs.writeFileSync(sameSizeCounterfeit, 'not CMake');
    fs.truncateSync(sameSizeCounterfeit, actualCmakeDiscovery.identity.size);
    fs.writeFileSync(versionSpoof, 'cmake version 99.99.99\nnot an executable\n');

    const aliasDirectory = path.join(temporaryRoot, 'actual-cmake-alias');
    fs.symlinkSync(
      path.dirname(actualCmake),
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const canonicalAlias = structuredClone(result);
    canonicalAlias.configure.command[0] = path.join(aliasDirectory, path.basename(actualCmake));
    canonicalAlias.build.command[0] = actualCmake;

    const withPath = (directories, callback) => {
      process.env[pathEnvironmentName] = [...directories, originalPath].join(path.delimiter);
      try {
        return callback();
      } finally {
        process.env[pathEnvironmentName] = originalPath;
      }
    };
    const expectPoisonSkipped = (name, directory, fakeExecutable) => {
      withPath([directory, path.dirname(actualCmake)], () => {
        const discovered = discoverTrustedCmake();
        if (pathKey(discovered.path) !== pathKey(actualCmake)) {
          failures.push(`${name}:selected=${discovered.path}`);
          return;
        }
        observeAccepted(`${name}-real-evidence`, verdictFor(result));
        const fakeEvidence = structuredClone(result);
        fakeEvidence.configure.command[0] = fakeExecutable;
        fakeEvidence.build.command[0] = fakeExecutable;
        observeRejected(`${name}-fake-evidence`, verdictFor(fakeEvidence));
      });
    };
    expectPoisonSkipped('path-arbitrary-text-first-real-next', counterfeitRoot, counterfeit);
    expectPoisonSkipped('path-version-spoof-first-real-next', versionSpoofRoot, versionSpoof);
    expectPoisonSkipped('path-same-size-first-real-next', sameSizeRoot, sameSizeCounterfeit);

    withPath([aliasDirectory], () => {
      const discovered = discoverTrustedCmake();
      if (pathKey(discovered.path) !== pathKey(actualCmake)) {
        failures.push(`path-actual-alias:selected=${discovered.path}`);
      } else {
        observeAccepted('path-actual-alias', verdictFor(canonicalAlias));
      }
    });

    const copiedRoot = path.join(temporaryRoot, 'byte-identical-runnable-copy');
    fs.mkdirSync(copiedRoot, { recursive: true });
    const copiedCmake = path.join(copiedRoot, cmakeName);
    fs.copyFileSync(actualCmake, copiedCmake);
    const copiedIdentity = canonicalFileIdentity(copiedCmake);
    if (
      copiedIdentity.size !== actualCmakeDiscovery.identity.size ||
      copiedIdentity.sha256 !== actualCmakeDiscovery.identity.sha256
    ) {
      failures.push('byte-identical-runnable-copy:identity-copy-mismatch');
    } else {
      withPath([copiedRoot, path.dirname(actualCmake)], () => {
        const copiedDiscovery = discoverTrustedCmake();
        if (pathKey(copiedDiscovery.path) === pathKey(copiedCmake)) {
          const copiedResult = structuredClone(result);
          copiedResult.configure.command[0] = copiedCmake;
          copiedResult.build.command[0] = copiedCmake;
          copiedResult.cmakeExecutable = cmakeExecutableEvidence(copiedDiscovery);
          observeAccepted('byte-identical-runnable-copy-first', verdictFor(copiedResult));
          fs.writeFileSync(copiedCmake, 'TOCTOU replacement, not CMake');
          observeRejected('in-place-cmake-replacement-after-discovery', verdictFor(copiedResult));
        } else {
          pass('byte-identical-runnable-copy-first: copy was not independently runnable');
        }
      });
    }

    const identityMutation = structuredClone(result);
    identityMutation.cmakeExecutable.afterBuild.sha256 = '0'.repeat(64);
    observeRejected('recorded-after-build-identity-mutation', verdictFor(identityMutation));
  } finally {
    process.env[pathEnvironmentName] = originalPath;
    if (!path.basename(temporaryRoot).startsWith('game-capture-round8-')) {
      throw new Error('Round 8 temporary path safety check failed');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return failures;
}

function runSchemaSelfControls() {
  const valid = JSON.stringify({
    version: 1,
    additive: true,
    servers: [
      {
        urls: 'turn:self-control-a.invalid:3478',
        username: 'user-a',
        credential: 'secret-a',
        udp: true,
        future: { safe: true },
      },
      {
        urls: ['turn:self-control-b.invalid:3478', 'turns:self-control-c.invalid:443'],
        username: 'user-b',
        credential: 'secret-b',
        udp: false,
      },
    ],
  });
  const checked = validateRegistryDocument(valid);
  if (!checked.passed || checked.serverCount !== 2 || checked.urlCount !== 3) {
    throw new Error('valid live-schema control was rejected or miscounted');
  }
  const invalid = [
    '{}',
    JSON.stringify({ version: 2, servers: [] }),
    JSON.stringify({ version: 1, servers: [] }),
    JSON.stringify({
      version: 1,
      servers: [{ urls: ['turn:ok.invalid:3478', 7], username: 'u', credential: 'c', udp: true }],
    }),
    JSON.stringify({
      version: 1,
      servers: [
        { urls: 'turn:ok.invalid:3478', username: 'u', credential: 'c', udp: true },
        { urls: [], username: 'u', credential: 'c', udp: true },
      ],
    }),
  ];
  for (const body of invalid) {
    if (validateRegistryDocument(body).passed) throw new Error('invalid live-schema control was accepted');
  }
  const scalar = validateRegistryDocument(
    JSON.stringify({
      version: 1,
      servers: [{ urls: 'turn:shape.invalid:3478', username: 'u', credential: 'c', udp: true }],
    }),
  );
  const array = validateRegistryDocument(
    JSON.stringify({
      version: 1,
      servers: [{ urls: ['turn:shape.invalid:3478'], username: 'u', credential: 'c', udp: true }],
    }),
  );
  if (scalar.canonicalConfigSha256 === array.canonicalConfigSha256) {
    throw new Error('canonical fingerprint lost scalar-versus-array shape');
  }
}

function runLiteralSelfControls() {
  const controls = [
    {
      name: 'adjacent-real-endpoint',
      source: 'constexpr auto endpoint = "turn:" "relay.example:3478";',
      expectedFindings: 1,
    },
    {
      name: 'constructed-real-endpoint',
      source:
        'constexpr auto scheme = "turn:"; constexpr auto host = "relay.example:3478"; const std::string endpoint = std::string{scheme} + host;',
      expectedFindings: 1,
    },
    {
      name: 'invalid-fixture',
      source: 'constexpr auto endpoint = "turn:fixture.invalid:3478";',
      expectedFindings: 0,
    },
    {
      name: 'split-https-source',
      source: 'constexpr auto left = "https://turn"; constexpr auto right = "servers.vdo.ninja/"; const std::string source = std::string{left} + right;',
      expectedFindings: 0,
    },
    {
      name: 'character-literal-with-quote',
      source: 'constexpr char quote = \'"\'; constexpr auto endpoint = "turn:fixture.invalid:3478";',
      expectedFindings: 0,
    },
  ];
  for (const control of controls) {
    const findings = scanCppSource(control.source, `${control.name}.cpp`);
    if (findings.length !== control.expectedFindings) {
      throw new Error(
        `literal self-control ${control.name}: expected ${control.expectedFindings}, got ${findings.length}`,
      );
    }
  }
}

function runSelfChecks(buildDir) {
  const toolchain = loadToolchainEnvironment(buildDir);
  if (
    process.platform === 'win32' &&
    (String(toolchain.provenance.targetArchitecture).toLowerCase() !== 'x64' ||
      toolchain.provenance.includeEntryCount < 1 ||
      toolchain.provenance.pathEntryCount < 1)
  ) {
    throw new Error('x64 Visual Studio developer environment self-control failed');
  }
  process.stdout.write(
    `[SELF-CONTROL PASS] build toolchain environment target=${toolchain.provenance.targetArchitecture}\n`,
  );
  runSchemaSelfControls();
  process.stdout.write('[SELF-CONTROL PASS] live schema atomicity, counts, and shape fingerprint\n');
  runLiteralSelfControls();
  process.stdout.write('[SELF-CONTROL PASS] C++ adjacent/constructed/.invalid/HTTPS literal controls\n');
  const round2Failures = runRound2AdversarialControls(buildDir);
  if (round2Failures.length > 0) {
    throw new Error(`Round 2 controls failed: ${round2Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 2 reviewer controls\n');
  const round3Failures = runRound3AdversarialControls(buildDir, toolchain.env);
  if (round3Failures.length > 0) {
    throw new Error(`Round 3 controls failed: ${round3Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 3 reviewer controls\n');
  const round4Failures = runRound4AdversarialControls(buildDir, toolchain.env);
  if (round4Failures.length > 0) {
    throw new Error(`Round 4 controls failed: ${round4Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 4 reviewer controls\n');
  const round5Failures = runRound5AdversarialControls();
  if (round5Failures.length > 0) {
    throw new Error(`Round 5 controls failed: ${round5Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 5 reviewer controls\n');
  const round6Failures = runRound6AdversarialControls();
  if (round6Failures.length > 0) {
    throw new Error(`Round 6 controls failed: ${round6Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 6 reviewer controls\n');
  const round7Failures = runRound7AdversarialControls();
  if (round7Failures.length > 0) {
    throw new Error(`Round 7 controls failed: ${round7Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 7 reviewer controls\n');
  const round8Failures = runRound8AdversarialControls();
  if (round8Failures.length > 0) {
    throw new Error(`Round 8 controls failed: ${round8Failures.join(', ')}`);
  }
  process.stdout.write('[SELF-CONTROL PASS] all Round 8 reviewer controls\n');

  const terminalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-terminal-'));
  const terminalBuildDir = path.join(terminalRoot, 'build');
  const terminalArtifact = path.join(
    terminalBuildDir,
    'bin',
    process.platform === 'win32' ? 'test_ice_config.exe' : 'test_ice_config',
  );
  fs.mkdirSync(path.dirname(terminalArtifact), { recursive: true });
  fs.writeFileSync(terminalArtifact, 'terminal-self-control');
  const cases = [
    ['missing-terminal', 'terminal-count'],
    ['duplicate-terminal', 'terminal-count'],
    ['malformed-json', 'terminal-json'],
    ['stall-timeout', 'child-timeout'],
    ['green-build-failure', 'green-build'],
    ['green-missing-function', 'green-functions'],
    ['green-wrong-totals', 'green-runtime'],
    ['green-nonzero-exit', 'status-exit'],
    ['red-zero-exit', 'status-exit'],
    ['ctest-outside-build-dir', 'green-registration'],
    ['stale-execution-after-build-failure', 'red-build-execution'],
  ];
  try {
    for (const [name, expectedReason] of cases) {
      const timeout = name === 'stall-timeout' ? 300 : 3000;
      const child = spawnSync(
        process.execPath,
        [__filename, `--internal-fake-child=${name}`, `--build-dir=${terminalBuildDir}`],
        { encoding: 'utf8', timeout, windowsHide: true },
      );
      const verdict = validateChildOutcome(
        {
          stdout: child.stdout,
          exitCode: Number.isInteger(child.status) ? child.status : null,
          timedOut: Boolean(child.error && child.error.code === 'ETIMEDOUT'),
        },
        terminalBuildDir,
      );
      if (verdict.ok || verdict.reason !== expectedReason) {
        throw new Error(
          `child self-control ${name}: expected ${expectedReason}, got ${verdict.ok ? 'accepted' : verdict.reason}`,
        );
      }
      process.stdout.write(`[SELF-CONTROL PASS] ${name}: ${verdict.reason}\n`);
    }
    const valid = validFakeResult(terminalBuildDir);
    const validLine = `${TERMINAL_PREFIX}${JSON.stringify(valid)}\n`;
    const accepted = validateChildOutcome(
      { stdout: validLine, exitCode: 0, timedOut: false },
      terminalBuildDir,
    );
    if (!accepted.ok) throw new Error(`valid child rejected: ${accepted.reason}`);
    process.stdout.write('[SELF-CONTROL PASS] internally consistent GREEN child accepted\n');
  } finally {
    if (!path.basename(terminalRoot).startsWith('game-capture-terminal-')) {
      throw new Error('terminal self-control path safety check failed');
    }
    fs.rmSync(terminalRoot, { recursive: true, force: true });
  }
}

function emptyRunState() {
  return { invoked: false, passed: false };
}

function selectFailureStage(result) {
  if (result.configure.exitCode !== 0) return ['HARNESS_ERROR', 'configure', 2];
  if (result.build.exitCode !== 0) return ['RED', 'build', 1];
  if (!result.registration.passed) return ['RED', 'registration', 1];
  if (!result.functions.passed) return ['RED', 'functions', 1];
  if (!result.runtime.passed) return ['RED', 'runtime', 1];
  if (!result.liveRegistry.passed) return ['RED', 'live-registry', 1];
  if (!result.literalGate.passed) return ['RED', 'literal-gate', 1];
  return ['GREEN', 'complete', 0];
}

function emitValidatedTerminal(result, intendedExit) {
  const line = `${TERMINAL_PREFIX}${JSON.stringify(result)}\n`;
  const verdict = validateChildOutcome(
    { stdout: line, exitCode: intendedExit, timedOut: false },
    result.buildDir,
  );
  if (!verdict.ok) {
    const emergency = {
      ...result,
      status: 'HARNESS_ERROR',
      stage: 'terminal-validation',
      terminalValidationError: verdict.reason,
    };
    process.stdout.write(`${TERMINAL_PREFIX}${JSON.stringify(emergency)}\n`);
    process.exit(2);
  }
  process.stdout.write(line);
  process.exit(intendedExit);
}

async function runGate(options) {
  const started = Date.now();
  const buildDirExistedBefore = fs.existsSync(options.buildDir);
  const cacheExistedBefore = fs.existsSync(path.join(options.buildDir, 'CMakeCache.txt'));
  if (options.requireFreshBuildDir && (buildDirExistedBefore || cacheExistedBefore)) {
    throw new Error(
      `fresh build directory requirement failed before configure: ${options.buildDir}`,
    );
  }
  const toolchain = loadToolchainEnvironment(options.buildDir);
  const qt = loadQtEnvironment(options.buildDir, toolchain.env);
  const generator = loadCmakeGenerator(options.buildDir);
  const trustedCmake = discoverTrustedCmake();
  const cmake = trustedCmake.path;
  const captureTrustedCmakeIdentity = (stage) => {
    const current = canonicalFileIdentity(cmake);
    if (!identityEqual(current, trustedCmake.identity)) {
      throw new Error(`CMake executable identity changed at ${stage}`);
    }
    return current;
  };
  const ctest = findExecutable('ctest', [
    process.platform === 'win32' ? 'C:\\Program Files\\CMake\\bin\\ctest.exe' : null,
  ]);
  const candidates = artifactCandidates(options.buildDir);
  const manifest = sourceManifest();
  const pre = candidates.map(fileIdentity);
  const literalGate = runLiteralGate();

  process.stdout.write(
    `[SOURCE MANIFEST] files=${manifest.entries.length} sha256=${manifest.sha256}\n`,
  );
  process.stdout.write(
    `[LITERAL GATE] passed=${literalGate.passed} files=${literalGate.scannedFiles} findings=${literalGate.findings.length}\n`,
  );

  const cmakeBeforeConfigure = captureTrustedCmakeIdentity('before-configure');
  const configureRaw = runCommand(
    cmake,
    [
      '-S',
      NATIVE_ROOT,
      '-B',
      options.buildDir,
      '-DVERSUS_BUILD_TESTS=ON',
      qt.cmakeArgument,
      ...generator.arguments,
    ],
    { timeoutMs: CONFIGURE_TIMEOUT_MS, env: qt.env },
  );
  publishCommand('CONFIGURE', configureRaw);
  const cmakeAfterConfigure = captureTrustedCmakeIdentity('after-configure');

  let cmakeBeforeBuild = cmakeAfterConfigure;
  let cmakeAfterBuild = cmakeAfterConfigure;
  let buildRaw = {
    command: [cmake, '--build', options.buildDir, '--target', 'test_ice_config'],
    attempted: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    outputSha256: sha256(''),
  };
  if (configureRaw.exitCode === 0 && !configureRaw.timedOut && !configureRaw.spawnError) {
    cmakeBeforeBuild = captureTrustedCmakeIdentity('before-build');
    buildRaw = runCommand(
      cmake,
      ['--build', options.buildDir, '--target', 'test_ice_config'],
      { timeoutMs: BUILD_TIMEOUT_MS, env: qt.env },
    );
    publishCommand('BUILD test_ice_config', buildRaw);
    cmakeAfterBuild = captureTrustedCmakeIdentity('after-build');
  }

  const liveRegistry = await fetchLiveRegistry();
  process.stdout.write(
    `[LIVE REGISTRY] passed=${liveRegistry.passed} source=${liveRegistry.sourceUrl} status=${liveRegistry.httpStatus || 0} version=${liveRegistry.version || 0} servers=${liveRegistry.serverCount || 0} urls=${liveRegistry.urlCount || 0} raw_sha256=${liveRegistry.rawResponseSha256 || 'none'} config_sha256=${liveRegistry.canonicalConfigSha256 || 'none'} endpoint_health_probed=false\n`,
  );
  process.stdout.write(`[LIMITATION] ${liveRegistry.endpointHealthLimitation}\n`);

  const result = {
    terminalVersion: TERMINAL_VERSION,
    gate: GATE_NAME,
    status: 'HARNESS_ERROR',
    stage: 'initializing',
    buildDir: options.buildDir,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    sourceManifest: manifest,
    toolchainEnvironment: toolchain.provenance,
    qtEnvironment: qt.provenance,
    cmakeGenerator: generator.provenance,
    cmakeExecutable: cmakeExecutableEvidence(trustedCmake, {
      beforeConfigure: cmakeBeforeConfigure,
      afterConfigure: cmakeAfterConfigure,
      beforeBuild: cmakeBeforeBuild,
      afterBuild: cmakeAfterBuild,
    }),
    freshConfigure: {
      required: options.requireFreshBuildDir,
      buildDirExistedBefore,
      cacheExistedBefore,
      configureInvocationCount: 1,
      configuredFromScratch:
        !buildDirExistedBefore && !cacheExistedBefore && configureRaw.exitCode === 0,
    },
    configure: {
      ...publicCommandResult(configureRaw),
      timeoutMs: CONFIGURE_TIMEOUT_MS,
      invocationCount: 1,
    },
    build: {
      ...publicCommandResult(buildRaw),
      timeoutMs: BUILD_TIMEOUT_MS,
      invocationCount: buildRaw.attempted ? 1 : 0,
    },
    registration: emptyRunState(),
    functions: emptyRunState(),
    runtime: emptyRunState(),
    liveRegistry,
    literalGate,
    artifact: {
      candidates,
      pre,
      post: candidates.map(fileIdentity),
      selected: null,
      executed: false,
    },
    flags: { artifactExecuted: false, functionsInvoked: false, ctestInvoked: false },
    limitations: [liveRegistry.endpointHealthLimitation, literalGate.limitation],
  };

  if (
    configureRaw.exitCode === 0 &&
    buildRaw.exitCode === 0 &&
    !buildRaw.timedOut &&
    !buildRaw.spawnError
  ) {
    const registrationRaw = runCommand(
      ctest,
      ['--test-dir', options.buildDir, '-C', 'Release', '--show-only=json-v1', '-R', '^IceConfigTest$'],
      { timeoutMs: 30000, env: qt.env },
    );
    result.flags.ctestInvoked = true;
    publishCommand('CTEST REGISTRATION', registrationRaw);
    const parsedRegistration =
      registrationRaw.exitCode === 0 && !registrationRaw.timedOut
        ? parseCtestRegistration(registrationRaw.stdout, options.buildDir)
        : { passed: false, reason: 'ctest-command-failed' };
    result.registration = {
      invoked: true,
      ...parsedRegistration,
      commandResult: publicCommandResult(registrationRaw),
    };

    if (parsedRegistration.passed) {
      const selectedPre = fileIdentity(parsedRegistration.command[0]);
      result.artifact.selected = selectedPre;
      if (!selectedPre.exists) {
        result.registration.passed = false;
        result.registration.reason = 'registered-artifact-missing';
      } else {
        const executableRaw = runCommand(
          parsedRegistration.command[0],
          [...parsedRegistration.command.slice(1), '-functions'],
          {
            cwd: parsedRegistration.workingDirectory,
            env: registeredEnvironment(parsedRegistration, qt.env),
            timeoutMs: 30000,
          },
        );
        result.flags.artifactExecuted = true;
        result.flags.functionsInvoked = true;
        result.artifact.executed = true;
        publishCommand('TEST FUNCTIONS', executableRaw);
        const names = parseFunctions(`${executableRaw.stdout}\n${executableRaw.stderr}`);
        result.functions = {
          invoked: true,
          passed:
            executableRaw.exitCode === 0 &&
            !executableRaw.timedOut &&
            arraysEqual(names, EXPECTED_FUNCTIONS),
          names,
          expectedNames: [...EXPECTED_FUNCTIONS],
          commandResult: publicCommandResult(executableRaw),
        };

        if (result.functions.passed) {
          const ctestRuntimeRaw = runCommand(
            ctest,
            [
              '--test-dir',
              options.buildDir,
              '-C',
              'Release',
              '-VV',
              '-R',
              '^IceConfigTest$',
              '--timeout',
              String(CTEST_TIMEOUT_SECONDS),
            ],
            { timeoutMs: (CTEST_TIMEOUT_SECONDS + 15) * 1000, env: qt.env },
          );
          publishCommand('CTEST RUNTIME', ctestRuntimeRaw);
          const ctestOutput = `${ctestRuntimeRaw.stdout}\n${ctestRuntimeRaw.stderr}`;
          const ctestSuccess =
            ctestRuntimeRaw.exitCode === 0 &&
            !ctestRuntimeRaw.timedOut &&
            /100% tests passed, 0 tests failed out of 1/i.test(ctestOutput);
          const runtimeRaw = ctestSuccess
            ? runCommand(
                parsedRegistration.command[0],
                parsedRegistration.command.slice(1),
                {
                  cwd: parsedRegistration.workingDirectory,
                  env: registeredEnvironment(parsedRegistration, qt.env),
                  timeoutMs: CTEST_TIMEOUT_SECONDS * 1000,
                  // QtTest routes text to OutputDebugString when Windows marks
                  // the child as hidden, leaving a successful run unverifiable.
                  windowsHide: false,
                },
              )
            : {
                command: parsedRegistration.command,
                attempted: false,
                exitCode: null,
                signal: null,
                timedOut: false,
                spawnError: null,
                durationMs: 0,
                stdout: '',
                stderr: '',
                outputSha256: sha256(''),
              };
          publishCommand('TEST RUNTIME', runtimeRaw);
          const totals = parseQtTotals(`${runtimeRaw.stdout}\n${runtimeRaw.stderr}`);
          result.runtime = {
            invoked: true,
            passed:
              runtimeRaw.exitCode === 0 &&
              !runtimeRaw.timedOut &&
              ctestSuccess &&
              totals?.passed === EXPECTED_QT_PASSES &&
              totals?.failed === 0 &&
              totals?.skipped === 0,
            timeoutSeconds: CTEST_TIMEOUT_SECONDS,
            ctestTestsPassed: ctestSuccess ? 1 : 0,
            ctestTestsFailed: ctestSuccess ? 0 : 1,
            totals,
            commandResult: publicCommandResult(runtimeRaw),
            ctestCommandResult: publicCommandResult(ctestRuntimeRaw),
          };
        }
        result.artifact.selected = fileIdentity(parsedRegistration.command[0]);
      }
    }
  }

  result.artifact.post = candidates.map(fileIdentity);
  result.durationMs = Date.now() - started;
  const [status, stage, exitCode] = selectFailureStage(result);
  result.status = status;
  result.stage = stage;

  if (options.expectCurrentRed && !(status === 'RED' && stage === 'build')) {
    result.status = 'HARNESS_ERROR';
    result.stage = 'current-red-expectation';
    result.currentRedExpectation = {
      passed: false,
      expectedStatus: 'RED',
      expectedStage: 'build',
      observedStatus: status,
      observedStage: stage,
    };
    emitValidatedTerminal(result, 2);
  }
  if (options.expectCurrentRed) {
    result.currentRedExpectation = {
      passed: true,
      expectedStatus: 'RED',
      expectedStage: 'build',
      observedStatus: status,
      observedStage: stage,
    };
  }
  emitValidatedTerminal(result, exitCode);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[HARNESS ERROR] ${error.message}\n`);
    process.exit(2);
  }
  if (options.internalFakeChild) {
    emitFakeChild(options.internalFakeChild, options.buildDir);
    return;
  }
  if (options.round2ControlsOnly) {
    const failures = runRound2AdversarialControls(options.buildDir);
    for (const failure of failures) process.stderr.write(`[ROUND2 CONTROL RED] ${failure}\n`);
    if (failures.length > 0) {
      process.stderr.write(`[ROUND2 CONTROL SUMMARY] escaped=${failures.length}\n`);
      process.exit(1);
    }
    process.stdout.write('[ROUND2 CONTROL SUMMARY] all controls passed\n');
    process.exit(0);
  }
  if (options.round3ControlsOnly) {
    try {
      const failures = runRound3AdversarialControls(options.buildDir);
      for (const failure of failures) process.stderr.write(`[ROUND3 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND3 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND3 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  if (options.round4ControlsOnly) {
    try {
      const failures = runRound4AdversarialControls(options.buildDir);
      for (const failure of failures) process.stderr.write(`[ROUND4 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND4 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND4 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  if (options.round5ControlsOnly) {
    try {
      const failures = runRound5AdversarialControls();
      for (const failure of failures) process.stderr.write(`[ROUND5 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND5 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND5 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  if (options.round6ControlsOnly) {
    try {
      const failures = runRound6AdversarialControls();
      for (const failure of failures) process.stderr.write(`[ROUND6 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND6 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND6 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  if (options.round7ControlsOnly) {
    try {
      const failures = runRound7AdversarialControls();
      for (const failure of failures) process.stderr.write(`[ROUND7 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND7 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND7 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  if (options.round8ControlsOnly) {
    try {
      const failures = runRound8AdversarialControls();
      for (const failure of failures) process.stderr.write(`[ROUND8 CONTROL RED] ${failure}\n`);
      if (failures.length > 0) {
        process.stderr.write(`[ROUND8 CONTROL SUMMARY] escaped=${failures.length}\n`);
        process.exit(1);
      }
      process.stdout.write('[ROUND8 CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
      process.exit(2);
    }
  }
  try {
    runSelfChecks(options.buildDir);
    if (options.selfCheckOnly) {
      process.stdout.write('[SELF-CONTROL SUMMARY] all controls passed\n');
      process.exit(0);
    }
    await runGate(options);
  } catch (error) {
    process.stderr.write(`[HARNESS ERROR] ${error.stack || error.message}\n`);
    process.exit(2);
  }
}

main();
