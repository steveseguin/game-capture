'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const nativeRoot = path.resolve(__dirname, '..');
const harnessPath = path.join(__dirname, 'signaling-regressions-e2e.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function optionName(arg) {
  return String(arg || '').split('=', 1)[0];
}

function findFilesNamed(root, filename, maxDepth) {
  if (!root || !fs.existsSync(root) || maxDepth < 0) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return path.basename(root).toLowerCase() === filename.toLowerCase() ? [root] : [];
  }
  if (!stat.isDirectory()) return [];

  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      matches.push(fullPath);
    } else if (entry.isDirectory() && maxDepth > 0) {
      matches.push(...findFilesNamed(fullPath, filename, maxDepth - 1));
    }
  }
  return matches;
}

function uniqueRealPaths(paths) {
  const byIdentity = new Map();
  for (const candidate of paths) {
    const resolved = fs.realpathSync.native
      ? fs.realpathSync.native(candidate)
      : fs.realpathSync(candidate);
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    byIdentity.set(identity, resolved);
  }
  return [...byIdentity.values()];
}

function resolveSpoutSender(buildDir) {
  let candidates = [];
  if (buildDir) {
    const resolvedBuildDir = path.resolve(nativeRoot, buildDir);
    candidates = findFilesNamed(resolvedBuildDir, 'spout_test_sender.exe', 5);
  } else {
    const buildRoots = fs.readdirSync(nativeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^build(?:-|$)/i.test(entry.name))
      .map((entry) => path.join(nativeRoot, entry.name));
    for (const buildRoot of buildRoots) {
      candidates.push(...findFilesNamed(buildRoot, 'spout_test_sender.exe', 5));
    }
  }
  candidates = uniqueRealPaths(candidates);
  if (candidates.length !== 1) {
    const detail = candidates.length > 0
      ? ` Candidates: ${candidates.join(', ')}`
      : '';
    throw new Error(
      `Expected exactly one built spout_test_sender.exe; found ${candidates.length}. ` +
      `Pass --build-dir=<directory> to disambiguate.${detail}`
    );
  }
  return candidates[0];
}

function resolveCurrentPackage() {
  const cmakeText = fs.readFileSync(path.join(nativeRoot, 'CMakeLists.txt'), 'utf8');
  const versionMatch = cmakeText.match(/project\s*\([^)]*\bVERSION\s+([0-9]+(?:\.[0-9]+)+)/iu);
  if (!versionMatch) {
    throw new Error('Could not resolve the package version from CMakeLists.txt');
  }
  const packageDir = path.join(
    nativeRoot,
    'dist',
    `game-capture-${versionMatch[1]}-win64`
  );
  const publisherPath = path.join(packageDir, 'game-capture.exe');
  const artifactManifestPath = path.join(packageDir, 'release-artifact-manifest.json');
  for (const requiredPath of [publisherPath, artifactManifestPath]) {
    if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
      throw new Error(
        `Current packaged artifact is missing: ${requiredPath}. ` +
        'Run qa/build-release.ps1 first.'
      );
    }
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(artifactManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse release artifact manifest: ${error.message}`);
  }
  const manifestBuildDir = manifest && manifest.build &&
    typeof manifest.build.directory === 'string'
    ? manifest.build.directory.trim()
    : '';
  if (!manifestBuildDir) {
    throw new Error('Release artifact manifest does not identify its build directory');
  }
  return { publisherPath, artifactManifestPath, manifestBuildDir };
}

function resolveInstalledFirefox() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean);
  const candidates = uniqueRealPaths(
    roots
      .map((root) => path.join(root, 'Mozilla Firefox', 'firefox.exe'))
      .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one installed Firefox executable; found ${candidates.length}. ` +
      'Pass --firefox-path and --expected-firefox-sha256 explicitly.'
    );
  }
  return candidates[0];
}

function prepareSignalingArgs(sourceArgs, overrides = {}) {
  const dependencies = {
    resolveCurrentPackage,
    resolveSpoutSender,
    resolveInstalledFirefox,
    sha256File,
    ...overrides
  };
  const forwardedArgs = [];
  let buildDir = '';
  for (let index = 0; index < sourceArgs.length; index += 1) {
    const arg = sourceArgs[index];
    if (arg === '--build-dir') {
      buildDir = String(sourceArgs[++index] || '').trim();
      if (!buildDir) throw new Error('--build-dir requires a value');
    } else if (arg.startsWith('--build-dir=')) {
      buildDir = arg.slice('--build-dir='.length).trim();
      if (!buildDir) throw new Error('--build-dir requires a value');
    } else {
      forwardedArgs.push(arg);
    }
  }

  const artifactOptions = new Set([
    '--publisher-path',
    '--artifact-manifest-path',
    '--artifact-manifest-sha256',
    '--spout-sender-path',
    '--expected-spout-sender-sha256'
  ]);
  const explicitArtifactOptions = new Set(
    forwardedArgs.map(optionName).filter((name) => artifactOptions.has(name))
  );
  if (explicitArtifactOptions.size === 0) {
    const {
      publisherPath,
      artifactManifestPath,
      manifestBuildDir
    } = dependencies.resolveCurrentPackage();
    const resolvedBuildDir = buildDir || manifestBuildDir;
    const spoutSenderPath = dependencies.resolveSpoutSender(resolvedBuildDir);
    forwardedArgs.push(
      `--publisher-path=${publisherPath}`,
      `--artifact-manifest-path=${artifactManifestPath}`,
      `--artifact-manifest-sha256=${dependencies.sha256File(artifactManifestPath)}`,
      `--spout-sender-path=${spoutSenderPath}`,
      `--expected-spout-sender-sha256=${dependencies.sha256File(spoutSenderPath)}`
    );
    console.log(`[SIGNAL-E2E] Resolved packaged publisher: ${publisherPath}`);
    console.log(`[SIGNAL-E2E] Resolved manifest build directory: ${resolvedBuildDir}`);
    console.log(`[SIGNAL-E2E] Resolved Spout fixture: ${spoutSenderPath}`);
  } else if (explicitArtifactOptions.size !== artifactOptions.size) {
    throw new Error('Packaged artifact identity arguments must be supplied together');
  } else if (buildDir) {
    throw new Error('--build-dir cannot be combined with explicit artifact identity arguments');
  }

  const installedFirefox = forwardedArgs.some(
    (arg, index) => arg === '--browser=firefox-installed' ||
      (arg === '--browser' && forwardedArgs[index + 1] === 'firefox-installed')
  );
  const firefoxIdentityOptions = new Set([
    '--firefox-path',
    '--expected-firefox-sha256'
  ]);
  const explicitFirefoxOptions = new Set(
    forwardedArgs.map(optionName).filter((name) => firefoxIdentityOptions.has(name))
  );
  if (installedFirefox && explicitFirefoxOptions.size === 0) {
    const firefoxPath = dependencies.resolveInstalledFirefox();
    forwardedArgs.push(
      `--firefox-path=${firefoxPath}`,
      `--expected-firefox-sha256=${dependencies.sha256File(firefoxPath)}`
    );
    console.log(`[SIGNAL-E2E] Resolved installed Firefox: ${firefoxPath}`);
  } else if (installedFirefox && explicitFirefoxOptions.size !== firefoxIdentityOptions.size) {
    throw new Error('Installed Firefox path and SHA-256 arguments must be supplied together');
  }

  return forwardedArgs;
}

function main() {
  const forwardedArgs = prepareSignalingArgs(process.argv.slice(2));

  const child = spawn(process.execPath, [harnessPath, ...forwardedArgs], {
    cwd: nativeRoot,
    stdio: 'inherit',
    windowsHide: true
  });
  child.on('error', (error) => {
    console.error(`[SIGNAL-E2E] Failed to start harness: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[SIGNAL-E2E] Harness terminated by signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code === null ? 1 : code;
  });
}

module.exports = { prepareSignalingArgs };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[SIGNAL-E2E] ${error.message}`);
    process.exitCode = 1;
  }
}
