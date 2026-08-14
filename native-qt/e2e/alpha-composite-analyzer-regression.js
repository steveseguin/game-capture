'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parsePluginRepo() {
  const prefix = '--plugin-repo=';
  const args = process.argv.slice(2);
  const arg = args.find((value) => value.startsWith(prefix));
  const optionIndex = args.indexOf('--plugin-repo');
  const pluginRepoArg = arg
    ? arg.slice(prefix.length)
    : optionIndex >= 0
      ? args[optionIndex + 1]
      : '';
  if (!pluginRepoArg) {
    throw new Error('--plugin-repo is required');
  }
  return path.resolve(pluginRepoArg);
}

function makeImage(width, height, color) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color.r;
    rgba[offset + 1] = color.g;
    rgba[offset + 2] = color.b;
    rgba[offset + 3] = 255;
  }
  return { width, height, rgba };
}

function fillRect(image, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      const offset = (py * image.width + px) * 4;
      image.rgba[offset] = color.r;
      image.rgba[offset + 1] = color.g;
      image.rgba[offset + 2] = color.b;
      image.rgba[offset + 3] = 255;
    }
  }
}

function cloneImage(image) {
  return { width: image.width, height: image.height, rgba: Buffer.from(image.rgba) };
}

function imageHash(image) {
  return crypto.createHash('sha256').update(image.rgba).digest('hex');
}

function blendColor(foreground, background, alpha) {
  const inverse = 255 - alpha;
  return {
    r: Math.round((foreground.r * alpha + background.r * inverse) / 255),
    g: Math.round((foreground.g * alpha + background.g * inverse) / 255),
    b: Math.round((foreground.b * alpha + background.b * inverse) / 255),
  };
}

function assertRejected(label, result, controls) {
  if (result && result.ok) {
    throw new Error(`${label} negative control unexpectedly passed`);
  }
  controls[label] = result && result.failureReasons
    ? result.failureReasons
    : result && result.failureReason
      ? [result.failureReason]
      : ['rejected'];
}

function main() {
  const pluginRepo = parsePluginRepo();
  const checkerPath = path.join(pluginRepo, 'scripts', 'obs-websocket-vdoninja-source-check.cjs');
  const {
    analyzeAlphaCompositeImages,
    analyzeAlphaCompositeSequence,
    analyzeAlphaTransition,
    analyzeAlphaCaptureCadence,
    fixtureColorForEpoch,
    normalizedDiagnosticsPeer,
    evaluateObservedTransition,
    classifyObservedConnection,
  } = require(checkerPath);
  if ([analyzeAlphaCompositeImages, analyzeAlphaCompositeSequence, analyzeAlphaTransition,
    analyzeAlphaCaptureCadence, fixtureColorForEpoch, normalizedDiagnosticsPeer,
    evaluateObservedTransition, classifyObservedConnection].some((value) => typeof value !== 'function')) {
    throw new Error(`Alpha analyzer exports are unavailable: ${checkerPath}`);
  }

  const backgroundColor = { r: 255, g: 0, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  const background = makeImage(100, 100, backgroundColor);
  const preColor = fixtureColorForEpoch('pre');
  const postColor = fixtureColorForEpoch('post');
  const controls = {};
  const baseOptions = {
    sampleStep: 1,
    tolerance: 36,
    fixtureColorTolerance: 36,
    halfCompositeTolerance: 36,
    maxDarkFillRatio: 0.002,
    maxGreenFillRatio: 0.05,
    throwOnFailure: false,
  };

  function diagnosticsPeer(options = {}) {
    return normalizedDiagnosticsPeer({
      uuid: options.uuid || 'obs-peer-a',
      session: options.session || 'obs-session-a',
      stream_id: options.streamId || 'alpha-stream',
      last_connection_state: options.state || 'connected',
      signaling: {
        client_transport_generation: options.clientGeneration === undefined ? 1 : options.clientGeneration,
        active_transport_generation: options.activeGeneration === undefined ? 1 : options.activeGeneration,
        active_offer_generation: options.offerGeneration === undefined ? 1 : options.offerGeneration,
      },
      transport: {
        transport_retired: options.retired === true,
        data_channel_open: options.dataChannelOpen !== false,
      },
      system: { platform: 'OBS', browser: 'Native Receiver' },
    });
  }

  function diagnosticsSnapshot(options = {}) {
    const peer = options.peer === undefined ? diagnosticsPeer(options) : options.peer;
    const peers = options.peers || (peer ? [peer] : []);
    return {
      source: 'game-capture-diagnostics',
      observedAtMs: options.observedAtMs || 1000,
      publisherPid: options.publisherPid || 101,
      control: {
        discoverySha256: options.discoverySha256 || 'a'.repeat(64),
        tokenSha256: options.tokenSha256 || 'b'.repeat(64),
      },
      peer,
      peers,
    };
  }

  const observedBefore = diagnosticsSnapshot({ observedAtMs: 1000 });
  const observedRetired = diagnosticsSnapshot({
    observedAtMs: 1100,
    peer: null,
    peers: [],
  });
  const observedNewPeer = diagnosticsSnapshot({
    observedAtMs: 1200,
    peer: diagnosticsPeer({ uuid: 'obs-peer-b', session: 'obs-session-b' }),
  });
  const observedSourceTransition = evaluateObservedTransition(
    'source-recreate',
    observedBefore,
    observedRetired,
    observedNewPeer
  );
  if (!observedSourceTransition.ok) {
    throw new Error(`Valid observed source transition failed: ${observedSourceTransition.failureReasons.join(', ')}`);
  }

  const observedHigherGeneration = diagnosticsSnapshot({
    observedAtMs: 1200,
    peer: diagnosticsPeer({ clientGeneration: 2, activeGeneration: 2, offerGeneration: 2 }),
  });
  const observedSamePeerTransition = evaluateObservedTransition(
    'same-peer-ice-rebuild',
    observedBefore,
    observedHigherGeneration,
    observedHigherGeneration
  );
  if (!observedSamePeerTransition.ok) {
    throw new Error(`Valid same-peer generation transition failed: ${observedSamePeerTransition.failureReasons.join(', ')}`);
  }

  assertRejected(
    'diagnostics-no-op-source-transition',
    evaluateObservedTransition('source-recreate', observedBefore, observedRetired, observedBefore),
    controls
  );
  assertRejected(
    'diagnostics-missing-retirement-boundary',
    evaluateObservedTransition('source-recreate', observedBefore, null, observedNewPeer),
    controls
  );
  const observedDisconnectedButNotRetired = diagnosticsSnapshot({
    observedAtMs: 1100,
    peer: diagnosticsPeer({ state: 'disconnected', dataChannelOpen: false }),
  });
  assertRejected(
    'diagnostics-disconnected-is-not-retired',
    evaluateObservedTransition(
      'source-recreate',
      observedBefore,
      observedDisconnectedButNotRetired,
      observedNewPeer
    ),
    controls
  );
  assertRejected(
    'diagnostics-command-exit-zero-without-observed-boundary',
    evaluateObservedTransition('source-recreate', observedBefore, null, observedNewPeer),
    controls
  );
  assertRejected(
    'diagnostics-unchanged-client-generation',
    evaluateObservedTransition(
      'same-peer-ice-rebuild',
      observedBefore,
      observedHigherGeneration,
      diagnosticsSnapshot({
        observedAtMs: 1200,
        peer: diagnosticsPeer({ clientGeneration: 1, activeGeneration: 2, offerGeneration: 2 }),
      })
    ),
    controls
  );
  assertRejected(
    'diagnostics-unchanged-active-generation',
    evaluateObservedTransition(
      'same-peer-ice-rebuild',
      observedBefore,
      observedHigherGeneration,
      diagnosticsSnapshot({
        observedAtMs: 1200,
        peer: diagnosticsPeer({ clientGeneration: 2, activeGeneration: 1, offerGeneration: 2 }),
      })
    ),
    controls
  );
  if (normalizedDiagnosticsPeer({
    uuid: 'obs-peer-a',
    session: 'obs-session-a',
    signaling: { active_transport_generation: 1 },
  }) !== null) {
    throw new Error('missing client transport generation negative control unexpectedly normalized');
  }
  controls['diagnostics-missing-client-generation'] = ['rejected'];
  if (normalizedDiagnosticsPeer({
    uuid: 'obs-peer-a',
    session: 'obs-session-a',
    signaling: { client_transport_generation: 1 },
  }) !== null) {
    throw new Error('missing active transport generation negative control unexpectedly normalized');
  }
  controls['diagnostics-missing-active-generation'] = ['rejected'];

  const restartedPublisher = diagnosticsSnapshot({
    observedAtMs: 1200,
    publisherPid: 202,
    discoverySha256: 'c'.repeat(64),
    peer: diagnosticsPeer({ uuid: 'obs-peer-b', session: 'obs-session-b' }),
  });
  const validPublisherRestart = evaluateObservedTransition(
    'publisher-restart',
    observedBefore,
    observedRetired,
    restartedPublisher
  );
  if (!validPublisherRestart.ok) {
    throw new Error(`Valid publisher restart evidence failed: ${validPublisherRestart.failureReasons.join(', ')}`);
  }
  assertRejected(
    'diagnostics-publisher-restart-unchanged-pid',
    evaluateObservedTransition('publisher-restart', observedBefore, observedRetired, observedNewPeer),
    controls
  );
  assertRejected(
    'diagnostics-publisher-restart-unchanged-discovery',
    evaluateObservedTransition(
      'publisher-restart',
      observedBefore,
      observedRetired,
      diagnosticsSnapshot({
        observedAtMs: 1200,
        publisherPid: 202,
        peer: diagnosticsPeer({ uuid: 'obs-peer-b', session: 'obs-session-b' }),
      })
    ),
    controls
  );

  function sample(image, analysis, index, epoch, prefix) {
    return {
      sample: index,
      checkpoint: `${epoch}:fixture-transition`,
      connectionEpoch: epoch,
      screenshot: {
        outputPath: `${prefix}-${index}.png`,
        sha256: imageHash(image),
      },
      ...analysis,
    };
  }

  function movingSample(epoch, index, x) {
    const image = cloneImage(background);
    fillRect(image, x, 33, 25, 33, epoch === 'post' ? postColor : preColor);
    const analysis = analyzeAlphaCompositeImages(background, image, {
      ...baseOptions,
      pattern: 'alpha-moving-edge',
      expectedVisualEpoch: epoch,
    });
    if (!analysis.ok) {
      throw new Error(`${epoch} moving sample ${index} unexpectedly failed: ${analysis.failureReason}`);
    }
    return sample(image, analysis, index, epoch, `moving-${epoch}`);
  }

  const aligned = cloneImage(background);
  fillRect(aligned, 30, 30, 30, 30, preColor);
  const alignedAnalysis = analyzeAlphaCompositeImages(background, aligned, baseOptions);
  if (!alignedAnalysis.ok) {
    throw new Error('Aligned alpha composite unexpectedly failed');
  }

  // This reproduces the archived shifted-mask signature: an otherwise correct
  // foreground has a dark exposed stripe where the alpha packet lagged.
  const archivedShiftedMask = cloneImage(aligned);
  fillRect(archivedShiftedMask, 27, 30, 3, 30, black);
  assertRejected(
    'archived-shifted-mask',
    analyzeAlphaCompositeImages(background, archivedShiftedMask, baseOptions),
    controls
  );

  const preMoving = Array.from({ length: 10 }, (_, index) =>
    movingSample('pre', index + 1, 3 + index * 6)
  );
  const postMoving = Array.from({ length: 10 }, (_, index) =>
    movingSample('post', index + 101, 5 + index * 6)
  );
  const movingTransition = analyzeAlphaTransition(preMoving, postMoving, {
    pattern: 'alpha-moving-edge',
    requiredUsefulSampleCount: 10,
  });
  if (!movingTransition.ok) {
    throw new Error(`Valid moving transition failed: ${movingTransition.failureReasons.join(', ')}`);
  }

  const cadenceOrigin = 100000;
  const cadenceSamples = preMoving.map((entry, index) => ({
    ...entry,
    screenshot: {
      ...entry.screenshot,
      captureStartedAtMs: cadenceOrigin + 50 + index * 75,
    },
  }));
  const cadencePositive = analyzeAlphaCaptureCadence(cadenceSamples, {
    inputCreatedAtMs: cadenceOrigin,
    requiredMaximumMs: 100,
  });
  if (!cadencePositive.ok) {
    throw new Error(`Immediate 75ms cadence positive control failed: ${cadencePositive.failureReasons.join(', ')}`);
  }
  const delayedFirstCapture = cadenceSamples.map((entry) => ({
    ...entry,
    screenshot: { ...entry.screenshot, captureStartedAtMs: entry.screenshot.captureStartedAtMs + 51 },
  }));
  assertRejected(
    'first-capture-over-100ms',
    analyzeAlphaCaptureCadence(delayedFirstCapture, {
      inputCreatedAtMs: cadenceOrigin,
      requiredMaximumMs: 100,
    }),
    controls
  );
  const cadenceGap = cadenceSamples.map((entry) => ({ ...entry, screenshot: { ...entry.screenshot } }));
  cadenceGap[3].screenshot.captureStartedAtMs += 30;
  cadenceGap[7].screenshot.captureStartedAtMs += 30;
  assertRejected(
    'repeated-capture-start-gaps-over-100ms',
    analyzeAlphaCaptureCadence(cadenceGap, {
      inputCreatedAtMs: cadenceOrigin,
      requiredMaximumMs: 100,
    }),
    controls
  );
  const missingCaptureStart = cadenceSamples.map((entry) => ({ ...entry, screenshot: { ...entry.screenshot } }));
  delete missingCaptureStart[4].screenshot.captureStartedAtMs;
  assertRejected(
    'missing-capture-start-evidence',
    analyzeAlphaCaptureCadence(missingCaptureStart, {
      inputCreatedAtMs: cadenceOrigin,
      requiredMaximumMs: 100,
    }),
    controls
  );

  const frozenPre = preMoving.map((entry, index) => ({ ...preMoving[0], sample: index + 1 }));
  assertRejected(
    'frozen-moving',
    analyzeAlphaCompositeSequence(frozenPre, {
      pattern: 'alpha-moving-edge',
      expectedVisualEpoch: 'pre',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  const staleFirstPost = [{ ...preMoving[0], sample: 101 }, ...postMoving.slice(1)];
  assertRejected(
    'stale-first-post',
    analyzeAlphaTransition(preMoving, staleFirstPost, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  // The pixels are a perfect post-color composite, but the capture is bound to
  // the old connection epoch. It must never satisfy first-new-transport proof.
  const fabricatedConnectionEpoch = 'post';
  const observedOldConnectionEpoch = classifyObservedConnection(
    observedBefore,
    observedSourceTransition,
    observedBefore.peer
  );
  if (fabricatedConnectionEpoch !== 'post' || observedOldConnectionEpoch !== 'pre') {
    throw new Error('Observed diagnostics identity did not override a fabricated post epoch claim');
  }
  controls['fabricated-connection-epoch-ignored'] = [
    `claimed=${fabricatedConnectionEpoch}`,
    `observed=${observedOldConnectionEpoch}`,
  ];
  const postColoredOldConnection = [
    {
      ...postMoving[0],
      connectionEpoch: observedOldConnectionEpoch,
      diagnosticsAtCaptureStart: observedBefore,
    },
    ...postMoving.slice(1),
  ];
  assertRejected(
    'post-colored-old-connection',
    analyzeAlphaTransition(preMoving, postColoredOldConnection, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  const frozenPost = postMoving.map((entry, index) => ({ ...postMoving[0], sample: index + 101 }));
  assertRejected(
    'frozen-post',
    analyzeAlphaTransition(preMoving, frozenPost, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );
  assertRejected(
    'nine-of-ten-post',
    analyzeAlphaTransition(preMoving, postMoving.slice(0, 9), {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  const missingDecodedHash = postMoving.map((entry) => ({ ...entry }));
  delete missingDecodedHash[4].compositePixelSha256;
  assertRejected(
    'missing-decoded-hash',
    analyzeAlphaTransition(preMoving, missingDecodedHash, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );
  const missingPngHash = postMoving.map((entry) => ({ ...entry, screenshot: { ...entry.screenshot } }));
  delete missingPngHash[3].screenshot.sha256;
  assertRejected(
    'missing-png-hash',
    analyzeAlphaTransition(preMoving, missingPngHash, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );
  const missingEvidencePath = postMoving.map((entry) => ({ ...entry, screenshot: { ...entry.screenshot } }));
  delete missingEvidencePath[2].screenshot.outputPath;
  assertRejected(
    'missing-evidence-path',
    analyzeAlphaTransition(preMoving, missingEvidencePath, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );
  const repeatedEvidenceHash = postMoving.map((entry) => ({
    ...entry,
    screenshot: { ...entry.screenshot, sha256: postMoving[0].screenshot.sha256 },
  }));
  assertRejected(
    'repeated-png-identity',
    analyzeAlphaTransition(preMoving, repeatedEvidenceHash, {
      pattern: 'alpha-moving-edge',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  const onePercentMarker = cloneImage(background);
  fillRect(onePercentMarker, 10, 10, 10, 10, preColor);
  assertRejected(
    'one-percent-marker',
    analyzeAlphaCompositeImages(background, onePercentMarker, {
      ...baseOptions,
      pattern: 'alpha-moving-edge',
      expectedVisualEpoch: 'pre',
    }),
    controls
  );

  const checker = cloneImage(background);
  fillRect(checker, 0, 0, 50, 100, preColor);
  const checkerAnalysis = analyzeAlphaCompositeImages(background, checker, {
    ...baseOptions,
    pattern: 'alpha-checker',
    expectedVisualEpoch: 'pre',
  });
  if (!checkerAnalysis.ok) {
    throw new Error(`50/50 checker unexpectedly failed: ${checkerAnalysis.failureReason}`);
  }
  const checkerThirtySix = cloneImage(background);
  fillRect(checkerThirtySix, 0, 0, 36, 100, preColor);
  assertRejected(
    'checker-36-64',
    analyzeAlphaCompositeImages(background, checkerThirtySix, {
      ...baseOptions,
      pattern: 'alpha-checker',
      expectedVisualEpoch: 'pre',
    }),
    controls
  );

  const missingForegroundSamples = [
    ...preMoving.slice(0, 9),
    sample(
      background,
      analyzeAlphaCompositeImages(background, background, {
        ...baseOptions,
        pattern: 'alpha-moving-edge',
        expectedVisualEpoch: 'pre',
      }),
      10,
      'pre',
      'missing-foreground'
    ),
  ];
  assertRejected(
    'archived-missing-foreground',
    analyzeAlphaCompositeSequence(missingForegroundSamples, {
      pattern: 'alpha-moving-edge',
      expectedVisualEpoch: 'pre',
      requiredUsefulSampleCount: 10,
    }),
    controls
  );

  const halfBackgrounds = [
    { name: 'magenta', image: background, color: backgroundColor },
    { name: 'red', image: makeImage(100, 100, { r: 255, g: 0, b: 0 }), color: { r: 255, g: 0, b: 0 } },
  ];
  for (const epoch of ['pre', 'post']) {
    const fixtureColor = fixtureColorForEpoch(epoch);
    for (const halfBackground of halfBackgrounds) {
      const halfPositive = makeImage(
        100,
        100,
        blendColor(fixtureColor, halfBackground.color, 128)
      );
      const halfAnalysis = analyzeAlphaCompositeImages(halfBackground.image, halfPositive, {
        ...baseOptions,
        pattern: 'alpha-half',
        expectedVisualEpoch: epoch,
      });
      if (!halfAnalysis.ok) {
        throw new Error(
          `50% alpha positive control failed for ${epoch}/${halfBackground.name}: ${halfAnalysis.failureReason}`
        );
      }
      for (const alpha of [64, 96, 159, 191, 255]) {
        const candidate = makeImage(
          100,
          100,
          blendColor(fixtureColor, halfBackground.color, alpha)
        );
        assertRejected(
          `half-alpha-${epoch}-${halfBackground.name}-negative-${alpha}`,
          analyzeAlphaCompositeImages(halfBackground.image, candidate, {
            ...baseOptions,
            pattern: 'alpha-half',
            expectedVisualEpoch: epoch,
          }),
          controls
        );
      }
    }
  }

  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-evidence-gate-'));
  try {
    const fileBound = preMoving.map((entry, index) => {
      const outputPath = path.join(evidenceDir, `sample-${index}.bin`);
      const bytes = Buffer.from(`alpha-evidence-${index}`);
      fs.writeFileSync(outputPath, bytes);
      return {
        ...entry,
        screenshot: {
          outputPath,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      };
    });
    const boundPositive = analyzeAlphaCompositeSequence(fileBound, {
      pattern: 'alpha-moving-edge',
      expectedVisualEpoch: 'pre',
      requiredUsefulSampleCount: 10,
      requireEvidenceFiles: true,
    });
    if (!boundPositive.ok) {
      throw new Error(`File-bound evidence positive control failed: ${boundPositive.failureReasons.join(', ')}`);
    }
    const hashMismatch = fileBound.map((entry) => ({ ...entry, screenshot: { ...entry.screenshot } }));
    hashMismatch[0].screenshot.sha256 = '0'.repeat(64);
    assertRejected(
      'evidence-file-hash-mismatch',
      analyzeAlphaCompositeSequence(hashMismatch, {
        pattern: 'alpha-moving-edge',
        expectedVisualEpoch: 'pre',
        requiredUsefulSampleCount: 10,
        requireEvidenceFiles: true,
      }),
      controls
    );
    fs.unlinkSync(fileBound[1].screenshot.outputPath);
    assertRejected(
      'evidence-file-missing',
      analyzeAlphaCompositeSequence(fileBound, {
        pattern: 'alpha-moving-edge',
        expectedVisualEpoch: 'pre',
        requiredUsefulSampleCount: 10,
        requireEvidenceFiles: true,
      }),
      controls
    );
  } finally {
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checkerPath,
    exactColorTolerance: 36,
    movingTransition,
    negativeControlCount: Object.keys(controls).length,
    negativeControls: controls,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
