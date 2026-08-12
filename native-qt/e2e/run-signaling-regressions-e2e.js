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
  return { publisherPath, artifactManifestPath };
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

function main() {
  const sourceArgs = process.argv.slice(2);
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
  const explicitArtifactOptionCount = forwardedArgs.filter(
    (arg) => artifactOptions.has(optionName(arg))
  ).length;
  if (explicitArtifactOptionCount === 0) {
    const { publisherPath, artifactManifestPath } = resolveCurrentPackage();
    const spoutSenderPath = resolveSpoutSender(buildDir);
    forwardedArgs.push(
      `--publisher-path=${publisherPath}`,
      `--artifact-manifest-path=${artifactManifestPath}`,
      `--artifact-manifest-sha256=${sha256File(artifactManifestPath)}`,
      `--spout-sender-path=${spoutSenderPath}`,
      `--expected-spout-sender-sha256=${sha256File(spoutSenderPath)}`
    );
    console.log(`[SIGNAL-E2E] Resolved packaged publisher: ${publisherPath}`);
    console.log(`[SIGNAL-E2E] Resolved Spout fixture: ${spoutSenderPath}`);
  } else if (buildDir) {
    throw new Error('--build-dir cannot be combined with explicit artifact identity arguments');
  }

  const installedFirefox = forwardedArgs.some(
    (arg) => arg === '--browser=firefox-installed'
  );
  const firefoxIdentityOptions = new Set([
    '--firefox-path',
    '--expected-firefox-sha256'
  ]);
  const explicitFirefoxOptionCount = forwardedArgs.filter(
    (arg) => firefoxIdentityOptions.has(optionName(arg))
  ).length;
  if (installedFirefox && explicitFirefoxOptionCount === 0) {
    const firefoxPath = resolveInstalledFirefox();
    forwardedArgs.push(
      `--firefox-path=${firefoxPath}`,
      `--expected-firefox-sha256=${sha256File(firefoxPath)}`
    );
    console.log(`[SIGNAL-E2E] Resolved installed Firefox: ${firefoxPath}`);
  }

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

try {
  main();
} catch (error) {
  console.error(`[SIGNAL-E2E] ${error.message}`);
  process.exitCode = 1;
}
