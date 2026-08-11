'use strict';

const acorn = require('acorn');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePaths = Object.freeze({
  header: 'native-qt/include/versus/ui/main_window.h',
  main: 'native-qt/src/main.cpp',
  mainWindow: 'native-qt/src/ui/main_window.cpp',
  package: 'native-qt/package.json',
  buildRelease: 'native-qt/qa/build-release.ps1',
  readiness: 'native-qt/qa/run-release-readiness.ps1',
  runner: 'native-qt/e2e/ui-wheel-packaged-e2e.js'
});

function readSources() {
  return Object.fromEntries(Object.entries(sourcePaths).map(([name, relativePath]) => [
    name,
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n')
  ]));
}

function occurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function addCheck(checks, id, ok, failure) {
  checks.push({ id, ok: Boolean(ok), failure });
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') {
    return;
  }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') {
          walkAst(child, visit);
        }
      }
    } else if (value && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

function parseRunnerAst(source) {
  try {
    return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (_) {
    return null;
  }
}

function findNamedFunction(ast, name) {
  const matches = [];
  walkAst(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      matches.push(node);
    }
  });
  return matches.length === 1 ? matches[0] : null;
}

function findVariableDeclarators(root, name) {
  const matches = [];
  walkAst(root, (node) => {
    if (node.type === 'VariableDeclarator' && node.id &&
        node.id.type === 'Identifier' && node.id.name === name) {
      matches.push(node);
    }
  });
  return matches;
}

function isDirectCall(node, calleeName) {
  return Boolean(node && node.type === 'CallExpression' &&
    node.callee && node.callee.type === 'Identifier' &&
    node.callee.name === calleeName);
}

function nodeText(source, node) {
  return node ? source.slice(node.start, node.end) : '';
}

function hasThrowingGuardAfter(root, source, afterOffset, requiredFragments) {
  let matched = false;
  walkAst(root, (node) => {
    if (matched || node.type !== 'IfStatement' || node.start <= afterOffset) {
      return;
    }
    const testText = nodeText(source, node.test);
    let throws = false;
    walkAst(node.consequent, (child) => {
      if (child.type === 'ThrowStatement') {
        throws = true;
      }
    });
    if (throws && requiredFragments.every((fragment) => testText.includes(fragment))) {
      matched = true;
    }
  });
  return matched;
}

function runnerOrderingContracts(source, ast) {
  const runFunction = ast && findNamedFunction(ast, 'run');
  if (!runFunction) {
    return { settings: false, artifact: false, output: false };
  }
  const unique = (name) => {
    const matches = findVariableDeclarators(runFunction.body, name);
    return matches.length === 1 ? matches[0] : null;
  };
  const child = unique('childResult');
  const settingsBefore = unique('settingsBefore');
  const settingsAfter = unique('settingsAfter');
  const hashBefore = unique('executableHashBefore');
  const hashAfter = unique('executableHashAfter');
  const payloadBefore = unique('payloadBefore');
  const payloadAfter = unique('payloadAfter');
  const started = unique('startedAtMs');
  const finished = unique('finishedAtMs');
  const resultStat = unique('resultStat');

  const settings = Boolean(child && settingsBefore && settingsAfter &&
    isDirectCall(settingsBefore.init, 'settingsFingerprint') &&
    isDirectCall(settingsAfter.init, 'settingsFingerprint') &&
    settingsBefore.end < child.start && settingsAfter.start > child.end &&
    hasThrowingGuardAfter(
      runFunction.body,
      source,
      settingsAfter.end,
      ['settingsBefore.registry32', 'settingsAfter.registry32',
        'settingsBefore.registry64', 'settingsAfter.registry64']
    ));

  const artifact = Boolean(child && hashBefore && hashAfter && payloadBefore && payloadAfter &&
    isDirectCall(hashBefore.init, 'sha256File') &&
    isDirectCall(hashAfter.init, 'sha256File') &&
    isDirectCall(payloadBefore.init, 'verifyPackagePayload') &&
    isDirectCall(payloadAfter.init, 'verifyPackagePayload') &&
    hashBefore.end < child.start && payloadBefore.end < child.start &&
    hashAfter.start > child.end && payloadAfter.start > child.end &&
    source.slice(payloadAfter.end).includes(
      'assertPayloadSnapshotsEqual(payloadBefore, payloadAfter);'
    ) &&
    hasThrowingGuardAfter(
      runFunction.body,
      source,
      hashAfter.end,
      ['executableHashBefore', 'executableHashAfter', 'artifact.executableSha256']
    ));

  let output = Boolean(child && started && finished && resultStat &&
    started.end < child.start && finished.start > child.end &&
    resultStat.start > finished.end);
  if (output) {
    output = false;
    walkAst(runFunction.body, (node) => {
      if (output || node.type !== 'IfStatement' || node.start <= resultStat.end) {
        return;
      }
      const testText = nodeText(source, node.test).replace(/\s+/g, '');
      let throws = false;
      walkAst(node.consequent, (childNode) => {
        if (childNode.type === 'ThrowStatement') {
          throws = true;
        }
      });
      if (throws &&
          testText.includes('resultStat.mtimeMs<startedAtMs-1000') &&
          testText.includes('resultStat.mtimeMs>finishedAtMs+1000')) {
        output = true;
      }
    });
  }
  return { settings, artifact, output };
}

function validateSourceSet(sources) {
  const checks = [];
  const runnerAst = parseRunnerAst(sources.runner);
  const runnerSyntaxOk = Boolean(runnerAst);
  const ordering = runnerOrderingContracts(sources.runner, runnerAst);
  addCheck(
    checks,
    'UI_WHEEL_RUNNER_SYNTAX',
    runnerSyntaxOk,
    'The packaged runner must remain valid JavaScript.'
  );

  let packageJson = null;
  try {
    packageJson = JSON.parse(sources.package);
  } catch (_) {
    packageJson = null;
  }
  addCheck(
    checks,
    'UI_WHEEL_PACKAGE_ALIASES',
    packageJson && packageJson.scripts &&
      packageJson.scripts['e2e:ui-wheel:packaged'] ===
        'node e2e/ui-wheel-packaged-e2e.js' &&
      packageJson.scripts['gate:ui-wheel-e2e'] ===
        'node e2e/ui-wheel-e2e-regression.js',
    'Package aliases must map exactly to the real packaged runner and its regression instrument.'
  );

  const exactRunnerControlMatrix =
    /const EXPECTED_CONTROLS = Object\.freeze\(\[\n  'viewerLimitSpin',\n  'primaryAudioGainSpin',\n  'microphoneAudioGainSpin'\n\]\);/.test(sources.runner);
  const exactRunnerDirectionMatrix =
    /const EXPECTED_DIRECTIONS = Object\.freeze\(\['up', 'down'\]\);/.test(sources.runner) &&
    /const EXPECTED_MODES = Object\.freeze\(\['unfocused', 'focused'\]\);/.test(sources.runner);
  addCheck(
    checks,
    'UI_WHEEL_RUNNER_EXACT_MATRIX',
    exactRunnerControlMatrix && exactRunnerDirectionMatrix &&
      sources.runner.includes(
        'const EXPECTED_CASE_COUNT = EXPECTED_CONTROLS.length *\n' +
        '  EXPECTED_DIRECTIONS.length * EXPECTED_MODES.length;'
      ) &&
      sources.runner.includes('observedKeys.size !== expectedKeys.size'),
    'The runner must require every exact control, direction, and focus mode once.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_MANIFEST_BINDING',
    sources.runner.includes("const RELEASE_MANIFEST_SCHEMA = 'game-capture-release-artifact/v1';") &&
      sources.runner.includes('manifestSha256 !== config.artifactManifestSha256') &&
      sources.runner.includes("manifest.artifact.relativePath !== 'game-capture.exe'") &&
      sources.runner.includes('comparablePath(executable) !== comparablePath(manifestExecutable)') &&
      sources.runner.includes('executableSha256 !== manifest.artifact.sha256') &&
      sources.runner.includes("path.join(path.dirname(config.publisherPath), 'platforms', 'qwindows.dll')"),
    'The runner must bind a complete packaged executable to its exact co-located release manifest.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RELEASE_MANIFEST_COMPLETE_PAYLOAD',
    sources.buildRelease.includes(
      "algorithm = 'sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1'"
    ) &&
      sources.buildRelease.includes(
        '$payloadInventory = Get-ReleasePayloadInventory -StageRoot $stageDir -ExcludedRelativePath'
      ) &&
      sources.buildRelease.includes('fileCount = $payloadInventory.fileCount') &&
      sources.buildRelease.includes('aggregateSha256 = $payloadInventory.aggregateSha256') &&
      sources.buildRelease.includes('files = @($payloadInventory.files)') &&
      sources.buildRelease.includes("relativePath = 'game-capture.exe'") &&
      sources.buildRelease.includes("$qtConfiguration = @'\n[Paths]\nPrefix=.\nPlugins=.\n'@"),
    'Release packaging must bind every positive-size staged payload file, except the manifest, using ordinal normalized paths, SHA-256, exact count, and a deterministic aggregate; qt.conf must confine plugin discovery to the package.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_PACKAGED_RUNTIME_IDENTITY',
    sources.runner.includes('function assertRuntimeModuleIdentity(report, artifact) {') &&
      sources.runner.includes("loadedNonSystemOrQtModules") &&
      sources.runner.includes("const requiredQtModules = new Set(REQUIRED_QT_RUNTIME_MODULES);") &&
      sources.runner.includes("relativePath !== 'platforms/qwindows.dll'") &&
      sources.runner.includes('artifact.payloadByRelativePath.get(relativePath)') &&
      sources.runner.includes('sha256File(modulePath) !== payloadEntry.sha256'),
    'The runner must bind the native process\'s loaded Qt and qwindows module paths and bytes to the complete package manifest.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_HERMETIC_RUNTIME',
    sources.runner.includes('function createHermeticChildEnvironment(packageRoot) {') &&
      sources.runner.includes('const hermeticEnvironment = createHermeticChildEnvironment(artifact.packageRoot);') &&
      sources.runner.includes('env: hermeticEnvironment') &&
      sources.runner.includes("const safePath = [packageRoot, system32Path, systemRoot].join(path.delimiter);") &&
      sources.runner.includes("if (/^(?:QT_|QML|VCPKG)/i.test(name))") &&
      !sources.runner.includes('env: process.env'),
    'The packaged child must run with a deliberately constructed system/package environment that cannot inherit Qt or vcpkg fallback paths.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_EXACT_EXECUTABLE',
    occurrences(
      sources.runner,
      '  const childResult = spawnSync(\n    artifact.executable,\n'
    ) === 1 &&
      sources.runner.includes('`--ui-wheel-e2e-expected-sha256=${artifact.executableSha256}`') &&
      sources.runner.includes('`--ui-wheel-e2e-run-id=${runId}`') &&
      sources.runner.includes('comparablePath(report.artifact.path) !== comparablePath(artifact.executable)'),
    'The runner must launch only the manifest-validated executable and bind its self-reported identity.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_EXIT_GUARD',
    occurrences(sources.runner, '  if (childResult.status !== 0) {') === 1 &&
      sources.runner.includes(
        'throw new Error(`Packaged wheel process exited with code ${childResult.status}`);'
      ) &&
      sources.runner.indexOf('if (childResult.status !== 0)') <
        sources.runner.indexOf('assertReportContract(report, artifact, runId);'),
    'A nonzero packaged-app exit must fail before any passing verdict is accepted.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_OUTPUT_GUARD',
    occurrences(sources.runner, '  if (!fs.existsSync(resultPath)) {') === 1 &&
      sources.runner.includes('const resultStat = fs.lstatSync(resultPath);') &&
      sources.runner.includes('!resultStat.isFile() || resultStat.isSymbolicLink()') &&
      sources.runner.includes('resultStat.mtimeMs < startedAtMs - 1000') &&
      sources.runner.indexOf('if (!fs.existsSync(resultPath))') <
        sources.runner.indexOf('JSON.parse(reportBytes.toString'),
    'Missing, stale, non-file, or symlinked app output must fail the packaged runner.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_COMPUTED_VERDICT',
    occurrences(
      sources.runner,
      '  const reportOk = report.pass === true && report.cases.every((entry) => entry.pass === true);'
    ) === 1 &&
      sources.runner.includes('interaction.valueAfter !== interaction.valueBefore') &&
      sources.runner.includes('interaction.scrollAfter < interaction.scrollBefore') &&
      sources.runner.includes('interaction.scrollAfter > interaction.scrollBefore') &&
      sources.runner.includes('interaction.spontaneousWheelEvents < 1') &&
      sources.runner.includes("interaction.inputMethod !== 'Win32.SendInput'"),
    'The runner must recompute behavior from detailed evidence instead of trusting a top-level true.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_SETTINGS_GUARD',
    sources.runner.includes("const SETTINGS_REGISTRY_KEY = 'HKCU\\\\Software\\\\VDO.Ninja\\\\Game Capture';") &&
      sources.runner.includes('const settingsBefore = settingsFingerprint();') &&
      sources.runner.includes('const settingsAfter = settingsFingerprint();') &&
      sources.runner.includes('settingsBefore.registry32 !== settingsAfter.registry32') &&
      sources.runner.includes('settingsBefore.registry64 !== settingsAfter.registry64'),
    'The packaged workflow must fingerprint both user-settings registry views before and after execution.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_SETTINGS_MEASUREMENT_ORDER',
    ordering.settings,
    'Registry settings must be measured by independent calls on opposite sides of the packaged child and compared by a throwing guard.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_ARTIFACT_STABILITY',
    ordering.artifact,
    'Executable and complete payload identities must be independently measured before and after the packaged child, then compared fail-closed.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_OUTPUT_TIME_BOUNDS',
    ordering.output,
    'Native JSON evidence must be a regular file whose mtime is bounded on both sides by this child invocation.'
  );

  addCheck(
    checks,
    'UI_WHEEL_RUNNER_FOCUSED_CLICK_EVIDENCE',
    sources.runner.includes(
      "interaction.focusClickSendInputAcceptedCount !== (interaction.mode === 'focused' ? 2 : 0)"
    ) &&
      sources.runner.includes(
        "assertNativeInputBoundaryEvidence(interaction.focusClickBoundary, interaction.mode === 'focused', key);"
      ),
    'Every focused row must prove exactly two accepted native click inputs and a guarded input boundary; every unfocused row must prove zero click inputs.'
  );

  const cppControlMatrix =
    /const QStringList expectedControls\{\n        QStringLiteral\("viewerLimitSpin"\),\n        QStringLiteral\("primaryAudioGainSpin"\),\n        QStringLiteral\("microphoneAudioGainSpin"\)\n    \};/.test(sources.mainWindow);
  const cppDirections =
    /\{"up", WHEEL_DELTA\},\n        \{"down", -WHEEL_DELTA\}/.test(sources.mainWindow) &&
    /QStringLiteral\("unfocused"\),\n        QStringLiteral\("focused"\)/.test(sources.mainWindow);
  addCheck(
    checks,
    'UI_WHEEL_CPP_EXACT_MATRIX',
    cppControlMatrix && cppDirections &&
      sources.mainWindow.includes(
        'const int expectedCaseCount = expectedControls.size() *\n' +
        '        expectedDirections.size() * expectedModes.size();'
      ),
    'The app mode must execute the complete three-control, two-direction, two-focus-state matrix.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_NATIVE_SENDINPUT',
    occurrences(
      sources.mainWindow,
      'const UINT accepted = SendInput(1, &input, sizeof(INPUT));'
    ) === 1 &&
      occurrences(
        sources.mainWindow,
        'const UINT accepted = SendInput(2, inputs, sizeof(INPUT));'
      ) === 1 &&
      sources.mainWindow.includes('input.mi.dwFlags = MOUSEEVENTF_WHEEL;') &&
      sources.mainWindow.includes('input.mi.mouseData = static_cast<DWORD>(angleDeltaY);') &&
      sources.mainWindow.includes('if (event->spontaneous())') &&
      !sources.mainWindow.includes('QTest::wheelEvent'),
    'The app mode must use real Win32 SendInput wheel/click input and observe spontaneous Qt delivery.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_FOCUSED_CLICK_BINDING',
    occurrences(sources.mainWindow, 'focusSetupOk = sendNativePrimaryClick(') === 1 &&
      sources.mainWindow.includes('&focusClickBoundary,') &&
      sources.mainWindow.includes('&acceptedClickInputs);') &&
      sources.mainWindow.includes(
        'caseResult["focusClickSendInputAcceptedCount"] = static_cast<int>(acceptedClickInputs);'
      ),
    'Focused setup must be caused by the measured native SendInput click and bind its accepted-input count into every case report.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_TARGET_HIT_GUARD',
    sources.mainWindow.includes(
      'boundary.targetHit = widgetIsOrDescendsFrom(hitWidget, expectedTarget);'
    ) &&
      occurrences(sources.mainWindow, 'if (!prepareNativeInputBoundary(') === 2,
    'Both native click and wheel input must fail before SendInput unless the exact screen coordinate hits the intended spin box.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_FOREGROUND_GUARD',
    sources.mainWindow.includes(
      'boundary.foregroundMatches = GetForegroundWindow() == expectedForegroundWindow;'
    ) &&
      sources.mainWindow.includes(
        'return boundary.cursorPositionMatches && boundary.targetHit && boundary.foregroundMatches;'
      ),
    'The shared native-input boundary must fail closed unless the packaged MainWindow is still the foreground window.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_CURSOR_POSITION_GUARD',
    sources.mainWindow.includes(
      'boundary.cursorPositionMatches = QCursor::pos() == globalPosition;'
    ) &&
      sources.mainWindow.includes(
        'return boundary.cursorPositionMatches && boundary.targetHit && boundary.foregroundMatches;'
      ),
    'The shared native-input boundary must verify the cursor reached the measured target coordinate before SendInput.'
  );

  const previousForegroundOffset = sources.mainWindow.indexOf(
    'const HWND previousForegroundWindow = GetForegroundWindow();'
  );
  const showOffset = sources.mainWindow.indexOf('    showNormal();', previousForegroundOffset);
  const restoreForegroundOffset = sources.mainWindow.indexOf(
    'SetForegroundWindow(previousForegroundWindow);',
    showOffset
  );
  const restoreCursorOffset = sources.mainWindow.indexOf(
    'QCursor::setPos(previousCursorPosition);',
    restoreForegroundOffset
  );
  addCheck(
    checks,
    'UI_WHEEL_CPP_FOREGROUND_RESTORE_ORDER',
    previousForegroundOffset >= 0 && showOffset > previousForegroundOffset &&
      restoreForegroundOffset > showOffset && restoreCursorOffset > restoreForegroundOffset,
    'The workflow must capture the prior foreground/cursor before showing itself, restore foreground after input, then restore the cursor.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_RUNTIME_MODULE_CLASSIFICATION',
    sources.mainWindow.includes(
      "return candidate.startsWith(root + QLatin1Char('/'), Qt::CaseInsensitive);"
    ) &&
      sources.mainWindow.includes('if (!system || qtRuntime) {'),
    'Native runtime evidence must classify Qt-normalized SystemRoot paths with the same normalized separator before filtering system modules.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_COMPUTED_VERDICT',
    occurrences(
      sources.mainWindow,
      '    const bool passed = setupFailures.isEmpty() &&\n' +
      '        cases.size() == expectedCaseCount &&\n' +
      '        passedCaseCount == expectedCaseCount;'
    ) === 1 &&
      sources.mainWindow.includes('const bool valueStable = valueAfter == valueBefore;') &&
      sources.mainWindow.includes('const bool pageStayed = scrollAfter == scrollBefore;') &&
      sources.mainWindow.includes('const bool casePassed = failures.isEmpty();') &&
      sources.mainWindow.includes('return passed ? 0 : 41;'),
    'The app must derive both its JSON verdict and exit code from measured interaction outcomes.'
  );

  addCheck(
    checks,
    'UI_WHEEL_CPP_OUTPUT_GUARD',
    sources.mainWindow.includes('QSaveFile output(absoluteOutputPath);') &&
      sources.mainWindow.includes('if (!output.open(QIODevice::WriteOnly))') &&
      sources.mainWindow.includes('output.write(encoded) != encoded.size() || !output.commit()') &&
      sources.header.includes('int runUiWheelEndToEnd('),
    'The app mode must atomically emit detailed JSON and return nonzero if output cannot be committed.'
  );

  const appModeBeforeCore = sources.main.indexOf('if (uiWheelE2eRequested) {') >= 0 &&
    sources.main.indexOf('if (uiWheelE2eRequested) {') <
      sources.main.indexOf('auto coreHolder = std::make_unique<versus::app::VersusApp>();');
  addCheck(
    checks,
    'UI_WHEEL_CPP_PERSISTENCE_ISOLATION',
    sources.header.includes('bool persistedSettingsEnabled = true;') &&
      sources.main.includes('runtimeOptions.persistedSettingsEnabled = false;') &&
      sources.main.includes('runtimeOptions.systemIntegrationsEnabled = false;') &&
      sources.mainWindow.includes(
        'if (!runtimeOptions_.persistedSettingsEnabled || loadingPersistedSettings_) {'
      ) &&
      sources.mainWindow.includes('if (!runtimeOptions_.systemIntegrationsEnabled) {') &&
      appModeBeforeCore,
    'The app E2E instance must structurally bypass persistence, prompts/tray integration, and core initialization.'
  );

  addCheck(
    checks,
    'UI_WHEEL_MAIN_ARGUMENT_BINDING',
    sources.main.includes('uiWheelE2eOutArg = arg.substr(19);') &&
      sources.main.includes('uiWheelE2eExpectedSha256Arg = arg.substr(31);') &&
      sources.main.includes('uiWheelE2eRunIdArg = arg.substr(22);') &&
      sources.main.includes('return window.runUiWheelEndToEnd('),
    'The executable must bind the exact output, expected hash, and fresh run ID arguments.'
  );

  const instrumentOffset = sources.readiness.indexOf(
    'node.exe (Join-Path $script:repoRoot "e2e/ui-wheel-e2e-regression.js")'
  );
  const packagedOffset = sources.readiness.indexOf(
    'node.exe (Join-Path $script:repoRoot "e2e/ui-wheel-packaged-e2e.js")'
  );
  const fixtureOffset = sources.readiness.indexOf('"gate:signaling-media-fixture"');
  addCheck(
    checks,
    'UI_WHEEL_RELEASE_WIRING',
    instrumentOffset >= 0 && packagedOffset > instrumentOffset && fixtureOffset > packagedOffset &&
      occurrences(sources.readiness, 'e2e/ui-wheel-e2e-regression.js') === 1 &&
      occurrences(sources.readiness, 'e2e/ui-wheel-packaged-e2e.js') === 1 &&
      sources.readiness.includes('if (-not $uiWheelInstrumentPass) {') &&
      sources.readiness.includes('"--publisher-path=$script:publisherExe"') &&
      sources.readiness.includes(
        '"--artifact-manifest-path=$script:artifactManifestPathBinding"'
      ) &&
      sources.readiness.includes(
        '"--artifact-manifest-sha256=$script:artifactManifestSha256Binding"'
      ) &&
      sources.readiness.includes('$allPass = $allPass -and $uiWheelPass'),
    'Release readiness must fail-fast the instrument, then run the exact manifest-bound packaged workflow before signaling.'
  );

  return checks;
}

function replaceExactlyOnce(source, before, after) {
  const first = source.indexOf(before);
  const second = first >= 0 ? source.indexOf(before, first + before.length) : -1;
  if (!before || first < 0 || second >= 0) {
    throw new Error(`Mutation source is not unique: ${before}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function failedIds(checks) {
  return checks.filter((entry) => !entry.ok).map((entry) => entry.id).sort();
}

function assertExactIds(name, actual, expected) {
  const actualText = [...new Set(actual)].sort().join(',');
  const expectedText = [...new Set(expected)].sort().join(',');
  if (actualText !== expectedText) {
    throw new Error(
      `Mutation ${name} failed the wrong policies: expected=[${expectedText}] actual=[${actualText}]`
    );
  }
  console.log(`[UI WHEEL MUTATION PASS] ${name}: ${actualText}`);
}

function makeValidReport(artifact, runId) {
  const cases = [];
  for (const control of ['viewerLimitSpin', 'primaryAudioGainSpin', 'microphoneAudioGainSpin']) {
    for (const mode of ['unfocused', 'focused']) {
      for (const direction of ['up', 'down']) {
        const up = direction === 'up';
        const interaction = {
          control,
          mode,
          direction,
          angleDeltaY: up ? 120 : -120,
          inputMethod: 'Win32.SendInput',
          focusClickSendInputAcceptedCount: mode === 'focused' ? 2 : 0,
          focusClickBoundary: {
            evaluated: mode === 'focused',
            cursorPositionMatches: mode === 'focused',
            targetHit: mode === 'focused',
            foregroundMatches: mode === 'focused'
          },
          focusSetupOk: true,
          sendInputAccepted: true,
          sendInputAcceptedCount: 1,
          wheelBoundary: {
            evaluated: true,
            cursorPositionMatches: true,
            targetHit: true,
            foregroundMatches: true
          },
          observedWheelEvents: 1,
          spontaneousWheelEvents: 1,
          valueBefore: 100,
          valueAfter: mode === 'focused' ? (up ? 101 : 99) : 100,
          scrollBefore: 100,
          scrollAfter: mode === 'unfocused' ? (up ? 90 : 110) : 100,
          focusRetained: true,
          pass: true,
          failures: []
        };
        if (mode === 'unfocused') {
          interaction.valueStable = true;
          interaction.pageMovedInDirection = true;
        } else {
          interaction.valueEditedInDirection = true;
          interaction.pageStayed = true;
        }
        cases.push(interaction);
      }
    }
  }
  return {
    schema: 'game-capture-ui-wheel-e2e/v1',
    runId,
    appVersion: artifact.manifest.version,
    expectedControls: ['viewerLimitSpin', 'primaryAudioGainSpin', 'microphoneAudioGainSpin'],
    expectedDirections: ['up', 'down'],
    expectedModes: ['unfocused', 'focused'],
    boundedDeadlineMs: 15000,
    elapsedMs: 1000,
    artifact: {
      path: artifact.executable,
      size: artifact.executableSize,
      sha256: artifact.executableSha256,
      expectedSha256: artifact.executableSha256,
      identityMatches: true
    },
    input: {
      method: 'Win32.SendInput',
      wheelApi: 'user32!SendInput/MOUSEEVENTF_WHEEL',
      nativePlatform: true
    },
    persistence: {
      enabled: false,
      settingSignalsConnected: false,
      systemIntegrationsEnabled: false
    },
    runtime: {
      moduleEnumerationSucceeded: true,
      observedModuleCount: artifact.runtimeModules.length,
      reportedModuleCount: artifact.runtimeModules.length,
      loadedNonSystemOrQtModules: artifact.runtimeModules.map((entry) => ({ ...entry }))
    },
    window: {
      foregroundAcquired: true,
      scrollMinimum: 0,
      scrollMaximum: 500
    },
    setupFailures: [],
    cases,
    caseCount: 12,
    expectedCaseCount: 12,
    passedCaseCount: 12,
    pass: true
  };
}

function assertReportInstrument() {
  const runner = require('./ui-wheel-packaged-e2e.js');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-ui-wheel-report-'));
  try {
    const fixtureFiles = [
      'game-capture.exe',
      'Qt6Core.dll',
      'Qt6Gui.dll',
      'Qt6Network.dll',
      'Qt6Widgets.dll',
      'platforms/qwindows.dll'
    ];
    const payloadByRelativePath = new Map();
    const runtimeModules = [];
    for (const relativePath of fixtureFiles) {
      const absolutePath = path.join(fixtureRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const bytes = Buffer.from(`instrument:${relativePath}\n`, 'utf8');
      fs.writeFileSync(absolutePath, bytes, { flag: 'wx' });
      payloadByRelativePath.set(relativePath, Object.freeze({
        relativePath,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }));
      runtimeModules.push({
        name: path.basename(relativePath),
        path: fs.realpathSync(absolutePath),
        qtRuntime: /^Qt6.*\.dll$/i.test(path.basename(relativePath)) ||
          path.basename(relativePath).toLowerCase() === 'qwindows.dll',
        system: false
      });
    }
    const executable = fs.realpathSync(path.join(fixtureRoot, 'game-capture.exe'));
    const executableEntry = payloadByRelativePath.get('game-capture.exe');
    const artifact = {
      executable,
      executableSize: executableEntry.size,
      executableSha256: executableEntry.sha256,
      manifest: { version: '0.2.49' },
      packageRoot: fs.realpathSync(fixtureRoot),
      payloadByRelativePath,
      runtimeModules
    };
    const runId = '0123456789abcdef0123456789abcdef';
    const valid = makeValidReport(artifact, runId);
    runner.assertReportContract(valid, artifact, runId);

    const invalidReports = [
    (() => {
      const value = structuredClone(valid);
      value.cases[0].valueAfter = 101;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.cases[0].spontaneousWheelEvents = 0;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.cases[1] = structuredClone(value.cases[0]);
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.pass = false;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      const focused = value.cases.find((entry) => entry.mode === 'focused');
      focused.focusClickSendInputAcceptedCount = 0;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.cases[0].wheelBoundary.targetHit = false;
      return value;
    })()
    ];
    for (const invalid of invalidReports) {
      let rejected = false;
      try {
        runner.assertReportContract(invalid, artifact, runId);
      } catch (_) {
        rejected = true;
      }
      if (!rejected) {
        throw new Error('Report-contract instrument accepted deliberately invalid evidence');
      }
    }
    console.log('[UI WHEEL INSTRUMENT PASS] valid=accepted invalid=6/6-rejected');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function independentPayloadAggregate(files) {
  const hash = crypto.createHash('sha256');
  for (const entry of files) {
    hash.update(`${entry.relativePath}\0${entry.size}\0${entry.sha256}\n`, 'utf8');
  }
  return hash.digest('hex');
}

function expectRejected(name, action) {
  let rejected = false;
  try {
    action();
  } catch (_) {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`UI wheel instrument accepted invalid ${name}`);
  }
}

function assertPackageAndEnvironmentInstrument() {
  const runner = require('./ui-wheel-packaged-e2e.js');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-ui-wheel-package-'));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-ui-wheel-external-'));
  const manifestPath = path.join(fixtureRoot, 'release-artifact-manifest.json');
  try {
    const contents = new Map([
      ['game-capture.exe', Buffer.from('instrument executable\n', 'utf8')],
      ['platforms/qwindows.dll', Buffer.from('instrument qwindows\n', 'utf8')],
      ['qt.conf', Buffer.from('[Paths]\nPrefix=.\nPlugins=.\n', 'utf8')]
    ]);
    const files = [];
    for (const [relativePath, bytes] of contents) {
      const absolutePath = path.join(fixtureRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, bytes, { flag: 'wx' });
      files.push({
        relativePath,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
    }
    files.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
    const executableEntry = files.find((entry) => entry.relativePath === 'game-capture.exe');
    const manifest = {
      schema: 'game-capture-release-artifact/v1',
      version: '0.2.49',
      artifact: { ...executableEntry },
      payload: {
        algorithm: 'sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1',
        fileCount: files.length,
        aggregateSha256: independentPayloadAggregate(files),
        files
      }
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(manifestPath, manifestBytes, { flag: 'wx' });
    const config = {
      publisherPath: path.join(fixtureRoot, 'game-capture.exe'),
      artifactManifestPath: manifestPath,
      artifactManifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex')
    };
    runner.validatePackagedArtifact(config);

    const extraPath = path.join(fixtureRoot, 'unowned.dll');
    fs.writeFileSync(extraPath, 'unowned payload\n', { flag: 'wx' });
    expectRejected('extra payload file', () => runner.validatePackagedArtifact(config));
    fs.unlinkSync(extraPath);

    const pluginPath = path.join(fixtureRoot, 'platforms', 'qwindows.dll');
    const originalPlugin = fs.readFileSync(pluginPath);
    fs.writeFileSync(pluginPath, 'mutated plugin bytes\n');
    expectRejected('mutated payload bytes', () => runner.validatePackagedArtifact(config));
    fs.writeFileSync(pluginPath, originalPlugin);

    const externalDirectory = path.join(externalRoot, 'outside');
    fs.mkdirSync(externalDirectory);
    fs.writeFileSync(path.join(externalDirectory, 'external.dll'), 'external\n');
    const junctionPath = path.join(fixtureRoot, 'reparse-payload');
    fs.symlinkSync(externalDirectory, junctionPath, 'junction');
    expectRejected('reparse payload directory', () => runner.validatePackagedArtifact(config));
    fs.unlinkSync(junctionPath);

    const savedEnvironment = {
      PATH: process.env.PATH,
      QT_PLUGIN_PATH: process.env.QT_PLUGIN_PATH,
      VCPKG_ROOT: process.env.VCPKG_ROOT
    };
    try {
      process.env.PATH = `C:\\vcpkg\\installed\\x64-windows\\bin${path.delimiter}${process.env.PATH || ''}`;
      process.env.QT_PLUGIN_PATH = 'C:\\vcpkg\\installed\\x64-windows\\Qt6\\plugins';
      process.env.VCPKG_ROOT = 'C:\\vcpkg';
      const environment = runner.createHermeticChildEnvironment(fs.realpathSync(fixtureRoot));
      if (Object.keys(environment).some((name) => /^(?:QT_|QML|VCPKG)/i.test(name)) ||
          /vcpkg/i.test(environment.Path) ||
          !environment.Path.split(path.delimiter).some((entry) =>
            entry.toLowerCase() === fs.realpathSync(fixtureRoot).toLowerCase())) {
        throw new Error('Hermetic child environment retained an external Qt/vcpkg fallback');
      }
    } finally {
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
    console.log('[UI WHEEL PACKAGE INSTRUMENT PASS] valid=accepted invalid=3/3-rejected hermetic=verified');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
}

function run() {
  const sources = readSources();
  const baselineChecks = validateSourceSet(sources);
  const baselineFailures = failedIds(baselineChecks);
  if (baselineFailures.length > 0) {
    for (const check of baselineChecks.filter((entry) => !entry.ok)) {
      console.error(`[UI WHEEL POLICY FAIL] ${check.id}: ${check.failure}`);
    }
    throw new Error(`UI wheel source-policy baseline failed: ${baselineFailures.join(',')}`);
  }
  assertReportInstrument();
  assertPackageAndEnvironmentInstrument();

  const mutations = [
    {
      name: 'forced-runner-true',
      file: 'runner',
      before: '  const reportOk = report.pass === true && report.cases.every((entry) => entry.pass === true);',
      after: '  const reportOk = true;',
      expected: ['UI_WHEEL_RUNNER_COMPUTED_VERDICT']
    },
    {
      name: 'forced-app-true',
      file: 'mainWindow',
      before: '    const bool passed = setupFailures.isEmpty() &&\n        cases.size() == expectedCaseCount &&\n        passedCaseCount == expectedCaseCount;',
      after: '    const bool passed = true;',
      expected: ['UI_WHEEL_CPP_COMPUTED_VERDICT']
    },
    {
      name: 'omitted-control',
      file: 'runner',
      before: "  'viewerLimitSpin',\n",
      after: '',
      expected: ['UI_WHEEL_RUNNER_EXACT_MATRIX']
    },
    {
      name: 'omitted-direction',
      file: 'runner',
      before: "const EXPECTED_DIRECTIONS = Object.freeze(['up', 'down']);",
      after: "const EXPECTED_DIRECTIONS = Object.freeze(['up']);",
      expected: ['UI_WHEEL_RUNNER_EXACT_MATRIX']
    },
    {
      name: 'non-sendinput-substitution',
      file: 'mainWindow',
      before: 'const UINT accepted = SendInput(1, &input, sizeof(INPUT));',
      after: 'const UINT accepted = 1;',
      expected: ['UI_WHEEL_CPP_NATIVE_SENDINPUT']
    },
    {
      name: 'ignored-child-exit',
      file: 'runner',
      before: '  if (childResult.status !== 0) {',
      after: '  if (false && childResult.status !== 0) {',
      expected: ['UI_WHEEL_RUNNER_EXIT_GUARD']
    },
    {
      name: 'wrong-artifact-launch',
      file: 'runner',
      before: '  const childResult = spawnSync(\n    artifact.executable,\n',
      after: '  const childResult = spawnSync(\n    process.execPath,\n',
      expected: ['UI_WHEEL_RUNNER_EXACT_EXECUTABLE']
    },
    {
      name: 'absent-output-accepted',
      file: 'runner',
      before: '  if (!fs.existsSync(resultPath)) {',
      after: '  if (false && !fs.existsSync(resultPath)) {',
      expected: ['UI_WHEEL_RUNNER_OUTPUT_GUARD']
    },
    {
      name: 'persistence-enabled',
      file: 'main',
      before: 'runtimeOptions.persistedSettingsEnabled = false;',
      after: 'runtimeOptions.persistedSettingsEnabled = true;',
      expected: ['UI_WHEEL_CPP_PERSISTENCE_ISOLATION']
    },
    {
      name: 'complete-payload-count-unbound',
      file: 'buildRelease',
      before: '        fileCount = $payloadInventory.fileCount',
      after: '        fileCount = 1',
      expected: ['UI_WHEEL_RELEASE_MANIFEST_COMPLETE_PAYLOAD']
    },
    {
      name: 'runtime-module-hash-bypassed',
      file: 'runner',
      before: 'sha256File(modulePath) !== payloadEntry.sha256',
      after: 'false',
      expected: ['UI_WHEEL_RUNNER_PACKAGED_RUNTIME_IDENTITY']
    },
    {
      name: 'child-inherits-parent-environment',
      file: 'runner',
      before: '      env: hermeticEnvironment,',
      after: '      env: process.env,',
      expected: ['UI_WHEEL_RUNNER_HERMETIC_RUNTIME']
    },
    {
      name: 'focused-click-evidence-ignored',
      file: 'runner',
      before: "interaction.focusClickSendInputAcceptedCount !== (interaction.mode === 'focused' ? 2 : 0)",
      after: 'interaction.focusClickSendInputAcceptedCount < 0',
      expected: ['UI_WHEEL_RUNNER_FOCUSED_CLICK_EVIDENCE']
    },
    {
      name: 'settings-after-moved-before-child',
      file: 'runner',
      changes: [
        {
          before: '  const settingsAfter = settingsFingerprint();\n',
          after: ''
        },
        {
          before: '  const startedAtMs = Date.now();',
          after: '  const settingsAfter = settingsFingerprint();\n  const startedAtMs = Date.now();'
        }
      ],
      expected: ['UI_WHEEL_RUNNER_SETTINGS_MEASUREMENT_ORDER']
    },
    {
      name: 'post-child-executable-hash-aliased',
      file: 'runner',
      before: '  const executableHashAfter = sha256File(artifact.executable);',
      after: '  const executableHashAfter = executableHashBefore;',
      expected: ['UI_WHEEL_RUNNER_ARTIFACT_STABILITY']
    },
    {
      name: 'output-upper-time-bound-bypassed',
      file: 'runner',
      before: 'resultStat.mtimeMs > finishedAtMs + 1000',
      after: 'false',
      expected: ['UI_WHEEL_RUNNER_OUTPUT_TIME_BOUNDS']
    },
    {
      name: 'focused-native-click-replaced-with-direct-focus',
      file: 'mainWindow',
      before: 'focusSetupOk = sendNativePrimaryClick(\n                        globalCenter,\n                        spin,\n                        testWindowHandle,\n                        &focusClickBoundary,\n                        &acceptedClickInputs);',
      after: 'spin->setFocus(Qt::OtherFocusReason);\n                    focusSetupOk = true;',
      expected: ['UI_WHEEL_CPP_FOCUSED_CLICK_BINDING']
    },
    {
      name: 'native-target-hit-guard-bypassed',
      file: 'mainWindow',
      before: 'boundary.targetHit = widgetIsOrDescendsFrom(hitWidget, expectedTarget);',
      after: 'boundary.targetHit = true;',
      expected: ['UI_WHEEL_CPP_TARGET_HIT_GUARD']
    },
    {
      name: 'native-foreground-guard-bypassed',
      file: 'mainWindow',
      before: 'boundary.foregroundMatches = GetForegroundWindow() == expectedForegroundWindow;',
      after: 'boundary.foregroundMatches = true;',
      expected: ['UI_WHEEL_CPP_FOREGROUND_GUARD']
    },
    {
      name: 'native-cursor-position-guard-bypassed',
      file: 'mainWindow',
      before: 'boundary.cursorPositionMatches = QCursor::pos() == globalPosition;',
      after: 'boundary.cursorPositionMatches = true;',
      expected: ['UI_WHEEL_CPP_CURSOR_POSITION_GUARD']
    },
    {
      name: 'foreground-restored-after-cursor',
      file: 'mainWindow',
      before: '    if (previousForegroundWindow && previousForegroundWindow != testWindowHandle) {\n        SetForegroundWindow(previousForegroundWindow);\n        settleUiWheelEvents(40);\n    }\n    QCursor::setPos(previousCursorPosition);',
      after: '    QCursor::setPos(previousCursorPosition);\n    if (previousForegroundWindow && previousForegroundWindow != testWindowHandle) {\n        SetForegroundWindow(previousForegroundWindow);\n        settleUiWheelEvents(40);\n    }',
      expected: ['UI_WHEEL_CPP_FOREGROUND_RESTORE_ORDER']
    },
    {
      name: 'runtime-system-path-uses-native-separator-after-qt-normalization',
      file: 'mainWindow',
      before: "return candidate.startsWith(root + QLatin1Char('/'), Qt::CaseInsensitive);",
      after: 'return candidate.startsWith(root + QDir::separator(), Qt::CaseInsensitive);',
      expected: ['UI_WHEEL_CPP_RUNTIME_MODULE_CLASSIFICATION']
    }
  ];

  for (const mutation of mutations) {
    const mutant = { ...sources };
    if (mutation.changes) {
      for (const change of mutation.changes) {
        mutant[mutation.file] = replaceExactlyOnce(
          mutant[mutation.file],
          change.before,
          change.after
        );
      }
    } else {
      mutant[mutation.file] = replaceExactlyOnce(
        mutant[mutation.file],
        mutation.before,
        mutation.after
      );
    }
    assertExactIds(mutation.name, failedIds(validateSourceSet(mutant)), mutation.expected);
  }

  for (const check of baselineChecks) {
    console.log(`[UI WHEEL POLICY PASS] ${check.id}`);
  }
  console.log(
    `[UI WHEEL GATE PASS] checks=${baselineChecks.length} ` +
    `mutations=${mutations.length}/${mutations.length}-rejected`
  );
}

try {
  run();
} catch (error) {
  console.error(`[UI WHEEL GATE FAIL] ${error.stack || error.message}`);
  process.exitCode = 1;
}
