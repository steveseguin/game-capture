'use strict';

const fs = require('fs');
const path = require('path');

const nativeRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(nativeRoot, '..');
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`[QA-CONTRACT] PASS ${name}`);
    return;
  }
  failures.push(name);
  console.error(`[QA-CONTRACT] FAIL ${name}: ${detail}`);
}

function powershellBlockContaining(markdown, command) {
  const blocks = [...markdown.matchAll(/```powershell\s*([\s\S]*?)```/giu)]
    .map((match) => match[1]);
  return blocks.find((block) => block.includes(command)) || '';
}

const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const fastGateBlock = powershellBlockContaining(readme, 'run-fast-gate.ps1');
const readinessBlock = powershellBlockContaining(readme, 'run-release-readiness.ps1');
const readinessParameters = [
  '-PublisherPath',
  '-ArtifactManifestPath',
  '-ArtifactManifestSha256',
  '-FirefoxPath'
];
const cmakeText = fs.readFileSync(path.join(nativeRoot, 'CMakeLists.txt'), 'utf8');
const versionMatch = cmakeText.match(/project\s*\([^)]*\bVERSION\s+([0-9]+(?:\.[0-9]+)+)/iu);
check(
  'documented-gate-commands-supply-mandatory-parameters',
  fastGateBlock.includes('-FirefoxPath') &&
    readinessParameters.every((parameter) => readinessBlock.includes(parameter)) &&
    !!versionMatch &&
    readinessBlock.includes(`game-capture-${versionMatch[1]}-win64`),
  'README gate commands must include every mandatory parameter and the current package version'
);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8')
);
const controlCenterScripts = [
  'e2e:control-center:edge',
  'e2e:control-center:firefox',
  'e2e:control-center:firefox-installed'
];
const wrapperPath = path.join(__dirname, 'run-director-room-e2e.js');
let wrapperContractValid = fs.existsSync(wrapperPath) && controlCenterScripts.every(
  (name) => String(packageJson.scripts[name] || '').includes('run-director-room-e2e.js')
);
let wrapperFailure = 'Control Center scripts must use the packaged-artifact resolver';
if (wrapperContractValid) {
  try {
    const { prepareDirectorArgs } = require(wrapperPath);
    if (typeof prepareDirectorArgs !== 'function') {
      throw new Error('wrapper does not export prepareDirectorArgs');
    }
    const fakeHash = 'a'.repeat(64);
    const fakeDependencies = {
      resolveCurrentPackage: () => ({
        publisherPath: 'fixture-publisher.exe',
        artifactManifestPath: 'fixture-manifest.json',
        manifestBuildDir: 'fixture-build'
      }),
      resolveSpoutSender: (buildDir) => {
        if (buildDir !== 'fixture-build') {
          throw new Error(`unexpected build directory: ${buildDir}`);
        }
        return 'fixture-spout.exe';
      },
      resolveInstalledFirefox: () => 'fixture-firefox.exe',
      sha256File: () => fakeHash
    };
    const forwarded = prepareDirectorArgs(
      ['--browser=edge', '--require-packaged-artifact'],
      fakeDependencies
    );
    const requiredIdentityArguments = [
      '--publisher-path=fixture-publisher.exe',
      '--artifact-manifest-path=fixture-manifest.json',
      `--artifact-manifest-sha256=${fakeHash}`,
      '--spout-sender-path=fixture-spout.exe',
      `--expected-spout-sender-sha256=${fakeHash}`
    ];
    wrapperContractValid = requiredIdentityArguments.every(
      (argument) => forwarded.includes(argument)
    );
    const installedFirefoxArgs = prepareDirectorArgs(
      ['--browser=firefox-installed', '--require-packaged-artifact'],
      fakeDependencies
    );
    wrapperContractValid = wrapperContractValid &&
      installedFirefoxArgs.includes('--firefox-path=fixture-firefox.exe') &&
      installedFirefoxArgs.includes(`--expected-firefox-sha256=${fakeHash}`);
    let partialIdentityRejected = false;
    try {
      prepareDirectorArgs(
        ['--browser=edge', '--publisher-path=incomplete.exe'],
        fakeDependencies
      );
    } catch (error) {
      partialIdentityRejected = /must be supplied together/i.test(error.message);
    }
    wrapperContractValid = wrapperContractValid && partialIdentityRejected;
    if (!wrapperContractValid) {
      wrapperFailure = 'resolver did not add the complete packaged-artifact identity';
    }
  } catch (error) {
    wrapperContractValid = false;
    wrapperFailure = error.message;
  }
}
check(
  'bare-control-center-commands-resolve-exact-artifacts',
  wrapperContractValid,
  wrapperFailure
);

const signalingScripts = [
  'e2e:signaling-regressions',
  'e2e:signaling-regressions:edge',
  'e2e:signaling-regressions:firefox',
  'e2e:signaling-regressions:firefox-installed'
];
const signalingWrapperPath = path.join(__dirname, 'run-signaling-regressions-e2e.js');
let signalingWrapperContractValid = fs.existsSync(signalingWrapperPath) && signalingScripts.every(
  (name) => String(packageJson.scripts[name] || '').includes('run-signaling-regressions-e2e.js')
);
let signalingWrapperFailure = 'Signaling scripts must use the packaged-artifact resolver';
if (signalingWrapperContractValid) {
  try {
    const { prepareSignalingArgs } = require(signalingWrapperPath);
    if (typeof prepareSignalingArgs !== 'function') {
      throw new Error('wrapper does not export prepareSignalingArgs');
    }
    const fakeHash = 'b'.repeat(64);
    const fakeDependencies = {
      resolveCurrentPackage: () => ({
        publisherPath: 'fixture-publisher.exe',
        artifactManifestPath: 'fixture-manifest.json',
        manifestBuildDir: 'fixture-build'
      }),
      resolveSpoutSender: (buildDir) => {
        if (buildDir !== 'fixture-build') {
          throw new Error(`unexpected build directory: ${buildDir}`);
        }
        return 'fixture-spout.exe';
      },
      resolveInstalledFirefox: () => 'fixture-firefox.exe',
      sha256File: () => fakeHash
    };
    const forwarded = prepareSignalingArgs(['--browser=edge'], fakeDependencies);
    const requiredIdentityArguments = [
      '--publisher-path=fixture-publisher.exe',
      '--artifact-manifest-path=fixture-manifest.json',
      `--artifact-manifest-sha256=${fakeHash}`,
      '--spout-sender-path=fixture-spout.exe',
      `--expected-spout-sender-sha256=${fakeHash}`
    ];
    signalingWrapperContractValid = requiredIdentityArguments.every(
      (argument) => forwarded.includes(argument)
    );
    const installedFirefoxArgs = prepareSignalingArgs(
      ['--browser', 'firefox-installed'],
      fakeDependencies
    );
    signalingWrapperContractValid = signalingWrapperContractValid &&
      installedFirefoxArgs.includes('--firefox-path=fixture-firefox.exe') &&
      installedFirefoxArgs.includes(`--expected-firefox-sha256=${fakeHash}`);

    let partialArtifactIdentityRejected = false;
    try {
      prepareSignalingArgs(
        ['--browser=edge', '--publisher-path=incomplete.exe'],
        fakeDependencies
      );
    } catch (error) {
      partialArtifactIdentityRejected = /must be supplied together/i.test(error.message);
    }
    let partialFirefoxIdentityRejected = false;
    try {
      prepareSignalingArgs(
        ['--browser=firefox-installed', '--firefox-path=incomplete.exe'],
        fakeDependencies
      );
    } catch (error) {
      partialFirefoxIdentityRejected = /must be supplied together/i.test(error.message);
    }
    signalingWrapperContractValid = signalingWrapperContractValid &&
      partialArtifactIdentityRejected &&
      partialFirefoxIdentityRejected;
    if (!signalingWrapperContractValid) {
      signalingWrapperFailure = 'resolver did not enforce complete artifact and browser identities';
    }
  } catch (error) {
    signalingWrapperContractValid = false;
    signalingWrapperFailure = error.message;
  }
}
check(
  'bare-signaling-commands-resolve-exact-artifacts',
  signalingWrapperContractValid,
  signalingWrapperFailure
);

const readinessScript = fs.readFileSync(
  path.join(nativeRoot, 'qa', 'run-release-readiness.ps1'),
  'utf8'
);
const assignedPassVariables = new Set(
  [...readinessScript.matchAll(/^\s*\$([A-Za-z][A-Za-z0-9]*Pass)\s*=/gmu)]
    .map((match) => match[1])
);
const reportedPassVariables = [
  ...readinessScript.matchAll(/^\s*\$lines\s*\+=[^\r\n]*?\$([A-Za-z][A-Za-z0-9]*Pass)\b/gmu)
].map((match) => match[1]);
const undefinedReportedVariables = [...new Set(
  reportedPassVariables.filter((name) => !assignedPassVariables.has(name))
)];
check(
  'release-report-only-references-defined-results',
  undefinedReportedVariables.length === 0,
  `undefined report result variables: ${undefinedReportedVariables.join(', ') || '(none)'}`
);

if (failures.length > 0) {
  console.error(`[QA-CONTRACT] ${failures.length} regression check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('[QA-CONTRACT] All QA entrypoint contracts passed');
}
