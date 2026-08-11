'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RELEASE_MANIFEST_NAME = 'release-artifact-manifest.json';
const RELEASE_MANIFEST_SCHEMA = 'game-capture-release-artifact/v1';
const RESULT_SCHEMA = 'game-capture-ui-wheel-e2e/v1';
const EXPECTED_CONTROLS = Object.freeze([
  'viewerLimitSpin',
  'primaryAudioGainSpin',
  'microphoneAudioGainSpin'
]);
const EXPECTED_DIRECTIONS = Object.freeze(['up', 'down']);
const EXPECTED_MODES = Object.freeze(['unfocused', 'focused']);
const EXPECTED_CASE_COUNT = EXPECTED_CONTROLS.length *
  EXPECTED_DIRECTIONS.length * EXPECTED_MODES.length;
const SETTINGS_REGISTRY_KEY = 'HKCU\\Software\\VDO.Ninja\\Game Capture';
const PAYLOAD_AGGREGATE_ALGORITHM =
  'sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1';
const QT_CONFIGURATION_CONTENT = '[Paths]\nPrefix=.\nPlugins=.\n';
const REQUIRED_QT_RUNTIME_MODULES = Object.freeze([
  'qt6core.dll',
  'qt6gui.dll',
  'qt6network.dll',
  'qt6widgets.dll',
  'qwindows.dll'
]);

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function realPath(filePath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
}

function comparablePath(filePath) {
  const resolved = realPath(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsWithin(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function toPayloadRelativePath(packageRoot, filePath) {
  const relative = path.relative(packageRoot, filePath);
  if (!relative || path.isAbsolute(relative) || relative === '..' ||
      relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Payload path escapes the package root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function isNormalizedPayloadRelativePath(relativePath) {
  return typeof relativePath === 'string' && relativePath.length > 0 &&
    !relativePath.includes('\\') && !relativePath.startsWith('/') &&
    !/^[A-Za-z]:/.test(relativePath) &&
    path.posix.normalize(relativePath) === relativePath &&
    relativePath.split('/').every((component) => component && component !== '.' && component !== '..');
}

function payloadAggregate(files) {
  const hash = crypto.createHash('sha256');
  for (const entry of files) {
    hash.update(`${entry.relativePath}\0${entry.size}\0${entry.sha256}\n`, 'utf8');
  }
  return hash.digest('hex');
}

function validatePayloadManifest(manifest) {
  const payload = manifest && manifest.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.algorithm !== PAYLOAD_AGGREGATE_ALGORITHM ||
      !Number.isSafeInteger(payload.fileCount) || payload.fileCount < 1 ||
      typeof payload.aggregateSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payload.aggregateSha256) ||
      !Array.isArray(payload.files) || payload.files.length !== payload.fileCount) {
    throw new Error('Release artifact manifest complete-payload identity is invalid');
  }

  const caseInsensitivePaths = new Set();
  let previousPath = '';
  for (const entry of payload.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !isNormalizedPayloadRelativePath(entry.relativePath) ||
        entry.relativePath === RELEASE_MANIFEST_NAME ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('Release artifact manifest contains an invalid payload file identity');
    }
    if (previousPath && !(previousPath < entry.relativePath)) {
      throw new Error('Release artifact payload paths are not unique ordinal-sorted values');
    }
    previousPath = entry.relativePath;
    const foldedPath = entry.relativePath.toLowerCase();
    if (caseInsensitivePaths.has(foldedPath)) {
      throw new Error('Release artifact payload contains a case-insensitive path collision');
    }
    caseInsensitivePaths.add(foldedPath);
  }
  if (payloadAggregate(payload.files) !== payload.aggregateSha256) {
    throw new Error('Release artifact payload aggregate does not match its file identities');
  }
  return payload;
}

function enumeratePackagePayload(packageRoot, manifestPath) {
  const rootStat = fs.lstatSync(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Packaged artifact root must be a regular directory');
  }

  const files = [];
  const pendingDirectories = [packageRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const directoryEntry of entries) {
      const absolutePath = path.join(directory, directoryEntry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Packaged artifact contains a reparse/symbolic link: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        pendingDirectories.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Packaged artifact contains an unsupported filesystem object: ${absolutePath}`);
      }
      if (comparablePath(absolutePath) === comparablePath(manifestPath)) {
        if (path.basename(absolutePath) !== RELEASE_MANIFEST_NAME) {
          throw new Error('Release manifest path uses non-canonical casing');
        }
        continue;
      }
      const relativePath = toPayloadRelativePath(packageRoot, absolutePath);
      if (relativePath.toLowerCase() === RELEASE_MANIFEST_NAME.toLowerCase()) {
        throw new Error('Package contains a colliding release manifest path');
      }
      if (stat.size < 1) {
        throw new Error(`Packaged payload files must have positive size: ${relativePath}`);
      }
      files.push({
        relativePath,
        size: stat.size,
        sha256: sha256File(absolutePath)
      });
    }
  }
  files.sort((left, right) => left.relativePath < right.relativePath
    ? -1
    : (left.relativePath > right.relativePath ? 1 : 0));
  return files;
}

function verifyPackagePayload(packageRoot, manifest, manifestPath) {
  const payload = validatePayloadManifest(manifest);
  const actualFiles = enumeratePackagePayload(packageRoot, manifestPath);
  if (actualFiles.length !== payload.fileCount) {
    throw new Error(
      `Packaged payload count mismatch: expected ${payload.fileCount}, observed ${actualFiles.length}`
    );
  }
  for (let index = 0; index < payload.files.length; index += 1) {
    const expected = payload.files[index];
    const actual = actualFiles[index];
    if (!actual || actual.relativePath !== expected.relativePath ||
        actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Packaged payload identity mismatch at ${expected.relativePath}`);
    }
  }
  const aggregateSha256 = payloadAggregate(actualFiles);
  if (aggregateSha256 !== payload.aggregateSha256) {
    throw new Error('Packaged payload bytes do not match the manifest aggregate');
  }
  return Object.freeze({
    algorithm: PAYLOAD_AGGREGATE_ALGORITHM,
    fileCount: actualFiles.length,
    aggregateSha256,
    files: Object.freeze(actualFiles.map((entry) => Object.freeze({ ...entry })))
  });
}

function assertPayloadSnapshotsEqual(before, after) {
  if (!before || !after || before.algorithm !== after.algorithm ||
      before.fileCount !== after.fileCount ||
      before.aggregateSha256 !== after.aggregateSha256 ||
      JSON.stringify(before.files) !== JSON.stringify(after.files)) {
    throw new Error('Packaged payload changed during the native wheel workflow');
  }
}

function createHermeticChildEnvironment(packageRoot) {
  const environment = {};
  const allowedNames = new Set([
    'appdata', 'comspec', 'homedrive', 'homepath', 'localappdata',
    'number_of_processors', 'os', 'pathext', 'processor_architecture',
    'programdata', 'systemdrive', 'systemroot', 'temp', 'tmp',
    'userdomain', 'username', 'userprofile', 'windir'
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(?:QT_|QML|VCPKG)/i.test(name)) {
      continue;
    }
    if (allowedNames.has(name.toLowerCase()) && typeof value === 'string' && value) {
      environment[name] = value;
    }
  }

  const configuredSystemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!configuredSystemRoot || !path.isAbsolute(configuredSystemRoot)) {
    throw new Error('A valid Windows system root is required for the hermetic child');
  }
  const systemRoot = realPath(configuredSystemRoot);
  const system32Path = realPath(path.join(systemRoot, 'System32'));
  const safePath = [packageRoot, system32Path, systemRoot].join(path.delimiter);
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === 'path') {
      delete environment[name];
    }
  }
  environment.Path = safePath;
  environment.SystemRoot = systemRoot;
  environment.WINDIR = systemRoot;
  environment.GAME_CAPTURE_E2E_HERMETIC = '1';
  return Object.freeze(environment);
}

function parseArgs(argv) {
  const config = {
    publisherPath: '',
    artifactManifestPath: '',
    artifactManifestSha256: '',
    reportDir: path.resolve(__dirname, 'reports', 'ui-wheel')
  };
  const counts = {
    publisherPath: 0,
    artifactManifestPath: 0,
    artifactManifestSha256: 0,
    reportDir: 0
  };
  const optionMap = new Map([
    ['--publisher-path', 'publisherPath'],
    ['--artifact-manifest-path', 'artifactManifestPath'],
    ['--artifact-manifest-sha256', 'artifactManifestSha256'],
    ['--report-dir', 'reportDir']
  ]);

  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let optionName = argument;
    let value = '';
    const equalsIndex = argument.indexOf('=');
    if (equalsIndex >= 0) {
      optionName = argument.slice(0, equalsIndex);
      value = argument.slice(equalsIndex + 1).trim();
    } else if (optionMap.has(optionName)) {
      const next = args[index + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        value = next.trim();
        index += 1;
      }
    }

    const property = optionMap.get(optionName);
    if (!property) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    counts[property] += 1;
    config[property] = property === 'artifactManifestSha256'
      ? value
      : (value ? path.resolve(value) : '');
  }

  for (const property of [
    'publisherPath',
    'artifactManifestPath',
    'artifactManifestSha256'
  ]) {
    if (counts[property] !== 1 || !config[property]) {
      const cliName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(`Exactly one explicit --${cliName} value is required`);
    }
  }
  if (counts.reportDir > 1 || !config.reportDir) {
    throw new Error('--report-dir may be supplied at most once and must not be empty');
  }
  if (!/^[0-9a-f]{64}$/.test(config.artifactManifestSha256)) {
    throw new Error('--artifact-manifest-sha256 must be lowercase 64-hex');
  }
  return config;
}

function validatePackagedArtifact(config) {
  if (process.platform !== 'win32') {
    throw new Error('The packaged wheel workflow requires a real interactive Windows desktop');
  }
  if (!fs.existsSync(config.publisherPath)) {
    throw new Error(`Packaged publisher is missing: ${config.publisherPath}`);
  }
  const explicitPublisherStat = fs.lstatSync(config.publisherPath);
  if (!explicitPublisherStat.isFile() || explicitPublisherStat.isSymbolicLink()) {
    throw new Error('Packaged publisher must be a regular non-reparse file');
  }
  if (path.basename(config.publisherPath) !== 'game-capture.exe') {
    throw new Error('Packaged publisher must be named exactly game-capture.exe');
  }
  if (!fs.existsSync(config.artifactManifestPath)) {
    throw new Error(`Release artifact manifest is missing: ${config.artifactManifestPath}`);
  }
  const explicitManifestStat = fs.lstatSync(config.artifactManifestPath);
  if (!explicitManifestStat.isFile() || explicitManifestStat.isSymbolicLink()) {
    throw new Error('Release artifact manifest must be a regular non-reparse file');
  }
  if (path.basename(config.artifactManifestPath) !== RELEASE_MANIFEST_NAME) {
    throw new Error(`Release artifact manifest must be named ${RELEASE_MANIFEST_NAME}`);
  }

  const manifestBytes = fs.readFileSync(config.artifactManifestPath);
  if (manifestBytes.length >= 3 && manifestBytes[0] === 0xef &&
      manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
    throw new Error('Release artifact manifest must be UTF-8 without a BOM');
  }
  const manifestSha256 = sha256Buffer(manifestBytes);
  if (manifestSha256 !== config.artifactManifestSha256) {
    throw new Error(
      `Release artifact manifest hash mismatch: expected ${config.artifactManifestSha256}, ` +
      `observed ${manifestSha256}`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Release artifact manifest is invalid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new Error('Release artifact manifest has the wrong schema');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Release artifact manifest version is invalid');
  }
  if (!manifest.artifact || manifest.artifact.relativePath !== 'game-capture.exe' ||
      !Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1 ||
      typeof manifest.artifact.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)) {
    throw new Error('Release artifact manifest executable identity is invalid');
  }
  const payload = validatePayloadManifest(manifest);

  const executable = realPath(config.publisherPath);
  const manifestPath = realPath(config.artifactManifestPath);
  const packageRoot = realPath(path.dirname(manifestPath));
  const manifestExecutable = path.resolve(
    packageRoot,
    manifest.artifact.relativePath
  );
  if (comparablePath(executable) !== comparablePath(manifestExecutable)) {
    throw new Error('Explicit publisher is not the manifest-relative executable');
  }
  if (comparablePath(path.dirname(executable)) !== comparablePath(packageRoot)) {
    throw new Error('Release artifact manifest is not co-located with the publisher');
  }

  const payloadSnapshot = verifyPackagePayload(packageRoot, manifest, manifestPath);
  const payloadByRelativePath = new Map(
    payload.files.map((entry) => [entry.relativePath, Object.freeze({ ...entry })])
  );
  const executableEntry = payloadByRelativePath.get('game-capture.exe');
  if (!executableEntry || executableEntry.size !== manifest.artifact.size ||
      executableEntry.sha256 !== manifest.artifact.sha256) {
    throw new Error('Executable identity is not bound into the complete payload manifest');
  }
  const platformPlugin = path.join(path.dirname(config.publisherPath), 'platforms', 'qwindows.dll');
  const qtConfigurationPath = path.join(packageRoot, 'qt.conf');
  if (!payloadByRelativePath.has('platforms/qwindows.dll') ||
      !payloadByRelativePath.has('qt.conf') ||
      !fs.existsSync(platformPlugin) || !fs.lstatSync(platformPlugin).isFile() ||
      fs.lstatSync(platformPlugin).isSymbolicLink()) {
    throw new Error('Publisher payload is missing a manifest-bound regular qwindows.dll or qt.conf');
  }
  if (fs.readFileSync(qtConfigurationPath, 'utf8') !== QT_CONFIGURATION_CONTENT) {
    throw new Error('Packaged qt.conf does not confine Qt plugin discovery to the package root');
  }

  const executableStat = fs.lstatSync(executable);
  const executableSha256 = sha256File(executable);
  if (executableStat.size !== manifest.artifact.size ||
      executableSha256 !== manifest.artifact.sha256) {
    throw new Error('Packaged publisher bytes do not match the release artifact manifest');
  }
  return {
    executable,
    executableSha256,
    executableSize: executableStat.size,
    manifest,
    manifestPath,
    manifestSha256,
    packageRoot,
    payloadByRelativePath,
    payloadSnapshot,
    platformPlugin: realPath(platformPlugin),
    qtConfigurationPath: realPath(qtConfigurationPath)
  };
}

function registryViewFingerprint(view) {
  const result = spawnSync(
    'reg.exe',
    ['query', SETTINGS_REGISTRY_KEY, '/s', `/reg:${view}`],
    {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    }
  );
  if (result.error) {
    throw new Error(`Could not inspect the ${view}-bit settings registry view: ${result.error.message}`);
  }
  if (result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `Settings registry inspection failed for ${view}-bit view: ` +
      `status=${result.status} signal=${result.signal || 'none'}`
    );
  }
  const evidence = Buffer.from(
    `${result.status}\0${result.stdout || ''}\0${result.stderr || ''}`,
    'utf8'
  );
  return sha256Buffer(evidence);
}

function settingsFingerprint() {
  return {
    registry32: registryViewFingerprint(32),
    registry64: registryViewFingerprint(64)
  };
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function assertNativeInputBoundaryEvidence(boundary, expectedEvaluated, key) {
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary) ||
      boundary.evaluated !== expectedEvaluated) {
    throw new Error(`Native input boundary evaluation is invalid for ${key}`);
  }
  if (expectedEvaluated) {
    if (boundary.cursorPositionMatches !== true || boundary.targetHit !== true ||
        boundary.foregroundMatches !== true) {
      throw new Error(`Native input boundary guard failed for ${key}`);
    }
  } else if (boundary.cursorPositionMatches !== false || boundary.targetHit !== false ||
      boundary.foregroundMatches !== false) {
    throw new Error(`Unexecuted native input boundary contains fabricated success for ${key}`);
  }
}

function assertRuntimeModuleIdentity(report, artifact) {
  const runtime = report && report.runtime;
  const modules = runtime && runtime.loadedNonSystemOrQtModules;
  if (!runtime || runtime.moduleEnumerationSucceeded !== true ||
      !Number.isInteger(runtime.observedModuleCount) || runtime.observedModuleCount < 1 ||
      !Number.isInteger(runtime.reportedModuleCount) ||
      !Array.isArray(modules) || runtime.reportedModuleCount !== modules.length ||
      runtime.observedModuleCount < runtime.reportedModuleCount) {
    throw new Error('Native runtime module evidence is incomplete');
  }

  const requiredQtModules = new Set(REQUIRED_QT_RUNTIME_MODULES);
  const observedPaths = new Set();
  const systemRootValue = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRootValue) {
    throw new Error('Cannot classify native runtime modules without SystemRoot');
  }
  const systemRoot = realPath(systemRootValue);
  for (const moduleEntry of modules) {
    if (!moduleEntry || typeof moduleEntry !== 'object' || Array.isArray(moduleEntry) ||
        typeof moduleEntry.name !== 'string' || !moduleEntry.name ||
        typeof moduleEntry.path !== 'string' || !path.isAbsolute(moduleEntry.path) ||
        typeof moduleEntry.qtRuntime !== 'boolean' || typeof moduleEntry.system !== 'boolean') {
      throw new Error('Native runtime module entry is invalid');
    }
    const modulePath = realPath(moduleEntry.path);
    const comparableModulePath = comparablePath(modulePath);
    if (observedPaths.has(comparableModulePath)) {
      throw new Error(`Native runtime module path is duplicated: ${modulePath}`);
    }
    observedPaths.add(comparableModulePath);
    const moduleStat = fs.lstatSync(modulePath);
    if (!moduleStat.isFile() || moduleStat.isSymbolicLink() ||
        path.basename(modulePath).toLowerCase() !== moduleEntry.name.toLowerCase()) {
      throw new Error(`Native runtime module is not a regular file with its reported name: ${modulePath}`);
    }

    const moduleName = moduleEntry.name.toLowerCase();
    const isQtRuntime = /^qt6.*\.dll$/i.test(moduleEntry.name) || moduleName === 'qwindows.dll';
    const isSystem = pathIsWithin(modulePath, systemRoot);
    if (moduleEntry.qtRuntime !== isQtRuntime || moduleEntry.system !== isSystem) {
      throw new Error(`Native runtime module classification is false: ${modulePath}`);
    }

    const inPackage = pathIsWithin(modulePath, artifact.packageRoot);
    if (inPackage) {
      const relativePath = toPayloadRelativePath(artifact.packageRoot, modulePath);
      const payloadEntry = artifact.payloadByRelativePath.get(relativePath);
      if (!payloadEntry || moduleStat.size !== payloadEntry.size ||
          sha256File(modulePath) !== payloadEntry.sha256) {
        throw new Error(`Loaded packaged module is not bound to the payload manifest: ${modulePath}`);
      }
      if (moduleName === 'qwindows.dll' && relativePath !== 'platforms/qwindows.dll') {
        throw new Error('Loaded qwindows.dll did not come from the packaged platforms directory');
      }
    } else if (isQtRuntime) {
      throw new Error(`Qt runtime escaped the packaged artifact: ${modulePath}`);
    }

    if (isQtRuntime) {
      requiredQtModules.delete(moduleName);
    }
  }
  if (requiredQtModules.size !== 0) {
    throw new Error(`Native runtime omitted required packaged Qt modules: ${[...requiredQtModules].join(', ')}`);
  }
}

function assertReportContract(report, artifact, runId) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Native wheel report root is not an object');
  }
  if (report.schema !== RESULT_SCHEMA || report.runId !== runId) {
    throw new Error('Native wheel report schema or run ID does not match this invocation');
  }
  if (report.appVersion !== artifact.manifest.version) {
    throw new Error('Native wheel report app version does not match the release manifest');
  }
  if (!report.artifact || report.artifact.sha256 !== artifact.executableSha256 ||
      report.artifact.expectedSha256 !== artifact.executableSha256 ||
      report.artifact.size !== artifact.executableSize ||
      report.artifact.identityMatches !== true ||
      comparablePath(report.artifact.path) !== comparablePath(artifact.executable)) {
    throw new Error('Native wheel report is not bound to the executed packaged artifact');
  }
  if (!report.input || report.input.method !== 'Win32.SendInput' ||
      report.input.wheelApi !== 'user32!SendInput/MOUSEEVENTF_WHEEL' ||
      report.input.nativePlatform !== true) {
    throw new Error('Native wheel report did not use the Win32 SendInput wheel path');
  }
  if (!report.persistence || report.persistence.enabled !== false ||
      report.persistence.settingSignalsConnected !== false ||
      report.persistence.systemIntegrationsEnabled !== false) {
    throw new Error('Native wheel report did not isolate user settings and system integrations');
  }
  assertRuntimeModuleIdentity(report, artifact);
  if (!report.window || report.window.foregroundAcquired !== true ||
      !Number.isInteger(report.window.scrollMinimum) ||
      !Number.isInteger(report.window.scrollMaximum) ||
      report.window.scrollMaximum <= report.window.scrollMinimum) {
    throw new Error('Packaged MainWindow did not acquire a usable foreground scroll viewport');
  }
  if (!arraysEqual(report.expectedControls, EXPECTED_CONTROLS) ||
      !arraysEqual(report.expectedDirections, EXPECTED_DIRECTIONS) ||
      !arraysEqual(report.expectedModes, EXPECTED_MODES)) {
    throw new Error('Native wheel report omitted or reordered a required control, direction, or mode');
  }
  if (!Array.isArray(report.setupFailures) || report.setupFailures.length !== 0 ||
      !Array.isArray(report.cases) || report.cases.length !== EXPECTED_CASE_COUNT ||
      report.caseCount !== EXPECTED_CASE_COUNT ||
      report.expectedCaseCount !== EXPECTED_CASE_COUNT ||
      report.passedCaseCount !== EXPECTED_CASE_COUNT ||
      !Number.isInteger(report.elapsedMs) || report.elapsedMs < 0 ||
      !Number.isInteger(report.boundedDeadlineMs) || report.boundedDeadlineMs !== 15000 ||
      report.elapsedMs > report.boundedDeadlineMs) {
    throw new Error('Native wheel report is incomplete, failed setup, or exceeded its deadline');
  }

  const expectedKeys = new Set();
  for (const control of EXPECTED_CONTROLS) {
    for (const mode of EXPECTED_MODES) {
      for (const direction of EXPECTED_DIRECTIONS) {
        expectedKeys.add(`${control}\0${mode}\0${direction}`);
      }
    }
  }
  const observedKeys = new Set();
  for (const interaction of report.cases) {
    const key = `${interaction.control}\0${interaction.mode}\0${interaction.direction}`;
    if (!expectedKeys.has(key) || observedKeys.has(key)) {
      throw new Error(`Native wheel report has an unexpected or duplicate case: ${key}`);
    }
    observedKeys.add(key);
    if (interaction.inputMethod !== 'Win32.SendInput' ||
        interaction.sendInputAccepted !== true ||
        interaction.sendInputAcceptedCount !== 1 ||
        !Number.isInteger(interaction.observedWheelEvents) ||
        interaction.observedWheelEvents < 1 ||
        !Number.isInteger(interaction.spontaneousWheelEvents) ||
        interaction.spontaneousWheelEvents < 1 ||
        interaction.focusSetupOk !== true || interaction.pass !== true ||
        !Array.isArray(interaction.failures) || interaction.failures.length !== 0) {
      throw new Error(`Native wheel input evidence failed for ${key}`);
    }
    if (interaction.focusClickSendInputAcceptedCount !== (interaction.mode === 'focused' ? 2 : 0)) {
      throw new Error(`Native focus-click acceptance evidence failed for ${key}`);
    }
    assertNativeInputBoundaryEvidence(interaction.focusClickBoundary, interaction.mode === 'focused', key);
    assertNativeInputBoundaryEvidence(interaction.wheelBoundary, true, key);

    const up = interaction.direction === 'up';
    if (interaction.mode === 'unfocused') {
      const pageMoved = up
        ? interaction.scrollAfter < interaction.scrollBefore
        : interaction.scrollAfter > interaction.scrollBefore;
      if (interaction.valueAfter !== interaction.valueBefore ||
          interaction.valueStable !== true || interaction.focusRetained !== true ||
          interaction.pageMovedInDirection !== true || !pageMoved) {
        throw new Error(`Unfocused wheel contract failed for ${key}`);
      }
    } else {
      const valueEdited = up
        ? interaction.valueAfter > interaction.valueBefore
        : interaction.valueAfter < interaction.valueBefore;
      if (!valueEdited || interaction.valueEditedInDirection !== true ||
          interaction.scrollAfter !== interaction.scrollBefore ||
          interaction.pageStayed !== true || interaction.focusRetained !== true) {
        throw new Error(`Focused wheel contract failed for ${key}`);
      }
    }
  }
  if (observedKeys.size !== expectedKeys.size ||
      [...expectedKeys].some((key) => !observedKeys.has(key))) {
    throw new Error('Native wheel report does not cover the complete interaction matrix');
  }
  const reportOk = report.pass === true && report.cases.every((entry) => entry.pass === true);
  if (!reportOk) {
    throw new Error('Native wheel report did not produce a computed passing verdict');
  }
}

function writeJsonExclusive(filePath, value) {
  const descriptor = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function run(config) {
  const artifact = validatePackagedArtifact(config);
  fs.mkdirSync(config.reportDir, { recursive: true });
  const runId = crypto.randomBytes(16).toString('hex');
  const resultPath = path.join(config.reportDir, `ui-wheel-native-${runId}.json`);
  const verificationPath = path.join(config.reportDir, `ui-wheel-verification-${runId}.json`);
  if (fs.existsSync(resultPath) || fs.existsSync(verificationPath)) {
    throw new Error('Fresh native wheel evidence paths unexpectedly already exist');
  }

  const settingsBefore = settingsFingerprint();
  const executableHashBefore = sha256File(artifact.executable);
  const payloadBefore = verifyPackagePayload(
    artifact.packageRoot,
    artifact.manifest,
    artifact.manifestPath
  );
  const hermeticEnvironment = createHermeticChildEnvironment(artifact.packageRoot);
  const startedAtMs = Date.now();
  const childResult = spawnSync(
    artifact.executable,
    [
      `--ui-wheel-e2e-out=${resultPath}`,
      `--ui-wheel-e2e-expected-sha256=${artifact.executableSha256}`,
      `--ui-wheel-e2e-run-id=${runId}`
    ],
    {
      cwd: path.dirname(artifact.executable),
      encoding: 'utf8',
      env: hermeticEnvironment,
      timeout: 30000,
      windowsHide: false
    }
  );
  const finishedAtMs = Date.now();
  const settingsAfter = settingsFingerprint();
  const executableHashAfter = sha256File(artifact.executable);
  const payloadAfter = verifyPackagePayload(
    artifact.packageRoot,
    artifact.manifest,
    artifact.manifestPath
  );

  if (settingsBefore.registry32 !== settingsAfter.registry32 ||
      settingsBefore.registry64 !== settingsAfter.registry64) {
    throw new Error('Packaged wheel workflow changed the user Game Capture settings registry');
  }
  if (executableHashBefore !== artifact.executableSha256 ||
      executableHashAfter !== artifact.executableSha256) {
    throw new Error('Packaged publisher bytes changed during the native wheel workflow');
  }
  assertPayloadSnapshotsEqual(payloadBefore, payloadAfter);
  if (childResult.error) {
    throw new Error(`Packaged wheel process failed to run: ${childResult.error.message}`);
  }
  if (childResult.signal || childResult.status === null) {
    throw new Error(
      `Packaged wheel process did not exit normally: signal=${childResult.signal || 'none'}`
    );
  }
  if (childResult.status !== 0) {
    throw new Error(`Packaged wheel process exited with code ${childResult.status}`);
  }
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Packaged wheel process exited without its required JSON output: ${resultPath}`);
  }
  const resultStat = fs.lstatSync(resultPath);
  if (!resultStat.isFile() || resultStat.isSymbolicLink() || resultStat.size < 2 ||
      resultStat.mtimeMs < startedAtMs - 1000 || resultStat.mtimeMs > finishedAtMs + 1000) {
    throw new Error('Packaged wheel JSON output is not a fresh regular file from this invocation');
  }

  const reportBytes = fs.readFileSync(resultPath);
  if (reportBytes.length >= 3 && reportBytes[0] === 0xef &&
      reportBytes[1] === 0xbb && reportBytes[2] === 0xbf) {
    throw new Error('Packaged wheel JSON output must be UTF-8 without a BOM');
  }
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Packaged wheel JSON output is invalid: ${error.message}`);
  }
  assertReportContract(report, artifact, runId);

  const verification = {
    schema: 'game-capture-ui-wheel-verification/v1',
    ok: true,
    runId,
    artifact: {
      path: artifact.executable,
      size: artifact.executableSize,
      sha256: artifact.executableSha256,
      manifestPath: artifact.manifestPath,
      manifestSha256: artifact.manifestSha256,
      platformPlugin: artifact.platformPlugin,
      qtConfigurationPath: artifact.qtConfigurationPath,
      payloadFileCount: payloadAfter.fileCount,
      payloadAggregateSha256: payloadAfter.aggregateSha256
    },
    process: {
      exitCode: childResult.status,
      elapsedMs: finishedAtMs - startedAtMs,
      hermeticEnvironment: true
    },
    settings: {
      unchanged: true,
      before: settingsBefore,
      after: settingsAfter
    },
    nativeReport: {
      path: resultPath,
      sha256: sha256Buffer(reportBytes),
      caseCount: report.cases.length,
      passedCaseCount: report.passedCaseCount,
      runtimeModuleCount: report.runtime.reportedModuleCount
    }
  };
  writeJsonExclusive(verificationPath, verification);
  return { artifact, report, resultPath, verificationPath };
}

function main() {
  try {
    const result = run(parseArgs(process.argv));
    console.log(
      `[UI WHEEL PACKAGED E2E PASS] artifact=${result.artifact.executableSha256} ` +
      `cases=${result.report.passedCaseCount}/${result.report.expectedCaseCount} ` +
      `report=${result.resultPath} verification=${result.verificationPath}`
    );
  } catch (error) {
    console.error(`[UI WHEEL PACKAGED E2E FAIL] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_CASE_COUNT,
  EXPECTED_CONTROLS,
  EXPECTED_DIRECTIONS,
  EXPECTED_MODES,
  assertReportContract,
  assertPayloadSnapshotsEqual,
  createHermeticChildEnvironment,
  parseArgs,
  run,
  validatePackagedArtifact,
  verifyPackagePayload
};
