#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const DIRECTOR_PATH = path.resolve(__dirname, 'director-room-e2e.js');
const FIREFOX_ADAPTER_PATH = path.resolve(__dirname, 'firefox-bidi-adapter.js');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one mutation anchor: ${before}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceFirst(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing mutation anchor: ${before}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function evaluatePolicy(source) {
  return [
    {
      id: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      ok: source.includes('function validatePackagedPublisherArtifact(config) {') &&
        source.includes('if (manifestSha256 !== config.artifactManifestSha256) {') &&
        source.includes('if (executableSha256 !== manifest.artifact.sha256) {') &&
        source.includes('Explicit publisher path does not exactly match the manifest-relative executable') &&
        source.includes('const packagedArtifact = config.requirePackagedArtifact') &&
        source.includes('function revalidatePackagedPublisherArtifact(config, expectedArtifact, phase) {') &&
        source.includes("if (!exactArtifact) {\n      throw new Error('Packaged publisher launch requires a prepared exact artifact identity');") &&
        source.includes("revalidatePackagedPublisherArtifact(config, exactArtifact, 'before publisher spawn')") &&
        source.includes("revalidatePackagedPublisherArtifact(config, exactArtifact, 'after publisher spawn')")
    },
    {
      id: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      ok: source.includes("expectedSpoutSenderSha256: ''") &&
        source.includes("'--expected-spout-sender-sha256'") &&
        source.includes("['spoutSenderPath', 'spout-sender-path'],\n      ['expectedSpoutSenderSha256', 'expected-spout-sender-sha256']") &&
        source.includes("validateExpectedFileArtifact(\n      config.spoutSenderPath,\n      config.expectedSpoutSenderSha256,\n      'Packaged Spout sender fixture'\n    )") &&
        source.includes('spawnSpoutTestSender(config, preparedArtifacts.spoutSender)') &&
        source.includes("if (!exactArtifact) {\n      throw new Error('Packaged Spout sender launch requires a prepared exact artifact identity');") &&
        source.includes("revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'before spawn')") &&
        source.includes("revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'after spawn')")
    },
    {
      id: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      ok: source.includes("expectedFirefoxSha256: ''") &&
        source.includes("'--expected-firefox-sha256'") &&
        source.includes("validateExpectedFileArtifact(\n      config.firefoxPath,\n      config.expectedFirefoxSha256,\n      'Installed Firefox'\n    )") &&
        source.includes('async function launchDirectorBrowser(config, exactFirefoxArtifact = null) {') &&
        source.includes("if (!exactFirefoxArtifact) {\n      throw new Error('Installed Firefox launch requires a prepared exact artifact identity');") &&
        source.includes('const beforeLaunch = revalidateExpectedFileArtifact(') &&
        source.includes('executablePath: beforeLaunch.path') &&
        source.includes('expectedSha256: beforeLaunch.sha256') &&
        source.includes('const postLaunch = validateLaunchedFirefoxArtifact(browser, beforeLaunch);') &&
        source.includes('browser.artifactReceipt = Object.freeze({')
    },
    {
      id: 'DIRECTOR_EXPLICIT_PATHS_DO_NOT_AUTOFALLBACK',
      ok: source.includes('function requireExplicitLeafFile(explicitPath, label) {') &&
        source.includes('throw new Error(`${label} does not exist or is not a file: ${resolved}`);') &&
        source.includes("return requireExplicitLeafFile(explicitPath, 'Explicit game-capture publisher');") &&
        source.includes("return requireExplicitLeafFile(explicitPath, 'Explicit Spout test sender');")
    },
    {
      id: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      ok: source.includes('throw new Error(`Unknown argument: ${arg}`);') &&
        source.includes('if (count > 1) {') &&
        source.includes('if (explicitArgumentCounts[name] !== 1 || !args[name]) {') &&
        source.includes('if (!args.requirePackagedArtifact && [') &&
        source.includes('} else if (explicitArgumentCounts.firefoxPath !== 0 ||') &&
        source.includes('Packaged artifact identity arguments require --require-packaged-artifact') &&
        source.includes('Installed Firefox identity arguments require --browser=firefox-installed')
    },
    {
      id: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      ok: source.includes('function verifyDirectorArtifactsStable(config, preparedArtifacts, runtimeArtifacts) {') &&
        source.includes('function finalizeSuccessfulReport(report, config, preparedArtifacts, runtimeArtifacts) {') &&
        source.includes('const publisherAtEnd = revalidatePackagedPublisherArtifact(') &&
        source.includes('const spoutAtEnd = revalidateExpectedFileArtifact(') &&
        source.includes('const firefoxAtEnd = revalidateExpectedFileArtifact(') &&
        source.includes('atEnd: artifactEvidence(publisherAtEnd)') &&
        source.includes('atEnd: artifactEvidence(spoutAtEnd)') &&
        source.includes('atEnd: artifactEvidence(firefoxAtEnd)') &&
        source.includes('? publisher.artifactReceipt.afterSpawn') &&
        source.includes('? sourceFixture.artifactReceipt.afterSpawn') &&
        source.includes('const browserLaunchArtifact = browser.artifactReceipt.postLaunch;') &&
        source.includes('const started = Date.now();\n  report.ok = false;') &&
        source.includes('report.ok = artifactStability.ok && report.checks.every((entry) => entry.ok);') &&
        !source.includes('report.ok = true;')
    },
    {
      id: 'DIRECTOR_STARTUP_IS_CLEANUP_OWNED',
      ok: source.includes('let sourceFixture = null;\n  let publisher = null;') &&
        source.includes('try {\n    sourceFixture = spawnSpoutTestSender(config, preparedArtifacts.spoutSender);\n    publisher = spawnPublisher(config, preparedArtifacts.packagedArtifact);') &&
        source.includes('await cleanupDirectorRuntime({ browser, publisher, sourceFixture });') &&
        source.includes("await stopAdmittedChild(publisher, 'SIGTERM', options.publisherGraceMs ?? 1000);") &&
        source.includes("await stopAdmittedChild(sourceFixture, 'SIGTERM', options.sourceFixtureGraceMs ?? 500);")
    },
    {
      id: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      ok: source.includes('function attachChildProcessErrorGuard(child, label) {') &&
        countOccurrences(source, 'attachChildProcessErrorGuard(child,') === 3 &&
        source.includes('child.workflowErrorGuard = guard;') &&
        source.includes('terminateSpawnedChild(child);\n    resolveFailure(observedError);') &&
        source.includes('async function awaitWithRuntimeProcessFailures(operation, runtimeArtifacts) {') &&
        source.includes('const result = await Promise.race([operationPromise, ...guardedFailures]);') &&
        countOccurrences(source, 'assertNoRuntimeProcessFailure(runtimeArtifacts);') === 3 &&
        source.includes('awaitWithRuntimeProcessFailures(')
    },
    {
      id: 'DIRECTOR_FALSE_GREEN_COMPOSITION_IS_REJECTED',
      ok: source.includes('if (require.main === module) {\n  run().catch((error) => {') &&
        countOccurrences(source, 'const child = spawn(command, args, {') === 2 &&
        source.includes('const artifactStability = verifyDirectorArtifactsStable(\n    config,\n    preparedArtifacts,\n    runtimeArtifacts\n  );')
    },
    {
      id: 'DIRECTOR_MODULE_IS_SAFE_TO_PROBE',
      ok: source.includes('if (require.main === module) {') &&
        source.includes('module.exports = {') &&
        source.includes('prepareDirectorArtifacts')
    }
  ];
}

function loadDirectorSource(source, requireOverrides = {}) {
  const probeModule = new Module(DIRECTOR_PATH, module);
  probeModule.filename = DIRECTOR_PATH;
  probeModule.paths = Module._nodeModulePaths(path.dirname(DIRECTOR_PATH));
  const nativeRequire = probeModule.require.bind(probeModule);
  probeModule.require = (request) => Object.prototype.hasOwnProperty.call(requireOverrides, request)
    ? requireOverrides[request]
    : nativeRequire(request);
  probeModule._compile(source, DIRECTOR_PATH);
  return probeModule.exports;
}

function loadFirefoxAdapterSource(source, requireOverrides = {}) {
  const probeModule = new Module(FIREFOX_ADAPTER_PATH, module);
  probeModule.filename = FIREFOX_ADAPTER_PATH;
  probeModule.paths = Module._nodeModulePaths(path.dirname(FIREFOX_ADAPTER_PATH));
  const nativeRequire = probeModule.require.bind(probeModule);
  probeModule.require = (request) => Object.prototype.hasOwnProperty.call(requireOverrides, request)
    ? requireOverrides[request]
    : nativeRequire(request);
  probeModule._compile(source, FIREFOX_ADAPTER_PATH);
  return probeModule.exports;
}

function runDirectorCliProbe(source) {
  const probePath = path.join(
    __dirname,
    `.director-identity-cli-probe-${process.pid}-${crypto.randomBytes(8).toString('hex')}.js`
  );
  fs.writeFileSync(probePath, source, 'utf8');
  try {
    return spawnSync(
      process.execPath,
      [probePath, '--director-identity-cli-probe-unknown'],
      { cwd: __dirname, encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(action, pattern, label) {
  let error = null;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert(error, `${label} unexpectedly succeeded`);
  assert(pattern.test(String(error && error.message || error)),
    `${label} failed for the wrong reason: ${error && error.message || error}`);
}

async function assertRejects(action, pattern, label) {
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert(error, `${label} unexpectedly succeeded`);
  assert(pattern.test(String(error && error.message || error)),
    `${label} failed for the wrong reason: ${error && error.message || error}`);
}

function fakeChild(state, command, args) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.resume = () => {};
  stderr.resume = () => {};
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) {
      this.killed = true;
      state.killSignals.push(signal);
      if (signal === 'SIGKILL') this.signalCode = signal;
      return true;
    }
  });
  state.children.push(child);
  state.spawnCalls.push({ command, args: [...args] });
  return child;
}

function fakeBrowser(options, state, overrides = {}) {
  return {
    executablePath: options.executablePath,
    executableSha256: options.expectedSha256,
    automation: 'fake-bidi',
    version: () => 'fake-firefox',
    async close() {
      state.browserCloseCount += 1;
    },
    ...overrides
  };
}

function makeHarnessState() {
  return {
    spawnCalls: [],
    children: [],
    killSignals: [],
    browserLaunchOptions: [],
    browserCloseCount: 0,
    onSpawn: null,
    onBrowserLaunch: null
  };
}

function makeRequireOverrides(state) {
  return {
    child_process: {
      spawn(command, args) {
        const child = fakeChild(state, command, args);
        if (state.onSpawn) state.onSpawn(command, args, child);
        return child;
      }
    },
    './firefox-bidi-adapter': {
      async launchInstalledFirefox(options) {
        state.browserLaunchOptions.push({ ...options });
        if (state.onBrowserLaunch) {
          return state.onBrowserLaunch(options, state);
        }
        return fakeBrowser(options, state);
      }
    }
  };
}

function removeCliArgument(args, cliName) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === `--${cliName}`) {
      index += 1;
      continue;
    }
    if (argument.startsWith(`--${cliName}=`)) continue;
    result.push(argument);
  }
  return result;
}

function replaceCliArgument(args, cliName, replacement) {
  return [
    ...removeCliArgument(args, cliName),
    replacement
  ];
}

function findCliArgument(args, cliName) {
  return args.find((argument) => argument === `--${cliName}` ||
    argument.startsWith(`--${cliName}=`));
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeArtifactFixture(root) {
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot, { recursive: true });
  const publisherPath = writeFile(path.join(packageRoot, 'game-capture.exe'),
    Buffer.from('director packaged identity publisher fixture'));
  const publisherBytes = fs.readFileSync(publisherPath);
  const manifest = {
    schema: 'game-capture-release-artifact/v1',
    version: '1.2.3',
    packagedAtUtc: '2026-08-11T12:00:00.000Z',
    artifact: {
      relativePath: 'game-capture.exe',
      size: publisherBytes.length,
      sha256: sha256Buffer(publisherBytes)
    },
    build: { configuration: 'Release' },
    source: {
      gitCommit: 'a'.repeat(40),
      dirty: false,
      snapshotSha256: 'b'.repeat(64),
      snapshotFileCount: 1,
      snapshotAlgorithm: 'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2'
    }
  };
  const manifestPath = writeFile(
    path.join(packageRoot, 'release-artifact-manifest.json'),
    Buffer.from(JSON.stringify(manifest), 'utf8')
  );
  const spoutPath = writeFile(path.join(root, 'spout_test_sender.exe'),
    Buffer.from('director packaged identity spout fixture'));
  const firefoxPath = writeFile(path.join(root, 'firefox.exe'),
    Buffer.from('director packaged identity firefox fixture'));
  return {
    manifest,
    publisherPath,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    spoutPath,
    spoutSha256: sha256File(spoutPath),
    firefoxPath,
    firefoxSha256: sha256File(firefoxPath)
  };
}

function packagedArgs(fixture, overrides = []) {
  return [
    'node', 'director-room-e2e.js',
    '--require-packaged-artifact',
    '--browser=firefox-installed',
    `--publisher-path=${fixture.publisherPath}`,
    `--artifact-manifest-path=${fixture.manifestPath}`,
    `--artifact-manifest-sha256=${fixture.manifestSha256}`,
    `--spout-sender-path=${fixture.spoutPath}`,
    `--expected-spout-sender-sha256=${fixture.spoutSha256}`,
    `--firefox-path=${fixture.firefoxPath}`,
    `--expected-firefox-sha256=${fixture.firefoxSha256}`,
    ...overrides
  ];
}

function evaluateFirefoxAdapterPolicy(source) {
  return {
    id: 'FIREFOX_BIDI_ASYNC_ERROR_IS_AWAITED_AND_CLEANED',
    ok: source.includes('function attachChildProcessErrorGuard(child, label) {') &&
      source.includes("const workflowErrorGuard = attachChildProcessErrorGuard(child, 'Installed Firefox');") &&
      source.includes("if (child.exitCode === null && child.signalCode === null && !child.killed) {\n      child.kill('SIGKILL');\n    }") &&
      source.includes('workflowErrorGuard.failure.then((error) => finish(error));') &&
      source.includes('async function awaitWithChildProcessError(operation, guard) {') &&
      source.includes('async function terminateFirefoxChild(child, gracefulWaitMs = 1000, forcedWaitMs = 5000) {') &&
      source.includes('await cleanupFirefoxChild(child, profilePath, 500);') &&
      source.includes('if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { recursive: true, force: true });')
  };
}

async function probeFirefoxAdapterAsyncError(source) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-adapter-error-probe-'));
  let profilePath = '';
  try {
    const firefoxPath = writeFile(
      path.join(temporaryRoot, 'firefox.exe'),
      Buffer.from('firefox adapter asynchronous error fixture')
    );
    const state = makeHarnessState();
    const adapter = loadFirefoxAdapterSource(source, {
      child_process: {
        spawn(command, args) {
          return fakeChild(state, command, args);
        }
      }
    });
    const launchPromise = adapter.launchInstalledFirefox({
      executablePath: firefoxPath,
      expectedSha256: sha256File(firefoxPath),
      headless: true
    });
    const child = state.children[0];
    assert(child, 'Firefox adapter did not admit its spawned child');
    const profileArgumentIndex = state.spawnCalls[0].args.indexOf('-profile');
    profilePath = state.spawnCalls[0].args[profileArgumentIndex + 1] || '';
    assert(profilePath && fs.existsSync(profilePath),
      'Firefox adapter did not create an owned isolated profile');
    if (child.listenerCount('error') === 0) {
      child.emit('exit', 1);
      await launchPromise.catch(() => {});
      assert(false, 'Installed Firefox child has no asynchronous error listener');
    }
    child.emit('error', new Error('synthetic installed Firefox launch failure'));
    const killedImmediately = child.killed;
    await Promise.resolve();
    child.emit('exit', 1);
    await assertRejects(
      () => launchPromise,
      /synthetic installed Firefox launch failure/i,
      'installed Firefox asynchronous process failure'
    );
    assert(killedImmediately,
      'Installed Firefox remained alive after its asynchronous process failure');
    assert(state.killSignals.includes('SIGKILL'),
      'Failed installed Firefox child was not terminated by launch cleanup');
    assert(!fs.existsSync(profilePath),
      'Failed installed Firefox launch leaked its isolated profile');
  } finally {
    if (profilePath && fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runFirefoxAdapterChecksAndMutations(source) {
  const baseline = evaluateFirefoxAdapterPolicy(source);
  assert(baseline.ok, `Missing adapter policy ${baseline.id}`);
  await probeFirefoxAdapterAsyncError(source);
  console.log(`[DIRECTOR IDENTITY POLICY PASS] ${baseline.id}`);
  const mutations = [
    {
      name: 'firefox-child-error-listener-is-removed',
      source: replaceOnce(
        source,
        "const workflowErrorGuard = attachChildProcessErrorGuard(child, 'Installed Firefox');",
        'const workflowErrorGuard = Object.freeze({ error: null, failure: new Promise(() => {}) });'
      )
    },
    {
      name: 'firefox-endpoint-wait-ignores-child-error',
      source: replaceOnce(
        source,
        '    workflowErrorGuard.failure.then((error) => finish(error));',
        '    void workflowErrorGuard;'
      )
    },
    {
      name: 'firefox-child-error-does-not-terminate-process',
      source: replaceOnce(
        source,
        "    if (child.exitCode === null && child.signalCode === null && !child.killed) {\n      child.kill('SIGKILL');\n    }",
        '    void child;'
      )
    },
    {
      name: 'firefox-error-cleanup-leaks-profile',
      source: replaceOnce(
        source,
        '    if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { recursive: true, force: true });',
        '    void profilePath;'
      )
    }
  ];
  for (const mutation of mutations) {
    assert(!evaluateFirefoxAdapterPolicy(mutation.source).ok,
      `Adapter mutation ${mutation.name} did not make ${baseline.id} red`);
    let mutationWentRed = false;
    try {
      await probeFirefoxAdapterAsyncError(mutation.source);
    } catch {
      mutationWentRed = true;
    }
    assert(mutationWentRed,
      `Adapter behavior probe stayed green for mutation ${mutation.name}`);
    console.log(`[DIRECTOR IDENTITY MUTATION RED] ${mutation.name}: ${baseline.id} + behavior`);
  }
}

async function runBehaviorChecks(source) {
  const cliProbe = runDirectorCliProbe(source);
  const cliOutput = `${cliProbe.stdout || ''}\n${cliProbe.stderr || ''}`;
  assert(cliProbe.status !== 0,
    'Director CLI main guard silently exited successfully without running the workflow');
  assert(/Unknown argument: --director-identity-cli-probe-unknown/i.test(cliOutput),
    `Director CLI probe failed for the wrong reason: ${cliOutput}`);

  const harnessState = makeHarnessState();
  const director = loadDirectorSource(source, makeRequireOverrides(harnessState));
  const requiredExports = [
    'parseArgs',
    'prepareDirectorArtifacts',
    'validatePackagedPublisherArtifact',
    'validateExpectedFileArtifact',
    'revalidatePackagedPublisherArtifact',
    'revalidateExpectedFileArtifact',
    'spawnPublisher',
    'spawnSpoutTestSender',
    'awaitWithRuntimeProcessFailures',
    'assertNoRuntimeProcessFailure',
    'cleanupDirectorRuntime',
    'launchDirectorBrowser',
    'verifyDirectorArtifactsStable',
    'finalizeSuccessfulReport'
  ];
  for (const name of requiredExports) {
    assert(typeof director[name] === 'function', `Director probe export is missing: ${name}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'director-identity-regression-'));
  try {
    const fixture = makeArtifactFixture(temporaryRoot);
    const validConfig = director.parseArgs(packagedArgs(fixture));
    const valid = director.prepareDirectorArtifacts(validConfig);
    assert(valid.packagedArtifact.executable === fs.realpathSync(fixture.publisherPath),
      'Valid packaged publisher did not resolve to the exact fixture');
    assert(valid.spoutSender.sha256 === fixture.spoutSha256,
      'Valid Spout identity did not preserve the expected SHA-256');
    assert(valid.firefox.sha256 === fixture.firefoxSha256,
      'Valid Firefox identity did not preserve the expected SHA-256');

    const missingPublisher = { ...fixture, publisherPath: path.join(temporaryRoot, 'dead-publisher.exe') };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(missingPublisher))),
      /publisher does not exist/i,
      'dead explicit publisher path'
    );

    const wrongManifest = { ...fixture, manifestSha256: '0'.repeat(64) };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongManifest))),
      /manifest SHA-256 mismatch/i,
      'wrong release manifest hash'
    );

    const publisherBytes = fs.readFileSync(fixture.publisherPath);
    const tamperedPublisherBytes = Buffer.from(publisherBytes);
    tamperedPublisherBytes[0] ^= 0xff;
    fs.writeFileSync(fixture.publisherPath, tamperedPublisherBytes);
    assertThrows(
      () => director.prepareDirectorArtifacts(validConfig),
      /Packaged publisher SHA-256 mismatch/i,
      'publisher content no longer matches release manifest'
    );
    fs.writeFileSync(fixture.publisherPath, publisherBytes);

    const noSpoutArguments = packagedArgs(fixture).filter((argument) =>
      !argument.startsWith('--spout-sender-path=') &&
      !argument.startsWith('--expected-spout-sender-sha256=')
    );
    assertThrows(
      () => director.parseArgs(noSpoutArguments),
      /spout-sender-path/i,
      'packaged stale Spout autodiscovery'
    );

    const deadSpout = { ...fixture, spoutPath: path.join(temporaryRoot, 'dead-spout.exe') };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(deadSpout))),
      /Spout sender fixture does not exist/i,
      'dead explicit Spout path'
    );

    const wrongSpout = { ...fixture, spoutSha256: '1'.repeat(64) };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongSpout))),
      /Spout sender fixture SHA-256 mismatch/i,
      'wrong Spout sender hash'
    );

    const deadFirefox = { ...fixture, firefoxPath: path.join(temporaryRoot, 'dead-firefox.exe') };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(deadFirefox))),
      /Installed Firefox does not exist/i,
      'dead explicit Firefox path'
    );

    assertThrows(
      () => director.detectPublisherBinary(missingPublisher.publisherPath),
      /game-capture publisher does not exist/i,
      'dead non-packaged explicit publisher path'
    );
    assertThrows(
      () => director.detectSpoutTestSender(deadSpout.spoutPath),
      /Spout test sender does not exist/i,
      'dead non-packaged explicit Spout path'
    );

    const wrongFirefox = { ...fixture, firefoxSha256: '2'.repeat(64) };
    assertThrows(
      () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongFirefox))),
      /Installed Firefox SHA-256 mismatch/i,
      'wrong installed Firefox hash'
    );

    assertThrows(
      () => director.parseArgs(packagedArgs(fixture, [`--publisher-path=${fixture.publisherPath}`])),
      /Exactly one explicit --publisher-path/i,
      'duplicate publisher argument'
    );

    const strictIdentityArguments = [
      'publisher-path',
      'artifact-manifest-path',
      'artifact-manifest-sha256',
      'spout-sender-path',
      'expected-spout-sender-sha256',
      'firefox-path',
      'expected-firefox-sha256'
    ];
    for (const cliName of strictIdentityArguments) {
      assertThrows(
        () => director.parseArgs(removeCliArgument(packagedArgs(fixture), cliName)),
        new RegExp(`Exactly one explicit --${cliName}`, 'i'),
        `missing ${cliName} argument`
      );
      assertThrows(
        () => director.parseArgs(replaceCliArgument(
          packagedArgs(fixture),
          cliName,
          `--${cliName}=`
        )),
        new RegExp(`Exactly one explicit --${cliName}`, 'i'),
        `empty ${cliName} argument`
      );
      const duplicate = findCliArgument(packagedArgs(fixture), cliName);
      assert(duplicate, `Test fixture is missing --${cliName}`);
      assertThrows(
        () => director.parseArgs([...packagedArgs(fixture), duplicate]),
        new RegExp(`Exactly one explicit --${cliName}`, 'i'),
        `duplicate ${cliName} argument`
      );
    }
    assertThrows(
      () => director.parseArgs([...packagedArgs(fixture), '--require-packaged-artifact']),
      /Exactly one explicit --require-packaged-artifact/i,
      'duplicate require-packaged-artifact flag'
    );
    assertThrows(
      () => director.parseArgs([...packagedArgs(fixture), '--browser=firefox-installed']),
      /Exactly one explicit --browser/i,
      'duplicate browser argument'
    );

    const typoPackagedFlag = packagedArgs(fixture).map((argument) =>
      argument === '--require-packaged-artifact'
        ? '--require-packaged-artifcat'
        : argument);
    assertThrows(
      () => director.parseArgs(typoPackagedFlag),
      /Unknown argument: --require-packaged-artifcat/i,
      'misspelled packaged-artifact flag'
    );
    assertThrows(
      () => director.parseArgs([...packagedArgs(fixture), '--publisher-pth=wrong.exe']),
      /Unknown argument: --publisher-pth/i,
      'unknown identity option'
    );
    assertThrows(
      () => director.parseArgs(packagedArgs(fixture).filter((argument) =>
        argument !== '--require-packaged-artifact')),
      /Packaged artifact identity arguments require --require-packaged-artifact/i,
      'packaged identities without their enabling flag'
    );
    assertThrows(
      () => director.parseArgs(replaceCliArgument(
        packagedArgs(fixture),
        'browser',
        '--browser=chromium'
      )),
      /Installed Firefox identity arguments require --browser=firefox-installed/i,
      'installed Firefox identities on a different browser'
    );

    const spawnCountBeforeMissingReceipts = harnessState.spawnCalls.length;
    assertThrows(
      () => director.spawnPublisher(validConfig, null),
      /prepared exact artifact identity/i,
      'packaged publisher launch without its prepared identity'
    );
    assertThrows(
      () => director.spawnSpoutTestSender(validConfig, null),
      /prepared exact artifact identity/i,
      'packaged Spout launch without its prepared identity'
    );
    assert(harnessState.spawnCalls.length === spawnCountBeforeMissingReceipts,
      'A strict packaged launch reached spawn without a prepared identity');
    await assertRejects(
      () => director.launchDirectorBrowser(validConfig, null),
      /prepared exact artifact identity/i,
      'installed Firefox launch without its prepared identity'
    );
    assert(harnessState.browserLaunchOptions.length === 0,
      'Installed Firefox adapter ran without a prepared identity');

    const originalPublisherBytes = fs.readFileSync(fixture.publisherPath);
    const changedPublisherBytes = Buffer.from(originalPublisherBytes);
    changedPublisherBytes[0] ^= 0xff;
    fs.writeFileSync(fixture.publisherPath, changedPublisherBytes);
    const publisherSpawnCount = harnessState.spawnCalls.length;
    assertThrows(
      () => director.spawnPublisher(validConfig, valid.packagedArtifact),
      /Packaged publisher SHA-256 mismatch/i,
      'publisher replaced between prepare and spawn'
    );
    assert(harnessState.spawnCalls.length === publisherSpawnCount,
      'Replaced publisher reached the process launcher');
    fs.writeFileSync(fixture.publisherPath, originalPublisherBytes);

    const originalSpoutBytes = fs.readFileSync(fixture.spoutPath);
    const changedSpoutBytes = Buffer.from(originalSpoutBytes);
    changedSpoutBytes[0] ^= 0xff;
    fs.writeFileSync(fixture.spoutPath, changedSpoutBytes);
    const spoutSpawnCount = harnessState.spawnCalls.length;
    assertThrows(
      () => director.spawnSpoutTestSender(validConfig, valid.spoutSender),
      /Spout sender fixture SHA-256 mismatch/i,
      'Spout sender replaced between prepare and spawn'
    );
    assert(harnessState.spawnCalls.length === spoutSpawnCount,
      'Replaced Spout sender reached the process launcher');
    fs.writeFileSync(fixture.spoutPath, originalSpoutBytes);

    const originalFirefoxBytes = fs.readFileSync(fixture.firefoxPath);
    const changedFirefoxBytes = Buffer.from(originalFirefoxBytes);
    changedFirefoxBytes[0] ^= 0xff;
    fs.writeFileSync(fixture.firefoxPath, changedFirefoxBytes);
    await assertRejects(
      () => director.launchDirectorBrowser(validConfig, valid.firefox),
      /Installed Firefox SHA-256 mismatch/i,
      'Firefox replaced between prepare and launch'
    );
    assert(harnessState.browserLaunchOptions.length === 0,
      'Replaced Firefox reached the browser adapter');
    fs.writeFileSync(fixture.firefoxPath, originalFirefoxBytes);

    const publisherDuringSpawnState = makeHarnessState();
    const publisherDuringSpawnDirector = loadDirectorSource(
      source,
      makeRequireOverrides(publisherDuringSpawnState)
    );
    const publisherDuringSpawnConfig = publisherDuringSpawnDirector.parseArgs(packagedArgs(fixture));
    const publisherDuringSpawnArtifacts = publisherDuringSpawnDirector.prepareDirectorArtifacts(
      publisherDuringSpawnConfig
    );
    publisherDuringSpawnState.onSpawn = (command) => {
      if (path.basename(command).toLowerCase() === 'game-capture.exe') {
        fs.writeFileSync(fixture.publisherPath, changedPublisherBytes);
      }
    };
    assertThrows(
      () => publisherDuringSpawnDirector.spawnPublisher(
        publisherDuringSpawnConfig,
        publisherDuringSpawnArtifacts.packagedArtifact
      ),
      /Packaged publisher SHA-256 mismatch/i,
      'publisher replaced while spawn was admitted'
    );
    assert(publisherDuringSpawnState.killSignals.includes('SIGKILL'),
      'Publisher was not killed after its post-spawn identity failed');
    fs.writeFileSync(fixture.publisherPath, originalPublisherBytes);

    const spoutDuringSpawnState = makeHarnessState();
    const spoutDuringSpawnDirector = loadDirectorSource(
      source,
      makeRequireOverrides(spoutDuringSpawnState)
    );
    const spoutDuringSpawnConfig = spoutDuringSpawnDirector.parseArgs(packagedArgs(fixture));
    const spoutDuringSpawnArtifacts = spoutDuringSpawnDirector.prepareDirectorArtifacts(
      spoutDuringSpawnConfig
    );
    spoutDuringSpawnState.onSpawn = (command) => {
      if (path.basename(command).toLowerCase() === 'spout_test_sender.exe') {
        fs.writeFileSync(fixture.spoutPath, changedSpoutBytes);
      }
    };
    assertThrows(
      () => spoutDuringSpawnDirector.spawnSpoutTestSender(
        spoutDuringSpawnConfig,
        spoutDuringSpawnArtifacts.spoutSender
      ),
      /Spout sender fixture SHA-256 mismatch/i,
      'Spout sender replaced while spawn was admitted'
    );
    assert(spoutDuringSpawnState.killSignals.includes('SIGKILL'),
      'Spout sender was not killed after its post-spawn identity failed');
    fs.writeFileSync(fixture.spoutPath, originalSpoutBytes);

    const publisher = director.spawnPublisher(validConfig, valid.packagedArtifact);
    const sourceFixture = director.spawnSpoutTestSender(validConfig, valid.spoutSender);
    const browser = await director.launchDirectorBrowser(validConfig, valid.firefox);
    assert(publisher.command === valid.packagedArtifact.path,
      'Publisher spawn did not use the prepared exact path');
    assert(sourceFixture.command === valid.spoutSender.path,
      'Spout spawn did not use the prepared exact path');
    const actualPublisherSpawn = harnessState.spawnCalls.find((call) =>
      path.basename(call.command).toLowerCase() === 'game-capture.exe');
    const actualSpoutSpawn = harnessState.spawnCalls.find((call) =>
      path.basename(call.command).toLowerCase() === 'spout_test_sender.exe');
    assert(actualPublisherSpawn &&
      fs.realpathSync(actualPublisherSpawn.command) === valid.packagedArtifact.path,
    'The actual publisher spawn call did not use the prepared real path');
    assert(actualSpoutSpawn &&
      fs.realpathSync(actualSpoutSpawn.command) === valid.spoutSender.path,
    'The actual Spout spawn call did not use the prepared real path');
    assert(harnessState.browserLaunchOptions.length === 1,
      'Installed Firefox adapter was not launched exactly once');
    assert(harnessState.browserLaunchOptions[0].executablePath === valid.firefox.path,
      'Installed Firefox adapter did not receive the prepared exact path');
    assert(harnessState.browserLaunchOptions[0].expectedSha256 === valid.firefox.sha256,
      'Installed Firefox adapter did not receive the prepared exact SHA-256');
    assert(browser.artifactReceipt.postLaunch.sha256 === valid.firefox.sha256,
      'Installed Firefox post-launch receipt did not preserve the observed SHA-256');

    const runtimeArtifacts = { publisher, sourceFixture, browser };
    const stable = director.verifyDirectorArtifactsStable(
      validConfig,
      valid,
      runtimeArtifacts
    );
    assert(stable.ok && stable.publisher.atEnd.sha256 === fixture.manifest.artifact.sha256,
      'Stable publisher evidence did not use the observed package hash');
    assert(stable.spoutSender.atEnd.sha256 === fixture.spoutSha256,
      'Stable Spout evidence did not use the observed fixture hash');
    assert(stable.firefox.atEnd.sha256 === fixture.firefoxSha256,
      'Stable Firefox evidence did not use the observed executable hash');

    fs.writeFileSync(fixture.publisherPath, changedPublisherBytes);
    assertThrows(
      () => director.verifyDirectorArtifactsStable(validConfig, valid, runtimeArtifacts),
      /Packaged publisher SHA-256 mismatch/i,
      'publisher replaced before successful completion'
    );
    const replacedPublisherReport = { ok: true, checks: [{ name: 'workflow', ok: true }] };
    assertThrows(
      () => director.finalizeSuccessfulReport(
        replacedPublisherReport,
        validConfig,
        valid,
        runtimeArtifacts
      ),
      /Packaged publisher SHA-256 mismatch/i,
      'publisher replacement reached a green final report'
    );
    assert(replacedPublisherReport.ok !== true,
      'Publisher replacement was forged into a green report');
    fs.writeFileSync(fixture.publisherPath, originalPublisherBytes);
    fs.writeFileSync(fixture.spoutPath, changedSpoutBytes);
    assertThrows(
      () => director.verifyDirectorArtifactsStable(validConfig, valid, runtimeArtifacts),
      /Spout sender fixture SHA-256 mismatch/i,
      'Spout sender replaced before successful completion'
    );
    const replacedSpoutReport = { ok: true, checks: [{ name: 'workflow', ok: true }] };
    assertThrows(
      () => director.finalizeSuccessfulReport(
        replacedSpoutReport,
        validConfig,
        valid,
        runtimeArtifacts
      ),
      /Spout sender fixture SHA-256 mismatch/i,
      'Spout replacement reached a green final report'
    );
    assert(replacedSpoutReport.ok !== true,
      'Spout replacement was forged into a green report');
    fs.writeFileSync(fixture.spoutPath, originalSpoutBytes);
    fs.writeFileSync(fixture.firefoxPath, changedFirefoxBytes);
    assertThrows(
      () => director.verifyDirectorArtifactsStable(validConfig, valid, runtimeArtifacts),
      /Installed Firefox SHA-256 mismatch/i,
      'Firefox replaced before successful completion'
    );
    const replacedFirefoxReport = { ok: true, checks: [{ name: 'workflow', ok: true }] };
    assertThrows(
      () => director.finalizeSuccessfulReport(
        replacedFirefoxReport,
        validConfig,
        valid,
        runtimeArtifacts
      ),
      /Installed Firefox SHA-256 mismatch/i,
      'Firefox replacement reached a green final report'
    );
    assert(replacedFirefoxReport.ok !== true,
      'Firefox replacement was forged into a green report');
    fs.writeFileSync(fixture.firefoxPath, originalFirefoxBytes);

    const originalManifestBytes = fs.readFileSync(fixture.manifestPath);
    const changedManifestBytes = Buffer.from(originalManifestBytes);
    changedManifestBytes[0] ^= 0xff;
    fs.writeFileSync(fixture.manifestPath, changedManifestBytes);
    assertThrows(
      () => director.verifyDirectorArtifactsStable(validConfig, valid, runtimeArtifacts),
      /manifest SHA-256 mismatch/i,
      'release manifest replaced before successful completion'
    );
    fs.writeFileSync(fixture.manifestPath, originalManifestBytes);

    const successReport = { ok: false, checks: [{ name: 'workflow', ok: true }] };
    director.finalizeSuccessfulReport(successReport, validConfig, valid, runtimeArtifacts);
    assert(successReport.ok === true,
      'A stable all-green workflow did not finalize as successful');
    assert(successReport.artifactStability.publisher.atEnd.sha256 === fixture.manifest.artifact.sha256,
      'Successful report forged the publisher hash instead of recording the end observation');
    const failedCheckReport = { ok: false, checks: [{ name: 'workflow', ok: false }] };
    assertThrows(
      () => director.finalizeSuccessfulReport(
        failedCheckReport,
        validConfig,
        valid,
        runtimeArtifacts
      ),
      /contains a failed check/i,
      'failed workflow report finalization'
    );
    assert(failedCheckReport.ok === false,
      'A failed workflow was reported as successful');

    const wrongFirefoxPath = writeFile(
      path.join(temporaryRoot, 'different-firefox.exe'),
      originalFirefoxBytes
    );
    const wrongPathState = makeHarnessState();
    wrongPathState.onBrowserLaunch = (options, state) => fakeBrowser(
      options,
      state,
      { executablePath: wrongFirefoxPath }
    );
    const wrongPathDirector = loadDirectorSource(source, makeRequireOverrides(wrongPathState));
    const wrongPathConfig = wrongPathDirector.parseArgs(packagedArgs(fixture));
    const wrongPathArtifacts = wrongPathDirector.prepareDirectorArtifacts(wrongPathConfig);
    await assertRejects(
      () => wrongPathDirector.launchDirectorBrowser(wrongPathConfig, wrongPathArtifacts.firefox),
      /does not match the prevalidated installed executable/i,
      'browser adapter reports a different Firefox path'
    );
    assert(wrongPathState.browserCloseCount === 1,
      'Wrong-path Firefox browser was not closed');

    const wrongHashState = makeHarnessState();
    wrongHashState.onBrowserLaunch = (options, state) => fakeBrowser(
      options,
      state,
      { executableSha256: 'f'.repeat(64) }
    );
    const wrongHashDirector = loadDirectorSource(source, makeRequireOverrides(wrongHashState));
    const wrongHashConfig = wrongHashDirector.parseArgs(packagedArgs(fixture));
    const wrongHashArtifacts = wrongHashDirector.prepareDirectorArtifacts(wrongHashConfig);
    await assertRejects(
      () => wrongHashDirector.launchDirectorBrowser(wrongHashConfig, wrongHashArtifacts.firefox),
      /does not match the prevalidated installed executable/i,
      'browser adapter reports a forged Firefox hash'
    );
    assert(wrongHashState.browserCloseCount === 1,
      'Wrong-hash Firefox browser was not closed');

    const swappedFirefoxState = makeHarnessState();
    swappedFirefoxState.onBrowserLaunch = (options, state) => {
      fs.writeFileSync(fixture.firefoxPath, changedFirefoxBytes);
      return fakeBrowser(options, state);
    };
    const swappedFirefoxDirector = loadDirectorSource(
      source,
      makeRequireOverrides(swappedFirefoxState)
    );
    const swappedFirefoxConfig = swappedFirefoxDirector.parseArgs(packagedArgs(fixture));
    const swappedFirefoxArtifacts = swappedFirefoxDirector.prepareDirectorArtifacts(
      swappedFirefoxConfig
    );
    await assertRejects(
      () => swappedFirefoxDirector.launchDirectorBrowser(
        swappedFirefoxConfig,
        swappedFirefoxArtifacts.firefox
      ),
      /Launched installed Firefox SHA-256 mismatch/i,
      'Firefox replaced while launch was admitted'
    );
    assert(swappedFirefoxState.browserCloseCount === 1,
      'Replaced Firefox browser was not closed after post-launch validation');
    fs.writeFileSync(fixture.firefoxPath, originalFirefoxBytes);

    for (const failingMember of ['publisher', 'sourceFixture']) {
      const asyncState = makeHarnessState();
      const asyncDirector = loadDirectorSource(source, makeRequireOverrides(asyncState));
      const runtime = await launchStrictRuntime(asyncDirector, fixture);
      const failingChild = runtime.runtimeArtifacts[failingMember];
      assert(failingChild.listenerCount('error') > 0,
        `${failingMember} has no process error listener`);
      const awaitedFailure = asyncDirector.awaitWithRuntimeProcessFailures(
        new Promise((resolve) => setTimeout(() => resolve('false-green'), 50)),
        runtime.runtimeArtifacts
      );
      setImmediate(() => failingChild.emit(
        'error',
        new Error(`synthetic ${failingMember} launch failure`)
      ));
      await assertRejects(
        () => awaitedFailure,
        new RegExp(`synthetic ${failingMember} launch failure`, 'i'),
        `${failingMember} asynchronous process failure`
      );
      assert(failingChild.killed,
        `${failingMember} remained alive after its asynchronous process failure`);
      assertThrows(
        () => asyncDirector.assertNoRuntimeProcessFailure(runtime.runtimeArtifacts),
        new RegExp(`synthetic ${failingMember} launch failure`, 'i'),
        `${failingMember} failure at the success boundary`
      );
      await asyncDirector.cleanupDirectorRuntime(runtime.runtimeArtifacts, {
        publisherGraceMs: 0,
        sourceFixtureGraceMs: 0
      });
      assert(runtime.runtimeArtifacts.publisher.killed,
        `Publisher remained alive after admitted ${failingMember} failure`);
      assert(runtime.runtimeArtifacts.sourceFixture.killed,
        `Spout sender remained alive after admitted ${failingMember} failure`);
      assert(asyncState.browserCloseCount === 1,
        `Browser remained alive after admitted ${failingMember} failure`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function flipFirstByte(filePath) {
  const bytes = fs.readFileSync(filePath);
  bytes[0] ^= 0xff;
  fs.writeFileSync(filePath, bytes);
}

function prepareStrictRuntime(director, fixture) {
  const config = director.parseArgs(packagedArgs(fixture));
  const artifacts = director.prepareDirectorArtifacts(config);
  return { config, artifacts };
}

async function launchStrictRuntime(director, fixture) {
  const { config, artifacts } = prepareStrictRuntime(director, fixture);
  const sourceFixture = director.spawnSpoutTestSender(config, artifacts.spoutSender);
  const publisher = director.spawnPublisher(config, artifacts.packagedArtifact);
  const browser = await director.launchDirectorBrowser(config, artifacts.firefox);
  return {
    config,
    artifacts,
    runtimeArtifacts: { sourceFixture, publisher, browser }
  };
}

function makeCombinedFalseGreenSource(source) {
  let variant = replaceOnce(
    source,
    'if (require.main === module) {\n  run().catch((error) => {',
    'if (require.main === module) {\n  if (false) run().catch((error) => {'
  );
  variant = replaceFirst(
    variant,
    'const child = spawn(command, args, {',
    'const child = spawn(detectSpoutTestSender(), args, {'
  );
  variant = replaceOnce(
    variant,
    'const child = spawn(command, args, {',
    'const child = spawn(detectPublisherBinary(), args, {'
  );
  variant = replaceOnce(
    variant,
    '  const artifactStability = verifyDirectorArtifactsStable(\n    config,\n    preparedArtifacts,\n    runtimeArtifacts\n  );',
    `  let artifactStability;
  try {
    artifactStability = verifyDirectorArtifactsStable(
      config,
      preparedArtifacts,
      runtimeArtifacts
    );
  } catch {
    artifactStability = {
      ok: true,
      publisher: preparedArtifacts.packagedArtifact
        ? { atEnd: artifactEvidence(preparedArtifacts.packagedArtifact) }
        : null,
      spoutSender: preparedArtifacts.spoutSender
        ? { atEnd: artifactEvidence(preparedArtifacts.spoutSender) }
        : null,
      firefox: preparedArtifacts.firefox
        ? { atEnd: artifactEvidence(preparedArtifacts.firefox) }
        : null
    };
  }`
  );
  return variant;
}

async function runMutations(source, baseline) {
  const mutations = [
    {
      name: 'manifest-hash-mismatch-check-is-bypassed',
      target: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      source: replaceOnce(
        source,
        'if (manifestSha256 !== config.artifactManifestSha256) {',
        'if (false) {'
      ),
      probe(director, fixture) {
        const wrongManifest = { ...fixture, manifestSha256: '0'.repeat(64) };
        assertThrows(
          () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongManifest))),
          /manifest SHA-256 mismatch/i,
          'wrong release manifest hash'
        );
      }
    },
    {
      name: 'publisher-content-hash-check-is-bypassed',
      target: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      source: replaceOnce(
        source,
        'if (executableSha256 !== manifest.artifact.sha256) {',
        'if (false) {'
      ),
      beforeProbe(fixture) {
        const bytes = fs.readFileSync(fixture.publisherPath);
        bytes[0] ^= 0xff;
        fs.writeFileSync(fixture.publisherPath, bytes);
      },
      probe(director, fixture) {
        assertThrows(
          () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(fixture))),
          /Packaged publisher SHA-256 mismatch/i,
          'publisher content no longer matches release manifest'
        );
      }
    },
    {
      name: 'packaged-spout-expected-hash-is-bypassed',
      target: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "      config.expectedSpoutSenderSha256,\n      'Packaged Spout sender fixture'",
        "      sha256File(config.spoutSenderPath),\n      'Packaged Spout sender fixture'"
      ),
      probe(director, fixture) {
        const wrongSpout = { ...fixture, spoutSha256: '1'.repeat(64) };
        assertThrows(
          () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongSpout))),
          /Spout sender fixture SHA-256 mismatch/i,
          'wrong Spout sender hash'
        );
      }
    },
    {
      name: 'packaged-spout-explicit-identity-is-not-required',
      target: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "      ['spoutSenderPath', 'spout-sender-path'],\n      ['expectedSpoutSenderSha256', 'expected-spout-sender-sha256']",
        ''
      ),
      probe(director, fixture) {
        const noSpoutArguments = packagedArgs(fixture).filter((argument) =>
          !argument.startsWith('--spout-sender-path=') &&
          !argument.startsWith('--expected-spout-sender-sha256=')
        );
        assertThrows(
          () => director.parseArgs(noSpoutArguments),
          /spout-sender-path/i,
          'packaged stale Spout autodiscovery'
        );
      }
    },
    {
      name: 'installed-firefox-preflight-hash-is-bypassed',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "      config.expectedFirefoxSha256,\n      'Installed Firefox'",
        "      sha256File(config.firefoxPath),\n      'Installed Firefox'"
      ),
      probe(director, fixture) {
        const wrongFirefox = { ...fixture, firefoxSha256: '2'.repeat(64) };
        assertThrows(
          () => director.prepareDirectorArtifacts(director.parseArgs(packagedArgs(wrongFirefox))),
          /Installed Firefox SHA-256 mismatch/i,
          'wrong installed Firefox hash'
        );
      }
    },
    {
      name: 'publisher-before-spawn-revalidation-is-bypassed',
      target: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "beforeSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'before publisher spawn');",
        'beforeSpawn = exactArtifact;'
      ),
      probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        flipFirstByte(fixture.publisherPath);
        const before = state.spawnCalls.length;
        assertThrows(
          () => director.spawnPublisher(config, artifacts.packagedArtifact),
          /Packaged publisher SHA-256 mismatch/i,
          'publisher changed before spawn'
        );
        assert(state.spawnCalls.length === before,
          'Changed publisher reached spawn before rejection');
      }
    },
    {
      name: 'publisher-after-spawn-revalidation-is-bypassed',
      target: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "const afterSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'after publisher spawn');",
        'const afterSpawn = beforeSpawn;'
      ),
      configureState(state, fixture) {
        state.onSpawn = (command) => {
          if (path.basename(command).toLowerCase() === 'game-capture.exe') {
            flipFirstByte(fixture.publisherPath);
          }
        };
      },
      probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        assertThrows(
          () => director.spawnPublisher(config, artifacts.packagedArtifact),
          /Packaged publisher SHA-256 mismatch/i,
          'publisher changed during spawn'
        );
        assert(state.killSignals.includes('SIGKILL'),
          'Changed publisher process was not killed');
      }
    },
    {
      name: 'packaged-publisher-missing-receipt-autodiscovers',
      target: 'DIRECTOR_PACKAGED_PUBLISHER_MANIFEST_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "  if (config.requirePackagedArtifact) {\n    if (!exactArtifact) {\n      throw new Error('Packaged publisher launch requires a prepared exact artifact identity');\n    }\n    beforeSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'before publisher spawn');",
        "  if (config.requirePackagedArtifact && exactArtifact) {\n    beforeSpawn = revalidatePackagedPublisherArtifact(config, exactArtifact, 'before publisher spawn');"
      ),
      probe(director, fixture, state) {
        const { config } = prepareStrictRuntime(director, fixture);
        assertThrows(
          () => director.spawnPublisher(config, null),
          /prepared exact artifact identity/i,
          'packaged publisher without prepared identity'
        );
        assert(state.spawnCalls.length === 0,
          'Packaged publisher fell back to discovery');
      }
    },
    {
      name: 'spout-before-spawn-revalidation-is-bypassed',
      target: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "beforeSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'before spawn');",
        'beforeSpawn = exactArtifact;'
      ),
      probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        flipFirstByte(fixture.spoutPath);
        const before = state.spawnCalls.length;
        assertThrows(
          () => director.spawnSpoutTestSender(config, artifacts.spoutSender),
          /Spout sender fixture SHA-256 mismatch/i,
          'Spout sender changed before spawn'
        );
        assert(state.spawnCalls.length === before,
          'Changed Spout sender reached spawn before rejection');
      }
    },
    {
      name: 'spout-after-spawn-revalidation-is-bypassed',
      target: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "const afterSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'after spawn');",
        'const afterSpawn = beforeSpawn;'
      ),
      configureState(state, fixture) {
        state.onSpawn = (command) => {
          if (path.basename(command).toLowerCase() === 'spout_test_sender.exe') {
            flipFirstByte(fixture.spoutPath);
          }
        };
      },
      probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        assertThrows(
          () => director.spawnSpoutTestSender(config, artifacts.spoutSender),
          /Spout sender fixture SHA-256 mismatch/i,
          'Spout sender changed during spawn'
        );
        assert(state.killSignals.includes('SIGKILL'),
          'Changed Spout sender process was not killed');
      }
    },
    {
      name: 'packaged-spout-missing-receipt-autodiscovers',
      target: 'DIRECTOR_PACKAGED_SPOUT_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "  if (config.requirePackagedArtifact) {\n    if (!exactArtifact) {\n      throw new Error('Packaged Spout sender launch requires a prepared exact artifact identity');\n    }\n    beforeSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'before spawn');",
        "  if (config.requirePackagedArtifact && exactArtifact) {\n    beforeSpawn = revalidateExpectedFileArtifact(exactArtifact, 'Packaged Spout sender fixture', 'before spawn');"
      ),
      probe(director, fixture, state) {
        const { config } = prepareStrictRuntime(director, fixture);
        assertThrows(
          () => director.spawnSpoutTestSender(config, null),
          /prepared exact artifact identity/i,
          'packaged Spout sender without prepared identity'
        );
        assert(state.spawnCalls.length === 0,
          'Packaged Spout sender fell back to discovery');
      }
    },
    {
      name: 'installed-firefox-before-launch-revalidation-is-bypassed',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "    const beforeLaunch = revalidateExpectedFileArtifact(\n      exactFirefoxArtifact,\n      'Installed Firefox',\n      'before launch'\n    );",
        '    const beforeLaunch = exactFirefoxArtifact;'
      ),
      async probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        flipFirstByte(fixture.firefoxPath);
        await assertRejects(
          () => director.launchDirectorBrowser(config, artifacts.firefox),
          /Installed Firefox SHA-256 mismatch/i,
          'Firefox changed before launch'
        );
        assert(state.browserLaunchOptions.length === 0,
          'Changed Firefox reached the browser adapter');
      }
    },
    {
      name: 'installed-firefox-exact-path-is-not-passed-to-adapter',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        'executablePath: beforeLaunch.path',
        'executablePath: config.firefoxPath'
      ),
      async probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        const otherPath = writeFile(
          path.join(path.dirname(fixture.firefoxPath), 'other-firefox.exe'),
          fs.readFileSync(fixture.firefoxPath)
        );
        config.firefoxPath = otherPath;
        await director.launchDirectorBrowser(config, artifacts.firefox);
        assert(state.browserLaunchOptions[0].executablePath === artifacts.firefox.path,
          'Installed Firefox adapter did not receive the prepared exact path');
      }
    },
    {
      name: 'installed-firefox-expected-hash-is-not-passed-to-adapter',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        'expectedSha256: beforeLaunch.sha256',
        "expectedSha256: ''"
      ),
      async probe(director, fixture, state) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        await director.launchDirectorBrowser(config, artifacts.firefox);
        assert(state.browserLaunchOptions[0].expectedSha256 === artifacts.firefox.sha256,
          'Installed Firefox adapter did not receive the prepared exact SHA-256');
      }
    },
    {
      name: 'installed-firefox-post-launch-validator-is-bypassed',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        'const postLaunch = validateLaunchedFirefoxArtifact(browser, beforeLaunch);',
        'const postLaunch = beforeLaunch;'
      ),
      configureState(state, fixture) {
        const wrongPath = writeFile(
          path.join(path.dirname(fixture.firefoxPath), 'wrong-firefox.exe'),
          fs.readFileSync(fixture.firefoxPath)
        );
        state.onBrowserLaunch = (options, browserState) => fakeBrowser(
          options,
          browserState,
          { executablePath: wrongPath }
        );
      },
      async probe(director, fixture) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        await assertRejects(
          () => director.launchDirectorBrowser(config, artifacts.firefox),
          /does not match the prevalidated installed executable/i,
          'wrong Firefox post-launch identity'
        );
      }
    },
    {
      name: 'installed-firefox-missing-receipt-autovalidates-config',
      target: 'DIRECTOR_INSTALLED_FIREFOX_IDENTITY_FAIL_CLOSED',
      source: replaceOnce(
        source,
        "    if (!exactFirefoxArtifact) {\n      throw new Error('Installed Firefox launch requires a prepared exact artifact identity');\n    }",
        "    if (!exactFirefoxArtifact) {\n      exactFirefoxArtifact = validateExpectedFileArtifact(\n        config.firefoxPath, config.expectedFirefoxSha256, 'Installed Firefox'\n      );\n    }"
      ),
      async probe(director, fixture, state) {
        const { config } = prepareStrictRuntime(director, fixture);
        await assertRejects(
          () => director.launchDirectorBrowser(config, null),
          /prepared exact artifact identity/i,
          'installed Firefox without prepared identity'
        );
        assert(state.browserLaunchOptions.length === 0,
          'Installed Firefox launch rebuilt identity from mutable config');
      }
    },
    {
      name: 'unknown-identity-options-are-ignored',
      target: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      source: replaceOnce(
        source,
        '      throw new Error(`Unknown argument: ${arg}`);',
        '      continue;'
      ),
      probe(director, fixture) {
        const typoArgs = packagedArgs(fixture).map((argument) =>
          argument === '--require-packaged-artifact'
            ? '--require-packaged-artifcat'
            : argument);
        assertThrows(
          () => director.parseArgs(typoArgs),
          /Unknown argument: --require-packaged-artifcat/i,
          'misspelled packaged identity flag'
        );
      }
    },
    {
      name: 'duplicate-identity-options-are-allowed',
      target: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      source: replaceOnce(
        replaceOnce(source, 'if (count > 1) {', 'if (false) {'),
        'if (explicitArgumentCounts[name] !== 1 || !args[name]) {',
        'if (!args[name]) {'
      ),
      probe(director, fixture) {
        const duplicate = findCliArgument(packagedArgs(fixture), 'publisher-path');
        assertThrows(
          () => director.parseArgs([...packagedArgs(fixture), duplicate]),
          /Exactly one explicit --publisher-path/i,
          'duplicate publisher identity'
        );
      }
    },
    {
      name: 'missing-and-empty-identity-options-are-allowed',
      target: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      source: replaceOnce(
        source,
        'if (explicitArgumentCounts[name] !== 1 || !args[name]) {',
        'if (false) {'
      ),
      probe(director, fixture) {
        assertThrows(
          () => director.parseArgs(removeCliArgument(packagedArgs(fixture), 'publisher-path')),
          /Exactly one explicit --publisher-path/i,
          'missing publisher identity'
        );
      }
    },
    {
      name: 'packaged-identity-options-are-accepted-without-flag',
      target: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      source: replaceOnce(
        source,
        'if (!args.requirePackagedArtifact && [',
        'if (false && ['
      ),
      probe(director, fixture) {
        const args = packagedArgs(fixture).filter((argument) =>
          argument !== '--require-packaged-artifact');
        assertThrows(
          () => director.parseArgs(args),
          /require --require-packaged-artifact/i,
          'packaged identities without enabling flag'
        );
      }
    },
    {
      name: 'firefox-identities-are-accepted-for-another-browser',
      target: 'DIRECTOR_IDENTITY_CLI_FAILS_CLOSED',
      source: replaceOnce(
        source,
        "  } else if (explicitArgumentCounts.firefoxPath !== 0 ||\n      explicitArgumentCounts.expectedFirefoxSha256 !== 0) {",
        "  } else if (false && (explicitArgumentCounts.firefoxPath !== 0 ||\n      explicitArgumentCounts.expectedFirefoxSha256 !== 0)) {"
      ),
      probe(director, fixture) {
        const args = replaceCliArgument(packagedArgs(fixture), 'browser', '--browser=chromium');
        assertThrows(
          () => director.parseArgs(args),
          /require --browser=firefox-installed/i,
          'Firefox identities for another browser'
        );
      }
    },
    {
      name: 'dead-explicit-publisher-path-is-not-rejected',
      target: 'DIRECTOR_EXPLICIT_PATHS_DO_NOT_AUTOFALLBACK',
      source: replaceOnce(
        source,
        "return requireExplicitLeafFile(explicitPath, 'Explicit game-capture publisher');",
        'return path.resolve(explicitPath);'
      ),
      probe(director, fixture) {
        assertThrows(
          () => director.detectPublisherBinary(path.join(path.dirname(fixture.publisherPath), 'dead.exe')),
          /game-capture publisher does not exist/i,
          'dead non-packaged explicit publisher path'
        );
      }
    },
    {
      name: 'dead-explicit-spout-path-is-not-rejected',
      target: 'DIRECTOR_EXPLICIT_PATHS_DO_NOT_AUTOFALLBACK',
      source: replaceOnce(
        source,
        "return requireExplicitLeafFile(explicitPath, 'Explicit Spout test sender');",
        'return path.resolve(explicitPath);'
      ),
      probe(director, fixture) {
        assertThrows(
          () => director.detectSpoutTestSender(path.join(path.dirname(fixture.spoutPath), 'dead.exe')),
          /Spout test sender does not exist/i,
          'dead non-packaged explicit Spout path'
        );
      }
    },
    {
      name: 'publisher-end-stability-is-forged-from-expected-identity',
      target: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      source: replaceOnce(
        source,
        "    const publisherAtEnd = revalidatePackagedPublisherArtifact(\n      config,\n      preparedArtifacts.packagedArtifact,\n      'at successful completion'\n    );",
        '    const publisherAtEnd = preparedArtifacts.packagedArtifact;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        flipFirstByte(fixture.publisherPath);
        assertThrows(
          () => director.verifyDirectorArtifactsStable(
            runtime.config,
            runtime.artifacts,
            runtime.runtimeArtifacts
          ),
          /Packaged publisher SHA-256 mismatch/i,
          'publisher changed before successful report'
        );
      }
    },
    {
      name: 'spout-end-stability-is-forged-from-expected-identity',
      target: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      source: replaceOnce(
        source,
        "    const spoutAtEnd = revalidateExpectedFileArtifact(\n      preparedArtifacts.spoutSender,\n      'Packaged Spout sender fixture',\n      'at successful completion'\n    );",
        '    const spoutAtEnd = preparedArtifacts.spoutSender;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        flipFirstByte(fixture.spoutPath);
        assertThrows(
          () => director.verifyDirectorArtifactsStable(
            runtime.config,
            runtime.artifacts,
            runtime.runtimeArtifacts
          ),
          /Spout sender fixture SHA-256 mismatch/i,
          'Spout sender changed before successful report'
        );
      }
    },
    {
      name: 'firefox-end-stability-is-forged-from-expected-identity',
      target: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      source: replaceOnce(
        source,
        "    const firefoxAtEnd = revalidateExpectedFileArtifact(\n      preparedArtifacts.firefox,\n      'Installed Firefox',\n      'at successful completion'\n    );",
        '    const firefoxAtEnd = preparedArtifacts.firefox;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        flipFirstByte(fixture.firefoxPath);
        assertThrows(
          () => director.verifyDirectorArtifactsStable(
            runtime.config,
            runtime.artifacts,
            runtime.runtimeArtifacts
          ),
          /Installed Firefox SHA-256 mismatch/i,
          'Firefox changed before successful report'
        );
      }
    },
    {
      name: 'publisher-report-uses-prepared-metadata-instead-of-end-observation',
      target: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      source: replaceOnce(
        source,
        'atEnd: artifactEvidence(publisherAtEnd)',
        'atEnd: artifactEvidence(preparedArtifacts.packagedArtifact)'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        const future = new Date(Date.now() + 120000);
        fs.utimesSync(fixture.publisherPath, future, future);
        const report = { ok: false, checks: [{ name: 'workflow', ok: true }] };
        director.finalizeSuccessfulReport(
          report,
          runtime.config,
          runtime.artifacts,
          runtime.runtimeArtifacts
        );
        assert(
          report.artifactStability.publisher.atEnd.modifiedUtc !==
            runtime.artifacts.packagedArtifact.modifiedUtc,
          'Report used prepared publisher metadata instead of the end observation'
        );
      }
    },
    {
      name: 'failed-checks-can-force-report-success',
      target: 'DIRECTOR_ARTIFACT_REPORTS_PROVE_STABILITY',
      source: replaceOnce(
        source,
        'report.ok = artifactStability.ok && report.checks.every((entry) => entry.ok);',
        'report.ok = true;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        const report = { ok: false, checks: [{ name: 'workflow', ok: false }] };
        assertThrows(
          () => director.finalizeSuccessfulReport(
            report,
            runtime.config,
            runtime.artifacts,
            runtime.runtimeArtifacts
          ),
          /contains a failed check/i,
          'failed workflow report'
        );
      }
    },
    {
      name: 'publisher-asynchronous-error-listener-is-removed',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        source,
        "  attachChildProcessErrorGuard(child, 'Packaged publisher');",
        '  void child;'
      ),
      probe(director, fixture) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        const publisher = director.spawnPublisher(config, artifacts.packagedArtifact);
        assert(publisher.listenerCount('error') > 0,
          'Publisher child has no asynchronous error listener');
      }
    },
    {
      name: 'spout-asynchronous-error-listener-is-removed',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        source,
        "  attachChildProcessErrorGuard(child, 'Packaged Spout sender fixture');",
        '  void child;'
      ),
      probe(director, fixture) {
        const { config, artifacts } = prepareStrictRuntime(director, fixture);
        const sourceFixture = director.spawnSpoutTestSender(config, artifacts.spoutSender);
        assert(sourceFixture.listenerCount('error') > 0,
          'Spout sender child has no asynchronous error listener');
      }
    },
    {
      name: 'child-process-error-does-not-terminate-failed-child',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        source,
        '    terminateSpawnedChild(child);\n    resolveFailure(observedError);',
        '    resolveFailure(observedError);'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        const publisher = runtime.runtimeArtifacts.publisher;
        const awaited = director.awaitWithRuntimeProcessFailures(
          new Promise((resolve) => setTimeout(() => resolve('false-green'), 50)),
          runtime.runtimeArtifacts
        );
        setImmediate(() => publisher.emit(
          'error',
          new Error('synthetic publisher termination failure')
        ));
        await assertRejects(
          () => awaited,
          /synthetic publisher termination failure/i,
          'publisher asynchronous process failure'
        );
        assert(publisher.killed,
          'Failed publisher process remained alive after its error event');
      }
    },
    {
      name: 'runtime-await-bypasses-child-process-failure',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        replaceOnce(
          source,
          '  const result = await Promise.race([operationPromise, ...guardedFailures]);',
          '  void Promise.allSettled(guardedFailures);\n  const result = await operationPromise;'
        ),
        '  assertNoRuntimeProcessFailure(runtimeArtifacts);\n  return result;',
        '  return result;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        const awaited = director.awaitWithRuntimeProcessFailures(
          new Promise((resolve) => setTimeout(() => resolve('false-green'), 50)),
          runtime.runtimeArtifacts
        );
        setImmediate(() => runtime.runtimeArtifacts.publisher.emit(
          'error',
          new Error('synthetic publisher await failure')
        ));
        await assertRejects(
          () => awaited,
          /synthetic publisher await failure/i,
          'runtime operation with failed publisher'
        );
      }
    },
    {
      name: 'child-error-guard-is-hidden-from-runtime',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        source,
        '  child.workflowErrorGuard = guard;',
        '  void guard;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        const awaited = director.awaitWithRuntimeProcessFailures(
          new Promise((resolve) => setTimeout(() => resolve('false-green'), 50)),
          runtime.runtimeArtifacts
        );
        setImmediate(() => runtime.runtimeArtifacts.publisher.emit(
          'error',
          new Error('synthetic hidden publisher failure')
        ));
        await assertRejects(
          () => awaited,
          /synthetic hidden publisher failure/i,
          'runtime with hidden publisher error guard'
        );
      }
    },
    {
      name: 'successful-finalizer-ignores-child-process-failure',
      target: 'DIRECTOR_ASYNC_CHILD_ERRORS_FAIL_THE_WORKFLOW',
      source: replaceOnce(
        source,
        'function finalizeSuccessfulReport(report, config, preparedArtifacts, runtimeArtifacts) {\n  const started = Date.now();\n  report.ok = false;\n  assertNoRuntimeProcessFailure(runtimeArtifacts);',
        'function finalizeSuccessfulReport(report, config, preparedArtifacts, runtimeArtifacts) {\n  const started = Date.now();\n  report.ok = false;'
      ),
      async probe(director, fixture) {
        const runtime = await launchStrictRuntime(director, fixture);
        runtime.runtimeArtifacts.publisher.emit(
          'error',
          new Error('synthetic publisher finalization failure')
        );
        const report = { ok: false, checks: [{ name: 'workflow', ok: true }] };
        assertThrows(
          () => director.finalizeSuccessfulReport(
            report,
            runtime.config,
            runtime.artifacts,
            runtime.runtimeArtifacts
          ),
          /synthetic publisher finalization failure/i,
          'successful finalization after publisher process error'
        );
        assert(report.ok !== true,
          'Publisher process error reached a green final report');
      }
    },
    {
      name: 'director-cleanup-leaves-admitted-publisher-alive',
      target: 'DIRECTOR_STARTUP_IS_CLEANUP_OWNED',
      source: replaceOnce(
        source,
        "  await stopAdmittedChild(publisher, 'SIGTERM', options.publisherGraceMs ?? 1000);",
        '  void publisher;'
      ),
      async probe(director, fixture, state) {
        const runtime = await launchStrictRuntime(director, fixture);
        await director.cleanupDirectorRuntime(runtime.runtimeArtifacts, {
          publisherGraceMs: 0,
          sourceFixtureGraceMs: 0
        });
        assert(runtime.runtimeArtifacts.publisher.killed,
          'Admitted publisher remained alive after Director cleanup');
        assert(runtime.runtimeArtifacts.sourceFixture.killed,
          'Admitted Spout sender remained alive after Director cleanup');
        assert(state.browserCloseCount === 1,
          'Admitted browser remained alive after Director cleanup');
      }
    },
    {
      name: 'combined-cli-spawn-and-finalizer-false-green',
      target: 'DIRECTOR_FALSE_GREEN_COMPOSITION_IS_REJECTED',
      source: makeCombinedFalseGreenSource(source),
      async probe(director, fixture, state, variantSource) {
        const cliProbe = runDirectorCliProbe(variantSource);
        const cliOutput = `${cliProbe.stdout || ''}\n${cliProbe.stderr || ''}`;
        assert(cliProbe.status !== 0 &&
          /Unknown argument: --director-identity-cli-probe-unknown/i.test(cliOutput),
        'Mutated Director CLI silently exited without executing its main workflow');

        const runtime = await launchStrictRuntime(director, fixture);
        const publisherSpawn = state.spawnCalls.find((call) =>
          path.basename(call.command).toLowerCase() === 'game-capture.exe');
        const spoutSpawn = state.spawnCalls.find((call) =>
          path.basename(call.command).toLowerCase() === 'spout_test_sender.exe');
        assert(publisherSpawn &&
          fs.realpathSync(publisherSpawn.command) === runtime.artifacts.packagedArtifact.path,
        'Actual publisher spawn did not use its prepared real path');
        assert(spoutSpawn &&
          fs.realpathSync(spoutSpawn.command) === runtime.artifacts.spoutSender.path,
        'Actual Spout spawn did not use its prepared real path');

        for (const replacement of [
          {
            path: fixture.publisherPath,
            pattern: /Packaged publisher SHA-256 mismatch/i,
            label: 'publisher'
          },
          {
            path: fixture.spoutPath,
            pattern: /Spout sender fixture SHA-256 mismatch/i,
            label: 'Spout sender'
          },
          {
            path: fixture.firefoxPath,
            pattern: /Installed Firefox SHA-256 mismatch/i,
            label: 'Firefox'
          }
        ]) {
          flipFirstByte(replacement.path);
          const report = { ok: true, checks: [{ name: 'workflow', ok: true }] };
          try {
            assertThrows(
              () => director.finalizeSuccessfulReport(
                report,
                runtime.config,
                runtime.artifacts,
                runtime.runtimeArtifacts
              ),
              replacement.pattern,
              `${replacement.label} replacement at finalization`
            );
            assert(report.ok !== true,
              `${replacement.label} replacement was forged into a green report`);
          } finally {
            flipFirstByte(replacement.path);
          }
        }
      }
    },
    {
      name: 'source-fixture-starts-before-cleanup-ownership',
      target: 'DIRECTOR_STARTUP_IS_CLEANUP_OWNED',
      source: replaceOnce(
        source,
        '  try {\n    sourceFixture = spawnSpoutTestSender(config, preparedArtifacts.spoutSender);\n    publisher = spawnPublisher(config, preparedArtifacts.packagedArtifact);',
        '  sourceFixture = spawnSpoutTestSender(config, preparedArtifacts.spoutSender);\n  try {\n    publisher = spawnPublisher(config, preparedArtifacts.packagedArtifact);'
      ),
      probe(_director, _fixture, _state, variantSource) {
        const runStart = variantSource.lastIndexOf('async function run() {');
        const tryStart = variantSource.indexOf('  try {', runStart);
        const spawnStart = variantSource.indexOf(
          'sourceFixture = spawnSpoutTestSender(config, preparedArtifacts.spoutSender);',
          runStart
        );
        assert(tryStart >= 0 && tryStart < spawnStart,
          'Source fixture starts before try/finally owns cleanup');
      }
    }
  ];

  const baselineById = new Map(baseline.map((check) => [check.id, check.ok]));
  for (const mutation of mutations) {
    const failed = evaluatePolicy(mutation.source)
      .filter((check) => baselineById.get(check.id) === true && !check.ok)
      .map((check) => check.id);
    assert(failed.length === 1 && failed[0] === mutation.target,
      `Mutation ${mutation.name} failed [${failed.join(', ')}], expected only ${mutation.target}`);

    const runProbe = async (variantSource) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'director-identity-mutation-'));
      try {
        const fixture = makeArtifactFixture(temporaryRoot);
        const state = makeHarnessState();
        if (mutation.beforeProbe) mutation.beforeProbe(fixture);
        if (mutation.configureState) mutation.configureState(state, fixture);
        const director = loadDirectorSource(variantSource, makeRequireOverrides(state));
        await mutation.probe(director, fixture, state, variantSource);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    };

    await runProbe(source);
    let mutationWentRed = false;
    try {
      await runProbe(mutation.source);
    } catch (error) {
      mutationWentRed = true;
    }
    assert(mutationWentRed, `Behavior probe stayed green for mutation ${mutation.name}`);
    console.log(`[DIRECTOR IDENTITY MUTATION RED] ${mutation.name}: ${failed[0]} + behavior`);
  }
}

async function run() {
  const source = fs.readFileSync(DIRECTOR_PATH, 'utf8');
  const firefoxAdapterSource = fs.readFileSync(FIREFOX_ADAPTER_PATH, 'utf8');
  const baseline = evaluatePolicy(source);
  const failed = baseline.filter((check) => !check.ok);
  for (const check of baseline) {
    console.log(`[DIRECTOR IDENTITY POLICY ${check.ok ? 'PASS' : 'FAIL'}] ${check.id}`);
  }
  if (failed.length > 0) {
    console.error(`[DIRECTOR IDENTITY RED] missing production contracts: ${failed.map((check) => check.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await runBehaviorChecks(source);
  console.log('[DIRECTOR IDENTITY BEHAVIOR PASS] CLI, launch-boundary, receipt, end-stability, and cleanup contracts enforced');
  await runMutations(source, baseline);
  await runFirefoxAdapterChecksAndMutations(firefoxAdapterSource);
  console.log('[DIRECTOR IDENTITY REGRESSION] PASS');
}

run().catch((error) => {
  console.error(`[DIRECTOR IDENTITY REGRESSION] FAIL: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
