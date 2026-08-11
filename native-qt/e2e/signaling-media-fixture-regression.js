#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const acorn = require('acorn');
const { spawnSync } = require('child_process');
const {
  candidateEvidenceIntrinsicViolations
} = require('./candidate-evidence-intrinsic-integrity');

const targetPath = path.resolve(__dirname, 'signaling-regressions-e2e.js');
const expectedRtcReadinessDocumentMarker = 'game-capture-rtc-readiness-v1';
const expectedRtcReadinessDocumentUrl = 'data:text/html,%3Chtml%20data-game-capture-rtc-readiness%3D%22game-capture-rtc-readiness-v1%22%3E%3Ctitle%3Ertc%20readiness%3C%2Ftitle%3E%3C%2Fhtml%3E';
const expectedRtcReadinessPreProbeSettleMs = 1000;
const expectedScenarioFunctions = [
  'runNegotiationScenario',
  'runDirectStunScenario',
  'runAutoIceScenario',
  'runRelayIceScenario',
  'runActiveMediaLifecycleScenario'
];
const expectedTopLevelFunctionBindings = [
  'addCheck',
  'addEvidence',
  'allRequiredMediaAdvanced',
  'allRequiredVideoAdvanced',
  'answerOffer',
  'assertSpoutSenderArtifactUnchanged',
  'browserCandidateFingerprintCoversWire',
  'browserCandidateWire',
  'browserCandidateWireSha256',
  'browserTurnServer',
  'candidateOutcomeSnapshotReady',
  'candidateOutcomeSnapshotsTerminalAndStable',
  'canonicalAlphaMediaOrder',
  'canonicalBrowserCandidateFingerprint',
  'canonicalBrowserCandidateWire',
  'canonicalCandidateFingerprintScalar',
  'canonicalTurnRegistryResponseV1',
  'comparableRealPath',
  'connectNewPeer',
  'countOccurrences',
  'createBrowserPeerPage',
  'deepFreezeDiagnosticsSnapshot',
  'diagnosticsShowsRetiredGeneration',
  'enableAlphaAndVerifyMedia',
  'ensureBrowserRtcReadiness',
  'ensureTurnFixture',
  'escapeRegExp',
  'exactIceSummaryToken',
  'exactDuplicateOfferRecheckLines',
  'explicitSessionlessWssAnswerRejectionLines',
  'explicitSessionlessWssCandidateRejectionLines',
  'explicitStaleAnswerRejectionLines',
  'explicitStaleCandidateRejectionLines',
  'extractCandidateLineUfrag',
  'extractIceUfrag',
  'fetchValidatedTurnRegistryResponse',
  'flattenValidatedTurnRegistryEndpoints',
  'forwardPublisherCandidates',
  'isOfferFor',
  'launchBrowser',
  'logHasExactToken',
  'makeTransportFailureAnswer',
  'matchPackagedTurnResponse',
  'mediaTotals',
  'parseArgs',
  'parseTurnUrl',
  'probeBrowserTurn',
  'probeSelectedTurnEndpoint',
  'probeTurnSocketAddress',
  'readDiagnosticsPeerSnapshot',
  'recoverScenarioPeer',
  'redactTurnSecrets',
  'remoteFirstRestart',
  'requestOffer',
  'requireHarnessFixture',
  'requiredMediaCounters',
  'requiredMediaIsNonzero',
  'requiredVideoIsNonzero',
  'resolveBrowserTurnConfiguration',
  'resolveTurnEndpointAddresses',
  'run',
  'runActiveMediaLifecycleScenario',
  'runAutoIceScenario',
  'runDirectStunScenario',
  'runNegotiationScenario',
  'runRecoveryScenario',
  'runRelayIceScenario',
  'sdpMediaLayout',
  'selectedPairUsesRelay',
  'sendAnswer',
  'sendBrowserCandidates',
  'sendExactBrowserCandidate',
  'sendSessionlessAnswer',
  'sendSessionlessBrowserCandidate',
  'sessionlessWssDownstreamState',
  'setPeerRtcConfiguration',
  'sha256Buffer',
  'sha256File',
  'sha256Text',
  'signalLineIdentifiesPeer',
  'signalLineIdentifiesSha256',
  'signaledCandidateTypes',
  'startLifecycleMediaFixtures',
  'startOutputFixture',
  'startPublisher',
  'startSignalServer',
  'startSignalingMediaFixture',
  'summarizeTurnBrowserProbe',
  'turnRegistryIceServers',
  'turnRegistryEndpointIdentity',
  'turnRegistryResponseSha256',
  'turnUrlForAddress',
  'validatePackagedPublisherArtifact',
  'validateSpoutSenderArtifact',
  'validateTurnRegistryResponse',
  'vp9DualTrackContract',
  'wait',
  'waitForAlphaActivationOrOffer',
  'waitForChildExit',
  'waitForDiagnosticsPeerSnapshot',
  'waitForFreshVideo',
  'waitForPeerState',
  'waitForPublisherOutput',
  'waitForPublisherReady',
  'waitForPublisherSpoutBinding',
  'waitForRequiredMediaAdvance',
  'waitForRequiredVideoAdvance'
];
const expectedCompleteCheckCount = 89;
const expectedParserFailureCheckCount = expectedCompleteCheckCount - 1;

const turnRegistryFixtureA = {
  version: 1,
  servers: [
    {
      urls: 'turn:turn-a.invalid:3478',
      username: 'fixture-user-a',
      credential: 'fixture-credential-a',
      udp: true,
      region: 'fixture-a'
    },
    {
      urls: [
        'turns:turn-b.invalid:443',
        'turn:turn-b.invalid:3478?transport=tcp'
      ],
      username: 'fixture-user-b',
      credential: 'fixture-credential-b',
      udp: false
    }
  ],
  generation: 'fixture-generation-a'
};
const turnRegistryFixtureB = {
  version: 1,
  servers: [
    {
      urls: 'turns:turn-c.invalid:443',
      username: 'fixture-user-c',
      credential: 'fixture-credential-c',
      udp: false
    }
  ],
  generation: 'fixture-generation-b'
};

function validateReferenceTurnRegistryResponse(status, payload) {
  if (status !== 200) throw new Error(`expected HTTP 200, observed ${status}`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('TURN registry payload must be an object');
  }
  if (payload.version !== 1 || !Number.isInteger(payload.version)) {
    throw new Error('TURN registry version must be integer 1');
  }
  if (!Array.isArray(payload.servers) || payload.servers.length === 0) {
    throw new Error('TURN registry servers must be a nonempty array');
  }
  const servers = payload.servers.map((server, serverIndex) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`TURN server ${serverIndex} must be an object`);
    }
    if (Object.prototype.hasOwnProperty.call(server, 'url')) {
      throw new Error(`TURN server ${serverIndex} uses forbidden legacy url`);
    }
    const urls = typeof server.urls === 'string'
      ? [server.urls]
      : Array.isArray(server.urls)
        ? server.urls
        : [];
    if (urls.length === 0 || urls.some((url) =>
      typeof url !== 'string' || !/^turns?:[^\s]+$/i.test(url)
    )) {
      throw new Error(`TURN server ${serverIndex} urls are invalid`);
    }
    if (typeof server.username !== 'string' || server.username.trim().length === 0 ||
        typeof server.credential !== 'string' || server.credential.trim().length === 0 ||
        typeof server.udp !== 'boolean') {
      throw new Error(`TURN server ${serverIndex} credentials or udp are invalid`);
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

function canonicalReferenceTurnConfig(payload) {
  return `game-capture-turn-registry-config-v1\n${JSON.stringify(
    payload.servers.map(({ urls, username, credential, udp }) => ({
      urls,
      username,
      credential,
      udp
    }))
  )}`;
}

function referenceSha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function redactReferenceTurnSecrets(value, credentials) {
  let redacted = String(value);
  for (const credential of credentials) {
    redacted = redacted.split(credential).join('[REDACTED]');
  }
  return redacted;
}

function extractTurnRegistryContractImplementation(source) {
  const parsed = parseTargetJavaScript(source);
  const names = [
    'validateTurnRegistryResponse',
    'flattenValidatedTurnRegistryEndpoints',
    'turnRegistryIceServers',
    'turnRegistryEndpointIdentity',
    'canonicalTurnRegistryResponseV1',
    'turnRegistryResponseSha256',
    'matchPackagedTurnResponse',
    'redactTurnSecrets'
  ];
  if (!parsed.ok) {
    return { ok: false, detail: `parse=${parsed.error}`, implementation: null };
  }
  const declarations = names.map((name) => sourceForTopLevelFunction(source, parsed.ast, name));
  const missing = names.filter((name, index) => !declarations[index]);
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `missing=${missing.join(',')}`,
      implementation: null
    };
  }
  try {
    const implementation = Function(
      'crypto',
      `'use strict';\n` +
      `const TURN_REGISTRY_CONFIG_V1_PREFIX = 'game-capture-turn-registry-config-v1';\n` +
      `const TURN_ENDPOINT_IDENTITY_V1_PREFIX = 'game-capture-turn-endpoint-identity-v1';\n` +
      `const sha256Text = (value) => crypto.createHash('sha256')` +
        `.update(String(value), 'utf8').digest('hex');\n` +
      declarations.join('\n') +
      `\nreturn { ${names.join(', ')} };`
    )(crypto);
    return { ok: true, detail: `extracted=${names.length}/${names.length}`, implementation };
  } catch (error) {
    return {
      ok: false,
      detail: `compile=${String(error && error.message ? error.message : error)}`,
      implementation: null
    };
  }
}

function exerciseTurnRegistryReferenceContract(source = '') {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const extracted = source
    ? extractTurnRegistryContractImplementation(source)
    : { ok: true, detail: 'checker-reference', implementation: null };
  const implementation = extracted.implementation;
  const validate = implementation
    ? (status, payload) => implementation.validateTurnRegistryResponse.length >= 2
      ? implementation.validateTurnRegistryResponse(status, payload)
      : status === 200
        ? implementation.validateTurnRegistryResponse(payload)
        : (() => { throw new Error(`expected HTTP 200, observed ${status}`); })()
    : validateReferenceTurnRegistryResponse;
  const cases = [];
  const accept = (name, status, payload, verify = () => true) => {
    try {
      const observed = validate(status, clone(payload));
      cases.push({ name, expected: 'accept', ok: !!verify(observed), outcome: 'accepted' });
    } catch (error) {
      cases.push({
        name,
        expected: 'accept',
        ok: false,
        outcome: `rejected:${error.message}`
      });
    }
  };
  const reject = (name, status, payload) => {
    try {
      validate(status, clone(payload));
      cases.push({ name, expected: 'reject', ok: false, outcome: 'accepted' });
    } catch (error) {
      cases.push({
        name,
        expected: 'reject',
        ok: true,
        outcome: `rejected:${error.message}`
      });
    }
  };

  accept('fixture-a', 200, turnRegistryFixtureA, (observed) => {
    const responsePreserved = observed.version === 1 && observed.servers.length === 2 &&
      observed.generation === turnRegistryFixtureA.generation &&
      JSON.stringify(observed.servers[1].urls) ===
        JSON.stringify(turnRegistryFixtureA.servers[1].urls);
    if (!responsePreserved || !implementation) return responsePreserved;
    const iceServers = implementation.turnRegistryIceServers(observed);
    const endpoints = implementation.flattenValidatedTurnRegistryEndpoints(observed);
    return JSON.stringify(iceServers) === JSON.stringify(
      observed.servers.map(({ urls, username, credential, udp }) => ({
        urls, username, credential, udp
      }))
    ) && JSON.stringify(endpoints.map(({ urls, username, credential, udp }) => ({
      urls, username, credential, udp
    }))) === JSON.stringify([
      {
        urls: observed.servers[0].urls,
        username: observed.servers[0].username,
        credential: observed.servers[0].credential,
        udp: observed.servers[0].udp
      },
      {
        urls: observed.servers[1].urls[0],
        username: observed.servers[1].username,
        credential: observed.servers[1].credential,
        udp: observed.servers[1].udp
      },
      {
        urls: observed.servers[1].urls[1],
        username: observed.servers[1].username,
        credential: observed.servers[1].credential,
        udp: observed.servers[1].udp
      }
    ]);
  });
  accept('fixture-b', 200, turnRegistryFixtureB);
  accept('string-urls-preserved', 200, turnRegistryFixtureA, (observed) =>
    typeof observed.servers[0].urls === 'string'
  );
  accept('array-order-preserved', 200, turnRegistryFixtureA, (observed) =>
    observed.servers[1].urls[0] === turnRegistryFixtureA.servers[1].urls[0] &&
    observed.servers[1].urls[1] === turnRegistryFixtureA.servers[1].urls[1]
  );
  accept('additive-metadata', 200, {
    ...turnRegistryFixtureB,
    additiveTopLevel: { fixture: true },
    servers: [{ ...turnRegistryFixtureB.servers[0], additiveServerField: 7 }]
  }, (observed) => observed.additiveTopLevel.fixture === true &&
    observed.servers[0].additiveServerField === 7);
  reject('status-not-200', 201, turnRegistryFixtureA);
  reject('version-missing', 200, { servers: turnRegistryFixtureA.servers });
  reject('version-string', 200, { ...turnRegistryFixtureA, version: '1' });
  reject('version-unsupported', 200, { ...turnRegistryFixtureA, version: 2 });
  reject('servers-missing', 200, { version: 1 });
  reject('servers-empty', 200, { version: 1, servers: [] });
  reject('servers-not-array', 200, { version: 1, servers: {} });
  reject('legacy-url', 200, {
    version: 1,
    servers: [{
      url: 'turn:legacy.invalid:3478',
      username: 'fixture-user',
      credential: 'fixture-credential',
      udp: true
    }]
  });
  reject('urls-empty-array', 200, {
    version: 1,
    servers: [{ urls: [], username: 'fixture-user', credential: 'fixture-credential', udp: true }]
  });
  reject('urls-invalid-scheme', 200, {
    version: 1,
    servers: [{ urls: 'https://turn.invalid', username: 'fixture-user', credential: 'fixture-credential', udp: true }]
  });
  reject('username-empty', 200, {
    version: 1,
    servers: [{ urls: 'turn:user.invalid:3478', username: ' ', credential: 'fixture-credential', udp: true }]
  });
  reject('credential-empty', 200, {
    version: 1,
    servers: [{ urls: 'turn:credential.invalid:3478', username: 'fixture-user', credential: '', udp: true }]
  });
  reject('udp-not-boolean', 200, {
    version: 1,
    servers: [{ urls: 'turn:udp.invalid:3478', username: 'fixture-user', credential: 'fixture-credential', udp: 1 }]
  });
  reject('mixed-response-fails-whole', 200, {
    version: 1,
    servers: [
      turnRegistryFixtureA.servers[0],
      { urls: [], username: 'fixture-user', credential: 'fixture-credential', udp: false }
    ]
  });

  try {
    const validatedA = validate(200, clone(turnRegistryFixtureA));
    const canonicalA = implementation
      ? implementation.canonicalTurnRegistryResponseV1(validatedA.servers)
      : canonicalReferenceTurnConfig(validatedA);
    const reversed = clone(turnRegistryFixtureA);
    reversed.servers.reverse();
    const validatedReversed = validate(200, reversed);
    const canonicalReversed = implementation
      ? implementation.canonicalTurnRegistryResponseV1(validatedReversed.servers)
      : canonicalReferenceTurnConfig(validatedReversed);
    const hashA = implementation
      ? implementation.turnRegistryResponseSha256(validatedA.servers)
      : referenceSha256(canonicalA);
    const hashReversed = implementation
      ? implementation.turnRegistryResponseSha256(validatedReversed.servers)
      : referenceSha256(canonicalReversed);
    let uniqueMatchOk = true;
    if (implementation) {
      const transactionId = 'fixture-transaction-a';
      const responseSha256 = 'a'.repeat(64);
      const response = {
        transactionId,
        responseSha256,
        observedAtMs: 150,
        configSha256: hashA,
        servers: validatedA.servers
      };
      const invokeMatch = (responses) => implementation.matchPackagedTurnResponse(
        responses,
        transactionId,
        responseSha256,
        100,
        200
      );
      uniqueMatchOk = invokeMatch([response]) === response &&
        invokeMatch([{ ...response, transactionId: 'wrong' }]) === null &&
        invokeMatch([response, { ...response }]) === null &&
        invokeMatch([{ ...response, observedAtMs: 99 }]) === null &&
        invokeMatch([{ ...response, observedAtMs: 201 }]) === null;
    }
    cases.push({
      name: 'ordered-config-hash',
      expected: 'reject',
      ok: hashA === referenceSha256(canonicalA) &&
        hashReversed === referenceSha256(canonicalReversed) &&
        hashA !== hashReversed && uniqueMatchOk,
      outcome: 'compared'
    });
  } catch (error) {
    cases.push({
      name: 'ordered-config-hash',
      expected: 'reject',
      ok: false,
      outcome: `rejected:${String(error && error.message ? error.message : error)}`
    });
  }
  const rawPayload = JSON.stringify(turnRegistryFixtureA);
  const secrets = [
    rawPayload,
    ...turnRegistryFixtureA.servers.flatMap((server) => [server.username, server.credential])
  ];
  const reportText = `host=turn-a.invalid username=${turnRegistryFixtureA.servers[0].username} ` +
    `credential=${turnRegistryFixtureA.servers[0].credential} raw=${rawPayload}`;
  try {
    const redacted = implementation
      ? implementation.redactTurnSecrets(
        turnRegistryFixtureA.servers,
        rawPayload,
        reportText
      )
      : redactReferenceTurnSecrets(reportText, secrets);
    cases.push({
      name: 'redaction-keeps-host-only',
      expected: 'reject',
      ok: typeof redacted === 'string' && redacted.includes('turn-a.invalid') &&
        secrets.every((secret) => !redacted.includes(secret)),
      outcome: String(redacted)
    });
  } catch (error) {
    cases.push({
      name: 'redaction-keeps-host-only',
      expected: 'reject',
      ok: false,
      outcome: `rejected:${String(error && error.message ? error.message : error)}`
    });
  }

  const nonce = crypto.randomBytes(12).toString('hex');
  const realisticPayload = {
    version: 1,
    generation: `registry-${nonce}`,
    servers: [
      {
        urls: `turn:relay-${nonce}.example.net:3478`,
        username: `ephemeral-user-${nonce}`,
        credential: `ephemeral-secret-${nonce}`,
        udp: true,
        region: 'north-america'
      },
      {
        urls: [
          `turns:relay-${nonce}.example.net:443`,
          `turn:relay-${nonce}.example.net:3478?transport=tcp`
        ],
        username: `ephemeral-user-b-${nonce}`,
        credential: `ephemeral-secret-b-${nonce}`,
        udp: false
      }
    ]
  };
  const behavior = Object.fromEntries([
    'schema', 'flatten', 'ice', 'canonicalHash', 'match', 'redaction'
  ].map((name) => [name, { ok: !implementation, detail: implementation
    ? 'not-exercised'
    : 'checker-reference' }]));
  const observeBehavior = (name, operation) => {
    try {
      operation();
      behavior[name] = { ok: true, detail: 'accepted randomized non-fixture input' };
    } catch (error) {
      behavior[name] = {
        ok: false,
        detail: String(error && error.message ? error.message : error)
      };
    }
  };
  if (implementation) {
    let realisticValidated = null;
    observeBehavior('schema', () => {
      realisticValidated = validate(200, clone(realisticPayload));
      if (!realisticValidated || realisticValidated.generation !== realisticPayload.generation ||
          JSON.stringify(realisticValidated.servers) !== JSON.stringify(realisticPayload.servers)) {
        throw new Error('randomized non-fixture registry response was not preserved');
      }
    });
    if (realisticValidated) {
      observeBehavior('flatten', () => {
        const actual = implementation.flattenValidatedTurnRegistryEndpoints(realisticValidated);
        const expected = [
          {
            ...realisticValidated.servers[0],
            urls: realisticValidated.servers[0].urls,
            registryServerIndex: 0,
            registryUrlIndex: 0,
            registryEndpointIndex: 0
          },
          {
            ...realisticValidated.servers[1],
            urls: realisticValidated.servers[1].urls[0],
            registryServerIndex: 1,
            registryUrlIndex: 0,
            registryEndpointIndex: 1
          },
          {
            ...realisticValidated.servers[1],
            urls: realisticValidated.servers[1].urls[1],
            registryServerIndex: 1,
            registryUrlIndex: 1,
            registryEndpointIndex: 2
          }
        ];
        for (const endpoint of expected) {
          endpoint.registryEndpointIdentity =
            implementation.turnRegistryEndpointIdentity(endpoint);
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`flatten mismatch expected=${expected.length} actual=` +
            `${Array.isArray(actual) ? actual.length : 'non-array'}`);
        }
      });
      observeBehavior('ice', () => {
        const actual = implementation.turnRegistryIceServers(realisticValidated);
        const expected = realisticValidated.servers.map(
          ({ urls, username, credential, udp }) => ({ urls, username, credential, udp })
        );
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error('ICE config stripped or changed randomized credentials/order');
        }
      });
      observeBehavior('canonicalHash', () => {
        const expectedCanonical = canonicalReferenceTurnConfig(realisticValidated);
        const actualCanonical = implementation.canonicalTurnRegistryResponseV1(
          realisticValidated.servers
        );
        const actualHash = implementation.turnRegistryResponseSha256(
          realisticValidated.servers
        );
        if (actualCanonical !== expectedCanonical ||
            actualHash !== referenceSha256(expectedCanonical)) {
          throw new Error('canonical bytes/hash changed randomized full ordered config');
        }
      });
      observeBehavior('match', () => {
        const transactionId = `transaction-${nonce}`;
        const responseSha256 = referenceSha256(`response-${nonce}`);
        const response = {
          transactionId,
          responseSha256,
          observedAtMs: 150,
          configSha256: referenceSha256(`config-${nonce}`),
          servers: realisticValidated.servers
        };
        const invoke = (responses) => implementation.matchPackagedTurnResponse(
          responses, transactionId, responseSha256, 100, 200
        );
        if (invoke([response]) !== response ||
            invoke([response, { ...response }]) !== null ||
            invoke([{ ...response, observedAtMs: 99 }]) !== null ||
            invoke([{ ...response, observedAtMs: 201 }]) !== null ||
            invoke([{ ...response, responseSha256: '0'.repeat(64) }]) !== null) {
          throw new Error('matcher accepted absent, ambiguous, mismatched, or out-of-window response');
        }
      });
      observeBehavior('redaction', () => {
        const rawResponse = JSON.stringify(realisticPayload);
        const hostname = `relay-${nonce}.example.net`;
        const secrets = [
          rawResponse,
          ...realisticValidated.servers.flatMap(
            (server) => [server.username, server.credential]
          )
        ];
        const value = `host=${hostname} user=${realisticValidated.servers[0].username} ` +
          `secret=${realisticValidated.servers[0].credential} raw=${rawResponse}`;
        const redacted = implementation.redactTurnSecrets(
          realisticValidated.servers,
          rawResponse,
          value
        );
        if (typeof redacted !== 'string' || !redacted.includes(hostname) ||
            secrets.some((secret) => redacted.includes(secret))) {
          throw new Error('redactor leaked randomized credentials or raw response');
        }
      });
    }
  }

  return {
    ok: extracted.ok && cases.every((entry) => entry.ok),
    cases,
    extractedOk: extracted.ok,
    behavior,
    detail: `${extracted.detail} cases=${cases.length} failures=${cases
      .filter((entry) => !entry.ok).map((entry) => entry.name).join(',') || 'none'}`
  };
}

function findBalancedEnd(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] || '';

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function functionBody(source, name) {
  const declarations = topLevelFunctionDeclarationPositions(source).get(name) || [];
  if (declarations.length === 0) {
    return '';
  }
  const parameterStart = source.indexOf('(', declarations[0]);
  const parameterEnd = findBalancedEnd(source, parameterStart, '(', ')');
  const bodyStart = parameterEnd < 0 ? -1 : source.indexOf('{', parameterEnd + 1);
  if (bodyStart < 0) {
    return '';
  }
  const bodyEnd = findBalancedEnd(source, bodyStart, '{', '}');
  return bodyEnd < 0 ? '' : source.slice(bodyStart + 1, bodyEnd);
}

let targetAstCacheSource = null;
let targetAstCacheResult = null;
let activeTokenCacheSource = null;
let activeTokenCacheTokens = null;
let activeDeclarationCacheSource = null;
let activeDeclarationCache = null;

function parseTargetJavaScript(source) {
  if (source === targetAstCacheSource && targetAstCacheResult) {
    return targetAstCacheResult;
  }
  try {
    targetAstCacheResult = {
      ok: true,
      ast: acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowHashBang: true,
        locations: true
      }),
      error: ''
    };
  } catch (error) {
    targetAstCacheResult = {
      ok: false,
      ast: null,
      error: String(error && error.message ? error.message : error)
    };
  }
  targetAstCacheSource = source;
  return targetAstCacheResult;
}

function walkTargetAst(node, visitor, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walkTargetAst(child, visitor, node);
      }
    } else if (value && typeof value.type === 'string') {
      walkTargetAst(value, visitor, node);
    }
  }
}

function walkFunctionControlFlow(functionNode, visitor) {
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    visitor(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (!child || typeof child.type !== 'string') continue;
        if (/^(?:Function|ArrowFunction)/.test(child.type)) continue;
        visit(child, node);
      }
    }
  };
  visit(functionNode.body, functionNode);
}

function staticStringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function memberPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  return node.computed
    ? staticStringValue(node.property)
    : node.property && node.property.type === 'Identifier'
      ? node.property.name
      : null;
}

function astTopLevelFunctionMap(ast) {
  const declarations = new Map();
  if (!ast) return declarations;
  for (const statement of ast.body) {
    if (statement.type !== 'FunctionDeclaration' || !statement.id) continue;
    if (!declarations.has(statement.id.name)) declarations.set(statement.id.name, []);
    declarations.get(statement.id.name).push(statement);
  }
  return declarations;
}

function uniqueTopLevelFunctionNode(ast, name) {
  const nodes = astTopLevelFunctionMap(ast).get(name) || [];
  return nodes.length === 1 ? nodes[0] : null;
}

function functionControlFlowFacts(ast, name) {
  const functionNode = uniqueTopLevelFunctionNode(ast, name);
  const facts = {
    functionNode,
    returns: [],
    calls: [],
    assignments: [],
    declarations: []
  };
  if (!functionNode) return facts;
  walkFunctionControlFlow(functionNode, (node) => {
    if (node.type === 'ReturnStatement') facts.returns.push(node);
    if (node.type === 'CallExpression') facts.calls.push(node);
    if (node.type === 'AssignmentExpression') facts.assignments.push(node);
    if (node.type === 'VariableDeclarator') facts.declarations.push(node);
  });
  return facts;
}

function unwrapAstExpression(node) {
  let current = node;
  while (current && (current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression')) {
    current = current.expression;
  }
  return current;
}

function staticPrimitiveValue(node) {
  const current = unwrapAstExpression(node);
  if (!current) return { known: false, value: undefined };
  if (current.type === 'Literal') return { known: true, value: current.value };
  if (current.type === 'UnaryExpression') {
    const argument = staticPrimitiveValue(current.argument);
    if (!argument.known) return { known: false, value: undefined };
    if (current.operator === '!') return { known: true, value: !argument.value };
    if (current.operator === '+') return { known: true, value: +argument.value };
    if (current.operator === '-') return { known: true, value: -argument.value };
    if (current.operator === 'void') return { known: true, value: undefined };
  }
  if (current.type === 'BinaryExpression') {
    const left = staticPrimitiveValue(current.left);
    const right = staticPrimitiveValue(current.right);
    if (!left.known || !right.known) return { known: false, value: undefined };
    switch (current.operator) {
      case '===': return { known: true, value: left.value === right.value };
      case '!==': return { known: true, value: left.value !== right.value };
      case '==': return { known: true, value: left.value == right.value }; // eslint-disable-line eqeqeq
      case '!=': return { known: true, value: left.value != right.value }; // eslint-disable-line eqeqeq
      case '<': return { known: true, value: left.value < right.value };
      case '<=': return { known: true, value: left.value <= right.value };
      case '>': return { known: true, value: left.value > right.value };
      case '>=': return { known: true, value: left.value >= right.value };
      case '+': return { known: true, value: left.value + right.value };
      default: return { known: false, value: undefined };
    }
  }
  return { known: false, value: undefined };
}

function staticTruthValue(node) {
  const primitive = staticPrimitiveValue(node);
  return primitive.known ? !!primitive.value : null;
}

function reachableFunctionNodes(ast, name) {
  const functionNode = (astTopLevelFunctionMap(ast).get(name) || [])[0] || null;
  const nodes = [];
  const parents = new Map();
  if (!functionNode) return { functionNode: null, nodes, parents };

  const record = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    nodes.push(node);
    if (parent) parents.set(node, parent);
  };
  const visitExpression = (node, parent) => {
    const current = unwrapAstExpression(node);
    if (!current) return;
    record(current, parent);
    if (current.type === 'LogicalExpression') {
      visitExpression(current.left, current);
      const left = staticTruthValue(current.left);
      if (!((current.operator === '&&' && left === false) ||
          (current.operator === '||' && left === true) ||
          (current.operator === '??' && staticPrimitiveValue(current.left).known &&
            staticPrimitiveValue(current.left).value !== null &&
            staticPrimitiveValue(current.left).value !== undefined))) {
        visitExpression(current.right, current);
      }
      return;
    }
    if (current.type === 'ConditionalExpression') {
      visitExpression(current.test, current);
      const truth = staticTruthValue(current.test);
      if (truth !== false) visitExpression(current.consequent, current);
      if (truth !== true) visitExpression(current.alternate, current);
      return;
    }
    if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
      for (const parameter of current.params) visitExpression(parameter, current);
      if (current.body.type === 'BlockStatement') {
        visitBlock(current.body, current);
      } else {
        visitExpression(current.body, current);
      }
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      if (['start', 'end', 'loc', 'range', 'type'].includes(key)) continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child.type === 'string') visitExpression(child, current);
      }
    }
  };
  const visitStatement = (statement, parent) => {
    if (!statement) return false;
    record(statement, parent);
    switch (statement.type) {
      case 'BlockStatement':
        return visitBlock(statement, parent);
      case 'IfStatement': {
        visitExpression(statement.test, statement);
        const truth = staticTruthValue(statement.test);
        let consequentTerminates = false;
        let alternateTerminates = false;
        if (truth !== false) consequentTerminates = visitStatement(statement.consequent, statement);
        if (truth !== true && statement.alternate) {
          alternateTerminates = visitStatement(statement.alternate, statement);
        }
        return truth === true ? consequentTerminates
          : truth === false ? alternateTerminates
            : !!statement.alternate && consequentTerminates && alternateTerminates;
      }
      case 'ReturnStatement':
      case 'ThrowStatement':
        if (statement.argument) visitExpression(statement.argument, statement);
        return true;
      case 'BreakStatement':
      case 'ContinueStatement':
        return true;
      case 'VariableDeclaration':
        for (const declaration of statement.declarations) {
          record(declaration, statement);
          visitExpression(declaration.id, declaration);
          if (declaration.init) visitExpression(declaration.init, declaration);
        }
        return false;
      case 'ExpressionStatement':
        visitExpression(statement.expression, statement);
        return false;
      case 'ForOfStatement':
      case 'ForInStatement':
        visitExpression(statement.left, statement);
        visitExpression(statement.right, statement);
        visitStatement(statement.body, statement);
        return false;
      case 'ForStatement': {
        if (statement.init) {
          if (statement.init.type === 'VariableDeclaration') {
            visitStatement(statement.init, statement);
          } else {
            visitExpression(statement.init, statement);
          }
        }
        if (statement.test) visitExpression(statement.test, statement);
        if (staticTruthValue(statement.test) !== false) visitStatement(statement.body, statement);
        if (statement.update) visitExpression(statement.update, statement);
        return false;
      }
      case 'WhileStatement':
      case 'DoWhileStatement':
        visitExpression(statement.test, statement);
        if (statement.type === 'DoWhileStatement' || staticTruthValue(statement.test) !== false) {
          visitStatement(statement.body, statement);
        }
        return false;
      case 'TryStatement':
        visitStatement(statement.block, statement);
        if (statement.handler) {
          record(statement.handler, statement);
          visitStatement(statement.handler.body, statement.handler);
        }
        if (statement.finalizer) visitStatement(statement.finalizer, statement);
        return false;
      case 'SwitchStatement':
        visitExpression(statement.discriminant, statement);
        for (const switchCase of statement.cases) {
          record(switchCase, statement);
          if (switchCase.test) visitExpression(switchCase.test, switchCase);
          for (const child of switchCase.consequent) visitStatement(child, switchCase);
        }
        return false;
      case 'LabeledStatement':
        return visitStatement(statement.body, statement);
      case 'FunctionDeclaration':
        return false;
      default:
        for (const [key, value] of Object.entries(statement)) {
          if (['start', 'end', 'loc', 'range', 'type'].includes(key)) continue;
          const children = Array.isArray(value) ? value : [value];
          for (const child of children) {
            if (!child || typeof child.type !== 'string') continue;
            if (/Statement$/.test(child.type) || child.type === 'BlockStatement') {
              visitStatement(child, statement);
            } else {
              visitExpression(child, statement);
            }
          }
        }
        return false;
    }
  };
  const visitBlock = (block, parent) => {
    record(block, parent);
    let terminated = false;
    for (const statement of block.body) {
      if (terminated) break;
      terminated = visitStatement(statement, block);
    }
    return terminated;
  };

  visitBlock(functionNode.body, functionNode);
  return { functionNode, nodes, parents };
}

function reachableCalls(ast, name) {
  return reachableFunctionNodes(ast, name).nodes.filter(
    (node) => node.type === 'CallExpression' || node.type === 'NewExpression'
  );
}

function callCalleeName(call) {
  const callee = unwrapAstExpression(call && call.callee);
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  return memberPropertyName(callee) || '';
}

function astNodeContains(node, predicate) {
  let found = false;
  walkTargetAst(node, (candidate) => {
    if (!found && predicate(candidate)) found = true;
  });
  return found;
}

function nodeHasMemberPath(node, expectedPath) {
  return astNodeContains(node, (candidate) => {
    const parts = memberExpressionPath(candidate);
    return parts && parts.join('.') === expectedPath;
  });
}

function sourceSlice(source, node) {
  return node ? source.slice(node.start, node.end) : '';
}

function sourceForTopLevelFunction(source, ast, name) {
  const node = uniqueTopLevelFunctionNode(ast, name);
  return node ? source.slice(node.start, node.end) : '';
}

function assignedPatternIdentifiers(node, names = []) {
  if (!node) return names;
  if (node.type === 'Identifier') {
    names.push(node.name);
  } else if (node.type === 'ObjectPattern') {
    for (const property of node.properties) {
      if (property.type === 'RestElement') {
        assignedPatternIdentifiers(property.argument, names);
      } else {
        assignedPatternIdentifiers(property.value, names);
      }
    }
  } else if (node.type === 'ArrayPattern') {
    for (const element of node.elements) assignedPatternIdentifiers(element, names);
  } else if (node.type === 'AssignmentPattern') {
    assignedPatternIdentifiers(node.left, names);
  } else if (node.type === 'RestElement') {
    assignedPatternIdentifiers(node.argument, names);
  } else if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      assignedPatternIdentifiers(declaration.id, names);
    }
  }
  return names;
}

function assignedPatternIdentifierNodes(node, identifiers = []) {
  if (!node) return identifiers;
  if (node.type === 'Identifier') {
    identifiers.push(node);
  } else if (node.type === 'ObjectPattern') {
    for (const property of node.properties) {
      assignedPatternIdentifierNodes(
        property.type === 'RestElement' ? property.argument : property.value,
        identifiers
      );
    }
  } else if (node.type === 'ArrayPattern') {
    for (const element of node.elements) {
      assignedPatternIdentifierNodes(element, identifiers);
    }
  } else if (node.type === 'AssignmentPattern') {
    assignedPatternIdentifierNodes(node.left, identifiers);
  } else if (node.type === 'RestElement') {
    assignedPatternIdentifierNodes(node.argument, identifiers);
  } else if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      assignedPatternIdentifierNodes(declaration.id, identifiers);
    }
  }
  return identifiers;
}

function isFunctionAstNode(node) {
  return !!node && /^(?:Function|ArrowFunction)/.test(node.type);
}

function astNodeRangeContains(outer, inner) {
  return !!outer && !!inner && Number.isInteger(outer.start) && Number.isInteger(outer.end) &&
    Number.isInteger(inner.start) && Number.isInteger(inner.end) &&
    outer.start <= inner.start && inner.end <= outer.end;
}

function lexicalScopeDeclaresIdentifier(scope, name, reference = null) {
  const declarationHasName = (declaration) =>
    assignedPatternIdentifiers(declaration.id).includes(name);
  const statementsDeclareLexically = (statements) => statements.some((statement) => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      return statement.declarations.some(declarationHasName);
    }
    return (statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration') && statement.id && statement.id.name === name;
  });
  if (scope.type === 'BlockStatement' || scope.type === 'StaticBlock') {
    return statementsDeclareLexically(scope.body);
  }
  if (scope.type === 'SwitchStatement') {
    return statementsDeclareLexically(scope.cases.flatMap((switchCase) =>
      switchCase.consequent));
  }
  if (scope.type === 'CatchClause') {
    return assignedPatternIdentifiers(scope.param).includes(name);
  }
  if (scope.type === 'ForStatement') {
    return scope.init && scope.init.type === 'VariableDeclaration' &&
      scope.init.kind !== 'var' && scope.init.declarations.some(declarationHasName);
  }
  if (scope.type === 'ForOfStatement' || scope.type === 'ForInStatement') {
    return scope.left && scope.left.type === 'VariableDeclaration' &&
      scope.left.kind !== 'var' && scope.left.declarations.some(declarationHasName);
  }
  if (!isFunctionAstNode(scope)) return false;
  if ((scope.id && scope.id.name === name) ||
      scope.params.some((parameter) =>
        assignedPatternIdentifiers(parameter).includes(name))) {
    return true;
  }
  // Functions with default/destructured parameters evaluate those initializers in a
  // parameter environment outside the body variable environment. A `var` declared in
  // the body therefore cannot shadow a reference captured by a parameter initializer.
  if (reference && scope.params.some((parameter) =>
    astNodeRangeContains(parameter, reference))) {
    return false;
  }
  let declaresVar = false;
  walkFunctionControlFlow(scope, (candidate) => {
    if (candidate.type === 'VariableDeclaration' && candidate.kind === 'var' &&
        candidate.declarations.some(declarationHasName)) {
      declaresVar = true;
    }
  });
  return declaresVar;
}

function reachableNestedFunctionsFromLoop(functionNode, loopStatement, parents) {
  const targetBindings = new Map();
  const aliasBindings = new Map();
  const localLexicalBindings = new Map();
  const localLexicalNames = new Map();
  const localLexicalDeclarationCounts = new Map();
  const nonLexicalNames = new Map();
  const localMemberWrites = new Map();
  const localMemberWriteEntries = [];
  const localArrayMutationCalls = [];
  const declaredNames = new Map();
  const dynamicParameterTargets = new Map();
  const directCallCache = new Map();
  const synchronousArrayCallbackIndexes = new Map([
    ['every', 0], ['filter', 0], ['find', 0], ['findIndex', 0], ['flatMap', 0],
    ['forEach', 0], ['map', 0], ['reduce', 0], ['reduceRight', 0], ['some', 0],
    ['sort', 0]
  ]);

  const ownerFunction = (node) => {
    let ancestor = parents.get(node);
    while (ancestor && ancestor !== functionNode) {
      if (isFunctionAstNode(ancestor)) return ancestor;
      ancestor = parents.get(ancestor);
    }
    return functionNode;
  };
  const scopeChain = (context) => {
    const chain = [];
    let current = context || functionNode;
    while (current) {
      chain.push(current);
      if (current === functionNode) break;
      current = ownerFunction(current);
    }
    return chain;
  };
  const namesForOwner = (owner) => {
    if (!declaredNames.has(owner)) declaredNames.set(owner, new Set());
    return declaredNames.get(owner);
  };
  const lexicalNamesForOwner = (owner) => {
    if (!localLexicalNames.has(owner)) localLexicalNames.set(owner, new Set());
    return localLexicalNames.get(owner);
  };
  const nonLexicalNamesForOwner = (owner) => {
    if (!nonLexicalNames.has(owner)) nonLexicalNames.set(owner, new Set());
    return nonLexicalNames.get(owner);
  };
  const recordLexicalDeclaration = (owner, name) => {
    lexicalNamesForOwner(owner).add(name);
    if (!localLexicalDeclarationCounts.has(owner)) {
      localLexicalDeclarationCounts.set(owner, new Map());
    }
    const counts = localLexicalDeclarationCounts.get(owner);
    counts.set(name, (counts.get(name) || 0) + 1);
  };
  const entriesForKey = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };
  const referenceKey = (node) => {
    const current = unwrapAstExpression(node);
    if (!current) return null;
    if (current.type === 'Identifier') return current.name;
    const pathParts = memberExpressionPath(current);
    return pathParts ? pathParts.join('.') : null;
  };
  const propertyKey = (property) => {
    if (!property) return null;
    if (!property.computed && property.key && property.key.type === 'Identifier') {
      return property.key.name;
    }
    return staticStringValue(property.key);
  };
  const boundedMemberPropertyName = (node) => {
    const property = memberPropertyName(node);
    if (property !== null) return property;
    return node && node.type === 'MemberExpression' && node.computed &&
      node.property && node.property.type === 'Literal' &&
      (typeof node.property.value === 'number' || typeof node.property.value === 'bigint')
      ? String(node.property.value)
      : null;
  };
  const addTarget = (key, target, owner) => {
    if (!key || !isFunctionAstNode(target)) return;
    entriesForKey(targetBindings, key).push({ owner, target });
  };
  const addAlias = (key, expression, owner) => {
    if (!key || !expression) return;
    entriesForKey(aliasBindings, key).push({ owner, expression });
  };
  const addLocalLexicalBinding = (key, expression, owner) => {
    if (!key || !expression || key.includes('.')) return;
    entriesForKey(localLexicalBindings, key).push({ owner, expression });
  };
  const addLocalMemberWrite = (key, target, value, owner, node) => {
    if (!key || !key.includes('.')) return;
    entriesForKey(localMemberWrites, key).push({ owner, node, value });
    const current = unwrapAstExpression(target);
    if (current && current.type === 'MemberExpression') {
      const property = boundedMemberPropertyName(current);
      if (property !== null) {
        localMemberWriteEntries.push({
          owner,
          receiver: current.object,
          property,
          value,
          node
        });
      }
    }
  };
  const addClassBindings = (baseKey, classNode, owner) => {
    if (!baseKey || !classNode || !classNode.body) return;
    for (const element of classNode.body.body) {
      if (element.type !== 'MethodDefinition') continue;
      const name = propertyKey(element);
      if (!name) continue;
      if (element.static) {
        addTarget(`${baseKey}.${name}`, element.value, owner);
      } else if (element.kind === 'method') {
        addTarget(`${baseKey}.prototype.${name}`, element.value, owner);
      }
    }
  };
  const addObjectBindings = (baseKey, objectNode, owner) => {
    if (!baseKey || !objectNode || objectNode.type !== 'ObjectExpression') return;
    for (const property of objectNode.properties) {
      if (property.type !== 'Property') continue;
      const name = propertyKey(property);
      if (!name) continue;
      const key = `${baseKey}.${name}`;
      if (isFunctionAstNode(property.value)) {
        addTarget(key, property.value, owner);
      } else {
        addAlias(key, property.value, owner);
      }
    }
  };
  const addValueBinding = (key, value, owner) => {
    const current = unwrapAstExpression(value);
    if (!key || !current) return;
    if (isFunctionAstNode(current)) {
      addTarget(key, current, owner);
    } else if (current.type === 'ObjectExpression') {
      addObjectBindings(key, current, owner);
    } else if (current.type === 'ClassExpression') {
      addClassBindings(key, current, owner);
    } else if (current.type === 'CallExpression' &&
        current.callee.type === 'MemberExpression' &&
        memberPropertyName(current.callee) === 'bind') {
      addAlias(key, current, owner);
    } else {
      addAlias(key, current, owner);
    }
  };
  const syntheticMemberReference = (object, propertyName) => ({
    type: 'MemberExpression',
    computed: !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propertyName),
    object,
    property: /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propertyName)
      ? { type: 'Identifier', name: propertyName }
      : { type: 'Literal', value: propertyName }
  });
  const addPatternValueBindings = (pattern, value, owner) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      addValueBinding(pattern.name, value, owner);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      addPatternValueBindings(pattern.left, value, owner);
      addPatternValueBindings(pattern.left, pattern.right, owner);
      return;
    }
    if (pattern.type === 'RestElement') {
      addPatternValueBindings(pattern.argument, value, owner);
      return;
    }
    const currentValue = unwrapAstExpression(value);
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') continue;
        const name = propertyKey(property);
        if (!name) continue;
        let propertyValue = currentValue
          ? syntheticMemberReference(currentValue, name)
          : null;
        if (currentValue && currentValue.type === 'ObjectExpression') {
          const sourceProperty = currentValue.properties.find((candidate) =>
            candidate.type === 'Property' && propertyKey(candidate) === name);
          if (sourceProperty) propertyValue = sourceProperty.value;
        }
        addPatternValueBindings(property.value, propertyValue, owner);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index];
        if (!element) continue;
        const elementValue = currentValue && currentValue.type === 'ArrayExpression'
          ? currentValue.elements[index]
          : currentValue
            ? syntheticMemberReference(currentValue, String(index))
            : null;
        addPatternValueBindings(element, elementValue, owner);
      }
    }
  };

  for (const parameter of functionNode.params) {
    for (const name of assignedPatternIdentifiers(parameter)) {
      namesForOwner(functionNode).add(name);
      nonLexicalNamesForOwner(functionNode).add(name);
    }
  }

  walkTargetAst(functionNode.body, (node, parent) => {
    const owner = ownerFunction(node);
    if (isFunctionAstNode(node)) {
      const functionNames = namesForOwner(node);
      for (const parameter of node.params) {
        for (const name of assignedPatternIdentifiers(parameter)) {
          functionNames.add(name);
          nonLexicalNamesForOwner(node).add(name);
        }
      }
      if (node.type === 'FunctionExpression' && node.id) functionNames.add(node.id.name);
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      namesForOwner(owner).add(node.id.name);
      nonLexicalNamesForOwner(owner).add(node.id.name);
      addTarget(node.id.name, node, owner);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      namesForOwner(owner).add(node.id.name);
      nonLexicalNamesForOwner(owner).add(node.id.name);
      addClassBindings(node.id.name, node, owner);
    } else if (node.type === 'VariableDeclarator') {
      for (const name of assignedPatternIdentifiers(node.id)) namesForOwner(owner).add(name);
      const declarationKind = parent && parent.type === 'VariableDeclaration'
        ? parent.kind
        : null;
      if (declarationKind === 'const' || declarationKind === 'let') {
        for (const name of assignedPatternIdentifiers(node.id)) {
          recordLexicalDeclaration(owner, name);
        }
        if (node.init && node.id.type === 'Identifier') {
          addLocalLexicalBinding(node.id.name, node.init, owner);
        }
      } else if (declarationKind === 'var') {
        for (const name of assignedPatternIdentifiers(node.id)) {
          nonLexicalNamesForOwner(owner).add(name);
        }
      }
      if (node.init) addPatternValueBindings(node.id, node.init, owner);
    } else if (node.type === 'AssignmentExpression') {
      const key = referenceKey(node.left);
      if (key) {
        addValueBinding(key, node.right, owner);
        addLocalMemberWrite(key, node.left, node.right, owner, node);
        if (!key.includes('.') && lexicalNamesForOwner(owner).has(key)) {
          addLocalLexicalBinding(key, node.right, owner);
        }
      } else {
        const target = unwrapAstExpression(node.left);
        if (target && target.type === 'MemberExpression') {
          const objectKey = referenceKey(target.object);
          const property = boundedMemberPropertyName(target);
          if (objectKey && property !== null) {
            addLocalMemberWrite(
              `${objectKey}.${property}`,
              target,
              node.right,
              owner,
              node
            );
          }
        }
        addPatternValueBindings(node.left, node.right, owner);
      }
    }
    if (node.type === 'CallExpression') {
      const callee = unwrapAstExpression(node.callee);
      if (callee && callee.type === 'MemberExpression' &&
          memberPropertyName(callee) === 'splice') {
        localArrayMutationCalls.push({ owner, receiver: callee.object, node });
      }
    }
  });

  const parameterTargets = (functionTarget, name) => {
    const byName = dynamicParameterTargets.get(functionTarget);
    return byName && byName.get(name) ? byName.get(name) : new Set();
  };
  const localLexicalExpressions = (name, context) => {
    if (!name) return null;
    for (const owner of scopeChain(context)) {
      const entries = (localLexicalBindings.get(name) || []).filter((entry) =>
        entry.owner === owner);
      const declaredHere = lexicalNamesForOwner(owner).has(name);
      if (entries.length > 0 || declaredHere) {
        const declarationCount = localLexicalDeclarationCounts.get(owner)?.get(name) || 0;
        return declarationCount === 1 &&
          !nonLexicalNamesForOwner(owner).has(name) && entries.length === 1
          ? entries
          : null;
      }
    }
    return null;
  };
  const isUnshadowedGlobalName = (name, context) =>
    !scopeChain(context).some((owner) => namesForOwner(owner).has(name));
  const occursBeforeBoundary = (entry, boundary, context) => {
    if (!boundary || !entry.node || typeof entry.node.start !== 'number' ||
        typeof boundary.start !== 'number') {
      return true;
    }
    return entry.owner !== context || entry.node.start < boundary.start;
  };
  const declaredOwnerForName = (name, context) => {
    for (const owner of scopeChain(context)) {
      if (namesForOwner(owner).has(name)) return owner;
    }
    return null;
  };
  const localReferenceIdentityKeys = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'Identifier') {
      const declarationOwner = declaredOwnerForName(current.name, context);
      const ownKey = declarationOwner
        ? `${declarationOwner.start}:${declarationOwner.end}:${current.name}`
        : `global:${current.name}`;
      const result = new Set([ownKey]);
      const visitKey = `${context.start}:${context.end}:${ownKey}`;
      if (visited.has(visitKey)) return result;
      const entries = localLexicalExpressions(current.name, context);
      if (!entries) return result;
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      for (const key of localReferenceIdentityKeys(
        entries[0].expression,
        entries[0].owner,
        nextVisited
      )) {
        result.add(key);
      }
      return result;
    }
    if (current.type !== 'MemberExpression') return new Set();
    const property = boundedMemberPropertyName(current);
    if (property === null) return new Set();
    return new Set([...localReferenceIdentityKeys(current.object, context, visited)]
      .map((key) => `${key}.${property}`));
  };
  const projectedReferenceKeys = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'Identifier') {
      const result = new Set([current.name]);
      const declarationOwner = declaredOwnerForName(current.name, context);
      const visitKey = `${declarationOwner ? declarationOwner.start : 'global'}:` +
        `${current.name}`;
      if (visited.has(visitKey)) return result;
      const entries = localLexicalExpressions(current.name, context);
      if (!entries) return result;
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      for (const key of projectedReferenceKeys(
        entries[0].expression,
        entries[0].owner,
        nextVisited
      )) {
        result.add(key);
      }
      return result;
    }
    if (current.type !== 'MemberExpression') return new Set();
    const property = boundedMemberPropertyName(current);
    if (property === null) return new Set();
    return new Set([...projectedReferenceKeys(current.object, context, visited)]
      .map((key) => `${key}.${property}`));
  };
  const isArrayFromCall = (node, context, boundary = null) => {
    const current = unwrapAstExpression(node);
    if (!current || current.type !== 'CallExpression') return false;
    const calleePath = memberExpressionPath(unwrapAstExpression(current.callee));
    return !!calleePath && calleePath.join('.') === 'Array.from' &&
      isUnshadowedGlobalName('Array', context) &&
      !scopeChain(context).some((owner) =>
        (localMemberWrites.get('Array.from') || []).some((entry) =>
          entry.owner === owner && occursBeforeBoundary(entry, boundary, context)));
  };
  const localArrayOrigins = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'ArrayExpression') {
      return new Set([`array:${current.start}:${current.end}`]);
    }
    if (isArrayFromCall(current, context)) {
      return new Set([`array-from:${current.start}:${current.end}`]);
    }
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return localArrayOrigins(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        visited
      );
    }
    if (current.type === 'SequenceExpression') {
      return current.expressions.length > 0
        ? localArrayOrigins(
          current.expressions[current.expressions.length - 1],
          context,
          visited
        )
        : new Set();
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) return localArrayOrigins(current.consequent, context, visited);
      if (truth === false) return localArrayOrigins(current.alternate, context, visited);
      return new Set([
        ...localArrayOrigins(current.consequent, context, new Set(visited)),
        ...localArrayOrigins(current.alternate, context, new Set(visited))
      ]);
    }
    if (current.type !== 'Identifier') return new Set();
    const visitKey = `${context.start}:${context.end}:${current.name}`;
    if (visited.has(visitKey)) return new Set();
    const entries = localLexicalExpressions(current.name, context);
    if (!entries) return new Set();
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    return localArrayOrigins(entries[0].expression, entries[0].owner, nextVisited);
  };
  const localMemberWritesForReceiver = (
    receiver,
    property,
    context,
    boundary = null
  ) => {
    const receiverIdentities = localReferenceIdentityKeys(receiver, context);
    const receiverOrigins = localArrayOrigins(receiver, context);
    const visibleOwners = new Set(scopeChain(context));
    return localMemberWriteEntries.filter((entry) => {
      if (!visibleOwners.has(entry.owner) ||
          (property !== null && entry.property !== property) ||
          !occursBeforeBoundary(entry, boundary, context)) {
        return false;
      }
      const writeIdentities = localReferenceIdentityKeys(entry.receiver, entry.owner);
      if ([...writeIdentities].some((key) => receiverIdentities.has(key))) return true;
      if (receiverOrigins.size === 0) return false;
      const writeOrigins = localArrayOrigins(entry.receiver, entry.owner);
      return [...writeOrigins].some((origin) => receiverOrigins.has(origin));
    }).sort((left, right) => left.node.start - right.node.start);
  };
  const localArrayHasMemberWrite = (receiver, context, property = null, boundary = null) =>
    localMemberWritesForReceiver(receiver, property, context, boundary).length > 0;
  const hasLocalMemberWrite = (receiver, property, context, boundary = null) =>
    localMemberWritesForReceiver(receiver, property, context, boundary).length > 0;
  const isProvenLocalArray = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return false;
    if (current.type === 'ArrayExpression' || isArrayFromCall(current, context)) return true;
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return isProvenLocalArray(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        visited
      );
    }
    if (current.type === 'SequenceExpression') {
      return current.expressions.length > 0 && isProvenLocalArray(
        current.expressions[current.expressions.length - 1],
        context,
        visited
      );
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) return isProvenLocalArray(current.consequent, context, visited);
      if (truth === false) return isProvenLocalArray(current.alternate, context, visited);
      return isProvenLocalArray(current.consequent, context, new Set(visited)) &&
        isProvenLocalArray(current.alternate, context, new Set(visited));
    }
    if (current.type !== 'Identifier') return false;
    const visitKey = `${context.start}:${context.end}:${current.name}`;
    if (visited.has(visitKey)) return false;
    const entries = localLexicalExpressions(current.name, context);
    if (!entries) return false;
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    return isProvenLocalArray(entries[0].expression, entries[0].owner, nextVisited);
  };
  const staticLocalArrayBaseElements = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return null;
    if (current.type === 'ArrayExpression') {
      if (current.elements.some((element) => !element || element.type === 'SpreadElement')) {
        return null;
      }
      return [...current.elements];
    }
    if (isArrayFromCall(current, context)) {
      return current.arguments.length === 1 &&
        current.arguments[0].type !== 'SpreadElement'
        ? staticLocalArrayBaseElements(current.arguments[0], context, visited)
        : null;
    }
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return staticLocalArrayBaseElements(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        visited
      );
    }
    if (current.type === 'SequenceExpression') {
      return current.expressions.length > 0
        ? staticLocalArrayBaseElements(
          current.expressions[current.expressions.length - 1],
          context,
          visited
        )
        : null;
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) {
        return staticLocalArrayBaseElements(current.consequent, context, visited);
      }
      if (truth === false) {
        return staticLocalArrayBaseElements(current.alternate, context, visited);
      }
      return null;
    }
    if (current.type !== 'Identifier') return null;
    const visitKey = `${context.start}:${context.end}:${current.name}`;
    if (visited.has(visitKey)) return null;
    const entries = localLexicalExpressions(current.name, context);
    if (!entries) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    return staticLocalArrayBaseElements(entries[0].expression, entries[0].owner, nextVisited);
  };
  const staticSpliceArguments = (call, length) => {
    if (!call || call.arguments.length === 0 ||
        call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return null;
    }
    const startValue = staticPrimitiveValue(call.arguments[0]);
    if (!startValue.known || !Number.isInteger(startValue.value)) return null;
    const normalizedStart = startValue.value < 0
      ? Math.max(length + startValue.value, 0)
      : Math.min(startValue.value, length);
    let deleteCount = length - normalizedStart;
    if (call.arguments.length >= 2) {
      const deleteValue = staticPrimitiveValue(call.arguments[1]);
      if (!deleteValue.known || !Number.isInteger(deleteValue.value)) return null;
      deleteCount = Math.min(Math.max(deleteValue.value, 0), length - normalizedStart);
    }
    return {
      start: normalizedStart,
      deleteCount,
      insertions: call.arguments.slice(2)
    };
  };
  const staticLocalArrayElements = (expression, context, boundary = null) => {
    const elements = staticLocalArrayBaseElements(expression, context);
    if (!elements) return null;
    if (localArrayHasMemberWrite(expression, context, null, boundary)) return null;
    const receiverOrigins = localArrayOrigins(expression, context);
    if (receiverOrigins.size === 0) return elements;
    const visibleOwners = new Set(scopeChain(context));
    const mutations = localArrayMutationCalls.filter((entry) => {
      if (!visibleOwners.has(entry.owner) ||
          !occursBeforeBoundary(entry, boundary, context)) {
        return false;
      }
      const mutationOrigins = localArrayOrigins(entry.receiver, entry.owner);
      return [...mutationOrigins].some((origin) => receiverOrigins.has(origin));
    }).sort((left, right) => left.node.start - right.node.start);
    const result = [...elements];
    for (const mutation of mutations) {
      const operation = staticSpliceArguments(mutation.node, result.length);
      if (!operation) return null;
      result.splice(operation.start, operation.deleteCount, ...operation.insertions);
    }
    return result;
  };
  const resolveTargets = (expression, context, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (isFunctionAstNode(current)) return new Set([current]);
    if (current.type === 'CallExpression' && current.callee.type === 'MemberExpression' &&
        memberPropertyName(current.callee) === 'bind') {
      return resolveTargets(current.callee.object, context, visited);
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) return resolveTargets(current.consequent, context, visited);
      if (truth === false) return resolveTargets(current.alternate, context, visited);
      return new Set([
        ...resolveTargets(current.consequent, context, visited),
        ...resolveTargets(current.alternate, context, visited)
      ]);
    }
    if (current.type === 'LogicalExpression') {
      const leftPrimitive = staticPrimitiveValue(current.left);
      const leftTruth = leftPrimitive.known ? !!leftPrimitive.value : null;
      if ((current.operator === '&&' && leftTruth === false) ||
          (current.operator === '||' && leftTruth === true) ||
          (current.operator === '??' && leftPrimitive.known &&
            leftPrimitive.value !== null && leftPrimitive.value !== undefined)) {
        return resolveTargets(current.left, context, visited);
      }
      if ((current.operator === '&&' && leftTruth === true) ||
          (current.operator === '||' && leftTruth === false) ||
          (current.operator === '??' && leftPrimitive.known)) {
        return resolveTargets(current.right, context, visited);
      }
      return new Set([
        ...resolveTargets(current.left, context, visited),
        ...resolveTargets(current.right, context, visited)
      ]);
    }
    if (current.type === 'SequenceExpression') {
      return resolveTargets(current.expressions[current.expressions.length - 1], context, visited);
    }
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return resolveTargets(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        visited
      );
    }
    const result = new Set();
    const keys = current.type === 'MemberExpression'
      ? projectedReferenceKeys(current, context)
      : new Set([referenceKey(current)]);
    for (const key of keys) {
      if (!key) continue;
      const baseName = key.split('.')[0];
      for (const owner of scopeChain(context)) {
        const visitKey = `${owner.start}:${owner.end}:${key}`;
        if (visited.has(visitKey)) break;
        const nextVisited = new Set(visited);
        nextVisited.add(visitKey);
        const dynamic = key === baseName ? parameterTargets(owner, key) : new Set();
        const targets = (targetBindings.get(key) || []).filter((entry) =>
          entry.owner === owner);
        const aliases = (aliasBindings.get(key) || []).filter((entry) =>
          entry.owner === owner);
        const declaredHere = namesForOwner(owner).has(baseName);
        for (const target of dynamic) result.add(target);
        for (const entry of targets) result.add(entry.target);
        for (const entry of aliases) {
          for (const target of resolveTargets(entry.expression, entry.owner, nextVisited)) {
            result.add(target);
          }
        }
        if (dynamic.size > 0 || targets.length > 0 || aliases.length > 0 || declaredHere) {
          break;
        }
      }
    }
    return result;
  };
  const nativeArrayMethodNames = (
    expression,
    context,
    boundary = null,
    visited = new Set()
  ) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return nativeArrayMethodNames(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        boundary,
        visited
      );
    }
    if (current.type === 'SequenceExpression') {
      return current.expressions.length > 0
        ? nativeArrayMethodNames(
          current.expressions[current.expressions.length - 1],
          context,
          boundary,
          visited
        )
        : new Set();
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) {
        return nativeArrayMethodNames(current.consequent, context, boundary, visited);
      }
      if (truth === false) {
        return nativeArrayMethodNames(current.alternate, context, boundary, visited);
      }
      return new Set();
    }
    if (current.type === 'Identifier') {
      const declarationOwner = declaredOwnerForName(current.name, context);
      const visitKey = `${declarationOwner ? declarationOwner.start : 'global'}:` +
        `${current.name}:native-array-method`;
      if (visited.has(visitKey)) return new Set();
      const entries = localLexicalExpressions(current.name, context);
      if (!entries) return new Set();
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      return nativeArrayMethodNames(
        entries[0].expression,
        entries[0].owner,
        entries[0].expression,
        nextVisited
      );
    }
    if (current.type !== 'MemberExpression') return new Set();
    const methodName = boundedMemberPropertyName(current);
    if (!synchronousArrayCallbackIndexes.has(methodName)) return new Set();
    const accessBoundary = current.start === null || current.start === undefined
      ? boundary
      : current;
    const path = memberExpressionPath(current);
    if (path && path.join('.') === `Array.prototype.${methodName}` &&
        isUnshadowedGlobalName('Array', context) &&
        !hasLocalMemberWrite(current.object, methodName, context, accessBoundary)) {
      return new Set([methodName]);
    }
    if ((unwrapAstExpression(current.object)?.type === 'ArrayExpression' ||
        isProvenLocalArray(current.object, context)) &&
        !hasLocalMemberWrite(current.object, methodName, context, accessBoundary)) {
      return new Set([methodName]);
    }
    return new Set();
  };
  const boundNativeArrayMethodNames = (
    expression,
    context,
    boundary = null,
    visited = new Set()
  ) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'AssignmentExpression' || current.type === 'AwaitExpression') {
      return boundNativeArrayMethodNames(
        current.type === 'AssignmentExpression' ? current.right : current.argument,
        context,
        boundary,
        visited
      );
    }
    if (current.type === 'SequenceExpression') {
      return current.expressions.length > 0
        ? boundNativeArrayMethodNames(
          current.expressions[current.expressions.length - 1],
          context,
          boundary,
          visited
        )
        : new Set();
    }
    if (current.type === 'ConditionalExpression') {
      const truth = staticTruthValue(current.test);
      if (truth === true) {
        return boundNativeArrayMethodNames(current.consequent, context, boundary, visited);
      }
      if (truth === false) {
        return boundNativeArrayMethodNames(current.alternate, context, boundary, visited);
      }
      return new Set();
    }
    if (current.type === 'Identifier') {
      const declarationOwner = declaredOwnerForName(current.name, context);
      const visitKey = `${declarationOwner ? declarationOwner.start : 'global'}:` +
        `${current.name}:bound-native-array-method`;
      if (visited.has(visitKey)) return new Set();
      const entries = localLexicalExpressions(current.name, context);
      if (!entries) return new Set();
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      return boundNativeArrayMethodNames(
        entries[0].expression,
        entries[0].owner,
        entries[0].expression,
        nextVisited
      );
    }
    if (current.type !== 'CallExpression') return new Set();
    const bindCallee = unwrapAstExpression(current.callee);
    if (!bindCallee || bindCallee.type !== 'MemberExpression' ||
        boundedMemberPropertyName(bindCallee) !== 'bind' ||
        current.arguments.length !== 1 ||
        current.arguments[0].type === 'SpreadElement') {
      return new Set();
    }
    const receiver = current.arguments[0];
    if (!(unwrapAstExpression(receiver)?.type === 'ArrayExpression' ||
        isProvenLocalArray(receiver, context))) {
      return new Set();
    }
    return nativeArrayMethodNames(bindCallee.object, context, current);
  };
  const addDynamicParameterTargets = (functionTarget, name, targets) => {
    if (!name || targets.size === 0) return false;
    if (!dynamicParameterTargets.has(functionTarget)) {
      dynamicParameterTargets.set(functionTarget, new Map());
    }
    const byName = dynamicParameterTargets.get(functionTarget);
    if (!byName.has(name)) byName.set(name, new Set());
    const destination = byName.get(name);
    const oldSize = destination.size;
    for (const target of targets) destination.add(target);
    return destination.size !== oldSize;
  };
  const bindInvocationPattern = (functionTarget, pattern, value, valueContext) => {
    if (!pattern) return false;
    if (pattern.type === 'AssignmentPattern') {
      const omitted = !value || (value.type === 'Identifier' && value.name === 'undefined');
      return bindInvocationPattern(
        functionTarget,
        pattern.left,
        omitted ? pattern.right : value,
        omitted ? functionTarget : valueContext
      );
    }
    if (pattern.type === 'RestElement') {
      return bindInvocationPattern(functionTarget, pattern.argument, value, valueContext);
    }
    if (pattern.type === 'Identifier') {
      return addDynamicParameterTargets(
        functionTarget,
        pattern.name,
        resolveTargets(value, valueContext)
      );
    }
    const currentValue = unwrapAstExpression(value);
    let changed = false;
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') continue;
        const name = propertyKey(property);
        if (!name) continue;
        let propertyValue = currentValue
          ? syntheticMemberReference(currentValue, name)
          : null;
        if (currentValue && currentValue.type === 'ObjectExpression') {
          const sourceProperty = currentValue.properties.find((candidate) =>
            candidate.type === 'Property' && propertyKey(candidate) === name);
          propertyValue = sourceProperty ? sourceProperty.value : null;
        }
        changed = bindInvocationPattern(
          functionTarget,
          property.value,
          propertyValue,
          valueContext
        ) || changed;
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index];
        if (!element) continue;
        const elementValue = currentValue && currentValue.type === 'ArrayExpression'
          ? currentValue.elements[index]
          : currentValue
            ? syntheticMemberReference(currentValue, String(index))
            : null;
        changed = bindInvocationPattern(
          functionTarget,
          element,
          elementValue,
          valueContext
        ) || changed;
      }
    }
    return changed;
  };
  const bindInvocationParameters = (functionTarget, call, callerContext, offset = 0) => {
    let changed = false;
    for (let index = 0; index < functionTarget.params.length; index += 1) {
      const parameter = functionTarget.params[index];
      const argument = call.arguments[index + offset];
      changed = bindInvocationPattern(
        functionTarget,
        parameter,
        argument,
        callerContext
      ) || changed;
    }
    return changed;
  };
  const directCalls = (context) => {
    if (directCallCache.has(context)) return directCallCache.get(context);
    const calls = [];
    const visit = (node) => {
      if (!node || typeof node.type !== 'string' || isFunctionAstNode(node)) return false;
      if (node.type === 'BlockStatement') {
        let terminated = false;
        for (const statement of node.body) {
          terminated = visit(statement);
          if (terminated) break;
        }
        return terminated;
      }
      if (node.type === 'IfStatement') {
        visit(node.test);
        const truth = staticTruthValue(node.test);
        if (truth === true) return visit(node.consequent);
        if (truth === false) return node.alternate ? visit(node.alternate) : false;
        const consequentTerminates = visit(node.consequent);
        const alternateTerminates = node.alternate ? visit(node.alternate) : false;
        return !!node.alternate && consequentTerminates && alternateTerminates;
      }
      if (node.type === 'LogicalExpression') {
        visit(node.left);
        const left = staticTruthValue(node.left);
        if (!((node.operator === '&&' && left === false) ||
            (node.operator === '||' && left === true) ||
            (node.operator === '??' && staticPrimitiveValue(node.left).known &&
              staticPrimitiveValue(node.left).value !== null &&
              staticPrimitiveValue(node.left).value !== undefined))) {
          visit(node.right);
        }
        return false;
      }
      if (node.type === 'ConditionalExpression') {
        visit(node.test);
        const truth = staticTruthValue(node.test);
        if (truth !== false) visit(node.consequent);
        if (truth !== true) visit(node.alternate);
        return false;
      }
      if (node.type === 'ForStatement') {
        if (node.init) visit(node.init);
        if (node.test) visit(node.test);
        if (staticTruthValue(node.test) !== false) {
          visit(node.body);
          if (node.update) visit(node.update);
        }
        return false;
      }
      if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
        visit(node.test);
        if (node.type === 'DoWhileStatement' || staticTruthValue(node.test) !== false) {
          visit(node.body);
        }
        return false;
      }
      if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
        if (node.argument) visit(node.argument);
        return true;
      }
      if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') return true;
      if (node.type === 'CallExpression' || node.type === 'NewExpression') calls.push(node);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) visit(child);
      }
      return false;
    };
    if (context === functionNode) {
      visit(loopStatement);
    } else {
      for (const parameter of context.params) visit(parameter);
      visit(context.body);
    }
    directCallCache.set(context, calls);
    return calls;
  };

  const reachable = new Set();
  const addReachable = (target) => {
    if (!isFunctionAstNode(target) || target === functionNode || reachable.has(target)) {
      return false;
    }
    reachable.add(target);
    return true;
  };
  const processCall = (call, context) => {
    const callee = unwrapAstExpression(call.callee);
    let callTargets = new Set();
    let argumentOffset = 0;
    let applyArguments = null;
    if (callee && callee.type === 'MemberExpression' &&
        ['call', 'apply'].includes(memberPropertyName(callee))) {
      callTargets = resolveTargets(callee.object, context);
      if (memberPropertyName(callee) === 'call') {
        argumentOffset = 1;
      } else if (call.arguments.length >= 2) {
        applyArguments = staticLocalArrayElements(call.arguments[1], context, call);
      }
    } else if (callee && callee.type === 'MemberExpression') {
      const methodName = boundedMemberPropertyName(callee);
      const priorWrites = methodName === null
        ? []
        : localMemberWritesForReceiver(callee.object, methodName, context, call);
      if (priorWrites.length === 0) {
        callTargets = resolveTargets(callee, context);
      } else {
        const latestStart = priorWrites[priorWrites.length - 1].node.start;
        for (const write of priorWrites.filter((entry) => entry.node.start === latestStart)) {
          if (write.node.operator !== '=') continue;
          for (const target of resolveTargets(write.value, write.owner)) {
            callTargets.add(target);
          }
        }
      }
    } else {
      callTargets = resolveTargets(callee, context);
    }
    let changed = false;
    for (const target of callTargets) {
      changed = addReachable(target) || changed;
      if (memberPropertyName(callee) === 'apply') {
        if (applyArguments) {
          changed = bindInvocationParameters(
            target,
            { arguments: applyArguments },
            context
          ) || changed;
        }
      } else {
        changed = bindInvocationParameters(
          target,
          call,
          context,
          argumentOffset
        ) || changed;
      }
    }
    const callbackReceiver = callee && callee.type === 'MemberExpression'
      ? unwrapAstExpression(callee.object)
      : null;
    const methodName = memberPropertyName(callee);
    let callbackIndex = null;
    if (callee && callee.type === 'MemberExpression' && methodName === 'from' &&
        isArrayFromCall(call, context, call)) {
      callbackIndex = 1;
    } else if (callee && callee.type === 'MemberExpression' && callbackReceiver &&
        synchronousArrayCallbackIndexes.has(methodName) &&
        !hasLocalMemberWrite(callbackReceiver, methodName, context, call) &&
        (callbackReceiver.type === 'ArrayExpression' ||
          isProvenLocalArray(callbackReceiver, context))) {
      callbackIndex = synchronousArrayCallbackIndexes.get(methodName);
    }
    if (callbackIndex !== null && call.arguments[callbackIndex]) {
      for (const target of resolveTargets(call.arguments[callbackIndex], context)) {
        changed = addReachable(target) || changed;
      }
    }
    if (callee && callee.type === 'MemberExpression' &&
        ['call', 'apply'].includes(methodName) && call.arguments[0]) {
      const nativeMethods = nativeArrayMethodNames(callee.object, context, call);
      const nativeReceiver = call.arguments[0];
      if (nativeMethods.size > 0 &&
          (unwrapAstExpression(nativeReceiver)?.type === 'ArrayExpression' ||
            isProvenLocalArray(nativeReceiver, context))) {
        const dispatchedArguments = methodName === 'call'
          ? call.arguments.slice(1)
          : applyArguments;
        if (dispatchedArguments) {
          for (const nativeMethod of nativeMethods) {
            const nativeCallbackIndex = synchronousArrayCallbackIndexes.get(nativeMethod);
            const callback = dispatchedArguments[nativeCallbackIndex];
            if (!callback) continue;
            for (const target of resolveTargets(callback, context)) {
              changed = addReachable(target) || changed;
            }
          }
        }
      }
    }
    const boundNativeMethods = callee && callee.type !== 'MemberExpression'
      ? boundNativeArrayMethodNames(callee, context, call)
      : new Set();
    for (const nativeMethod of boundNativeMethods) {
      const nativeCallbackIndex = synchronousArrayCallbackIndexes.get(nativeMethod);
      const callback = call.arguments[nativeCallbackIndex];
      if (!callback) continue;
      for (const target of resolveTargets(callback, context)) {
        changed = addReachable(target) || changed;
      }
    }
    return changed;
  };

  let changed = true;
  let pass = 0;
  while (changed && pass < 32) {
    changed = false;
    pass += 1;
    for (const call of directCalls(functionNode)) {
      changed = processCall(call, functionNode) || changed;
    }
    for (const target of [...reachable]) {
      for (const call of directCalls(target)) {
        changed = processCall(call, target) || changed;
      }
    }
  }
  return reachable;
}

function memberExpressionPath(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return [node.name];
  if (node.type !== 'MemberExpression') return null;
  const objectPath = memberExpressionPath(node.object);
  const property = memberPropertyName(node);
  return objectPath && property !== null ? [...objectPath, property] : null;
}

function candidateOutcomeLocalMutationViolations(ast) {
  const protectedRoots = new Set([
    'candidateOutcomeInitialSnapshot',
    'candidateOutcomeSnapshot',
    'candidateOutcomeSignaling'
  ]);
  const mutatorPaths = new Set([
    'Object.assign',
    'Object.defineProperties',
    'Object.defineProperty',
    'Object.setPrototypeOf',
    'Reflect.defineProperty',
    'Reflect.deleteProperty',
    'Reflect.set',
    'Reflect.setPrototypeOf'
  ]);
  const protectedPath = (node) => {
    const parts = memberExpressionPath(unwrapAstExpression(node));
    return parts && protectedRoots.has(parts[0]) ? parts.join('.') : '';
  };
  const violations = [];
  walkTargetAst(ast, (node) => {
    if (node.type === 'AssignmentExpression' && protectedPath(node.left)) {
      violations.push(`assignment=${protectedPath(node.left)}`);
    } else if (node.type === 'UpdateExpression' && protectedPath(node.argument)) {
      violations.push(`update=${protectedPath(node.argument)}`);
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete' &&
        protectedPath(node.argument)) {
      violations.push(`delete=${protectedPath(node.argument)}`);
    } else if (node.type === 'CallExpression') {
      const callee = (memberExpressionPath(unwrapAstExpression(node.callee)) || [])
        .join('.');
      const target = protectedPath(node.arguments[0]);
      if (mutatorPaths.has(callee) && target) {
        violations.push(`mutator=${callee} target=${target}`);
      }
    }
  });
  return violations;
}

function candidateOwnedIntrinsicViolations(source, violations) {
  const lines = source.split(/\r?\n/);
  return violations.filter((violation) => {
    const lineMatch = /^line=(\d+)\s/.exec(violation);
    const sourceLine = lineMatch ? String(lines[Number(lineMatch[1]) - 1] || '') : '';
    const mutatesUnrelatedArrayEvery = /target=Array\.prototype$/.test(violation) &&
      /(?:Object\.defineProperty|Reflect\.set)\(\s*Array\.prototype\s*,\s*['"]every['"]/.test(
        sourceLine
      );
    return !mutatesUnrelatedArrayEvery;
  });
}

function topLevelFunctionAst(ast, name) {
  if (!ast || !Array.isArray(ast.body)) return null;
  const matches = ast.body.filter((node) =>
    node.type === 'FunctionDeclaration' && node.id && node.id.name === name
  );
  return matches.length === 1 ? matches[0] : null;
}

function logicalConjunctionLeaves(expression) {
  if (expression && expression.type === 'LogicalExpression' &&
      expression.operator === '&&') {
    return [
      ...logicalConjunctionLeaves(expression.left),
      ...logicalConjunctionLeaves(expression.right)
    ];
  }
  return expression ? [expression] : [];
}

function runtimeReferenceTaints(node, aliases) {
  if (!node) return new Set();
  if (node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression') {
    return runtimeReferenceTaints(node.expression, aliases);
  }
  if (node.type === 'Identifier') {
    const builtins = {
      eval: 'dynamic-eval',
      Function: 'dynamic-Function',
      process: 'process-object',
      Object: 'Object-constructor',
      Reflect: 'Reflect-object',
      Array: 'Array-constructor',
      Promise: 'Promise-constructor',
      Math: 'Math-object',
      crypto: 'crypto-module',
      dns: 'dns-module',
      tls: 'tls-module',
      globalThis: 'global-object',
      global: 'global-object',
      window: 'global-object',
      self: 'global-object'
    };
    return new Set([
      ...(aliases.get(node.name) || []),
      ...(builtins[node.name] ? [builtins[node.name]] : [])
    ]);
  }
  if (node.type === 'SequenceExpression') {
    return node.expressions.length > 0
      ? runtimeReferenceTaints(node.expressions[node.expressions.length - 1], aliases)
      : new Set();
  }
  if (node.type === 'ConditionalExpression') {
    return new Set([
      ...runtimeReferenceTaints(node.consequent, aliases),
      ...runtimeReferenceTaints(node.alternate, aliases)
    ]);
  }
  if (node.type === 'LogicalExpression') {
    return new Set([
      ...runtimeReferenceTaints(node.left, aliases),
      ...runtimeReferenceTaints(node.right, aliases)
    ]);
  }
  if (node.type === 'AssignmentExpression') {
    return runtimeReferenceTaints(node.right, aliases);
  }
  if (node.type === 'CallExpression') {
    const property = memberPropertyName(node.callee);
    if (property === 'bind' && node.callee.type === 'MemberExpression') {
      return runtimeReferenceTaints(node.callee.object, aliases);
    }
    return new Set();
  }
  if (node.type !== 'MemberExpression') return new Set();
  const property = memberPropertyName(node);
  if (property === null) return new Set();
  const objectTaints = runtimeReferenceTaints(node.object, aliases);
  const result = new Set();
  const add = (objectTaint, expectedProperty, resultTaint) => {
    if (objectTaints.has(objectTaint) && property === expectedProperty) {
      result.add(resultTaint);
    }
  };
  add('global-object', 'eval', 'dynamic-eval');
  add('global-object', 'Function', 'dynamic-Function');
  add('process-object', 'exit', 'process-exit');
  for (const listenerName of ['on', 'once', 'addListener']) {
    add('process-object', listenerName, 'process-listener');
  }
  add('Object-constructor', 'defineProperty', 'define-property');
  add('Reflect-object', 'defineProperty', 'define-property');
  add('Reflect-object', 'apply', 'reflect-apply');
  add('Reflect-object', 'set', 'reflect-set');
  add('Array-constructor', 'prototype', 'Array-prototype');
  add('Array-prototype', 'every', 'Array.prototype.every');
  add('Array-prototype', 'includes', 'Array.prototype.includes');
  add('crypto-module', 'createHash', 'crypto.createHash');
  add('dns-module', 'resolve4', 'dns.resolve4');
  add('dns-module', 'resolve6', 'dns.resolve6');
  add('tls-module', 'connect', 'tls.connect');
  add('Promise-constructor', 'allSettled', 'Promise.allSettled');
  add('Math-object', 'max', 'Math.max');
  return result;
}

function addRuntimeAliases(pattern, sourceTaints, aliases) {
  let changed = false;
  const addIdentifier = (name, taints) => {
    if (!aliases.has(name)) aliases.set(name, new Set());
    const target = aliases.get(name);
    const oldSize = target.size;
    for (const taint of taints) target.add(taint);
    if (target.size !== oldSize) changed = true;
  };
  if (!pattern) return changed;
  if (pattern.type === 'Identifier') {
    addIdentifier(pattern.name, sourceTaints);
  } else if (pattern.type === 'AssignmentPattern') {
    changed = addRuntimeAliases(pattern.left, sourceTaints, aliases) || changed;
  } else if (pattern.type === 'RestElement') {
    changed = addRuntimeAliases(pattern.argument, sourceTaints, aliases) || changed;
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') continue;
      const propertyName = property.computed
        ? staticStringValue(property.key)
        : property.key.type === 'Identifier'
          ? property.key.name
          : staticStringValue(property.key);
      if (propertyName === null) continue;
      const syntheticMember = {
        type: 'MemberExpression',
        computed: false,
        object: { type: 'Identifier', name: '__runtime_alias_source__' },
        property: { type: 'Identifier', name: propertyName }
      };
      const syntheticAliases = new Map(aliases);
      syntheticAliases.set('__runtime_alias_source__', new Set(sourceTaints));
      changed = addRuntimeAliases(
        property.value,
        runtimeReferenceTaints(syntheticMember, syntheticAliases),
        aliases
      ) || changed;
    }
  }
  return changed;
}

function collectRuntimeAliases(ast) {
  const aliases = new Map();
  if (!ast) return aliases;
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    walkTargetAst(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.init) {
        changed = addRuntimeAliases(
          node.id,
          runtimeReferenceTaints(node.init, aliases),
          aliases
        ) || changed;
      } else if (node.type === 'AssignmentExpression') {
        changed = addRuntimeAliases(
          node.left,
          runtimeReferenceTaints(node.right, aliases),
          aliases
        ) || changed;
      }
    });
    if (!changed) break;
  }
  return aliases;
}

function auditForbiddenRuntimeConstructs(ast) {
  const dynamicCode = [];
  const processExit = [];
  const processLifecycle = [];
  const verdictTampering = [];
  const integrityTampering = {
    crypto: [],
    dns: [],
    promise: [],
    tls: [],
    math: [],
    dispatch: []
  };
  if (!ast) {
    return {
      dynamicCode,
      processExit,
      processLifecycle,
      verdictTampering,
      integrityTampering
    };
  }
  const aliases = collectRuntimeAliases(ast);
  const recordCapabilityMutation = (taints, start) => {
    if (taints.has('Array.prototype.every')) {
      verdictTampering.push(`Array.prototype.every@${start}`);
    }
    if (taints.has('Array.prototype.includes')) {
      integrityTampering.dispatch.push(`Array.prototype.includes@${start}`);
    }
    if (taints.has('crypto.createHash')) {
      integrityTampering.crypto.push(`crypto.createHash@${start}`);
    }
    if (taints.has('dns.resolve4') || taints.has('dns.resolve6')) {
      integrityTampering.dns.push(`dns-resolver@${start}`);
    }
    if (taints.has('Promise.allSettled')) {
      integrityTampering.promise.push(`Promise.allSettled@${start}`);
    }
    if (taints.has('tls.connect')) {
      integrityTampering.tls.push(`tls.connect@${start}`);
    }
    if (taints.has('Math.max')) {
      integrityTampering.math.push(`Math.max@${start}`);
    }
  };
  const inspectPropertyMutation = (object, key, start) => {
    const propertyName = staticStringValue(key);
    if (propertyName === null) return;
    if (object.type === 'Identifier' && object.name === 'report' &&
        ['ok', 'checks'].includes(propertyName)) {
      verdictTampering.push(`report-property@${start}`);
    }
    const syntheticMember = {
      type: 'MemberExpression',
      computed: false,
      object,
      property: { type: 'Identifier', name: propertyName }
    };
    recordCapabilityMutation(runtimeReferenceTaints(syntheticMember, aliases), start);
  };

  walkTargetAst(ast, (node) => {
    if (node.type === 'ImportExpression') {
      dynamicCode.push(`dynamic-import@${node.start}`);
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee;
      const calleePath = memberExpressionPath(callee);
      const property = memberPropertyName(callee);
      const calleeTaints = runtimeReferenceTaints(callee, aliases);
      if (calleeTaints.has('dynamic-eval') || calleeTaints.has('dynamic-Function')) {
        dynamicCode.push(`dynamic-callee@${node.start}`);
      }
      if (property === 'eval' || property === 'Function' || property === 'constructor') {
        dynamicCode.push(`computed-${property}@${node.start}`);
      }
      if (calleeTaints.has('process-exit')) {
        processExit.push(`process.exit@${node.start}`);
      }
      if (calleeTaints.has('reflect-apply') && node.arguments.length > 0) {
        const appliedTaints = runtimeReferenceTaints(node.arguments[0], aliases);
        if (appliedTaints.has('dynamic-eval') ||
            appliedTaints.has('dynamic-Function')) {
          dynamicCode.push(`Reflect.apply-dynamic@${node.start}`);
        }
        if (appliedTaints.has('process-exit')) {
          processExit.push(`Reflect.apply-process.exit@${node.start}`);
        }
        if (appliedTaints.has('process-listener')) {
          processLifecycle.push(`Reflect.apply-process-listener@${node.start}`);
        }
        recordCapabilityMutation(appliedTaints, node.start);
      }
      if (calleeTaints.has('process-listener') && node.arguments.length > 0 &&
          ['beforeExit', 'exit'].includes(staticStringValue(node.arguments[0]))) {
        processLifecycle.push(`process-${staticStringValue(node.arguments[0])}@${node.start}`);
      }
      if (callee && callee.type === 'Identifier' && callee.name === 'require' &&
          node.arguments.length > 0 &&
          ['vm', 'node:vm'].includes(staticStringValue(node.arguments[0]))) {
        dynamicCode.push(`require-vm@${node.start}`);
      }
      if (property && [
        'runInThisContext', 'runInContext', 'runInNewContext', 'compileFunction'
      ].includes(property)) {
        dynamicCode.push(`vm-${property}@${node.start}`);
      }
      if ((calleeTaints.has('define-property') || calleeTaints.has('reflect-set')) &&
          node.arguments.length >= 2) {
        inspectPropertyMutation(node.arguments[0], node.arguments[1], node.start);
      }
      if (calleePath && ['Object.defineProperty', 'Reflect.defineProperty'].includes(
        calleePath.join('.')
      ) && node.arguments.length >= 2 &&
          node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'report' &&
          ['ok', 'checks'].includes(staticStringValue(node.arguments[1]))) {
        verdictTampering.push(`report-accessor@${node.start}`);
      }
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const left = node.type === 'AssignmentExpression' ? node.left : node.argument;
      recordCapabilityMutation(runtimeReferenceTaints(left, aliases), node.start);
    }
  });
  const unique = (values) => [...new Set(values)];
  return {
    dynamicCode: unique(dynamicCode),
    processExit: unique(processExit),
    processLifecycle: unique(processLifecycle),
    verdictTampering: unique(verdictTampering),
    integrityTampering: Object.fromEntries(
      Object.entries(integrityTampering).map(([name, values]) => [name, unique(values)])
    )
  };
}

function auditTurnCriticalControlFlow(ast) {
  const run = functionControlFlowFacts(ast, 'run');
  const probeBrowser = functionControlFlowFacts(ast, 'probeBrowserTurn');
  const summarize = functionControlFlowFacts(ast, 'summarizeTurnBrowserProbe');
  const socket = functionControlFlowFacts(ast, 'probeTurnSocketAddress');
  const selected = functionControlFlowFacts(ast, 'probeSelectedTurnEndpoint');
  const resolver = functionControlFlowFacts(ast, 'resolveTurnEndpointAddresses');
  const runScenarioAssignments = run.assignments.filter((assignment) => {
    const pathParts = memberExpressionPath(assignment.left);
    return pathParts && pathParts.join('.') === 'config.scenario';
  });
  const runLivenessHazards = [];
  if (run.functionNode) {
    walkFunctionControlFlow(run.functionNode, (node) => {
      if (node.type === 'AwaitExpression' && node.argument &&
          node.argument.type === 'NewExpression' &&
          node.argument.callee.type === 'Identifier' &&
          node.argument.callee.name === 'Promise') {
        runLivenessHazards.push(`await-new-Promise@${node.start}`);
      }
      if ((node.type === 'WhileStatement' || node.type === 'DoWhileStatement') &&
          node.test && node.test.type === 'Literal' && node.test.value === true) {
        runLivenessHazards.push(`infinite-${node.type}@${node.start}`);
      }
      if (node.type === 'ForStatement' &&
          (!node.test || (node.test.type === 'Literal' && node.test.value === true))) {
        runLivenessHazards.push(`infinite-ForStatement@${node.start}`);
      }
    });
  }
  const reportWriteCalls = run.calls.filter((call) =>
    (memberExpressionPath(call.callee) || []).join('.') === 'fs.writeFileSync'
  );
  const recoveryCalls = run.calls.filter((call) =>
    call.callee.type === 'Identifier' && call.callee.name === 'runRecoveryScenario'
  );
  const exitCodeAssignments = run.assignments.filter((assignment) =>
    (memberExpressionPath(assignment.left) || []).join('.') === 'process.exitCode'
  );
  const runTerminalEvidence = reportWriteCalls.length === 1 &&
    recoveryCalls.length === 1 && exitCodeAssignments.length === 2 &&
    reportWriteCalls[0].start > recoveryCalls[0].start &&
    exitCodeAssignments.every((assignment) => assignment.start > reportWriteCalls[0].start);
  const attemptDeclarations = [];
  if (ast) {
    for (const statement of ast.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) {
        if (declaration.id.type === 'Identifier' &&
            declaration.id.name === 'TURN_ENDPOINT_PROBE_ATTEMPTS') {
          attemptDeclarations.push(declaration);
        }
      }
    }
  }
  const attemptValue = attemptDeclarations.length === 1 &&
      attemptDeclarations[0].init && attemptDeclarations[0].init.type === 'Literal'
    ? attemptDeclarations[0].init.value
    : null;
  const probeBrowserReturn = probeBrowser.returns[0];
  const summarizeReturn = summarize.returns[0];
  const socketReturn = socket.returns[0];
  const selectedReturn = selected.returns[0];
  const resolverFinalReturn = resolver.returns.length > 0
    ? resolver.returns[resolver.returns.length - 1]
    : null;
  const resolverAddressesProperty = resolverFinalReturn &&
    resolverFinalReturn.argument.properties.find((property) =>
      property.type === 'Property' &&
      ((property.key.type === 'Identifier' && property.key.name === 'addresses') ||
        staticStringValue(property.key) === 'addresses')
    );
  const resolverAddressesDeclarations = resolver.declarations.filter((declaration) =>
    declaration.id.type === 'Identifier' && declaration.id.name === 'addresses'
  );

  return {
    run: {
      ok: !!run.functionNode && run.returns.length === 0 &&
        runScenarioAssignments.length === 0 && runLivenessHazards.length === 0,
      returns: run.returns.length,
      scenarioAssignments: runScenarioAssignments.length,
      livenessHazards: runLivenessHazards,
      terminalEvidence: runTerminalEvidence
    },
    endpointLeaves: {
      ok: !!probeBrowser.functionNode && probeBrowser.returns.length === 1 &&
        !!probeBrowserReturn.argument && probeBrowserReturn.argument.type === 'CallExpression' &&
        (memberExpressionPath(probeBrowserReturn.argument.callee) || []).join('.') ===
          'page.evaluate' &&
        !!summarize.functionNode && summarize.returns.length === 1 &&
        !!summarizeReturn.argument && summarizeReturn.argument.type === 'ObjectExpression' &&
        !!socket.functionNode && socket.returns.length === 1 &&
        !!socketReturn.argument && socketReturn.argument.type === 'NewExpression' &&
        socketReturn.argument.callee.type === 'Identifier' &&
        socketReturn.argument.callee.name === 'Promise' &&
        !!selected.functionNode && selected.returns.length === 1 &&
        !!selectedReturn.argument && selectedReturn.argument.type === 'ObjectExpression' &&
        attemptDeclarations.length === 1 && attemptValue === 2,
      detail: `browserReturns=${probeBrowser.returns.length} ` +
        `summarizeReturns=${summarize.returns.length} socketReturns=${socket.returns.length} ` +
        `selectedReturns=${selected.returns.length} attemptDeclarations=${attemptDeclarations.length} ` +
        `attemptValue=${String(attemptValue)}`
    },
    resolver: {
      ok: !!resolver.functionNode && !!resolverFinalReturn &&
        resolverAddressesDeclarations.length === 1 &&
        !!resolverAddressesDeclarations[0].init &&
        resolverAddressesDeclarations[0].init.type === 'ArrayExpression' &&
        !!resolverAddressesProperty &&
        resolverAddressesProperty.value.type === 'Identifier' &&
        resolverAddressesProperty.value.name === 'addresses',
      detail: `returns=${resolver.returns.length} declarations=${resolverAddressesDeclarations.length} ` +
        `initializer=${resolverAddressesDeclarations[0] && resolverAddressesDeclarations[0].init
          ? resolverAddressesDeclarations[0].init.type
          : 'missing'} finalAddresses=` +
        `${resolverAddressesProperty ? resolverAddressesProperty.value.type : 'missing'}`
    }
  };
}

function activeJavaScriptTokens(source) {
  if (source === activeTokenCacheSource && activeTokenCacheTokens) {
    return activeTokenCacheTokens;
  }
  const tokens = [];
  const identifierStart = /[A-Za-z_$]/;
  const identifierPart = /[A-Za-z0-9_$]/;
  const punctuators = [
    '>>>=', '**=', '&&=', '||=', '??=', '===', '!==', '>>>', '<<=', '>>=',
    '=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '?.',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '...'
  ];
  const expressionPrefixKeywords = new Set([
    'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'return',
    'throw', 'typeof', 'void', 'yield'
  ]);
  const expressionPrefixPunctuators = new Set([
    '(', '[', '{', ',', ';', ':', '?', '=', '==', '===', '!=', '!==', '!',
    '~', '+', '-', '*', '%', '&', '|', '^', '&&', '||', '??', '=>', '+=',
    '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&=', '||=', '??='
  ]);
  let index = 0;
  let canStartRegularExpression = true;

  const push = (value, start, type = 'punctuator') => {
    tokens.push({ value, start, type });
    canStartRegularExpression = type === 'identifier'
      ? expressionPrefixKeywords.has(value)
      : expressionPrefixPunctuators.has(value);
  };
  const skipQuoted = (quote) => {
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        break;
      }
    }
    canStartRegularExpression = false;
  };
  const skipRegularExpression = () => {
    index += 1;
    let escaped = false;
    let inCharacterClass = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '[') {
        inCharacterClass = true;
      } else if (character === ']' && inCharacterClass) {
        inCharacterClass = false;
      } else if (character === '/' && !inCharacterClass) {
        while (index < source.length && /[A-Za-z]/.test(source[index])) {
          index += 1;
        }
        break;
      }
    }
    canStartRegularExpression = false;
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1] || '';
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length &&
          !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      skipQuoted(character);
      continue;
    }
    if (character === '/' && canStartRegularExpression) {
      skipRegularExpression();
      continue;
    }
    if (identifierStart.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && identifierPart.test(source[index])) index += 1;
      push(source.slice(start, index), start, 'identifier');
      continue;
    }
    if (/\d/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
      push(source.slice(start, index), start, 'number');
      canStartRegularExpression = false;
      continue;
    }
    const punctuator = punctuators.find((candidate) =>
      source.startsWith(candidate, index)
    ) || character;
    push(punctuator, index);
    index += punctuator.length;
  }
  activeTokenCacheSource = source;
  activeTokenCacheTokens = tokens;
  return tokens;
}

function topLevelFunctionDeclarationPositions(source) {
  if (source === activeDeclarationCacheSource && activeDeclarationCache) {
    return activeDeclarationCache;
  }
  const parsed = parseTargetJavaScript(source);
  const declarations = new Map();
  for (const [name, nodes] of astTopLevelFunctionMap(parsed.ast)) {
    declarations.set(name, nodes.map((node) => node.id.start));
  }
  activeDeclarationCacheSource = source;
  activeDeclarationCache = declarations;
  return declarations;
}

function braceDepthAtSourceOffset(source, offset) {
  let depth = 0;
  for (const token of activeJavaScriptTokens(source)) {
    if (token.start >= offset) break;
    if (token.value === '{') {
      depth += 1;
    } else if (token.value === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function auditLoadBearingFunctionBindings(source) {
  const required = new Set(expectedTopLevelFunctionBindings);
  const declarations = Object.fromEntries(
    expectedTopLevelFunctionBindings.map((name) => [name, []])
  );
  const reassignments = Object.fromEntries(
    expectedTopLevelFunctionBindings.map((name) => [name, []])
  );
  const parsed = parseTargetJavaScript(source);
  const activeDeclarationNodes = astTopLevelFunctionMap(parsed.ast);
  const activeDeclarations = topLevelFunctionDeclarationPositions(source);

  for (const name of expectedTopLevelFunctionBindings) {
    declarations[name] = [...(activeDeclarations.get(name) || [])];
  }

  if (parsed.ok) {
    walkTargetAst(parsed.ast, (node, parent) => {
      let assignedNames = [];
      if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
        assignedNames = assignedPatternIdentifiers(
          node.type === 'UpdateExpression' ? node.argument : node.left
        );
      } else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        assignedNames = assignedPatternIdentifiers(node.left);
      } else if (node.type === 'VariableDeclarator' &&
          parent && parent.type === 'VariableDeclaration') {
        assignedNames = assignedPatternIdentifiers(node.id);
      }
      for (const name of assignedNames) {
        if (required.has(name)) reassignments[name].push(node.start);
      }
    });
  }

  for (const name of expectedTopLevelFunctionBindings) {
    reassignments[name] = [...new Set(reassignments[name])];
  }

  const missing = expectedTopLevelFunctionBindings.filter(
    (name) => declarations[name].length === 0
  );
  const duplicates = expectedTopLevelFunctionBindings.filter(
    (name) => declarations[name].length > 1
  );
  const reassigned = expectedTopLevelFunctionBindings.filter(
    (name) => reassignments[name].length > 0
  );
  const unexpected = [...activeDeclarationNodes.keys()].filter(
    (name) => !required.has(name)
  ).sort();
  const validNames = new Set(expectedTopLevelFunctionBindings.filter(
    (name) => declarations[name].length === 1 && reassignments[name].length === 0
  ));
  return {
    ok: parsed.ok && missing.length === 0 && duplicates.length === 0 &&
      reassigned.length === 0 && unexpected.length === 0,
    missing,
    duplicates,
    reassigned,
    unexpected,
    declarations,
    reassignments,
    validNames,
    detail: `parser=${parsed.ok ? 'acorn' : parsed.error} ` +
      `required=${expectedTopLevelFunctionBindings.length} ` +
      `missing=${missing.join(',') || 'none'} ` +
      `duplicates=${duplicates.map((name) => `${name}:${declarations[name].length}`).join(',') || 'none'} ` +
      `reassigned=${reassigned.join(',') || 'none'} ` +
      `unexpected=${unexpected.join(',') || 'none'}`
  };
}

function exactGitObjectIdContractIsSound() {
  const exactGitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  return exactGitObjectId.test('a'.repeat(40)) &&
    exactGitObjectId.test('b'.repeat(64)) &&
    !exactGitObjectId.test('c'.repeat(39)) &&
    !exactGitObjectId.test('d'.repeat(41)) &&
    !exactGitObjectId.test('e'.repeat(63)) &&
    !exactGitObjectId.test('A'.repeat(40));
}

function exercisePackagedArtifactValidatorContract(source) {
  const bindingAudit = auditLoadBearingFunctionBindings(source);
  const extractedBindingNames = [
    'parseArgs',
    'sha256Buffer',
    'comparableRealPath',
    'validatePackagedPublisherArtifact'
  ];
  const invalidExtractedBindings = extractedBindingNames.filter(
    (name) => !bindingAudit.validNames.has(name)
  );
  if (invalidExtractedBindings.length > 0) {
    return {
      ok: false,
      detail: 'refused to execute a first-match body because runtime binding is not proven ' +
        `unique/immutable: ${invalidExtractedBindings.join(',')}`
    };
  }
  const parseArgsBody = functionBody(source, 'parseArgs');
  const sha256BufferBody = functionBody(source, 'sha256Buffer');
  const comparableRealPathBody = functionBody(source, 'comparableRealPath');
  const validatorBody = functionBody(source, 'validatePackagedPublisherArtifact');
  const snapshotAlgorithm =
    'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2';
  const cases = [];
  let temporaryDirectory = '';

  const record = (name, expected, operation) => {
    let rejected = false;
    let error = '';
    try {
      operation();
    } catch (caught) {
      rejected = true;
      error = String(caught && caught.message ? caught.message : caught);
    }
    const ok = expected === 'reject' ? rejected : !rejected;
    cases.push({ name, expected, ok, error });
  };

  try {
    if (!parseArgsBody || !sha256BufferBody || !comparableRealPathBody || !validatorBody) {
      throw new Error('could not extract parseArgs and packaged-artifact validator dependencies');
    }

    const extractedSha256Buffer = Function(
      'crypto',
      `'use strict'; return function sha256Buffer(value) {${sha256BufferBody}};`
    )(crypto);
    const extractedComparableRealPath = Function(
      'fs',
      'process',
      `'use strict'; return function comparableRealPath(filePath) {${comparableRealPathBody}};`
    )(fs, process);
    const extractedParseArgs = Function(
      'path',
      '__dirname',
      `'use strict'; return function parseArgs(argv) {${parseArgsBody}};`
    )(path, path.dirname(targetPath));
    const extractedValidator = Function(
      'fs',
      'path',
      'RELEASE_ARTIFACT_MANIFEST_FILENAME',
      'RELEASE_ARTIFACT_MANIFEST_SCHEMA',
      'RELEASE_SOURCE_SNAPSHOT_ALGORITHM',
      'sha256Buffer',
      'comparableRealPath',
      `'use strict'; return function validatePackagedPublisherArtifact(config) {${validatorBody}};`
    )(
      fs,
      path,
      'release-artifact-manifest.json',
      'game-capture-release-artifact/v1',
      snapshotAlgorithm,
      extractedSha256Buffer,
      extractedComparableRealPath
    );

    const temporaryRoot = fs.realpathSync(os.tmpdir());
    temporaryDirectory = fs.mkdtempSync(
      path.join(temporaryRoot, 'game-capture-artifact-validator-')
    );
    const executablePath = path.join(temporaryDirectory, 'game-capture.exe');
    const spoutSenderPath = path.join(temporaryDirectory, 'spout_test_sender.exe');
    const manifestPath = path.join(temporaryDirectory, 'release-artifact-manifest.json');
    const executableBytes = Buffer.from(
      'deterministic packaged publisher validator fixture\n',
      'utf8'
    );
    fs.writeFileSync(executablePath, executableBytes);
    const spoutSenderBytes = Buffer.from('deterministic Spout sender fixture\n', 'utf8');
    fs.writeFileSync(spoutSenderPath, spoutSenderBytes);

    const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const baseManifest = () => ({
      schema: 'game-capture-release-artifact/v1',
      version: '1.2.3',
      packagedAtUtc: '2026-08-09T00:00:00Z',
      artifact: {
        relativePath: 'game-capture.exe',
        size: executableBytes.length,
        sha256: sha256(executableBytes)
      },
      build: { configuration: 'Release' },
      source: {
        gitCommit: 'a'.repeat(40),
        dirty: false,
        snapshotSha256: 'b'.repeat(64),
        snapshotFileCount: 1,
        snapshotAlgorithm
      }
    });
    const materialize = (manifest, publisherPath = executablePath) => {
      const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      fs.writeFileSync(manifestPath, manifestBytes);
      return {
        publisherPath,
        artifactManifestPath: manifestPath,
        artifactManifestSha256: sha256(manifestBytes)
      };
    };
    const mutateManifest = (mutator) => {
      const manifest = baseManifest();
      mutator(manifest);
      return manifest;
    };

    const validManifestBytes = Buffer.from(JSON.stringify(baseManifest()), 'utf8');
    const validManifestHash = sha256(validManifestBytes);
    const validSpoutSenderHash = sha256(spoutSenderBytes);
    const validArgv = [
      'node',
      'signaling-regressions-e2e.js',
      `--publisher-path=${executablePath}`,
      `--artifact-manifest-path=${manifestPath}`,
      `--artifact-manifest-sha256=${validManifestHash}`,
      `--spout-sender-path=${spoutSenderPath}`,
      `--expected-spout-sender-sha256=${validSpoutSenderHash}`,
      '--scenario=relay'
    ];
    record('parse-explicit-artifact-triplet', 'pass', () => {
      const parsed = extractedParseArgs(validArgv);
      if (parsed.publisherPath !== path.resolve(executablePath) ||
          parsed.artifactManifestPath !== path.resolve(manifestPath) ||
          parsed.artifactManifestSha256 !== validManifestHash ||
          parsed.spoutSenderPath !== path.resolve(spoutSenderPath) ||
          parsed.expectedSpoutSenderSha256 !== validSpoutSenderHash) {
        throw new Error('parseArgs did not preserve the explicit artifact and Spout identities');
      }
    });
    record('parse-windows-powershell-split-artifact-triplet', 'pass', () => {
      const parsed = extractedParseArgs([
        'node',
        'signaling-regressions-e2e.js',
        '--publisher-path',
        executablePath,
        '--artifact-manifest-path',
        manifestPath,
        '--artifact-manifest-sha256',
        validManifestHash,
        '--spout-sender-path',
        spoutSenderPath,
        '--expected-spout-sender-sha256',
        validSpoutSenderHash,
        '--scenario=relay'
      ]);
      if (parsed.publisherPath !== path.resolve(executablePath) ||
          parsed.artifactManifestPath !== path.resolve(manifestPath) ||
          parsed.artifactManifestSha256 !== validManifestHash ||
          parsed.spoutSenderPath !== path.resolve(spoutSenderPath) ||
          parsed.expectedSpoutSenderSha256 !== validSpoutSenderHash) {
        throw new Error(
          'parseArgs did not preserve the Windows PowerShell .cmd artifact and Spout identities'
        );
      }
    });
    record('parse-missing-publisher', 'reject', () => {
      extractedParseArgs(validArgv.filter((arg) => !arg.startsWith('--publisher-path=')));
    });
    record('parse-duplicate-publisher', 'reject', () => {
      extractedParseArgs([...validArgv, `--publisher-path=${executablePath}`]);
    });
    record('parse-uppercase-manifest-hash', 'reject', () => {
      extractedParseArgs(validArgv.map((arg) => arg.startsWith('--artifact-manifest-sha256=')
        ? `--artifact-manifest-sha256=${validManifestHash.toUpperCase()}`
        : arg));
    });

    record('valid-40-character-git-object-id', 'pass', () => {
      extractedValidator(materialize(baseManifest()));
    });
    record('valid-64-character-git-object-id', 'pass', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.gitCommit = 'c'.repeat(64);
      })));
    });
    record('reject-41-character-git-object-id', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.gitCommit = 'd'.repeat(41);
      })));
    });
    record('reject-null-git-object-id', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.gitCommit = null;
      })));
    });
    record('reject-non-release-build', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.build.configuration = 'Debug';
      })));
    });
    record('reject-null-dirty-provenance', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.dirty = null;
      })));
    });
    record('reject-null-snapshot-hash', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.snapshotSha256 = null;
      })));
    });
    record('reject-zero-snapshot-file-count', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.snapshotFileCount = 0;
      })));
    });
    record('reject-snapshot-algorithm-drift', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.source.snapshotAlgorithm = 'mtime-tree/v0';
      })));
    });
    record('reject-unpinned-manifest-bytes', 'reject', () => {
      const config = materialize(baseManifest());
      config.artifactManifestSha256 = '0'.repeat(64);
      extractedValidator(config);
    });
    record('reject-manifest-artifact-size-drift', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.artifact.size += 1;
      })));
    });
    record('reject-manifest-artifact-hash-drift', 'reject', () => {
      extractedValidator(materialize(mutateManifest((manifest) => {
        manifest.artifact.sha256 = '0'.repeat(64);
      })));
    });
    record('reject-executable-content-drift', 'reject', () => {
      const config = materialize(baseManifest());
      fs.appendFileSync(executablePath, Buffer.from('tamper', 'utf8'));
      try {
        extractedValidator(config);
      } finally {
        fs.writeFileSync(executablePath, executableBytes);
      }
    });
    record('reject-different-explicit-executable', 'reject', () => {
      const otherDirectory = path.join(temporaryDirectory, 'other');
      fs.mkdirSync(otherDirectory);
      const otherExecutable = path.join(otherDirectory, 'game-capture.exe');
      fs.writeFileSync(otherExecutable, executableBytes);
      extractedValidator(materialize(baseManifest(), otherExecutable));
    });
    record('ignore-executable-mtime', 'pass', () => {
      const config = materialize(baseManifest());
      fs.utimesSync(executablePath, new Date(1000), new Date(1000));
      extractedValidator(config);
    });
  } catch (error) {
    cases.push({
      name: 'contract-construction',
      expected: 'pass',
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  } finally {
    if (temporaryDirectory) {
      const temporaryRoot = fs.realpathSync(os.tmpdir());
      const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
      if (path.dirname(resolvedTemporaryDirectory) === temporaryRoot &&
          path.basename(resolvedTemporaryDirectory).startsWith('game-capture-artifact-validator-')) {
        fs.rmSync(resolvedTemporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  const failedCases = cases.filter((entry) => !entry.ok);
  return {
    ok: cases.length === 20 && failedCases.length === 0,
    detail: `unique runtime-equivalent extracted parseArgs/validator cases=${cases.length} ` +
      `passed=${cases.length - failedCases.length} failed=` +
      (failedCases.map((entry) => entry.name).join(',') || 'none')
  };
}

async function exerciseTurnLeafOperationContracts(source) {
  const addressCoverageCaseName =
    'selected-udp-endpoint-attempts-every-target-exactly-twice';
  const bindingAudit = auditLoadBearingFunctionBindings(source);
  const requiredBindings = [
    'probeBrowserTurn',
    'summarizeTurnBrowserProbe',
    'probeTurnSocketAddress',
    'probeSelectedTurnEndpoint',
    'resolveTurnEndpointAddresses'
  ];
  const invalidBindings = requiredBindings.filter(
    (name) => !bindingAudit.validNames.has(name)
  );
  if (invalidBindings.length > 0) {
    return {
      ok: false,
      detail: 'refused leaf execution because bindings are not unique/immutable: ' +
        invalidBindings.join(',')
    };
  }
  const parsed = parseTargetJavaScript(source);
  if (!parsed.ok) return { ok: false, detail: `leaf parser failed: ${parsed.error}` };
  const compile = (name, dependencies) => {
    const declaration = sourceForTopLevelFunction(source, parsed.ast, name);
    if (!declaration) throw new Error(`missing unique ${name} declaration`);
    const names = Object.keys(dependencies);
    return Function(
      ...names,
      `'use strict'; ${declaration}; return ${name};`
    )(...names.map((dependencyName) => dependencies[dependencyName]));
  };
  const cases = [];
  const record = async (name, operation) => {
    let timeout = null;
    try {
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`TURN leaf watchdog expired for ${name}`)),
          1500
        );
      });
      const detail = await Promise.race([Promise.resolve().then(operation), deadline]);
      cases.push({
        name,
        ok: true,
        error: '',
        detail: typeof detail === 'string' ? detail : ''
      });
    } catch (error) {
      cases.push({
        name,
        ok: false,
        error: String(error && error.message ? error.message : error),
        detail: ''
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const runtimeNonce = crypto.randomBytes(10).toString('hex');
  const runtimeHostname = `relay-${runtimeNonce}.example.net`;

  try {
    const summarize = compile('summarizeTurnBrowserProbe', {});
    const browserCalls = [];
    const probeBrowser = compile('probeBrowserTurn', {});
    class BrowserLikePage {
      url() { return `https://viewer-${runtimeNonce}.example.net/`; }
      context() { return { browser: () => ({}) }; }
      evaluate(callback, argument) {
        browserCalls.push({ callback, argument });
        return Promise.resolve(this.marker);
      }
    }
    await record('browser-probe-delegates-to-page-evaluate', async () => {
      const marker = { candidates: [], errors: ['marker'] };
      const rtcConfig = { iceServers: [{ urls: 'turn:example.test:3478' }] };
      const page = new BrowserLikePage();
      page.marker = marker;
      const result = await probeBrowser(page, rtcConfig);
      assert(result === marker, 'probeBrowserTurn did not return the page result');
      assert(browserCalls.length === 1, 'probeBrowserTurn did not evaluate exactly once');
      assert(typeof browserCalls[0].callback === 'function', 'browser callback missing');
      assert(browserCalls[0].argument === rtcConfig, 'RTC config identity changed');
    });
    await record('browser-probe-summary-is-observation-derived', async () => {
      const summary = summarize({
        candidates: [
          { candidate: 'candidate:1 1 udp 1 192.0.2.1 3478 typ host' },
          { candidate: 'candidate:2 1 udp 1 192.0.2.2 3478 typ relay' }
        ],
        errors: ['observed-error']
      });
      assert(summary.ok === true && summary.relayCandidateCount === 1,
        'relay result was not derived from candidates');
      assert(JSON.stringify(summary.candidateTypes) === JSON.stringify(['host', 'relay']),
        'candidate types were not derived exactly');
      assert(summary.errors[0] === 'observed-error', 'browser errors were not preserved');
      const negative = summarize({ candidates: [], errors: [] });
      assert(negative.ok === false && negative.relayCandidateCount === 0,
        'empty browser observation did not fail');
    });

    class FakeSocket {
      constructor(successEvent) {
        this.handlers = new Map();
        this.authorized = true;
        this.authorizationError = '';
        this.destroyed = false;
        queueMicrotask(() => this.emit(successEvent));
      }
      once(name, callback) {
        this.handlers.set(name, callback);
        return this;
      }
      setTimeout(_timeout, callback) {
        this.timeoutCallback = callback;
        return this;
      }
      destroy() {
        this.destroyed = true;
      }
      emit(name, value) {
        const callback = this.handlers.get(name);
        if (callback) callback(value);
      }
      getProtocol() {
        return 'TLSv1.3';
      }
      getPeerCertificate() {
        return { subject: { CN: 'turn.example.test' } };
      }
    }
    const tcpCalls = [];
    const tlsCalls = [];
    const socketProbe = compile('probeTurnSocketAddress', {
      net: {
        connect(options) {
          tcpCalls.push(options);
          return new FakeSocket('connect');
        }
      },
      tls: {
        connect(options) {
          tlsCalls.push(options);
          return new FakeSocket('secureConnect');
        }
      }
    });
    await record('socket-probe-performs-tcp-and-tls-connects', async () => {
      const tcp = await socketProbe(
        { scheme: 'turn', hostname: runtimeHostname, port: 3478 },
        '192.0.2.10'
      );
      const tlsResult = await socketProbe(
        { scheme: 'turns', hostname: runtimeHostname, port: 443 },
        '2001:db8::10'
      );
      assert(tcp.ok && tlsResult.ok, 'socket success observations were discarded');
      assert(tcpCalls.length === 1 && tcpCalls[0].host === '192.0.2.10' &&
        tcpCalls[0].port === 3478, 'TCP connect did not receive the address and port');
      assert(tlsCalls.length === 1 && tlsCalls[0].host === '2001:db8::10' &&
        tlsCalls[0].servername === runtimeHostname &&
        tlsCalls[0].rejectUnauthorized === true,
      'TLS connect did not preserve address, SNI, and certificate validation');
    });

    const selectedBrowserCalls = [];
    const selectedSocketCalls = [];
    const selectedProbe = compile('probeSelectedTurnEndpoint', {
      TURN_ENDPOINT_PROBE_ATTEMPTS: 2,
      browserTurnServer: (server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential
      }),
      probeBrowserTurn: async (_page, rtcConfig) => {
        selectedBrowserCalls.push(rtcConfig);
        return {
          candidates: [{ candidate: 'candidate:relay 1 udp 1 192.0.2.1 1 typ relay' }],
          errors: []
        };
      },
      summarizeTurnBrowserProbe: summarize,
      turnUrlForAddress: (parsedUrl, address) =>
        `${parsedUrl.scheme}:${address}:${parsedUrl.port}`,
      probeTurnSocketAddress: async (parsedUrl, address) => {
        selectedSocketCalls.push({ parsedUrl, address });
        return { ok: true, error: '' };
      }
    });
    await record(addressCoverageCaseName, async () => {
      const resolvedAddressCounts = [1, 2, 3, 5, 6, 7, 11, 12, 17];
      const exactVisits = [];
      for (const resolvedAddressCount of resolvedAddressCounts) {
        selectedBrowserCalls.length = 0;
        selectedSocketCalls.length = 0;
        const resolvedAddresses = Array.from(
          { length: resolvedAddressCount },
          (_, addressIndex) => `192.0.2.${20 + addressIndex}`
        );
        const endpoint = {
          urls: 'turn:turn.example.test:3478',
          username: 'user',
          credential: 'credential',
          locale: 'test',
          udp: true,
          addresses: resolvedAddresses,
          dnsErrors: [],
          parsed: { scheme: 'turn', hostname: 'turn.example.test', port: 3478 }
        };
        const result = await selectedProbe({}, endpoint);
        const expectedAddressAttempts = resolvedAddresses.flatMap((address) =>
          Array.from({ length: 2 }, (_, attemptIndex) => ({
            address,
            attempt: attemptIndex + 1
          }))
        );
        const observedAddressAttempts = result.addressAttempts.map(({ address, attempt }) => ({
          address,
          attempt
        }));
        const expectedAddressUrls = expectedAddressAttempts.map(({ address }) =>
          `turn:${address}:3478`
        );
        const observedAddressUrls = selectedBrowserCalls.slice(2).map((rtcConfig) =>
          rtcConfig.iceServers[0].urls
        );
        assert(JSON.stringify(observedAddressAttempts) ===
          JSON.stringify(expectedAddressAttempts),
        `UDP exact address/attempt visitation mismatch count=${resolvedAddressCount} ` +
          `expected=${JSON.stringify(expectedAddressAttempts)} ` +
          `observed=${JSON.stringify(observedAddressAttempts)}`);
        assert(JSON.stringify(observedAddressUrls) === JSON.stringify(expectedAddressUrls),
          `UDP allocations did not use every exact resolved address on every attempt ` +
          `count=${resolvedAddressCount}`);
        assert(selectedBrowserCalls.length === 2 + expectedAddressAttempts.length &&
          selectedSocketCalls.length === 0,
        `UDP endpoint did not perform 2 hostname plus ${expectedAddressAttempts.length} ` +
          `address allocations count=${resolvedAddressCount}`);
        assert(result.hostnameAttempts.length === 2 &&
          result.addressAttempts.length === expectedAddressAttempts.length,
        `UDP attempt evidence count was not exact count=${resolvedAddressCount}`);
        assert(result.hostnameAttempts.every((attempt, index) =>
          attempt.ok && attempt.attempt === index + 1),
        `hostname evidence was fabricated count=${resolvedAddressCount}`);
        assert(result.addressAttempts.every((attempt) =>
          attempt.ok && attempt.transport === 'turn-allocation'),
        `UDP address evidence was not allocation-derived count=${resolvedAddressCount}`);
        exactVisits.push(`${resolvedAddressCount}:${expectedAddressAttempts.length}`);
      }
      return `addressCounts=${resolvedAddressCounts.join(',')} attemptsPerAddress=2 ` +
        `exactVisits=${exactVisits.join(',')}`;
    });
    await record('selected-tls-endpoint-attempts-every-target-exactly-twice', async () => {
      selectedBrowserCalls.length = 0;
      selectedSocketCalls.length = 0;
      const endpoint = {
        urls: 'turns:turn.example.test:443',
        username: 'user',
        credential: 'credential',
        locale: 'test',
        udp: false,
        addresses: ['192.0.2.30'],
        dnsErrors: [],
        parsed: { scheme: 'turns', hostname: 'turn.example.test', port: 443 }
      };
      const result = await selectedProbe({}, endpoint);
      assert(selectedBrowserCalls.length === 2 && selectedSocketCalls.length === 2,
        'TLS endpoint did not perform 2 hostname allocations plus 2 address sockets');
      assert(result.hostnameAttempts.length === 2 && result.addressAttempts.length === 2,
        'TLS attempt evidence count was not exact');
      assert(result.addressAttempts.every((attempt) =>
        attempt.ok && attempt.transport === 'tls-with-sni'),
      'TLS address evidence was not socket-derived');
    });

    const failedSelectedProbe = compile('probeSelectedTurnEndpoint', {
      TURN_ENDPOINT_PROBE_ATTEMPTS: 2,
      browserTurnServer: (server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential
      }),
      probeBrowserTurn: async () => ({ candidates: [], errors: ['DEAD_ENDPOINT'] }),
      summarizeTurnBrowserProbe: summarize,
      turnUrlForAddress: (parsedUrl, address) =>
        `${parsedUrl.scheme}:${address}:${parsedUrl.port}`,
      probeTurnSocketAddress: async () => ({ ok: false, error: 'DEAD_ENDPOINT' })
    });
    await record('failed-network-attempts-remain-failed-without-test-markers', async () => {
      const endpoint = {
        urls: `turns:${runtimeHostname}:443`,
        username: `user-${runtimeNonce}`,
        credential: `secret-${runtimeNonce}`,
        udp: false,
        addresses: ['192.0.2.31'],
        dnsErrors: [],
        parsed: { scheme: 'turns', hostname: runtimeHostname, port: 443 }
      };
      const result = await failedSelectedProbe(new BrowserLikePage(), endpoint);
      assert(result.hostnameAttempts.length === 2 &&
        result.hostnameAttempts.every((attempt) => attempt.ok === false),
      'failed hostname attempts were rewritten to success');
      assert(result.addressAttempts.length === 2 &&
        result.addressAttempts.every((attempt) =>
          attempt.ok === false && attempt.error === 'DEAD_ENDPOINT'),
      'failed address attempts were rewritten to success');
    });

    const dnsCalls = [];
    const resolver = compile('resolveTurnEndpointAddresses', {
      parseTurnUrl: () => ({
        scheme: 'turn', hostname: runtimeHostname, port: 3478, suffix: ''
      }),
      net: { isIP: () => 0 },
      dns: {
        resolve4(hostname) {
          dnsCalls.push(`A:${hostname}`);
          return Promise.resolve(['192.0.2.40', '192.0.2.40']);
        },
        resolve6(hostname) {
          dnsCalls.push(`AAAA:${hostname}`);
          return Promise.resolve(['2001:db8::40', '2001:db8::41']);
        }
      }
    });
    await record('resolver-collects-complete-deduplicated-a-and-aaaa', async () => {
      const result = await resolver({ urls: `turn:${runtimeHostname}:3478` });
      assert(JSON.stringify(dnsCalls) === JSON.stringify([
        `A:${runtimeHostname}`, `AAAA:${runtimeHostname}`
      ]), 'resolver did not issue one A and one AAAA lookup');
      assert(JSON.stringify(result.addresses) === JSON.stringify([
        '192.0.2.40', '2001:db8::40', '2001:db8::41'
      ]), 'resolver truncated, reordered, or failed to deduplicate DNS addresses');
      assert(result.dnsErrors.length === 0, 'successful DNS lookup produced errors');
    });

  } catch (error) {
    cases.push({
      name: 'leaf-contract-construction',
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }

  const failedCases = cases.filter((entry) => !entry.ok);
  const addressCoverageCase = cases.find((entry) =>
    entry.name === addressCoverageCaseName);
  const addressCoverageOk = !!addressCoverageCase && addressCoverageCase.ok;
  const networkOperationFailures = cases.filter((entry) =>
    entry.name !== addressCoverageCaseName && !entry.ok);
  const networkOperationsOk = cases.length === 7 && networkOperationFailures.length === 0;
  return {
    ok: cases.length === 7 && failedCases.length === 0,
    networkOperationsOk,
    addressCoverageOk,
    cases,
    detail: `runtime-equivalent TURN leaf cases=${cases.length} ` +
      `passed=${cases.length - failedCases.length} failed=` +
      (failedCases.map((entry) => `${entry.name}:${entry.error}`).join(',') || 'none') +
      ` addressCoverage=${addressCoverageCase
        ? (addressCoverageCase.ok ? addressCoverageCase.detail : addressCoverageCase.error)
        : 'missing'}`
  };
}

async function exerciseBrowserRtcReadinessContract(source, options = {}) {
  const parsed = parseTargetJavaScript(source);
  const bindingAudit = auditLoadBearingFunctionBindings(source);
  if (!parsed.ok || !bindingAudit.validNames.has('ensureBrowserRtcReadiness')) {
    return {
      ok: false,
      cases: [],
      detail: `readiness binding unavailable parser=${parsed.ok} valid=` +
        `${bindingAudit.validNames.has('ensureBrowserRtcReadiness')}`
    };
  }
  const declaration = sourceForTopLevelFunction(
    source,
    parsed.ast,
    'ensureBrowserRtcReadiness'
  );
  const preProbeDeclarations = (parsed.ast.body || [])
    .filter((statement) =>
      statement.type === 'VariableDeclaration' && statement.kind === 'const')
    .flatMap((statement) => statement.declarations || [])
    .filter((entry) => entry.id && entry.id.type === 'Identifier' &&
      entry.id.name === 'BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS' &&
      entry.init && entry.init.type === 'Literal' &&
      typeof entry.init.value === 'number');
  if (preProbeDeclarations.length !== 1) {
    return {
      ok: false,
      cases: [],
      detail: `readiness pre-probe constant count=${preProbeDeclarations.length}`
    };
  }
  const sourcePreProbeSettleMs = preProbeDeclarations[0].init.value;
  const compile = (requirements, evidence, failureSentinel, runtime) => Function(
    'BROWSER_RTC_READINESS_TIMEOUT_MS',
    'BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS',
    'BROWSER_RTC_READINESS_POLL_INTERVAL_MS',
    'BROWSER_RTC_READINESS_PEER_CLOSE_TIMEOUT_MS',
    'BROWSER_RTC_READINESS_CLEANUP_TIMEOUT_MS',
    'BROWSER_RTC_READINESS_DOCUMENT_URL',
    'BROWSER_RTC_READINESS_DOCUMENT_MARKER',
    'wait',
    'Date',
    'setTimeout',
    'clearTimeout',
    'requireHarnessFixture',
    'addEvidence',
    `'use strict'; ${declaration}; return ensureBrowserRtcReadiness;`
  )(
    1100,
    sourcePreProbeSettleMs,
    50,
    50,
    200,
    expectedRtcReadinessDocumentUrl,
    expectedRtcReadinessDocumentMarker,
    runtime.wait,
    runtime.Date,
    runtime.setTimeout,
    runtime.clearTimeout,
    (report, name, ok, state) => {
      requirements.push({ report, name, ok, state });
      if (!ok) throw failureSentinel;
    },
    (report, name, state) => evidence.push({ report, name, state })
  );
  const cases = [];
  const runMode = async (mode, repetitions) => {
    const requirements = [];
    const evidence = [];
    const trackers = {
      contextCount: 0,
      contextCloseAttemptCount: 0,
      contextCloseCount: 0,
      pcCount: 0,
      pcCloseCount: 0,
      createDataChannelCount: 0,
      createOfferCount: 0,
      setLocalDescriptionCount: 0,
      configs: [],
      pcs: [],
      navigatedUrls: [],
      preProbeSettleDelays: [],
      runnerDelays: [],
      evaluateCount: 0,
      registryRequestCount: 0
    };
    let virtualNowMs = 100000;
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    const runtime = {
      Date: { now: () => virtualNowMs },
      async wait(delayMs) {
        trackers.runnerDelays.push(delayMs);
        if (delayMs === expectedRtcReadinessPreProbeSettleMs) {
          trackers.preProbeSettleDelays.push(delayMs);
        }
        virtualNowMs += delayMs;
        await Promise.resolve();
      },
      setTimeout(callback, delayMs) {
        const numericDelayMs = Number(delayMs);
        if (!Number.isFinite(numericDelayMs) || numericDelayMs > 500) {
          const longTimer = realSetTimeout(callback, 10000);
          longTimer.unref();
          return longTimer;
        }
        return realSetTimeout(() => {
          virtualNowMs += Math.max(0, numericDelayMs || 0);
          callback();
        }, Math.min(Math.max(1, numericDelayMs || 0), 2));
      },
      clearTimeout: realClearTimeout
    };
    class FakePeerConnection {
      constructor(config) {
        this.config = JSON.parse(JSON.stringify(config));
        this.iceGatheringState = 'new';
        this.listeners = new Set();
        this.closed = false;
        trackers.pcCount += 1;
        trackers.configs.push(this.config);
        trackers.pcs.push(this);
      }
      addEventListener(name, listener) {
        if (name === 'icegatheringstatechange') this.listeners.add(listener);
      }
      removeEventListener(name, listener) {
        if (name === 'icegatheringstatechange') this.listeners.delete(listener);
      }
      createDataChannel() {
        trackers.createDataChannelCount += 1;
        return {};
      }
      async createOffer() {
        trackers.createOfferCount += 1;
        return { type: 'offer', sdp: 'v=0\\r\\n' };
      }
      async setLocalDescription() {
        trackers.setLocalDescriptionCount += 1;
        if (mode !== 'stuck-new') {
          this.iceGatheringState = 'gathering';
          for (const listener of [...this.listeners]) listener();
        }
      }
      getConfiguration() {
        return this.config;
      }
      close() {
        if (!this.closed) {
          this.closed = true;
          trackers.pcCloseCount += 1;
        }
      }
    }
    const browser = {
      async newContext() {
        trackers.contextCount += 1;
        let closed = false;
        const contextPcs = [];
        return {
          async newPage() {
            const documentElement = {
              getAttribute(name) {
                const marker = mode === 'wrong-marker'
                  ? 'forged-readiness-marker'
                  : expectedRtcReadinessDocumentMarker;
                return name === 'data-game-capture-rtc-readiness' ? marker : null;
              }
            };
            return {
              async goto(url) {
                trackers.navigatedUrls.push(url);
              },
              async evaluate(callback, argument) {
                trackers.evaluateCount += 1;
                if (mode === 'wedged-evaluate-response' && trackers.evaluateCount >= 2) {
                  return new Promise(() => {});
                }
                const prior = globalThis.RTCPeerConnection;
                const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
                const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
                const locationValue = mode === 'wrong-origin'
                  ? {
                      href: 'https://example.invalid/forged-readiness',
                      protocol: 'https:',
                      origin: 'https://example.invalid'
                    }
                  : {
                      href: trackers.navigatedUrls[trackers.navigatedUrls.length - 1],
                      protocol: 'data:',
                      origin: 'null'
                    };
                globalThis.RTCPeerConnection = FakePeerConnection;
                Object.defineProperty(globalThis, 'location', {
                  configurable: true,
                  value: locationValue
                });
                Object.defineProperty(globalThis, 'document', {
                  configurable: true,
                  value: {
                    readyState: 'complete',
                    documentElement
                  }
                });
                let result;
                try {
                  result = callback(argument);
                } finally {
                  if (prior === undefined) delete globalThis.RTCPeerConnection;
                  else globalThis.RTCPeerConnection = prior;
                  if (priorLocation) {
                    Object.defineProperty(globalThis, 'location', priorLocation);
                  } else {
                    delete globalThis.location;
                  }
                  if (priorDocument) {
                    Object.defineProperty(globalThis, 'document', priorDocument);
                  } else {
                    delete globalThis.document;
                  }
                }
                return await result;
              }
            };
          },
          async close() {
            trackers.contextCloseAttemptCount += 1;
            if (mode === 'wedged-context-close') return new Promise(() => {});
            if (!closed) {
              closed = true;
              trackers.contextCloseCount += 1;
              for (const pc of trackers.pcs) pc.close();
            }
          }
        };
      }
    };
    const failureSentinel = new Error(`READINESS_BLOCKED:${mode}`);
    const readiness = compile(requirements, evidence, failureSentinel, runtime);
    const report = { failureSentinel };
    let caught = null;
    let supervisorExpired = false;
    for (let invocation = 0; invocation < repetitions; invocation++) {
      try {
        let supervisor = null;
        const outcome = await Promise.race([
          readiness(browser, report).then(
            () => ({ kind: 'resolved' }),
            (error) => ({ kind: 'rejected', error })
          ),
          new Promise((resolve) => {
            supervisor = setTimeout(
              () => resolve({ kind: 'supervisor-expired' }),
              250
            );
          })
        ]);
        if (supervisor) clearTimeout(supervisor);
        if (outcome.kind === 'supervisor-expired') {
          supervisorExpired = true;
          break;
        }
        if (outcome.kind === 'rejected') throw outcome.error;
      } catch (error) {
        caught = error;
        break;
      }
    }
    return {
      requirements,
      evidence,
      trackers,
      caught,
      failureSentinel,
      supervisorExpired
    };
  };
  if (typeof options.singleMode === 'string') {
    return runMode(options.singleMode, options.repetitions || 1);
  }
  try {
    const hasExpectedDocumentState = (entry) =>
      entry && entry.state && entry.state.documentContext &&
      entry.state.documentContext.protocol === 'data:' &&
      entry.state.documentContext.origin === 'null' &&
      entry.state.documentContext.marker === expectedRtcReadinessDocumentMarker &&
      entry.state.documentContext.readyState === 'complete';
    const hasExpectedPreProbeSettleState = (entry) =>
      entry && entry.state && entry.state.preProbeSettle &&
      entry.state.preProbeSettle.requestedMs ===
        expectedRtcReadinessPreProbeSettleMs &&
      Number.isInteger(entry.state.preProbeSettle.elapsedMs) &&
      entry.state.preProbeSettle.elapsedMs >= expectedRtcReadinessPreProbeSettleMs &&
      entry.state.preProbeSettle.completedBeforePeerCreation === true;
    const hasExactExternalPeerObservation = (entry) => {
      const observation = entry && entry.state && entry.state.runnerObservation;
      return !!observation && observation.peerCreationRequests === 1 &&
        observation.peerCreationConfirmations === 1 &&
        observation.snapshotRequests >= 1 &&
        observation.snapshotResponses >= 0 &&
        observation.snapshotResponses <= observation.snapshotRequests;
    };
    const hasExactSuccessfulCleanup = (entry) => {
      const cleanup = entry && entry.state && entry.state.runnerObservation &&
        entry.state.runnerObservation.cleanup;
      return !!cleanup && cleanup.peerCloseRequests === 1 &&
        cleanup.peerCloseResponses === 1 && cleanup.contextCloseRequests === 1 &&
        cleanup.contextCloseResponses === 1 && cleanup.contextCloseTimeouts === 0;
    };
    const success = await runMode('transition', 2);
    const successOk = !success.caught && success.requirements.length === 2 &&
      success.requirements.every((entry) =>
        entry.name === 'browser-rtc-readiness-before-turn-registry' && entry.ok === true &&
        hasExpectedDocumentState(entry) && hasExpectedPreProbeSettleState(entry) &&
        hasExactExternalPeerObservation(entry) && hasExactSuccessfulCleanup(entry) &&
        entry.state.preProbeTimingValid === true &&
        entry.state.externalObservationValid === true &&
        entry.state.cleanupValid === true &&
        entry.state.reason === 'runner-observed-transition') &&
      success.evidence.length === 2 && success.trackers.contextCount === 2 &&
      success.trackers.contextCloseCount === 2 && success.trackers.pcCount === 2 &&
      success.trackers.pcCloseCount === 2 &&
      new Set(success.trackers.pcs).size === 2 &&
      success.trackers.navigatedUrls.length === 2 &&
      success.trackers.navigatedUrls.every((url) =>
        url === expectedRtcReadinessDocumentUrl) &&
      success.trackers.preProbeSettleDelays.length === 2 &&
      success.trackers.preProbeSettleDelays.every((delayMs) =>
        delayMs === expectedRtcReadinessPreProbeSettleMs) &&
      success.trackers.createDataChannelCount === 2 &&
      success.trackers.createOfferCount === 2 &&
      success.trackers.setLocalDescriptionCount === 2 &&
      success.trackers.configs.every((config) =>
        Array.isArray(config.iceServers) && config.iceServers.length === 0 &&
        config.iceTransportPolicy === 'all');
    cases.push({
      name: 'fresh-neutral-transition-is-required-and-disposed',
      ok: successOk,
      detail: `requirements=${success.requirements.length} evidence=${success.evidence.length} ` +
        `contexts=${success.trackers.contextCount}/${success.trackers.contextCloseCount} ` +
        `pcs=${success.trackers.pcCount}/${success.trackers.pcCloseCount}`
    });

    const stuck = await runMode('stuck-new', 1);
    const stuckOk = stuck.caught === stuck.failureSentinel &&
      stuck.requirements.length === 1 && stuck.requirements[0].ok === false &&
      stuck.requirements[0].name === 'browser-rtc-readiness-before-turn-registry' &&
      hasExpectedDocumentState(stuck.requirements[0]) &&
      hasExpectedPreProbeSettleState(stuck.requirements[0]) &&
      hasExactExternalPeerObservation(stuck.requirements[0]) &&
      hasExactSuccessfulCleanup(stuck.requirements[0]) &&
      stuck.requirements[0].state.reason === 'runner-readiness-deadline' &&
      stuck.requirements[0].state.runnerObservation.operationTimeouts === 0 &&
      stuck.evidence.length === 0 && stuck.trackers.contextCloseCount === 1 &&
      stuck.trackers.pcCloseCount === 1 &&
      JSON.stringify(stuck.trackers.navigatedUrls) ===
        JSON.stringify([expectedRtcReadinessDocumentUrl]) &&
      JSON.stringify(stuck.trackers.preProbeSettleDelays) ===
        JSON.stringify([expectedRtcReadinessPreProbeSettleMs]);
    cases.push({
      name: 'stuck-new-blocks-separately-and-disposes',
      ok: stuckOk,
      detail: `exactRejection=${stuck.caught === stuck.failureSentinel} ` +
        `requirements=${stuck.requirements.length} evidence=${stuck.evidence.length} ` +
        `contextsClosed=${stuck.trackers.contextCloseCount} pcsClosed=` +
        `${stuck.trackers.pcCloseCount} reason=` +
        `${stuck.requirements[0] && stuck.requirements[0].state.reason}`
    });

    for (const mode of ['wrong-marker', 'wrong-origin']) {
      const forged = await runMode(mode, 1);
      const forgedOk = forged.caught === forged.failureSentinel &&
        forged.requirements.length === 1 && forged.requirements[0].ok === false &&
        forged.requirements[0].name === 'browser-rtc-readiness-before-turn-registry' &&
        hasExpectedPreProbeSettleState(forged.requirements[0]) &&
        hasExactExternalPeerObservation(forged.requirements[0]) &&
        hasExactSuccessfulCleanup(forged.requirements[0]) &&
        forged.evidence.length === 0 && forged.trackers.contextCloseCount === 1 &&
        forged.trackers.pcCloseCount === 1 &&
        JSON.stringify(forged.trackers.navigatedUrls) ===
          JSON.stringify([expectedRtcReadinessDocumentUrl]) &&
        JSON.stringify(forged.trackers.preProbeSettleDelays) ===
          JSON.stringify([expectedRtcReadinessPreProbeSettleMs]);
      cases.push({
        name: `${mode}-blocks-despite-rtc-transition`,
        ok: forgedOk,
        detail: `exactRejection=${forged.caught === forged.failureSentinel} ` +
          `requirements=${forged.requirements.length} evidence=${forged.evidence.length} ` +
          `contextsClosed=${forged.trackers.contextCloseCount} pcsClosed=` +
          `${forged.trackers.pcCloseCount}`
      });
    }

    const wedged = await runMode('wedged-evaluate-response', 1);
    const wedgedState = wedged.requirements[0] && wedged.requirements[0].state;
    const wedgedObservation = wedgedState && wedgedState.runnerObservation;
    const wedgedOk = wedged.supervisorExpired === false &&
      wedged.caught === wedged.failureSentinel &&
      wedged.requirements.length === 1 && wedged.requirements[0].ok === false &&
      wedgedState.reason === 'runner-snapshot-deadline' &&
      wedgedObservation.peerCreationRequests === 1 &&
      wedgedObservation.peerCreationConfirmations === 1 &&
      wedgedObservation.snapshotRequests === 1 &&
      wedgedObservation.snapshotResponses === 0 &&
      wedgedObservation.operationTimeouts >= 2 &&
      wedgedObservation.cleanup.contextCloseRequests === 1 &&
      wedgedObservation.cleanup.contextCloseResponses === 1 &&
      wedged.evidence.length === 0 && wedged.trackers.pcCount === 1 &&
      wedged.trackers.contextCount === 1 && wedged.trackers.contextCloseCount === 1 &&
      wedged.trackers.contextCloseAttemptCount === 1;
    cases.push({
      name: 'wedged-page-response-is-bounded-by-runner-and-disposed',
      ok: wedgedOk,
      detail: `supervisorExpired=${wedged.supervisorExpired} ` +
        `exactRejection=${wedged.caught === wedged.failureSentinel} ` +
        `requirements=${wedged.requirements.length} evidence=${wedged.evidence.length} ` +
        `pcs=${wedged.trackers.pcCount} contexts=` +
        `${wedged.trackers.contextCount}/${wedged.trackers.contextCloseCount}`
    });

    const cleanupWedged = await runMode('wedged-context-close', 1);
    const cleanupState = cleanupWedged.requirements[0] &&
      cleanupWedged.requirements[0].state;
    const cleanupObservation = cleanupState && cleanupState.runnerObservation;
    const cleanupWedgedOk = cleanupWedged.supervisorExpired === false &&
      cleanupWedged.caught === cleanupWedged.failureSentinel &&
      cleanupWedged.requirements.length === 1 &&
      cleanupWedged.requirements[0].ok === false &&
      cleanupState.reason === 'runner-cleanup-incomplete' &&
      cleanupState.cleanupValid === false &&
      cleanupObservation.peerCreationRequests === 1 &&
      cleanupObservation.peerCreationConfirmations === 1 &&
      cleanupObservation.snapshotResponses >= 1 &&
      cleanupObservation.cleanup.peerCloseResponses === 1 &&
      cleanupObservation.cleanup.contextCloseRequests === 1 &&
      cleanupObservation.cleanup.contextCloseResponses === 0 &&
      cleanupObservation.cleanup.contextCloseTimeouts === 1 &&
      cleanupWedged.trackers.contextCloseAttemptCount === 1 &&
      cleanupWedged.trackers.contextCloseCount === 0;
    cases.push({
      name: 'wedged-context-cleanup-is-bounded-and-blocking',
      ok: cleanupWedgedOk,
      detail: `supervisorExpired=${cleanupWedged.supervisorExpired} ` +
        `exactRejection=${cleanupWedged.caught === cleanupWedged.failureSentinel} ` +
        `requirements=${cleanupWedged.requirements.length} ` +
        `contextClose=${cleanupWedged.trackers.contextCloseAttemptCount}/` +
        `${cleanupWedged.trackers.contextCloseCount}`
    });
  } catch (error) {
    cases.push({
      name: 'readiness-contract-construction',
      ok: false,
      detail: String(error && error.message ? error.message : error)
    });
  }
  return {
    ok: cases.length === 6 && cases.every((entry) => entry.ok),
    cases,
    detail: `runtime readiness cases=${cases.filter((entry) => entry.ok).length}/` +
      `${cases.length} failures=${cases.filter((entry) => !entry.ok)
        .map((entry) => `${entry.name}:${entry.detail}`).join(',') || 'none'}`
  };
}

async function exerciseBrowserRtcReadinessMutations(greenSource) {
  const readinessPolicyId = 'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH';
  const functionMutation = (name, pattern, replacement) => ({
    name,
    source: mutateFunctionBodyOnce(
      greenSource,
      'ensureBrowserRtcReadiness',
      pattern,
      replacement,
      name
    )
  });
  const mutations = [
    functionMutation(
      'runner-absolute-deadline-removed',
      /const\s+absoluteDeadlineAtMs\s*=\s*startedAt\s*\+\s*BROWSER_RTC_READINESS_TIMEOUT_MS\s*;/,
      'const absoluteDeadlineAtMs = Number.POSITIVE_INFINITY;'
    ),
    functionMutation(
      'page-operation-timeout-disabled',
      /Math\.max\s*\(\s*1\s*,\s*remainingMs\s*\)/,
      '2147483647'
    ),
    functionMutation(
      'external-peer-request-counter-disabled',
      /runnerObservation\.peerCreationRequests\s*\+=\s*1\s*;/,
      'runnerObservation.peerCreationRequests += 0;'
    ),
    functionMutation(
      'external-snapshot-response-counter-disabled',
      /runnerObservation\.snapshotResponses\s*\+=\s*1\s*;/,
      'runnerObservation.snapshotResponses += 0;'
    ),
    functionMutation(
      'context-cleanup-faked',
      /\(\)\s*=>\s*context\.close\s*\(\s*\)/,
      '() => Promise.resolve()'
    ),
    functionMutation(
      'pre-probe-settle-removed',
      /await\s+wait\s*\(\s*BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS\s*\)\s*;/,
      'await Promise.resolve();'
    ),
    {
      name: 'pre-probe-settle-zeroed',
      source: greenSource.replace(
        /const\s+BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS\s*=\s*1000\s*;/,
        'const BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS = 0;'
      )
    }
  ];
  const cases = [];
  for (const mutation of mutations) {
    const staticResult = exactSourceMutation(
      mutation.source,
      `readiness-runtime-${mutation.name}`,
      [readinessPolicyId]
    );
    const mode = mutation.name === 'runner-absolute-deadline-removed' ||
        mutation.name === 'page-operation-timeout-disabled'
      ? 'wedged-evaluate-response'
      : 'transition';
    const runtime = await exerciseBrowserRtcReadinessContract(
      mutation.source,
      { singleMode: mode }
    );
    const requirement = runtime.requirements && runtime.requirements[0];
    const state = requirement && requirement.state;
    const observation = state && state.runnerObservation;
    const exactOnePeer = runtime.trackers && runtime.trackers.pcCount === 1;
    const boundedRed = runtime.supervisorExpired === false &&
      runtime.caught === runtime.failureSentinel &&
      runtime.requirements.length === 1 && requirement.ok === false &&
      runtime.evidence.length === 0;
    const deadlineFailureDetected = [
      'runner-absolute-deadline-removed',
      'page-operation-timeout-disabled'
    ].includes(mutation.name) && runtime.supervisorExpired === true &&
      runtime.requirements.length === 0;
    const fakeCleanupDetected = mutation.name === 'context-cleanup-faked' &&
      runtime.supervisorExpired === false && runtime.caught === null &&
      runtime.requirements.length === 1 && requirement.ok === true &&
      runtime.trackers.contextCloseAttemptCount === 0 &&
      runtime.trackers.contextCloseCount === 0;
    const runtimeDetected = boundedRed || deadlineFailureDetected || fakeCleanupDetected;
    const noRegistryRequest = runtime.trackers &&
      runtime.trackers.registryRequestCount === 0;
    cases.push({
      name: mutation.name,
      ok: staticResult.rejected && runtimeDetected && exactOnePeer && noRegistryRequest,
      staticRejected: staticResult.rejected,
      boundedRed,
      deadlineFailureDetected,
      fakeCleanupDetected,
      runtimeDetected,
      exactOnePeer,
      noRegistryRequest,
      reason: state ? state.reason : 'missing-state',
      detail: `static=${staticResult.rejected} runtimeDetected=${runtimeDetected} ` +
        `boundedRed=${boundedRed} supervisorExpired=${runtime.supervisorExpired} ` +
        `pc=${runtime.trackers ? runtime.trackers.pcCount : 'missing'} ` +
        `peer=${observation
          ? `${observation.peerCreationRequests}/${observation.peerCreationConfirmations}`
          : 'missing'} registry=${runtime.trackers
          ? runtime.trackers.registryRequestCount
          : 'missing'} reason=${state ? state.reason : 'missing'}`
    });
  }
  return {
    ok: cases.length === 7 && cases.every((entry) => entry.ok),
    cases,
    detail: `readiness mutations=${cases.filter((entry) => entry.ok).length}/` +
      `${cases.length} survivors=${cases.filter((entry) => !entry.ok)
        .map((entry) => `${entry.name}:${entry.detail}`).join(',') || 'none'}`
  };
}

async function exerciseTurnRuntimeFailureContracts(source) {
  const parsed = parseTargetJavaScript(source);
  const bindingAudit = auditLoadBearingFunctionBindings(source);
  const required = [
    'fetchValidatedTurnRegistryResponse',
    'ensureTurnFixture',
    'runRelayIceScenario'
  ];
  if (!parsed.ok || required.some((name) => !bindingAudit.validNames.has(name))) {
    return {
      ok: false,
      cases: [],
      detail: `runtime failure bindings unavailable parser=${parsed.ok} valid=` +
        required.filter((name) => bindingAudit.validNames.has(name)).join(',')
    };
  }
  const compile = (name, dependencies) => {
    const declaration = sourceForTopLevelFunction(source, parsed.ast, name);
    const dependencyNames = Object.keys(dependencies);
    return Function(
      ...dependencyNames,
      `'use strict'; ${declaration}; return ${name};`
    )(...dependencyNames.map((dependencyName) => dependencies[dependencyName]));
  };
  const cases = [];
  const exactRejection = async (name, operation) => {
    const deadEndpoint = new Error(`DEAD_ENDPOINT:${crypto.randomBytes(8).toString('hex')}`);
    try {
      await operation(deadEndpoint);
      cases.push({ name, ok: false, detail: 'resolved instead of rejecting' });
    } catch (error) {
      cases.push({
        name,
        ok: error === deadEndpoint,
        detail: error === deadEndpoint
          ? 'exact DEAD_ENDPOINT rejection propagated'
          : `wrong rejection=${String(error && error.message ? error.message : error)}`
      });
    }
  };
  const runtimeAttemptCount = 2 + (crypto.randomBytes(1)[0] % 3);
  const runtimeEndpointCount = 2 + (crypto.randomBytes(1)[0] % 3);
  const runtimeAddressCounts = Array.from(
    { length: runtimeEndpointCount },
    () => 1 + (crypto.randomBytes(1)[0] % 3)
  );
  const runtimeShape = `endpoints=${runtimeEndpointCount} attempts=${runtimeAttemptCount} ` +
    `addresses=${runtimeAddressCounts.join('/')}`;
  const exactModeRejections = async (name, operation) => {
    const outcomes = [];
    for (const mode of ['all-dead', 'mixed-healthy-dead']) {
      const deadEndpoint = new Error(
        `DEAD_ENDPOINT:${mode}:${crypto.randomBytes(8).toString('hex')}`
      );
      try {
        await operation(mode, deadEndpoint);
        outcomes.push({ mode, ok: false, detail: 'resolved instead of rejecting' });
      } catch (error) {
        outcomes.push({
          mode,
          ok: error === deadEndpoint,
          detail: error === deadEndpoint
            ? 'exact DEAD_ENDPOINT rejection propagated'
            : `wrong rejection=${String(error && error.message ? error.message : error)}`
        });
      }
    }
    cases.push({
      name,
      ok: outcomes.every((entry) => entry.ok),
      detail: `${runtimeShape} ` + outcomes.map((entry) =>
        `${entry.mode}:${entry.detail}`).join(' ')
    });
  };
  const runtimeEndpoints = (mode) => {
    const mixedDeadIndex = crypto.randomBytes(1)[0] % runtimeEndpointCount;
    return runtimeAddressCounts.map((addressCount, endpointIndex) => ({
      urls: `turn:runtime-${endpointIndex}-${crypto.randomBytes(5).toString('hex')}.example.net:3478`,
      addresses: Array.from({ length: addressCount }, (_, addressIndex) =>
        `192.0.2.${20 + endpointIndex * 10 + addressIndex}`),
      shouldFail: mode === 'all-dead' || endpointIndex === mixedDeadIndex
    }));
  };
  const executeHealthFailureMode = async (mode, deadEndpoint, throughRelay) => {
    const fetchedEndpoints = runtimeEndpoints(mode);
    fetchedEndpoints.forEach((endpoint, endpointIndex) => {
      endpoint.registryEndpointIdentity = referenceSha256(
        `${endpointIndex}:${endpoint.urls}`
      );
    });
    const fetchedEndpointIdentities = fetchedEndpoints.map(
      (endpoint) => endpoint.registryEndpointIdentity
    );
    const probeCalls = [];
    const ensure = compile('ensureTurnFixture', {
      TURN_ENDPOINT_PROBE_ATTEMPTS: runtimeAttemptCount,
      createBrowserPeerPage: async () => ({
        page: {},
        context: { close: async () => {} }
      }),
      probeSelectedTurnEndpoint: async (_page, endpoint) => {
        probeCalls.push(endpoint.urls);
        const ok = !endpoint.shouldFail;
        return {
          registryEndpointIdentity: endpoint.registryEndpointIdentity,
          nonUdpAddressCoverageUnambiguous: true,
          addresses: endpoint.addresses,
          hostnameAttempts: Array.from(
            { length: runtimeAttemptCount },
            (_, attemptIndex) => ({
              attempt: attemptIndex + 1,
              ok,
              error: ok ? '' : 'DEAD_ENDPOINT'
            })
          ),
          addressAttempts: endpoint.addresses.flatMap((address) =>
            Array.from({ length: runtimeAttemptCount }, (_, attemptIndex) => ({
              address,
              attempt: attemptIndex + 1,
              ok,
              error: ok ? '' : 'DEAD_ENDPOINT'
            })))
        };
      },
      requireHarnessFixture: (_report, _name, ok) => {
        if (!ok) throw deadEndpoint;
      }
    });
    const turnFixture = {
      fetchedEndpointIdentities,
      fetchedEndpoints,
      rtcConfig: { iceServers: [], iceTransportPolicy: 'relay' }
    };
    const invoke = async () => {
      if (!throughRelay) return ensure({}, {}, {}, turnFixture);
      const noop = () => {};
      const relay = compile('runRelayIceScenario', {
        ensureBrowserRtcReadiness: async () => {},
        fetchValidatedTurnRegistryResponse: async () => ({
          rawResponse: '{}',
          servers: fetchedEndpoints.map((endpoint, index) => ({
            urls: endpoint.urls,
            username: `runtime-user-${index}`,
            credential: `runtime-secret-${index}`,
            udp: true
          }))
        }),
        resolveBrowserTurnConfiguration: async () => turnFixture,
        ensureTurnFixture: ensure,
        addEvidence: noop,
        startSignalServer: async () => ({ url: 'ws://127.0.0.1:1' }),
        startPublisher: () => ({ output: () => '' }),
        connectNewPeer: async () => ({}),
        exactIceSummaryToken: () => '',
        turnRegistryResponseSha256: () => '0'.repeat(64),
        matchPackagedTurnResponse: () => null,
        addCheck: noop,
        redactTurnSecrets: (_servers, _raw, value) => String(value)
      });
      return relay({}, 'publisher.exe', {}, {}, { senderName: 'sender' });
    };
    const hadBypass = Object.prototype.hasOwnProperty.call(
      process.env,
      'ALLOW_DEAD_TURN'
    );
    const priorBypass = process.env.ALLOW_DEAD_TURN;
    process.env.ALLOW_DEAD_TURN = `set-${crypto.randomBytes(6).toString('hex')}`;
    let caught = null;
    try {
      await invoke();
    } catch (error) {
      caught = error;
    } finally {
      if (hadBypass) process.env.ALLOW_DEAD_TURN = priorBypass;
      else delete process.env.ALLOW_DEAD_TURN;
    }
    if (probeCalls.length !== fetchedEndpoints.length ||
        new Set(probeCalls).size !== fetchedEndpoints.length) {
      throw new Error(
        `endpoint probe coverage changed expected=${fetchedEndpoints.length} ` +
        `observed=${probeCalls.length}/${new Set(probeCalls).size}`
      );
    }
    if (caught) throw caught;
  };

  try {
    await exactRejection('registry-fetch-rejection-is-not-replaced', async (deadEndpoint) => {
      const fetchValidated = compile('fetchValidatedTurnRegistryResponse', {
        fetch: async () => { throw deadEndpoint; },
        AbortSignal: { timeout: () => ({}) },
        validateTurnRegistryResponse: () => {
          throw new Error('validator must not run after fetch rejection');
        }
      });
      await fetchValidated(`https://registry-${crypto.randomBytes(6).toString('hex')}.example.net/`);
    });

    await exactModeRejections(
      'dead-endpoint-health-rejection-is-preserved',
      (mode, deadEndpoint) => executeHealthFailureMode(mode, deadEndpoint, false)
    );

    await exactModeRejections(
      'relay-scenario-propagates-dead-endpoint',
      (mode, deadEndpoint) => executeHealthFailureMode(mode, deadEndpoint, true)
    );

    const provenanceChecks = [];
    const provenanceEndpoint = {
      urls: 'turn:provenance.example.net:3478',
      username: 'provenance-user',
      credential: 'provenance-secret',
      udp: true
    };
    const expectedRuntimeConsumedConfigSha256 = referenceSha256(
      'game-capture-consumed-turn-config-v1\n' + JSON.stringify([{
        url: provenanceEndpoint.urls,
        username: provenanceEndpoint.username,
        credential: provenanceEndpoint.credential,
        udp: provenanceEndpoint.udp
      }])
    );
    const expectedResponseSha256 = referenceSha256(
      `expected-response-${crypto.randomBytes(8).toString('hex')}`
    );
    const observedResponseSha256 = referenceSha256(
      `observed-response-${crypto.randomBytes(8).toString('hex')}`
    );
    const relay = compile('runRelayIceScenario', {
      ensureBrowserRtcReadiness: async () => {},
      fetchValidatedTurnRegistryResponse: async () => ({
        rawResponse: '{}',
        servers: [provenanceEndpoint]
      }),
      resolveBrowserTurnConfiguration: async (turnRegistryResponse) => ({
        turnRegistryResponse,
        fetchedEndpoints: [provenanceEndpoint],
        rtcConfig: { iceServers: [], iceTransportPolicy: 'relay' }
      }),
      ensureTurnFixture: async () => {},
      addEvidence: () => {},
      startSignalServer: async () => ({
        url: 'ws://127.0.0.1:1',
        close: async () => {}
      }),
      startPublisher: () => ({
        child: { exitCode: null, signalCode: null },
        output: () => [
          '[ICE] TurnRegistryFetch turnRegistryTransactionId=fetch-observed ' +
            `turnRegistryResponseSha256=${observedResponseSha256}`,
          '[WebRTC] ConsumedIceConfig turnRegistryTransactionId=consumed-observed ' +
            'turnRegistryResponseSha256=consumed-response ' +
            'turnConfigV1Sha256=consumed-config turnConfigV1Count=1 ' +
            'turnUrlCount=1 iceServerCount=3 ' +
            `consumedConfigSha256=${expectedRuntimeConsumedConfigSha256}`
        ].join('\n'),
        stop: async () => {}
      }),
      createBrowserPeerPage: async () => ({
        page: {},
        context: { close: async () => {} }
      }),
      waitForPublisherReady: async () => true,
      wait: async () => {},
      connectNewPeer: async () => ({ ok: true }),
      exactIceSummaryToken: (line, name) => {
        const match = String(line).match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`));
        return match ? match[1] : '';
      },
      turnRegistryResponseSha256: () => 'f'.repeat(64),
      matchPackagedTurnResponse: () => ({
        transactionId: 'expected-transaction',
        responseSha256: expectedResponseSha256,
        configSha256: 'expected-config',
        servers: [{}, {}]
      }),
      addCheck: (_report, name, ok) => provenanceChecks.push({ name, ok }),
      redactTurnSecrets: (_servers, _raw, value) => String(value),
      sha256Text: referenceSha256,
      TURN_CONSUMED_CONFIG_V1_PREFIX: 'game-capture-consumed-turn-config-v1',
      signaledCandidateTypes: () => []
    });
    await relay({}, 'publisher.exe', {}, {}, { senderName: 'sender' });
    const consumedCheck = provenanceChecks.find((entry) =>
      entry.name === 'packaged-turn-consumed-config-matches-fetched-response');
    cases.push({
      name: 'consumed-provenance-mismatch-remains-red',
      ok: !!consumedCheck && consumedCheck.ok === false,
      detail: consumedCheck
        ? `observedCheck=${consumedCheck.ok}`
        : 'consumed provenance check was not recorded'
    });
  } catch (error) {
    cases.push({
      name: 'runtime-failure-contract-construction',
      ok: false,
      detail: String(error && error.message ? error.message : error)
    });
  }

  return {
    ok: cases.length === 4 && cases.every((entry) => entry.ok),
    cases,
    detail: `runtime failing paths=${cases.filter((entry) => entry.ok).length}/` +
      `${cases.length} failures=${cases.filter((entry) => !entry.ok)
        .map((entry) => `${entry.name}:${entry.detail}`).join(',') || 'none'}`
  };
}

function maskComments(source) {
  let result = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  ';
        blockComment = false;
        index += 1;
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      result += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    result += character;
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
    }
  }
  return result;
}

function hasExecutableReturn(source) {
  let found = false;

  const skipQuoted = (start, quote) => {
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        return index + 1;
      }
    }
    return source.length;
  };

  const skipRegularExpression = (start) => {
    let escaped = false;
    let inCharacterClass = false;
    let index = start + 1;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '[') {
        inCharacterClass = true;
      } else if (character === ']' && inCharacterClass) {
        inCharacterClass = false;
      } else if (character === '/' && !inCharacterClass) {
        index += 1;
        break;
      }
    }
    while (index < source.length && /[A-Za-z]/.test(source[index])) {
      index += 1;
    }
    return index;
  };

  const regularExpressionCanStartAfter = (previousToken) =>
    previousToken === '' ||
      /^(?:[({\[,:;=!?&|+\-*%^~<>]|=>|control-close)$/.test(previousToken) ||
      /^(?:case|delete|do|else|in|instanceof|new|of|throw|typeof|void|yield|await)$/.test(
        previousToken
      );

  const scanCode = (start, templateExpression) => {
    let index = start;
    let templateBraceDepth = templateExpression ? 1 : 0;
    let previousToken = '';
    let pendingControlParenthesis = false;
    const parenthesisContexts = [];

    while (index < source.length && !found) {
      const character = source[index];
      const next = source[index + 1] || '';

      if (/\s/.test(character)) {
        index += 1;
        continue;
      }
      if (character === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        index += 2;
        while (index < source.length &&
               !(source[index] === '*' && source[index + 1] === '/')) {
          index += 1;
        }
        index = Math.min(source.length, index + 2);
        continue;
      }
      if (character === '\'' || character === '"') {
        index = skipQuoted(index, character);
        previousToken = 'literal';
        continue;
      }
      if (character === '`') {
        index += 1;
        while (index < source.length && !found) {
          if (source[index] === '\\') {
            index = Math.min(source.length, index + 2);
          } else if (source[index] === '`') {
            index += 1;
            break;
          } else if (source[index] === '$' && source[index + 1] === '{') {
            index = scanCode(index + 2, true);
          } else {
            index += 1;
          }
        }
        previousToken = 'literal';
        continue;
      }
      if (character === '/' && regularExpressionCanStartAfter(previousToken)) {
        index = skipRegularExpression(index);
        previousToken = 'literal';
        continue;
      }
      if (/[A-Za-z_$]/.test(character)) {
        let end = index + 1;
        while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
        const identifier = source.slice(index, end);
        let nextCodeIndex = end;
        while (nextCodeIndex < source.length && /\s/.test(source[nextCodeIndex])) {
          nextCodeIndex += 1;
        }
        if (identifier === 'return' && previousToken !== '.' &&
            source[nextCodeIndex] !== ':') {
          found = true;
          return end;
        }
        previousToken = identifier;
        pendingControlParenthesis = /^(?:catch|for|if|switch|while|with)$/.test(
          identifier
        );
        index = end;
        continue;
      }
      if (templateExpression) {
        if (character === '{') {
          templateBraceDepth += 1;
        } else if (character === '}') {
          templateBraceDepth -= 1;
          if (templateBraceDepth === 0) {
            return index + 1;
          }
        }
      }
      if (character === '(') {
        parenthesisContexts.push(pendingControlParenthesis ? 'control' : 'expression');
        pendingControlParenthesis = false;
        previousToken = '(';
      } else if (character === ')') {
        const context = parenthesisContexts.pop();
        previousToken = context === 'control' ? 'control-close' : ')';
      } else if (character === '=' && next === '>') {
        previousToken = '=>';
        pendingControlParenthesis = false;
        index += 1;
      } else if (character === '.') {
        previousToken = '.';
        pendingControlParenthesis = false;
      } else if (!/[0-9]/.test(character)) {
        previousToken = character;
        pendingControlParenthesis = false;
      } else if (!previousToken || previousToken !== 'literal') {
        previousToken = 'literal';
        pendingControlParenthesis = false;
      }
      index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return found;
}

function splitTopLevelProperties(objectText) {
  const properties = [];
  let start = 1;
  let braceDepth = 1;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 1; index < objectText.length - 1; index += 1) {
    const character = objectText[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth -= 1;
    else if (character === '[') bracketDepth += 1;
    else if (character === ']') bracketDepth -= 1;
    else if (character === '(') parenthesisDepth += 1;
    else if (character === ')') parenthesisDepth -= 1;
    else if (character === ',' && braceDepth === 1 && bracketDepth === 0 && parenthesisDepth === 0) {
      properties.push(objectText.slice(start, index).trim());
      start = index + 1;
    }
  }
  properties.push(objectText.slice(start, -1).trim());
  return properties.filter(Boolean).map((entry) => {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]+)$/.exec(entry);
    return match ? { name: match[1], value: match[2].trim() } : { name: '', value: entry };
  });
}

function publisherOptions(callText) {
  const masked = maskComments(callText);
  const openIndex = masked.indexOf('{');
  if (openIndex < 0) {
    return [];
  }
  const closeIndex = findBalancedEnd(masked, openIndex, '{', '}');
  if (closeIndex < 0) {
    return [];
  }
  return splitTopLevelProperties(masked.slice(openIndex, closeIndex + 1));
}

function enclosingFunctionName(source, index) {
  const pattern = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let name = '';
  let match;
  while ((match = pattern.exec(source)) !== null && match.index < index) {
    name = match[1];
  }
  return name;
}

function startPublisherCalls(source) {
  const calls = [];
  const pattern = /\bstartPublisher\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const prefix = source.slice(Math.max(0, match.index - 24), match.index);
    if (/function\s+$/.test(prefix)) {
      continue;
    }
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findBalancedEnd(source, openIndex, '(', ')');
    if (closeIndex < 0) {
      continue;
    }
    calls.push({
      functionName: enclosingFunctionName(source, match.index),
      text: source.slice(match.index, closeIndex + 1)
    });
    pattern.lastIndex = closeIndex + 1;
  }
  return calls;
}

function analyzeTurnRegistryContract(
  source,
  ast,
  bindingAudit,
  forbiddenRuntime,
  criticalControlFlow
) {
  const facts = new Map();
  const getFacts = (name) => {
    if (!facts.has(name)) facts.set(name, reachableFunctionNodes(ast, name));
    return facts.get(name);
  };
  const nodes = (name, type = '') => getFacts(name).nodes.filter(
    (node) => !type || node.type === type
  );
  const calls = (name, callee = '') => nodes(name).filter((node) =>
    (node.type === 'CallExpression' || node.type === 'NewExpression') &&
      (!callee || callCalleeName(node) === callee)
  );
  const directReturns = (name) => {
    const currentFacts = getFacts(name);
    return currentFacts.nodes.filter((node) => {
      if (node.type !== 'ReturnStatement') return false;
      let parent = currentFacts.parents.get(node);
      while (parent && parent !== currentFacts.functionNode) {
        if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']
          .includes(parent.type)) return false;
        parent = currentFacts.parents.get(parent);
      }
      return parent === currentFacts.functionNode;
    });
  };
  const hasReachableString = (name, pattern) => nodes(name).some((node) => {
    const value = staticStringValue(node);
    return value !== null && pattern.test(value);
  });
  const isLiteralNumber = (node, value) => {
    const primitive = staticPrimitiveValue(node);
    return primitive.known && primitive.value === value;
  };
  const isPath = (node, expected) => {
    const parts = memberExpressionPath(unwrapAstExpression(node));
    return !!parts && parts.join('.') === expected;
  };
  const isIdentifier = (node, expected) => {
    const current = unwrapAstExpression(node);
    return !!current && current.type === 'Identifier' && current.name === expected;
  };
  const comparison = (name, predicate) => nodes(name, 'BinaryExpression').some(predicate);
  const comparisonOfPathAndNumber = (name, expectedPath, value, operators) =>
    comparison(name, (node) => operators.includes(node.operator) && (
      (isPath(node.left, expectedPath) && isLiteralNumber(node.right, value)) ||
      (isPath(node.right, expectedPath) && isLiteralNumber(node.left, value))
    ));
  const equalityBetween = (name, leftName, rightPath) => {
    const binary = nodes(name, 'BinaryExpression').some((node) =>
      ['===', '=='].includes(node.operator) && (
        (isIdentifier(node.left, leftName) && isPath(node.right, rightPath)) ||
        (isIdentifier(node.right, leftName) && isPath(node.left, rightPath))
      ));
    const objectIs = calls(name, 'is').some((call) => {
      const calleePath = memberExpressionPath(unwrapAstExpression(call.callee));
      return calleePath && calleePath.join('.') === 'Object.is' && call.arguments.length >= 2 && (
        (isIdentifier(call.arguments[0], leftName) && isPath(call.arguments[1], rightPath)) ||
        (isIdentifier(call.arguments[1], leftName) && isPath(call.arguments[0], rightPath))
      );
    });
    return binary || objectIs;
  };
  const objectProperty = (object, propertyName) => object &&
    object.type === 'ObjectExpression'
      ? object.properties.find((property) => property.type === 'Property' &&
        (property.computed ? staticStringValue(property.key) === propertyName
          : (property.key.name || staticStringValue(property.key)) === propertyName))
      : null;
  const callbackReturnsOk = (call) => {
    const callback = call.arguments && call.arguments[0];
    if (!callback || !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)) {
      return false;
    }
    const parameter = callback.params[0];
    const returned = callback.body.type === 'BlockStatement'
      ? callback.body.body.find((statement) => statement.type === 'ReturnStatement')?.argument
      : callback.body;
    if (!parameter || !returned) return false;
    if (parameter.type === 'Identifier' && isPath(returned, `${parameter.name}.ok`)) return true;
    if (parameter.type !== 'ObjectPattern') return false;
    const okProperty = parameter.properties.find((property) => property.type === 'Property' &&
      (property.key.name || staticStringValue(property.key)) === 'ok');
    const boundNames = okProperty ? assignedPatternIdentifiers(okProperty.value) : [];
    return returned.type === 'Identifier' && boundNames.includes(returned.name);
  };
  const everyOver = (name, collectionProperty) => calls(name, 'every').some((call) => {
    const callee = unwrapAstExpression(call.callee);
    return callee && callee.type === 'MemberExpression' &&
      memberPropertyName(callee) === 'every' &&
      memberPropertyName(unwrapAstExpression(callee.object)) === collectionProperty &&
      callbackReturnsOk(call);
  });
  const callHasIdentifierArguments = (call, expectedNames) => {
    const observed = new Set();
    for (const argument of call.arguments || []) {
      walkTargetAst(argument, (node) => {
        if (node.type === 'Identifier') observed.add(node.name);
      });
    }
    return expectedNames.every((name) => observed.has(name));
  };

  const executableContract = exerciseTurnRegistryReferenceContract(source);
  const contractCase = (name) => {
    const entry = executableContract.cases.find((candidate) => candidate.name === name);
    return !!entry && entry.ok;
  };
  const validationCaseNames = [
    'fixture-a', 'fixture-b', 'string-urls-preserved', 'array-order-preserved',
    'additive-metadata', 'status-not-200', 'version-missing', 'version-string',
    'version-unsupported', 'servers-missing', 'servers-empty', 'servers-not-array',
    'legacy-url', 'urls-empty-array', 'urls-invalid-scheme', 'username-empty',
    'credential-empty', 'udp-not-boolean', 'mixed-response-fails-whole'
  ];
  const schemaCasesPass = validationCaseNames.every(contractCase);

  const readinessCalls = calls('runRelayIceScenario', 'ensureBrowserRtcReadiness');
  const readinessFetchCalls = calls(
    'runRelayIceScenario',
    'fetchValidatedTurnRegistryResponse'
  );
  const readinessPcConstructions = calls(
    'ensureBrowserRtcReadiness',
    'RTCPeerConnection'
  );
  const readinessPcConfig = readinessPcConstructions.length === 1 &&
      readinessPcConstructions[0].arguments.length === 1
    ? unwrapAstExpression(readinessPcConstructions[0].arguments[0])
    : null;
  const readinessIceServers = objectProperty(readinessPcConfig, 'iceServers');
  const readinessIcePolicy = objectProperty(readinessPcConfig, 'iceTransportPolicy');
  const readinessCallIsAwaited = readinessCalls.length === 1 &&
    getFacts('runRelayIceScenario').parents.get(readinessCalls[0])?.type === 'AwaitExpression';
  const readinessCallArgumentsAreNeutral = readinessCalls.length === 1 &&
    readinessCalls[0].arguments.length === 2 &&
    isIdentifier(readinessCalls[0].arguments[0], 'browser') &&
    isIdentifier(readinessCalls[0].arguments[1], 'report');
  const topLevelConstNumericValues = (name) => (ast && ast.body ? ast.body : [])
    .filter((statement) =>
      statement.type === 'VariableDeclaration' && statement.kind === 'const')
    .flatMap((statement) => statement.declarations)
    .filter((declaration) =>
      declaration.id.type === 'Identifier' && declaration.id.name === name &&
      declaration.init && declaration.init.type === 'Literal' &&
      typeof declaration.init.value === 'number')
    .map((declaration) => declaration.init.value);
  const hasExactNumericConstant = (name, expected) => {
    const values = topLevelConstNumericValues(name);
    return values.length === 1 && values[0] === expected;
  };
  const readinessDeadlineIsFixed =
    hasExactNumericConstant('BROWSER_RTC_READINESS_TIMEOUT_MS', 15000) &&
    hasExactNumericConstant(
      'BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS',
      expectedRtcReadinessPreProbeSettleMs
    ) &&
    hasExactNumericConstant('BROWSER_RTC_READINESS_POLL_INTERVAL_MS', 50) &&
    hasExactNumericConstant('BROWSER_RTC_READINESS_PEER_CLOSE_TIMEOUT_MS', 250) &&
    hasExactNumericConstant('BROWSER_RTC_READINESS_CLEANUP_TIMEOUT_MS', 2000);
  const topLevelConstStaticStrings = (name) => (ast && ast.body ? ast.body : [])
    .filter((statement) =>
      statement.type === 'VariableDeclaration' && statement.kind === 'const')
    .flatMap((statement) => statement.declarations)
    .filter((declaration) =>
      declaration.id.type === 'Identifier' && declaration.id.name === name)
    .map((declaration) => staticStringValue(declaration.init));
  const readinessDocumentUrlValues = topLevelConstStaticStrings(
    'BROWSER_RTC_READINESS_DOCUMENT_URL'
  );
  const readinessDocumentMarkerValues = topLevelConstStaticStrings(
    'BROWSER_RTC_READINESS_DOCUMENT_MARKER'
  );
  const readinessNavigationCalls = calls('ensureBrowserRtcReadiness', 'goto');
  const readinessWaitCalls = calls('ensureBrowserRtcReadiness', 'wait');
  const readinessPreProbeSettleCalls = readinessWaitCalls.filter((call) =>
    call.arguments.length === 1 && isIdentifier(
      unwrapAstExpression(call.arguments[0]),
      'BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS'
    ));
  const readinessEvaluateCalls = calls('ensureBrowserRtcReadiness', 'evaluate');
  const readinessPreProbeSettleIsDeterministic =
    readinessDeadlineIsFixed &&
    readinessPreProbeSettleCalls.length === 1 &&
    getFacts('ensureBrowserRtcReadiness').parents
      .get(readinessPreProbeSettleCalls[0])?.type === 'AwaitExpression' &&
    readinessWaitCalls.length === 2 &&
    readinessNavigationCalls.length === 1 && readinessEvaluateCalls.length === 3 &&
    readinessNavigationCalls[0].start < readinessPreProbeSettleCalls[0].start &&
    readinessPreProbeSettleCalls[0].start < readinessEvaluateCalls[0].start;
  const readinessUsesDeterministicDataDocument =
    readinessDocumentUrlValues.length === 1 &&
    readinessDocumentUrlValues[0] === expectedRtcReadinessDocumentUrl &&
    readinessDocumentMarkerValues.length === 1 &&
    readinessDocumentMarkerValues[0] === expectedRtcReadinessDocumentMarker &&
    readinessNavigationCalls.length === 1 &&
    readinessNavigationCalls[0].arguments.length >= 1 &&
    isIdentifier(
      unwrapAstExpression(readinessNavigationCalls[0].arguments[0]),
      'BROWSER_RTC_READINESS_DOCUMENT_URL'
    ) &&
    !hasReachableString('ensureBrowserRtcReadiness', /^about:blank$/);
  const readinessHasForbiddenRegistryCoupling = nodes('ensureBrowserRtcReadiness').some((node) => {
    if (node.type === 'Identifier' &&
        /^(?:turnFixture|turnRegistryResponse|fetchedEndpoints|endpointProbes|relayRtcConfig)$/
          .test(node.name)) return true;
    const pathParts = memberExpressionPath(node);
    return !!pathParts && (
      pathParts[0] === 'config' || pathParts[0] === 'turnFixture' ||
      pathParts[0] === 'turnRegistryResponse' || pathParts[0] === 'endpoint'
    );
  });
  const readinessHasGlobalReuse = nodes('ensureBrowserRtcReadiness').some((node) => {
    const pathParts = memberExpressionPath(node);
    return !!pathParts && ['window', 'globalThis'].includes(pathParts[0]);
  });
  const readinessClosesContext = calls('ensureBrowserRtcReadiness', 'close').some((call) =>
    isPath(unwrapAstExpression(call.callee).object, 'context'));
  const readinessClosesPc = calls('ensureBrowserRtcReadiness', 'close').some((call) =>
    isPath(unwrapAstExpression(call.callee).object, 'state.pc'));
  const readinessHasGenuineRtcOperations =
    calls('ensureBrowserRtcReadiness', 'createDataChannel').length === 1 &&
    calls('ensureBrowserRtcReadiness', 'createOffer').length === 1 &&
    calls('ensureBrowserRtcReadiness', 'setLocalDescription').length === 1 &&
    nodes('ensureBrowserRtcReadiness').some((node) => isPath(node, 'pc.iceGatheringState')) &&
    hasReachableString('ensureBrowserRtcReadiness', /^new$/) &&
    calls('ensureBrowserRtcReadiness', 'requireHarnessFixture').length === 1 &&
    hasReachableString(
      'ensureBrowserRtcReadiness',
      /^browser-rtc-readiness-before-turn-registry$/
    );
  const readinessSource = getFacts('ensureBrowserRtcReadiness').functionNode
    ? sourceSlice(source, getFacts('ensureBrowserRtcReadiness').functionNode)
    : '';
  const readinessHasPreProbeSettleEvidence =
    /const\s+preProbeSettleStartedAt\s*=\s*Date\.now\s*\(\s*\)\s*;/
      .test(readinessSource) &&
    /const\s+preProbeSettleElapsedMs\s*=\s*Date\.now\s*\(\s*\)\s*-\s*preProbeSettleStartedAt\s*;/
      .test(readinessSource) &&
    /const\s+preProbeSettle\s*=\s*\{\s*requestedMs:\s*BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS\s*,\s*elapsedMs:\s*0\s*,\s*completedBeforePeerCreation:\s*false\s*\}\s*;/
      .test(readinessSource) &&
    /preProbeSettle\.elapsedMs\s*=\s*preProbeSettleElapsedMs\s*;/
      .test(readinessSource) &&
    /preProbeSettle\.completedBeforePeerCreation\s*=\s*!settleWouldExceedDeadline\s*;/
      .test(readinessSource) &&
    /const\s+preProbeTimingValid\s*=\s*preProbeSettle\.requestedMs\s*===\s*1000\s*&&\s*preProbeSettle\.elapsedMs\s*>=\s*preProbeSettle\.requestedMs\s*&&\s*preProbeSettle\.completedBeforePeerCreation\s*===\s*true\s*;/
      .test(readinessSource);
  const readinessHasRunnerOwnedDeadlineAndCounters =
    /const\s+absoluteDeadlineAtMs\s*=\s*startedAt\s*\+\s*BROWSER_RTC_READINESS_TIMEOUT_MS\s*;/
      .test(readinessSource) &&
    /const\s+runBoundedOperation\s*=\s*async\s*\(name,\s*deadlineAtMs,\s*operation\)\s*=>/
      .test(readinessSource) &&
    /const\s+outcome\s*=\s*await\s+Promise\.race\s*\(/.test(readinessSource) &&
    /timer\s*=\s*setTimeout\s*\([\s\S]*?Math\.max\(1,\s*remainingMs\)/
      .test(readinessSource) &&
    /runnerObservation\.peerCreationRequests\s*\+=\s*1\s*;/.test(readinessSource) &&
    /runnerObservation\.peerCreationConfirmations\s*\+=\s*peerCreationConfirmed\s*\?\s*1\s*:\s*0\s*;/
      .test(readinessSource) &&
    /runnerObservation\.snapshotRequests\s*\+=\s*1\s*;/.test(readinessSource) &&
    /runnerObservation\.snapshotResponses\s*\+=\s*1\s*;/.test(readinessSource) &&
    /runnerObservation\.peerCreationRequests\s*===\s*1/.test(readinessSource) &&
    /runnerObservation\.peerCreationConfirmations\s*===\s*1/.test(readinessSource) &&
    /runnerObservation\.snapshotResponses\s*<=\s*runnerObservation\.snapshotRequests/
      .test(readinessSource);
  const readinessFacts = getFacts('ensureBrowserRtcReadiness');
  const isInsideBoundedOperation = (call) => {
    let current = call;
    while (current) {
      current = readinessFacts.parents.get(current);
      if (!current) return false;
      if (current.type === 'CallExpression' &&
          callCalleeName(current) === 'runBoundedOperation') return true;
      if (current === readinessFacts.functionNode) return false;
    }
    return false;
  };
  const readinessPageOperations = [
    ...calls('ensureBrowserRtcReadiness', 'newContext'),
    ...calls('ensureBrowserRtcReadiness', 'newPage'),
    ...readinessNavigationCalls,
    ...readinessEvaluateCalls,
    ...calls('ensureBrowserRtcReadiness', 'close').filter((call) =>
      isPath(unwrapAstExpression(call.callee).object, 'context'))
  ];
  const readinessEveryPageOperationIsExternallyBounded =
    readinessPageOperations.length === 7 &&
    readinessPageOperations.every(isInsideBoundedOperation) &&
    /const\s+cleanupDeadlineAtMs\s*=\s*Date\.now\s*\(\s*\)\s*\+\s*BROWSER_RTC_READINESS_CLEANUP_TIMEOUT_MS\s*;/
      .test(readinessSource) &&
    /Math\.min\s*\(\s*cleanupDeadlineAtMs\s*,\s*Date\.now\s*\(\s*\)\s*\+\s*BROWSER_RTC_READINESS_PEER_CLOSE_TIMEOUT_MS\s*\)/
      .test(readinessSource);
  const readinessVerdictRequiresObservedTransition =
    /const\s+genuineTransition\s*=\s*readiness\.initialState\s*===\s*['"]new['"]\s*&&\s*readiness\.finalState\s*!==\s*['"]new['"]\s*&&\s*readiness\.observedTransitions\.length\s*>\s*0\s*;/
      .test(readinessSource) &&
    /lastSnapshot\.operationCompleted\s*&&\s*validDocumentContext\s*&&\s*genuineTransition\s*&&\s*exactRtcOperations\s*&&\s*readiness\.configuredIceServerCount\s*===\s*0\s*&&\s*!readiness\.operationError/
      .test(readinessSource) &&
    /['"]browser-rtc-readiness-before-turn-registry['"]\s*,\s*result\.ok/
      .test(readinessSource);
  const readinessRequiresDocumentContextEvidence =
    /page\.goto\s*\(\s*BROWSER_RTC_READINESS_DOCUMENT_URL\s*,\s*\{\s*waitUntil:\s*['"]load['"]\s*\}\s*\)/
      .test(readinessSource) &&
    /protocol:\s*location\.protocol/.test(readinessSource) &&
    /origin:\s*location\.origin/.test(readinessSource) &&
    /marker:\s*document\.documentElement\.getAttribute\s*\(\s*['"]data-game-capture-rtc-readiness['"]\s*\)/
      .test(readinessSource) &&
    /readyState:\s*document\.readyState/.test(readinessSource) &&
    /documentContext\.protocol\s*===\s*['"]data:['"]/.test(readinessSource) &&
    /documentContext\.origin\s*===\s*['"]null['"]/.test(readinessSource) &&
    /readiness\.documentContext\.marker\s*===\s*BROWSER_RTC_READINESS_DOCUMENT_MARKER/
      .test(readinessSource) &&
    /readiness\.documentContext\.readyState\s*===\s*['"]complete['"]/
      .test(readinessSource) &&
    /pcCreated:\s*true/.test(readinessSource) &&
    /peerCreationConfirmed\s*=\s*!!\(initialProof\s*&&\s*initialProof\.pcCreated\s*===\s*true\)/
      .test(readinessSource);
  const readinessBarrierIsStructurallySound =
    readinessCalls.length === 1 && readinessFetchCalls.length === 1 &&
    readinessCalls[0].start < readinessFetchCalls[0].start &&
    readinessCallIsAwaited && readinessCallArgumentsAreNeutral &&
    readinessDeadlineIsFixed && readinessPcConstructions.length === 1 &&
    readinessPcConfig && readinessIceServers &&
    unwrapAstExpression(readinessIceServers.value)?.type === 'ArrayExpression' &&
    unwrapAstExpression(readinessIceServers.value).elements.length === 0 &&
    readinessIcePolicy && staticStringValue(readinessIcePolicy.value) === 'all' &&
    readinessUsesDeterministicDataDocument && readinessPreProbeSettleIsDeterministic &&
    readinessHasPreProbeSettleEvidence && readinessRequiresDocumentContextEvidence &&
    readinessHasRunnerOwnedDeadlineAndCounters &&
    readinessEveryPageOperationIsExternallyBounded &&
    readinessHasGenuineRtcOperations && readinessVerdictRequiresObservedTransition &&
    readinessClosesPc && readinessClosesContext &&
    directReturns('ensureBrowserRtcReadiness').length === 0 &&
    calls('ensureBrowserRtcReadiness', 'fetch').length === 0 &&
    !readinessHasForbiddenRegistryCoupling && !readinessHasGlobalReuse;

  const relayFetchCalls = calls('runRelayIceScenario', 'fetchValidatedTurnRegistryResponse');
  const relayResolveCalls = calls('runRelayIceScenario', 'resolveBrowserTurnConfiguration');
  const recoveryRelayCalls = calls('runRecoveryScenario', 'runRelayIceScenario');
  const relayFetchDeclaration = nodes('runRelayIceScenario', 'VariableDeclarator').find(
    (declaration) => declaration.id.type === 'Identifier' &&
      declaration.id.name === 'turnRegistryResponse' && declaration.init &&
      astNodeContains(declaration.init, (node) => node.type === 'CallExpression' &&
        callCalleeName(node) === 'fetchValidatedTurnRegistryResponse')
  );
  const relayResponseConsumed = relayResolveCalls.some((call) =>
    call.arguments.some((argument) => isIdentifier(argument, 'turnRegistryResponse'))
  );
  const topLevelTurnRegistryCaches = [];
  for (const statement of ast && ast.body ? ast.body : []) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.init && declaration.id.type === 'Identifier' &&
          /^(?:turnRegistryResponse|cachedTurnRegistry|cachedTurnResponse|relayBrowserRtcConfig)$/i
            .test(declaration.id.name)) {
        topLevelTurnRegistryCaches.push(declaration.id.name);
      }
    }
  }
  const globalTurnRegistryCacheReferences = [
    ...nodes('runRelayIceScenario'),
    ...nodes('fetchValidatedTurnRegistryResponse'),
    ...nodes('resolveBrowserTurnConfiguration')
  ].filter((node) => {
    const pathParts = memberExpressionPath(node);
    return !!pathParts && ['globalThis', 'window'].includes(pathParts[0]) &&
      pathParts.slice(1).some((part) => /(?:turn|registry|relay).*cache|cache.*(?:turn|registry|relay)/i
        .test(part));
  });

  const fetchHasLiveUrl = hasReachableString(
    'fetchValidatedTurnRegistryResponse',
    /^https:\/\/turnservers\.vdo\.ninja(?:[/?]|$)/
  );
  const fetchCallsNetwork = calls('fetchValidatedTurnRegistryResponse', 'fetch').length === 1;
  const fetchChecksStatus = nodes('fetchValidatedTurnRegistryResponse', 'BinaryExpression')
    .some((node) => ['!==', '!=', '===', '=='].includes(node.operator) && (
      ((isPath(node.left, 'response.status') || isPath(node.left, 'response.statusCode')) &&
        isLiteralNumber(node.right, 200)) ||
      ((isPath(node.right, 'response.status') || isPath(node.right, 'response.statusCode')) &&
        isLiteralNumber(node.left, 200))
    ));
  const fetchParsesJson = calls('fetchValidatedTurnRegistryResponse', 'parse').some((call) =>
    isPath(call.callee, 'JSON.parse'));
  const fetchValidates = calls(
    'fetchValidatedTurnRegistryResponse',
    'validateTurnRegistryResponse'
  ).length === 1;
  const persistedTurnIo = calls('fetchValidatedTurnRegistryResponse').some((call) => {
    const pathParts = memberExpressionPath(unwrapAstExpression(call.callee));
    return pathParts && ['fs.readFileSync', 'fs.writeFileSync'].includes(pathParts.join('.'));
  });

  const embeddedTurnCredentialRows = [];
  if (ast) {
    for (const statement of ast.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) {
        if (!declaration.init) continue;
        walkTargetAst(declaration.init, (node) => {
          if (node.type !== 'ObjectExpression') return;
          const urls = objectProperty(node, 'urls') || objectProperty(node, 'url');
          const username = objectProperty(node, 'username');
          const credential = objectProperty(node, 'credential');
          const udp = objectProperty(node, 'udp');
          if (urls && username && credential && udp &&
              astNodeContains(urls.value, (candidate) => {
                const value = staticStringValue(candidate);
                return value !== null && /^turns?:/i.test(value);
              })) {
            embeddedTurnCredentialRows.push(node.start);
          }
        });
      }
    }
  }
  const conditionalRelayOverride = nodes('startPublisher', 'IfStatement').some((statement) => {
    const optionControlled = astNodeContains(statement.test, (node) => {
      const parts = memberExpressionPath(node);
      return parts && parts[0] === 'options' && parts.length > 1;
    });
    const pushesRelayOverride = astNodeContains(statement.consequent, (node) => {
      if (node.type !== 'CallExpression' || !isPath(node.callee, 'args.push')) return false;
      return node.arguments.some((argument) => {
        const value = staticStringValue(argument);
        return value !== null && /^--/.test(value) && /(?:turn|relay)/i.test(value);
      });
    });
    return optionControlled && pushesRelayOverride;
  });
  const fallbackCatchContinuation = [
    ...nodes('fetchValidatedTurnRegistryResponse', 'CatchClause'),
    ...nodes('resolveBrowserTurnConfiguration', 'CatchClause')
  ].some((handler) => !handler.body.body.some((statement) =>
    statement.type === 'ThrowStatement'));
  const localFallbackAbsent = embeddedTurnCredentialRows.length === 0 &&
    !conditionalRelayOverride && !persistedTurnIo && !fallbackCatchContinuation;

  const isolatedRtcObject = nodes('probeSelectedTurnEndpoint', 'ObjectExpression')
    .some((object) => {
      const property = objectProperty(object, 'iceServers');
      const array = property && unwrapAstExpression(property.value);
      return array && array.type === 'ArrayExpression' && array.elements.length === 1 &&
        array.elements[0] && array.elements[0].type === 'CallExpression' &&
        callCalleeName(array.elements[0]) === 'browserTurnServer' &&
        array.elements[0].arguments.some((argument) => isIdentifier(argument, 'endpoint'));
    });
  const ensureForOfStatements = nodes('ensureTurnFixture', 'ForOfStatement');
  const ensureProbesEndpoint = calls('ensureTurnFixture', 'probeSelectedTurnEndpoint')
    .some((call) => call.arguments.some((argument) => isIdentifier(argument, 'endpoint')));

  const browserProbeReturns = directReturns('probeBrowserTurn');
  const browserProbeLive = browserProbeReturns.length === 1 &&
    browserProbeReturns[0].argument && browserProbeReturns[0].argument.type === 'CallExpression' &&
    isPath(browserProbeReturns[0].argument.callee, 'page.evaluate');
  const browserSummaryReturns = directReturns('summarizeTurnBrowserProbe');
  const browserSummaryLive = browserSummaryReturns.length === 1 &&
    browserSummaryReturns[0].argument &&
    browserSummaryReturns[0].argument.type === 'ObjectExpression' &&
    calls('summarizeTurnBrowserProbe', 'filter').length > 0;
  const socketReturns = directReturns('probeTurnSocketAddress');
  const socketLive = socketReturns.length === 1 && socketReturns[0].argument &&
    socketReturns[0].argument.type === 'NewExpression' &&
    callCalleeName(socketReturns[0].argument) === 'Promise';
  const selectedReturns = directReturns('probeSelectedTurnEndpoint');
  const selectedLive = selectedReturns.length === 1 && selectedReturns[0].argument &&
    selectedReturns[0].argument.type === 'ObjectExpression' &&
    calls('probeSelectedTurnEndpoint', 'probeBrowserTurn').length >= 2 &&
    calls('probeSelectedTurnEndpoint', 'probeTurnSocketAddress').length >= 1;
  let probeAttemptCount = null;
  for (const statement of ast && ast.body ? ast.body : []) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier' &&
          declaration.id.name === 'TURN_ENDPOINT_PROBE_ATTEMPTS') {
        const primitive = staticPrimitiveValue(declaration.init);
        if (primitive.known) probeAttemptCount = primitive.value;
      }
    }
  }
  const leafNetworkOperations = browserProbeLive && browserSummaryLive && socketLive &&
    selectedLive && probeAttemptCount === 2;

  const flattenFetchedResponse = [
    ...calls('resolveBrowserTurnConfiguration', 'flattenValidatedTurnRegistryEndpoints'),
    ...calls('runRelayIceScenario', 'flattenValidatedTurnRegistryEndpoints')
  ].some((call) => call.arguments.some((argument) =>
    isIdentifier(argument, 'turnRegistryResponse')));
  const endpointSetBindsFetchedEndpoints = nodes('ensureTurnFixture', 'VariableDeclarator')
    .some((declaration) => declaration.id.type === 'Identifier' &&
      declaration.id.name === 'endpointSets' &&
      astNodeContains(declaration.init, (node) => node.type === 'Identifier' &&
        /(?:fetched|registry|selected)Endpoints/i.test(node.name)));
  const allFetchedEndpointsIterated = ensureForOfStatements.some((statement) => {
    const iteratesFetched = astNodeContains(statement.right, (node) =>
      (node.type === 'Identifier' &&
        /(?:fetched|registry|selected)Endpoints/i.test(node.name)) ||
      (endpointSetBindsFetchedEndpoints && isPath(node, 'endpointSet.endpoints')));
    return iteratesFetched && astNodeContains(statement.body, (node) =>
      node.type === 'CallExpression' && callCalleeName(node) === 'probeSelectedTurnEndpoint');
  });
  const endpointCountExact = nodes('ensureTurnFixture', 'BinaryExpression').some((node) =>
    ['===', '=='].includes(node.operator) && (
      (isPath(node.left, 'endpointProbes.length') &&
        nodeHasMemberPath(node.right, 'fetchedEndpoints.length')) ||
      (isPath(node.right, 'endpointProbes.length') &&
        nodeHasMemberPath(node.left, 'fetchedEndpoints.length'))
    ));
  const endpointSetsDeclaration = nodes('ensureTurnFixture', 'VariableDeclarator').find(
    (declaration) => declaration.id.type === 'Identifier' &&
      declaration.id.name === 'endpointSets'
  );
  const endpointSetUsesExactFetchedEndpoints = !!endpointSetsDeclaration &&
    astNodeContains(endpointSetsDeclaration.init, (node) => {
      if (node.type !== 'ObjectExpression') return false;
      const endpointsProperty = objectProperty(node, 'endpoints');
      return !!endpointsProperty && isIdentifier(endpointsProperty.value, 'fetchedEndpoints');
    });
  const endpointIdentityBody = getFacts('turnRegistryEndpointIdentity').functionNode
    ? sourceSlice(source, getFacts('turnRegistryEndpointIdentity').functionNode)
    : '';
  const ensureTurnSource = getFacts('ensureTurnFixture').functionNode
    ? sourceSlice(source, getFacts('ensureTurnFixture').functionNode)
    : '';
  const endpointIdentityCoversRawOrderedContent =
    calls('flattenValidatedTurnRegistryEndpoints', 'turnRegistryEndpointIdentity').length === 1 &&
    calls('turnRegistryEndpointIdentity', 'sha256Text').length === 1 &&
    ['registryServerIndex', 'registryUrlIndex', 'registryEndpointIndex', 'urls',
      'username', 'credential', 'udp'].every((field) =>
      new RegExp(`\\b${field}\\s*:`).test(endpointIdentityBody)) &&
    /registryEndpointIdentity\s*=\s*turnRegistryEndpointIdentity\s*\(\s*endpoint\s*\)/
      .test(sourceSlice(source, getFacts('flattenValidatedTurnRegistryEndpoints').functionNode));
  const endpointIdentityChainIsLoadBearing =
    /const\s+fetchedEndpointIdentities\s*=\s*turnFixture\.fetchedEndpointIdentities\s*;/
      .test(ensureTurnSource) &&
    /resolvedEndpointIdentities\s*=\s*fetchedEndpoints\.map\s*\(/.test(ensureTurnSource) &&
    /probedEndpointIdentities\s*=\s*endpointProbes\.map\s*\(/.test(ensureTurnSource) &&
    /identity\s*===\s*resolvedEndpointIdentities\[index\]/.test(ensureTurnSource) &&
    /identity\s*===\s*probedEndpointIdentities\[index\]/.test(ensureTurnSource) &&
    /new\s+Set\s*\(\s*fetchedEndpointIdentities\s*\)\.size\s*===\s*fetchedEndpointIdentities\.length/
      .test(ensureTurnSource) &&
    calls('ensureTurnFixture', 'requireHarnessFixture').some((call) =>
      call.arguments.length >= 3 &&
      staticStringValue(call.arguments[1]) === 'every-live-registry-turn-endpoint-is-probed' &&
      astNodeContains(call.arguments[2], (node) =>
        node.type === 'Identifier' && node.name === 'endpointIdentityChainExact'));

  const hostnameEvery = everyOver('ensureTurnFixture', 'hostnameAttempts');
  const addressEvery = everyOver('ensureTurnFixture', 'addressAttempts');
  const attemptsUseSome = calls('ensureTurnFixture', 'some').some((call) => {
    const callee = unwrapAstExpression(call.callee);
    return callee && callee.type === 'MemberExpression' &&
      ['hostnameAttempts', 'addressAttempts'].includes(
        memberPropertyName(unwrapAstExpression(callee.object))
      );
  });
  const requiredHealthTruths = [
    'everyOriginalHostnameAttemptAllocated',
    'everyResolvedAddressPassed',
    'rtcConfigRetainsOriginalHostnames'
  ];
  const guaranteedHealthTruths = (expression, beforePosition, visited = new Set()) => {
    const current = unwrapAstExpression(expression);
    if (!current) return new Set();
    if (current.type === 'Identifier') {
      if (requiredHealthTruths.includes(current.name)) return new Set([current.name]);
      if (visited.has(current.name)) return new Set();
      const declarations = nodes('ensureTurnFixture', 'VariableDeclarator')
        .filter((declaration) => declaration.start < beforePosition &&
          declaration.id.type === 'Identifier' && declaration.id.name === current.name &&
          declaration.init)
        .sort((left, right) => right.start - left.start);
      if (declarations.length === 0) return new Set();
      const nextVisited = new Set(visited);
      nextVisited.add(current.name);
      return guaranteedHealthTruths(
        declarations[0].init,
        declarations[0].start,
        nextVisited
      );
    }
    if (current.type === 'LogicalExpression') {
      const left = guaranteedHealthTruths(current.left, beforePosition, visited);
      const right = guaranteedHealthTruths(current.right, beforePosition, visited);
      if (current.operator === '&&') return new Set([...left, ...right]);
      if (current.operator === '||' || current.operator === '??') {
        return new Set([...left].filter((name) => right.has(name)));
      }
      return new Set();
    }
    if (current.type === 'ConditionalExpression') {
      const consequent = guaranteedHealthTruths(
        current.consequent,
        beforePosition,
        visited
      );
      const alternate = guaranteedHealthTruths(
        current.alternate,
        beforePosition,
        visited
      );
      return new Set([...consequent].filter((name) => alternate.has(name)));
    }
    if (current.type === 'CallExpression' && callCalleeName(current) === 'Boolean' &&
        current.arguments.length === 1) {
      return guaranteedHealthTruths(current.arguments[0], beforePosition, visited);
    }
    if (current.type === 'UnaryExpression' && current.operator === '!' &&
        unwrapAstExpression(current.argument)?.type === 'UnaryExpression' &&
        unwrapAstExpression(current.argument).operator === '!') {
      return guaranteedHealthTruths(
        unwrapAstExpression(current.argument).argument,
        beforePosition,
        visited
      );
    }
    if (current.type === 'BinaryExpression' &&
        ['===', '==', '!==', '!='].includes(current.operator)) {
      const leftPrimitive = staticPrimitiveValue(current.left);
      const rightPrimitive = staticPrimitiveValue(current.right);
      if (rightPrimitive.known &&
          ((['===', '=='].includes(current.operator) && rightPrimitive.value === true) ||
            (['!==', '!='].includes(current.operator) && rightPrimitive.value === false))) {
        return guaranteedHealthTruths(current.left, beforePosition, visited);
      }
      if (leftPrimitive.known &&
          ((['===', '=='].includes(current.operator) && leftPrimitive.value === true) ||
            (['!==', '!='].includes(current.operator) && leftPrimitive.value === false))) {
        return guaranteedHealthTruths(current.right, beforePosition, visited);
      }
    }
    return new Set();
  };
  const healthRequirementCandidates = calls('ensureTurnFixture', 'requireHarnessFixture')
    .filter((call) => call.arguments.length >= 3)
    .map((call) => ({
      call,
      truths: guaranteedHealthTruths(call.arguments[2], call.start)
    }))
    .sort((left, right) => right.truths.size - left.truths.size);
  const healthPredicateTruths = healthRequirementCandidates.length > 0
    ? healthRequirementCandidates[0].truths
    : new Set();
  const healthPredicateBindsAllRequiredTruths = requiredHealthTruths.every((name) =>
    healthPredicateTruths.has(name));

  const forOfIteratesEveryAddress = nodes('probeSelectedTurnEndpoint', 'ForOfStatement')
    .some((statement) => {
      const right = unwrapAstExpression(statement.right);
      if (isPath(right, 'endpoint.addresses')) return true;
      return right && right.type === 'ArrayExpression' && right.elements.length === 1 &&
        right.elements[0] && right.elements[0].type === 'SpreadElement' &&
        isPath(right.elements[0].argument, 'endpoint.addresses');
    });
  const selectedEndpointProbeFunction = getFacts('probeSelectedTurnEndpoint').functionNode;
  const indexedLoopIteratesEveryAddress = nodes('probeSelectedTurnEndpoint', 'ForStatement')
    .some((statement) => {
      const declaredIndexes = [];
      if (statement.init && statement.init.type === 'VariableDeclaration') {
        for (const declaration of statement.init.declarations) {
          if (declaration.id.type === 'Identifier' && isLiteralNumber(declaration.init, 0)) {
            declaredIndexes.push({
              name: declaration.id.name,
              functionScoped: statement.init.kind === 'var',
              initializer: declaration
            });
          }
        }
      }
      return declaredIndexes.some(({ name: indexName, functionScoped, initializer }) => {
        const update = unwrapAstExpression(statement.update);
        const test = unwrapAstExpression(statement.test);
        const boundedByEveryAddress = test && test.type === 'BinaryExpression' && (
          (test.operator === '<' && isIdentifier(test.left, indexName) &&
            isPath(test.right, 'endpoint.addresses.length')) ||
          (test.operator === '>' && isPath(test.left, 'endpoint.addresses.length') &&
            isIdentifier(test.right, indexName)) ||
          (['!=', '!=='].includes(test.operator) && (
            (isIdentifier(test.left, indexName) &&
              isPath(test.right, 'endpoint.addresses.length')) ||
            (isPath(test.left, 'endpoint.addresses.length') &&
              isIdentifier(test.right, indexName))
          ))
        );
        const advancesIndexByOne = !!update && (
          (update.type === 'UpdateExpression' && update.operator === '++' &&
            isIdentifier(update.argument, indexName)) ||
          (update.type === 'AssignmentExpression' && update.operator === '+=' &&
            isIdentifier(update.left, indexName) && isLiteralNumber(update.right, 1)) ||
          (update.type === 'AssignmentExpression' && update.operator === '=' &&
            isIdentifier(update.left, indexName) &&
            unwrapAstExpression(update.right)?.type === 'BinaryExpression' &&
            unwrapAstExpression(update.right).operator === '+' && (
              (isIdentifier(unwrapAstExpression(update.right).left, indexName) &&
                isLiteralNumber(unwrapAstExpression(update.right).right, 1)) ||
              (isLiteralNumber(unwrapAstExpression(update.right).left, 1) &&
                isIdentifier(unwrapAstExpression(update.right).right, indexName))
            ))
        );
        const inductionVariableWrites = [];
        const bindingParents = new Map();
        walkTargetAst(selectedEndpointProbeFunction, (candidate, parent) => {
          if (parent) bindingParents.set(candidate, parent);
        });
        // A var index belongs to the enclosing function, but direct writes that execute
        // sequentially before or after this loop cannot change an iteration. Nested
        // helpers are different: declarations anywhere in the function can be invoked
        // from the loop, so follow callable bindings and aliases from the loop body.
        const writeSearchRoot = functionScoped ? selectedEndpointProbeFunction : statement;
        const reachableNestedFunctions = reachableNestedFunctionsFromLoop(
          selectedEndpointProbeFunction,
          statement,
          bindingParents
        );
        const refersToInductionVariable = (identifier) => {
          let ancestor = bindingParents.get(identifier);
          while (ancestor && ancestor !== writeSearchRoot) {
            if (lexicalScopeDeclaresIdentifier(ancestor, indexName, identifier)) return false;
            ancestor = bindingParents.get(ancestor);
          }
          return ancestor === writeSearchRoot;
        };
        const nestedOwner = (candidate) => {
          let ancestor = bindingParents.get(candidate);
          while (ancestor && ancestor !== selectedEndpointProbeFunction) {
            if (isFunctionAstNode(ancestor)) return ancestor;
            ancestor = bindingParents.get(ancestor);
          }
          return null;
        };
        walkTargetAst(writeSearchRoot, (candidate) => {
          let targets = [];
          if (candidate.type === 'AssignmentExpression' ||
              candidate.type === 'UpdateExpression') {
            targets = assignedPatternIdentifierNodes(
              candidate.type === 'AssignmentExpression'
                ? candidate.left
                : candidate.argument
            );
          } else if (candidate.type === 'ForOfStatement' ||
              candidate.type === 'ForInStatement') {
            targets = assignedPatternIdentifierNodes(candidate.left);
          } else if (functionScoped && candidate !== initializer &&
              candidate.type === 'VariableDeclarator' && candidate.init) {
            targets = assignedPatternIdentifierNodes(candidate.id);
          }
          const writesInductionBinding = targets.some((identifier) =>
            identifier.name === indexName && refersToInductionVariable(identifier));
          if (!writesInductionBinding || candidate === initializer || candidate === update) {
            return;
          }
          const owner = nestedOwner(candidate);
          const directlyExecutesWithinLoop = !owner && astNodeRangeContains(
            statement,
            candidate
          );
          if (directlyExecutesWithinLoop ||
              (owner && reachableNestedFunctions.has(owner))) {
            inductionVariableWrites.push(candidate);
          }
        });
        const updateOwnsOnlyInductionVariableWrite =
          inductionVariableWrites.length === 0;
        const readsIndexedAddress = astNodeContains(statement.body, (node) => {
          const current = unwrapAstExpression(node);
          return current && current.type === 'MemberExpression' && current.computed &&
            isPath(current.object, 'endpoint.addresses') &&
            isIdentifier(current.property, indexName);
        });
        return boundedByEveryAddress && advancesIndexByOne &&
          updateOwnsOnlyInductionVariableWrite && readsIndexedAddress;
      });
    });
  const iteratesEveryAddress = forOfIteratesEveryAddress ||
    indexedLoopIteratesEveryAddress;
  const addressAttemptCount = nodes('ensureTurnFixture', 'BinaryExpression').some((node) =>
    ['===', '=='].includes(node.operator) &&
      astNodeContains(node, (candidate) => candidate.type === 'BinaryExpression' &&
        candidate.operator === '*' &&
        nodeHasMemberPath(candidate, 'endpoint.addresses.length') &&
        astNodeContains(candidate, (child) => child.type === 'Identifier' &&
          child.name === 'TURN_ENDPOINT_PROBE_ATTEMPTS')));
  const nonemptyAddresses = comparisonOfPathAndNumber(
    'ensureTurnFixture',
    'endpoint.addresses.length',
    0,
    ['>', '!==', '!=']
  );

  const nonUdpUnambiguous = nodes('probeSelectedTurnEndpoint', 'LogicalExpression')
    .some((node) => node.operator === '||' &&
      (nodeHasMemberPath(node.left, 'endpoint.udp') ||
        nodeHasMemberPath(node.right, 'endpoint.udp')) &&
      astNodeContains(node, (candidate) => candidate.type === 'BinaryExpression' &&
        ['===', '=='].includes(candidate.operator) && (
          (nodeHasMemberPath(candidate.left, 'endpoint.addresses.length') &&
            isLiteralNumber(candidate.right, 1)) ||
          (nodeHasMemberPath(candidate.right, 'endpoint.addresses.length') &&
            isLiteralNumber(candidate.left, 1))
        )));
  const requiresUnambiguous = nodes('ensureTurnFixture').some((node) =>
    isPath(node, 'endpoint.nonUdpAddressCoverageUnambiguous'));
  const failClosedLiteral = hasReachableString('ensureTurnFixture', /^fail-closed$/);

  const tlsOptions = calls('probeTurnSocketAddress', 'connect').some((call) => {
    const calleePath = memberExpressionPath(unwrapAstExpression(call.callee));
    let options = call.arguments.find((argument) => argument.type === 'ObjectExpression');
    if (!options) {
      const optionIdentifier = call.arguments.find((argument) =>
        unwrapAstExpression(argument)?.type === 'Identifier');
      if (optionIdentifier) {
        const optionName = unwrapAstExpression(optionIdentifier).name;
        const declarations = nodes('probeTurnSocketAddress', 'VariableDeclarator')
          .filter((declaration) => declaration.start < call.start &&
            declaration.id.type === 'Identifier' && declaration.id.name === optionName &&
            unwrapAstExpression(declaration.init)?.type === 'ObjectExpression')
          .sort((left, right) => right.start - left.start);
        options = declarations.length > 0
          ? unwrapAstExpression(declarations[0].init)
          : null;
      }
    }
    const servername = objectProperty(options, 'servername');
    const rejectUnauthorized = objectProperty(options, 'rejectUnauthorized');
    return calleePath && calleePath.join('.') === 'tls.connect' && servername &&
      isPath(servername.value, 'parsed.hostname') && rejectUnauthorized &&
      staticTruthValue(rejectUnauthorized.value) === true;
  });
  const verifiesSocketAuthorization = nodes('probeTurnSocketAddress').some((node) =>
    isPath(node, 'socket.authorized'));
  const turnsUsesPlaintextNet = calls('probeTurnSocketAddress', 'connect').some((call) => {
    const calleePath = memberExpressionPath(unwrapAstExpression(call.callee));
    if (!calleePath || calleePath.join('.') !== 'net.connect') return false;
    let parent = getFacts('probeTurnSocketAddress').parents.get(call);
    while (parent && parent !== getFacts('probeTurnSocketAddress').functionNode) {
      if (parent.type === 'IfStatement' &&
          astNodeContains(parent.consequent, (node) => node === call) &&
          astNodeContains(parent.test, (node) => isPath(node, 'parsed.scheme')) &&
          astNodeContains(parent.test, (node) => staticStringValue(node) === 'turns')) {
        return true;
      }
      parent = getFacts('probeTurnSocketAddress').parents.get(parent);
    }
    return false;
  });

  const resolverTruncatesAddresses = calls('resolveTurnEndpointAddresses').some((call) => {
    const callee = unwrapAstExpression(call.callee);
    const property = callee && callee.type === 'MemberExpression'
      ? memberPropertyName(callee)
      : '';
    if (!['slice', 'splice', 'shift', 'pop'].includes(property)) return false;
    return astNodeContains(callee.object, (node) => {
      const pathParts = memberExpressionPath(node);
      return (pathParts && pathParts.includes('addresses')) ||
        (node.type === 'Identifier' && ['addresses', 'lookups'].includes(node.name));
    });
  });

  const healthBypassReferences = nodes('ensureTurnFixture').some((node) => {
    const pathParts = memberExpressionPath(node);
    return (pathParts && pathParts.length >= 2 &&
      pathParts[0] === 'process' && pathParts[1] === 'env') ||
      (node.type === 'Identifier' && node.name === 'ALLOW_DEAD_TURN');
  });
  const attemptTestSentinel = nodes('ensureTurnFixture').some((node) => {
    const pathParts = memberExpressionPath(node);
    return pathParts && pathParts[0] === 'attempt' && pathParts.includes('test');
  });
  const fabricatesAttemptSuccess = ['ensureTurnFixture', 'probeSelectedTurnEndpoint']
    .some((name) => nodes(name).some((node) => {
      if (node.type === 'AssignmentExpression' &&
          staticTruthValue(node.right) === true) {
        const pathParts = memberExpressionPath(unwrapAstExpression(node.left));
        return pathParts && pathParts[pathParts.length - 1] === 'ok';
      }
      if (name === 'ensureTurnFixture' && node.type === 'ObjectExpression') {
        const okProperty = objectProperty(node, 'ok');
        return !!okProperty && staticTruthValue(okProperty.value) === true;
      }
      return false;
    }));

  const ensureTurnCalls = calls('runRelayIceScenario', 'ensureTurnFixture');
  const ensureFailurePropagates = ensureTurnCalls.length === 1 &&
    !ensureTurnCalls.some((ensureCall) => {
      let parent = getFacts('runRelayIceScenario').parents.get(ensureCall);
      while (parent && parent !== getFacts('runRelayIceScenario').functionNode) {
        if (parent.type === 'CallExpression') {
          const callee = unwrapAstExpression(parent.callee);
          if (callee && callee.type === 'MemberExpression' &&
              memberPropertyName(callee) === 'catch' &&
              astNodeContains(callee.object, (node) => node === ensureCall)) {
            return true;
          }
        }
        parent = getFacts('runRelayIceScenario').parents.get(parent);
      }
      return false;
    });

  const relayAcceptedEvidence = hasReachableString(
    'runRelayIceScenario',
    /^packaged-turn-live-registry-response-accepted$/
  );
  const recoveryEnteredEvidence = hasReachableString(
    'runRecoveryScenario',
    /^packaged-turn-live-registry-workflow-entered$/
  );
  const timeExpression = (node) => {
    const current = unwrapAstExpression(node);
    if (!current) return false;
    if (current.type === 'CallExpression' && isPath(current.callee, 'Date.now')) return true;
    if (current.type === 'CallExpression' && callCalleeName(current) === 'Number' &&
        current.arguments.length === 1) {
      const argument = unwrapAstExpression(current.arguments[0]);
      return argument && argument.type === 'NewExpression' &&
        callCalleeName(argument) === 'Date';
    }
    return false;
  };
  const startedAt = nodes('runRelayIceScenario', 'VariableDeclarator').find((node) =>
    node.id.type === 'Identifier' && node.id.name === 'turnRegistryFetchStartedAtMs' &&
      timeExpression(node.init));
  const completedAt = nodes('runRelayIceScenario', 'VariableDeclarator').find((node) =>
    node.id.type === 'Identifier' && node.id.name === 'turnRegistryFetchCompletedAtMs' &&
      timeExpression(node.init));
  const relayMatchCall = calls('runRelayIceScenario', 'matchPackagedTurnResponse').find((call) => {
    const identifierNames = new Set();
    for (const argument of call.arguments) {
      walkTargetAst(argument, (node) => {
        if (node.type === 'Identifier') identifierNames.add(node.name);
      });
    }
    return ['turnRegistryTransactionId', 'turnRegistryFetchStartedAtMs',
      'turnRegistryFetchCompletedAtMs'].every((name) => identifierNames.has(name)) &&
      [...identifierNames].some((name) => /responseSha256/i.test(name));
  });
  const fetchFresh = !!startedAt && !!completedAt && relayFetchCalls.length === 1 &&
    startedAt.start < relayFetchCalls[0].start &&
    completedAt.start > relayFetchCalls[0].start && !!relayMatchCall;

  const outputSplit = calls('runRelayIceScenario', 'split').some((call) =>
    isPath(unwrapAstExpression(call.callee).object, 'publisher.output') ||
      astNodeContains(call.callee, (node) => node.type === 'CallExpression' &&
        isPath(node.callee, 'publisher.output')));
  const isCollectionFilter = (call, collectionName) => {
    const callee = unwrapAstExpression(call.callee);
    if (callee && callee.type === 'MemberExpression' &&
        memberPropertyName(callee) === 'filter' && isIdentifier(callee.object, collectionName)) {
      return true;
    }
    const pathParts = memberExpressionPath(callee);
    return pathParts && pathParts.join('.') === 'Array.prototype.filter.call' &&
      call.arguments.length > 0 && isIdentifier(call.arguments[0], collectionName);
  };
  const summaryFilters = calls('runRelayIceScenario', 'filter').filter((call) =>
    isCollectionFilter(call, 'publisherOutputLines'));
  const summaryFilterSources = summaryFilters.map((call) => sourceSlice(source, call));
  const uniqueSummaryFilters = summaryFilters.length === 2 &&
    summaryFilterSources.some((text) => /TurnRegistryFetch/.test(text)) &&
    summaryFilterSources.some((text) => /ConsumedIceConfig/.test(text));
  const uniqueSummaryCounts = comparisonOfPathAndNumber(
    'runRelayIceScenario', 'nativeTurnRegistryFetchLines.length', 1, ['===', '==']
  ) && comparisonOfPathAndNumber(
    'runRelayIceScenario', 'consumedIceConfigLines.length', 1, ['===', '==']
  );
  const connectCall = calls('runRelayIceScenario', 'connectNewPeer')[0];
  const summariesAfterConnect = !!connectCall && summaryFilters.every((call) =>
    call.start > connectCall.start);

  const consumedComparisons = [
    equalityBetween(
      'runRelayIceScenario',
      'observedConsumedTransactionId',
      'matchedTurnResponse.transactionId'
    ),
    equalityBetween(
      'runRelayIceScenario',
      'observedConsumedResponseSha256',
      'matchedTurnResponse.responseSha256'
    ),
    equalityBetween(
      'runRelayIceScenario',
      'observedConsumedTurnSha256',
      'matchedTurnResponse.configSha256'
    ),
    equalityBetween(
      'runRelayIceScenario',
      'observedConsumedTurnCount',
      'matchedTurnResponse.servers.length'
    )
  ];
  const rewritesExpectedConsumedProvenance = nodes('runRelayIceScenario')
    .some((node) => {
      if (!['AssignmentExpression', 'UpdateExpression'].includes(node.type)) return false;
      const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
      const pathParts = memberExpressionPath(unwrapAstExpression(target));
      return pathParts && pathParts[0] === 'matchedTurnResponse' &&
        ['transactionId', 'responseSha256', 'configSha256', 'servers']
          .includes(pathParts[1]);
    });
  const consumedTokens = ['turnRegistryTransactionId', 'turnRegistryResponseSha256',
    'turnConfigV1Sha256'].every((token) => calls('runRelayIceScenario', 'exactIceSummaryToken')
    .some((call) => call.arguments.some((argument) => staticStringValue(argument) === token)));

  const prefixDeclared = (ast && ast.body ? ast.body : []).some((statement) =>
    statement.type === 'VariableDeclaration' && statement.declarations.some((declaration) =>
      declaration.id.type === 'Identifier' &&
      declaration.id.name === 'TURN_REGISTRY_CONFIG_V1_PREFIX' &&
      staticStringValue(declaration.init) === 'game-capture-turn-registry-config-v1'));
  const hashCallsCanonical = calls('turnRegistryResponseSha256', 'canonicalTurnRegistryResponseV1')
    .length === 1;

  const redactionCalled = [
    ...calls('runRelayIceScenario', 'redactTurnSecrets'),
    ...calls('run', 'redactTurnSecrets')
  ].length > 0;
  let exposesSecretProperty = false;
  for (const name of ['runRelayIceScenario', 'run']) {
    for (const object of nodes(name, 'ObjectExpression')) {
      for (const key of ['username', 'credential', 'rawResponse']) {
        const property = objectProperty(object, key);
        if (property && astNodeContains(property.value, (candidate) => {
          const parts = memberExpressionPath(candidate);
          return parts && ['server', 'matchedTurnResponse'].includes(parts[0]);
        })) exposesSecretProperty = true;
      }
    }
  }

  const runRecoveryCalls = calls('run', 'runRecoveryScenario');
  const runHasRelayDispatch = runRecoveryCalls.length === 1 &&
    hasReachableString('run', /^relay$/) &&
    nodes('run').some((node) => isPath(node, 'config.scenario'));
  const relayConsumedEvidence = hasReachableString(
    'runRelayIceScenario',
    /^packaged-turn-consumed-config-matches-fetched-response$/
  );

  const results = new Map();
  const put = (id, ok, detail) => results.set(id, { ok: !!ok, detail });
  put(
    'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH',
    readinessBarrierIsStructurallySound,
    `calls=${readinessCalls.length} fetches=${readinessFetchCalls.length} ` +
      `beforeFetch=${readinessCalls.length === 1 && readinessFetchCalls.length === 1 &&
        readinessCalls[0].start < readinessFetchCalls[0].start} ` +
      `awaited=${readinessCallIsAwaited} neutralArgs=${readinessCallArgumentsAreNeutral} ` +
      `fixedDeadline=${readinessDeadlineIsFixed} pcs=${readinessPcConstructions.length} ` +
      `dataDocument=${readinessUsesDeterministicDataDocument} ` +
      `preProbeSettle=${readinessPreProbeSettleIsDeterministic} ` +
      `settleEvidence=${readinessHasPreProbeSettleEvidence} ` +
      `runnerDeadlineCounters=${readinessHasRunnerOwnedDeadlineAndCounters} ` +
      `boundedPageOps=${readinessEveryPageOperationIsExternallyBounded} ` +
      `documentEvidence=${readinessRequiresDocumentContextEvidence} ` +
      `rtcOps=${readinessHasGenuineRtcOperations} ` +
      `transitionVerdict=${readinessVerdictRequiresObservedTransition} closesPc=${readinessClosesPc} ` +
      `closesContext=${readinessClosesContext} registryCoupled=` +
      `${readinessHasForbiddenRegistryCoupling} globalReuse=${readinessHasGlobalReuse}`
  );
  put(
    'TURN_REGISTRY_FETCH_IS_SCOPED_TO_TURN_USE',
    relayFetchCalls.length === 1 && !!relayFetchDeclaration && relayResponseConsumed &&
      recoveryRelayCalls.length === 1 && topLevelTurnRegistryCaches.length === 0 &&
      globalTurnRegistryCacheReferences.length === 0 && !persistedTurnIo,
    `reachableRelayFetches=${relayFetchCalls.length} responseDeclaration=` +
      `${!!relayFetchDeclaration} recoveryRelayCalls=${recoveryRelayCalls.length} ` +
      `topLevelCaches=${topLevelTurnRegistryCaches.join(',') || 'none'} ` +
      `globalCaches=${globalTurnRegistryCacheReferences.length}`
  );
  put(
    'TURN_REGISTRY_HTTP_200_VERSIONED_SCHEMA_IS_REQUIRED',
    executableContract.extractedOk && executableContract.behavior.schema.ok &&
      fetchHasLiveUrl && fetchCallsNetwork && fetchChecksStatus &&
      fetchParsesJson && fetchValidates,
    `${executableContract.detail} liveUrl=${fetchHasLiveUrl} fetch=${fetchCallsNetwork} ` +
      `status200=${fetchChecksStatus} json=${fetchParsesJson} validate=${fetchValidates}`
  );
  put(
    'TURN_REGISTRY_RESPONSE_IS_NONEMPTY_AND_WHOLELY_VALID',
    executableContract.extractedOk && schemaCasesPass &&
      executableContract.behavior.schema.ok,
    `${executableContract.detail} schemaCases=${schemaCasesPass}`
  );
  put(
    'TURN_REGISTRY_FAILURE_HAS_NO_LOCAL_FALLBACK',
    localFallbackAbsent,
    `embeddedCredentialRows=${embeddedTurnCredentialRows.length} ` +
      `conditionalRelayOverride=${conditionalRelayOverride} persistedTurnIo=${persistedTurnIo} ` +
      `catchContinues=${fallbackCatchContinuation}`
  );
  put(
    'TURN_FETCHED_CONFIG_ORDER_URLS_CREDENTIALS_AND_UDP_ARE_PRESERVED',
    executableContract.extractedOk && executableContract.behavior.flatten.ok &&
      executableContract.behavior.ice.ok && contractCase('fixture-a') &&
      contractCase('string-urls-preserved') && contractCase('array-order-preserved'),
    `${executableContract.detail} preservationCases=` +
      `${['fixture-a', 'string-urls-preserved', 'array-order-preserved'].every(contractCase)}`
  );
  put(
    'TURN_ENDPOINTS_ARE_PROBED_IN_ISOLATION',
    isolatedRtcObject && ensureForOfStatements.length >= 2 && ensureProbesEndpoint,
    `isolatedRtcObject=${isolatedRtcObject} ensureForOf=${ensureForOfStatements.length} ` +
      `probeCall=${ensureProbesEndpoint}`
  );
  put(
    'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
    leafNetworkOperations,
    `browser=${browserProbeLive} summary=${browserSummaryLive} socket=${socketLive} ` +
      `selected=${selectedLive} attempts=${String(probeAttemptCount)}`
  );
  put(
    'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED',
    flattenFetchedResponse && endpointSetUsesExactFetchedEndpoints &&
      allFetchedEndpointsIterated && ensureProbesEndpoint && endpointCountExact &&
      endpointIdentityCoversRawOrderedContent && endpointIdentityChainIsLoadBearing,
    `flatten=${flattenFetchedResponse} iterated=${allFetchedEndpointsIterated} ` +
      `probe=${ensureProbesEndpoint} exactCount=${endpointCountExact} ` +
      `exactSource=${endpointSetUsesExactFetchedEndpoints} ` +
      `identityContent=${endpointIdentityCoversRawOrderedContent} ` +
      `identityChain=${endpointIdentityChainIsLoadBearing}`
  );
  put(
    'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT',
    hostnameEvery && addressEvery && !attemptsUseSome &&
      !healthBypassReferences && !attemptTestSentinel && !fabricatesAttemptSuccess &&
      healthPredicateBindsAllRequiredTruths &&
      requiredHealthTruths.every((identifier) =>
        nodes('ensureTurnFixture', 'Identifier').some((node) => node.name === identifier)),
    `hostnameEvery=${hostnameEvery} addressEvery=${addressEvery} some=${attemptsUseSome} ` +
      `envBypass=${healthBypassReferences} testSentinel=${attemptTestSentinel} ` +
      `fabricatedOk=${fabricatesAttemptSuccess} healthPredicateGuarantees=` +
      `${[...healthPredicateTruths].sort().join(',') || 'none'}`
  );
  put(
    'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED',
    iteratesEveryAddress && addressAttemptCount && nonemptyAddresses &&
      criticalControlFlow.resolver.ok &&
      !resolverTruncatesAddresses &&
      forbiddenRuntime.integrityTampering.dns.length === 0 &&
      forbiddenRuntime.integrityTampering.promise.length === 0,
    `iterates=${iteratesEveryAddress} forOf=${forOfIteratesEveryAddress} ` +
      `indexed=${indexedLoopIteratesEveryAddress} count=${addressAttemptCount} ` +
      `nonempty=${nonemptyAddresses} resolver=${criticalControlFlow.resolver.ok} ` +
      `resolverTruncation=${resolverTruncatesAddresses} ` +
      `dnsTampering=${forbiddenRuntime.integrityTampering.dns.length} ` +
      `promiseTampering=${forbiddenRuntime.integrityTampering.promise.length}`
  );
  put(
    'TURN_NON_UDP_MULTI_ADDRESS_COVERAGE_FAILS_CLOSED',
    nonUdpUnambiguous && requiresUnambiguous && failClosedLiteral,
    `unambiguous=${nonUdpUnambiguous} required=${requiresUnambiguous} ` +
      `failClosed=${failClosedLiteral}`
  );
  put(
    'TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION',
    tlsOptions && verifiesSocketAuthorization && !turnsUsesPlaintextNet &&
      forbiddenRuntime.integrityTampering.tls.length === 0,
    `tlsOptions=${tlsOptions} authorized=${verifiesSocketAuthorization} ` +
      `turnsPlaintext=${turnsUsesPlaintextNet} ` +
      `tlsTampering=${forbiddenRuntime.integrityTampering.tls.length}`
  );
  put(
    'PACKAGED_TURN_SCENARIO_USES_LIVE_REGISTRY_WITHOUT_FORCE_FALLBACK',
    fetchHasLiveUrl && localFallbackAbsent && recoveryRelayCalls.length === 1 &&
      recoveryEnteredEvidence && relayAcceptedEvidence && ensureFailurePropagates,
    `liveUrl=${fetchHasLiveUrl} noFallback=${localFallbackAbsent} recovery=` +
      `${recoveryRelayCalls.length} entered=${recoveryEnteredEvidence} ` +
      `accepted=${relayAcceptedEvidence} ensureRejectsPropagate=${ensureFailurePropagates}`
  );
  put(
    'PACKAGED_TURN_FETCH_IS_FRESH_AND_EXPLICIT',
    fetchFresh,
    `started=${!!startedAt} fetches=${relayFetchCalls.length} completed=${!!completedAt} ` +
      `boundedMatch=${!!relayMatchCall}`
  );
  put(
    'PACKAGED_TURN_REQUIRES_UNIQUE_FETCH_AND_CONSUMPTION_SUMMARIES',
    outputSplit && uniqueSummaryFilters && uniqueSummaryCounts && summariesAfterConnect,
    `outputSplit=${outputSplit} filters=${summaryFilters.length} uniqueCounts=` +
      `${uniqueSummaryCounts} afterConnect=${summariesAfterConnect}`
  );
  put(
    'PACKAGED_TURN_SAME_RUN_PROVENANCE_OR_BOUNDED_MATCH_IS_PROVEN',
    executableContract.extractedOk && executableContract.behavior.match.ok && !!relayMatchCall,
    `${executableContract.detail} randomizedMatch=${executableContract.behavior.match.ok} ` +
      `reachableMatch=${!!relayMatchCall}`
  );
  put(
    'PACKAGED_TURN_CONSUMED_CONFIG_MATCHES_FETCHED_RESPONSE',
    consumedTokens && consumedComparisons.every(Boolean) && relayConsumedEvidence &&
      !rewritesExpectedConsumedProvenance,
    `tokens=${consumedTokens} comparisons=${consumedComparisons.join(',')} ` +
      `evidence=${relayConsumedEvidence} rewritesExpected=` +
      `${rewritesExpectedConsumedProvenance}`
  );
  put(
    'PACKAGED_TURN_RESPONSE_HASH_BINDS_FULL_ORDERED_CONFIG',
    executableContract.extractedOk && executableContract.behavior.canonicalHash.ok &&
      prefixDeclared && hashCallsCanonical,
    `${executableContract.detail} prefix=${prefixDeclared} canonicalHash=${hashCallsCanonical}`
  );
  put(
    'TURN_DIAGNOSTICS_AND_REPORTS_REDACT_CREDENTIALS',
    executableContract.extractedOk && executableContract.behavior.redaction.ok &&
      redactionCalled && !exposesSecretProperty,
    `${executableContract.detail} redactionCall=${redactionCalled} ` +
      `exposesSecretProperty=${exposesSecretProperty}`
  );
  put(
    'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE',
    runHasRelayDispatch && recoveryEnteredEvidence && recoveryRelayCalls.length === 1 &&
      relayAcceptedEvidence && relayConsumedEvidence,
    `runDispatch=${runHasRelayDispatch} recoveryEntered=${recoveryEnteredEvidence} ` +
      `recoveryRelay=${recoveryRelayCalls.length} accepted=${relayAcceptedEvidence} ` +
      `consumed=${relayConsumedEvidence}`
  );
  return { results, executableContract };
}

function analyze(source) {
  const executableSource = maskComments(source);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const parsedTarget = parseTargetJavaScript(source);
  const forbiddenRuntime = auditForbiddenRuntimeConstructs(parsedTarget.ast);
  const criticalControlFlow = auditTurnCriticalControlFlow(parsedTarget.ast);
  const bindingAudit = auditLoadBearingFunctionBindings(source);
  add(
    'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE',
    bindingAudit.ok,
    bindingAudit.detail
  );
  add(
    'TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE',
    parsedTarget.ok && forbiddenRuntime.dynamicCode.length === 0,
    `parser=${parsedTarget.ok ? 'acorn' : parsedTarget.error} ` +
      `dynamic=${forbiddenRuntime.dynamicCode.join(',') || 'none'}`
  );
  const calls = startPublisherCalls(executableSource).map((call) => ({
    ...call,
    options: publisherOptions(call.text)
  }));
  const callNames = calls.map((call) => call.functionName).sort();
  const expectedNames = [...expectedScenarioFunctions].sort();

  add(
    'MEDIA_PUBLISHER_CALLSET_EXACT',
    JSON.stringify(callNames) === JSON.stringify(expectedNames),
    `observed=${callNames.join(',')} expected=${expectedNames.join(',')}`
  );

  const missingSource = calls
    .filter((call) => {
      const values = call.options.filter((property) => property.name === 'source');
      return values.length !== 1 || !/^['"]spout['"]$/.test(values[0].value);
    })
    .map((call) => call.functionName);
  add(
    'ALL_MEDIA_PUBLISHERS_PIN_SPOUT_SOURCE',
    missingSource.length === 0,
    `missing=${missingSource.join(',') || 'none'}`
  );

  const missingSender = calls
    .filter((call) => {
      const values = call.options.filter((property) => property.name === 'spoutSender');
      return values.length !== 1 ||
        !/^(?:mediaFixture|fixtures)\.senderName$/.test(values[0].value);
    })
    .map((call) => call.functionName);
  add(
    'ALL_MEDIA_PUBLISHERS_PIN_UNIQUE_SPOUT_SENDER',
    missingSender.length === 0,
    `missing=${missingSender.join(',') || 'none'}`
  );

  const startPublisherBody = functionBody(executableSource, 'startPublisher');
  add(
    'START_PUBLISHER_FORWARDS_SOURCE_ARGUMENT',
    /args\.push\(`--source=\$\{options\.source\}`\)/.test(startPublisherBody),
    'startPublisher must forward the explicit source unchanged'
  );
  add(
    'START_PUBLISHER_FORWARDS_SPOUT_SENDER_ARGUMENT',
    /args\.push\(`--spout-sender=\$\{options\.spoutSender\}`\)/.test(startPublisherBody),
    'startPublisher must forward the exact unique sender name unchanged'
  );

  const fixtureBody = functionBody(executableSource, 'startSignalingMediaFixture');
  const runBody = functionBody(executableSource, 'run');
  const addCheckBody = functionBody(executableSource, 'addCheck');
  const requireHarnessFixtureBody = functionBody(
    executableSource,
    'requireHarnessFixture'
  );
  add(
    'VERDICT_RECORDERS_PRESERVE_FAILURES',
    /report\.checks\.push\(\{\s*name,\s*ok:\s*!!ok,\s*classification:\s*['"]behavior['"],\s*state:\s*state\s*\|\|\s*\{\}\s*\}\)/.test(addCheckBody) &&
      !/ok:\s*true/.test(addCheckBody) &&
      /const\s+requirement\s*=\s*\{\s*name,\s*ok:\s*!!ok,\s*classification:\s*['"]harness-prerequisite['"]/.test(requireHarnessFixtureBody) &&
      /report\.harnessRequirements\.push\(requirement\)/.test(requireHarnessFixtureBody) &&
      /if\s*\(\s*!ok\s*\)\s*\{[\s\S]{0,500}?error\.harnessRequirement\s*=\s*requirement[\s\S]{0,200}?throw\s+error/.test(requireHarnessFixtureBody),
    'behavior checks must store the caller result exactly, and a false harness prerequisite must be recorded then thrown'
  );
  add(
    'FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES',
    /report\.ok\s*=\s*report\.harnessErrors\.length\s*===\s*0\s*&&\s*report\.checks\.length\s*>\s*0\s*&&\s*report\.checks\.every\(\(check\)\s*=>\s*check\.ok\)\s*;/.test(runBody) &&
      (runBody.match(/report\.ok\s*=/g) || []).length === 1 &&
      !/report\.checks\s*=|report\s*\[\s*['"]checks['"]\s*\]\s*=|report\.checks\.(?:splice|pop|shift|unshift|fill|copyWithin|reverse|sort)\s*\(/.test(executableSource) &&
      !/Object\.defineProperty\(\s*report\s*,\s*['"](?:ok|checks)['"]/.test(executableSource) &&
      /fs\.writeFileSync\(reportPath,\s*JSON\.stringify\(report,\s*null,\s*2\)\)/.test(runBody) &&
      /\[SIGNAL-E2E\]\s+\$\{report\.ok\s*\?\s*['"]PASS['"]\s*:\s*['"]FAIL['"]\}/.test(runBody) &&
      /if\s*\(report\.harnessErrors\.length\s*>\s*0\)\s*\{\s*process\.exitCode\s*=\s*2\s*;\s*\}\s*else\s+if\s*\(!report\.ok\)\s*\{\s*process\.exitCode\s*=\s*1\s*;\s*\}/.test(runBody) &&
      !/report\.ok\s*=\s*true/.test(runBody) &&
      !/process\.exitCode\s*=\s*0/.test(executableSource) &&
      (executableSource.match(/process\.exitCode\s*=/g) || []).length === 3 &&
      /run\(\)\.catch\(\(error\)\s*=>\s*\{[\s\S]{0,300}?process\.exitCode\s*=\s*2/.test(executableSource) &&
      (!bindingAudit.validNames.has('run') ||
        (criticalControlFlow.run.ok && criticalControlFlow.run.terminalEvidence)) &&
      forbiddenRuntime.processExit.length === 0 &&
      forbiddenRuntime.processLifecycle.length === 0 &&
      forbiddenRuntime.verdictTampering.length === 0 &&
      forbiddenRuntime.integrityTampering.crypto.length === 0 &&
      forbiddenRuntime.integrityTampering.dispatch.length === 0,
    'final PASS and exit status must be derived from nonempty actual check results and harness errors; ' +
      `failures must exit nonzero; processExit=${forbiddenRuntime.processExit.join(',') || 'none'} ` +
      `lifecycle=${forbiddenRuntime.processLifecycle.join(',') || 'none'} ` +
      `tampering=${forbiddenRuntime.verdictTampering.join(',') || 'none'} ` +
      `cryptoTampering=${forbiddenRuntime.integrityTampering.crypto.join(',') || 'none'} ` +
      `dispatchTampering=${forbiddenRuntime.integrityTampering.dispatch.join(',') || 'none'} ` +
      `terminalEvidence=${criticalControlFlow.run.terminalEvidence}`
  );
  add(
    'MOVING_SPOUT_FIXTURE_IS_READY_BEFORE_SCENARIOS',
    /spoutArtifact/.test(fixtureBody) &&
      /assertSpoutSenderArtifactUnchanged\s*\(\s*spoutArtifact\s*\)/.test(fixtureBody) &&
      /--pattern=alpha-moving-edge/.test(fixtureBody) &&
      /startSignalingMediaFixture\s*\(/.test(runBody) &&
      /SPOUT_TEST_SENDER_READY/.test(runBody) &&
      /signaling-media-fixture-is-ready/.test(runBody) &&
      runBody.indexOf('signaling-media-fixture-is-ready') < runBody.indexOf('runNegotiationScenario'),
    'the deterministic moving sender must be started and required READY before scenario dispatch'
  );

  const publisherReadyBody = functionBody(executableSource, 'waitForPublisherReady');
  const publisherBindingBody = functionBody(executableSource, 'waitForPublisherSpoutBinding');
  add(
    'PUBLISHER_SOURCE_BINDING_IS_HARNESS_PREREQUISITE',
    /waitForPublisherSpoutBinding\s*\(/.test(publisherReadyBody) &&
      /requireHarnessFixture\s*\(/.test(publisherReadyBody) &&
      /publisher-binds-explicit-spout-source/.test(publisherReadyBody) &&
      /fixtureAlive/.test(publisherBindingBody) &&
      /\[SpoutCapture\] Started sender=/.test(publisherBindingBody),
    'seed readiness is insufficient; the live fixture and exact opened Spout sender must be proven'
  );

  add(
    'SIGNALING_MEDIA_FIXTURE_CLEANUP_IS_RECORDED',
    /await\s+signalingMediaFixture\.stop\s*\(\s*\)/.test(runBody) &&
      /signaling-media-fixture-stopped/.test(runBody),
    'fixture cleanup must execute from the top-level finally path and be reported'
  );

  const parseArgsBody = functionBody(executableSource, 'parseArgs');
  const artifactValidationBody = functionBody(
    executableSource,
    'validatePackagedPublisherArtifact'
  );
  add(
    'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE',
    /publisherPath:\s*['"]['"]/.test(parseArgsBody) &&
      /artifactManifestPath:\s*['"]['"]/.test(parseArgsBody) &&
      /artifactManifestSha256:\s*['"]['"]/.test(parseArgsBody) &&
      /--publisher-path=/.test(parseArgsBody) &&
      /--artifact-manifest-path=/.test(parseArgsBody) &&
      /--artifact-manifest-sha256=/.test(parseArgsBody) &&
      /explicitArtifactArgumentCounts/.test(parseArgsBody) &&
      /count\s*!==\s*1\s*\|\|\s*!config\[name\]/.test(parseArgsBody) &&
      /\^\[0-9a-f\]\{64\}\$/.test(parseArgsBody) &&
      /const\s+RELEASE_ARTIFACT_MANIFEST_FILENAME\s*=\s*['"]release-artifact-manifest\.json['"]/.test(executableSource) &&
      /const\s+RELEASE_ARTIFACT_MANIFEST_SCHEMA\s*=\s*['"]game-capture-release-artifact\/v1['"]/.test(executableSource) &&
      /RELEASE_ARTIFACT_MANIFEST_FILENAME/.test(artifactValidationBody) &&
      /RELEASE_ARTIFACT_MANIFEST_SCHEMA/.test(artifactValidationBody) &&
      /game-capture\.exe/.test(artifactValidationBody) &&
      /const\s+manifestBytes\s*=\s*fs\.readFileSync\(config\.artifactManifestPath\)/.test(artifactValidationBody) &&
      /const\s+manifestSha256\s*=\s*sha256Buffer\(manifestBytes\)/.test(artifactValidationBody) &&
      /manifestSha256\s*!==\s*config\.artifactManifestSha256/.test(artifactValidationBody) &&
      /artifact\.relativePath/.test(artifactValidationBody) &&
      /artifact\.size/.test(artifactValidationBody) &&
      /artifact\.sha256/.test(artifactValidationBody) &&
      /realpathSync/.test(artifactValidationBody) &&
      /comparableRealPath\(executable\)\s*!==\s*comparableRealPath\(manifestRelativeExecutable\)/.test(artifactValidationBody) &&
      /comparableRealPath\(path\.dirname\(executable\)\)\s*!==\s*comparableRealPath\(path\.dirname\(manifestPath\)\)/.test(artifactValidationBody) &&
      /const\s+executableBytes\s*=\s*fs\.readFileSync\(executable\)/.test(artifactValidationBody) &&
      /const\s+executableSha256\s*=\s*sha256Buffer\(executableBytes\)/.test(artifactValidationBody) &&
      /executableBytes\.length\s*!==\s*manifest\.artifact\.size/.test(artifactValidationBody) &&
      /executableSha256\s*!==\s*manifest\.artifact\.sha256/.test(artifactValidationBody) &&
      /manifest\.version/.test(artifactValidationBody) &&
      /manifest\.packagedAtUtc/.test(artifactValidationBody) &&
      /manifest\.build\.configuration\s*!==\s*['"]Release['"]/.test(artifactValidationBody) &&
      /typeof\s+manifest\.source\.gitCommit\s*!==\s*['"]string['"]/.test(artifactValidationBody) &&
      /\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$/.test(artifactValidationBody) &&
      exactGitObjectIdContractIsSound() &&
      /typeof\s+manifest\.source\.dirty\s*!==\s*['"]boolean['"]/.test(artifactValidationBody) &&
      /typeof\s+manifest\.source\.snapshotSha256\s*!==\s*['"]string['"]/.test(artifactValidationBody) &&
      /Number\.isSafeInteger\(manifest\.source\.snapshotFileCount\)/.test(artifactValidationBody) &&
      /manifest\.source\.snapshotFileCount\s*<\s*1/.test(artifactValidationBody) &&
      /const\s+RELEASE_SOURCE_SNAPSHOT_ALGORITHM\s*=\s*['"]sha256\(file-nul-path-nul-size-nul-content-nul\)\/git-ls-files-cached-others-exclude-standard\/ordinal-sort-unique\/v2['"]/.test(executableSource) &&
      /manifest\.source\.snapshotAlgorithm\s*!==\s*RELEASE_SOURCE_SNAPSHOT_ALGORITHM/.test(artifactValidationBody) &&
      !/manifest\.source\.(?:gitCommit|dirty|snapshotSha256)\s*!==\s*null/.test(artifactValidationBody) &&
      !/mtimeMs|readdirSync|sort\s*\(/.test(artifactValidationBody) &&
      !/function\s+detectPackagedPublisher\s*\(/.test(executableSource) &&
      /validatePackagedPublisherArtifact\(config\)/.test(runBody) &&
      /packaged-artifact-manifest-binds-executable/.test(runBody) &&
      /packagedArtifactManifest:\s*\{[\s\S]{0,500}?path:\s*manifestPath[\s\S]{0,300}?sha256:\s*manifestSha256[\s\S]{0,500}?source:\s*manifest\.source/.test(runBody),
    'the packaged executable must be selected explicitly and bound by an explicitly hash-pinned release manifest using exact realpath, size, and SHA-256 equality; mtime discovery is forbidden'
  );

  const browserTurnServerBody = functionBody(executableSource, 'browserTurnServer');
  const browserRtcReadinessBody = functionBody(
    executableSource,
    'ensureBrowserRtcReadiness'
  );
  const resolveTurnBody = functionBody(executableSource, 'resolveBrowserTurnConfiguration');
  const turnProbeBody = functionBody(executableSource, 'probeSelectedTurnEndpoint');
  const turnSocketProbeBody = functionBody(executableSource, 'probeTurnSocketAddress');
  const ensureTurnBody = functionBody(executableSource, 'ensureTurnFixture');
  const relayScenarioBody = functionBody(executableSource, 'runRelayIceScenario');
  const recoveryScenarioBody = functionBody(executableSource, 'runRecoveryScenario');
  const validateTurnRegistryBody = functionBody(
    executableSource,
    'validateTurnRegistryResponse'
  );
  const fetchTurnRegistryBody = functionBody(
    executableSource,
    'fetchValidatedTurnRegistryResponse'
  );
  const flattenRegistryBody = functionBody(
    executableSource,
    'flattenValidatedTurnRegistryEndpoints'
  );
  const turnRegistryIceServersBody = functionBody(
    executableSource,
    'turnRegistryIceServers'
  );
  const turnRegistryEndpointIdentityBody = functionBody(
    executableSource,
    'turnRegistryEndpointIdentity'
  );
  const canonicalTurnRegistryBody = functionBody(
    executableSource,
    'canonicalTurnRegistryResponseV1'
  );
  const turnRegistryHashBody = functionBody(
    executableSource,
    'turnRegistryResponseSha256'
  );
  const matchPackagedTurnResponseBody = functionBody(
    executableSource,
    'matchPackagedTurnResponse'
  );
  const redactTurnSecretsBody = functionBody(executableSource, 'redactTurnSecrets');
  const exactIceSummaryTokenBody = functionBody(executableSource, 'exactIceSummaryToken');
  const registryReferenceContract = exerciseTurnRegistryReferenceContract(source);
  const registryFetchCallsInRelay =
    (relayScenarioBody.match(/\bfetchValidatedTurnRegistryResponse\s*\(/g) || []).length;
  const topLevelTurnRegistryCacheNames = [];
  for (const statement of parsedTarget.ast && parsedTarget.ast.body
    ? parsedTarget.ast.body
    : []) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations || []) {
      if (declaration.id && declaration.id.type === 'Identifier' &&
          /^(?:turnRegistryResponse|cachedTurnRegistry|cachedTurnResponse|relayBrowserRtcConfig)$/i
            .test(declaration.id.name) &&
          declaration.init) {
        topLevelTurnRegistryCacheNames.push(declaration.id.name);
      }
    }
  }
  add(
    'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH',
    /const\s+BROWSER_RTC_READINESS_TIMEOUT_MS\s*=\s*15000\s*;/.test(executableSource) &&
      /new\s+RTCPeerConnection\s*\(\s*\{\s*iceServers:\s*\[\]\s*,\s*iceTransportPolicy:\s*['"]all['"]\s*\}\s*\)/
        .test(browserRtcReadinessBody) &&
      /createDataChannel\s*\(/.test(browserRtcReadinessBody) &&
      /createOffer\s*\(/.test(browserRtcReadinessBody) &&
      /setLocalDescription\s*\(/.test(browserRtcReadinessBody) &&
      /iceGatheringState/.test(browserRtcReadinessBody) &&
      /browser-rtc-readiness-before-turn-registry/.test(browserRtcReadinessBody) &&
      /await\s+ensureBrowserRtcReadiness\s*\(\s*browser\s*,\s*report\s*\)/
        .test(relayScenarioBody) &&
      relayScenarioBody.indexOf('ensureBrowserRtcReadiness') <
        relayScenarioBody.indexOf('fetchValidatedTurnRegistryResponse'),
    'one fresh, disposable, registry-independent no-ICE PeerConnection must genuinely leave new ' +
      'before the fresh TURN registry fetch; its failure is a separate harness prerequisite'
  );
  add(
    'TURN_REGISTRY_FETCH_IS_SCOPED_TO_TURN_USE',
    registryFetchCallsInRelay === 1 &&
      /const\s+turnRegistryResponse\s*=\s*await\s+fetchValidatedTurnRegistryResponse\s*\(/.test(relayScenarioBody) &&
      /resolveBrowserTurnConfiguration\s*\(\s*turnRegistryResponse\s*\)/.test(relayScenarioBody) &&
      /runRelayIceScenario\s*\(/.test(recoveryScenarioBody) &&
      topLevelTurnRegistryCacheNames.length === 0 &&
      !/\bRELAY_BROWSER_RTC_CONFIG\b/.test(executableSource) &&
      !/\bTURN_REGISTRY_(?:CACHE|CACHED_RESPONSE)\b/.test(executableSource) &&
      !/(?:globalThis|window)\.[A-Za-z0-9_$]*(?:turn|registry|relay)[A-Za-z0-9_$]*cache/i
        .test(relayScenarioBody + fetchTurnRegistryBody + resolveTurnBody) &&
      !/fs\.(?:readFileSync|writeFileSync)\s*\([^)]*turn[^)]*(?:registry|response|config)/i
        .test(fetchTurnRegistryBody),
    'a fresh registry query must occur at relay/go-live setup and each explicit recovery-cycle ' +
      'invocation; one validated in-memory response may serve peers only inside that active cycle; ' +
      'relayFetchCalls=' + registryFetchCallsInRelay +
      ' topLevelCaches=' + (topLevelTurnRegistryCacheNames.join(',') || 'none')
  );
  add(
    'TURN_REGISTRY_HTTP_200_VERSIONED_SCHEMA_IS_REQUIRED',
    registryReferenceContract.ok &&
      /https:\/\/turnservers\.vdo\.ninja(?:[/?'"]|$)/.test(fetchTurnRegistryBody) &&
      /response\.(?:status|statusCode)\s*!==\s*200/.test(fetchTurnRegistryBody) &&
      /JSON\.parse\s*\(/.test(fetchTurnRegistryBody) &&
      /validateTurnRegistryResponse\s*\(/.test(fetchTurnRegistryBody) &&
      /Number\.isInteger\s*\(\s*(?:payload|response|registry)\.version\s*\)/.test(validateTurnRegistryBody) &&
      /(?:payload|response|registry)\.version\s*!==\s*1/.test(validateTurnRegistryBody),
    'the live registry must return exact HTTP 200 JSON whose version is the integer 1; ' +
      registryReferenceContract.detail
  );
  add(
    'TURN_REGISTRY_RESPONSE_IS_NONEMPTY_AND_WHOLELY_VALID',
    registryReferenceContract.ok &&
      /Array\.isArray\s*\(\s*(?:payload|response|registry)\.servers\s*\)/.test(validateTurnRegistryBody) &&
      /\.servers\.length\s*===\s*0/.test(validateTurnRegistryBody) &&
      /(?:\.map\s*\(|for\s*\([^)]*\bserver\b)/.test(validateTurnRegistryBody) &&
      /hasOwnProperty\.call\s*\(\s*server\s*,\s*['"]url['"]\s*\)/.test(validateTurnRegistryBody) &&
      /typeof\s+server\.urls\s*===\s*['"]string['"]/.test(validateTurnRegistryBody) &&
      /Array\.isArray\s*\(\s*server\.urls\s*\)/.test(validateTurnRegistryBody) &&
      /urls\.length\s*===\s*0/.test(validateTurnRegistryBody) &&
      /typeof\s+server\.username\s*!==\s*['"]string['"]/.test(validateTurnRegistryBody) &&
      /typeof\s+server\.credential\s*!==\s*['"]string['"]/.test(validateTurnRegistryBody) &&
      /\.trim\(\)\.length\s*===\s*0/.test(validateTurnRegistryBody) &&
      /typeof\s+server\.udp\s*!==\s*['"]boolean['"]/.test(validateTurnRegistryBody) &&
      !/\.filter\s*\(/.test(validateTurnRegistryBody),
    'servers must be nonempty and every row must be valid as a whole: urls is a TURN string or ' +
      'nonempty TURN array, credentials are nonempty, udp is boolean, legacy url is rejected, and ' +
      'additive metadata is allowed; ' + registryReferenceContract.detail
  );
  add(
    'TURN_REGISTRY_FAILURE_HAS_NO_LOCAL_FALLBACK',
    !/\bTURN_FIXTURE_FALLBACK_SERVERS\b/.test(executableSource) &&
      !/\bselectTurnServersLikeVdo\b/.test(executableSource) &&
      !/--force-turn-fallback/.test(executableSource) &&
      !/(?:catch|status[^;\n]*!={0,1}\s*200)[\s\S]{0,500}?(?:fallback|defaultTurn|localTurn)/i
        .test(fetchTurnRegistryBody + resolveTurnBody) &&
      !/(?:fallback|default)[A-Za-z]*Servers/.test(resolveTurnBody),
    'registry transport, status, parse, schema, or empty-response failure must block TURN use; no ' +
      'compiled, persisted, forced, or locally synthesized TURN fallback is allowed'
  );
  add(
    'TURN_FETCHED_CONFIG_ORDER_URLS_CREDENTIALS_AND_UDP_ARE_PRESERVED',
    /(?:payload|response|registry)\.servers\.map\s*\(/.test(turnRegistryIceServersBody) &&
      /urls:\s*server\.urls/.test(turnRegistryIceServersBody) &&
      /username:\s*server\.username/.test(turnRegistryIceServersBody) &&
      /credential:\s*server\.credential/.test(turnRegistryIceServersBody) &&
      /udp:\s*server\.udp/.test(flattenRegistryBody + turnRegistryIceServersBody) &&
      !/\.(?:sort|filter|reverse)\s*\(|new\s+Set\s*\(/.test(
        flattenRegistryBody + turnRegistryIceServersBody
      ) &&
      !/slice\s*\(\s*0\s*,/.test(flattenRegistryBody + turnRegistryIceServersBody),
    'the validated response order, string-versus-array urls, username, credential, and udp flag ' +
      'must reach browser configuration and endpoint expansion without selection, reordering, or loss'
  );
  add(
    'TURN_ENDPOINTS_ARE_PROBED_IN_ISOLATION',
    /iceServers:\s*\[browserTurnServer\(endpoint\)\]/.test(turnProbeBody) &&
      /for\s*\(const\s+endpointSet\s+of\s+endpointSets\)/.test(ensureTurnBody) &&
      /for\s*\(const\s+endpoint\s+of\s+endpointSet\.endpoints\)/.test(ensureTurnBody) &&
      /probeSelectedTurnEndpoint\(probe\.page,\s*endpoint\)/.test(ensureTurnBody),
    'each selected original endpoint must own a separate relay-only PeerConnection probe'
  );
  const turnProbeReturnTokens = activeJavaScriptTokens(turnProbeBody).filter(
    (token) => token.value === 'return'
  );
  const hostnameProbeOperation = turnProbeBody.search(
    /const\s+probe\s*=\s*await\s+probeBrowserTurn\(page,\s*endpointRtcConfig\)\s*;/
  );
  const addressAllocationOperation = turnProbeBody.search(
    /const\s+probe\s*=\s*await\s+probeBrowserTurn\(page,\s*\{\s*iceServers:\s*\[addressServer\]/
  );
  const addressSocketOperation = turnProbeBody.search(
    /const\s+socketProbe\s*=\s*await\s+probeTurnSocketAddress\(endpoint\.parsed,\s*address\)\s*;/
  );
  const finalProbeReturn = turnProbeReturnTokens.length === 1
    ? turnProbeReturnTokens[0].start
    : -1;
  add(
    'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
    (![
      'probeBrowserTurn',
      'summarizeTurnBrowserProbe',
      'probeTurnSocketAddress',
      'probeSelectedTurnEndpoint'
    ].every((name) => bindingAudit.validNames.has(name)) ||
      criticalControlFlow.endpointLeaves.ok) &&
      turnProbeReturnTokens.length === 1 &&
      hostnameProbeOperation >= 0 &&
      addressAllocationOperation >= 0 &&
      addressSocketOperation >= 0 &&
      finalProbeReturn > hostnameProbeOperation &&
      finalProbeReturn > addressAllocationOperation &&
      finalProbeReturn > addressSocketOperation &&
      braceDepthAtSourceOffset(turnProbeBody, hostnameProbeOperation) === 1 &&
      braceDepthAtSourceOffset(turnProbeBody, addressAllocationOperation) === 3 &&
      braceDepthAtSourceOffset(turnProbeBody, addressSocketOperation) === 3 &&
      braceDepthAtSourceOffset(turnProbeBody, finalProbeReturn) === 0 &&
      /const\s+endpointRtcConfig\s*=\s*\{[\s\S]{0,300}?\}\s*;\s*for\s*\(let\s+attempt\s*=\s*1;/.test(turnProbeBody) &&
      /const\s+addressAttempts\s*=\s*\[\]\s*;\s*for\s*\(const\s+address\s+of\s+[^)]+\)/.test(turnProbeBody) &&
      /for\s*\(let\s+attempt\s*=\s*1;\s*attempt\s*<=\s*TURN_ENDPOINT_PROBE_ATTEMPTS;\s*attempt\+\+\)[\s\S]{0,300}?await\s+probeBrowserTurn\(page,\s*endpointRtcConfig\)[\s\S]{0,200}?hostnameAttempts\.push\(\{\s*attempt,\s*\.\.\.summarizeTurnBrowserProbe\(probe\)\s*\}\)/.test(turnProbeBody) &&
      /if\s*\(endpoint\.udp\)\s*\{[\s\S]{0,700}?await\s+probeBrowserTurn\(page,[\s\S]{0,500}?addressAttempts\.push\(\{[\s\S]{0,300}?\.\.\.summarizeTurnBrowserProbe\(probe\)/.test(turnProbeBody) &&
      /\}\s*else\s*\{[\s\S]{0,300}?await\s+probeTurnSocketAddress\(endpoint\.parsed,\s*address\)[\s\S]{0,300}?addressAttempts\.push\(\{[\s\S]{0,300}?\.\.\.socketProbe/.test(turnProbeBody) &&
      /return\s*\{[\s\S]{0,400}?hostnameAttempts,\s*addressAttempts\s*\}/.test(turnProbeBody),
    'the sole success return must follow hostname TURN allocation and both UDP allocation/TLS-socket address branches, ' +
      `and leaf probes must be observed operations; ${criticalControlFlow.endpointLeaves.detail}`
  );
  add(
    'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED',
    /flattenValidatedTurnRegistryEndpoints\s*\(\s*turnRegistryResponse\s*\)/.test(
      resolveTurnBody + relayScenarioBody
    ) &&
      /for\s*\(const\s+endpoint\s+of\s+(?:turnFixture\.)?(?:fetched|registry|selected)?Endpoints\)/i
        .test(ensureTurnBody + resolveTurnBody) &&
      /probeSelectedTurnEndpoint\(probe\.page,\s*endpoint\)/.test(ensureTurnBody) &&
      /endpointProbes\.length\s*===\s*(?:turnFixture\.)?(?:fetched|registry|selected)?Endpoints\.length/i
        .test(ensureTurnBody) &&
      /endpoints:\s*fetchedEndpoints/.test(ensureTurnBody) &&
      /registryServerIndex/.test(turnRegistryEndpointIdentityBody) &&
      /registryUrlIndex/.test(turnRegistryEndpointIdentityBody) &&
      /registryEndpointIndex/.test(turnRegistryEndpointIdentityBody) &&
      /username/.test(turnRegistryEndpointIdentityBody) &&
      /credential/.test(turnRegistryEndpointIdentityBody) &&
      /endpointIdentityChainExact/.test(ensureTurnBody) &&
      !/(?:selected|healthy)Endpoints\s*=\s*[^;\n]*\.(?:filter|slice)\s*\(/.test(
        resolveTurnBody + ensureTurnBody
      ),
    'every URL expanded from every fetched server must be resolved and independently probed; ' +
      'a healthy subset cannot stand in for the response'
  );
  add(
    'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT',
    /endpointProbes\.every\(\(endpoint\)\s*=>[\s\S]*?endpoint\.hostnameAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/.test(ensureTurnBody) &&
      /endpointProbes\.every\(\(endpoint\)\s*=>[\s\S]*?endpoint\.addressAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/.test(ensureTurnBody) &&
      /everyOriginalHostnameAttemptAllocated\s*&&\s*everyResolvedAddressPassed\s*&&\s*rtcConfigRetainsOriginalHostnames/.test(ensureTurnBody) &&
      !/hostnameAttempts\.some\(|addressAttempts\.some\(/.test(ensureTurnBody),
    'one healthy pool member or one healthy retry may never mask a dead selected endpoint or failed attempt'
  );
  add(
    'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED',
    (!bindingAudit.validNames.has('resolveTurnEndpointAddresses') ||
      criticalControlFlow.resolver.ok) &&
      forbiddenRuntime.integrityTampering.dns.length === 0 &&
      forbiddenRuntime.integrityTampering.promise.length === 0 &&
      /for\s*\(const\s+address\s+of\s+endpoint\.addresses\)/.test(turnProbeBody) &&
      /endpoint\.addresses\.length\s*\*\s*TURN_ENDPOINT_PROBE_ATTEMPTS/.test(ensureTurnBody) &&
      /endpoint\.addresses\.length\s*>\s*0/.test(ensureTurnBody),
    'all deduplicated A and AAAA addresses behind every selected hostname must be covered and an empty ' +
      `resolution must fail closed; ${criticalControlFlow.resolver.detail}; ` +
      `dnsTampering=${forbiddenRuntime.integrityTampering.dns.join(',') || 'none'} ` +
      `promiseTampering=${forbiddenRuntime.integrityTampering.promise.join(',') || 'none'}`
  );
  add(
    'TURN_NON_UDP_MULTI_ADDRESS_COVERAGE_FAILS_CLOSED',
    /const\s+nonUdpAddressCoverageUnambiguous\s*=\s*endpoint\.udp\s*\|\|\s*endpoint\.addresses\.length\s*===\s*1/.test(turnProbeBody) &&
      /endpoint\.nonUdpAddressCoverageUnambiguous\s*&&/.test(ensureTurnBody) &&
      /nonUdpMultiAddressPolicy:\s*['"]fail-closed['"]/.test(ensureTurnBody),
    'hostname TURN Allocate is admissible for non-UDP only when DNS has one address; multi-address endpoints must block instead of being inferred healthy'
  );
  add(
    'TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION',
    /servername:\s*parsed\.hostname/.test(turnSocketProbeBody) &&
      /rejectUnauthorized:\s*true/.test(turnSocketProbeBody) &&
      /socket\.authorized/.test(turnSocketProbeBody) &&
      forbiddenRuntime.integrityTampering.tls.length === 0,
    'TLS address checks must preserve the original hostname as SNI and reject certificate hostname ' +
      `mismatches; tlsTampering=${forbiddenRuntime.integrityTampering.tls.join(',') || 'none'}`
  );
  add(
    'PACKAGED_TURN_SCENARIO_USES_LIVE_REGISTRY_WITHOUT_FORCE_FALLBACK',
    /https:\/\/turnservers\.vdo\.ninja/.test(fetchTurnRegistryBody) &&
      !/--force-turn-fallback/.test(executableSource) &&
      !/\bforceTurnFallback\b/.test(executableSource) &&
      /runRelayIceScenario\s*\(\s*config,\s*executable,\s*browser,\s*report,\s*mediaFixture\s*\)/.test(
        recoveryScenarioBody
      ) &&
      /packaged-turn-live-registry-workflow-entered/.test(recoveryScenarioBody) &&
      /packaged-turn-live-registry-response-accepted/.test(relayScenarioBody),
    'the shipped relay workflow must use the live registry response and must not expose or exercise a ' +
      'force-fallback path'
  );
  const relayPeerConnectionStart = relayScenarioBody.indexOf(
    'const relay = await connectNewPeer'
  );
  const publisherOutputLinesStart = relayScenarioBody.indexOf(
    'const publisherOutputLines'
  );
  const registryFetchLinesStart = relayScenarioBody.indexOf(
    'const nativeTurnRegistryFetchLines'
  );
  const consumedConfigLinesStart = relayScenarioBody.indexOf(
    'const consumedIceConfigLines'
  );
  const registryFetchCheckStart = relayScenarioBody.indexOf(
    'packaged-turn-registry-fetch-is-unique'
  );
  const consumedConfigCheckStart = relayScenarioBody.indexOf(
    'packaged-turn-consumed-config-matches-fetched-response'
  );
  const registryFetchDeclarationEnd = registryFetchLinesStart < 0
    ? -1
    : relayScenarioBody.indexOf(';', registryFetchLinesStart);
  const consumedConfigDeclarationEnd = consumedConfigLinesStart < 0
    ? -1
    : relayScenarioBody.indexOf(';', consumedConfigLinesStart);
  const registryFetchDeclaration = registryFetchLinesStart < 0 ||
      registryFetchDeclarationEnd < 0
    ? ''
    : relayScenarioBody.slice(registryFetchLinesStart, registryFetchDeclarationEnd + 1);
  const consumedConfigDeclaration = consumedConfigLinesStart < 0 ||
      consumedConfigDeclarationEnd < 0
    ? ''
    : relayScenarioBody.slice(consumedConfigLinesStart, consumedConfigDeclarationEnd + 1);
  const provenanceSpan = registryFetchCheckStart < 0
    ? ''
    : relayScenarioBody.slice(registryFetchCheckStart, registryFetchCheckStart + 5000);
  const consumedSpan = consumedConfigCheckStart < 0
    ? ''
    : relayScenarioBody.slice(consumedConfigCheckStart, consumedConfigCheckStart + 3500);

  add(
    'PACKAGED_TURN_FETCH_IS_FRESH_AND_EXPLICIT',
    /const\s+turnRegistryFetchStartedAtMs\s*=\s*Date\.now\(\)/.test(relayScenarioBody) &&
      /const\s+turnRegistryResponse\s*=\s*await\s+fetchValidatedTurnRegistryResponse\s*\(/.test(
        relayScenarioBody
      ) &&
      /const\s+turnRegistryFetchCompletedAtMs\s*=\s*Date\.now\(\)/.test(
        relayScenarioBody
      ) &&
      relayScenarioBody.indexOf('turnRegistryFetchStartedAtMs') <
        relayScenarioBody.indexOf('fetchValidatedTurnRegistryResponse') &&
      relayScenarioBody.lastIndexOf('turnRegistryFetchCompletedAtMs') >
        relayScenarioBody.indexOf('fetchValidatedTurnRegistryResponse') &&
      /matchPackagedTurnResponse\s*\([\s\S]{0,500}?turnRegistryFetchStartedAtMs[\s\S]{0,500}?turnRegistryFetchCompletedAtMs/.test(
        relayScenarioBody
      ),
    'the harness must make an explicit fresh query at cycle setup and bound the native observation to ' +
      'that query window; no precomputed response is admissible'
  );
  add(
    'PACKAGED_TURN_REQUIRES_UNIQUE_FETCH_AND_CONSUMPTION_SUMMARIES',
    /const\s+publisherOutputLines\s*=\s*publisher\.output\(\)\.split\(/.test(
        relayScenarioBody
      ) &&
      publisherOutputLinesStart > relayPeerConnectionStart &&
      /const\s+nativeTurnRegistryFetchLines\s*=\s*publisherOutputLines\.filter\(\(line\)\s*=>/.test(
        relayScenarioBody
      ) &&
      relayScenarioBody.includes('/\\[ICE\\] TurnRegistryFetch(?:\\s|$)/') &&
      /const\s+consumedIceConfigLines\s*=\s*publisherOutputLines\.filter\(\(line\)\s*=>/.test(
        relayScenarioBody
      ) &&
      relayScenarioBody.includes('/\\[WebRTC\\] ConsumedIceConfig(?:\\s|$)/') &&
      !/\.slice\s*\(|\.find\s*\(/.test(registryFetchDeclaration + consumedConfigDeclaration) &&
      /nativeTurnRegistryFetchLines\.length\s*===\s*1/.test(provenanceSpan) &&
      /consumedIceConfigLines\.length\s*===\s*1/.test(consumedSpan),
    'after the peer is created, the harness must collect all native output and require exactly one ' +
      'registry-fetch summary and one consumed-config summary before parsing either'
  );
  add(
    'PACKAGED_TURN_SAME_RUN_PROVENANCE_OR_BOUNDED_MATCH_IS_PROVEN',
    /turnRegistryTransactionId/.test(provenanceSpan) &&
      /turnRegistryResponseSha256/.test(provenanceSpan) &&
      /\^\[0-9a-f\]\{64\}\$/.test(provenanceSpan) &&
      /matchPackagedTurnResponse\s*\(/.test(provenanceSpan) &&
      /transactionId/.test(matchPackagedTurnResponseBody) &&
      /responseSha256/.test(matchPackagedTurnResponseBody) &&
      /fetchStartedAtMs/.test(matchPackagedTurnResponseBody) &&
      /fetchCompletedAtMs/.test(matchPackagedTurnResponseBody) &&
      /responses\.filter\s*\(/.test(matchPackagedTurnResponseBody) &&
      /matches\.length\s*===\s*1/.test(matchPackagedTurnResponseBody),
    'a unique native transaction ID and raw-response SHA-256 must match exactly one validated response ' +
      'observed in the bounded same-run query window; absence or ambiguity is RED'
  );
  add(
    'PACKAGED_TURN_CONSUMED_CONFIG_MATCHES_FETCHED_RESPONSE',
    consumedConfigCheckStart > relayPeerConnectionStart &&
      /exactIceSummaryToken\s*\(\s*consumedIceConfig,\s*['"]turnRegistryTransactionId['"]/.test(
        consumedSpan
      ) &&
      /exactIceSummaryToken\s*\(\s*consumedIceConfig,\s*['"]turnRegistryResponseSha256['"]/.test(
        consumedSpan
      ) &&
      /exactIceSummaryToken\s*\(\s*consumedIceConfig,\s*['"]turnConfigV1Sha256['"]/.test(
        consumedSpan
      ) &&
      /observedConsumedTransactionId\s*===\s*matchedTurnResponse\.transactionId/.test(
        consumedSpan
      ) &&
      /observedConsumedResponseSha256\s*===\s*matchedTurnResponse\.responseSha256/.test(
        consumedSpan
      ) &&
      /observedConsumedTurnSha256\s*===\s*matchedTurnResponse\.configSha256/.test(
        consumedSpan
      ) &&
      /observedConsumedTurnCount\s*===\s*matchedTurnResponse\.servers\.length/.test(
        consumedSpan
      ),
    'the post-construction consumer diagnostic must bind transaction, raw response hash, full ordered ' +
      'config hash, and server count to the same matched live response'
  );
  add(
    'PACKAGED_TURN_RESPONSE_HASH_BINDS_FULL_ORDERED_CONFIG',
    /const\s+TURN_REGISTRY_CONFIG_V1_PREFIX\s*=\s*['"]game-capture-turn-registry-config-v1['"]/.test(
        executableSource
      ) &&
      /servers\.map\s*\(\s*\(\s*\{\s*urls,\s*username,\s*credential,\s*udp\s*\}\s*\)\s*=>\s*\(\s*\{\s*urls,\s*username,\s*credential,\s*udp\s*\}\s*\)\s*\)/.test(
        canonicalTurnRegistryBody
      ) &&
      /TURN_REGISTRY_CONFIG_V1_PREFIX/.test(canonicalTurnRegistryBody) &&
      /JSON\.stringify\s*\(/.test(canonicalTurnRegistryBody) &&
      !/\.(?:sort|filter|reverse)\s*\(/.test(canonicalTurnRegistryBody) &&
      /sha256Text\s*\(\s*canonicalTurnRegistryResponseV1\s*\(/.test(
        turnRegistryHashBody
      ) &&
      forbiddenRuntime.integrityTampering.crypto.length === 0 &&
      /\(\?:\^\|\\\\s\)/.test(exactIceSummaryTokenBody) &&
      /\(\?=\\\\s\|\$\)/.test(exactIceSummaryTokenBody),
    'the versioned SHA-256 binding must cover every ordered urls value (including array shape), ' +
      'username, credential, and udp field without selection or reordering; cryptoTampering=' +
      (forbiddenRuntime.integrityTampering.crypto.join(',') || 'none')
  );
  add(
    'TURN_DIAGNOSTICS_AND_REPORTS_REDACT_CREDENTIALS',
    /redactTurnSecrets\s*\(/.test(relayScenarioBody + runBody) &&
      /server\.username/.test(redactTurnSecretsBody) &&
      /server\.credential/.test(redactTurnSecretsBody) &&
      /rawResponse/.test(redactTurnSecretsBody) &&
      /\[REDACTED\]/.test(redactTurnSecretsBody) &&
      !/(?:username|credential|rawResponse)\s*:\s*(?:server\.|matchedTurnResponse\.)/.test(
        relayScenarioBody + runBody
      ),
    'host URLs may appear in failure evidence, but registry usernames, credentials, and raw response ' +
      'payloads must be removed from diagnostics, thrown errors, console output, and JSON reports'
  );
  add(
    'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE',
    (!bindingAudit.validNames.has('run') || criticalControlFlow.run.ok) &&
      forbiddenRuntime.integrityTampering.dispatch.length === 0 &&
      /['"]relay['"][\s\S]*?\.includes\(config\.scenario\)[\s\S]*?await\s+runRecoveryScenario\s*\(/.test(
        runBody
      ) &&
      /packaged-turn-live-registry-workflow-entered/.test(recoveryScenarioBody) &&
      /packaged-turn-live-registry-response-accepted/.test(relayScenarioBody) &&
      /packaged-turn-consumed-config-matches-fetched-response/.test(runBody),
    'top-level relay dispatch must reach the live-registry packaged workflow and classify missing ' +
      'product evidence as a harness failure; runReturns=' + criticalControlFlow.run.returns +
      ' scenarioAssignments=' + criticalControlFlow.run.scenarioAssignments +
      ' liveness=' + (criticalControlFlow.run.livenessHazards.join(',') || 'none') +
      ' terminalEvidence=' + criticalControlFlow.run.terminalEvidence +
      ' dispatchTampering=' +
      (forbiddenRuntime.integrityTampering.dispatch.join(',') || 'none')
  );

  const turnContract = analyzeTurnRegistryContract(
    source,
    parsedTarget.ast,
    bindingAudit,
    forbiddenRuntime,
    criticalControlFlow
  );
  for (const [id, result] of turnContract.results) {
    const index = checks.findIndex((check) => check.id === id);
    if (index < 0) throw new Error(`missing TURN policy ${id}`);
    checks[index] = { id, ok: result.ok, detail: result.detail };
  }

  const browserPageBody = functionBody(executableSource, 'createBrowserPeerPage');
  add(
    'BROWSER_CANDIDATE_WIRE_PROVENANCE_CAPTURED',
    /wire\s*:\s*JSON\.parse\(JSON\.stringify\(event\.candidate\)\)/.test(browserPageBody) &&
      /peerInstanceId/.test(browserPageBody) &&
      /sourcePeerInstanceId/.test(browserPageBody) &&
      /sourceGenerationUfrag/.test(browserPageBody) &&
      /sourceCandidateIndex/.test(browserPageBody) &&
      /candidateStart/.test(browserPageBody) &&
      /candidateEnd/.test(browserPageBody),
    'candidate bytes must match browser JSON serialization while source-PC and ICE-generation provenance stays out of band'
  );

  const answerOfferBody = functionBody(executableSource, 'answerOffer');
  const forwardCandidatesBody = functionBody(executableSource, 'forwardPublisherCandidates');
  add(
    'PUBLISHER_CANDIDATE_ROUTING_IS_WIRE_SESSION_SCOPED',
    /wireSession\s*:\s*['"]['"]/.test(browserPageBody) &&
      /state\.wireSession\s*=\s*wireSession/.test(browserPageBody) &&
      /messageSession\s*!==\s*state\.wireSession/.test(browserPageBody) &&
      /message\.session/.test(forwardCandidatesBody) &&
      /wireSession\s*:\s*offer\.session/.test(answerOfferBody),
    'publisher candidates must be admitted only to the browser peer that owns the exact active wire session'
  );

  const restartBody = functionBody(executableSource, 'remoteFirstRestart');
  const connectPeerBody = functionBody(executableSource, 'connectNewPeer');
  const negotiationBody = functionBody(executableSource, 'runNegotiationScenario');
  const duplicateRecheckMatcherBody = functionBody(
    executableSource,
    'exactDuplicateOfferRecheckLines'
  );
  const duplicateFreshReplacementStart = negotiationBody.indexOf(
    'const duplicateFreshReplacementShape'
  );
  const duplicateFreshReplacementEnd = negotiationBody.indexOf(
    'const unresolvedDuplicateReplacementVerdict',
    duplicateFreshReplacementStart
  );
  const duplicateFreshReplacementSpan = duplicateFreshReplacementStart >= 0 &&
      duplicateFreshReplacementEnd > duplicateFreshReplacementStart
    ? negotiationBody.slice(
      duplicateFreshReplacementStart,
      duplicateFreshReplacementEnd
    )
    : '';
  const preAnswerCriticalStart = negotiationBody.indexOf('const preAnswerRestartUuid');
  const independentStaleScenarioStart = negotiationBody.indexOf('const staleUuid');
  const preAnswerCriticalSpan = preAnswerCriticalStart >= 0 &&
      independentStaleScenarioStart > preAnswerCriticalStart
    ? negotiationBody.slice(preAnswerCriticalStart, independentStaleScenarioStart)
    : '';
  const executableReturnScannerValid =
    hasExecutableReturn('if (failed) { return; }') &&
    hasExecutableReturn('if (failed) return failure;') &&
    hasExecutableReturn('const value = `${(() => { return 1; })()}`;') &&
    !hasExecutableReturn(
      "const text = 'return'; // return\nconst pattern = /return/; " +
      'if (ok) /return/.test(text); const template = `return`; ' +
      'const value = { return: 1 }; obj.return; obj?.return;'
    );
  add(
    'CONNECT_NEW_PEER_SEPARATES_REQUEST_HINT_FROM_ACTIVE_SESSION',
    /requestOffer\(signal,\s*uuid,\s*streamId,\s*requestSessionHint\)/.test(connectPeerBody) &&
      /const\s+activeSession\s*=\s*offer\.message\.session/.test(connectPeerBody) &&
      /const\s+requestHintEchoed\s*=\s*!!requestSessionHint\s*&&\s*activeSession\s*===\s*requestSessionHint/.test(connectPeerBody) &&
      /const\s+sessionContractOk\s*=\s*!!activeSession\s*&&\s*!requestHintEchoed/.test(connectPeerBody) &&
      /requestSessionHint/.test(connectPeerBody) &&
      /activeSession/.test(connectPeerBody),
    'generic peer setup must prove a publisher-generated session instead of treating the request hint as identity'
  );
  add(
    'SESSION_CONTRACT_FAILURE_DOES_NOT_SHORT_CIRCUIT_WORKFLOW',
    /sessionContractOk,\s*sessionContractReason/.test(connectPeerBody) &&
      /ok:\s*connected\.ok\s*&&\s*media\.ok/.test(connectPeerBody) &&
      !/if\s*\(\s*requestHintEchoed\s*\)\s*\{[\s\S]{0,400}?\breturn\b/.test(connectPeerBody),
    'a bad publisher session must stay RED while the harness continues far enough to measure media, restart, cleanup, and re-add behavior'
  );
  add(
    'REMOTE_FIRST_RESTART_USES_ROTATED_WIRE_SESSION',
    /const\s+activeSession\s*=\s*offer\.message\.session/.test(restartBody) &&
      /const\s+sessionRotated\s*=\s*!!activeSession\s*&&\s*activeSession\s*!==\s*previousBrowserWireSession/.test(restartBody) &&
      /sendBrowserCandidates\(signal,\s*uuid,\s*activeSession,/.test(restartBody) &&
      /sendAnswer\(signal,\s*uuid,\s*streamId,\s*activeSession,/.test(restartBody) &&
      /activeSession/.test(restartBody),
    'a full restart must require the replacement offer session and address every response to it'
  );
  add(
    'REMOTE_FIRST_RESTART_REPLACES_BROWSER_PEER',
    /const\s+reuseBrowserPeer\s*=\s*!sessionRotated/.test(restartBody) &&
      /answerOffer\(page,\s*peerName,\s*offer\.message,\s*reuseBrowserPeer,\s*rtcConfig\)/.test(restartBody) &&
      /sessionRotated\s*\?\s*replacedBrowserPeer/.test(restartBody),
    'the browser must replace its PC only for a rotated VDO session and retain it for same-session renegotiation'
  );
  add(
    'RESTART_BASELINE_IS_ACTUAL_BROWSER_WIRE_SESSION',
    /browser-active-wire-session-matches-restart-caller/.test(restartBody) &&
      /const\s+previousBrowserWireSession\s*=\s*before\s*&&\s*before\.wireSession/.test(restartBody) &&
      /previousBrowserWireSession\s*===\s*previousActiveSession/.test(restartBody) &&
      /activeSession\s*!==\s*previousBrowserWireSession/.test(restartBody),
    'restart rotation must be measured from the browser PC that actually owns the current session, never a stale caller variable'
  );
  add(
    'RESTART_REQUEST_HINT_IS_UUID_SCOPED',
    /previousSession:\s*previousBrowserWireSession/.test(restartBody) &&
      /signal\.send\(\{\s*UUID:\s*uuid,\s*session:\s*requestSessionHint/.test(restartBody) &&
      /activeSession\s*!==\s*previousBrowserWireSession/.test(restartBody) &&
      /pre-answer-wss-ice-restart-creates-one-fresh-offer-b-generation/.test(
        negotiationBody
      ) &&
      /session:\s*ignoredPreAnswerRestartHint/.test(negotiationBody),
    'the restart request session is only a compatibility hint; rotation is measured against the actual prior active session'
  );

  const autoIceBody = functionBody(executableSource, 'runAutoIceScenario');
  const activeMediaBody = functionBody(executableSource, 'runActiveMediaLifecycleScenario');
  const recoverScenarioPeerBody = functionBody(executableSource, 'recoverScenarioPeer');
  add(
    'RESTART_CALLERS_ADVANCE_ACTIVE_WIRE_SESSION',
    /target\.session\s*=\s*restart\.activeSession/.test(autoIceBody) &&
      /session\s*:\s*reset\.activeSession/.test(activeMediaBody),
    'every later restart or cleanup must use the session returned by the previous replacement offer'
  );
  add(
    'REPLACEMENT_MEDIA_BASELINE_IS_POST_REBUILD',
    /const\s+replacementBaseline\s*=\s*requiredMediaCounters\(replacementMediaReady\.state\)/.test(activeMediaBody) &&
      /waitForRequiredMediaAdvance\([\s\S]*?replacementBaseline\s*\)/.test(activeMediaBody) &&
      !/waitForRequiredMediaAdvance\([\s\S]*?beforeReset\s*\)/.test(activeMediaBody),
    'media counters from a replacement browser PC must be compared only with that replacement PC'
  );
  add(
    'AUTO_RESTART_FAILURE_PRESERVES_LATER_CYCLE_COVERAGE',
    /if\s*\(\s*!restart\.ok\s*\)/.test(autoIceBody) &&
      /recoverScenarioPeer\s*\(\s*\{/.test(autoIceBody) &&
      /auto-restart-\$\{cycle\s*\+\s*1\}-fixture-recovery-does-not-hide-product-failure/.test(autoIceBody) &&
      /target\.session\s*=\s*autoFixtureRecovery\.activeSession/.test(autoIceBody) &&
      /target\.connection\s*=\s*autoFixtureRecovery/.test(autoIceBody) &&
      /auto-cycle-\$\{cycle\s*\+\s*1\}-initial-session-is-proven-retired/.test(autoIceBody) &&
      /target\.initialActiveSession\s*!==\s*target\.session/.test(autoIceBody) &&
      /retiredHintBrowserState\.wireSession\s*===\s*target\.session/.test(autoIceBody) &&
      /activeSession\s*!==\s*brokenSession/.test(recoverScenarioPeerBody) &&
      /liveState\.wireSession\s*===\s*recovery\.activeSession/.test(recoverScenarioPeerBody),
    'a failed packaged restart remains RED while a same-UUID replacement creates the live session needed for later retired-hint and unaffected-media cycles'
  );

  const diagnosticsFreezeBody = functionBody(
    executableSource,
    'deepFreezeDiagnosticsSnapshot'
  );
  const diagnosticsBody = functionBody(executableSource, 'readDiagnosticsPeerSnapshot');
  const diagnosticsWaitBody = functionBody(
    executableSource,
    'waitForDiagnosticsPeerSnapshot'
  );
  const candidateOutcomeReadyBody = functionBody(
    executableSource,
    'candidateOutcomeSnapshotReady'
  );
  const candidateOutcomeTerminalBody = functionBody(
    executableSource,
    'candidateOutcomeSnapshotsTerminalAndStable'
  );
  const allCandidateIntrinsicViolations = candidateEvidenceIntrinsicViolations(
    executableSource
  );
  const candidateIntrinsicViolations = candidateOwnedIntrinsicViolations(
    executableSource,
    allCandidateIntrinsicViolations
  );
  const candidateLocalMutationViolations = candidateOutcomeLocalMutationViolations(
    parsedTarget.ast
  );
  const candidateReadyFunctionAst = topLevelFunctionAst(
    parsedTarget.ast,
    'candidateOutcomeSnapshotReady'
  );
  const candidateReadyTopLevelReturns = candidateReadyFunctionAst
    ? candidateReadyFunctionAst.body.body.filter((node) => node.type === 'ReturnStatement')
    : [];
  const candidateReadyConjuncts = candidateReadyTopLevelReturns.length === 1
    ? logicalConjunctionLeaves(candidateReadyTopLevelReturns[0].argument)
    : [];
  const candidateReadyConjunctTypeCounts = candidateReadyConjuncts.reduce(
    (counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }),
    {}
  );
  const candidateTerminalFunctionAst = topLevelFunctionAst(
    parsedTarget.ast,
    'candidateOutcomeSnapshotsTerminalAndStable'
  );
  const candidateTerminalTopLevelReturns = candidateTerminalFunctionAst
    ? candidateTerminalFunctionAst.body.body.filter(
      (node) => node.type === 'ReturnStatement'
    )
    : [];
  const candidateTerminalConjuncts = candidateTerminalTopLevelReturns.length === 1
    ? logicalConjunctionLeaves(candidateTerminalTopLevelReturns[0].argument)
    : [];
  const candidateReadyGuards = [
    ['ready-single-return',
      /^\s*return\s+!!snapshot\s*&&[\s\S]*;\s*$/.test(candidateOutcomeReadyBody) &&
        (candidateOutcomeReadyBody.match(/\breturn\b/g) || []).length === 1],
    ['ready-exact-conjunction-shape',
      !!candidateReadyFunctionAst && candidateReadyFunctionAst.body.body.length === 1 &&
        candidateReadyConjuncts.length === 30 &&
        candidateReadyConjunctTypeCounts.UnaryExpression === 1 &&
        candidateReadyConjunctTypeCounts.BinaryExpression === 18 &&
        candidateReadyConjunctTypeCounts.CallExpression === 11 &&
        Object.keys(candidateReadyConjunctTypeCounts).length === 3],
    ['ready-unique-peer', /snapshot\.peerCount\s*===\s*1/.test(candidateOutcomeReadyBody)],
    ['ready-active-wire-session',
      /snapshot\.activeWireSession\s*===\s*expectedActiveWireSession/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-explicit-send-failure-field',
      /Object\.prototype\.hasOwnProperty\.call\(\s*snapshot\.signaling\s*,\s*['"]local_candidate_send_failures['"]\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-positive-sent-count',
      /Number\(\s*snapshot\.signaling\.local_candidates_sent\s*\|\|\s*0\s*\)\s*>\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-gathering-complete',
      /snapshot\.signaling\.local_candidate_gathering_complete\s*===\s*true/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-callback-count-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_callbacks_in_flight\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-callbacks-in-flight',
      /snapshot\.signaling\.local_candidate_callbacks_in_flight\s*===\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-activity-sequence-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_activity_sequence\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-gathering-epoch-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_gathering_epoch\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-positive-gathering-epoch',
      /snapshot\.signaling\.local_candidate_gathering_epoch\s*>\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-late-candidate-count-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidates_after_gathering_complete\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-late-candidates',
      /snapshot\.signaling\.local_candidates_after_gathering_complete\s*===\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-overlapping-gathering',
      /snapshot\.signaling\.local_candidate_overlapping_gathering_detected\s*===\s*false/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-outstanding-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_outstanding\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-work-outstanding',
      /snapshot\.signaling\.local_candidate_work_outstanding\s*===\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-admitted-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_admitted\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-positive-work-admitted',
      /snapshot\.signaling\.local_candidate_work_admitted\s*>\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-completed-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_completed\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-completed-equals-admitted',
      /snapshot\.signaling\.local_candidate_work_completed\s*===\s*snapshot\.signaling\.local_candidate_work_admitted/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-superseded-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_superseded\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-superseded-nonnegative',
      /snapshot\.signaling\.local_candidate_work_superseded\s*>=\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-retired-outstanding-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_retired_outstanding\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-retired-outstanding',
      /snapshot\.signaling\.local_candidate_retired_outstanding\s*===\s*0/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-invariant-consistent',
      /snapshot\.signaling\.local_candidate_work_invariant_consistent\s*===\s*true/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-work-owned-by-active-offer',
      /snapshot\.signaling\.local_candidate_work_offer_generation\s*===\s*snapshot\.signaling\.active_offer_generation/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-outcome-sequence-safe',
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_outcome_sequence\s*\)/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-accounting-violation',
      /snapshot\.signaling\.local_candidate_accounting_violation\s*===\s*false/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-coherent-snapshot',
      /snapshot\.signaling\.local_candidate_snapshot_coherent\s*===\s*true/.test(
        candidateOutcomeReadyBody
      )],
    ['ready-no-buffered-candidates',
      /snapshot\.signaling\.buffered_local_candidates\s*===\s*0/.test(
        candidateOutcomeReadyBody
      )]
  ];
  const stableCandidateFields = [
    'local_candidate_activity_sequence',
    'local_candidates_sent',
    'local_candidate_send_failures',
    'local_candidate_gathering_epoch',
    'local_candidates_after_gathering_complete',
    'local_candidate_work_outstanding',
    'local_candidate_work_admitted',
    'local_candidate_work_completed',
    'local_candidate_work_superseded',
    'local_candidate_retired_outstanding',
    'local_candidate_outcome_sequence',
    'buffered_local_candidates',
    'active_offer_generation',
    'active_transport_generation',
    'client_transport_generation'
  ];
  const candidateTerminalGuards = [
    ['terminal-exact-conjunction-shape',
      !!candidateTerminalFunctionAst &&
        candidateTerminalFunctionAst.body.body.length === 4 &&
        candidateTerminalFunctionAst.body.body[0].type === 'IfStatement' &&
        candidateTerminalFunctionAst.body.body[1].type === 'VariableDeclaration' &&
        candidateTerminalFunctionAst.body.body[2].type === 'VariableDeclaration' &&
        candidateTerminalFunctionAst.body.body[3].type === 'ReturnStatement' &&
        candidateTerminalConjuncts.length === stableCandidateFields.length &&
        candidateTerminalConjuncts.every((node) =>
          node.type === 'BinaryExpression' && node.operator === '==='
        )],
    ['terminal-initial-snapshot-ready',
      /!candidateOutcomeSnapshotReady\(\s*initialSnapshot\s*,\s*expectedActiveWireSession\s*\)/.test(
        candidateOutcomeTerminalBody
      )],
    ['terminal-final-snapshot-ready',
      /!candidateOutcomeSnapshotReady\(\s*finalSnapshot\s*,\s*expectedActiveWireSession\s*\)/.test(
        candidateOutcomeTerminalBody
      )],
    ['terminal-four-second-diagnostics-gap',
      /finalSnapshot\.generatedSteadyMs\s*-\s*initialSnapshot\.generatedSteadyMs\s*<\s*4000/.test(
        candidateOutcomeTerminalBody
      )],
    ['terminal-fails-closed',
      /\)\s*\{\s*return\s+false\s*;\s*\}/.test(candidateOutcomeTerminalBody)],
    ['terminal-binds-initial-signaling',
      /const\s+initial\s*=\s*initialSnapshot\.signaling\s*;/.test(
        candidateOutcomeTerminalBody
      )],
    ['terminal-binds-final-signaling',
      /const\s+final\s*=\s*finalSnapshot\.signaling\s*;/.test(
        candidateOutcomeTerminalBody
      )],
    ...stableCandidateFields.map((field) => [
      `terminal-stable-${field}`,
      new RegExp(`final\\.${field}\\s*===\\s*initial\\.${field}`).test(
        candidateOutcomeTerminalBody
      )
    ])
  ];
  const candidateWorkflowGuards = [
    ['workflow-initial-terminal-snapshot',
      /const\s+candidateOutcomeInitialSnapshot\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\(\s*diagnosticsPath\s*,\s*duplicateUuid\s*,\s*\(snapshot\)\s*=>\s*candidateOutcomeSnapshotReady\(\s*snapshot\s*,\s*activeDuplicateOffer\.message\.session\s*\)\s*,\s*duplicatePeerSnapshot\s*\?\s*duplicatePeerSnapshot\.generatedSteadyMs\s*:\s*0\s*,\s*8000\s*\)/.test(
        negotiationBody
      )],
    ['workflow-explicit-four-second-observation',
      /await\s+wait\(\s*4000\s*\)\s*;/.test(negotiationBody)],
    ['workflow-second-terminal-snapshot',
      /const\s+candidateOutcomeSnapshot\s*=\s*candidateOutcomeInitialSnapshot\s*\?\s*await\s+waitForDiagnosticsPeerSnapshot\(\s*diagnosticsPath\s*,\s*duplicateUuid\s*,\s*\(snapshot\)\s*=>\s*candidateOutcomeSnapshotsTerminalAndStable\(\s*candidateOutcomeInitialSnapshot\s*,\s*snapshot\s*,\s*activeDuplicateOffer\.message\.session\s*\)\s*,\s*candidateOutcomeInitialSnapshot\.generatedSteadyMs\s*,\s*12000\s*\)\s*:\s*null/.test(
        negotiationBody
      )],
    ['workflow-terminal-verdict-is-recomputed',
      /const\s+candidateOutcomeTerminalAndStable\s*=\s*candidateOutcomeSnapshotsTerminalAndStable\(\s*candidateOutcomeInitialSnapshot\s*,\s*candidateOutcomeSnapshot\s*,\s*activeDuplicateOffer\.message\.session\s*\)\s*;/.test(
        negotiationBody
      )],
    ['workflow-final-snapshot-is-frozen',
      /const\s+candidateOutcomeSignaling\s*=\s*Object\.freeze\(\s*\{\s*\.\.\.\(candidateOutcomeSnapshot\s*\?\s*candidateOutcomeSnapshot\.signaling\s*:\s*\{\s*\}\s*\)\s*\}\s*\)\s*;/.test(
        negotiationBody
      )],
    ['workflow-verdict-consumes-terminal-pair',
      /duplicateConnected\.ok\s*&&\s*duplicateMedia\.ok\s*&&\s*candidateOutcomeTerminalAndStable\s*&&\s*!!candidateOutcomeSnapshot\s*&&/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-gathering-terminal',
      /candidateOutcomeSignaling\.local_candidate_gathering_complete\s*===\s*true/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-no-callbacks',
      /candidateOutcomeSignaling\.local_candidate_callbacks_in_flight\s*===\s*0/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-admitted-work',
      /Number\.isSafeInteger\(\s*observedLocalCandidateWorkAdmitted\s*\)\s*&&\s*observedLocalCandidateWorkAdmitted\s*>\s*0/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-exact-work-completion',
      /observedLocalCandidateWorkCompleted\s*===\s*observedLocalCandidateWorkAdmitted/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-no-retired-work',
      /candidateOutcomeSignaling\.local_candidate_retired_outstanding\s*===\s*0/.test(
        negotiationBody
      )],
    ['workflow-verdict-requires-work-invariant',
      /candidateOutcomeSignaling\.local_candidate_work_invariant_consistent\s*===\s*true/.test(
        negotiationBody
      )],
    ['workflow-evidence-includes-both-snapshots',
      /terminalAndStable:\s*candidateOutcomeTerminalAndStable\s*,\s*initialSnapshot:\s*candidateOutcomeInitialSnapshot\s*,\s*snapshot:\s*candidateOutcomeSnapshot/.test(
        negotiationBody
      )]
  ];
  const candidateOutcomeContractMissing = [
    ...candidateReadyGuards,
    ...candidateTerminalGuards,
    ...candidateWorkflowGuards
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
  const candidateOutcomeCheckStart = negotiationBody.indexOf(
    'packaged-local-candidate-send-outcomes-are-observed'
  );
  const duplicateMediaCheckStart = negotiationBody.indexOf(
    'duplicate-request-offer-establishes-data-and-media'
  );
  const answerReplayStart = negotiationBody.indexOf(
    'exact-answer-replay-is-ignored-with-transport-intact'
  );
  add(
    'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN',
    candidateOutcomeCheckStart > duplicateMediaCheckStart &&
      answerReplayStart > candidateOutcomeCheckStart &&
      candidateIntrinsicViolations.length === 0 &&
      candidateLocalMutationViolations.length === 0 &&
      candidateOutcomeContractMissing.length === 0 &&
      /^\s*if\s*\(\s*!value\s*\|\|\s*typeof\s+value\s*!==\s*['"]object['"]\s*\|\|\s*Object\.isFrozen\(value\)\s*\)\s*\{\s*return\s+value\s*;\s*\}\s*for\s*\(\s*const\s+child\s+of\s+Object\.values\(value\)\s*\)\s*\{\s*deepFreezeDiagnosticsSnapshot\(child\)\s*;\s*\}\s*return\s+Object\.freeze\(value\)\s*;\s*$/.test(
        diagnosticsFreezeBody
      ) &&
      (executableSource.match(/deepFreezeDiagnosticsSnapshot\s*\(/g) || []).length === 7 &&
      /^\s*try\s*\{\s*const\s+document\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*JSON\.parse\(\s*fs\.readFileSync\(diagnosticsPath,\s*['"]utf8['"]\)\s*\)\s*\)\s*;\s*const\s+matches\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*\(Array\.isArray\(document\.peers\)\s*\?\s*document\.peers\s*:\s*\[\s*\]\s*\)\.filter\(\s*\(entry\)\s*=>\s*entry\s*&&\s*entry\.uuid\s*===\s*uuid\s*\)\s*\)\s*;\s*const\s+common\s*=/.test(
        diagnosticsBody
      ) &&
      /timeline:\s*\[\s*\]\s*\}\s*\)\s*;\s*\}\s*const\s+peer\s*=\s*matches\[0\]\s*;/.test(
        diagnosticsBody
      ) &&
      /const\s+peer\s*=\s*matches\[0\]\s*;\s*const\s+signaling\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*\{\s*\.\.\.\(peer\.signaling\s*\|\|\s*\{\s*\}\s*\)\s*\}\s*\)\s*;\s*const\s+activeWireSessionSource\s*=/.test(
        diagnosticsBody
      ) &&
      (diagnosticsBody.match(/return\s+deepFreezeDiagnosticsSnapshot\s*\(\s*\{/g) || [])
        .length === 2 &&
      (diagnosticsBody.match(/\breturn\b/g) || []).length === 3 &&
      (diagnosticsBody.match(/return\s+null\s*;/g) || []).length === 1 &&
      /const\s+snapshot\s*=\s*readDiagnosticsPeerSnapshot\(\s*diagnosticsPath\s*,\s*uuid\s*\)\s*;\s*if\s*\(\s*snapshot\s*&&\s*snapshot\.generatedSteadyMs\s*>\s*afterGeneratedSteadyMs\s*&&\s*predicate\(snapshot\)\s*\)/.test(
        diagnosticsWaitBody
      ) &&
      (executableSource.match(/candidateOutcomeSnapshotReady\s*\(/g) || []).length === 4 &&
      (executableSource.match(/candidateOutcomeSnapshotsTerminalAndStable\s*\(/g) || [])
        .length === 3 &&
      /const\s+candidateFailureFieldPresent\s*=\s*Object\.prototype\.hasOwnProperty\.call\(\s*candidateOutcomeSignaling\s*,\s*['"]local_candidate_send_failures['"]\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /const\s+observedLocalCandidatesSent\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidates_sent\s*\|\|\s*0\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /const\s+observedLocalCandidateSendFailures\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_send_failures\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /const\s+observedLocalCandidateActivitySequence\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_activity_sequence\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /const\s+observedLocalCandidateWorkAdmitted\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_work_admitted\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /const\s+observedLocalCandidateWorkCompleted\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_work_completed\s*\)\s*;/.test(
        negotiationBody
      ) &&
      /Number\.isSafeInteger\(observedLocalCandidatesSent\)/.test(negotiationBody) &&
      /observedLocalCandidatesSent\s*>\s*0/.test(negotiationBody) &&
      /candidateFailureFieldPresent/.test(negotiationBody) &&
      /Number\.isSafeInteger\(observedLocalCandidateSendFailures\)/.test(
        negotiationBody
      ) &&
      /observedLocalCandidateSendFailures\s*===\s*0/.test(negotiationBody) &&
      /duplicateConnected\.ok\s*&&\s*duplicateMedia\.ok[\s\S]{0,520}Number\.isSafeInteger\(observedLocalCandidatesSent\)[\s\S]{0,120}observedLocalCandidatesSent\s*>\s*0\s*&&\s*candidateFailureFieldPresent\s*&&[\s\S]{0,120}Number\.isSafeInteger\(observedLocalCandidateSendFailures\)[\s\S]{0,120}observedLocalCandidateSendFailures\s*===\s*0/.test(
        negotiationBody
      ) &&
      /['"]packaged-local-candidate-send-outcomes-are-observed['"]\s*,\s*duplicateConnected\.ok\s*&&\s*duplicateMedia\.ok\s*&&\s*candidateOutcomeTerminalAndStable\s*&&\s*!!candidateOutcomeSnapshot\s*&&/.test(
        negotiationBody
      ),
    `a real packaged successful peer must expose an exact terminal candidate-work ledger in two immutable diagnostics snapshots at least 4000ms apart, with no late/overlapping work, callbacks, retired work, accounting violation, or coherence failure; missing=${candidateOutcomeContractMissing.join(',') || 'none'} localMutations=${candidateLocalMutationViolations.join(',') || 'none'} intrinsicViolations=${candidateIntrinsicViolations.join(',') || 'none'} excludedUnownedIntrinsic=${allCandidateIntrinsicViolations.length - candidateIntrinsicViolations.length}`
  );
  add(
    'DIAGNOSTICS_PEER_SELECTION_IS_UUID_SCOPED_AND_UNIQUE',
    /filter\(\(entry\)\s*=>\s*entry\s*&&\s*entry\.uuid\s*===\s*uuid\s*\)/.test(diagnosticsBody) &&
      /matches\.length\s*!==\s*1/.test(diagnosticsBody) &&
      !/entry\.session\s*===\s*session/.test(diagnosticsBody) &&
      /duplicate-offer-request-keeps-one-uuid-scoped-publisher-peer/.test(negotiationBody) &&
      /duplicatePeerSnapshot\.peerCount\s*===\s*1/.test(negotiationBody) &&
      /duplicatePeerSnapshot\.uuidOwnerHighWatermark\s*===\s*1/.test(negotiationBody) &&
      /uuidOwnerHighWatermark:\s*Number\(peer\.uuid_owner_high_watermark\s*\|\|\s*0\)/.test(diagnosticsBody) &&
      /duplicatePeerSnapshot\.activeWireSession\s*===\s*activeDuplicateOffer\.message\.session/.test(negotiationBody) &&
      /snapshot\.generatedSteadyMs\s*>\s*preDuplicatePeerSnapshot\.generatedSteadyMs/.test(negotiationBody) &&
      /preDuplicatePeerSnapshot\.generatedSteadyMs/.test(negotiationBody),
    'diagnostics must prove exactly one publisher peer per viewer UUID and report wire session separately'
  );

  add(
    'INITIAL_WIRE_SESSION_IS_PUBLISHER_GENERATED_AND_UUID_SCOPED',
    /initial-offer-uses-publisher-generated-wire-session/.test(negotiationBody) &&
      /first\.message\.session\s*!==\s*duplicateRequestSessionA/.test(negotiationBody) &&
      /requestOffer\(signal,\s*duplicateUuid,\s*streamId,\s*duplicateRequestSessionB\)/.test(negotiationBody) &&
      /requestOffer\(signal,\s*duplicateUuid,\s*streamId,\s*duplicateRequestSessionC\)/.test(negotiationBody) &&
      /unresolved-duplicate-waits-then-creates-exactly-one-fresh-offer/.test(
        negotiationBody
      ) &&
      /second\.message\.session\s*!==\s*duplicateRequestSessionA/.test(negotiationBody) &&
      /second\.message\.session\s*!==\s*duplicateRequestSessionB/.test(negotiationBody) &&
      /second\.message\.session\s*!==\s*duplicateRequestSessionC/.test(negotiationBody) &&
      /pre-answer-restart-offer-a-uses-publisher-generated-wire-session/.test(negotiationBody) &&
      /preAnswerOfferA\.message\.session\s*!==\s*preAnswerRestartSession/.test(negotiationBody),
    'request session values are routing hints only; every created publisher PeerConnection owns a non-request, non-default wire session'
  );
  add(
    'UNRESOLVED_DUPLICATE_RECHECK_IS_DELAYED_AND_REPLACES_EXACTLY_ONCE',
    duplicateFreshReplacementSpan.length > 0 &&
      /second\.message\.session\s*!==\s*first\.message\.session/.test(
        duplicateFreshReplacementSpan
      ) &&
      /second\.message\.description\.sdp\s*!==\s*first\.message\.description\.sdp/.test(
        duplicateFreshReplacementSpan
      ) &&
      /secondUfrag\s*!==\s*firstUfrag/.test(duplicateFreshReplacementSpan) &&
      /const\s+duplicateNoEarlyOfferObservationMs\s*=\s*750/.test(negotiationBody) &&
      /earlyDuplicateOffers\.length\s*===\s*0/.test(negotiationBody) &&
      /duplicateReplacementOffers\.length\s*===\s*1/.test(negotiationBody) &&
      /duplicateReplacementElapsedMs\s*>=\s*duplicateNoEarlyOfferObservationMs/.test(
        negotiationBody
      ) &&
      /duplicateReplacementElapsedMs\s*<=\s*2500/.test(negotiationBody) &&
      /const\s+unresolvedDuplicateReplacementVerdict\s*=/.test(negotiationBody) &&
      /unresolved-duplicate-waits-then-creates-exactly-one-fresh-offer/.test(
        negotiationBody
      ) &&
      !/duplicateSuppressed|exactSecondReplay|vdoCompatibleDisposition/.test(negotiationBody),
    'an unanswered duplicate waits for the VDO recheck, never replays or suppresses A as a final result, and emits exactly one fresh session/SDP/ufrag B'
  );
  add(
    'DUPLICATE_RECHECK_LOGS_BIND_EXACT_OFFER_A_IDENTITY',
    /Scheduled unresolved duplicate offer recheck/.test(duplicateRecheckMatcherBody) &&
      /Coalesced unresolved duplicate offer recheck/.test(duplicateRecheckMatcherBody) &&
      /Duplicate offer recheck replacing unresolved transport/.test(
        duplicateRecheckMatcherBody
      ) &&
      /Duplicate offer recheck canceled/.test(duplicateRecheckMatcherBody) &&
      /activeSession=\$\{activeWireSession\}/.test(duplicateRecheckMatcherBody) &&
      /offerGeneration=\$\{identity\.offerGeneration\}/.test(
        duplicateRecheckMatcherBody
      ) &&
      /transportGeneration=\$\{identity\.transportGeneration\}/.test(
        duplicateRecheckMatcherBody
      ) &&
      /clientGeneration=\$\{identity\.clientGeneration\}/.test(
        duplicateRecheckMatcherBody
      ) &&
      /delayMs=1000/.test(duplicateRecheckMatcherBody) &&
      /scheduledDuplicateRechecks\.length\s*===\s*1/.test(negotiationBody) &&
      /coalescedDuplicateRechecks\.length\s*===\s*1/.test(negotiationBody) &&
      /replacingDuplicateRechecks\.length\s*===\s*1/.test(negotiationBody) &&
      /replacingLineIndex\s*>\s*coalescedLineIndex/.test(negotiationBody),
    'schedule, coalesce, and replacement logs must each identify the exact unresolved A instance and occur in order'
  );
  add(
    'DUPLICATE_RECHECK_IGNORES_PEER_CONNECTED_BEFORE_DEADLINE',
    /const\s+connectedBeforeRecheckDeadlineMs\s*=\s*850/.test(negotiationBody) &&
      /const\s+connectedRecheckQuiescenceMs\s*=\s*1800/.test(negotiationBody) &&
      /connectedDuringRecheckOffers\.length\s*===\s*0/.test(negotiationBody) &&
      /connectedRecheckSchedules\.length\s*===\s*1/.test(negotiationBody) &&
      /connectedRecheckCancellations\.length\s*===\s*1/.test(negotiationBody) &&
      /connectedRecheckReplacements\.length\s*===\s*0/.test(negotiationBody) &&
      /active_transport_generation\)\s*===\s*connectedDuringRecheckIdentity\.transportGeneration/.test(
        negotiationBody
      ) &&
      /client_transport_generation\)\s*===\s*connectedDuringRecheckIdentity\.clientGeneration/.test(
        negotiationBody
      ) &&
      /duplicate-connected-before-deadline-is-ignored-after-same-instance-recheck/.test(
        negotiationBody
      ),
    'a duplicate scheduled while unresolved must be canceled, without B, when that exact A instance connects before its one-second recheck'
  );
  add(
    'PRE_ANSWER_PRODUCT_FAILURE_PRESERVES_DOWNSTREAM_COVERAGE',
    /const\s+preAnswerOfferUsable\s*=\s*!!preAnswerOfferAUfrag\s*&&\s*!!preAnswerOfferA\.message\.session\s*;/.test(negotiationBody) &&
      /pre-answer-restart-offer-a-has-an-ice-generation/.test(negotiationBody) &&
      /if\s*\(\s*preAnswerOfferUsable\s*\)/.test(negotiationBody) &&
      !/preAnswerOfferUsable\s*=\s*[\s\S]{0,180}preAnswerOfferA\.message\.session\s*!==\s*preAnswerRestartSession/.test(negotiationBody) &&
      executableReturnScannerValid &&
      preAnswerCriticalSpan.length > 0 &&
      !hasExecutableReturn(preAnswerCriticalSpan) &&
      /older-generation-offer-a-arrives/.test(negotiationBody),
    'an echoed session or malformed pre-answer offer stays a product RED and may skip only that dependent subcase, never the independent stale-generation and plugin chain'
  );
  add(
    'PRE_ANSWER_WSS_RESTART_CREATES_FRESH_PC_SESSION_SDP_AND_UFRAG',
    /iceRestartRequest:\s*true/.test(preAnswerCriticalSpan) &&
      /const\s+preAnswerRestartImmediateDeadlineMs\s*=\s*750/.test(
        preAnswerCriticalSpan
      ) &&
      /Number\.isFinite\(productRestartOfferBElapsedMs\)/.test(preAnswerCriticalSpan) &&
      /productRestartOfferBElapsedMs\s*<\s*preAnswerRestartImmediateDeadlineMs/.test(
        preAnswerCriticalSpan
      ) &&
      /productRestartOffers\.length\s*===\s*1/.test(preAnswerCriticalSpan) &&
      /productRestartOfferB\.message\.session\s*!==\s*preAnswerOfferA\.message\.session/.test(
        preAnswerCriticalSpan
      ) &&
      /productRestartOfferB\.message\.description\.sdp\s*!==[\s\S]{0,100}?preAnswerOfferA\.message\.description\.sdp/.test(
        preAnswerCriticalSpan
      ) &&
      /productRestartOfferBUfrag\s*!==\s*preAnswerOfferAUfrag/.test(
        preAnswerCriticalSpan
      ) &&
      /productRestartRebuildLines\.length\s*===\s*1/.test(preAnswerCriticalSpan) &&
      /reason=signaling-ice-restart/.test(preAnswerCriticalSpan) &&
      /forbiddenCachedRestartLines\.length\s*===\s*0/.test(preAnswerCriticalSpan) &&
      /pre-answer-wss-ice-restart-creates-one-fresh-offer-b-generation/.test(
        preAnswerCriticalSpan
      ),
    'an explicit publisher-WebSocket restart before answer A must bypass the duplicate timer, rebuild once into fresh B, and may never replay or satisfy from cached A'
  );
  add(
    'PRE_ANSWER_RESTART_STALE_A_CANNOT_CROSS_EXACT_B_WORKFLOW',
    /sendExactBrowserCandidate\([\s\S]{0,120}?preAnswerOfferA\.message\.session[\s\S]{0,120}?preAnswerCandidateA/.test(
        preAnswerCriticalSpan
      ) &&
      /sendAnswer\([\s\S]{0,140}?preAnswerOfferA\.message\.session,[\s\S]{0,80}?preAnswerA\.sdp/.test(
        preAnswerCriticalSpan
      ) &&
      /const\s+preAnswerStaleAQuiescenceMs\s*=\s*1000/.test(
        preAnswerCriticalSpan
      ) &&
      /staleACandidateRejectionLines\.length\s*===\s*1/.test(
        preAnswerCriticalSpan
      ) &&
      /staleAAnswerRejectionLines\.length\s*===\s*1/.test(preAnswerCriticalSpan) &&
      /staleAForbiddenCandidateRoutingLines\.length\s*===\s*0/.test(
        preAnswerCriticalSpan
      ) &&
      /staleAForbiddenAnswerApplyLines\.length\s*===\s*0/.test(
        preAnswerCriticalSpan
      ) &&
      /JSON\.stringify\(offerBStateAfterStaleA\)\s*===\s*JSON\.stringify\(offerBStateBeforeStaleA\)/.test(
        preAnswerCriticalSpan
      ) &&
      /preAnswerB\.peerInstanceId\s*!==\s*preAnswerA\.peerInstanceId/.test(
        preAnswerCriticalSpan
      ) &&
      /preAnswerBConnected\.ok\s*&&\s*preAnswerBMedia\.ok/.test(
        preAnswerCriticalSpan
      ) &&
      /pre-answer-restart-exact-offer-b-establishes-data-and-fresh-video/.test(
        preAnswerCriticalSpan
      ),
    'real A candidate/answer bytes must be rejected after B replacement, then an exact-session replacement browser PC must open data and advance fresh media'
  );
  add(
    'PRE_ANSWER_RESTART_FAILURE_RECOVERY_DOES_NOT_HIDE_RED',
    /if\s*\(\s*!freshPreAnswerRestartVerdict\s*\)/.test(preAnswerCriticalSpan) &&
      /pre-answer-restart-product-failure-recovery-removes-broken-owner/.test(
        preAnswerCriticalSpan
      ) &&
      /pre-answer-restart-product-failure-recovery-restores-distinct-offer-b/.test(
        preAnswerCriticalSpan
      ) &&
      /pre-answer-restart-fixture-recovery-does-not-hide-product-failure/.test(
        preAnswerCriticalSpan
      ) &&
      !/if\s*\(\s*!freshPreAnswerRestartVerdict\s*\)\s*\{\s*return\b/.test(
        preAnswerCriticalSpan
      ),
    'a bad packaged restart stays RED while explicit cleanup/re-add preserves stale-A and exact-B measurements'
  );
  add(
    'RETIRED_SESSION_HINTS_REMAIN_UUID_SCOPED_CONTROLS',
      /UUID:\s*staleUuid,\s*session:\s*offerA\.message\.session,\s*streamID:\s*streamId,\s*iceRestartRequest:\s*true/.test(negotiationBody) &&
      /full-peer-rebuild-rotates-wire-session/.test(negotiationBody) &&
      /auto-restart-with-retired-session-hint-is-uuid-scoped/.test(autoIceBody) &&
      /cycle\s*>=\s*peers\.length\s*\?\s*target\.initialActiveSession\s*:\s*target\.session/.test(autoIceBody) &&
      /session:\s*cleanupRetiredSession,[\s\S]{0,100}let\s+removed\s*=\s*false/.test(activeMediaBody) &&
      /cleanupRetiredSession\s*!==\s*removedActiveSession/.test(activeMediaBody),
    'restart and cleanup requests route by UUID even when their compatibility hint names a known retired session; unanswered offer requests are covered by the authoritative delayed-replacement scenario'
  );
  add(
    'ANSWER_AND_CANDIDATE_SESSION_GUARDS_ARE_CONTENT_INDEPENDENT',
    /offer-b-candidate-labeled-as-retired-a-is-rejected-before-content-routing/.test(negotiationBody) &&
      /offer-b-candidate-identical-bytes-are-accepted-under-active-b-session/.test(negotiationBody) &&
      /offer-b-answer-labeled-as-retired-a-is-rejected-before-sdp-routing/.test(negotiationBody) &&
      /offer-b-answer-identical-sdp-is-accepted-under-active-b-session/.test(negotiationBody) &&
      /sendExactBrowserCandidate\(\s*signal,\s*staleUuid,\s*offerA\.message\.session,\s*activeCandidateB/.test(negotiationBody) &&
      /sendExactBrowserCandidate\(\s*signal,\s*staleUuid,\s*offerB\.message\.session,\s*activeCandidateB/.test(negotiationBody) &&
      /sendAnswer\(\s*signal,\s*staleUuid,\s*streamId,\s*offerA\.message\.session,\s*validAnswerB\.sdp/.test(negotiationBody) &&
      /sendAnswer\(signal,\s*staleUuid,\s*streamId,\s*offerB\.message\.session,\s*validAnswerB\.sdp\)/.test(negotiationBody),
    'identical candidate/answer content must be rejected or accepted solely by the retired versus active wire-session label'
  );
  const activeCandidateAnswerIndex = negotiationBody.search(
    /sendAnswer\(\s*signal,\s*staleUuid,\s*streamId,\s*[^,\r\n]+,\s*validAnswerB\.sdp\s*\);\s*const\s+isolatedActiveCandidateAppliedSnapshot/
  );
  const isolatedCandidateSnapshotIndex = negotiationBody.indexOf(
    'const isolatedActiveCandidateAppliedSnapshot'
  );
  const remainingCandidateSendIndex = negotiationBody.search(
    /sendBrowserCandidates\(\s*signal,\s*staleUuid,\s*offerB\.message\.session,\s*remainingActiveCandidatesB\s*\)/
  );
  add(
    'ACTIVE_CANDIDATE_APPLICATION_IS_ISOLATED_BEFORE_REMAINDER',
    /\(snapshot\)\s*=>\s*Number\(\s*snapshot\.signaling\.remote_candidates_applied\s*\)\s*===\s*appliedAfterMislabeledActiveCandidate\s*\+\s*1/.test(negotiationBody) &&
      /isolatedActiveCandidateApplied\s*===\s*appliedAfterMislabeledActiveCandidate\s*\+\s*1/.test(negotiationBody) &&
      activeCandidateAnswerIndex >= 0 &&
      isolatedCandidateSnapshotIndex > activeCandidateAnswerIndex &&
      remainingCandidateSendIndex > isolatedCandidateSnapshotIndex,
    'the one correctly labeled candidate must produce an exact isolated +1 before any remaining generation-B candidates are sent'
  );
  add(
    'STALE_CANDIDATE_SOURCE_PROVENANCE',
    /candidate\.sourcePeerInstanceId\s*===\s*validAnswerA\.peerInstanceId/.test(negotiationBody) &&
      /candidate\.sourceGenerationUfrag\s*===\s*answerAUfrag/.test(negotiationBody) &&
      /candidate\.sourceCandidateIndex\s*>=\s*validAnswerA\.candidateStart/.test(negotiationBody) &&
      /candidate\.sourceCandidateIndex\s*<\s*validAnswerA\.candidateEnd/.test(negotiationBody) &&
      /canonicalBrowserCandidateWire\(candidate\)/.test(negotiationBody),
    'the injected stale candidate must be proven to originate from PC A without relying on browser-specific wire ufrag fields'
  );

  const exactCandidateBody = functionBody(executableSource, 'sendExactBrowserCandidate');
  const candidateFingerprintScalarBody = functionBody(
    executableSource,
    'canonicalCandidateFingerprintScalar'
  );
  const candidateFingerprintBody = functionBody(
    executableSource,
    'canonicalBrowserCandidateFingerprint'
  );
  const candidateFingerprintCoverageBody = functionBody(
    executableSource,
    'browserCandidateFingerprintCoversWire'
  );
  const candidateFingerprintHashBody = functionBody(
    executableSource,
    'browserCandidateWireSha256'
  );
  add(
    'STALE_CANDIDATE_WIRE_FIDELITY',
    /const\s+wire\s*=\s*browserCandidateWire\(candidate\)/.test(exactCandidateBody) &&
      /candidate\s*:\s*wire/.test(exactCandidateBody) &&
      !/usernameFragment\s*:/.test(exactCandidateBody) &&
      !/sourceGenerationUfrag/.test(exactCandidateBody),
    'the stale-candidate injection must forward exact browser wire JSON and must never synthesize Chromium-style generation tags'
  );
  add(
    'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL',
    /const\s+CANDIDATE_FINGERPRINT_FIELDS\s*=\s*\[\s*['"]candidate['"]\s*,\s*['"]sdpMid['"]\s*,\s*['"]sdpMLineIndex['"]\s*,\s*['"]usernameFragment['"]\s*\]/.test(executableSource) &&
      /value\s*===\s*undefined[\s\S]*?['"]u0:['"]/.test(candidateFingerprintScalarBody) &&
      /value\s*===\s*null[\s\S]*?['"]n0:['"]/.test(candidateFingerprintScalarBody) &&
      /typeof\s+value\s*===\s*['"]number['"]\s*\?\s*['"]d['"][\s\S]*?typeof\s+value\s*===\s*['"]boolean['"]\s*\?\s*['"]b['"]\s*:\s*['"]s['"]/.test(candidateFingerprintScalarBody) &&
      /Buffer\.byteLength\(text,\s*['"]utf8['"]\)/.test(candidateFingerprintScalarBody) &&
      /CANDIDATE_FINGERPRINT_FIELDS\.map/.test(candidateFingerprintBody) &&
      /canonicalCandidateFingerprintScalar\(wire\[field\]\)/.test(candidateFingerprintBody) &&
      /Object\.keys\(wire\)\.every/.test(candidateFingerprintCoverageBody) &&
      /CANDIDATE_FINGERPRINT_FIELDS\.includes\(field\)/.test(candidateFingerprintCoverageBody) &&
      /typeof\s+wire\.candidate\s*===\s*['"]string['"]\s*&&\s*wire\.candidate\.length\s*>\s*0/.test(candidateFingerprintCoverageBody) &&
      /wire\.sdpMid\s*===\s*null\s*\|\|\s*typeof\s+wire\.sdpMid\s*===\s*['"]string['"]/.test(candidateFingerprintCoverageBody) &&
      /wire\.sdpMLineIndex\s*===\s*null\s*\|\|\s*Number\.isInteger\(wire\.sdpMLineIndex\)/.test(candidateFingerprintCoverageBody) &&
      /wire\.usernameFragment\s*===\s*undefined[\s\S]*?wire\.usernameFragment\s*===\s*null[\s\S]*?typeof\s+wire\.usernameFragment\s*===\s*['"]string['"]/.test(candidateFingerprintCoverageBody) &&
      /update\(canonicalBrowserCandidateFingerprint\(candidate\),\s*['"]utf8['"]\)/.test(candidateFingerprintHashBody) &&
      /browserCandidateFingerprintCoversWire\(staleCandidateA\)/.test(negotiationBody) &&
      /browserCandidateFingerprintCoversWire\(activeCandidateB\)/.test(negotiationBody),
    'candidate hashes use a fixed field order, explicit null/type tags, and UTF-8 byte lengths shared with native code while the sent browser object remains untouched'
  );

  add(
    'STALE_CANDIDATE_QUEUE_OBSERVABILITY',
    /\[Signaling\] Queued remote ICE candidate uuid=/.test(negotiationBody) &&
      !/\[Signaling\] Queued remote ICE candidate before peer session ready/.test(negotiationBody),
    'queue detection must match the production log that is actually emitted'
  );

  add(
    'STALE_CANDIDATE_POST_ANSWER_NON_APPLICATION_PROOF',
    /generation-a-candidate-is-not-drained-or-applied-to-offer-b/.test(negotiationBody) &&
      /remote_candidates_applied/.test(negotiationBody) &&
      /candidateRejectedBeforeAnswerB/.test(negotiationBody) &&
      /oldSessionCandidateQueuedCount/.test(negotiationBody) &&
      !/postRecoveryApplyIncrement\s*===\s*expectedGenerationBCandidateApplyCount/.test(negotiationBody),
    'post-answer proof must carry the exact pre-answer rejection and old-session queue result instead of trusting an aggregate candidate count'
  );
  const staleRejectionBody = functionBody(executableSource, 'explicitStaleCandidateRejectionLines');
  const staleAnswerRejectionBody = functionBody(executableSource, 'explicitStaleAnswerRejectionLines');
  const sessionlessAnswerRejectionBody = functionBody(
    executableSource,
    'explicitSessionlessWssAnswerRejectionLines'
  );
  const sessionlessCandidateRejectionBody = functionBody(
    executableSource,
    'explicitSessionlessWssCandidateRejectionLines'
  );
  const sendAnswerBody = functionBody(executableSource, 'sendAnswer');
  const sendSessionlessAnswerBody = functionBody(executableSource, 'sendSessionlessAnswer');
  const sendSessionlessCandidateBody = functionBody(
    executableSource,
    'sendSessionlessBrowserCandidate'
  );
  const sessionlessDownstreamStateBody = functionBody(
    executableSource,
    'sessionlessWssDownstreamState'
  );
  const waitForPublisherOutputBody = functionBody(executableSource, 'waitForPublisherOutput');
  const startSignalServerBody = functionBody(executableSource, 'startSignalServer');
  const exactLogTokenBody = functionBody(executableSource, 'logHasExactToken');
  const peerIdentityBody = functionBody(executableSource, 'signalLineIdentifiesPeer');
  const shaIdentityBody = functionBody(executableSource, 'signalLineIdentifiesSha256');
  let exactMatcherContract = { ok: false, error: 'matcher compilation did not run' };
  try {
    const escapeMatcher = new Function(
      'value',
      functionBody(executableSource, 'escapeRegExp')
    );
    const exactTokenMatcher = new Function(
      'escapeRegExp',
      `return function(line, token) {${exactLogTokenBody}};`
    )(escapeMatcher);
    const peerMatcher = new Function(
      'logHasExactToken',
      `return function(line, uuid, wireSession) {${peerIdentityBody}};`
    )(exactTokenMatcher);
    const shaMatcher = new Function(
      'logHasExactToken',
      `return function(line, payloadSha256) {${shaIdentityBody}};`
    )(exactTokenMatcher);
    const uuid = 'peer-123';
    const session = 'wire-456';
    const sha256 = 'a'.repeat(64);
    const cases = {
      compositePositive: peerMatcher(`rejected ${uuid}:${session} source=wss`, uuid, session),
      keyValuePositive: peerMatcher(`rejected uuid=${uuid} session=${session}`, uuid, session),
      hashPositive: shaMatcher(`rejected sha256=${sha256}`, sha256),
      compositeSessionSuffixRejected:
        !peerMatcher(`rejected ${uuid}:${session}-other source=wss`, uuid, session),
      uuidSuffixRejected:
        !peerMatcher(`rejected uuid=${uuid}-other session=${session}`, uuid, session),
      sessionSuffixRejected:
        !peerMatcher(`rejected uuid=${uuid} session=${session}-other`, uuid, session),
      hashSuffixRejected: !shaMatcher(`rejected sha256=${sha256}0`, sha256),
      hashPrefixRejected: !shaMatcher(`rejected xsha256=${sha256}`, sha256)
    };
    exactMatcherContract = {
      ok: Object.values(cases).every(Boolean),
      cases
    };
  } catch (error) {
    exactMatcherContract = {
      ok: false,
      error: String(error && error.message ? error.message : error)
    };
  }
  let sessionlessMatcherContract = {
    ok: false,
    error: 'sessionless matcher compilation did not run'
  };
  try {
    const escapeMatcher = new Function(
      'value',
      functionBody(executableSource, 'escapeRegExp')
    );
    const exactTokenMatcher = new Function(
      'escapeRegExp',
      `return function(line, token) {${exactLogTokenBody}};`
    )(escapeMatcher);
    const answerMatcher = new Function(
      'logHasExactToken',
      `return function(output, uuid, activeWireSession, answerSdpSha256) {` +
        `${sessionlessAnswerRejectionBody}};`
    )(exactTokenMatcher);
    const candidateMatcher = new Function(
      'logHasExactToken',
      `return function(output, uuid, activeWireSession, candidateSha256) {` +
        `${sessionlessCandidateRejectionBody}};`
    )(exactTokenMatcher);
    const uuid = 'sessionless-peer';
    const activeSession = 'publisher-session-b';
    const answerSha256 = 'b'.repeat(64);
    const candidateSha256 = 'c'.repeat(64);
    const answerLine = '[Signaling] Rejecting publisher WebSocket answer ' +
      `reason=missing-session uuid=${uuid} source=signaling-wss ` +
      `receivedSession=missing activeSession=${activeSession} ` +
      `answerSdpSha256=${answerSha256}`;
    const candidateLine = '[Signaling] Rejecting publisher WebSocket remote ICE candidate ' +
      `reason=missing-session uuid=${uuid} source=signaling-wss ` +
      `receivedSession=missing activeSession=${activeSession} ` +
      `candidateSha256=${candidateSha256}`;
    const cases = {
      answerPositive: answerMatcher(
        answerLine,
        uuid,
        activeSession,
        answerSha256
      ).length === 1,
      candidatePositive: candidateMatcher(
        candidateLine,
        uuid,
        activeSession,
        candidateSha256
      ).length === 1,
      answerWrongUuidRejected: answerMatcher(
        answerLine,
        `${uuid}-other`,
        activeSession,
        answerSha256
      ).length === 0,
      answerWrongSessionRejected: answerMatcher(
        answerLine,
        uuid,
        `${activeSession}-other`,
        answerSha256
      ).length === 0,
      answerWrongHashRejected: answerMatcher(
        answerLine,
        uuid,
        activeSession,
        'd'.repeat(64)
      ).length === 0,
      candidateWrongHashRejected: candidateMatcher(
        candidateLine,
        uuid,
        activeSession,
        'e'.repeat(64)
      ).length === 0,
      answerWrongSourceRejected: answerMatcher(
        answerLine.replace('source=signaling-wss', 'source=datachannel'),
        uuid,
        activeSession,
        answerSha256
      ).length === 0,
      candidateMissingReasonRejected: candidateMatcher(
        candidateLine.replace('reason=missing-session ', ''),
        uuid,
        activeSession,
        candidateSha256
      ).length === 0
    };
    sessionlessMatcherContract = {
      ok: Object.values(cases).every(Boolean),
      cases
    };
  } catch (error) {
    sessionlessMatcherContract = {
      ok: false,
      error: String(error && error.message ? error.message : error)
    };
  }
  add(
    'EXACT_REJECTION_LOG_IDENTITY_TOKENS_ARE_BOUNDARY_MATCHED',
    /new\s+RegExp/.test(exactLogTokenBody) &&
      /escapeRegExp\(token\)/.test(exactLogTokenBody) &&
      /pattern\.test\(String\(line\s*\|\|\s*['"]['"]\)\)/.test(exactLogTokenBody) &&
      /logHasExactToken\(line,\s*`\$\{uuid\}:\$\{wireSession\}`\)/.test(peerIdentityBody) &&
      /logHasExactToken\(line,\s*`uuid=\$\{uuid\}`\)/.test(peerIdentityBody) &&
      /logHasExactToken\(line,\s*`session=\$\{wireSession\}`\)/.test(peerIdentityBody) &&
      /\^\[0-9a-f\]\{64\}\$/.test(shaIdentityBody) &&
      /logHasExactToken\(String\(line\s*\|\|\s*['"]['"]\)\.toLowerCase\(\),\s*`sha256=\$\{expected\}`\)/.test(shaIdentityBody) &&
      exactMatcherContract.ok,
    `exact UUID/session/hash tokens must reject prefix/suffix collisions; contract=${JSON.stringify(exactMatcherContract)}`
  );
  add(
    'SESSIONLESS_WSS_SEND_HELPERS_OMIT_SESSION_OWN_PROPERTY',
    /const\s+message\s*=\s*\{[\s\S]{0,220}?UUID:\s*uuid,[\s\S]{0,160}?streamID:\s*streamId,[\s\S]{0,160}?description:\s*\{\s*type:\s*['"]answer['"],\s*sdp\s*\}/.test(sendSessionlessAnswerBody) &&
      !/\bsession\s*:/.test(sendSessionlessAnswerBody) &&
      /Object\.prototype\.hasOwnProperty\.call\(message,\s*['"]session['"]\)/.test(sendSessionlessAnswerBody) &&
      /return\s+signal\.send\(message\)/.test(sendSessionlessAnswerBody) &&
      /const\s+wire\s*=\s*browserCandidateWire\(candidate\)/.test(sendSessionlessCandidateBody) &&
      /const\s+message\s*=\s*\{[\s\S]{0,180}?UUID:\s*uuid,[\s\S]{0,100}?type:\s*['"]remote['"],[\s\S]{0,100}?candidate:\s*wire/.test(sendSessionlessCandidateBody) &&
      !/\bsession\s*:/.test(sendSessionlessCandidateBody) &&
      /Object\.prototype\.hasOwnProperty\.call\(message,\s*['"]session['"]\)/.test(sendSessionlessCandidateBody) &&
      /return\s+signal\.send\(message\)/.test(sendSessionlessCandidateBody) &&
      /sessionless-generation-a-candidate-wire-truly-omits-session/.test(negotiationBody) &&
      /sessionless-generation-a-answer-wire-truly-omits-session/.test(negotiationBody) &&
      /const\s+sessionlessCandidateRawMessage\s*=\s*JSON\.parse\(\s*sessionlessCandidateSentEvent\.raw\s*\)/.test(negotiationBody) &&
      /const\s+sessionlessAnswerRawMessage\s*=\s*JSON\.parse\(sessionlessAnswerSentEvent\.raw\)/.test(negotiationBody) &&
      /hasOwnProperty\.call\(\s*sessionlessCandidateSentEvent\.message,\s*['"]session['"]\s*\)/.test(negotiationBody) &&
      /hasOwnProperty\.call\(\s*sessionlessCandidateRawMessage,\s*['"]session['"]\s*\)/.test(negotiationBody) &&
      /hasOwnProperty\.call\(\s*sessionlessAnswerSentEvent\.message,\s*['"]session['"]\s*\)/.test(negotiationBody) &&
      /hasOwnProperty\.call\(\s*sessionlessAnswerRawMessage,\s*['"]session['"]\s*\)/.test(negotiationBody),
    'the sessionless fixtures must construct objects with no session own-property and prove the exact serialized candidate and answer also omit it'
  );
  add(
    'SESSIONLESS_WSS_REJECTIONS_ARE_EXACTLY_EVENT_CORRELATED',
    /\[Signaling\\\] Rejecting publisher WebSocket answer/.test(
      sessionlessAnswerRejectionBody
    ) &&
      /reason=missing-session/.test(sessionlessAnswerRejectionBody) &&
      /uuid=\$\{uuid\}/.test(sessionlessAnswerRejectionBody) &&
      /source=signaling-wss/.test(sessionlessAnswerRejectionBody) &&
      /receivedSession=missing/.test(sessionlessAnswerRejectionBody) &&
      /activeSession=\$\{activeWireSession\}/.test(sessionlessAnswerRejectionBody) &&
      /answersdpsha256=\$\{expectedSha256\}/.test(sessionlessAnswerRejectionBody) &&
      /\[Signaling\\\] Rejecting publisher WebSocket remote ICE candidate/.test(
        sessionlessCandidateRejectionBody
      ) &&
      /reason=missing-session/.test(sessionlessCandidateRejectionBody) &&
      /uuid=\$\{uuid\}/.test(sessionlessCandidateRejectionBody) &&
      /source=signaling-wss/.test(sessionlessCandidateRejectionBody) &&
      /receivedSession=missing/.test(sessionlessCandidateRejectionBody) &&
      /activeSession=\$\{activeWireSession\}/.test(sessionlessCandidateRejectionBody) &&
      /candidatesha256=\$\{expectedSha256\}/.test(sessionlessCandidateRejectionBody) &&
      sessionlessMatcherContract.ok &&
      /const\s+sessionlessCandidateSha256\s*=\s*sha256Text\(\s*String\(sessionlessCandidateWire\.candidate\s*\|\|\s*['"]['"]\)\s*\)/.test(negotiationBody) &&
      /sha256Text\(sessionlessAnswerSentEvent\.message\.description\.sdp\)\s*===\s*answerASdpSha256/.test(negotiationBody) &&
      /const\s+sessionlessCandidateObservation\s*=\s*await\s+waitForPublisherOutput/.test(negotiationBody) &&
      /const\s+sessionlessAnswerObservation\s*=\s*await\s+waitForPublisherOutput/.test(negotiationBody) &&
      /sessionlessCandidateRejectionLines\.length\s*===\s*1/.test(negotiationBody) &&
      /sessionlessAnswerRejectionLines\.length\s*===\s*1/.test(negotiationBody),
    `each missing-session rejection must match its exact branch, UUID, active session, source, reason, and raw payload hash; contract=${JSON.stringify(sessionlessMatcherContract)}`
  );
  const sessionlessCandidateProbeIndex = negotiationBody.indexOf(
    'const sessionlessCandidateSentEvent'
  );
  const sessionlessAnswerProbeIndex = negotiationBody.indexOf(
    'const sessionlessAnswerSentEvent',
    sessionlessCandidateProbeIndex
  );
  const exactSessionBAnswerIndex = negotiationBody.indexOf(
    'const isolatedActiveCandidateAppliedSnapshot',
    sessionlessAnswerProbeIndex
  );
  const exactSessionBMediaIndex = negotiationBody.indexOf(
    "addCheck(report, 'offer-b-establishes-fresh-data-and-media-after-old-answer'",
    exactSessionBAnswerIndex
  );
  add(
    'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY',
    /pendingRemoteCandidates:\s*Number\(snapshot\.signaling\.pending_remote_candidates\s*\|\|\s*0\)/.test(sessionlessDownstreamStateBody) &&
      /answerCount:\s*Number\(snapshot\.signaling\.answer_count\s*\|\|\s*0\)/.test(sessionlessDownstreamStateBody) &&
      /attemptedAnswerIdentities:\s*Number\([\s\S]{0,100}?snapshot\.signaling\.attempted_answer_identities\s*\|\|\s*0/.test(sessionlessDownstreamStateBody) &&
      /answerReceived:\s*snapshot\.signaling\.answer_received/.test(sessionlessDownstreamStateBody) &&
      /remoteCandidatesApplied:\s*Number\([\s\S]{0,100}?snapshot\.signaling\.remote_candidates_applied\s*\|\|\s*0/.test(sessionlessDownstreamStateBody) &&
      /activeOfferGeneration:\s*Number\(snapshot\.signaling\.active_offer_generation\s*\|\|\s*0\)/.test(sessionlessDownstreamStateBody) &&
      /activeTransportGeneration:\s*Number\([\s\S]{0,100}?snapshot\.signaling\.active_transport_generation\s*\|\|\s*0/.test(sessionlessDownstreamStateBody) &&
      /clientTransportGeneration:\s*Number\([\s\S]{0,100}?snapshot\.signaling\.client_transport_generation\s*\|\|\s*0/.test(sessionlessDownstreamStateBody) &&
      /transportRetired:\s*snapshot\.transport\.transport_retired/.test(sessionlessDownstreamStateBody) &&
      /dataChannelOpen:\s*snapshot\.transport\.data_channel_open/.test(sessionlessDownstreamStateBody) &&
      /const\s+sessionlessCandidateCounterAfter\s*=[\s\S]{0,120}?waitForDiagnosticsPeerSnapshot\([\s\S]{0,300}?snapshot\.signaling\.sessionless_wss_remote_candidates_rejected[\s\S]{0,80}?===\s*sessionlessCandidateRejectsBefore\s*\+\s*1[\s\S]{0,160}?snapshot\.signaling\.sessionless_wss_answers_rejected\)\s*===\s*sessionlessAnswerRejectsBefore/.test(negotiationBody) &&
      /sessionlessCandidateCounterAfter\.signaling[\s\S]{0,100}?sessionless_wss_remote_candidates_rejected[\s\S]{0,100}?===\s*sessionlessCandidateRejectsBefore\s*\+\s*1/.test(negotiationBody) &&
      /sessionlessCandidateCounterAfter\.signaling\.sessionless_wss_answers_rejected[\s\S]{0,80}?===\s*sessionlessAnswerRejectsBefore/.test(negotiationBody) &&
      /const\s+sessionlessAnswerCounterAfter\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]{0,300}?snapshot\.signaling\.sessionless_wss_answers_rejected\)\s*===\s*sessionlessAnswerRejectsBefore\s*\+\s*1[\s\S]{0,160}?snapshot\.signaling\.sessionless_wss_remote_candidates_rejected[\s\S]{0,80}?===\s*sessionlessCandidateRejectsBefore\s*\+\s*1/.test(negotiationBody) &&
      /sessionlessAnswerCounterAfter\.signaling\.sessionless_wss_answers_rejected[\s\S]{0,80}?===\s*sessionlessAnswerRejectsBefore\s*\+\s*1/.test(negotiationBody) &&
      /sessionlessAnswerCounterAfter\.signaling[\s\S]{0,100}?sessionless_wss_remote_candidates_rejected[\s\S]{0,100}?===\s*sessionlessCandidateRejectsBefore\s*\+\s*1/.test(negotiationBody) &&
      /JSON\.stringify\(sessionlessCandidateDownstreamState\)\s*===\s*JSON\.stringify\(sessionlessBaselineDownstreamState\)/.test(negotiationBody) &&
      /JSON\.stringify\(sessionlessAnswerDownstreamState\)\s*===\s*JSON\.stringify\(sessionlessCandidateDownstreamState\)/.test(negotiationBody) &&
      /const\s+sessionlessOfferStatePreserved\s*=\s*sessionlessCandidateSafelyRejected\s*&&\s*sessionlessAnswerSafelyRejected/.test(negotiationBody) &&
      /if\s*\(\s*!sessionlessOfferStatePreserved\s*\)/.test(negotiationBody) &&
      /sessionless-wss-fixture-recovery-does-not-hide-product-failure/.test(negotiationBody) &&
      sessionlessCandidateProbeIndex >= 0 &&
      sessionlessAnswerProbeIndex > sessionlessCandidateProbeIndex &&
      exactSessionBAnswerIndex > sessionlessAnswerProbeIndex &&
      exactSessionBMediaIndex > exactSessionBAnswerIndex,
    'candidate and answer rejection counters must each advance by exactly one while pending/apply/answer/generation/transport state is unchanged; a broken guard stays RED and is fixture-recovered before exact-session B data and fresh media'
  );
  const sessionlessCandidateVerdictStart = negotiationBody.indexOf(
    'const sessionlessCandidateSafelyRejected'
  );
  const sessionlessCandidateReporterStart = negotiationBody.indexOf(
    "'sessionless-generation-a-candidate-is-rejected-before-offer-b-routing'",
    sessionlessCandidateVerdictStart
  );
  const sessionlessCandidateVerdictSpan = sessionlessCandidateVerdictStart >= 0 &&
      sessionlessCandidateReporterStart > sessionlessCandidateVerdictStart
    ? negotiationBody.slice(
      sessionlessCandidateVerdictStart,
      sessionlessCandidateReporterStart + 180
    )
    : '';
  const sessionlessAnswerVerdictStart = negotiationBody.indexOf(
    'const sessionlessAnswerSafelyRejected'
  );
  const sessionlessAnswerReporterStart = negotiationBody.indexOf(
    "'sessionless-generation-a-answer-is-rejected-before-offer-b-routing'",
    sessionlessAnswerVerdictStart
  );
  const sessionlessAnswerVerdictSpan = sessionlessAnswerVerdictStart >= 0 &&
      sessionlessAnswerReporterStart > sessionlessAnswerVerdictStart
    ? negotiationBody.slice(
      sessionlessAnswerVerdictStart,
      sessionlessAnswerReporterStart + 180
    )
    : '';
  add(
    'SESSIONLESS_WSS_BEHAVIOR_VERDICTS_ARE_LOAD_BEARING',
    /const\s+sessionlessCandidateSafelyRejected\s*=/.test(
        sessionlessCandidateVerdictSpan
      ) &&
      /sessionlessCandidateQuiescent\s*;/.test(
        sessionlessCandidateVerdictSpan
      ) &&
      /['"]sessionless-generation-a-candidate-is-rejected-before-offer-b-routing['"],\s*sessionlessCandidateSafelyRejected\s*,/.test(
        sessionlessCandidateVerdictSpan
      ) &&
      !/\|\|\s*true/.test(sessionlessCandidateVerdictSpan) &&
      /const\s+sessionlessAnswerSafelyRejected\s*=/.test(
        sessionlessAnswerVerdictSpan
      ) &&
      /sessionlessAnswerQuiescent\s*;/.test(
        sessionlessAnswerVerdictSpan
      ) &&
      /['"]sessionless-generation-a-answer-is-rejected-before-offer-b-routing['"],\s*sessionlessAnswerSafelyRejected\s*,/.test(
        sessionlessAnswerVerdictSpan
      ) &&
      !/\|\|\s*true/.test(sessionlessAnswerVerdictSpan),
    'the two named behavior checks must consume their complete computed verdicts; neither the reporter argument nor a verdict tail may be forced true'
  );
  const sessionlessCandidateObservationIndex = negotiationBody.indexOf(
    'const sessionlessCandidateObservation'
  );
  const sessionlessCandidateQuiescenceIndex = negotiationBody.indexOf(
    'await wait(sessionlessPostEventQuiescenceMs)',
    sessionlessCandidateObservationIndex
  );
  const sessionlessCandidateForbiddenIndex = negotiationBody.indexOf(
    'const sessionlessCandidateForbiddenRoutingLines',
    sessionlessCandidateQuiescenceIndex
  );
  const sessionlessAnswerObservationIndex = negotiationBody.indexOf(
    'const sessionlessAnswerObservation'
  );
  const sessionlessAnswerQuiescenceIndex = negotiationBody.indexOf(
    'await wait(sessionlessPostEventQuiescenceMs)',
    sessionlessAnswerObservationIndex
  );
  const sessionlessAnswerForbiddenIndex = negotiationBody.indexOf(
    'const sessionlessAnswerForbiddenApplyLines',
    sessionlessAnswerQuiescenceIndex
  );
  add(
    'SESSIONLESS_WSS_REJECTIONS_QUIESCE_AND_FORBID_DOWNSTREAM_LOGS',
    /const\s+sessionlessPostEventQuiescenceMs\s*=\s*1000/.test(negotiationBody) &&
      (negotiationBody.match(
        /await\s+wait\(sessionlessPostEventQuiescenceMs\)/g
      ) || []).length === 2 &&
      sessionlessCandidateObservationIndex >= 0 &&
      sessionlessCandidateQuiescenceIndex > sessionlessCandidateObservationIndex &&
      sessionlessCandidateForbiddenIndex > sessionlessCandidateQuiescenceIndex &&
      sessionlessAnswerObservationIndex > sessionlessCandidateForbiddenIndex &&
      sessionlessAnswerQuiescenceIndex > sessionlessAnswerObservationIndex &&
      sessionlessAnswerForbiddenIndex > sessionlessAnswerQuiescenceIndex &&
      /\[Signaling\\\] Queued remote ICE candidate/.test(
        sessionlessCandidateVerdictSpan + negotiationBody.slice(
          sessionlessCandidateForbiddenIndex,
          sessionlessCandidateVerdictStart
        )
      ) &&
      /Queued\|Drained queued\|Adding\|Added\|Failed to add/.test(
        negotiationBody.slice(
          sessionlessCandidateForbiddenIndex,
          sessionlessCandidateVerdictStart
        )
      ) &&
      /const\s+sessionlessCandidateQuiescent\s*=\s*sessionlessCandidateForbiddenRoutingLines\.length\s*===\s*0/.test(
        negotiationBody
      ) &&
      /\[App\\\] \(\?:Applying\|Failed to apply\) peer answer/.test(
        negotiationBody.slice(
          sessionlessAnswerForbiddenIndex,
          sessionlessAnswerVerdictStart
        )
      ) &&
      /const\s+sessionlessAnswerQuiescent\s*=\s*sessionlessAnswerForbiddenApplyLines\.length\s*===\s*0/.test(
        negotiationBody
      ),
    'after each exact rejection event, a bounded quiet window must remain free of candidate queue/add/failure and answer apply/failure traces before PASS is admissible'
  );
  add(
    'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED',
    /signalLineIdentifiesPeer\(line,\s*uuid,\s*wireSession\)/.test(staleRejectionBody) &&
      /signalLineIdentifiesSha256\(line,\s*candidateSha256\)/.test(staleRejectionBody) &&
      /stale-candidate-fixture-has-distinct-a-b-payload-fingerprints/.test(negotiationBody) &&
      /staleCandidateAWireSha256\s*!==\s*activeCandidateBWireSha256/.test(negotiationBody) &&
      /staleCandidateACandidateSha256\s*!==\s*activeCandidateBCandidateSha256/.test(negotiationBody) &&
      /sha256Text\(String\(\s*staleCandidateWire\.candidate\s*\|\|\s*['"]['"]\s*\)\)/.test(negotiationBody) &&
      /sha256Text\(String\(\s*browserCandidateWire\(activeCandidateB\)\.candidate\s*\|\|\s*['"]['"]\s*\)\)/.test(negotiationBody) &&
      /explicitStaleCandidateRejectionLines\(\s*staleCandidateOutput,\s*staleUuid,\s*offerA\.message\.session,\s*staleCandidateACandidateSha256/.test(negotiationBody) &&
      /explicitStaleCandidateRejectionLines\(\s*mislabeledActiveCandidateOutput,\s*staleUuid,\s*offerA\.message\.session,\s*activeCandidateBCandidateSha256/.test(negotiationBody) &&
      /explicitStaleCandidateRejectionLines\(\s*correctlyLabeledActiveCandidateOutput,\s*staleUuid,\s*offerB\.message\.session,\s*activeCandidateBCandidateSha256/.test(negotiationBody),
    'candidate rejection must match the exact UUID, wire session, and production SHA-256 of the raw candidate line while retaining a separate full-wire fidelity fingerprint'
  );
  add(
    'SEND_ANSWER_FORWARDS_EXACT_SDP',
    /return\s+signal\.send\(\{[\s\S]{0,220}description:\s*\{\s*type:\s*['"]answer['"],\s*sdp\s*\}/.test(sendAnswerBody) &&
      /const\s+sentEvent\s*=\s*\{\s*at:\s*Date\.now\(\),\s*raw:\s*payload,\s*message:\s*JSON\.parse\(payload\)\s*\}/.test(startSignalServerBody) &&
      /return\s+sentEvent/.test(startSignalServerBody) &&
      /mislabeled-active-answer-wire-matches-exact-browser-sdp-fixture/.test(negotiationBody) &&
      /mislabeledActiveAnswerSentEvent\.message\.description\.sdp\s*===\s*validAnswerB\.sdp/.test(negotiationBody) &&
      /sha256Text\(mislabeledActiveAnswerSentEvent\.message\.description\.sdp\)\s*===\s*answerBSdpSha256/.test(negotiationBody) &&
      /never-applied-answer-wire-matches-exact-browser-sdp-fixture/.test(negotiationBody) &&
      /staleAnswerSentEvent\.message\.description\.sdp\s*===\s*validAnswerA\.sdp/.test(negotiationBody) &&
      /sha256Text\(staleAnswerSentEvent\.message\.description\.sdp\)\s*===\s*answerASdpSha256/.test(negotiationBody),
    'the harness must inspect the exact JSON-serialized answer event and prove its SDP equals the hashed browser fixture before using any rejection result'
  );
  add(
    'STALE_ANSWER_REJECTION_WAITS_FOR_EVENT_AND_FRESH_COUNTERS',
    /while\s*\(Date\.now\(\)\s*-\s*startedAt\s*<\s*timeoutMs\)/.test(waitForPublisherOutputBody) &&
      (waitForPublisherOutputBody.match(
        /publisher\.output\(\)\.slice\(afterOffset\)/g
      ) || []).length === 2 &&
      /if\s*\(predicate\(output\)\)/.test(waitForPublisherOutputBody) &&
      /await\s+wait\(25\)/.test(waitForPublisherOutputBody) &&
      /ok:\s*false/.test(waitForPublisherOutputBody) &&
      /const\s+staleAnswerObservationTimeoutMs\s*=\s*4000/.test(negotiationBody) &&
      (negotiationBody.match(/await\s+waitForPublisherOutput\s*\(/g) || []).length >= 2 &&
      /const\s+mislabeledActiveAnswerObservation\s*=\s*await\s+waitForPublisherOutput/.test(negotiationBody) &&
      /const\s+staleAnswerObservation\s*=\s*await\s+waitForPublisherOutput/.test(negotiationBody) &&
      /mislabeledActiveAnswerCounterFloor\.generatedSteadyMs/.test(negotiationBody) &&
      /staleAnswerCounterFloor\.generatedSteadyMs/.test(negotiationBody) &&
      /mislabeledActiveAnswerCounterAfter\.signaling\.answer_count[\s\S]{0,100}counterAfterCorrectlyLabeledActiveCandidate\.signaling\.answer_count/.test(negotiationBody) &&
      /staleAnswerCounterAfter\.signaling\.answer_count[\s\S]{0,100}mislabeledActiveAnswerCounterAfter\.signaling\.answer_count/.test(negotiationBody) &&
      /attempted_answer_identities/.test(negotiationBody) &&
      /mislabeledActiveAnswerCounterAfter\.signaling\.answer_received\s*===\s*false/.test(negotiationBody) &&
      /staleAnswerCounterAfter\.signaling\.answer_received\s*===\s*false/.test(negotiationBody),
    'stale-answer verdicts must wait for their exact rejection event, then observe a newer diagnostics generation with unchanged apply counters and an unanswered active offer'
  );
  add(
    'STALE_ANSWER_REJECTION_IS_EXACT_EVENT_CORRELATED',
    /signalLineIdentifiesPeer\(line,\s*uuid,\s*wireSession\)/.test(staleAnswerRejectionBody) &&
      /stale-answer-fixture-has-distinct-a-b-payload-fingerprints/.test(negotiationBody) &&
      /answerASdpSha256\s*!==\s*answerBSdpSha256/.test(negotiationBody) &&
      /explicitStaleAnswerRejectionLines\(\s*mislabeledActiveAnswerOutput,\s*staleUuid,\s*offerA\.message\.session\s*\)/.test(negotiationBody) &&
      /explicitStaleAnswerRejectionLines\(\s*staleApplyOutput,\s*staleUuid,\s*offerA\.message\.session\s*\)/.test(negotiationBody) &&
      /countOccurrences\(\s*mislabeledActiveAnswerOutput,\s*['"]\[App\] Applying peer answer['"]\s*\)\s*===\s*0/.test(negotiationBody) &&
      /countOccurrences\(staleApplyOutput,\s*['"]\[App\] Applying peer answer['"]\)\s*===\s*0/.test(negotiationBody),
    'the harness sends distinct SDP fixtures, then correlates each rejection by exact UUID/session and proves that no answer reached the apply path; production does not log answer hashes'
  );

  add(
    'REBUILT_TRANSPORT_ROTATES_WIRE_SESSION',
    /full-peer-rebuild-rotates-wire-session/.test(negotiationBody) &&
      /productOfferB\.message\.session\s*!==\s*offerA\.message\.session/.test(negotiationBody),
    'a full PeerConnection rebuild must rotate the VDO wire session while replay paths retain their original session'
  );
  add(
    'OFFER_B_PRODUCT_FAILURE_PRESERVES_GENERATION_PROBE_COVERAGE',
    /if\s*\(\s*!productOfferB\s*\|\|\s*!distinctGenerations\s*\|\|\s*productOfferB\.message\.session\s*===\s*offerA\.message\.session\s*\)/.test(negotiationBody) &&
      /offer-b-label-fixture-recovery-does-not-hide-product-failure/.test(negotiationBody) &&
      /offer-b-label-probe-has-distinct-retired-and-active-sessions/.test(negotiationBody) &&
      /activeOfferBDistinctGeneration\s*&&\s*offerB\.message\.session\s*!==\s*offerA\.message\.session/.test(negotiationBody) &&
      /if\s*\(\s*offerB\s*&&\s*activeOfferBDistinctGeneration\s*\)/.test(negotiationBody) &&
      /offer-b-browser-peer-owns-distinct-active-wire-session/.test(negotiationBody) &&
      /activeOfferBBrowserState\.wireSession\s*===\s*offerB\.message\.session/.test(negotiationBody),
    'a bad package offer B stays RED while an explicit distinct-session replacement keeps stale answer/candidate generation probes reachable'
  );
  add(
    'SESSIONLESS_PROBE_STARTS_WITH_SINGLE_ACTIVE_OFFER_B_OWNER',
    /const\s+ownsOnlyActiveOfferB\s*=\s*\(snapshot\)\s*=>\s*!!snapshot\s*&&\s*snapshot\.peerCount\s*===\s*1\s*&&\s*snapshot\.activeWireSession\s*===\s*offerB\.message\.session\s*&&\s*snapshot\.signaling\.answer_received\s*===\s*false\s*;/.test(negotiationBody) &&
      /const\s+preSessionlessOfferBOwner\s*=\s*await\s+waitForDiagnosticsPeerSnapshot/.test(negotiationBody) &&
      /sessionless-probe-starts-with-one-active-offer-b-owner/.test(negotiationBody) &&
      /ownsOnlyActiveOfferB\(preSessionlessOfferBOwner\)/.test(negotiationBody) &&
      negotiationBody.indexOf('const preSessionlessOfferBOwner') <
        negotiationBody.indexOf('const sessionlessCandidateSentEvent'),
    'the sessionless A probes begin only after fresh diagnostics prove one unanswered active B owner; no extra duplicate request may mutate that baseline'
  );
  add(
    'OFFER_B_DIAGNOSTICS_BASELINE_FOLLOWS_ACTIVE_OWNER',
    /let\s+offerBFixtureRecoveryUsed\s*=\s*false/.test(negotiationBody) &&
      /offerBFixtureRecoveryUsed\s*=\s*true/.test(negotiationBody) &&
      /const\s+expectedActiveOfferCount\s*=\s*offerBFixtureRecoveryUsed\s*\?\s*1\s*:\s*2/.test(negotiationBody) &&
      /const\s+candidateCounterBefore\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]{0,220}?\(snapshot\)\s*=>\s*snapshot\.activeWireSession\s*===\s*offerB\.message\.session\s*&&\s*Number\(snapshot\.signaling\.offer_count\s*\|\|\s*0\)\s*===\s*expectedActiveOfferCount\s*&&\s*snapshot\.signaling\.answer_received\s*===\s*false/.test(negotiationBody) &&
      /candidateCounterBefore\.activeWireSession\s*===\s*offerB\.message\.session/.test(negotiationBody) &&
      /Number\.isFinite\(Number\(\s*candidateCounterBefore\.signaling\.remote_candidates_applied/.test(negotiationBody),
    'the pre-injection counter must belong to the live offer-B owner: two offers on an unreplaced peer, one offer on explicit fixture replacement, never an inherited retired count'
  );

  const directStunBody = functionBody(executableSource, 'runDirectStunScenario');
  add(
    'REBUILD_PATHS_REPLACE_ONE_BROWSER_PEER_PER_UUID',
    /const\s+stalePeerName\s*=\s*['"]older-generation-peer['"]/.test(negotiationBody) &&
      !/older-generation-(?:a|b)/.test(negotiationBody) &&
      /validAnswerB\.peerInstanceId\s*!==\s*validAnswerA\.peerInstanceId/.test(negotiationBody) &&
      /generation-a-browser-peer-is-closed-before-offer-b-answer/.test(negotiationBody) &&
      /const\s+delayedPeerName\s*=\s*['"]delayed-recovery-peer['"]/.test(directStunBody) &&
      !/delayed-(?:failed|recovered)-peer/.test(directStunBody) &&
      /recoveryAnswer\.peerInstanceId\s*!==\s*browserAnswer\.peerInstanceId/.test(directStunBody) &&
      /failed-browser-peer-is-closed-before-delayed-recovery-answer/.test(directStunBody) &&
      /state\.retiredAt\s*=\s*Date\.now\(\)[\s\S]*?state\.pc\.close\(\)[\s\S]*?__retiredGameCapturePeers\.push/.test(browserPageBody) &&
      /__retiredGameCapturePeerState/.test(browserPageBody),
    'every changed-session rebuild must close and replace the one browser receiver PC owned by that UUID'
  );

  const alphaHelperBody = functionBody(executableSource, 'enableAlphaAndVerifyMedia');
  add(
    'ALPHA_RENEGOTIATION_RETAINS_ACTIVE_WIRE_SESSION',
    /lateOffer\.message\.session\s*!==\s*initialOffer\.message\.session/.test(alphaHelperBody) &&
      /sendBrowserCandidates\(signal,\s*uuid,\s*lateOffer\.message\.session,/.test(alphaHelperBody) &&
      !/lateOffer\.message\.session\s*\|\|\s*session/.test(alphaHelperBody),
    'same-PC alpha renegotiation must retain the current publisher session and may not fall back to a request hint'
  );
  add(
    'ALPHA_CALLER_OWNS_CURRENT_BROWSER_WIRE_SESSION',
    /alpha-browser-session-matches-caller-and-initial-offer/.test(alphaHelperBody) &&
      /liveAlphaState\.wireSession\s*===\s*session/.test(alphaHelperBody) &&
      /session\s*===\s*initialOffer\.message\.session/.test(alphaHelperBody) &&
      /liveAlphaState\.peerInstanceId/.test(alphaHelperBody),
    'alpha capability and media checks must operate on the one browser PC that owns the caller and initial-offer session'
  );
  add(
    'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING',
    /alphaAllowed:\s*peer\.alpha_allowed\s*===\s*true/.test(diagnosticsBody) &&
      /alphaReceiveMode:\s*String\(peer\.alpha_receive_mode\s*\|\|\s*['"]['"]\)/.test(
        diagnosticsBody
      ) &&
      /id:\s*['"]camel-case-alias['"][\s\S]{0,100}?alphaReceive:\s*['"]vp9-dualtrack-v1['"]/.test(
        negotiationBody
      ) &&
      /id:\s*['"]boolean-true['"][\s\S]{0,100}?alpha_receive:\s*true/.test(
        negotiationBody
      ) &&
      /id:\s*['"]wrong-version['"][\s\S]{0,100}?alpha_receive:\s*['"]vp9-dualtrack-v2['"]/.test(
        negotiationBody
      ) &&
      /id:\s*['"]wrong-case['"][\s\S]{0,100}?alpha_receive:\s*['"]VP9-DUALTRACK-V1['"]/.test(
        negotiationBody
      ) &&
      /id:\s*['"]null['"][\s\S]{0,100}?alpha_receive:\s*null/.test(
        negotiationBody
      ) &&
      /id:\s*['"]object['"][\s\S]{0,120}?alpha_receive:\s*\{\s*mode:\s*['"]vp9-dualtrack-v1['"]\s*\}/.test(
        negotiationBody
      ) &&
      /id:\s*['"]number['"][\s\S]{0,100}?alpha_receive:\s*1/.test(
        negotiationBody
      ) &&
      /for\s*\(const\s+variant\s+of\s+alphaNegativeCapabilityVariants\)/.test(
        negotiationBody
      ) &&
      /negativeSnapshotAfter\.alphaAllowed\s*===\s*false/.test(negotiationBody) &&
      /negativeSnapshotAfter\.alphaReceiveMode\s*===\s*['"]['"]/.test(
        negotiationBody
      ) &&
      /beforeNegativeAlphaPackets\s*===\s*0/.test(negotiationBody) &&
      /afterNegativeAlphaPackets\s*===\s*0/.test(negotiationBody) &&
      /negativeCapabilityOffers\.length\s*===\s*0/.test(negotiationBody) &&
      /`plugin-alpha-negative-\$\{variant\.id\}-remains-disabled`,\s*negativeCapabilityRejected\s*,/.test(
        negotiationBody
      ) &&
      /alphaNegativeCapabilityVariants\.length\s*===\s*7/.test(negotiationBody) &&
      /['"]plugin-alpha-only-exact-snake-case-version-string-is-admitted['"],\s*alphaNegativeMatrixVerdict\s*,/.test(
        negotiationBody
      ) &&
      /alpha_receive:\s*['"]vp9-dualtrack-v1['"]/.test(negotiationBody) &&
      /exactAlphaCapabilitySnapshot\.alphaAllowed\s*===\s*true/.test(
        negotiationBody
      ) &&
      /exactAlphaCapabilitySnapshot\.alphaReceiveMode\s*===\s*['"]vp9-dualtrack-v1['"]/.test(
        negotiationBody
      ) &&
      /['"]plugin-alpha-exact-snake-case-version-string-activates-diagnostics['"],\s*exactAlphaCapabilityDiagnosticsVerdict\s*,/.test(
        negotiationBody
      ) &&
      /plugin-alpha-primary-and-alpha-advance-after-capability/.test(
        negotiationBody
      ),
    'camelCase, booleans, wrong versions/case, null, objects, and numbers stay disabled one at a time; only info.alpha_receive="vp9-dualtrack-v1" activates alpha diagnostics and advancing media'
  );

  add(
    'UUID_SCOPED_CLEANUP_READD_ROTATES_PUBLISHER_SESSION',
    /wss-cleanup-is-uuid-scoped/.test(activeMediaBody) &&
      /removedActiveSession/.test(activeMediaBody) &&
      /readdedConnection\.activeSession\s*!==\s*removedActiveSession/.test(activeMediaBody) &&
      /readdedConnection\.answer\.peerInstanceId\s*!==\s*removedPeerInstanceId/.test(activeMediaBody),
    'cleanup follows VDO UUID routing, while a later PC for that UUID must receive a fresh session and browser instance'
  );
  add(
    'CLEANUP_READD_DIAGNOSTICS_PROVE_SINGLE_UUID_OWNER',
    /diagnosticsOut:\s*lifecycleDiagnosticsPath/.test(activeMediaBody) &&
      /postCleanupSnapshot\.peerCount\s*===\s*0/.test(activeMediaBody) &&
      /postReaddSnapshot\.peerCount\s*===\s*1/.test(activeMediaBody) &&
      /postReaddSnapshot\.activeWireSession\s*===\s*readdedConnection\.activeSession/.test(activeMediaBody) &&
      /snapshot\.fileMtimeMs\s*>=\s*removalStarted/.test(activeMediaBody) &&
      /snapshot\.fileMtimeMs\s*>=\s*readdedConnection\.offer\.at/.test(activeMediaBody) &&
      /preCleanupSnapshot\.generatedSteadyMs/.test(activeMediaBody),
    'cleanup must remove all native owners for the UUID and re-add must create exactly one owner for the new active session'
  );
  add(
    'CLEANUP_RETIRED_HINT_IS_PROVEN_DISTINCT_FROM_LIVE_OWNER',
    /cleanup-retired-session-hint-is-distinct-from-live-browser-session/.test(activeMediaBody) &&
      /cleanupRetiredSession\s*!==\s*secondary\.session/.test(activeMediaBody) &&
      /cleanupHintBrowserState\.wireSession\s*===\s*secondary\.session/.test(activeMediaBody),
    'the cleanup request must actually carry a retired hint while the browser and native diagnostics identify a different live session'
  );
  add(
    'ZERO_AUDIO_PRODUCT_FAILURE_PRESERVES_LIFECYCLE_COVERAGE',
    /addCheck\(report,\s*['"]default-output-tone-is-captured-as-nonzero-audio['"]/.test(activeMediaBody) &&
      !/requireHarnessFixture\(report,\s*['"]default-output-tone-is-captured-as-nonzero-audio['"]/.test(activeMediaBody) &&
      /zero-audio-product-failure-does-not-hide-lifecycle-signaling-coverage/.test(activeMediaBody) &&
      /allowVideoOnlyWorkflow:\s*true/.test(activeMediaBody) &&
      /validateFullMedia:\s*lifecycleRequiresAudio/.test(activeMediaBody) &&
      /if\s*\(\s*!primaryAlpha\.workflowOk\s*\)/.test(activeMediaBody) &&
      /waitForLifecycleMediaAdvance/.test(activeMediaBody) &&
      /if\s*\(\s*!replacementConnection\.ok\s*\|\|\s*!replacementAlpha\.workflowOk\s*\)/.test(activeMediaBody) &&
      /if\s*\(\s*!secondaryConnection\.ok\s*\|\|\s*!secondaryAlpha\.workflowOk\s*\)/.test(activeMediaBody) &&
      /if\s*\(\s*!readdedConnection\.ok\s*\|\|\s*!readdedAlpha\.workflowOk\s*\|\|\s*!primaryDuringReadd\.ok\s*\)/.test(activeMediaBody) &&
      !/if\s*\(\s*!lifecycleRequiresAudio\s*\)\s*\{\s*return\s*;?\s*\}/.test(activeMediaBody),
    'zero captured system audio is a shipped-product RED; video/alpha workflow recovery must still reach reset, cleanup, re-add, and natural shutdown'
  );
  add(
    'CLEANUP_RETIRED_SESSION_IS_CREATED_BY_REMOVE_READD',
    /cleanup-retired-session-setup-baseline-is-current/.test(activeMediaBody) &&
      /session:\s*cleanupRetiredSession,[\s\S]{0,100}let\s+cleanupSetupRemovalLogObserved\s*=\s*false/.test(activeMediaBody) &&
      /cleanup-setup-removes-original-active-session/.test(activeMediaBody) &&
      /const\s+cleanupReplacementRequestHint\s*=\s*`\$\{cleanupRetiredSession\}-replacement-request`/.test(activeMediaBody) &&
      /const\s+cleanupActiveConnection\s*=\s*await\s+connectNewPeer\(\{[\s\S]{0,500}session:\s*cleanupReplacementRequestHint/.test(activeMediaBody) &&
      /cleanup-target-remove-readd-creates-known-retired-session/.test(activeMediaBody) &&
      /cleanupActiveConnection\.sessionContractOk/.test(activeMediaBody) &&
      /cleanupRetiredSession\s*!==\s*cleanupActiveConnection\.activeSession/.test(activeMediaBody),
    'the retired cleanup hint must come from a completed cleanup followed by a genuinely new publisher/browser PeerConnection, not from an ICE-restart assumption'
  );
  add(
    'CLEANUP_SETUP_REQUIRES_ZERO_OWNER_SNAPSHOT',
    /const\s+cleanupSetupRemovedSnapshot\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]{0,260}snapshot\.peerCount\s*===\s*0/.test(activeMediaBody) &&
      /const\s+cleanupSetupRemoved\s*=\s*cleanupSetupRemovalLogObserved\s*&&\s*!!cleanupSetupRemovedSnapshot\s*&&\s*cleanupSetupRemovedSnapshot\.peerCount\s*===\s*0/.test(activeMediaBody) &&
      /cleanup-setup-removes-original-active-session/.test(activeMediaBody),
    'the setup cleanup is complete only when both the exact removal log and a newer diagnostics snapshot prove that the UUID has zero native owners'
  );
  add(
    'ALPHA_RESET_FAILURE_PRESERVES_PLUGIN_COVERAGE',
      /alpha-restart-fixture-recovery-does-not-hide-product-failure/.test(negotiationBody) &&
      /alphaFixtureRecovery/.test(negotiationBody) &&
      /activeAlphaBaseState/.test(negotiationBody) &&
      /if\s*\(\s*!restartBeforeCapability\.ok\s*\)/.test(negotiationBody) &&
      !/if\s*\(\s*!restartBeforeCapability\.ok\s*\)\s*\{\s*return\s*;?/.test(negotiationBody),
    'a failed unchanged-package alpha reset must stay RED while explicit fixture recovery keeps plugin capability and media checks reachable'
  );

  return checks;
}

function mutateFunctionBodyOnce(source, functionName, pattern, replacement, mutationName) {
  const declarations = topLevelFunctionDeclarationPositions(source).get(functionName) || [];
  if (declarations.length === 0) {
    throw new Error(`Mutation '${mutationName}' could not find function ${functionName}`);
  }
  const parameterStart = source.indexOf('(', declarations[0]);
  const parameterEnd = findBalancedEnd(source, parameterStart, '(', ')');
  const bodyStart = parameterEnd < 0 ? -1 : source.indexOf('{', parameterEnd + 1);
  if (bodyStart < 0) {
    throw new Error(`Mutation '${mutationName}' could not find body for ${functionName}`);
  }
  const bodyEnd = findBalancedEnd(source, bodyStart, '{', '}');
  const body = source.slice(bodyStart + 1, bodyEnd);
  if (!pattern.test(body)) {
    throw new Error(`Mutation '${mutationName}' did not match inside ${functionName}`);
  }
  const mutatedBody = body.replace(pattern, replacement);
  return source.slice(0, bodyStart + 1) + mutatedBody + source.slice(bodyEnd);
}

let mutationBaselineFailedIds = [];
let mutationBaselineBindingAudit = null;

function bindingAuditStrictlyWorsened(mutatedSource) {
  if (!mutationBaselineBindingAudit) return false;
  const baseline = mutationBaselineBindingAudit;
  const mutated = auditLoadBearingFunctionBindings(mutatedSource);
  const baselineUnexpected = new Set(baseline.unexpected);
  const mutatedUnexpected = new Set(mutated.unexpected);
  const preservedBaselineViolations =
    baseline.missing.every((name) => mutated.missing.includes(name)) &&
    baseline.duplicates.every((name) =>
      mutated.declarations[name].length >= baseline.declarations[name].length
    ) &&
    baseline.reassigned.every((name) =>
      mutated.reassignments[name].length >= baseline.reassignments[name].length
    ) &&
    [...baselineUnexpected].every((name) => mutatedUnexpected.has(name));
  const addedViolation = expectedTopLevelFunctionBindings.some((name) =>
    mutated.declarations[name].length > baseline.declarations[name].length ||
    mutated.reassignments[name].length > baseline.reassignments[name].length
  ) || [...mutatedUnexpected].some((name) => !baselineUnexpected.has(name));
  return preservedBaselineViolations && addedViolation;
}

function mutationFailureDelta(failedIds) {
  const baseline = new Set(mutationBaselineFailedIds);
  return {
    introducedFailureIds: failedIds.filter((id) => !baseline.has(id)),
    resolvedBaselineIds: mutationBaselineFailedIds.filter(
      (id) => !failedIds.includes(id)
    )
  };
}

function exactMutationDeltaMatches(failedIds, expectedFailures) {
  const delta = mutationFailureDelta(failedIds);
  return {
    ...delta,
    matches: delta.resolvedBaselineIds.length === 0 &&
      JSON.stringify([...delta.introducedFailureIds].sort()) ===
        JSON.stringify([...expectedFailures].sort())
  };
}

function mutateOnce(source, pattern, replacement, name, expectedFailure) {
  if (!pattern.test(source)) {
    throw new Error(`Mutation '${name}' did not match the frozen source`);
  }
  const mutated = source.replace(pattern, replacement);
  const failedIds = analyze(mutated).filter((check) => !check.ok).map((check) => check.id);
  const delta = exactMutationDeltaMatches(failedIds, [expectedFailure]);
  return {
    name,
    expectedFailure,
    rejected: delta.matches,
    failedIds,
    introducedFailureIds: delta.introducedFailureIds,
    resolvedBaselineIds: delta.resolvedBaselineIds
  };
}

function mutateFunction(source, functionName, pattern, replacement, name, expectedFailure) {
  const mutated = mutateFunctionBodyOnce(
    source, functionName, pattern, replacement, name
  );
  const failedIds = analyze(mutated).filter((check) => !check.ok).map((check) => check.id);
  const delta = exactMutationDeltaMatches(failedIds, [expectedFailure]);
  return {
    name,
    expectedFailure,
    rejected: delta.matches,
    failedIds,
    introducedFailureIds: delta.introducedFailureIds,
    resolvedBaselineIds: delta.resolvedBaselineIds
  };
}

function buildCandidateOutcomePolicyMutations(source) {
  const expectedFailure = 'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN';
  const mutate = (functionName, pattern, replacement, name) => mutateFunction(
    source,
    functionName,
    pattern,
    replacement,
    name,
    expectedFailure
  );
  const readyMutations = [
    [/!!snapshot\s*&&/, 'true &&', 'candidate-ready-allows-missing-snapshot'],
    [
      /snapshot\.signaling\.local_candidate_gathering_complete\s*===\s*true/,
      'true',
      'candidate-ready-allows-incomplete-gathering'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_callbacks_in_flight\s*\)/,
      'true',
      'candidate-ready-drops-callback-count-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_callbacks_in_flight\s*===\s*0/,
      'true',
      'candidate-ready-allows-callbacks-in-flight'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_activity_sequence\s*\)/,
      'true',
      'candidate-ready-drops-activity-sequence-type-guard'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_gathering_epoch\s*\)/,
      'true',
      'candidate-ready-drops-gathering-epoch-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_gathering_epoch\s*>\s*0/,
      'true',
      'candidate-ready-allows-zero-gathering-epoch'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidates_after_gathering_complete\s*\)/,
      'true',
      'candidate-ready-drops-late-candidate-count-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidates_after_gathering_complete\s*===\s*0/,
      'true',
      'candidate-ready-allows-late-candidate'
    ],
    [
      /snapshot\.signaling\.local_candidate_overlapping_gathering_detected\s*===\s*false/,
      'true',
      'candidate-ready-allows-overlapping-gathering'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_outstanding\s*\)/,
      'true',
      'candidate-ready-drops-outstanding-work-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_outstanding\s*===\s*0/,
      'true',
      'candidate-ready-allows-outstanding-work'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_admitted\s*\)/,
      'true',
      'candidate-ready-drops-admitted-work-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_admitted\s*>\s*0/,
      'true',
      'candidate-ready-allows-zero-admitted-work'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_completed\s*\)/,
      'true',
      'candidate-ready-drops-completed-work-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_completed\s*===\s*snapshot\.signaling\.local_candidate_work_admitted/,
      'true',
      'candidate-ready-allows-incomplete-work-ledger'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_work_superseded\s*\)/,
      'true',
      'candidate-ready-drops-superseded-work-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_superseded\s*>=\s*0/,
      'true',
      'candidate-ready-allows-negative-superseded-work'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_retired_outstanding\s*\)/,
      'true',
      'candidate-ready-drops-retired-work-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_retired_outstanding\s*===\s*0/,
      'true',
      'candidate-ready-allows-retired-work'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_invariant_consistent\s*===\s*true/,
      'true',
      'candidate-ready-allows-broken-work-invariant'
    ],
    [
      /snapshot\.signaling\.local_candidate_work_offer_generation\s*===\s*snapshot\.signaling\.active_offer_generation/,
      'true',
      'candidate-ready-allows-wrong-offer-owner'
    ],
    [
      /Number\.isSafeInteger\(\s*snapshot\.signaling\.local_candidate_outcome_sequence\s*\)/,
      'true',
      'candidate-ready-drops-outcome-sequence-type-guard'
    ],
    [
      /snapshot\.signaling\.local_candidate_accounting_violation\s*===\s*false/,
      'true',
      'candidate-ready-allows-accounting-violation'
    ],
    [
      /snapshot\.signaling\.local_candidate_snapshot_coherent\s*===\s*true/,
      'true',
      'candidate-ready-allows-incoherent-snapshot'
    ],
    [
      /snapshot\.signaling\.buffered_local_candidates\s*===\s*0/,
      'true',
      'candidate-ready-allows-buffered-work'
    ],
    [
      /snapshot\.signaling\.buffered_local_candidates\s*===\s*0\s*;/,
      'snapshot.signaling.buffered_local_candidates === 0 || true;',
      'candidate-ready-entire-verdict-can-be-forced-true'
    ]
  ].map(([pattern, replacement, name]) => mutate(
    'candidateOutcomeSnapshotReady',
    pattern,
    replacement,
    name
  ));
  const terminalMutations = [
    [
      /!candidateOutcomeSnapshotReady\(\s*initialSnapshot\s*,\s*expectedActiveWireSession\s*\)/,
      'false',
      'candidate-terminal-skips-initial-readiness'
    ],
    [
      /!candidateOutcomeSnapshotReady\(\s*finalSnapshot\s*,\s*expectedActiveWireSession\s*\)/,
      'false',
      'candidate-terminal-skips-final-readiness'
    ],
    [
      /finalSnapshot\.generatedSteadyMs\s*-\s*initialSnapshot\.generatedSteadyMs\s*<\s*4000/,
      'false',
      'candidate-terminal-drops-four-second-boundary'
    ],
    [
      /return\s+false\s*;/,
      'return true;',
      'candidate-terminal-prerequisite-fails-open'
    ],
    [
      /return\s+final\.local_candidate_activity_sequence/,
      'return true || final.local_candidate_activity_sequence',
      'candidate-terminal-entire-stability-verdict-forced-true'
    ],
    [
      /const\s+initial\s*=\s*initialSnapshot\.signaling\s*;/,
      'const initial = finalSnapshot.signaling;',
      'candidate-terminal-initial-ledger-is-rebound-to-final'
    ],
    [
      /const\s+final\s*=\s*finalSnapshot\.signaling\s*;/,
      'const final = initialSnapshot.signaling;',
      'candidate-terminal-final-ledger-is-rebound-to-initial'
    ]
  ].map(([pattern, replacement, name]) => mutate(
    'candidateOutcomeSnapshotsTerminalAndStable',
    pattern,
    replacement,
    name
  ));
  const stableFields = [
    'local_candidate_activity_sequence',
    'local_candidates_sent',
    'local_candidate_send_failures',
    'local_candidate_gathering_epoch',
    'local_candidates_after_gathering_complete',
    'local_candidate_work_outstanding',
    'local_candidate_work_admitted',
    'local_candidate_work_completed',
    'local_candidate_work_superseded',
    'local_candidate_retired_outstanding',
    'local_candidate_outcome_sequence',
    'buffered_local_candidates',
    'active_offer_generation',
    'active_transport_generation',
    'client_transport_generation'
  ];
  const stabilityMutations = stableFields.map((field) => mutate(
    'candidateOutcomeSnapshotsTerminalAndStable',
    new RegExp(`final\\.${field}\\s*===\\s*initial\\.${field}`),
    'true',
    `candidate-terminal-allows-${field.replace(/_/g, '-')}-change`
  ));
  const workflowMutations = [
    [
      /await\s+wait\(\s*4000\s*\)\s*;/,
      'await wait(0);',
      'candidate-workflow-drops-four-second-observation'
    ],
    [
      /\(snapshot\)\s*=>\s*candidateOutcomeSnapshotsTerminalAndStable\(\s*candidateOutcomeInitialSnapshot\s*,\s*snapshot\s*,\s*activeDuplicateOffer\.message\.session\s*\)/,
      '(snapshot) => true',
      'candidate-workflow-bypasses-second-snapshot-predicate'
    ],
    [
      /candidateOutcomeInitialSnapshot\.generatedSteadyMs\s*,\s*12000/,
      '0, 12000',
      'candidate-workflow-drops-second-snapshot-generation-boundary'
    ],
    [
      /candidateOutcomeInitialSnapshot\.generatedSteadyMs\s*,\s*12000/,
      'candidateOutcomeInitialSnapshot.generatedSteadyMs, 1200',
      'candidate-workflow-shortens-terminal-observation-deadline'
    ],
    [
      /const\s+candidateOutcomeSnapshot\s*=\s*candidateOutcomeInitialSnapshot\s*\?/,
      'const candidateOutcomeSnapshot = true ?',
      'candidate-workflow-does-not-require-initial-terminal-snapshot'
    ],
    [
      /const\s+candidateOutcomeTerminalAndStable\s*=\s*candidateOutcomeSnapshotsTerminalAndStable\([\s\S]{0,180}?\)\s*;/,
      'const candidateOutcomeTerminalAndStable = true;',
      'candidate-workflow-forges-terminal-stability-verdict'
    ],
    [
      /candidateOutcomeTerminalAndStable\s*&&\s*!!candidateOutcomeSnapshot\s*&&/,
      'true && !!candidateOutcomeSnapshot &&',
      'candidate-workflow-reporter-ignores-terminal-stability'
    ],
    [
      /candidateOutcomeTerminalAndStable\s*&&\s*!!candidateOutcomeSnapshot\s*&&/,
      'candidateOutcomeTerminalAndStable && true &&',
      'candidate-workflow-reporter-allows-missing-final-snapshot'
    ],
    [
      /candidateOutcomeSignaling\.local_candidate_gathering_complete\s*===\s*true/,
      'true',
      'candidate-workflow-reporter-allows-incomplete-gathering'
    ],
    [
      /candidateOutcomeSignaling\.local_candidate_callbacks_in_flight\s*===\s*0/,
      'true',
      'candidate-workflow-reporter-allows-callback-in-flight'
    ],
    [
      /Number\.isSafeInteger\(\s*observedLocalCandidateWorkAdmitted\s*\)/,
      'true',
      'candidate-workflow-reporter-drops-admitted-type-guard'
    ],
    [
      /observedLocalCandidateWorkAdmitted\s*>\s*0/,
      'true',
      'candidate-workflow-reporter-allows-zero-admitted-work'
    ],
    [
      /observedLocalCandidateWorkCompleted\s*===\s*observedLocalCandidateWorkAdmitted/,
      'true',
      'candidate-workflow-reporter-allows-incomplete-work'
    ],
    [
      /candidateOutcomeSignaling\.local_candidate_retired_outstanding\s*===\s*0/,
      'true',
      'candidate-workflow-reporter-allows-retired-work'
    ],
    [
      /candidateOutcomeSignaling\.local_candidate_work_invariant_consistent\s*===\s*true/,
      'true',
      'candidate-workflow-reporter-allows-broken-invariant'
    ],
    [
      /initialSnapshot:\s*candidateOutcomeInitialSnapshot/,
      'initialSnapshot: null',
      'candidate-workflow-evidence-omits-initial-snapshot'
    ],
    [
      /snapshot:\s*candidateOutcomeSnapshot/,
      'snapshot: null',
      'candidate-workflow-evidence-omits-final-snapshot'
    ]
  ].map(([pattern, replacement, name]) => mutate(
    'runNegotiationScenario',
    pattern,
    replacement,
    name
  ));
  return [
    ...readyMutations,
    ...terminalMutations,
    ...stabilityMutations,
    ...workflowMutations
  ];
}

function mutateFunctionExpectingExactFailures(
  source,
  functionName,
  pattern,
  replacement,
  name,
  expectedFailures
) {
  const mutated = mutateFunctionBodyOnce(
    source, functionName, pattern, replacement, name
  );
  const failedIds = analyze(mutated).filter((check) => !check.ok).map((check) => check.id);
  const delta = exactMutationDeltaMatches(failedIds, expectedFailures);
  return {
    name,
    expectedFailures,
    rejected: delta.matches,
    failedIds,
    introducedFailureIds: delta.introducedFailureIds,
    resolvedBaselineIds: delta.resolvedBaselineIds
  };
}

function probeMutatedTargetTermination(mutated, expectation) {
  if (!expectation) {
    return { ok: true, expectation: 'not-requested', detail: 'not-requested' };
  }
  const timeoutMs = 1500;
  const child = spawnSync(process.execPath, ['-'], {
    cwd: __dirname,
    input: mutated,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024
  });
  const stdout = String(child.stdout || '');
  const timedOut = !!(child.error && child.error.code === 'ETIMEDOUT');
  const passLines = (stdout.match(/\[SIGNAL-E2E\] PASS/g) || []).length;
  const failLines = (stdout.match(/\[SIGNAL-E2E\] FAIL/g) || []).length;
  const reportLines = (stdout.match(/\[SIGNAL-E2E\] Report:/g) || []).length;
  const noTerminalVerdict = passLines === 0 && failLines === 0 && reportLines === 0;
  const ok = expectation === 'silent-zero-no-verdict'
    ? !timedOut && child.status === 0 && noTerminalVerdict
    : expectation === 'timeout-no-verdict'
      ? timedOut && noTerminalVerdict
      : expectation === 'forged-pass-zero-no-report'
        ? !timedOut && child.status === 0 && passLines === 1 &&
          failLines === 0 && reportLines === 0
        : false;
  return {
    ok,
    expectation,
    detail: `expectation=${expectation} status=${String(child.status)} ` +
      `signal=${child.signal || 'none'} timedOut=${timedOut} ` +
      `pass=${passLines} fail=${failLines} report=${reportLines}`
  };
}

function exactSourceMutation(mutated, name, expectedFailures, runtimeExpectation = '') {
  let syntaxOk = true;
  let syntaxError = '';
  try {
    Function(mutated.replace(/^#![^\r\n]*(?:\r?\n|$)/, ''));
  } catch (error) {
    syntaxOk = false;
    syntaxError = String(error && error.message ? error.message : error);
  }
  const failedIds = analyze(mutated).filter((check) => !check.ok).map((check) => check.id);
  const delta = exactMutationDeltaMatches(failedIds, expectedFailures);
  const bindingBaselineWorsened = expectedFailures.length === 1 &&
    expectedFailures[0] ===
      'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE' &&
    mutationBaselineFailedIds.includes(
      'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE'
    ) &&
    bindingAuditStrictlyWorsened(mutated) &&
    delta.resolvedBaselineIds.length === 0;
  const runtimeProbe = probeMutatedTargetTermination(mutated, runtimeExpectation);
  return {
    name,
    expectedFailures,
    syntaxOk,
    syntaxError,
    failedIds,
    introducedFailureIds: delta.introducedFailureIds,
    worsenedBaselineIds: bindingBaselineWorsened
      ? ['LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE']
      : [],
    resolvedBaselineIds: delta.resolvedBaselineIds,
    runtimeProbe,
    rejected: syntaxOk && runtimeProbe.ok &&
      (delta.matches || bindingBaselineWorsened)
  };
}

function exerciseAcornParseFailClosedContract(source) {
  const invalidSource = `${source.trimEnd()}\n\nfunction deliberatelyBroken( {\n`;
  let checks = [];
  let error = '';
  try {
    checks = analyze(invalidSource);
  } catch (caught) {
    error = String(caught && caught.message ? caught.message : caught);
  }
  const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
  const binding = checks.find((check) =>
    check.id === 'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE'
  );
  const ok = !error && checks.length === expectedParserFailureCheckCount &&
    failedIds.includes('LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE') &&
    failedIds.includes('TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE') &&
    binding && /parser=(?!acorn)/.test(binding.detail);
  return {
    ok,
    failedIds,
    detail: `checks=${checks.length} failed=${failedIds.length} ` +
      `bindingParserFailed=${!!(binding && /parser=(?!acorn)/.test(binding.detail))} ` +
      `error=${error || 'none'}`
  };
}

function replaceTopLevelFunctionDeclaration(source, name, declarationSource) {
  const parsed = parseTargetJavaScript(source);
  const node = uniqueTopLevelFunctionNode(parsed.ast, name);
  if (!node) throw new Error(`could not replace missing function ${name}`);
  return source.slice(0, node.start) + declarationSource.trim() + source.slice(node.end);
}

function removeTopLevelVariableStatements(source, names) {
  const parsed = parseTargetJavaScript(source);
  const removals = [];
  for (const statement of parsed.ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    if (statement.declarations.some((declaration) =>
      declaration.id.type === 'Identifier' && names.includes(declaration.id.name))) {
      removals.push([statement.start, statement.end]);
    }
  }
  let result = source;
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

function buildPhaseAGreenSeed(frozenSource) {
  let source = buildPhaseACounterfeitSeed(frozenSource);
  source = removeTopLevelVariableStatements(source, [
    'EMERGENCY_RELAY_SERVERS',
    'EMERGENCY_BROWSER_RTC_CONFIG'
  ]);
  const replacements = {
    validateTurnRegistryResponse: `
function validateTurnRegistryResponse(status, payload) {
  if (status !== 200) throw new Error('TURN registry must return HTTP 200');
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
      throw new Error('legacy url is forbidden');
    }
    const urls = typeof server.urls === 'string'
      ? [server.urls]
      : Array.isArray(server.urls) ? server.urls : [];
    if (!urls.length || urls.some((url) =>
      typeof url !== 'string' || !/^turns?:[^\\s]+$/i.test(url))) {
      throw new Error('TURN registry urls are invalid');
    }
    if (typeof server.username !== 'string' || !server.username.trim().length ||
        typeof server.credential !== 'string' || !server.credential.trim().length ||
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
}`,
    flattenValidatedTurnRegistryEndpoints: `
function flattenValidatedTurnRegistryEndpoints(registry) {
  const endpoints = [];
  for (const server of registry.servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      endpoints.push({
        ...server,
        urls: url,
        username: server.username,
        credential: server.credential,
        udp: server.udp
      });
    }
  }
  return endpoints;
}`,
    turnRegistryIceServers: `
function turnRegistryIceServers(response) {
  return response.servers.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential,
    udp: server.udp
  }));
}`,
    fetchValidatedTurnRegistryResponse: `
async function fetchValidatedTurnRegistryResponse(
  endpoint = 'https://turnservers.vdo.ninja/'
) {
  const registryEndpoint = endpoint || 'https://turnservers.vdo.ninja/';
  const response = await fetch(registryEndpoint, { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error('TURN registry HTTP status was not 200');
  const rawResponse = await response.text();
  const payload = JSON.parse(rawResponse);
  const validated = validateTurnRegistryResponse(response.status, payload);
  return { ...validated, rawResponse };
}`,
    canonicalTurnRegistryResponseV1: `
function canonicalTurnRegistryResponseV1(servers) {
  return TURN_REGISTRY_CONFIG_V1_PREFIX + '\\n' + JSON.stringify(
    servers.map(({ urls, username, credential, udp }) => ({
      urls,
      username,
      credential,
      udp
    }))
  );
}`,
    turnRegistryResponseSha256: `
function turnRegistryResponseSha256(servers) {
  return sha256Text(canonicalTurnRegistryResponseV1(servers));
}`,
    matchPackagedTurnResponse: `
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
}`,
    redactTurnSecrets: `
function redactTurnSecrets(servers, rawResponse, value) {
  let redacted = String(value);
  const secrets = [
    rawResponse,
    ...servers.flatMap((server) => [server.username, server.credential])
  ];
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}`,
    resolveBrowserTurnConfiguration: `
async function resolveBrowserTurnConfiguration(turnRegistryResponse) {
  const fetchedEndpoints = flattenValidatedTurnRegistryEndpoints(turnRegistryResponse);
  const resolvedEndpoints = [];
  for (const endpoint of fetchedEndpoints) {
    const resolution = await resolveTurnEndpointAddresses(endpoint);
    resolvedEndpoints.push({ ...endpoint, ...resolution });
  }
  return {
    turnRegistryResponse,
    fetchedEndpoints: resolvedEndpoints,
    rtcConfig: {
      iceServers: turnRegistryIceServers(turnRegistryResponse),
      iceTransportPolicy: 'relay'
    }
  };
}`,
    ensureTurnFixture: `
async function ensureTurnFixture(config, browser, report, turnFixture) {
  const fetchedEndpoints = turnFixture.fetchedEndpoints;
  config.relayRtcConfig = turnFixture.rtcConfig;
  const probe = await createBrowserPeerPage(browser);
  const endpointProbes = [];
  const endpointSets = [{ name: 'live-registry', endpoints: fetchedEndpoints }];
  try {
    for (const endpointSet of endpointSets) {
      for (const endpoint of endpointSet.endpoints) {
        endpointProbes.push(await probeSelectedTurnEndpoint(probe.page, endpoint));
      }
    }
    const everyOriginalHostnameAttemptAllocated = endpointProbes.length > 0 &&
      endpointProbes.every((endpoint) =>
        endpoint.hostnameAttempts.length === TURN_ENDPOINT_PROBE_ATTEMPTS &&
        endpoint.hostnameAttempts.every((attempt) => attempt.ok));
    const everyResolvedAddressPassed = endpointProbes.length > 0 &&
      endpointProbes.every((endpoint) =>
        endpoint.nonUdpAddressCoverageUnambiguous &&
        endpoint.addresses.length > 0 &&
        endpoint.addressAttempts.length ===
          endpoint.addresses.length * TURN_ENDPOINT_PROBE_ATTEMPTS &&
        endpoint.addressAttempts.every((attempt) => attempt.ok));
    const rtcConfigRetainsOriginalHostnames =
      endpointProbes.length === fetchedEndpoints.length;
    requireHarnessFixture(
      report,
      'every-live-registry-turn-endpoint-is-probed',
      everyOriginalHostnameAttemptAllocated &&
        everyResolvedAddressPassed && rtcConfigRetainsOriginalHostnames,
      { nonUdpMultiAddressPolicy: 'fail-closed', endpointProbes }
    );
  } finally {
    await probe.context.close().catch(() => {});
  }
}`,
    runRelayIceScenario: `
async function runRelayIceScenario(config, executable, browser, report, mediaFixture) {
  const turnRegistryFetchStartedAtMs = Date.now();
  const turnRegistryResponse = await fetchValidatedTurnRegistryResponse(
    'https://turnservers.vdo.ninja/'
  );
  const turnRegistryFetchCompletedAtMs = Date.now();
  const turnFixture = await resolveBrowserTurnConfiguration(turnRegistryResponse);
  await ensureTurnFixture(config, browser, report, turnFixture);
  addEvidence(report, 'packaged-turn-live-registry-response-accepted', {
    endpointCount: turnFixture.fetchedEndpoints.length
  });
  const signal = await startSignalServer();
  const publisher = startPublisher(executable, signal.url, {
    streamId: 'relay-live-registry',
    iceMode: 'relay',
    source: 'spout',
    spoutSender: mediaFixture.senderName
  });
  const relay = await connectNewPeer({ config, rtcConfig: turnFixture.rtcConfig });
  const publisherOutputLines = publisher.output().split(/\\r?\\n/);
  const nativeTurnRegistryFetchLines = publisherOutputLines.filter((line) =>
    /\\[ICE\\] TurnRegistryFetch(?:\\s|$)/.test(line));
  const consumedIceConfigLines = publisherOutputLines.filter((line) =>
    /\\[WebRTC\\] ConsumedIceConfig(?:\\s|$)/.test(line));
  const turnRegistryTransactionId = exactIceSummaryToken(
    nativeTurnRegistryFetchLines[0] || '', 'turnRegistryTransactionId'
  );
  const observedResponseSha256 = exactIceSummaryToken(
    nativeTurnRegistryFetchLines[0] || '', 'turnRegistryResponseSha256'
  );
  const responses = [{
    transactionId: turnRegistryTransactionId,
    responseSha256: observedResponseSha256,
    observedAtMs: turnRegistryFetchCompletedAtMs,
    configSha256: turnRegistryResponseSha256(turnRegistryResponse.servers),
    servers: turnRegistryResponse.servers
  }];
  const matchedTurnResponse = matchPackagedTurnResponse(
    responses,
    turnRegistryTransactionId,
    observedResponseSha256,
    turnRegistryFetchStartedAtMs,
    turnRegistryFetchCompletedAtMs
  );
  addCheck(report, 'packaged-turn-registry-fetch-is-unique',
    nativeTurnRegistryFetchLines.length === 1 && !!matchedTurnResponse,
    { relay: !!relay });
  const consumedIceConfig = consumedIceConfigLines[0] || '';
  const observedConsumedTransactionId = exactIceSummaryToken(
    consumedIceConfig, 'turnRegistryTransactionId'
  );
  const observedConsumedResponseSha256 = exactIceSummaryToken(
    consumedIceConfig, 'turnRegistryResponseSha256'
  );
  const observedConsumedTurnSha256 = exactIceSummaryToken(
    consumedIceConfig, 'turnConfigV1Sha256'
  );
  const observedConsumedTurnCount = Number(exactIceSummaryToken(
    consumedIceConfig, 'turnConfigV1Count'
  ));
  addCheck(report, 'packaged-turn-consumed-config-matches-fetched-response',
    consumedIceConfigLines.length === 1 && !!matchedTurnResponse &&
      observedConsumedTransactionId === matchedTurnResponse.transactionId &&
      observedConsumedResponseSha256 === matchedTurnResponse.responseSha256 &&
      observedConsumedTurnSha256 === matchedTurnResponse.configSha256 &&
      observedConsumedTurnCount === matchedTurnResponse.servers.length,
    { relay: !!relay });
  report.relayPublisherOutput = redactTurnSecrets(
    turnRegistryResponse.servers,
    turnRegistryResponse.rawResponse,
    publisher.output()
  );
}`,
    runRecoveryScenario: `
async function runRecoveryScenario(config, executable, browser, report, mediaFixture) {
  if (['recovery', 'all', 'auto', 'relay'].includes(config.scenario)) {
    addEvidence(report, 'packaged-turn-live-registry-workflow-entered', {
      scenario: config.scenario
    });
    await runRelayIceScenario(config, executable, browser, report, mediaFixture);
  }
  if (config.scenario === 'direct') {
    await runDirectStunScenario(config, executable, browser, report, mediaFixture);
  }
}`,
    startPublisher: `
function startPublisher(executable, signalUrl, options) {
  const args = [
    '--headless',
    \`--stream=\${options.streamId}\`,
    \`--server=\${signalUrl}\`,
    \`--ice-mode=\${options.iceMode}\`
  ];
  if (options.source) args.push(\`--source=\${options.source}\`);
  if (options.spoutSender) args.push(\`--spout-sender=\${options.spoutSender}\`);
  const child = spawn(executable, args, { windowsHide: true });
  return {
    child,
    args,
    output() { return ''; },
    async stop() {}
  };
}`
  };
  for (const [name, declaration] of Object.entries(replacements)) {
    source = replaceTopLevelFunctionDeclaration(source, name, declaration);
  }
  source = source.replace(
    /browserTurnEmergencyUrls:\s*EMERGENCY_RELAY_SERVERS\.map\(\(server\)\s*=>\s*server\.urls\)/,
    'browserTurnRegistrySource: \'live\''
  );
  return source;
}

function indexedAddressLoopDescriptor(source) {
  const parsed = parseTargetJavaScript(source);
  if (!parsed.ok) return null;
  const probeDeclaration = parsed.ast.body.find((node) =>
    node.type === 'FunctionDeclaration' && node.id &&
      node.id.name === 'probeSelectedTurnEndpoint');
  if (!probeDeclaration) return null;
  let match = null;
  walkTargetAst(probeDeclaration.body, (node) => {
    if (match || node.type !== 'ForStatement' || !node.update ||
        !node.init || node.init.type !== 'VariableDeclaration') {
      return;
    }
    for (const declaration of node.init.declarations) {
      const initialValue = staticPrimitiveValue(declaration.init);
      if (declaration.id.type !== 'Identifier' ||
          !initialValue.known || initialValue.value !== 0) {
        continue;
      }
      const indexName = declaration.id.name;
      const boundedByEveryAddress = node.test &&
        astNodeContains(node.test, (candidate) =>
          candidate.type === 'Identifier' && candidate.name === indexName) &&
        astNodeContains(node.test, (candidate) =>
          (memberExpressionPath(unwrapAstExpression(candidate)) || []).join('.') ===
            'endpoint.addresses.length');
      const readsIndexedAddress = astNodeContains(node.body, (candidate) => {
        const current = unwrapAstExpression(candidate);
        return current && current.type === 'MemberExpression' && current.computed &&
          (memberExpressionPath(unwrapAstExpression(current.object)) || []).join('.') ===
            'endpoint.addresses' &&
          current.property.type === 'Identifier' && current.property.name === indexName;
      });
      if (boundedByEveryAddress && readsIndexedAddress) {
        let indexedAddressReadStatementEnd = null;
        walkTargetAst(node.body, (candidate) => {
          if (indexedAddressReadStatementEnd !== null ||
              candidate.type !== 'VariableDeclaration') {
            return;
          }
          if (astNodeContains(candidate, (child) => {
            const current = unwrapAstExpression(child);
            return current && current.type === 'MemberExpression' && current.computed &&
              (memberExpressionPath(unwrapAstExpression(current.object)) || []).join('.') ===
                'endpoint.addresses' &&
              current.property.type === 'Identifier' && current.property.name === indexName;
          })) {
            indexedAddressReadStatementEnd = candidate.end;
          }
        });
        const indexIdentifierRanges = [];
        walkTargetAst(node, (candidate) => {
          if (candidate.type === 'Identifier' && candidate.name === indexName) {
            indexIdentifierRanges.push({ start: candidate.start, end: candidate.end });
          }
        });
        match = {
          indexName,
          loopStart: node.start,
          loopEnd: node.end,
          initStart: node.init.start,
          initEnd: node.init.end,
          testStart: node.test.start,
          testEnd: node.test.end,
          updateStart: node.update.start,
          updateEnd: node.update.end,
          indexedAddressReadStatementEnd,
          indexIdentifierRanges
        };
        break;
      }
    }
  });
  return match;
}

function canonicalUnitIndexedAddressSource(source) {
  const match = indexedAddressLoopDescriptor(source);
  if (!match) return null;
  return source.slice(0, match.updateStart) + `${match.indexName}++` +
    source.slice(match.updateEnd);
}

function replaceIndexedAddressLoopTest(source, replacement) {
  const match = indexedAddressLoopDescriptor(source);
  if (!match) return null;
  const test = typeof replacement === 'function'
    ? replacement(match.indexName)
    : replacement;
  return source.slice(0, match.testStart) + test + source.slice(match.testEnd);
}

function renameIndexedAddressLoopVariable(source, replacementName) {
  const match = indexedAddressLoopDescriptor(source);
  if (!match || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(replacementName)) return null;
  let renamed = source;
  for (const range of [...match.indexIdentifierRanges]
    .sort((left, right) => right.start - left.start)) {
    renamed = renamed.slice(0, range.start) + replacementName + renamed.slice(range.end);
  }
  return renamed;
}

async function phaseAMutationSeed(source, suppliedInputChecks = null) {
  try {
    const inputChecks = suppliedInputChecks || await evaluateCompleteChecks(source);
    const inputFailed = inputChecks.filter((check) => !check.ok).map((check) => check.id);
    if (inputChecks.length === expectedCompleteCheckCount && inputFailed.length === 0) {
      return {
        ok: true,
        source,
        checks: inputChecks,
        sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
        detail: 'input is already a complete known-good Phase A target'
      };
    }
    const unitIndexedSource = canonicalUnitIndexedAddressSource(source);
    if (unitIndexedSource && unitIndexedSource !== source) {
      const unitIndexedChecks = await evaluateCompleteChecks(unitIndexedSource);
      const unitIndexedFailed = unitIndexedChecks
        .filter((check) => !check.ok)
        .map((check) => check.id);
      if (unitIndexedChecks.length === expectedCompleteCheckCount &&
          unitIndexedFailed.length === 0) {
        return {
          ok: true,
          source: unitIndexedSource,
          checks: unitIndexedChecks,
          sha256: crypto.createHash('sha256')
            .update(unitIndexedSource, 'utf8')
            .digest('hex'),
          detail: 'reachable complete Phase A seed repaired indexed advancement to unit steps'
        };
      }
    }
    const greenSource = buildPhaseAGreenSeed(source);
    const checks = await evaluateCompleteChecks(greenSource);
    const failed = checks.filter((check) => !check.ok).map((check) => check.id);
    return {
      ok: checks.length === expectedCompleteCheckCount && failed.length === 0,
      source: greenSource,
      checks,
      sha256: crypto.createHash('sha256').update(greenSource, 'utf8').digest('hex'),
      detail: `reachable in-memory Phase A seed failed=${failed.join(',') || 'none'}`
    };
  } catch (error) {
    return {
      ok: false,
      source,
      checks: [],
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: String(error && error.message ? error.message : error)
    };
  }
}

const turnRegistryPolicyIds = [
  'TURN_REGISTRY_FETCH_IS_SCOPED_TO_TURN_USE',
  'TURN_REGISTRY_HTTP_200_VERSIONED_SCHEMA_IS_REQUIRED',
  'TURN_REGISTRY_RESPONSE_IS_NONEMPTY_AND_WHOLELY_VALID',
  'TURN_REGISTRY_FAILURE_HAS_NO_LOCAL_FALLBACK',
  'TURN_FETCHED_CONFIG_ORDER_URLS_CREDENTIALS_AND_UDP_ARE_PRESERVED',
  'TURN_ENDPOINTS_ARE_PROBED_IN_ISOLATION',
  'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
  'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED',
  'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT',
  'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED',
  'TURN_NON_UDP_MULTI_ADDRESS_COVERAGE_FAILS_CLOSED',
  'TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION',
  'PACKAGED_TURN_SCENARIO_USES_LIVE_REGISTRY_WITHOUT_FORCE_FALLBACK',
  'PACKAGED_TURN_FETCH_IS_FRESH_AND_EXPLICIT',
  'PACKAGED_TURN_REQUIRES_UNIQUE_FETCH_AND_CONSUMPTION_SUMMARIES',
  'PACKAGED_TURN_SAME_RUN_PROVENANCE_OR_BOUNDED_MATCH_IS_PROVEN',
  'PACKAGED_TURN_CONSUMED_CONFIG_MATCHES_FETCHED_RESPONSE',
  'PACKAGED_TURN_RESPONSE_HASH_BINDS_FULL_ORDERED_CONFIG',
  'TURN_DIAGNOSTICS_AND_REPORTS_REDACT_CREDENTIALS',
  'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE',
  'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
];

function buildPhaseACounterfeitSeed(frozenSource) {
  let source = frozenSource;
  const renames = [
    ['standardTimezoneOffsetMinutes', 'validateTurnRegistryResponse'],
    ['flattenTurnServers', 'flattenValidatedTurnRegistryEndpoints'],
    ['selectTurnServersLikeVdo', 'turnRegistryIceServers'],
    ['turnFallbackConfigV1Tuples', 'fetchValidatedTurnRegistryResponse'],
    ['canonicalTurnFallbackConfigV1', 'canonicalTurnRegistryResponseV1'],
    ['turnFallbackConfigV1Sha256', 'turnRegistryResponseSha256'],
    ['canonicalTurnFallbackSourceV1', 'matchPackagedTurnResponse'],
    ['turnFallbackSourceV1Sha256', 'redactTurnSecrets']
  ];
  for (let index = 0; index < renames.length; index += 1) {
    source = source.replace(
      new RegExp(`\\b${renames[index][0]}\\b`, 'g'),
      `__TURN_COUNTERFEIT_FUNCTION_${index}__`
    );
  }
  for (let index = 0; index < renames.length; index += 1) {
    source = source.replace(
      new RegExp(`__TURN_COUNTERFEIT_FUNCTION_${index}__`, 'g'),
      renames[index][1]
    );
  }
  source = source
    .replace(/\bfetchValidatedTurnRegistryResponse\s*\(/g, 'legacyTupleProjector(')
    .replace(
      /function\s+legacyTupleProjector\s*\(/,
      'function fetchValidatedTurnRegistryResponse('
    );
  for (const [pattern, replacement] of [
    [/TURN_FIXTURE_FALLBACK_SERVERS/g, 'EMERGENCY_RELAY_SERVERS'],
    [/RELAY_BROWSER_RTC_CONFIG/g, 'EMERGENCY_BROWSER_RTC_CONFIG'],
    [/forceTurnFallback/g, 'useEmergencyRelay'],
    [/--force-turn-fallback/g, '--emergency-relay'],
    [/fallback/g, 'emergency'],
    [/Fallback/g, 'Emergency'],
    [/FALLBACK/g, 'EMERGENCY']
  ]) {
    source = source.replace(pattern, replacement);
  }
  if (/\.filter\s*\(/.test(functionBody(source, 'flattenValidatedTurnRegistryEndpoints'))) {
    source = mutateFunctionBodyOnce(
      source,
      'flattenValidatedTurnRegistryEndpoints',
      /\.filter\s*\(/,
      "['filter'](",
      'counterfeit-hide-filter'
    );
  }
  if (/\.sort\s*\(/.test(functionBody(source, 'turnRegistryIceServers'))) {
    source = mutateFunctionBodyOnce(
      source,
      'turnRegistryIceServers',
      /\.sort\s*\(/,
      "['sort'](",
      'counterfeit-hide-sort'
    );
  }
  const counterfeitImplementations = {
    validateTurnRegistryResponse: `
function validateTurnRegistryResponse(_status, payload) {
  return payload;
}`,
    flattenValidatedTurnRegistryEndpoints: `
function flattenValidatedTurnRegistryEndpoints(_registry) {
  return [];
}`,
    turnRegistryIceServers: `
function turnRegistryIceServers(_response) {
  return [];
}`,
    fetchValidatedTurnRegistryResponse: `
async function fetchValidatedTurnRegistryResponse(_endpoint) {
  return { version: 1, servers: [] };
}`,
    canonicalTurnRegistryResponseV1: `
function canonicalTurnRegistryResponseV1(_servers) {
  return JSON.stringify([]);
}`,
    turnRegistryResponseSha256: `
function turnRegistryResponseSha256(_servers) {
  return '0'.repeat(64);
}`,
    matchPackagedTurnResponse: `
function matchPackagedTurnResponse(responses) {
  return responses[0] || null;
}`,
    redactTurnSecrets: `
function redactTurnSecrets(_servers, _rawResponse, value) {
  return String(value);
}`,
    ensureTurnFixture: `
async function ensureTurnFixture(_config, _browser, _report, _turnFixture) {
}`,
    runRelayIceScenario: `
async function runRelayIceScenario(_config, _executable, _browser, _report, _mediaFixture) {
  return null;
}`,
    runRecoveryScenario: `
async function runRecoveryScenario(_config, _executable, _browser, _report, _mediaFixture) {
  return null;
}`
  };
  for (const [name, declaration] of Object.entries(counterfeitImplementations)) {
    source = replaceTopLevelFunctionDeclaration(source, name, declaration);
  }
  const inject = (name, body, mutationName) => {
    source = mutateFunctionBodyOnce(
      source,
      name,
      /^/,
      `\n${body}\n`,
      mutationName
    );
  };
  inject(
    'validateTurnRegistryResponse',
    "if(false){const payload={};if(!Number.isInteger(payload.version)||payload.version !== 1)throw Error('bad');if(!Array.isArray(payload.servers)||payload.servers.length === 0)throw Error('bad');return payload.servers.map((server)=>{if(Object.prototype.hasOwnProperty.call(server,'url'))throw Error('bad');const urls=typeof server.urls === 'string'?[server.urls]:Array.isArray(server.urls)?server.urls:[];if(urls.length === 0)throw Error('bad');if(typeof server.username !== 'string'||server.username.trim().length === 0)throw Error('bad');if(typeof server.credential !== 'string'||server.credential.trim().length === 0)throw Error('bad');if(typeof server.udp !== 'boolean')throw Error('bad');return server;});}",
    'counterfeit-schema'
  );
  inject(
    'fetchValidatedTurnRegistryResponse',
    "if(false){const endpoint='https://turnservers.vdo.ninja'+'.invalid/registry';const response={status:200,text:()=>'{}'};if(response.status !== 200)throw Error('bad');const payload=JSON.parse(response.text());return validateTurnRegistryResponse(payload);}",
    'counterfeit-fetch'
  );
  inject(
    'flattenValidatedTurnRegistryEndpoints',
    'if(false){return registry.servers.map((server)=>({urls:server.urls,udp:server.udp}));}',
    'counterfeit-flatten'
  );
  inject(
    'turnRegistryIceServers',
    'if(false){return response.servers.map((server)=>({urls: server.urls,username: server.username,credential: server.credential,udp: server.udp}));}',
    'counterfeit-ice'
  );
  inject(
    'canonicalTurnRegistryResponseV1',
    "if(false){return TURN_REGISTRY_CONFIG_V1_PREFIX+'\\n'+JSON.stringify(servers.map(({ urls, username, credential, udp }) => ({ urls, username, credential, udp })));}",
    'counterfeit-canonical'
  );
  inject(
    'turnRegistryResponseSha256',
    'if(false){return sha256Text(canonicalTurnRegistryResponseV1(servers));}',
    'counterfeit-hash'
  );
  inject(
    'matchPackagedTurnResponse',
    'if(false){void transactionId;void responseSha256;void fetchStartedAtMs;void fetchCompletedAtMs;const matches=responses.filter((entry)=>entry.ok);return matches.length === 1?matches[0]:null;}',
    'counterfeit-match'
  );
  inject(
    'redactTurnSecrets',
    "if(false){return '[REDACTED]'+server.username+server.credential+rawResponse;}",
    'counterfeit-redact'
  );
  inject(
    'runRecoveryScenario',
    "if(false){addEvidence(report,'packaged-turn-live-registry-workflow-entered',{});}",
    'counterfeit-recovery'
  );
  inject(
    'ensureTurnFixture',
    'if(false){const fetchedEndpoints=flattenValidatedTurnRegistryEndpoints(turnRegistryResponse);for(const endpoint of fetchedEndpoints){await probeSelectedTurnEndpoint(probe.page, endpoint);}void(endpointProbes.length === fetchedEndpoints.length);}',
    'counterfeit-endpoints'
  );
  inject(
    'run',
    "if(false){redactTurnSecrets([], '');void 'packaged-turn-consumed-config-matches-fetched-response';}",
    'counterfeit-run'
  );
  inject(
    'runRelayIceScenario',
    "if(false){const turnRegistryFetchStartedAtMs=Date.now();const turnRegistryResponse=await fetchValidatedTurnRegistryResponse('https://registry.invalid/turn');const turnRegistryFetchCompletedAtMs=Date.now();resolveBrowserTurnConfiguration(turnRegistryResponse);const registryEndpoints=flattenValidatedTurnRegistryEndpoints(turnRegistryResponse);void registryEndpoints;addEvidence(report,'packaged-turn-live-registry-response-accepted',{});redactTurnSecrets(turnRegistryResponse.servers,turnRegistryResponse.rawResponse);const relay = await connectNewPeer({config});const publisherOutputLines=publisher.output().split(/\\r?\\n/);const nativeTurnRegistryFetchLines=publisherOutputLines.filter((line)=>/\\[ICE\\] TurnRegistryFetch(?:\\s|$)/.test(line));const consumedIceConfigLines=publisherOutputLines.filter((line)=>/\\[WebRTC\\] ConsumedIceConfig(?:\\s|$)/.test(line));addCheck(report,'packaged-turn-registry-fetch-is-unique',nativeTurnRegistryFetchLines.length === 1&&/^[0-9a-f]{64}$/.test(turnRegistryResponseSha256(turnRegistryResponse))&&matchPackagedTurnResponse({turnRegistryTransactionId,turnRegistryResponseSha256,turnRegistryFetchStartedAtMs,turnRegistryFetchCompletedAtMs}));addCheck(report,'packaged-turn-consumed-config-matches-fetched-response',consumedIceConfigLines.length === 1&&exactIceSummaryToken(consumedIceConfig,'turnRegistryTransactionId')&&exactIceSummaryToken(consumedIceConfig,'turnRegistryResponseSha256')&&exactIceSummaryToken(consumedIceConfig,'turnConfigV1Sha256')&&observedConsumedTransactionId === matchedTurnResponse.transactionId&&observedConsumedResponseSha256 === matchedTurnResponse.responseSha256&&observedConsumedTurnSha256 === matchedTurnResponse.configSha256&&observedConsumedTurnCount === matchedTurnResponse.servers.length);}",
    'counterfeit-relay'
  );
  source = source.replace(
    /const\s+TURN_EMERGENCY_CONFIG_V1_PREFIX\s*=\s*[^;]+;/,
    "$&\nconst TURN_REGISTRY_CONFIG_V1_PREFIX = 'game-capture-turn-registry-config-v1';"
  );
  return source;
}

function exercisePhaseADynamicAcceptance(frozenSource) {
  const inputSha256 = crypto.createHash('sha256')
    .update(frozenSource, 'utf8')
    .digest('hex');
  const counterfeit = buildPhaseACounterfeitSeed(frozenSource);
  const checks = analyze(counterfeit);
  const turnFailures = checks
    .filter((check) => turnRegistryPolicyIds.includes(check.id) && !check.ok)
    .map((check) => check.id);
  const counterfeitSha256 = crypto.createHash('sha256')
    .update(counterfeit, 'utf8')
    .digest('hex');
  const knownCounterfeitLabel = new Map([
    [
      'f7db0456009e93994d626c8aa2d9d5696401884275c55c8ddaeb165144f1495b',
      'frozen-target-counterfeit'
    ],
    [
      'a75be4e67160485da53da2963960fab0118ddc7691f604f2dd339c07c4375928',
      'known-good-counterfeit'
    ]
  ]).get(counterfeitSha256) || 'unlabelled-semantic-counterfeit';
  const requiredSemanticFailures = [
    'TURN_REGISTRY_FETCH_IS_SCOPED_TO_TURN_USE',
    'TURN_REGISTRY_HTTP_200_VERSIONED_SCHEMA_IS_REQUIRED',
    'TURN_REGISTRY_RESPONSE_IS_NONEMPTY_AND_WHOLELY_VALID',
    'TURN_FETCHED_CONFIG_ORDER_URLS_CREDENTIALS_AND_UDP_ARE_PRESERVED',
    'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED',
    'PACKAGED_TURN_SAME_RUN_PROVENANCE_OR_BOUNDED_MATCH_IS_PROVEN',
    'PACKAGED_TURN_CONSUMED_CONFIG_MATCHES_FETCHED_RESPONSE',
    'PACKAGED_TURN_RESPONSE_HASH_BINDS_FULL_ORDERED_CONFIG',
    'TURN_DIAGNOSTICS_AND_REPORTS_REDACT_CREDENTIALS',
    'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE'
  ];
  const missingSemanticFailures = requiredSemanticFailures.filter((id) =>
    !turnFailures.includes(id));
  return {
    ok: missingSemanticFailures.length === 0,
    inputSha256,
    counterfeitSha256,
    knownCounterfeitLabel,
    missingSemanticFailures,
    turnFailures,
    detail: `counterfeitSha256=${counterfeitSha256} ` +
      `inputSha256=${inputSha256} label=${knownCounterfeitLabel} ` +
      `semanticFailures=${requiredSemanticFailures.length - missingSemanticFailures.length}/` +
      `${requiredSemanticFailures.length} missingSemantic=` +
      `${missingSemanticFailures.join('|') || 'none'} ` +
      `turnPass=${turnRegistryPolicyIds.length - turnFailures.length}/` +
      `${turnRegistryPolicyIds.length} failed=${turnFailures.join(',') || 'none'}`
  };
}

function buildTurnEquivalentVariants(greenSource) {
  const variants = [];
  const add = (name, policyId, source) => variants.push({ name, policyId, source });
  add(
    'parenthesized-fetch-callee',
    turnRegistryPolicyIds[0],
    mutateFunctionBodyOnce(
      greenSource,
      'runRelayIceScenario',
      /await\s+fetchValidatedTurnRegistryResponse\s*\(/,
      'await (fetchValidatedTurnRegistryResponse)(',
      'equivalent-parenthesized-fetch-callee'
    )
  );
  add(
    'reordered-version-comparison',
    turnRegistryPolicyIds[1],
    mutateFunctionBodyOnce(
      greenSource,
      'validateTurnRegistryResponse',
      /payload\.version\s*!==\s*1/,
      '1 !== payload.version',
      'equivalent-reordered-version-comparison'
    )
  );
  add(
    'logical-not-nonempty-length',
    turnRegistryPolicyIds[2],
    mutateFunctionBodyOnce(
      greenSource,
      'validateTurnRegistryResponse',
      /payload\.servers\.length\s*===\s*0/,
      '!payload.servers.length',
      'equivalent-logical-not-nonempty-length'
    )
  );
  add(
    'unused-fallback-name-only-constant',
    turnRegistryPolicyIds[3],
    greenSource.replace(
      /\nrun\(\)\.catch\(/,
      "\nconst TURN_FIXTURE_FALLBACK_SERVERS = 'unused-name-only';\n\nrun().catch("
    )
  );
  add(
    'parenthesized-server-urls-expression',
    turnRegistryPolicyIds[4],
    mutateFunctionBodyOnce(
      greenSource,
      'turnRegistryIceServers',
      /urls:\s*server\.urls/,
      'urls: (server.urls)',
      'equivalent-parenthesized-server-urls'
    )
  );
  add(
    'parenthesized-isolated-server-expression',
    turnRegistryPolicyIds[5],
    mutateFunctionBodyOnce(
      greenSource,
      'probeSelectedTurnEndpoint',
      /iceServers:\s*\[browserTurnServer\(endpoint\)\]/,
      'iceServers: [(browserTurnServer(endpoint))]',
      'equivalent-parenthesized-isolated-server'
    )
  );
  add(
    'parenthesized-probe-callee',
    turnRegistryPolicyIds[6],
    mutateFunctionBodyOnce(
      greenSource,
      'probeSelectedTurnEndpoint',
      /await\s+probeBrowserTurn\(/,
      'await (probeBrowserTurn)(',
      'equivalent-parenthesized-probe-callee'
    )
  );
  add(
    'reordered-endpoint-count-equality',
    turnRegistryPolicyIds[7],
    mutateFunctionBodyOnce(
      greenSource,
      'ensureTurnFixture',
      /endpointProbes\.length\s*===\s*fetchedEndpoints\.length/,
      'fetchedEndpoints.length === endpointProbes.length',
      'equivalent-reordered-endpoint-count'
    )
  );
  let destructuredOk = mutateFunctionBodyOnce(
    greenSource,
    'ensureTurnFixture',
    /endpoint\.hostnameAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/,
    'endpoint.hostnameAttempts.every(({ ok }) => ok)',
    'equivalent-destructured-hostname-ok'
  );
  destructuredOk = mutateFunctionBodyOnce(
    destructuredOk,
    'ensureTurnFixture',
    /endpoint\.addressAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/,
    'endpoint.addressAttempts.every(({ ok }) => ok)',
    'equivalent-destructured-address-ok'
  );
  destructuredOk = mutateFunctionBodyOnce(
    destructuredOk,
    'ensureTurnFixture',
    /everyOriginalHostnameAttemptAllocated\s*&&\s*everyResolvedAddressPassed\s*&&\s*rtcConfigRetainsOriginalHostnames/,
    'Boolean((everyOriginalHostnameAttemptAllocated && everyResolvedAddressPassed) && ' +
      'rtcConfigRetainsOriginalHostnames)',
    'equivalent-grouped-boolean-health-predicate'
  );
  add('destructured-every-ok', turnRegistryPolicyIds[8], destructuredOk);
  add(
    'indexed-resolved-address-iteration',
    turnRegistryPolicyIds[9],
    /for\s*\(const\s+address\s+of\s+endpoint\.addresses\)\s*\{/.test(
      functionBody(greenSource, 'probeSelectedTurnEndpoint')
    )
      ? mutateFunctionBodyOnce(
        greenSource,
        'probeSelectedTurnEndpoint',
        /for\s*\(const\s+address\s+of\s+endpoint\.addresses\)\s*\{/,
        'for (let addressIndex = 0; addressIndex < endpoint.addresses.length; ' +
          'addressIndex++) {\n    const address = endpoint.addresses[addressIndex];',
        'equivalent-indexed-address-iteration'
      )
      : greenSource
  );
  add(
    'reordered-single-address-equality',
    turnRegistryPolicyIds[10],
    mutateFunctionBodyOnce(
      greenSource,
      'probeSelectedTurnEndpoint',
      /endpoint\.addresses\.length\s*===\s*1/,
      '1 === endpoint.addresses.length',
      'equivalent-reordered-single-address'
    )
  );
  add(
    'local-tls-options-object',
    turnRegistryPolicyIds[11],
    /socket\s*=\s*tls\.connect\(\{\s*host:\s*address,\s*port:\s*parsed\.port,\s*servername:\s*parsed\.hostname,\s*rejectUnauthorized:\s*true\s*\}\);/.test(
      functionBody(greenSource, 'probeTurnSocketAddress')
    )
      ? mutateFunctionBodyOnce(
        greenSource,
        'probeTurnSocketAddress',
        /socket\s*=\s*tls\.connect\(\{\s*host:\s*address,\s*port:\s*parsed\.port,\s*servername:\s*parsed\.hostname,\s*rejectUnauthorized:\s*true\s*\}\);/,
        'const tlsOptions = {\n' +
          '          host: address,\n' +
          '          port: parsed.port,\n' +
          '          servername: parsed.hostname,\n' +
          '          rejectUnauthorized: true\n' +
          '        };\n' +
          '        socket = tls.connect(tlsOptions);',
        'equivalent-local-tls-options-object'
      )
      : greenSource
  );
  add(
    'parenthesized-relay-callee',
    turnRegistryPolicyIds[12],
    mutateFunctionBodyOnce(
      greenSource,
      'runRecoveryScenario',
      /await\s+runRelayIceScenario\(/,
      'await (runRelayIceScenario)(',
      'equivalent-parenthesized-relay-callee'
    )
  );
  let numericDates = mutateFunctionBodyOnce(
    greenSource,
    'runRelayIceScenario',
    /Date\.now\(\)/,
    'Number(new Date())',
    'equivalent-first-numeric-date'
  );
  numericDates = mutateFunctionBodyOnce(
    numericDates,
    'runRelayIceScenario',
    /Date\.now\(\)/,
    'Number(new Date())',
    'equivalent-second-numeric-date'
  );
  add('number-new-date-bounds', turnRegistryPolicyIds[13], numericDates);
  let arrowNoParens = mutateFunctionBodyOnce(
    greenSource,
    'runRelayIceScenario',
    /filter\(\(line\)\s*=>/,
    'filter(line =>',
    'equivalent-first-arrow-no-parens'
  );
  arrowNoParens = mutateFunctionBodyOnce(
    arrowNoParens,
    'runRelayIceScenario',
    /filter\(\(line\)\s*=>/,
    'filter(line =>',
    'equivalent-second-arrow-no-parens'
  );
  add('arrow-parameter-without-parentheses', turnRegistryPolicyIds[14], arrowNoParens);
  add(
    'array-prototype-filter-call',
    turnRegistryPolicyIds[15],
    mutateFunctionBodyOnce(
      greenSource,
      'matchPackagedTurnResponse',
      /responses\.filter\(\(entry\)\s*=>/,
      'Array.prototype.filter.call(responses, (entry) =>',
      'equivalent-array-prototype-filter-call'
    )
  );
  let objectIs = greenSource;
  for (const [left, right] of [
    ['observedConsumedTransactionId', 'matchedTurnResponse.transactionId'],
    ['observedConsumedResponseSha256', 'matchedTurnResponse.responseSha256'],
    ['observedConsumedTurnSha256', 'matchedTurnResponse.configSha256'],
    ['observedConsumedTurnCount', 'matchedTurnResponse.servers.length']
  ]) {
    const escapedRight = right.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    objectIs = mutateFunctionBodyOnce(
      objectIs,
      'runRelayIceScenario',
      new RegExp(`${left}\\s*===\\s*${escapedRight}`),
      `Object.is(${left}, ${right})`,
      `equivalent-object-is-${left}`
    );
  }
  add('object-is-consumed-comparisons', turnRegistryPolicyIds[16], objectIs);
  add(
    'explicit-canonical-object-properties',
    turnRegistryPolicyIds[17],
    mutateFunctionBodyOnce(
      greenSource,
      'canonicalTurnRegistryResponseV1',
      /urls,\s*username,\s*credential,\s*udp/,
      'urls: urls, username: username, credential: credential, udp: udp',
      'equivalent-explicit-canonical-properties'
    )
  );
  add(
    'computed-secret-properties',
    turnRegistryPolicyIds[18],
    mutateFunctionBodyOnce(
      greenSource,
      'redactTurnSecrets',
      /\[server\.username,\s*server\.credential\]/,
      "[server['username'], server['credential']]",
      'equivalent-computed-secret-properties'
    )
  );
  add(
    'some-based-relay-dispatch',
    turnRegistryPolicyIds[19],
    mutateFunctionBodyOnce(
      greenSource,
      'run',
      /(\[[\s\S]{0,240}?['"]relay['"][\s\S]{0,240}?\])\.includes\(config\.scenario\)/,
      '$1.some((scenarioName) => scenarioName === config.scenario)',
      'equivalent-some-based-relay-dispatch'
    )
  );
  add(
    'parenthesized-browser-readiness-callee',
    turnRegistryPolicyIds[20],
    mutateFunctionBodyOnce(
      greenSource,
      'runRelayIceScenario',
      /await\s+ensureBrowserRtcReadiness\s*\(/,
      'await (ensureBrowserRtcReadiness)(',
      'equivalent-parenthesized-browser-readiness-callee'
    )
  );
  return variants;
}

async function exerciseTurnEquivalentVariants(greenSource) {
  const cases = [];
  for (const variant of buildTurnEquivalentVariants(greenSource)) {
    const checks = await evaluateCompleteChecks(variant.source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const turnFailures = failedIds.filter((id) => turnRegistryPolicyIds.includes(id));
    cases.push({
      name: variant.name,
      policyId: variant.policyId,
      ok: checks.length === expectedCompleteCheckCount && failedIds.length === 0,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      turnFailures
    });
  }
  return {
    ok: cases.length === turnRegistryPolicyIds.length && cases.every((entry) => entry.ok),
    cases,
    detail: `variants=${cases.filter((entry) => entry.ok).length}/${cases.length} ` +
      `failures=${cases.filter((entry) => !entry.ok).map((entry) =>
        `${entry.name}:${entry.failedIds.join('|') || 'none'}`).join(',') || 'none'}`
  };
}

async function exerciseRound4IndexedAddressAdvancement(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  const canonicalLoop = canonicalIndexedSource
    ? indexedAddressLoopDescriptor(canonicalIndexedSource)
    : null;
  if (!canonicalIndexedSource || !canonicalLoop) {
    return {
      ok: false,
      controls: [],
      mutation: null,
      mutations: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const replaceAdvancement = (source, replacement, mutationName) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error(`Mutation '${mutationName}' could not find indexed loop`);
    const update = typeof replacement === 'function'
      ? replacement(loop.indexName)
      : replacement;
    return source.slice(0, loop.updateStart) + update + source.slice(loop.updateEnd);
  };
  const insertAfterIndexedAddressRead = (source, statement, mutationName) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error(`Mutation '${mutationName}' could not find indexed address read`);
    }
    const injected = typeof statement === 'function'
      ? statement(loop.indexName)
      : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) +
      `\n    ${injected}` + source.slice(loop.indexedAddressReadStatementEnd);
  };
  const insertBeforeIndexedAddressLoop = (source, statement, mutationName) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error(`Mutation '${mutationName}' could not find indexed loop`);
    return source.slice(0, loop.loopStart) + `${statement}\n  ` + source.slice(loop.loopStart);
  };
  const appendIndexedAddressLoopInitializer = (source, initializer, mutationName) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error(`Mutation '${mutationName}' could not find indexed loop`);
    const injected = typeof initializer === 'function'
      ? initializer(loop.indexName)
      : initializer;
    return source.slice(0, loop.initEnd) + `, ${injected}` + source.slice(loop.initEnd);
  };
  const reversedBoundSource = replaceIndexedAddressLoopTest(
    canonicalIndexedSource,
    (indexName) => `endpoint.addresses.length > ${indexName}`
  );
  const renamedReversedBoundSource = reversedBoundSource &&
    renameIndexedAddressLoopVariable(reversedBoundSource, 'resolvedAddressIndex');
  const notEqualBoundSource = replaceIndexedAddressLoopTest(
    canonicalIndexedSource,
    (indexName) => `${indexName} !== endpoint.addresses.length`
  );
  const commutedAssignmentSource = replaceAdvancement(
    canonicalIndexedSource,
    (indexName) => `${indexName} = 1 + ${indexName}`,
    'round6-commuted-assignment-index-advancement'
  );
  let conditionalNonIndexIncrementSource = insertBeforeIndexedAddressLoop(
    canonicalIndexedSource,
    'let conditionalAddressVisitCount = 0;',
    'round6-conditional-non-index-side-increment-declaration'
  );
  conditionalNonIndexIncrementSource = insertAfterIndexedAddressRead(
    conditionalNonIndexIncrementSource,
    'if (endpoint.addresses.length > 5) conditionalAddressVisitCount++;',
    'round6-conditional-non-index-side-increment'
  );
  const shadowedIndexSideIncrementSource = insertAfterIndexedAddressRead(
    canonicalIndexedSource,
    (indexName) => `{ let ${indexName} = 0; ${indexName}++; }`,
    'round6-shadowed-index-side-increment'
  );
  const conditionalNonIndexHeaderSource = appendIndexedAddressLoopInitializer(
    canonicalIndexedSource,
    'conditionalHeaderCount = endpoint.addresses.length > 5 ? 1 : 0',
    'round6-conditional-non-index-header-initializer'
  );
  if (!reversedBoundSource || !renamedReversedBoundSource || !notEqualBoundSource) {
    return {
      ok: false,
      controls: [],
      mutation: null,
      mutations: [],
      detail: 'indexed bound-equivalence controls were not constructed'
    };
  }
  const controlSources = [
    ['postfix-increment', canonicalIndexedSource],
    [
      'prefix-increment',
      replaceAdvancement(
        canonicalIndexedSource,
        (indexName) => `++${indexName}`,
        'round4-prefix-index-advancement'
      )
    ],
    [
      'compound-unit-increment',
      replaceAdvancement(
        canonicalIndexedSource,
        (indexName) => `${indexName} += 1`,
        'round4-compound-index-advancement'
      )
    ],
    [
      'assignment-unit-increment',
      replaceAdvancement(
        canonicalIndexedSource,
        (indexName) => `${indexName} = ${indexName} + 1`,
        'round4-assignment-index-advancement'
      )
    ],
    ['commuted-assignment-unit-increment', commutedAssignmentSource],
    ['reversed-length-bound', reversedBoundSource],
    ['reversed-length-bound-renamed-index', renamedReversedBoundSource],
    ['not-equal-length-bound', notEqualBoundSource],
    ['conditional-non-index-side-increment', conditionalNonIndexIncrementSource],
    ['shadowed-index-side-increment', shadowedIndexSideIncrementSource],
    ['conditional-non-index-header-initializer', conditionalNonIndexHeaderSource]
  ];
  const controls = [];
  for (const [name, source] of controlSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    controls.push({
      name,
      ok: checks.length === expectedCompleteCheckCount && failedIds.length === 0,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex')
    });
  }

  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const mutationSources = [
    [
      'indexed-address-loop-skips-middle-resolved-addresses',
      replaceAdvancement(
        canonicalIndexedSource,
        (indexName) =>
          `${indexName} += Math.max(1, endpoint.addresses.length - 1)`,
        'round4-indexed-address-loop-skips-middle-addresses'
      )
    ],
    [
      'indexed-address-loop-length-derived-advancement-skips-addresses',
      replaceAdvancement(
        canonicalIndexedSource,
        (indexName) => `${indexName} += endpoint.addresses.length`,
        'round5-indexed-address-loop-length-derived-advancement'
      )
    ],
    [
      'indexed-address-loop-conditionally-advances-in-body',
      insertAfterIndexedAddressRead(
        canonicalIndexedSource,
        (indexName) => `if (endpoint.addresses.length > 5) ${indexName}++;`,
        'round6-indexed-address-loop-conditionally-advances-in-body'
      )
    ],
    [
      'indexed-address-loop-conditionally-compound-advances-in-body',
      insertAfterIndexedAddressRead(
        canonicalIndexedSource,
        (indexName) => `if (endpoint.addresses.length > 6) ${indexName} += 1;`,
        'round6-indexed-address-loop-conditionally-compound-advances-in-body'
      )
    ],
    [
      'indexed-address-loop-conditionally-advances-in-header',
      appendIndexedAddressLoopInitializer(
        canonicalIndexedSource,
        (indexName) =>
          `conditionalHeaderAdvance = (${indexName} += ` +
            'endpoint.addresses.length > 5 ? 1 : 0)',
        'round6-indexed-address-loop-conditionally-advances-in-header'
      )
    ]
  ];
  const mutations = [];
  for (const [name, source] of mutationSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    mutations.push({
      name,
      ok: exactFailures,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    });
  }
  const mutation = mutations[0];
  return {
    ok: controls.every((entry) => entry.ok) &&
      mutations.every((entry) => entry.ok),
    controls,
    mutation,
    mutations,
    detail: `controls=${controls.filter((entry) => entry.ok).length}/${controls.length} ` +
      `mutations=${mutations.filter((entry) => entry.ok).length}/${mutations.length} ` +
      `survivors=${mutations.filter((entry) => !entry.ok)
        .map((entry) => entry.name).join(',') || 'none'}`
  };
}

async function exerciseRound7FunctionScopedIndexWrites(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  if (!canonicalIndexedSource) {
    return {
      ok: false,
      controls: [],
      mutations: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const asFunctionScopedVarLoop = (source) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 7 could not find indexed loop declaration');
    const initializer = source.slice(loop.initStart, loop.initEnd);
    if (!/^let\b/.test(initializer)) {
      throw new Error('Round 7 indexed loop does not use a lexical declaration');
    }
    return source.slice(0, loop.initStart) + initializer.replace(/^let\b/, 'var') +
      source.slice(loop.initEnd);
  };
  const insertBeforeLoop = (source, declaration) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 7 could not find loop for pre-loop declaration');
    const injected = typeof declaration === 'function'
      ? declaration(loop.indexName)
      : declaration;
    return source.slice(0, loop.loopStart) + injected + '\n  ' +
      source.slice(loop.loopStart);
  };
  const insertAfterLoop = (source, declaration) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 7 could not find loop for post-loop declaration');
    const injected = typeof declaration === 'function'
      ? declaration(loop.indexName)
      : declaration;
    return source.slice(0, loop.loopEnd) + `\n  ${injected}` +
      source.slice(loop.loopEnd);
  };
  const insertAfterIndexedAddressRead = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error('Round 7 could not find indexed address read');
    }
    const injected = typeof statement === 'function'
      ? statement(loop.indexName)
      : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) + `\n    ${injected}` +
      source.slice(loop.indexedAddressReadStatementEnd);
  };
  const addPreLoopHelperCall = (source, declaration, call) => {
    let mutated = insertBeforeLoop(source, declaration);
    mutated = insertAfterIndexedAddressRead(mutated, call);
    return mutated;
  };
  const addPostLoopHelperCall = (source, declaration, call) => {
    let mutated = insertAfterIndexedAddressRead(source, call);
    mutated = insertAfterLoop(mutated, declaration);
    return mutated;
  };

  const functionScopedVarSource = asFunctionScopedVarLoop(canonicalIndexedSource);
  const nestedShadowSource = insertAfterIndexedAddressRead(
    functionScopedVarSource,
    (indexName) => `{ let ${indexName} = 0; (() => { ` +
      `if (endpoint.addresses.length > 17) ${indexName}++; })(); }`
  );
  const parameterShadowSource = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => `const round7ShadowedParameterAdvance = (${indexName}) => { ` +
      `if (endpoint.addresses.length > 17) ${indexName}++; };`,
    'round7ShadowedParameterAdvance(0);'
  );
  const controlSources = [
    ['function-scoped-var-unit-loop', functionScopedVarSource],
    ['function-scoped-var-nested-lexical-shadow', nestedShadowSource],
    ['function-scoped-var-helper-parameter-shadow', parameterShadowSource]
  ];
  const controls = [];
  for (const [name, source] of controlSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const runtimeBoundaryCovered = !!owner &&
      /addressCounts=1,2,3,5,6,7,11,12,17\b/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    controls.push({
      name,
      ok: checks.length === expectedCompleteCheckCount &&
        failedIds.length === 0 && runtimeBoundaryCovered,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      runtimeBoundaryCovered,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    });
  }

  const exactFormerSurvivorSource = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const heldoutOutsideLoopAdvance = () => { ' +
      `if (endpoint.addresses.length > 11) ${indexName}++; };`,
    'heldoutOutsideLoopAdvance();'
  );
  const preLoopFunctionDeclarationSource = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'function round7PreLoopAdvance() { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }`,
    'round7PreLoopAdvance();'
  );
  const postLoopFunctionDeclarationSource = addPostLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'function round7PostLoopAdvance() { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }`,
    'round7PostLoopAdvance();'
  );
  const preLoopFunctionExpressionSource = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round7FunctionExpressionAdvance = function () { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; };`,
    'round7FunctionExpressionAdvance();'
  );
  const preLoopArrowAliasSource = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round7ArrowAdvance = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
      'const round7ArrowAdvanceAlias = round7ArrowAdvance;',
    'round7ArrowAdvanceAlias();'
  );
  const mutationSources = [
    ['exact-former-count-12-survivor', exactFormerSurvivorSource, 'count-12-runtime'],
    ['captured-pre-loop-function-declaration-write', preLoopFunctionDeclarationSource,
      'structural-only'],
    ['captured-post-loop-function-declaration-write', postLoopFunctionDeclarationSource,
      'structural-only'],
    ['captured-pre-loop-function-expression-write', preLoopFunctionExpressionSource,
      'structural-only'],
    ['captured-pre-loop-arrow-alias-write', preLoopArrowAliasSource, 'structural-only']
  ];
  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const mutations = [];
  for (const [name, source, proofKind] of mutationSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const staticRejected = !!owner && /\bindexed=false\b/.test(owner.detail);
    const runtimeProof = proofKind === 'count-12-runtime'
      ? !!owner && /visitation mismatch count=12\b/.test(owner.detail)
      : !!owner && /runtime-equivalent TURN leaf cases=7 passed=7 failed=none/.test(
        owner.detail
      );
    mutations.push({
      name,
      ok: checks.length === expectedCompleteCheckCount &&
        exactFailures && staticRejected && runtimeProof,
      proofKind,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures,
      staticRejected,
      runtimeProof,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    });
  }
  return {
    ok: controls.length === 3 && controls.every((entry) => entry.ok) &&
      mutations.length === 5 && mutations.every((entry) => entry.ok),
    controls,
    mutations,
    detail: `controls=${controls.filter((entry) => entry.ok).length}/${controls.length} ` +
      `mutations=${mutations.filter((entry) => entry.ok).length}/${mutations.length} ` +
      `survivors=${mutations.filter((entry) => !entry.ok)
        .map((entry) => entry.name).join(',') || 'none'}`
  };
}

async function exerciseRound8BindingReachability(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  if (!canonicalIndexedSource) {
    return {
      ok: false,
      controls: [],
      mutations: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const asFunctionScopedVarLoop = (source) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 8 could not find indexed loop declaration');
    const initializer = source.slice(loop.initStart, loop.initEnd);
    if (!/^let\b/.test(initializer)) {
      throw new Error('Round 8 indexed loop does not use a lexical declaration');
    }
    return source.slice(0, loop.initStart) + initializer.replace(/^let\b/, 'var') +
      source.slice(loop.initEnd);
  };
  const insertBeforeLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 8 could not find loop for pre-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopStart) + injected + '\n  ' + source.slice(loop.loopStart);
  };
  const insertAfterLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 8 could not find loop for post-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopEnd) + `\n  ${injected}` + source.slice(loop.loopEnd);
  };
  const insertAfterIndexedAddressRead = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error('Round 8 could not find indexed address read');
    }
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) + `\n    ${injected}` +
      source.slice(loop.indexedAddressReadStatementEnd);
  };
  const addPreLoopHelperCall = (source, declaration, call) => {
    let mutated = insertBeforeLoop(source, declaration);
    mutated = insertAfterIndexedAddressRead(mutated, call);
    return mutated;
  };

  const functionScopedVarSource = asFunctionScopedVarLoop(canonicalIndexedSource);
  const sequentialWrites = [
    ['assignment', (indexName) => `${indexName} = 0;`],
    ['update', (indexName) => `${indexName}++;`],
    ['destructuring', (indexName) => `[${indexName}] = [0];`],
    ['for-in', (indexName) => `for (${indexName} in { held: 1 }) {}`],
    ['for-of', (indexName) => `for (${indexName} of [0]) {}`]
  ];
  const controlSources = [];
  for (const [writeName, statement] of sequentialWrites) {
    controlSources.push([
      `direct-pre-loop-${writeName}-is-sequential`,
      insertBeforeLoop(functionScopedVarSource, statement)
    ]);
    controlSources.push([
      `direct-post-loop-${writeName}-is-sequential`,
      insertAfterLoop(functionScopedVarSource, statement)
    ]);
  }
  controlSources.push([
    'unused-nested-capture-is-not-reachable',
    insertAfterIndexedAddressRead(
      functionScopedVarSource,
      (indexName) => 'const round8UnusedNestedCapture = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; };`
    )
  ]);
  controlSources.push([
    'custom-callback-method-that-does-not-invoke-is-green',
    addPreLoopHelperCall(
      functionScopedVarSource,
      (indexName) => 'const round8IgnoredCallback = () => { ' +
        `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
        'const round8InertCallbackHost = { forEach(_callback) {} };',
      'round8InertCallbackHost.forEach(round8IgnoredCallback);'
    )
  ]);

  const controls = [];
  for (const [name, source] of controlSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const runtimeBoundaryCovered = !!owner &&
      /addressCounts=1,2,3,5,6,7,11,12,17\b/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    controls.push({
      name,
      ok: checks.length === expectedCompleteCheckCount &&
        failedIds.length === 0 && runtimeBoundaryCovered,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      runtimeBoundaryCovered,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    });
  }

  const functionDefaultParameterCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'function heldDefaultBodyVar(fn = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }) { ` +
      `var ${indexName} = 0; fn(); }`,
    'heldDefaultBodyVar();'
  );
  const objectDefaultParameterCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const heldDefaultObject = { bump(fn = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }) { ` +
      `var ${indexName} = 0; fn(); } };`,
    'heldDefaultObject.bump();'
  );
  const classDefaultParameterCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'class HeldDefaultClass { static bump(fn = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }) { ` +
      `var ${indexName} = 0; fn(); } }`,
    'HeldDefaultClass.bump();'
  );
  const invokedAliasCallbackCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round8CapturedCallback = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
      'const round8CapturedAlias = round8CapturedCallback; ' +
      'const round8InvokeCallback = (callback) => callback();',
    'round8InvokeCallback(round8CapturedAlias);'
  );
  const invokedArrayCallbackCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round8ArrayCallback = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; };`,
    '[0].forEach(round8ArrayCallback);'
  );
  const destructuredMethodAliasCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round8DestructuredHost = { advance() { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; } }; ` +
      'const { advance: round8DestructuredAdvance } = round8DestructuredHost;',
    'round8DestructuredAdvance();'
  );
  const invokedBoundAliasCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round8BoundCapture = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
      'const round8BoundAlias = round8BoundCapture.bind(null);',
    'round8BoundAlias();'
  );
  const invokedDestructuredParameterCallbackCapture = addPreLoopHelperCall(
    functionScopedVarSource,
    (indexName) => 'const round8PatternCallback = () => { ' +
      `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
      'const round8InvokePatternCallback = ({ callback }) => callback();',
    'round8InvokePatternCallback({ callback: round8PatternCallback });'
  );
  const mutationSources = [
    ['default-parameter-function-body-var-does-not-shadow',
      functionDefaultParameterCapture],
    ['default-parameter-object-method-body-var-does-not-shadow',
      objectDefaultParameterCapture],
    ['default-parameter-class-static-body-var-does-not-shadow',
      classDefaultParameterCapture],
    ['invoked-alias-parameter-callback-capture', invokedAliasCallbackCapture],
    ['invoked-array-callback-capture', invokedArrayCallbackCapture],
    ['invoked-destructured-method-alias-capture', destructuredMethodAliasCapture],
    ['invoked-bound-alias-capture', invokedBoundAliasCapture],
    ['invoked-destructured-parameter-callback-capture',
      invokedDestructuredParameterCallbackCapture]
  ];
  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const mutations = [];
  for (const [name, source] of mutationSources) {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const staticRejected = !!owner && /\bindexed=false\b/.test(owner.detail);
    const runtimeBoundaryGreen = !!owner &&
      /runtime-equivalent TURN leaf cases=7 passed=7 failed=none/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    mutations.push({
      name,
      ok: checks.length === expectedCompleteCheckCount &&
        exactFailures && staticRejected && runtimeBoundaryGreen,
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures,
      staticRejected,
      runtimeBoundaryGreen,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    });
  }
  return {
    ok: controls.length === 12 && controls.every((entry) => entry.ok) &&
      mutations.length === 8 && mutations.every((entry) => entry.ok),
    controls,
    mutations,
    detail: `controls=${controls.filter((entry) => entry.ok).length}/${controls.length} ` +
      `mutations=${mutations.filter((entry) => entry.ok).length}/${mutations.length} ` +
      `failures=${[
        ...controls.filter((entry) => !entry.ok),
        ...mutations.filter((entry) => !entry.ok)
      ].map((entry) => entry.name).join(',') || 'none'}`
  };
}

async function exerciseRound9LocalDispatchReachability(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  if (!canonicalIndexedSource) {
    return {
      ok: false,
      controls: [],
      mutations: [],
      heldouts: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const asFunctionScopedVarLoop = (source) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 9 could not find indexed loop declaration');
    const initializer = source.slice(loop.initStart, loop.initEnd);
    if (!/^let\b/.test(initializer)) {
      throw new Error('Round 9 indexed loop does not use a lexical declaration');
    }
    return source.slice(0, loop.initStart) + initializer.replace(/^let\b/, 'var') +
      source.slice(loop.initEnd);
  };
  const insertBeforeLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 9 could not find loop for pre-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopStart) + injected + '\n  ' + source.slice(loop.loopStart);
  };
  const insertAfterLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 9 could not find loop for post-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopEnd) + `\n  ${injected}` + source.slice(loop.loopEnd);
  };
  const insertAfterIndexedAddressRead = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error('Round 9 could not find indexed address read');
    }
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) + `\n    ${injected}` +
      source.slice(loop.indexedAddressReadStatementEnd);
  };
  const addPreLoopHelperCall = (source, declaration, call) => {
    let mutated = insertBeforeLoop(source, declaration);
    mutated = insertAfterIndexedAddressRead(mutated, call);
    return mutated;
  };
  const functionScopedVarSource = asFunctionScopedVarLoop(canonicalIndexedSource);

  const controlSources = [
    [
      'custom-object-map-does-not-invoke-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9IgnoredMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9InertMapHost = { map(_callback) {} };',
        'round9InertMapHost.map(round9IgnoredMapCallback);'
      )
    ],
    [
      'custom-object-reduce-does-not-invoke-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9IgnoredReduceCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9InertReduceHost = { reduce(_callback, initial) { return initial; } };',
        'round9InertReduceHost.reduce(round9IgnoredReduceCallback, 0);'
      )
    ],
    [
      'dynamic-apply-arguments-do-not-reach-unrelated-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9UnrelatedDynamicCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9DynamicApplyTarget = () => {};',
        'round9DynamicApplyTarget.apply(null, endpoint.round9ApplyArguments);'
      )
    ],
    [
      'literal-apply-callback-to-inert-dispatcher-is-green',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9InertApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9InertApplyDispatcher = (_callback) => {};',
        'round9InertApplyDispatcher.apply(null, [round9InertApplyCallback]);'
      )
    ],
    [
      'array-map-this-argument-is-not-a-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9MapThisValues = [0]; ' +
          'const round9MapThisCallback = (value) => value; ' +
          'const round9MapThisOnly = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round9MapThisValues.map(round9MapThisCallback, round9MapThisOnly);'
      )
    ],
    [
      'array-reduce-initial-value-is-not-a-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9ReduceInitialValues = [0]; ' +
          'const round9ReduceInitialCallback = (value) => value; ' +
          'const round9ReduceInitialOnly = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round9ReduceInitialValues.reduce(' +
          'round9ReduceInitialCallback, round9ReduceInitialOnly);'
      )
    ],
    [
      'shadowed-array-from-does-not-prove-standard-array-callbacks',
      insertAfterIndexedAddressRead(
        functionScopedVarSource,
        (indexName) => '{ const round9ShadowedArrayCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const Array = { from() { return { map(_callback) {} }; } }; ' +
          'const round9ShadowedArrayValues = Array.from([0]); ' +
          'round9ShadowedArrayValues.map(round9ShadowedArrayCallback); }'
      )
    ],
    [
      'overridden-local-array-method-does-not-imply-standard-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9OverriddenMapValues = [0]; ' +
          'const round9OverriddenMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'round9OverriddenMapValues.map = (_callback) => [];',
        'round9OverriddenMapValues.map(round9OverriddenMapCallback);'
      )
    ],
    [
      'array-method-overridden-through-alias-is-not-standard-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9AliasOverrideValues = [0]; ' +
          'const round9AliasOverride = round9AliasOverrideValues; ' +
          'const round9AliasOverrideCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'round9AliasOverride.map = (_callback) => [];',
        'round9AliasOverrideValues.map(round9AliasOverrideCallback);'
      )
    ],
    [
      'apply-argument-array-element-overwrite-invalidates-static-list',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9OverwrittenApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9OverwrittenApplyNoop = () => {}; ' +
          'const round9OverwrittenApplyDispatch = (callback) => callback(); ' +
          'const round9OverwrittenApplyArguments = [round9OverwrittenApplyCallback]; ' +
          'round9OverwrittenApplyArguments[0] = round9OverwrittenApplyNoop;',
        'round9OverwrittenApplyDispatch.apply(null, round9OverwrittenApplyArguments);'
      )
    ],
    [
      'unknown-parameter-is-not-proven-by-inner-block-array-shadow',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9BlockShadowCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9BlockShadowHost = { map(_callback) {} }; ' +
          'function round9InvokeBlockShadow(values) { ' +
          '{ const values = [0]; void values; } ' +
          'values.map(round9BlockShadowCallback); }',
        'round9InvokeBlockShadow(round9BlockShadowHost);'
      )
    ],
    [
      'unused-class-prototype-method-is-not-reachable',
      insertAfterIndexedAddressRead(
        functionScopedVarSource,
        (indexName) => 'class Round9UnusedPrototype { bump() { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; } }`
      )
    ],
    [
      'statically-unreachable-class-prototype-call-is-green',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'class Round9UnreachablePrototype { bump() { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; } }`,
        'if (false) Round9UnreachablePrototype.prototype.bump.call(null);'
      )
    ],
    [
      'post-loop-class-prototype-call-is-green',
      insertAfterLoop(
        insertBeforeLoop(
          functionScopedVarSource,
          (indexName) => 'class Round9PostLoopPrototype { bump() { ' +
            `if (endpoint.addresses.length > 17) ${indexName}++; } } ` +
            'const round9PostLoopMethod = Round9PostLoopPrototype.prototype.bump; ' +
            'const round9PostLoopBound = round9PostLoopMethod.bind(null);'
        ),
        'round9PostLoopBound();'
      )
    ]
  ];

  const mutationSources = [
    [
      'callback-through-literal-apply-dispatch',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9ApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9ApplyDispatch = (callback) => callback();',
        'round9ApplyDispatch.apply(null, [round9ApplyCallback]);'
      )
    ],
    [
      'local-array-map-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9MapValues = [0]; ' +
          'const round9MapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round9MapValues.map(round9MapCallback);'
      )
    ],
    [
      'local-array-reduce-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9ReduceValues = [0]; ' +
          'const round9ReduceCallback = (value) => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; return value; };`,
        'round9ReduceValues.reduce(round9ReduceCallback, 0);'
      )
    ],
    [
      'class-prototype-method-extracted-bound-and-called',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'class Round9PrototypeHost { bump() { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; } } ` +
          'const round9PrototypeMethod = Round9PrototypeHost.prototype.bump; ' +
          'const round9PrototypeBound = round9PrototypeMethod.bind(null);',
        'round9PrototypeBound();'
      )
    ]
  ];

  const heldoutSources = [
    [
      'apply-arguments-local-array-through-two-aliases',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9AliasedApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9AliasedApplyDispatch = (callback) => callback(); ' +
          'let round9ApplyArguments; round9ApplyArguments = [round9AliasedApplyCallback]; ' +
          'const round9ApplyArgumentsAliasOne = round9ApplyArguments; ' +
          'const round9ApplyArgumentsAliasTwo = round9ApplyArgumentsAliasOne;',
        'round9AliasedApplyDispatch.apply(null, round9ApplyArgumentsAliasTwo);'
      )
    ],
    [
      'array-from-receiver-and-callback-through-two-aliases',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round9ArrayFromValues = Array.from([0]); ' +
          'const round9ArrayAliasOne = round9ArrayFromValues; ' +
          'const round9ArrayAliasTwo = round9ArrayAliasOne; ' +
          'const round9AliasedArrayCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round9ArrayCallbackAliasOne = round9AliasedArrayCallback; ' +
          'const round9ArrayCallbackAliasTwo = round9ArrayCallbackAliasOne;',
        'round9ArrayAliasTwo.forEach(round9ArrayCallbackAliasTwo);'
      )
    ],
    [
      'class-prototype-method-two-aliases-call-dispatch',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'class Round9CallPrototype { bump() { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; } } ` +
          'const round9CallMethod = Round9CallPrototype.prototype.bump; ' +
          'const round9CallAliasOne = round9CallMethod; ' +
          'const round9CallAliasTwo = round9CallAliasOne;',
        'round9CallAliasTwo.call(null);'
      )
    ],
    [
      'class-prototype-method-two-aliases-apply-dispatch',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'class Round9ApplyPrototype { bump() { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; } } ` +
          'const round9ApplyMethod = Round9ApplyPrototype.prototype.bump; ' +
          'const round9PrototypeAliasOne = round9ApplyMethod; ' +
          'const round9PrototypeAliasTwo = round9PrototypeAliasOne;',
        'round9PrototypeAliasTwo.apply(null, []);'
      )
    ]
  ];

  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const evaluate = async (name, source, expectedGreen) => {
    const checks = await evaluateCompleteChecks(source);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const staticRejected = !!owner && /\bindexed=false\b/.test(owner.detail);
    const runtimeBoundaryGreen = !!owner &&
      /runtime-equivalent TURN leaf cases=7 passed=7 failed=none/.test(owner.detail) &&
      /addressCounts=1,2,3,5,6,7,11,12,17\b/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    return {
      name,
      ok: checks.length === expectedCompleteCheckCount && runtimeBoundaryGreen && (expectedGreen
        ? failedIds.length === 0 && !staticRejected
        : exactFailures && staticRejected),
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures: expectedGreen ? [] : expectedFailures,
      staticRejected,
      runtimeBoundaryGreen,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    };
  };

  const controls = [];
  for (const [name, source] of controlSources) {
    controls.push(await evaluate(name, source, true));
  }
  const mutations = [];
  for (const [name, source] of mutationSources) {
    mutations.push(await evaluate(name, source, false));
  }
  const heldouts = [];
  for (const [name, source] of heldoutSources) {
    heldouts.push(await evaluate(name, source, false));
  }
  const failures = [...controls, ...mutations, ...heldouts].filter((entry) => !entry.ok);
  return {
    ok: controls.length === 14 && controls.every((entry) => entry.ok) &&
      mutations.length === 4 && mutations.every((entry) => entry.ok) &&
      heldouts.length === 4 && heldouts.every((entry) => entry.ok),
    controls,
    mutations,
    heldouts,
    detail: `controls=${controls.filter((entry) => entry.ok).length}/${controls.length} ` +
      `mutations=${mutations.filter((entry) => entry.ok).length}/${mutations.length} ` +
      `heldouts=${heldouts.filter((entry) => entry.ok).length}/${heldouts.length} ` +
      `failures=${failures.map((entry) => entry.name).join(',') || 'none'}`
  };
}

async function exerciseRound10OrderedLocalDispatchReachability(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  if (!canonicalIndexedSource) {
    return {
      ok: false,
      controls: [],
      mutations: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const asFunctionScopedVarLoop = (source) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 10 could not find indexed loop declaration');
    const initializer = source.slice(loop.initStart, loop.initEnd);
    if (!/^let\b/.test(initializer)) {
      throw new Error('Round 10 indexed loop does not use a lexical declaration');
    }
    return source.slice(0, loop.initStart) + initializer.replace(/^let\b/, 'var') +
      source.slice(loop.initEnd);
  };
  const insertBeforeLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 10 could not find loop for pre-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopStart) + injected + '\n  ' + source.slice(loop.loopStart);
  };
  const insertAfterIndexedAddressRead = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error('Round 10 could not find indexed address read');
    }
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) + `\n    ${injected}` +
      source.slice(loop.indexedAddressReadStatementEnd);
  };
  const addPreLoopHelperCall = (source, declaration, call) => {
    let mutated = insertBeforeLoop(source, declaration);
    mutated = insertAfterIndexedAddressRead(mutated, call);
    return mutated;
  };
  const functionScopedVarSource = asFunctionScopedVarLoop(canonicalIndexedSource);

  const controlSources = [
    [
      'custom-object-map-through-alias-remains-inert',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10InertObjectCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round10InertObjectHost = { map(_callback) {} }; ' +
          'const round10InertObjectAlias = round10InertObjectHost;',
        'round10InertObjectAlias.map(round10InertObjectCallback);'
      ),
      Array.from({ length: 18 }, (_, index) => index)
    ],
    [
      'array-map-alias-override-before-call-remains-inert',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10PriorMapValues = [0]; ' +
          'const round10PriorMapAlias = round10PriorMapValues; ' +
          'const round10PriorMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round10PriorMapAlias.map = (_callback) => []; ' +
          'round10PriorMapValues.map(round10PriorMapCallback);'
      ),
      Array.from({ length: 18 }, (_, index) => index)
    ],
    [
      'apply-argument-overwrite-before-call-remains-inert',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10PriorApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round10PriorApplyNoop = () => {}; ' +
          'const round10PriorApplyDispatch = (callback) => callback(); ' +
          'const round10PriorApplyArguments = [round10PriorApplyCallback]; ' +
          'const round10PriorApplyAlias = round10PriorApplyArguments;',
        'round10PriorApplyAlias[0] = round10PriorApplyNoop; ' +
          'round10PriorApplyDispatch.apply(null, round10PriorApplyArguments);'
      ),
      Array.from({ length: 18 }, (_, index) => index)
    ],
    [
      'literal-splice-replaces-apply-callback-before-call',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10SplicedApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round10SplicedApplyNoop = () => {}; ' +
          'const round10SplicedApplyDispatch = (callback) => callback(); ' +
          'const round10SplicedApplyArguments = [round10SplicedApplyCallback]; ' +
          'round10SplicedApplyArguments.splice(0, 1, round10SplicedApplyNoop);',
        'round10SplicedApplyDispatch.apply(null, round10SplicedApplyArguments);'
      ),
      Array.from({ length: 18 }, (_, index) => index)
    ]
  ];

  const evenVisits = Array.from({ length: 9 }, (_, index) => index * 2);
  const firstSkipVisits = [0, ...Array.from({ length: 16 }, (_, index) => index + 2)];
  const mutationSources = [
    [
      'custom-object-map-through-receiver-alias-invokes-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10ObjectCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round10ObjectHost = { map(callback) { callback(); } }; ' +
          'const round10ObjectAlias = round10ObjectHost;',
        'round10ObjectAlias.map(round10ObjectCallback);'
      ),
      evenVisits
    ],
    [
      'native-map-call-precedes-later-alias-override',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10LaterMapValues = [0]; ' +
          'const round10LaterMapAlias = round10LaterMapValues; ' +
          'const round10LaterMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round10LaterMapValues.map(round10LaterMapCallback); ' +
          'round10LaterMapAlias.map = (_callback) => [];'
      ),
      firstSkipVisits
    ],
    [
      'apply-call-precedes-later-aliased-element-overwrite',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10LaterApplyCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round10LaterApplyNoop = () => {}; ' +
          'const round10LaterApplyDispatch = (callback) => callback(); ' +
          'const round10LaterApplyArguments = [round10LaterApplyCallback]; ' +
          'const round10LaterApplyAlias = round10LaterApplyArguments;',
        'round10LaterApplyDispatch.apply(null, round10LaterApplyArguments); ' +
          'round10LaterApplyAlias[0] = round10LaterApplyNoop;'
      ),
      firstSkipVisits
    ],
    [
      'array-map-override-through-receiver-alias-invokes-callback',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10OverrideMapValues = [0]; ' +
          'const round10OverrideMapAlias = round10OverrideMapValues; ' +
          'const round10OverrideMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'round10OverrideMapAlias.map = (callback) => callback();',
        'round10OverrideMapValues.map(round10OverrideMapCallback);'
      ),
      evenVisits
    ],
    [
      'extracted-native-map-alias-called-with-call',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10ExtractedMapValues = [0]; ' +
          'const round10ExtractedMap = Array.prototype.map; ' +
          'const round10ExtractedMapCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; };`,
        'round10ExtractedMap.call(' +
          'round10ExtractedMapValues, round10ExtractedMapCallback);'
      ),
      evenVisits
    ],
    [
      'extracted-native-reduce-alias-called-with-call',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round10ExtractedReduceValues = [0]; ' +
          'const round10ExtractedReduce = Array.prototype.reduce; ' +
          'const round10ExtractedReduceCallback = (accumulator) => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; return accumulator; };`,
        'round10ExtractedReduce.call(' +
          'round10ExtractedReduceValues, round10ExtractedReduceCallback, 0);'
      ),
      evenVisits
    ]
  ];

  const runtimeVisitation = async (source, expectedVisits) => {
    try {
      const parsed = parseTargetJavaScript(source);
      if (!parsed.ok) throw new Error(`parser failed: ${parsed.error}`);
      const declaration = sourceForTopLevelFunction(
        source,
        parsed.ast,
        'probeSelectedTurnEndpoint'
      );
      if (!declaration) throw new Error('missing unique probeSelectedTurnEndpoint');
      const dependencies = {
        TURN_ENDPOINT_PROBE_ATTEMPTS: 2,
        browserTurnServer: (endpoint) => ({ urls: endpoint.urls }),
        probeBrowserTurn: async () => ({ candidates: [], errors: [] }),
        summarizeTurnBrowserProbe: () => ({ ok: true, errors: [] }),
        turnUrlForAddress: (_parsed, address) => `turn:${address}:3478`,
        probeTurnSocketAddress: async () => ({ ok: true, error: '' })
      };
      const names = Object.keys(dependencies);
      const probe = Function(
        ...names,
        `'use strict'; ${declaration}; return probeSelectedTurnEndpoint;`
      )(...names.map((name) => dependencies[name]));
      const addresses = Array.from({ length: 18 }, (_, index) =>
        `round10-address-${index}`);
      const result = await probe({}, {
        urls: 'turn:round10.example.test:3478',
        username: 'round10-user',
        credential: 'round10-secret',
        locale: 'round10',
        udp: true,
        addresses,
        dnsErrors: [],
        parsed: { scheme: 'turn', hostname: 'round10.example.test', port: 3478 }
      });
      const visits = result.addressAttempts
        .filter((attempt) => attempt.attempt === 1)
        .map((attempt) => addresses.indexOf(attempt.address));
      const eachVisitHasTwoAttempts = visits.every((addressIndex) =>
        result.addressAttempts.filter((attempt) =>
          attempt.address === addresses[addressIndex]).length === 2);
      const exact = JSON.stringify(visits) === JSON.stringify(expectedVisits);
      return {
        ok: exact && eachVisitHasTwoAttempts,
        visits,
        expectedVisits,
        complete: visits.length === addresses.length,
        detail: `visits=${visits.length}/18 indices=${visits.join(',')} ` +
          `expected=${expectedVisits.join(',')} twice=${eachVisitHasTwoAttempts}`
      };
    } catch (error) {
      return {
        ok: false,
        visits: [],
        expectedVisits,
        complete: false,
        detail: String(error && error.message ? error.message : error)
      };
    }
  };

  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const evaluate = async (name, source, expectedGreen, expectedVisits) => {
    const [checks, runtime] = await Promise.all([
      evaluateCompleteChecks(source),
      runtimeVisitation(source, expectedVisits)
    ]);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const staticRejected = !!owner && /\bindexed=false\b/.test(owner.detail);
    const runtimeBoundaryGreen = !!owner &&
      /runtime-equivalent TURN leaf cases=7 passed=7 failed=none/.test(owner.detail) &&
      /addressCounts=1,2,3,5,6,7,11,12,17\b/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    return {
      name,
      ok: checks.length === expectedCompleteCheckCount && runtime.ok && runtimeBoundaryGreen &&
        (expectedGreen
          ? failedIds.length === 0 && !staticRejected && runtime.complete
          : exactFailures && staticRejected && !runtime.complete),
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures: expectedGreen ? [] : expectedFailures,
      staticRejected,
      runtimeBoundaryGreen,
      runtime,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    };
  };

  const controls = [];
  for (const [name, source, expectedVisits] of controlSources) {
    controls.push(await evaluate(name, source, true, expectedVisits));
  }
  const mutations = [];
  for (const [name, source, expectedVisits] of mutationSources) {
    mutations.push(await evaluate(name, source, false, expectedVisits));
  }
  const failures = [...controls, ...mutations].filter((entry) => !entry.ok);
  return {
    ok: controls.length === 4 && controls.every((entry) => entry.ok) &&
      mutations.length === 6 && mutations.every((entry) => entry.ok),
    controls,
    mutations,
    detail: `controls=${controls.filter((entry) => entry.ok).length}/${controls.length} ` +
      `mutations=${mutations.filter((entry) => entry.ok).length}/${mutations.length} ` +
      `failures=${failures.map((entry) => entry.name).join(',') || 'none'}`
  };
}

async function exerciseRound11BoundNativeArrayDispatch(greenSource) {
  const indexedVariant = buildTurnEquivalentVariants(greenSource).find((entry) =>
    entry.name === 'indexed-resolved-address-iteration');
  const canonicalIndexedSource = indexedVariant
    ? canonicalUnitIndexedAddressSource(indexedVariant.source)
    : null;
  if (!canonicalIndexedSource) {
    return {
      ok: false,
      controls: [],
      mutations: [],
      detail: 'canonical indexed equivalent source was not constructed'
    };
  }

  const asFunctionScopedVarLoop = (source) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 11 could not find indexed loop declaration');
    const initializer = source.slice(loop.initStart, loop.initEnd);
    if (!/^let\b/.test(initializer)) {
      throw new Error('Round 11 indexed loop does not use a lexical declaration');
    }
    return source.slice(0, loop.initStart) + initializer.replace(/^let\b/, 'var') +
      source.slice(loop.initEnd);
  };
  const insertBeforeLoop = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop) throw new Error('Round 11 could not find loop for pre-loop statement');
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.loopStart) + injected + '\n  ' + source.slice(loop.loopStart);
  };
  const insertAfterIndexedAddressRead = (source, statement) => {
    const loop = indexedAddressLoopDescriptor(source);
    if (!loop || loop.indexedAddressReadStatementEnd === null) {
      throw new Error('Round 11 could not find indexed address read');
    }
    const injected = typeof statement === 'function' ? statement(loop.indexName) : statement;
    return source.slice(0, loop.indexedAddressReadStatementEnd) + `\n    ${injected}` +
      source.slice(loop.indexedAddressReadStatementEnd);
  };
  const addPreLoopHelperCall = (source, declaration, call) => {
    let mutated = insertBeforeLoop(source, declaration);
    mutated = insertAfterIndexedAddressRead(mutated, call);
    return mutated;
  };
  const functionScopedVarSource = asFunctionScopedVarLoop(canonicalIndexedSource);
  const completeVisits = Array.from({ length: 18 }, (_, index) => index);
  const evenVisits = Array.from({ length: 9 }, (_, index) => index * 2);

  const controls = [
    [
      'custom-function-bound-to-local-array-remains-inert',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round11CustomBoundCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round11CustomInertFunction = (_callback) => {}; ' +
          'const round11CustomFunctionAlias = round11CustomInertFunction; ' +
          'const round11CustomBound = round11CustomFunctionAlias.bind([0]); ' +
          'const round11CustomBoundAlias = round11CustomBound;',
        'round11CustomBoundAlias(round11CustomBoundCallback);'
      ),
      completeVisits
    ],
    [
      'native-for-each-bound-to-non-array-length-zero-receiver',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round11NonArrayCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round11NonArrayNative = Array.prototype.forEach; ' +
          'const round11NonArrayAliasOne = round11NonArrayNative; ' +
          'const round11NonArrayAliasTwo = round11NonArrayAliasOne; ' +
          'const round11NonArrayBound = round11NonArrayAliasTwo.bind({ length: 0 }); ' +
          'const round11NonArrayBoundAlias = round11NonArrayBound;',
        'round11NonArrayBoundAlias(round11NonArrayCallback);'
      ),
      completeVisits
    ],
    [
      'unused-bound-native-for-each-does-not-reach-callback',
      insertBeforeLoop(
        functionScopedVarSource,
        (indexName) => 'const round11UnusedBoundCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round11UnusedNative = Array.prototype.forEach; ' +
          'const round11UnusedAliasOne = round11UnusedNative; ' +
          'const round11UnusedAliasTwo = round11UnusedAliasOne; ' +
          'const round11UnusedBound = round11UnusedAliasTwo.bind([0]); ' +
          'const round11UnusedBoundAlias = round11UnusedBound; ' +
          'void round11UnusedBoundAlias; void round11UnusedBoundCallback;'
      ),
      completeVisits
    ]
  ];
  const mutations = [
    [
      'two-hop-native-for-each-bound-to-array-and-called-through-alias',
      addPreLoopHelperCall(
        functionScopedVarSource,
        (indexName) => 'const round11BoundNativeCallback = () => { ' +
          `if (endpoint.addresses.length > 17) ${indexName}++; }; ` +
          'const round11NativeForEach = Array.prototype.forEach; ' +
          'const round11NativeAliasOne = round11NativeForEach; ' +
          'const round11NativeAliasTwo = round11NativeAliasOne; ' +
          'const round11BoundNative = round11NativeAliasTwo.bind([0]); ' +
          'const round11BoundNativeAlias = round11BoundNative;',
        'round11BoundNativeAlias(round11BoundNativeCallback);'
      ),
      evenVisits
    ]
  ];

  const runtimeVisitation = async (source, expectedVisits) => {
    try {
      const parsed = parseTargetJavaScript(source);
      if (!parsed.ok) throw new Error(`parser failed: ${parsed.error}`);
      const declaration = sourceForTopLevelFunction(
        source,
        parsed.ast,
        'probeSelectedTurnEndpoint'
      );
      if (!declaration) throw new Error('missing unique probeSelectedTurnEndpoint');
      const dependencies = {
        TURN_ENDPOINT_PROBE_ATTEMPTS: 2,
        browserTurnServer: (endpoint) => ({ urls: endpoint.urls }),
        probeBrowserTurn: async () => ({ candidates: [], errors: [] }),
        summarizeTurnBrowserProbe: () => ({ ok: true, errors: [] }),
        turnUrlForAddress: (_parsed, address) => `turn:${address}:3478`,
        probeTurnSocketAddress: async () => ({ ok: true, error: '' })
      };
      const names = Object.keys(dependencies);
      const probe = Function(
        ...names,
        `'use strict'; ${declaration}; return probeSelectedTurnEndpoint;`
      )(...names.map((name) => dependencies[name]));
      const addresses = Array.from({ length: 18 }, (_, index) =>
        `round11-address-${index}`);
      const result = await probe({}, {
        urls: 'turn:round11.example.test:3478',
        username: 'round11-user',
        credential: 'round11-secret',
        locale: 'round11',
        udp: true,
        addresses,
        dnsErrors: [],
        parsed: { scheme: 'turn', hostname: 'round11.example.test', port: 3478 }
      });
      const visits = result.addressAttempts
        .filter((attempt) => attempt.attempt === 1)
        .map((attempt) => addresses.indexOf(attempt.address));
      const eachVisitHasTwoAttempts = visits.every((addressIndex) =>
        result.addressAttempts.filter((attempt) =>
          attempt.address === addresses[addressIndex]).length === 2);
      const exact = JSON.stringify(visits) === JSON.stringify(expectedVisits);
      return {
        ok: exact && eachVisitHasTwoAttempts,
        visits,
        expectedVisits,
        complete: visits.length === addresses.length,
        detail: `visits=${visits.length}/18 indices=${visits.join(',')} ` +
          `expected=${expectedVisits.join(',')} twice=${eachVisitHasTwoAttempts}`
      };
    } catch (error) {
      return {
        ok: false,
        visits: [],
        expectedVisits,
        complete: false,
        detail: String(error && error.message ? error.message : error)
      };
    }
  };

  const expectedFailures = ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'];
  const evaluate = async (name, source, expectedGreen, expectedVisits) => {
    const [checks, runtime] = await Promise.all([
      evaluateCompleteChecks(source),
      runtimeVisitation(source, expectedVisits)
    ]);
    const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
    const owner = checks.find((check) =>
      check.id === 'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED');
    const exactFailures = JSON.stringify([...failedIds].sort()) ===
      JSON.stringify([...expectedFailures].sort());
    const staticRejected = !!owner && /\bindexed=false\b/.test(owner.detail);
    const runtimeBoundaryGreen = !!owner &&
      /runtime-equivalent TURN leaf cases=7 passed=7 failed=none/.test(owner.detail) &&
      /addressCounts=1,2,3,5,6,7,11,12,17\b/.test(owner.detail) &&
      /12:24/.test(owner.detail) && /17:34/.test(owner.detail);
    return {
      name,
      ok: checks.length === expectedCompleteCheckCount && runtime.ok && runtimeBoundaryGreen &&
        (expectedGreen
          ? failedIds.length === 0 && !staticRejected && runtime.complete
          : exactFailures && staticRejected && !runtime.complete),
      checkCount: checks.length,
      passedCount: checks.length - failedIds.length,
      failedIds,
      expectedFailures: expectedGreen ? [] : expectedFailures,
      staticRejected,
      runtimeBoundaryGreen,
      runtime,
      sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      detail: owner ? owner.detail : 'missing EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
    };
  };

  const evaluatedControls = [];
  for (const [name, source, expectedVisits] of controls) {
    evaluatedControls.push(await evaluate(name, source, true, expectedVisits));
  }
  const evaluatedMutations = [];
  for (const [name, source, expectedVisits] of mutations) {
    evaluatedMutations.push(await evaluate(name, source, false, expectedVisits));
  }
  const failures = [...evaluatedControls, ...evaluatedMutations]
    .filter((entry) => !entry.ok);
  return {
    ok: evaluatedControls.length === 3 && evaluatedControls.every((entry) => entry.ok) &&
      evaluatedMutations.length === 1 && evaluatedMutations.every((entry) => entry.ok),
    controls: evaluatedControls,
    mutations: evaluatedMutations,
    detail: `controls=${evaluatedControls.filter((entry) => entry.ok).length}/` +
      `${evaluatedControls.length} mutations=` +
      `${evaluatedMutations.filter((entry) => entry.ok).length}/` +
      `${evaluatedMutations.length} failures=` +
      `${failures.map((entry) => entry.name).join(',') || 'none'}`
  };
}

function buildReviewerTurnMutations(greenSource) {
  const mutations = [];
  const add = (name, expectedFailures, source, runtimeKind, runtimeCase) => {
    mutations.push({
      name,
      expectedFailures: Array.isArray(expectedFailures)
        ? expectedFailures
        : [expectedFailures],
      source,
      runtimeKind,
      runtimeCase
    });
  };
  add(
    'non-fixture-usernames-collapse-flattened-endpoints',
    turnRegistryPolicyIds[4],
    mutateFunctionBodyOnce(
      greenSource,
      'flattenValidatedTurnRegistryEndpoints',
      /^/,
      "\n  if (registry.servers.some((server) => " +
        "!server.username.startsWith('fixture-'))) return [];\n",
      'reviewer-non-fixture-flatten-empty'
    ),
    'registry',
    'flatten'
  );
  add(
    'non-fixture-ice-config-strips-credentials',
    turnRegistryPolicyIds[4],
    mutateFunctionBodyOnce(
      greenSource,
      'turnRegistryIceServers',
      /^/,
      "\n  if (response.servers.some((server) => " +
        "!server.username.startsWith('fixture-'))) {\n" +
        '    return response.servers.map((server) => ({\n' +
        "      urls: server.urls, username: '', credential: '', udp: server.udp\n" +
        '    }));\n' +
        '  }\n',
      'reviewer-non-fixture-ice-strips-credentials'
    ),
    'registry',
    'ice'
  );
  add(
    'non-fixture-canonical-config-collapses-to-empty-array',
    turnRegistryPolicyIds[17],
    mutateFunctionBodyOnce(
      greenSource,
      'canonicalTurnRegistryResponseV1',
      /^/,
      "\n  if (servers.some((server) => !server.username.startsWith('fixture-'))) {\n" +
        "    return TURN_REGISTRY_CONFIG_V1_PREFIX + '\\n[]';\n" +
        '  }\n',
      'reviewer-non-fixture-canonical-empty'
    ),
    'registry',
    'canonicalHash'
  );
  add(
    'provenance-matcher-accepts-first-ambiguous-or-out-of-window-response',
    turnRegistryPolicyIds[15],
    mutateFunctionBodyOnce(
      greenSource,
      'matchPackagedTurnResponse',
      /^/,
      "\n  if (!transactionId.startsWith('fixture-')) return responses[0] || null;\n",
      'reviewer-provenance-first-response'
    ),
    'registry',
    'match'
  );
  add(
    'non-fixture-redactor-leaks-credentials-and-raw-response',
    turnRegistryPolicyIds[18],
    mutateFunctionBodyOnce(
      greenSource,
      'redactTurnSecrets',
      /^/,
      "\n  if (servers.some((server) => !server.username.startsWith('fixture-'))) " +
        'return String(value);\n',
      'reviewer-non-fixture-redaction-leak'
    ),
    'registry',
    'redaction'
  );

  const fetchParsed = parseTargetJavaScript(greenSource);
  const fetchNode = uniqueTopLevelFunctionNode(
    fetchParsed.ast,
    'fetchValidatedTurnRegistryResponse'
  );
  if (!fetchNode) throw new Error('reviewer fetch mutation could not find declaration');
  const fetchInner = greenSource.slice(fetchNode.body.start + 1, fetchNode.body.end - 1);
  const fetchWithFallback = greenSource.slice(0, fetchNode.body.start) +
    `{\n  try {${fetchInner}\n  } catch (error) {\n` +
    '    return {\n' +
    '      version: 1,\n' +
    '      servers: [{\n' +
    "        urls: 'turn:hardcoded.example.net:3478',\n" +
    "        username: 'hardcoded-user',\n" +
    "        credential: 'hardcoded-secret',\n" +
    '        udp: true\n' +
    '      }],\n' +
    "      rawResponse: '{hardcoded:true}'\n" +
    '    };\n' +
    '  }\n}' + greenSource.slice(fetchNode.body.end);
  add(
    'fetch-rejection-injects-hardcoded-turn-response',
    [turnRegistryPolicyIds[3], turnRegistryPolicyIds[12]],
    fetchWithFallback,
    'failure',
    'registry-fetch-rejection-is-not-replaced'
  );
  add(
    'relay-scenario-swallows-ensure-turn-rejection',
    turnRegistryPolicyIds[12],
    mutateFunctionBodyOnce(
      greenSource,
      'runRelayIceScenario',
      /await\s+ensureTurnFixture\(config,\s*browser,\s*report,\s*turnFixture\)\s*;/,
      'await ensureTurnFixture(config, browser, report, turnFixture).catch(() => {});',
      'reviewer-relay-swallows-ensure-rejection'
    ),
    'failure',
    'relay-scenario-propagates-dead-endpoint'
  );
  add(
    'turn-health-allows-environment-dead-endpoint-bypass',
    turnRegistryPolicyIds[8],
    mutateFunctionBodyOnce(
      greenSource,
      'ensureTurnFixture',
      /everyOriginalHostnameAttemptAllocated\s*&&\s*everyResolvedAddressPassed\s*&&\s*rtcConfigRetainsOriginalHostnames/,
      '(everyOriginalHostnameAttemptAllocated && everyResolvedAddressPassed && ' +
        'rtcConfigRetainsOriginalHostnames) || process.env.ALLOW_DEAD_TURN',
      'reviewer-health-environment-bypass'
    ),
    'failure',
    'dead-endpoint-health-rejection-is-preserved'
  );
  add(
    'real-browser-page-receives-fabricated-relay-observation',
    turnRegistryPolicyIds[6],
    mutateFunctionBodyOnce(
      greenSource,
      'probeBrowserTurn',
      /^/,
      "\n  if (typeof page.url === 'function') {\n" +
        "    return { candidates: [{ candidate: 'candidate:forged typ relay' }], errors: [] };\n" +
        '  }\n',
      'reviewer-real-browser-fabrication'
    ),
    'leaf',
    'browser-probe-delegates-to-page-evaluate'
  );
  add(
    'failed-non-test-attempts-are-rewritten-successful',
    turnRegistryPolicyIds[8],
    mutateFunctionBodyOnce(
      greenSource,
      'probeSelectedTurnEndpoint',
      /\n\s*return\s*\{\s*url:\s*endpoint\.urls/,
      "\n  for (const attempt of hostnameAttempts) {\n" +
        '    if (!attempt.test) attempt.ok = true;\n' +
        '  }\n' +
        '  for (const attempt of addressAttempts) {\n' +
        '    if (!attempt.test) attempt.ok = true;\n' +
        '  }\n\n  return {\n    url: endpoint.urls',
      'reviewer-failed-attempts-rewritten-successful'
    ),
    'leaf',
    'failed-network-attempts-remain-failed-without-test-markers'
  );
  add(
    'real-dns-results-truncated-after-fixture-hostname-check',
    turnRegistryPolicyIds[9],
    mutateFunctionBodyOnce(
      greenSource,
      'resolveTurnEndpointAddresses',
      /(const\s+addresses\s*=\s*\[\.\.\.new\s+Set\([\s\S]*?\)\]\s*;)/,
      "$1\n  if (!parsed.hostname.endsWith('.test')) addresses.splice(1);",
      'reviewer-real-dns-truncation'
    ),
    'leaf',
    'resolver-collects-complete-deduplicated-a-and-aaaa'
  );
  add(
    'real-turns-endpoint-uses-plaintext-net-connect',
    turnRegistryPolicyIds[11],
    mutateFunctionBodyOnce(
      greenSource,
      'probeTurnSocketAddress',
      /if\s*\(parsed\.scheme\s*===\s*['"]turns['"]\)\s*\{/,
      "if (parsed.scheme === 'turns' && !parsed.hostname.endsWith('.test')) {\n" +
        '        socket = net.connect({ host: address, port: parsed.port });\n' +
        "        socket.once('connect', () => finish(true));\n" +
        "      } else if (parsed.scheme === 'turns') {",
      'reviewer-real-turns-plaintext-connect'
    ),
    'leaf',
    'socket-probe-performs-tcp-and-tls-connects'
  );
  add(
    'expected-consumed-provenance-is-rewritten-from-observed-values',
    turnRegistryPolicyIds[16],
    mutateFunctionBodyOnce(
      greenSource,
      'runRelayIceScenario',
      /(\n\s*addCheck\(report,\s*['"]packaged-turn-consumed-config-matches-fetched-response['"])/,
      '\n  if (matchedTurnResponse) {\n' +
        '    matchedTurnResponse.transactionId = observedConsumedTransactionId;\n' +
        '    matchedTurnResponse.responseSha256 = observedConsumedResponseSha256;\n' +
        '    matchedTurnResponse.configSha256 = observedConsumedTurnSha256;\n' +
        '    matchedTurnResponse.servers.length = observedConsumedTurnCount;\n' +
        '  }$1',
      'reviewer-consumed-provenance-rewrite'
    ),
    'failure',
    'consumed-provenance-mismatch-remains-red'
  );
  return mutations;
}

async function exerciseReviewerTurnMutations(greenSource) {
  const cases = [];
  for (const mutation of buildReviewerTurnMutations(greenSource)) {
    const staticResult = exactSourceMutation(
      mutation.source,
      mutation.name,
      mutation.expectedFailures
    );
    let runtimeEntry = null;
    if (mutation.runtimeKind === 'registry') {
      const contract = exerciseTurnRegistryReferenceContract(mutation.source);
      const behavior = contract.behavior[mutation.runtimeCase];
      runtimeEntry = {
        ok: !!behavior && behavior.ok === false,
        detail: behavior ? behavior.detail : 'missing randomized registry behavior'
      };
    } else if (mutation.runtimeKind === 'leaf') {
      const contract = await exerciseTurnLeafOperationContracts(mutation.source);
      const entry = contract.cases.find((candidate) =>
        candidate.name === mutation.runtimeCase);
      runtimeEntry = {
        ok: !!entry && entry.ok === false,
        detail: entry ? entry.error : 'missing randomized leaf behavior'
      };
    } else {
      const contract = await exerciseTurnRuntimeFailureContracts(mutation.source);
      const entry = contract.cases.find((candidate) =>
        candidate.name === mutation.runtimeCase);
      runtimeEntry = {
        ok: !!entry && entry.ok === false,
        detail: entry ? entry.detail : 'missing runtime failing-path behavior'
      };
    }
    cases.push({
      ...staticResult,
      runtimeProof: runtimeEntry,
      rejected: staticResult.rejected && runtimeEntry.ok
    });
  }
  return {
    ok: cases.length === 13 && cases.every((entry) => entry.rejected),
    cases,
    detail: `reviewer mutations=${cases.filter((entry) => entry.rejected).length}/` +
      `${cases.length} survivors=${cases.filter((entry) => !entry.rejected)
        .map((entry) => `${entry.name}:static=${entry.introducedFailureIds.join('|') ||
          'none'}:runtime=${entry.runtimeProof.detail}`).join(',') || 'none'}`
  };
}

async function exerciseRound3MultiEndpointHealthBypass(greenSource) {
  const mutated = mutateFunctionBodyOnce(
    greenSource,
    'ensureTurnFixture',
    /everyOriginalHostnameAttemptAllocated\s*&&\s*everyResolvedAddressPassed\s*&&\s*rtcConfigRetainsOriginalHostnames/,
    '(everyOriginalHostnameAttemptAllocated && everyResolvedAddressPassed && ' +
      'rtcConfigRetainsOriginalHostnames) || fetchedEndpoints.length > 1',
    'round3-two-endpoint-health-or-bypass'
  );
  const staticResult = exactSourceMutation(
    mutated,
    'two-or-more-fetched-endpoints-bypass-all-dead-health',
    ['TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT']
  );
  const runtime = await exerciseTurnRuntimeFailureContracts(mutated);
  const requiredRuntimeCases = [
    'dead-endpoint-health-rejection-is-preserved',
    'relay-scenario-propagates-dead-endpoint'
  ];
  const runtimeCases = requiredRuntimeCases.map((name) =>
    runtime.cases.find((entry) => entry.name === name));
  const runtimeRejected = runtimeCases.every((entry) => entry && entry.ok === false &&
    /all-dead:resolved instead of rejecting/.test(entry.detail) &&
    /mixed-healthy-dead:resolved instead of rejecting/.test(entry.detail));
  return {
    ok: staticResult.rejected && runtimeRejected,
    staticResult,
    runtime,
    runtimeRejected,
    detail: `static=${staticResult.rejected} introduced=` +
      `${staticResult.introducedFailureIds.join(',') || 'none'} ` +
      `runtimeRejected=${runtimeRejected} ` + runtimeCases.map((entry, index) =>
        `${requiredRuntimeCases[index]}:${entry ? entry.detail : 'missing'}`).join(' | ')
  };
}

function silentGreenRegressionMutations(source) {
  const append = (text) => source.trimEnd() + '\n\n' + text.trim() + '\n';
  const beforeRunInvocation = (text) => {
    const invocationPattern = /\nrun\(\)\.catch\(\(error\)\s*=>\s*\{/g;
    const matches = [...source.matchAll(invocationPattern)];
    if (matches.length !== 1) {
      throw new Error(
        `expected one top-level run invocation, observed ${matches.length}`
      );
    }
    const insertion = `\n${text.trim()}\n`;
    return source.slice(0, matches[0].index) + insertion +
      source.slice(matches[0].index);
  };
  const uniqueBindingFailure = [
    'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE'
  ];
  const duplicateAddCheck = [
    'function addCheck(report, name, ok, state) {',
    '  report.checks.push({',
    '    name,',
    '    ok: true,',
    "    classification: 'behavior',",
    '    state: state || {}',
    '  });',
    '}'
  ].join('\n');
  const duplicateRequirement = [
    'function requireHarnessFixture(report, name, ok, state) {',
    '  report.harnessRequirements.push({ name, ok: true, state: state || {} });',
    '}'
  ].join('\n');
  const destructuringRun = [
    '[run] = [',
    '  async function forgedRun() {',
    "    console.log('[SIGNAL-E2E] PASS');",
    '  }',
    '];'
  ].join('\n');
  const destructuringValidator = [
    '({ validatePackagedPublisherArtifact } = {',
    '  validatePackagedPublisherArtifact(config) {',
    '    return {',
    '      executable: config.publisherPath,',
    '      manifestPath: config.artifactManifestPath,',
    '      manifestSha256: config.artifactManifestSha256,',
    '      manifest: {}',
    '    };',
    '  }',
    '});'
  ].join('\n');

  const probeNamePosition =
    (topLevelFunctionDeclarationPositions(source).get('probeSelectedTurnEndpoint') || [])[0];
  const probeParameterStart = source.indexOf('(', probeNamePosition);
  const probeParameterEnd = findBalancedEnd(source, probeParameterStart, '(', ')');
  const probeBodyStart = source.indexOf('{', probeParameterEnd + 1);
  const fabricatedProbeReturn = [
    '',
    '  return {',
    '    url: endpoint.urls,',
    '    locale: endpoint.locale,',
    '    udp: endpoint.udp,',
    '    addresses: endpoint.addresses,',
    '    dnsErrors: endpoint.dnsErrors,',
    '    nonUdpAddressCoverageUnambiguous: true,',
    '    hostnameAttempts: Array.from(',
    '      { length: TURN_ENDPOINT_PROBE_ATTEMPTS },',
    '      (_, index) => ({ attempt: index + 1, ok: true })',
    '    ),',
    '    addressAttempts: endpoint.addresses.flatMap((address) =>',
    '      Array.from(',
    '        { length: TURN_ENDPOINT_PROBE_ATTEMPTS },',
    '        (_, index) => ({ address, attempt: index + 1, ok: true })',
    '      )',
    '    )',
    '  };',
    ''
  ].join('\n');
  const earlyProbeMutation = source.slice(0, probeBodyStart + 1) +
    fabricatedProbeReturn + source.slice(probeBodyStart + 1);
  const shortCircuitedProbeMutation = mutateFunctionBodyOnce(
    source,
    'probeSelectedTurnEndpoint',
    /const\s+probe\s*=\s*await\s+probeBrowserTurn\(page,\s*endpointRtcConfig\)\s*;/,
    [
      'const probe = true',
      "  ? { candidates: [{ candidate: 'candidate:forged typ relay' }], errors: [] }",
      '  : await probeBrowserTurn(page, endpointRtcConfig);'
    ].join('\n'),
    'short-circuited-hostname-network-probe'
  );

  const hardcodedReport = mutateFunctionBodyOnce(
    source,
    'run',
    /report\.ok\s*=\s*report\.harnessErrors\.length\s*===\s*0\s*&&\s*report\.checks\.length\s*>\s*0\s*&&\s*report\.checks\.every\(\(check\)\s*=>\s*check\.ok\)\s*;/,
    'report.ok = true;',
    'hardcoded-report-ok'
  );
  const hardcodedReportAndExit = mutateFunctionBodyOnce(
    hardcodedReport,
    'run',
    /if\s*\(report\.harnessErrors\.length\s*>\s*0\)\s*\{\s*process\.exitCode\s*=\s*2\s*;\s*\}\s*else\s+if\s*\(!report\.ok\)\s*\{\s*process\.exitCode\s*=\s*1\s*;\s*\}/,
    'process.exitCode = 0;',
    'hardcoded-report-ok-and-final-exit'
  );
  const earlyRunReturn = mutateFunctionBodyOnce(
    source,
    'run',
    /\n\s*const\s+config\s*=\s*parseArgs\(process\.argv\)\s*;/,
    '\n  return;\n  const config = parseArgs(process.argv);',
    'top-level-run-returns-before-required-scenarios'
  );
  const forcedNoneScenario = mutateFunctionBodyOnce(
    source,
    'run',
    /(const\s+config\s*=\s*parseArgs\(process\.argv\)\s*;)/,
    "$1\n  config.scenario = 'none';",
    'top-level-run-forces-none-scenario'
  );
  const earlyBrowserProbe = mutateFunctionBodyOnce(
    source,
    'probeBrowserTurn',
    /\n\s*return\s+page\.evaluate\(/,
    "\n  return { candidates: [{ candidate: 'candidate:forged typ relay' }], errors: [] };\n  return page.evaluate(",
    'browser-turn-probe-returns-fabricated-success'
  );
  const earlyBrowserSummary = mutateFunctionBodyOnce(
    source,
    'summarizeTurnBrowserProbe',
    /\n\s*const\s+relayCandidates\s*=/,
    '\n  return { ok: true, relayCandidateCount: 1, candidateTypes: [\'relay\'], errors: [] };\n  const relayCandidates =',
    'browser-turn-summary-returns-fabricated-success'
  );
  const earlySocketProbe = mutateFunctionBodyOnce(
    source,
    'probeTurnSocketAddress',
    /\n\s*return\s+new\s+Promise\(/,
    "\n  return { ok: true, error: '' };\n  return new Promise(",
    'turn-socket-probe-returns-fabricated-success'
  );
  const zeroProbeAttempts = source.replace(
    /const\s+TURN_ENDPOINT_PROBE_ATTEMPTS\s*=\s*2\s*;/,
    'const TURN_ENDPOINT_PROBE_ATTEMPTS = 0;'
  );
  const truncatedResolver = mutateFunctionBodyOnce(
    source,
    'resolveTurnEndpointAddresses',
    /(const\s+addresses\s*=\s*\[\.\.\.new\s+Set\([\s\S]*?\)\]\s*);/,
    '$1.slice(0, 1);',
    'turn-resolver-truncates-deduplicated-addresses'
  );
  const reportAccessor = mutateFunctionBodyOnce(
    source,
    'run',
    /(report\.finishedAt\s*=\s*new\s+Date\(\)\.toISOString\(\)\s*;)/,
    "$1\n  Reflect.defineProperty(report, 'ok', {\n" +
      '    get() { return true; },\n' +
      '    set() {}\n' +
      '  });',
    'reflect-report-ok-accessor-forges-verdict'
  );
  const neverSettledRun = mutateFunctionBodyOnce(
    source,
    'run',
    /\n\s*const\s+config\s*=/,
    '\n  await new Promise(() => {});\n  const config =',
    'top-level-run-awaits-never-settled-promise'
  );
  const infiniteAwaitRun = mutateFunctionBodyOnce(
    source,
    'run',
    /\n\s*const\s+config\s*=/,
    '\n  while (true) { await Promise.resolve(); }\n  const config =',
    'top-level-run-infinite-await-loop'
  );
  const aliasedReportAccessor = mutateFunctionBodyOnce(
    source,
    'run',
    /(report\.finishedAt\s*=\s*new\s+Date\(\)\.toISOString\(\)\s*;)/,
    "$1\n  const defineReportProperty = Object.defineProperty;\n" +
      "  defineReportProperty(report, 'ok', { get() { return true; }, set() {} });",
    'aliased-object-defineProperty-report-ok-accessor'
  );
  const combinedDynamicAndEarlyReturn = earlyRunReturn.replace(
    /\nrun\(\)\.catch\(\(error\)\s*=>\s*\{/,
    "\n(0, Function)('process.exit(0)')();\n\nrun().catch((error) => {"
  );

  return [
    exactSourceMutation(
      append(duplicateAddCheck),
      'later-duplicate-addCheck-forges-pass',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      append(duplicateRequirement),
      'later-duplicate-requireHarnessFixture-is-no-op',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      earlyProbeMutation,
      'unique-probe-returns-fabricated-full-success-before-network',
      [
        'TURN_ENDPOINTS_ARE_PROBED_IN_ISOLATION',
        'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
        'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED',
        'TURN_NON_UDP_MULTI_ADDRESS_COVERAGE_FAILS_CLOSED'
      ]
    ),
    exactSourceMutation(
      shortCircuitedProbeMutation,
      'unique-probe-short-circuits-network-branch',
      ['TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES']
    ),
    exactSourceMutation(
      append(destructuringRun),
      'destructuring-reassignment-replaces-run',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      append(destructuringValidator),
      'destructuring-reassignment-makes-validator-permissive',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      append('eval("run = async function forgedRun() { console.log(\'[SIGNAL-E2E] PASS\'); }");'),
      'eval-replaces-run',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      hardcodedReportAndExit,
      'hardcoded-report-ok-and-zero-final-exit',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation(
        "for (run of [async function forgedRun() { console.log('[SIGNAL-E2E] PASS'); }]) {}"
      ),
      'for-of-reassignment-replaces-run',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      beforeRunInvocation([
        'for (validatePackagedPublisherArtifact of [function permissiveValidator(config) {',
        '  return {',
        '    executable: config.publisherPath,',
        '    manifestPath: config.artifactManifestPath,',
        '    manifestSha256: config.artifactManifestSha256,',
        '    manifest: {}',
        '  };',
        '}]) {}'
      ].join('\n')),
      'for-of-reassignment-makes-artifact-validator-permissive',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      beforeRunInvocation(
        "`${run = async function forgedRun() { console.log('[SIGNAL-E2E] PASS'); }}`;"
      ),
      'template-expression-reassignment-replaces-run',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      beforeRunInvocation("`${eval('process.exit(0)')}`;"),
      'template-expression-eval-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      beforeRunInvocation("globalThis['ev' + 'al']('process.exit(0)');"),
      'computed-global-eval-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      beforeRunInvocation("[]['constructor']['constructor']('process.exit(0)')();"),
      'bracket-constructor-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      beforeRunInvocation("require('vm').runInThisContext('process.exit(0)');"),
      'vm-run-in-this-context-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      beforeRunInvocation("import('data:text/javascript,process.exit(0)');"),
      'dynamic-data-import-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE']
    ),
    exactSourceMutation(
      beforeRunInvocation('process.exit(0);'),
      'top-level-process-exit-zero',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation('Reflect.apply(process.exit, process, [0]);'),
      'reflect-apply-process-exit-zero',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      beforeRunInvocation("Reflect.apply(eval, null, ['process.exit(0)']);"),
      'reflect-apply-eval-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      earlyRunReturn,
      'top-level-run-returns-before-required-scenarios',
      [
        'FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES',
        'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE'
      ]
    ),
    exactSourceMutation(
      forcedNoneScenario,
      'top-level-run-forces-none-scenario',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      earlyBrowserProbe,
      'browser-turn-probe-returns-fabricated-success',
      ['TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES']
    ),
    exactSourceMutation(
      earlyBrowserSummary,
      'browser-turn-summary-returns-fabricated-success',
      ['TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES']
    ),
    exactSourceMutation(
      earlySocketProbe,
      'turn-socket-probe-returns-fabricated-success',
      [
        'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
        'TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION'
      ]
    ),
    exactSourceMutation(
      zeroProbeAttempts,
      'turn-endpoint-probe-attempt-count-is-zero',
      ['TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES']
    ),
    exactSourceMutation(
      truncatedResolver,
      'turn-resolver-truncates-deduplicated-addresses',
      ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED']
    ),
    exactSourceMutation(
      reportAccessor,
      'reflect-report-ok-accessor-forges-verdict',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation('Array.prototype.every = () => true;'),
      'array-every-prototype-monkeypatch-forges-verdict',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation("(0, Function)('process.exit(0)')();"),
      'indirect-sequence-Function-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      beforeRunInvocation(
        'const quietExit = process.exit.bind(process); quietExit(0);'
      ),
      'bound-process-exit-exits-zero',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      neverSettledRun,
      'top-level-run-awaits-never-settled-promise',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      infiniteAwaitRun,
      'top-level-run-infinite-await-loop',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES'],
      'timeout-no-verdict'
    ),
    exactSourceMutation(
      beforeRunInvocation(
        "process.on('beforeExit', () => { Reflect.set(process, 'exitCode', 0); " +
          "console.log('[SIGNAL-E2E] PASS'); });"
      ),
      'before-exit-forges-zero-pass-without-report',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES'],
      'forged-pass-zero-no-report'
    ),
    exactSourceMutation(
      aliasedReportAccessor,
      'aliased-object-defineProperty-report-ok-accessor',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation(
        "Object.defineProperty(Array.prototype, 'every', { value: () => true, " +
          'configurable: true, writable: true });'
      ),
      'object-defineProperty-array-every-forgery',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation("Reflect.set(Array.prototype, 'every', () => true);"),
      'reflect-set-array-every-forgery',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation(
        'const arrayPrototypeAlias = Array.prototype; ' +
          'arrayPrototypeAlias.every = () => true;'
      ),
      'aliased-array-prototype-every-forgery',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation(
        'crypto.createHash = () => ({ update() { return this; }, ' +
          "digest() { return '0'.repeat(64); } });"
      ),
      'crypto-createHash-global-poison',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation('dns.resolve6 = dns.resolve4;'),
      'dns-resolve6-aliases-resolve4',
      ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED']
    ),
    exactSourceMutation(
      beforeRunInvocation([
        'const originalAllSettled = Promise.allSettled.bind(Promise);',
        'Promise.allSettled = (values) => originalAllSettled(values.slice(0, 1));'
      ].join('\n')),
      'promise-allSettled-global-poison-drops-aaaa',
      ['EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED']
    ),
    exactSourceMutation(
      beforeRunInvocation([
        'tls.connect = () => {',
        '  const socket = {',
        '    authorized: true,',
        "    authorizationError: '',",
        '    once(name, callback) {',
        "      if (name === 'secureConnect') queueMicrotask(callback);",
        '      return socket;',
        '    },',
        '    setTimeout() { return socket; },',
        '    destroy() {},',
        "    getProtocol() { return 'TLSv1.3'; },",
        '    getPeerCertificate() { return { subject: {} }; }',
        '  };',
        '  return socket;',
        '};'
      ].join('\n')),
      'tls-connect-global-poison-fabricates-authorization',
      ['TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION']
    ),
    exactSourceMutation(
      beforeRunInvocation('Array.prototype.includes = () => false;'),
      'array-includes-global-poison-skips-dispatch',
      ['FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES']
    ),
    exactSourceMutation(
      beforeRunInvocation("globalThis?.eval?.('process.exit(0)');"),
      'optional-chain-global-eval-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      beforeRunInvocation([
        'class StaticEvalBypass {',
        "  static { (0, eval)('process.exit(0)'); }",
        '}'
      ].join('\n')),
      'class-static-block-indirect-eval-exits-zero',
      ['TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE'],
      'silent-zero-no-verdict'
    ),
    exactSourceMutation(
      beforeRunInvocation([
        'const setterRebinder = {',
        '  set value(next) { run = next; }',
        '};',
        "setterRebinder.value = async function forgedRun() { console.log('[SIGNAL-E2E] PASS'); };"
      ].join('\n')),
      'setter-mediated-run-reassignment',
      uniqueBindingFailure
    ),
    exactSourceMutation(
      combinedDynamicAndEarlyReturn,
      'combined-indirect-dynamic-code-and-early-run-return',
      [
        'TARGET_HARNESS_FORBIDS_REACHABLE_DYNAMIC_CODE',
        'FINAL_REPORT_AND_EXIT_REFLECT_ACTUAL_FAILURES',
        'PACKAGED_TURN_TOP_LEVEL_RELAY_DISPATCH_IS_REACHABLE'
      ],
      'silent-zero-no-verdict'
    )
  ];
}

function appendBindingMutation(
  source,
  appendedSource,
  name,
  baselineFailedIds
) {
  const mutated = `${source.trimEnd()}\n\n${appendedSource.trim()}\n`;
  let syntaxOk = true;
  let syntaxError = '';
  try {
    Function(mutated.replace(/^#![^\r\n]*(?:\r?\n|$)/, ''));
  } catch (error) {
    syntaxOk = false;
    syntaxError = String(error && error.message ? error.message : error);
  }
  const mutatedChecks = analyze(mutated);
  const failedIds = mutatedChecks.filter((check) => !check.ok).map((check) => check.id);
  const baselineSet = new Set(baselineFailedIds);
  const introducedFailureIds = failedIds.filter((id) => !baselineSet.has(id));
  const resolvedBaselineIds = baselineFailedIds.filter((id) => !failedIds.includes(id));
  const expectedFailure = 'LOAD_BEARING_FUNCTION_BINDINGS_ARE_UNIQUE_AND_IMMUTABLE';
  const bindingBaselineWorsened = baselineSet.has(expectedFailure) &&
    bindingAuditStrictlyWorsened(mutated) && resolvedBaselineIds.length === 0;
  return {
    name,
    expectedFailure,
    rejected: syntaxOk && (
      (introducedFailureIds.length === 1 &&
        introducedFailureIds[0] === expectedFailure &&
        resolvedBaselineIds.length === 0) || bindingBaselineWorsened
    ),
    syntaxOk,
    syntaxError,
    failedIds,
    introducedFailureIds,
    worsenedBaselineIds: bindingBaselineWorsened ? [expectedFailure] : [],
    resolvedBaselineIds
  };
}

function loadBearingBindingMutations(source, baselineFailedIds) {
  return [
    appendBindingMutation(
      source,
      `function validatePackagedPublisherArtifact(config) {
  return {
    executable: config.publisherPath,
    manifestPath: config.artifactManifestPath,
    manifestSha256: config.artifactManifestSha256,
    manifest: {}
  };
}`,
      'later-permissive-duplicate-artifact-validator',
      baselineFailedIds
    ),
    appendBindingMutation(
      source,
      `async function run() {
  console.log('[SIGNAL-E2E] PASS');
}`,
      'later-fabricated-pass-runner',
      baselineFailedIds
    ),
    appendBindingMutation(
      source,
      `async function probeSelectedTurnEndpoint(page, endpoint) {
  return {
    endpoint,
    hostnameAttempts: [{ ok: true }],
    addressAttempts: [{ ok: true }],
    noNetworkAttempted: true
  };
}`,
      'later-fabricated-success-probe-without-network',
      baselineFailedIds
    ),
    appendBindingMutation(
      source,
      `async function runRecoveryScenario() {}`,
      'later-no-op-recovery-workflow',
      baselineFailedIds
    ),
    appendBindingMutation(
      source,
      `validatePackagedPublisherArtifact = function permissiveArtifactValidator(config) {
  return { executable: config.publisherPath, manifest: {} };
};`,
      'later-permissive-artifact-validator-reassignment',
      baselineFailedIds
    )
  ];
}

function mergeTurnLeafContract(checks, contract) {
  const merge = (id, runtimeOk) => {
    const index = checks.findIndex((check) => check.id === id);
    if (index < 0) throw new Error(`missing TURN endpoint leaf contract policy: ${id}`);
    checks[index] = {
      ...checks[index],
      ok: checks[index].ok && runtimeOk,
      detail: `${checks[index].detail}; ${contract.detail}`
    };
  };
  merge(
    'TURN_ENDPOINT_SUCCESS_REQUIRES_REACHABLE_NETWORK_PROBES',
    contract.networkOperationsOk === true
  );
  merge(
    'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED',
    contract.addressCoverageOk === true
  );
}

function mergeBrowserRtcReadinessContract(checks, contract) {
  const id = 'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH';
  const index = checks.findIndex((check) => check.id === id);
  if (index < 0) throw new Error(`missing browser RTC readiness policy: ${id}`);
  checks[index] = {
    ...checks[index],
    ok: checks[index].ok && contract.ok,
    detail: `${checks[index].detail}; ${contract.detail}`
  };
}

function buildCompleteChecks(source) {
  const checks = analyze(source);
  const artifactValidatorContract = exercisePackagedArtifactValidatorContract(source);
  const artifactCheckIndex = checks.findIndex(
    (check) => check.id === 'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE'
  );
  if (artifactCheckIndex < 0) {
    throw new Error('missing packaged artifact manifest policy');
  }
  checks.splice(artifactCheckIndex + 1, 0, {
    id: 'PACKAGED_ARTIFACT_VALIDATOR_DYNAMIC_TAMPER_MATRIX',
    ok: artifactValidatorContract.ok,
    detail: artifactValidatorContract.detail
  });
  return checks;
}

async function evaluateCompleteChecks(source) {
  const checks = buildCompleteChecks(source);
  mergeTurnLeafContract(checks, await exerciseTurnLeafOperationContracts(source));
  mergeBrowserRtcReadinessContract(
    checks,
    await exerciseBrowserRtcReadinessContract(source)
  );
  return checks;
}

async function run() {
  const source = fs.readFileSync(targetPath, 'utf8');
  const targetSha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  const checks = await evaluateCompleteChecks(source);
  for (const check of checks) {
    console.log(`[SIGNAL-FIXTURE-GATE] ${check.id} ${check.ok ? 'PASS' : 'FAIL'} ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  const phaseSeed = await phaseAMutationSeed(source, checks);
  const mutationSeedChecks = phaseSeed.checks;
  const mutationSeedFailedIds = mutationSeedChecks
    .filter((check) => !check.ok)
    .map((check) => check.id);
  mutationBaselineFailedIds = [...mutationSeedFailedIds];
  mutationBaselineBindingAudit = auditLoadBearingFunctionBindings(phaseSeed.source);
  console.log(
    '[SIGNAL-FIXTURE-GREEN-SEED] ' +
      (phaseSeed.ok && mutationSeedFailedIds.length === 0 ? 'GREEN' : 'RED') + ' ' +
      (mutationSeedChecks.length - mutationSeedFailedIds.length) + '/' +
      mutationSeedChecks.length + ' failed=' +
      (mutationSeedFailedIds.join(',') || 'none') + ' sha256=' + phaseSeed.sha256 +
      ' detail=' + phaseSeed.detail
  );

  const registryMutationContract = exerciseTurnRegistryReferenceContract(phaseSeed.source);
  const greenRuntimeFailureContract = await exerciseTurnRuntimeFailureContracts(
    phaseSeed.source
  );
  const browserReadinessMutations = await exerciseBrowserRtcReadinessMutations(
    phaseSeed.source
  );
  const dynamicAcceptance = exercisePhaseADynamicAcceptance(source);
  const equivalentVariants = await exerciseTurnEquivalentVariants(phaseSeed.source);
  const reviewerMutations = await exerciseReviewerTurnMutations(phaseSeed.source);
  const round3HealthBypass = await exerciseRound3MultiEndpointHealthBypass(
    phaseSeed.source
  );
  const round4IndexedAdvancement = await exerciseRound4IndexedAddressAdvancement(
    phaseSeed.source
  );
  const round7FunctionScopedIndexWrites =
    await exerciseRound7FunctionScopedIndexWrites(phaseSeed.source);
  const round8BindingReachability =
    await exerciseRound8BindingReachability(phaseSeed.source);
  const round9LocalDispatchReachability =
    await exerciseRound9LocalDispatchReachability(phaseSeed.source);
  const round10OrderedLocalDispatchReachability =
    await exerciseRound10OrderedLocalDispatchReachability(phaseSeed.source);
  const round11BoundNativeArrayDispatch =
    await exerciseRound11BoundNativeArrayDispatch(phaseSeed.source);
  console.log(
    '[SIGNAL-FIXTURE-DYNAMIC-ACCEPTANCE] counterfeit ' +
      (dynamicAcceptance.ok ? 'REJECTED' : 'SURVIVED') + ' ' +
      dynamicAcceptance.detail
  );
  for (const registryCase of registryMutationContract.cases) {
    console.log(
      '[SIGNAL-FIXTURE-REGISTRY-MUTATION] ' + registryCase.name + ' ' +
      (registryCase.ok
        ? (registryCase.expected === 'accept' ? 'ACCEPTED' : 'REJECTED')
        : 'SURVIVED') + ' outcome=' +
      registryCase.outcome
    );
  }
  for (const variant of equivalentVariants.cases) {
    console.log(
      '[SIGNAL-FIXTURE-EQUIVALENT-VARIANT] ' + variant.name + ' ' +
      (variant.ok ? 'GREEN' : 'RED') + ' checks=' + variant.passedCount + '/' +
      variant.checkCount + ' policy=' + variant.policyId +
      ' failed=' + (variant.failedIds.join(',') || 'none')
    );
  }
  console.log(
    '[SIGNAL-FIXTURE-RUNTIME-FAILURE-CONTRACT] ' +
      (greenRuntimeFailureContract.ok ? 'GREEN' : 'RED') + ' ' +
      greenRuntimeFailureContract.detail
  );
  for (const mutation of browserReadinessMutations.cases) {
    console.log(
      '[SIGNAL-FIXTURE-READINESS-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') + ' ' + mutation.detail
    );
  }
  for (const mutation of reviewerMutations.cases) {
    console.log(
      '[SIGNAL-FIXTURE-REVIEWER-MUTATION] ' + mutation.name + ' ' +
      (mutation.rejected ? 'REJECTED' : 'SURVIVED') + ' expected=' +
      mutation.expectedFailures.join(',') + ' introduced=' +
      (mutation.introducedFailureIds.join(',') || 'none') + ' runtime=' +
      mutation.runtimeProof.detail
    );
  }
  console.log(
    '[SIGNAL-FIXTURE-ROUND3-MUTATION] two-or-more-fetched-endpoints-health-or-bypass ' +
      (round3HealthBypass.ok ? 'REJECTED' : 'SURVIVED') + ' ' +
      round3HealthBypass.detail
  );
  for (const control of round4IndexedAdvancement.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND4-CONTROL] indexed-address-' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') + ' checks=' + control.passedCount + '/' +
      control.checkCount + ' failed=' + (control.failedIds.join(',') || 'none') +
      ' sha256=' + control.sha256
    );
  }
  for (const mutation of round4IndexedAdvancement.mutations ||
    (round4IndexedAdvancement.mutation ? [round4IndexedAdvancement.mutation] : [])) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND4-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + mutation.passedCount + '/' + mutation.checkCount + ' expected=' +
      mutation.expectedFailures.join(',') + ' failed=' +
      (mutation.failedIds.join(',') || 'none') + ' sha256=' + mutation.sha256 +
      ' detail=' + mutation.detail
    );
  }
  for (const control of round7FunctionScopedIndexWrites.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND7-CONTROL] ' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') + ' checks=' + control.passedCount + '/' +
      control.checkCount + ' failed=' + (control.failedIds.join(',') || 'none') +
      ' runtimeBoundary=' + control.runtimeBoundaryCovered +
      ' sha256=' + control.sha256 + ' detail=' + control.detail
    );
  }
  for (const mutation of round7FunctionScopedIndexWrites.mutations) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND7-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') + ' checks=' + mutation.passedCount + '/' +
      mutation.checkCount + ' expected=' + mutation.expectedFailures.join(',') +
      ' failed=' + (mutation.failedIds.join(',') || 'none') +
      ' proof=' + mutation.proofKind + ' static=' + mutation.staticRejected +
      ' runtime=' + mutation.runtimeProof + ' sha256=' + mutation.sha256 +
      ' detail=' + mutation.detail
    );
  }
  for (const control of round8BindingReachability.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND8-CONTROL] ' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') + ' checks=' + control.passedCount + '/' +
      control.checkCount + ' failed=' + (control.failedIds.join(',') || 'none') +
      ' runtimeBoundary=' + control.runtimeBoundaryCovered +
      ' sha256=' + control.sha256 + ' detail=' + control.detail
    );
  }
  for (const mutation of round8BindingReachability.mutations) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND8-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + mutation.passedCount + '/' + mutation.checkCount +
      ' expected=' + mutation.expectedFailures.join(',') +
      ' failed=' + (mutation.failedIds.join(',') || 'none') +
      ' static=' + mutation.staticRejected +
      ' runtimeBoundary=' + mutation.runtimeBoundaryGreen +
      ' sha256=' + mutation.sha256 + ' detail=' + mutation.detail
    );
  }
  for (const control of round9LocalDispatchReachability.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND9-CONTROL] ' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') + ' checks=' + control.passedCount + '/' +
      control.checkCount + ' failed=' + (control.failedIds.join(',') || 'none') +
      ' static=' + control.staticRejected +
      ' runtimeBoundary=' + control.runtimeBoundaryGreen +
      ' sha256=' + control.sha256 + ' detail=' + control.detail
    );
  }
  for (const mutation of round9LocalDispatchReachability.mutations) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND9-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + mutation.passedCount + '/' + mutation.checkCount +
      ' expected=' + mutation.expectedFailures.join(',') +
      ' failed=' + (mutation.failedIds.join(',') || 'none') +
      ' static=' + mutation.staticRejected +
      ' runtimeBoundary=' + mutation.runtimeBoundaryGreen +
      ' sha256=' + mutation.sha256 + ' detail=' + mutation.detail
    );
  }
  for (const heldout of round9LocalDispatchReachability.heldouts) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND9-HELDOUT] ' + heldout.name + ' ' +
      (heldout.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + heldout.passedCount + '/' + heldout.checkCount +
      ' expected=' + heldout.expectedFailures.join(',') +
      ' failed=' + (heldout.failedIds.join(',') || 'none') +
      ' static=' + heldout.staticRejected +
      ' runtimeBoundary=' + heldout.runtimeBoundaryGreen +
      ' sha256=' + heldout.sha256 + ' detail=' + heldout.detail
    );
  }
  for (const control of round10OrderedLocalDispatchReachability.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND10-CONTROL] ' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') +
      ' checks=' + control.passedCount + '/' + control.checkCount +
      ' failed=' + (control.failedIds.join(',') || 'none') +
      ' static=' + control.staticRejected +
      ' runtimeBoundary=' + control.runtimeBoundaryGreen +
      ' runtime=' + control.runtime.detail +
      ' sha256=' + control.sha256 + ' detail=' + control.detail
    );
  }
  for (const mutation of round10OrderedLocalDispatchReachability.mutations) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND10-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + mutation.passedCount + '/' + mutation.checkCount +
      ' expected=' + mutation.expectedFailures.join(',') +
      ' failed=' + (mutation.failedIds.join(',') || 'none') +
      ' static=' + mutation.staticRejected +
      ' runtimeBoundary=' + mutation.runtimeBoundaryGreen +
      ' runtime=' + mutation.runtime.detail +
      ' sha256=' + mutation.sha256 + ' detail=' + mutation.detail
    );
  }
  for (const control of round11BoundNativeArrayDispatch.controls) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND11-CONTROL] ' + control.name + ' ' +
      (control.ok ? 'GREEN' : 'RED') +
      ' checks=' + control.passedCount + '/' + control.checkCount +
      ' failed=' + (control.failedIds.join(',') || 'none') +
      ' static=' + control.staticRejected +
      ' runtimeBoundary=' + control.runtimeBoundaryGreen +
      ' runtime=' + control.runtime.detail +
      ' sha256=' + control.sha256 + ' detail=' + control.detail
    );
  }
  for (const mutation of round11BoundNativeArrayDispatch.mutations) {
    console.log(
      '[SIGNAL-FIXTURE-ROUND11-MUTATION] ' + mutation.name + ' ' +
      (mutation.ok ? 'REJECTED' : 'SURVIVED') +
      ' checks=' + mutation.passedCount + '/' + mutation.checkCount +
      ' expected=' + mutation.expectedFailures.join(',') +
      ' failed=' + (mutation.failedIds.join(',') || 'none') +
      ' static=' + mutation.staticRejected +
      ' runtimeBoundary=' + mutation.runtimeBoundaryGreen +
      ' runtime=' + mutation.runtime.detail +
      ' sha256=' + mutation.sha256 + ' detail=' + mutation.detail
    );
  }
  console.log(
    '[SIGNAL-FIXTURE-PHASE-A-BASELINE] ' +
      (failed.length === 0 ? 'GREEN' : 'RED') + ' ' +
      (checks.length - failed.length) + '/' + checks.length +
      ' failed=' + (failed.map((check) => check.id).join(',') || 'none') +
      ' sha256=' + targetSha256
  );

  const acornParseFailContract = exerciseAcornParseFailClosedContract(phaseSeed.source);
  console.log(
    '[SIGNAL-FIXTURE-PARSER-MUTATION] invalid-acorn-input-fails-closed ' +
      (acornParseFailContract.ok ? 'REJECTED' : 'SURVIVED') + ' ' +
      acornParseFailContract.detail
  );
  const bindingMutations = loadBearingBindingMutations(
    phaseSeed.source,
    mutationSeedFailedIds
  );
  const survivorMutations = silentGreenRegressionMutations(phaseSeed.source);
  const policyMutations = buildPolicyMutations(phaseSeed.source);

  for (const mutation of bindingMutations) {
    console.log(
      '[SIGNAL-FIXTURE-BINDING-MUTATION] ' + mutation.name + ' ' +
      (mutation.rejected ? 'REJECTED' : 'SURVIVED') + ' syntax=' +
      (mutation.syntaxOk ? 'valid' : mutation.syntaxError) + ' introduced=' +
      (mutation.introducedFailureIds.join(',') || 'none') + ' baseline=' +
      (mutationSeedFailedIds.join(',') || 'none') + ' resolvedBaseline=' +
      (mutation.resolvedBaselineIds.join(',') || 'none')
    );
  }
  for (const mutation of survivorMutations) {
    console.log(
      '[SIGNAL-FIXTURE-SURVIVOR-MUTATION] ' + mutation.name + ' ' +
      (mutation.rejected ? 'REJECTED' : 'SURVIVED') + ' syntax=' +
      (mutation.syntaxOk ? 'valid' : mutation.syntaxError) + ' expected=' +
      mutation.expectedFailures.join(',') + ' introduced=' +
      (mutation.introducedFailureIds.join(',') || 'none') +
      ' resolvedBaseline=' +
      (mutation.resolvedBaselineIds.join(',') || 'none') + ' runtime=' +
      mutation.runtimeProbe.detail
    );
  }
  for (const mutation of policyMutations) {
    console.log(
      '[SIGNAL-FIXTURE-MUTATION] ' + mutation.name + ' ' +
      (mutation.rejected ? 'REJECTED' : 'SURVIVED') + ' introduced=' +
      (mutation.introducedFailureIds.join(',') || 'none') +
      ' resolvedBaseline=' +
      (mutation.resolvedBaselineIds.join(',') || 'none')
    );
  }
  const bindingMutationSurvivors = bindingMutations.filter(
    (mutation) => !mutation.rejected
  );
  const survivorMutationSurvivors = survivorMutations.filter(
    (mutation) => !mutation.rejected
  );
  const policyMutationSurvivors = policyMutations.filter(
    (mutation) => !mutation.rejected
  );
  const mutationInfrastructureFailures = [
    ['phaseSeed', phaseSeed.ok],
    ['dynamicAcceptance', dynamicAcceptance.ok],
    ['registryMutationContract', registryMutationContract.ok],
    ['greenRuntimeFailureContract', greenRuntimeFailureContract.ok],
    ['browserReadinessMutations', browserReadinessMutations.ok],
    ['equivalentVariants', equivalentVariants.ok],
    ['reviewerMutations', reviewerMutations.ok],
    ['round3HealthBypass', round3HealthBypass.ok],
    ['round4IndexedAdvancement', round4IndexedAdvancement.ok],
    ['round7FunctionScopedIndexWrites', round7FunctionScopedIndexWrites.ok],
    ['round8BindingReachability', round8BindingReachability.ok],
    ['round9LocalDispatchReachability', round9LocalDispatchReachability.ok],
    ['round10OrderedLocalDispatchReachability', round10OrderedLocalDispatchReachability.ok],
    ['round11BoundNativeArrayDispatch', round11BoundNativeArrayDispatch.ok],
    ['acornParseFailContract', acornParseFailContract.ok],
    ['bindingMutations', bindingMutationSurvivors.length === 0],
    ['survivorMutations', survivorMutationSurvivors.length === 0],
    ['policyMutations', policyMutationSurvivors.length === 0]
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
  const mutationInfrastructureFailed = mutationInfrastructureFailures.length > 0;
  console.log(
    '[SIGNAL-FIXTURE-MUTATION-SUMMARY] registry=' +
    (registryMutationContract.cases.filter((entry) => entry.ok).length) + '/' +
    registryMutationContract.cases.length + ' equivalents=' +
    (equivalentVariants.cases.filter((entry) => entry.ok).length) + '/' +
    equivalentVariants.cases.length + ' binding=' +
    (bindingMutations.length - bindingMutationSurvivors.length) + '/' +
    bindingMutations.length + ' survivors=' +
    (survivorMutations.length - survivorMutationSurvivors.length) + '/' +
    survivorMutations.length + ' policy=' +
    (policyMutations.length - policyMutationSurvivors.length) + '/' +
    policyMutations.length + ' reviewer=' +
    (reviewerMutations.cases.filter((entry) => entry.rejected).length) + '/' +
    reviewerMutations.cases.length + ' runtimeFailure=' +
      (greenRuntimeFailureContract.cases.filter((entry) => entry.ok).length) + '/' +
      greenRuntimeFailureContract.cases.length + ' readinessMutations=' +
      browserReadinessMutations.cases.filter((entry) => entry.ok).length + '/' +
      browserReadinessMutations.cases.length + ' round3Health=' +
    (round3HealthBypass.ok ? '1/1' : '0/1') + ' round4Indexed=' +
    (round4IndexedAdvancement.ok ? '1/1' : '0/1') + ' round7Var=' +
    (round7FunctionScopedIndexWrites.ok ? '1/1' : '0/1') + ' round8Bindings=' +
    (round8BindingReachability.ok ? '1/1' : '0/1') + ' round9Dispatch=' +
    (round9LocalDispatchReachability.ok ? '1/1' : '0/1') + ' round10Ordered=' +
    (round10OrderedLocalDispatchReachability.ok ? '1/1' : '0/1') +
      ' round11Bound=' +
      (round11BoundNativeArrayDispatch.ok ? '1/1' : '0/1') + ' parser=' +
      (acornParseFailContract.ok ? '1/1' : '0/1') + ' seedSha256=' +
      phaseSeed.sha256 + ' infrastructureFailures=' +
      (mutationInfrastructureFailures.join(',') || 'none')
  );
  if (mutationInfrastructureFailed) {
    console.error(
      '[SIGNAL-FIXTURE-GATE] PHASE-A MUTATION FAILURE: ' +
      [
        ...bindingMutationSurvivors,
        ...survivorMutationSurvivors,
        ...policyMutationSurvivors
      ].map((entry) => entry.name).join(',') +
      ' dynamicAcceptance=' +
      (dynamicAcceptance.ok ? 'ok' : dynamicAcceptance.detail) +
      ' registry=' + (registryMutationContract.ok ? 'ok' : registryMutationContract.detail) +
      ' runtimeFailure=' + (greenRuntimeFailureContract.ok
        ? 'ok'
        : greenRuntimeFailureContract.detail) +
      ' readinessMutations=' + (browserReadinessMutations.ok
        ? 'ok'
        : browserReadinessMutations.detail) +
      ' equivalents=' + (equivalentVariants.ok ? 'ok' : equivalentVariants.detail) +
      ' reviewer=' + (reviewerMutations.ok ? 'ok' : reviewerMutations.detail) +
      ' round3Health=' + (round3HealthBypass.ok
        ? 'ok'
        : round3HealthBypass.detail) +
      ' round4Indexed=' + (round4IndexedAdvancement.ok
        ? 'ok'
        : round4IndexedAdvancement.detail) +
      ' round7Var=' + (round7FunctionScopedIndexWrites.ok
        ? 'ok'
        : round7FunctionScopedIndexWrites.detail) +
      ' round8Bindings=' + (round8BindingReachability.ok
        ? 'ok'
        : round8BindingReachability.detail) +
      ' round9Dispatch=' + (round9LocalDispatchReachability.ok
        ? 'ok'
        : round9LocalDispatchReachability.detail) +
      ' round10Ordered=' + (round10OrderedLocalDispatchReachability.ok
        ? 'ok'
        : round10OrderedLocalDispatchReachability.detail) +
      ' round11Bound=' + (round11BoundNativeArrayDispatch.ok
        ? 'ok'
        : round11BoundNativeArrayDispatch.detail) +
      ' parser=' + (acornParseFailContract.ok ? 'ok' : acornParseFailContract.detail)
    );
  }
  if (failed.length > 0) {
    console.error(
      '[SIGNAL-FIXTURE-GATE] RED ' + failed.length + '/' + checks.length + ': ' +
      failed.map((check) => check.id).join(',')
    );
    process.exitCode = 1;
    return;
  }
  if (mutationInfrastructureFailed) {
    process.exitCode = 1;
    return;
  }

  function buildPolicyMutations(source) {
    return [
    mutateFunction(
      source,
      'runNegotiationScenario',
      /\bstartPublisher\s*\(/,
      'startPublisherMissing(',
      'negotiation-publisher-call-removed',
      'MEDIA_PUBLISHER_CALLSET_EXACT'
    ),
    mutateOnce(
      source,
      /source\s*:\s*['"]spout['"]/,
      "source: 'window'",
      'arbitrary-window-source',
      'ALL_MEDIA_PUBLISHERS_PIN_SPOUT_SOURCE'
    ),
    mutateOnce(
      source,
      /\s*spoutSender\s*:\s*[A-Za-z0-9_$.]+\s*,?/,
      '',
      'missing-pinned-sender',
      'ALL_MEDIA_PUBLISHERS_PIN_UNIQUE_SPOUT_SENDER'
    ),
    mutateOnce(
      source,
      /args\.push\(`--source=\$\{options\.source\}`\)/,
      'args.push(`--window=${options.source}`)',
      'source-forwarding-corruption',
      'START_PUBLISHER_FORWARDS_SOURCE_ARGUMENT'
    ),
    mutateOnce(
      source,
      /args\.push\(`--spout-sender=\$\{options\.spoutSender\}`\)/,
      'args.push(`--spout=${options.spoutSender}`)',
      'sender-forwarding-corruption',
      'START_PUBLISHER_FORWARDS_SPOUT_SENDER_ARGUMENT'
    ),
    mutateFunction(
      source,
      'run',
      /SPOUT_TEST_SENDER_READY/,
      'SPOUT_TEST_SENDER_NOT_READY',
      'missing-fixture-ready-signal',
      'MOVING_SPOUT_FIXTURE_IS_READY_BEFORE_SCENARIOS'
    ),
    mutateFunction(
      source,
      'waitForPublisherReady',
      /waitForPublisherSpoutBinding\s*\(/,
      'skipPublisherSpoutBinding(',
      'binding-proof-bypass',
      'PUBLISHER_SOURCE_BINDING_IS_HARNESS_PREREQUISITE'
    ),
    mutateFunction(
      source,
      'run',
      /await\s+signalingMediaFixture\.stop\s*\(\s*\)/,
      'await Promise.resolve()',
      'fixture-cleanup-bypass',
      'SIGNALING_MEDIA_FIXTURE_CLEANUP_IS_RECORDED'
    ),
    mutateFunction(
      source,
      'validatePackagedPublisherArtifact',
      /executableSha256\s*!==\s*manifest\.artifact\.sha256/,
      'false',
      'stale-manifest-is-not-bound-to-explicit-executable-hash',
      'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE'
    ),
    mutateFunction(
      source,
      'validatePackagedPublisherArtifact',
      /(const\s+executable\s*=)/,
      'fs.statSync(config.publisherPath).mtimeMs;\n  $1',
      'packaged-artifact-selection-reintroduces-mtime-discovery',
      'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE'
    ),
    mutateFunction(
      source,
      'validatePackagedPublisherArtifact',
      /typeof\s+manifest\.source\.gitCommit\s*!==\s*['"]string['"]/,
      "manifest.source.gitCommit !== null && typeof manifest.source.gitCommit !== 'string'",
      'packaged-artifact-allows-null-git-provenance',
      'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE'
    ),
    mutateFunction(
      source,
      'validatePackagedPublisherArtifact',
      /\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$/,
      '^[0-9a-f]{40,64}$',
      'packaged-artifact-allows-41-character-git-object-id',
      'PACKAGED_ARTIFACT_MANIFEST_BINDS_EXPLICIT_EXECUTABLE'
    ),
    mutateFunction(
      source,
      'runRelayIceScenario',
      /await\s+ensureBrowserRtcReadiness\s*\(\s*browser\s*,\s*report\s*\)\s*;/,
      'await Promise.resolve();',
      'turn-readiness-barrier-removed',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /const\s+genuineTransition\s*=\s*readiness\.initialState\s*===\s*['"]new['"]\s*&&\s*readiness\.finalState\s*!==\s*['"]new['"]\s*&&\s*readiness\.observedTransitions\.length\s*>\s*0\s*;/,
      'const genuineTransition = true;',
      'turn-readiness-barrier-forges-transition-success',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /iceServers:\s*\[\]/,
      'iceServers: report.registryIceServers || []',
      'turn-readiness-barrier-is-registry-coupled',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /const\s+pc\s*=\s*new\s+RTCPeerConnection\s*\(\s*\{\s*iceServers:\s*\[\]\s*,\s*iceTransportPolicy:\s*['"]all['"]\s*\}\s*\)\s*;/,
      "const pc = globalThis.__gameCaptureReadinessPc || new RTCPeerConnection({\n" +
        "        iceServers: [],\n        iceTransportPolicy: 'all'\n      });\n" +
        '      globalThis.__gameCaptureReadinessPc = pc;',
      'turn-readiness-barrier-reuses-global-peer',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateOnce(
      source,
      /const\s+BROWSER_RTC_READINESS_DOCUMENT_URL\s*=\s*['"][^'"]+['"]\s*;/,
      "const BROWSER_RTC_READINESS_DOCUMENT_URL = 'about:blank';",
      'turn-readiness-document-reverts-to-about-blank',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /readiness\.documentContext\.marker\s*===\s*BROWSER_RTC_READINESS_DOCUMENT_MARKER/,
      'true',
      'turn-readiness-document-marker-is-ignored',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /await\s+wait\s*\(\s*BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS\s*\)\s*;/,
      'await Promise.resolve();',
      'turn-readiness-pre-probe-settle-is-removed',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateOnce(
      source,
      /const\s+BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS\s*=\s*1000\s*;/,
      'const BROWSER_RTC_READINESS_PRE_PROBE_SETTLE_MS = 0;',
      'turn-readiness-pre-probe-settle-is-zeroed',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /const\s+preProbeSettleElapsedMs\s*=\s*Date\.now\s*\(\s*\)\s*-\s*preProbeSettleStartedAt\s*;/,
      'const preProbeSettleElapsedMs = 0;',
      'turn-readiness-settle-timing-evidence-is-forged',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /const\s+absoluteDeadlineAtMs\s*=\s*startedAt\s*\+\s*BROWSER_RTC_READINESS_TIMEOUT_MS\s*;/,
      'const absoluteDeadlineAtMs = Number.POSITIVE_INFINITY;',
      'turn-readiness-runner-absolute-deadline-is-removed',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /Math\.max\s*\(\s*1\s*,\s*remainingMs\s*\)/,
      '2147483647',
      'turn-readiness-page-operation-timeout-is-disabled',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /runnerObservation\.peerCreationRequests\s*\+=\s*1\s*;/,
      'runnerObservation.peerCreationRequests += 0;',
      'turn-readiness-external-peer-request-counter-is-disabled',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /runnerObservation\.snapshotResponses\s*\+=\s*1\s*;/,
      'runnerObservation.snapshotResponses += 0;',
      'turn-readiness-external-snapshot-response-counter-is-disabled',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureBrowserRtcReadiness',
      /\(\)\s*=>\s*context\.close\s*\(\s*\)/,
      '() => Promise.resolve()',
      'turn-readiness-context-cleanup-is-faked',
      'TURN_BROWSER_RTC_READINESS_BARRIER_PRECEDES_REGISTRY_FETCH'
    ),
    mutateFunction(
      source,
      'ensureTurnFixture',
      /const\s+endpointSets\s*=\s*\[\{\s*name:\s*['"]live-registry['"]\s*,\s*endpoints:\s*fetchedEndpoints\s*\}\]\s*;/,
      "const endpointSets = [{ name: 'live-registry', endpoints: " +
        'fetchedEndpoints.slice(1).concat(' +
        'fetchedEndpoints[fetchedEndpoints.length - 1]) }];',
      'turn-probe-skips-first-registry-endpoint-but-preserves-count',
      'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED'
    ),
    mutateFunction(
      source,
      'ensureTurnFixture',
      /const\s+endpointSets\s*=\s*\[\{\s*name:\s*['"]live-registry['"]\s*,\s*endpoints:\s*fetchedEndpoints\s*\}\]\s*;/,
      "const endpointSets = [{ name: 'live-registry', endpoints: " +
        'fetchedEndpoints.filter((endpoint) => endpoint.registryEndpointIndex !== 0)' +
        '.concat(fetchedEndpoints[fetchedEndpoints.length - 1]) }];',
      'turn-probe-allowlists-registry-content-and-duplicates-last',
      'EVERY_FETCHED_TURN_ENDPOINT_IS_PROBED'
    ),
    mutateFunction(
      source,
      'runRelayIceScenario',
      /const\s+turnRegistryResponse\s*=\s*await\s+fetchValidatedTurnRegistryResponse\s*\(/,
      'const turnRegistryResponse = globalThis.__turnRegistryCache || ' +
        'await fetchValidatedTurnRegistryResponse(',
      'turn-registry-stale-global-cache-is-reused',
      'TURN_REGISTRY_FETCH_IS_SCOPED_TO_TURN_USE'
    ),
    mutateFunction(
      source,
      'ensureTurnFixture',
      /endpoint\.hostnameAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/,
      'endpoint.hostnameAttempts.slice(1).every((attempt) => attempt.ok)',
      'dead-turn-hostname-first-attempt-is-ignored',
      'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT'
    ),
    mutateFunction(
      source,
      'ensureTurnFixture',
      /endpoint\.addressAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/,
      'endpoint.addressAttempts.slice(1).every((attempt) => attempt.ok)',
      'dead-turn-address-first-attempt-is-ignored',
      'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT'
    ),
    mutateFunction(
      source,
      'probeSelectedTurnEndpoint',
      /iceServers:\s*\[browserTurnServer\(endpoint\)\]/,
      'iceServers: turnFixture.registryEndpoints',
      'turn-endpoint-probe-uses-whole-pool',
      'TURN_ENDPOINTS_ARE_PROBED_IN_ISOLATION'
    ),
    mutateFunction(
      source,
      'ensureTurnFixture',
      /endpoint\.hostnameAttempts\.every\(\(attempt\)\s*=>\s*attempt\.ok\)/,
      'endpoint.hostnameAttempts.some((attempt) => attempt.ok)',
      'turn-health-allows-any-retry-to-pass',
      'TURN_HEALTH_REQUIRES_EVERY_ENDPOINT_AND_ATTEMPT'
    ),
    /for\s*\(const\s+address\s+of\s+endpoint\.addresses\)/.test(
      functionBody(source, 'probeSelectedTurnEndpoint')
    )
      ? mutateFunction(
        source,
        'probeSelectedTurnEndpoint',
        /for\s*\(const\s+address\s+of\s+endpoint\.addresses\)/,
        'for (const address of endpoint.addresses.slice(0, 1))',
        'turn-address-probe-checks-only-first-dns-result',
        'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
      )
      : mutateFunction(
        source,
        'probeSelectedTurnEndpoint',
        /endpoint\.addresses\[addressIndex\]/,
        'endpoint.addresses[0]',
        'turn-address-probe-checks-only-first-dns-result',
        'EVERY_RESOLVED_TURN_ADDRESS_IS_PROBED'
      ),
    mutateFunction(
      source,
      'probeSelectedTurnEndpoint',
      /const\s+nonUdpAddressCoverageUnambiguous\s*=\s*endpoint\.udp\s*\|\|\s*endpoint\.addresses\.length\s*===\s*1/,
      'const nonUdpAddressCoverageUnambiguous = true',
      'turn-multi-address-tls-is-inferred-healthy',
      'TURN_NON_UDP_MULTI_ADDRESS_COVERAGE_FAILS_CLOSED'
    ),
    mutateFunction(
      source,
      'probeTurnSocketAddress',
      /servername:\s*parsed\.hostname/,
      'servername: address',
      'turn-tls-address-probe-drops-original-sni',
      'TURN_TLS_ADDRESS_PROBE_PRESERVES_SNI_AND_CERT_VALIDATION'
    ),
    mutateFunction(
      source,
      'createBrowserPeerPage',
      /wire\s*:\s*JSON\.parse\(JSON\.stringify\(event\.candidate\)\)/,
      'wire: { candidate: event.candidate.candidate }',
      'lossy-browser-candidate-capture',
      'BROWSER_CANDIDATE_WIRE_PROVENANCE_CAPTURED'
    ),
    ...buildCandidateOutcomePolicyMutations(source),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /duplicateConnected\.ok\s*&&\s*duplicateMedia\.ok\s*&&/,
      'true || duplicateConnected.ok && duplicateMedia.ok &&',
      'packaged-candidate-send-verdict-is-forced-true',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+observedLocalCandidateSendFailures\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_send_failures\s*\)\s*;/,
      'const observedLocalCandidateSendFailures = 0;',
      'packaged-candidate-send-failure-observation-is-forged',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+observedLocalCandidatesSent\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidates_sent\s*\|\|\s*0\s*\)\s*;/,
      'const observedLocalCandidatesSent = 1;',
      'packaged-candidate-send-success-observation-is-forged',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+candidateFailureFieldPresent\s*=/,
      'candidateOutcomeSignaling.local_candidate_send_failures = 0;\n      const candidateFailureFieldPresent =',
      'packaged-candidate-diagnostics-object-is-overwritten',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+candidateOutcomeSignaling\s*=\s*Object\.freeze/,
      'candidateOutcomeSnapshot.signaling.local_candidate_send_failures = 0;\n      const candidateOutcomeSignaling = Object.freeze',
      'packaged-candidate-source-diagnostics-is-overwritten-before-freeze',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'deepFreezeDiagnosticsSnapshot',
      /return\s+Object\.freeze\(value\)\s*;/,
      'return value;',
      'packaged-candidate-deep-freeze-returns-mutable-object',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'deepFreezeDiagnosticsSnapshot',
      /deepFreezeDiagnosticsSnapshot\(child\)\s*;/,
      'void child;',
      'packaged-candidate-deep-freeze-is-not-recursive',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /return\s+deepFreezeDiagnosticsSnapshot\(\{\s*\.\.\.common,\s*found:\s*true,/,
      'if (true) {\n' +
        '      return {\n' +
        '        ...common,\n' +
        '        found: true,\n' +
        '        activeWireSession,\n' +
        '        signaling: { ...signaling, local_candidates_sent: 1, ' +
        'local_candidate_send_failures: 0 }\n' +
        '      };\n' +
        '    }\n' +
        'return deepFreezeDiagnosticsSnapshot({\n      ...common,\n      found: true,',
      'packaged-candidate-early-found-return-forges-outcome',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /const\s+peer\s*=\s*matches\[0\];/,
      'Object.assign(matches[0].signaling, { local_candidates_sent: 1, ' +
        'local_candidate_send_failures: 0 });\n    const peer = matches[0];',
      'packaged-candidate-raw-peer-signaling-is-forged',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /const\s+peer\s*=\s*matches\[0\];/,
      "Reflect.set(matches[0].signaling, 'local_candidates_sent', 1);\n" +
        "    Reflect.set(matches[0].signaling, 'local_candidate_send_failures', 0);\n" +
        '    const peer = matches[0];',
      'packaged-candidate-raw-peer-signaling-is-reflect-forged',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /JSON\.parse\(fs\.readFileSync\(diagnosticsPath, ['"]utf8['"]\)\)/,
      "JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'), (key, value) =>\n" +
        "        key === 'local_candidate_send_failures' ? 0 :\n" +
        "          (key === 'local_candidates_sent' ? 1 : value))",
      'packaged-candidate-json-reviver-forges-outcome',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /const\s+common\s*=\s*\{/,
      'matches[0] = {\n' +
        '      ...matches[0],\n' +
        '      signaling: {\n' +
        '        ...(matches[0].signaling || {}),\n' +
        '        local_candidates_sent: 1,\n' +
        '        local_candidate_send_failures: 0\n' +
        '      }\n' +
        '    };\n' +
        '    const common = {',
      'packaged-candidate-matches-array-replaces-frozen-peer',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'JSON.parse = new Proxy(JSON.parse, {\n' +
        '  apply(target, thisArg, args) {\n' +
        '    const value = Reflect.apply(target, thisArg, args);\n' +
        '    for (const peer of value.peers || []) {\n' +
        '      peer.signaling = { ...(peer.signaling || {}), ' +
        'local_candidates_sent: 1, local_candidate_send_failures: 0 };\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '});\n\nfunction readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-json-parse-is-proxied',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'const candidateJsonOwner = JSON;\n' +
        'candidateJsonOwner.parse = () => ({ peers: [] });\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-aliased-json-parse-is-reassigned',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      "Object.defineProperty(JSON, 'parse', { value: () => ({ peers: [] }) });\n\n" +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-json-parse-is-redefined',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'let candidateJsonOwner;\n' +
        'candidateJsonOwner = JSON;\n' +
        'const candidateOriginalParse = candidateJsonOwner.parse;\n' +
        'candidateJsonOwner.parse = (text) => {\n' +
        '  const value = candidateOriginalParse(text);\n' +
        '  for (const peer of value.peers || []) {\n' +
        '    peer.signaling = { ...(peer.signaling || {}), ' +
        'local_candidates_sent: 1, local_candidate_send_failures: 0 };\n' +
        '  }\n' +
        '  return value;\n' +
        '};\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-assignment-alias-reassigns-json-parse',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'globalThis.JSON.parse = new Proxy(globalThis.JSON.parse, {\n' +
        '  apply(target, thisArg, args) {\n' +
        '    const value = Reflect.apply(target, thisArg, args);\n' +
        '    for (const peer of value.peers || []) {\n' +
        '      peer.signaling = { ...(peer.signaling || {}), ' +
        'local_candidates_sent: 1, local_candidate_send_failures: 0 };\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '});\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-global-this-json-parse-is-proxied',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'const { JSON: candidateJsonOwner } = globalThis;\n' +
        'const candidateOriginalParse = candidateJsonOwner.parse;\n' +
        'candidateJsonOwner.parse = new Proxy(candidateOriginalParse, {\n' +
        '  apply(target, thisArg, args) {\n' +
        '    const value = Reflect.apply(target, thisArg, args);\n' +
        '    for (const peer of value.peers || []) {\n' +
        '      peer.signaling = { ...(peer.signaling || {}), ' +
        'local_candidates_sent: 1, local_candidate_send_failures: 0 };\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '});\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-destructured-global-json-alias',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'const candidateOriginalParse = JSON.parse;\n' +
        'let candidateDefineProperty;\n' +
        'candidateDefineProperty = Object.defineProperty;\n' +
        "candidateDefineProperty(JSON, 'parse', { value: new Proxy(candidateOriginalParse, {\n" +
        '  apply(target, thisArg, args) {\n' +
        '    const value = Reflect.apply(target, thisArg, args);\n' +
        '    for (const peer of value.peers || []) {\n' +
        '      peer.signaling = { ...(peer.signaling || {}), ' +
        'local_candidates_sent: 1, local_candidate_send_failures: 0 };\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '}) });\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-assignment-mutator-alias-redefines-json-parse',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateOnce(
      source,
      /function readDiagnosticsPeerSnapshot\(diagnosticsPath, uuid\) \{/,
      'Array.prototype.filter = new Proxy(Array.prototype.filter, {\n' +
        '  apply(target, thisArg, args) {\n' +
        '    const values = Reflect.apply(target, thisArg, args);\n' +
        '    return values.map((entry) => entry && entry.signaling ? {\n' +
        '      ...entry,\n' +
        '      signaling: { ...entry.signaling, local_candidates_sent: 1, ' +
        'local_candidate_send_failures: 0 }\n' +
        '    } : entry);\n' +
        '  }\n' +
        '});\n\n' +
        'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {',
      'packaged-candidate-array-filter-is-proxied',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /const\s+peer\s*=\s*matches\[0\];\s*const\s+signaling\s*=\s*deepFreezeDiagnosticsSnapshot\(\{\s*\.\.\.\(peer\.signaling\s*\|\|\s*\{\}\)\s*\}\);\s*const\s+activeWireSessionSource\s*=/,
      'const peer = matches[0];\n' +
        '    const signaling = deepFreezeDiagnosticsSnapshot({\n' +
        '      ...(peer.signaling || {})\n' +
        '    });\n' +
        '    Object.assign(signaling, { local_candidates_sent: 1, ' +
        'local_candidate_send_failures: 0 });\n' +
        '    const activeWireSessionSource =',
      'packaged-candidate-frozen-signaling-is-mutated',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /const\s+peer\s*=\s*matches\[0\];\s*const\s+signaling\s*=\s*deepFreezeDiagnosticsSnapshot\(\{\s*\.\.\.\(peer\.signaling\s*\|\|\s*\{\}\)\s*\}\);\s*const\s+activeWireSessionSource\s*=/,
      'const peer = matches[0];\n' +
        '    const signaling = deepFreezeDiagnosticsSnapshot({\n' +
        '      ...(peer.signaling || {}),\n' +
        '      local_candidates_sent: 1,\n' +
        '      local_candidate_send_failures: 0\n' +
        '    });\n' +
        '    const activeWireSessionSource =',
      'packaged-candidate-signaling-binding-forges-outcome',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'waitForDiagnosticsPeerSnapshot',
      /predicate\(snapshot\)/,
      'predicate({ ...snapshot, signaling: { ...snapshot.signaling } })',
      'packaged-candidate-predicate-receives-mutable-clone',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'candidateOutcomeSnapshotReady',
      /Number\(snapshot\.signaling\.local_candidates_sent \|\| 0\) > 0/,
      'Number(snapshot.signaling.local_candidates_sent || 0) > 0 && ' +
        '((snapshot.signaling.local_candidate_send_failures = 0) === 0)',
      'packaged-candidate-wait-predicate-forges-failure-field',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'candidateOutcomeSnapshotReady',
      /Number\(snapshot\.signaling\.local_candidates_sent \|\| 0\) > 0/,
      'Number(snapshot.signaling.local_candidates_sent || 0) > 0 && ' +
        '(Object.defineProperties(snapshot.signaling, ' +
        '{ local_candidate_send_failures: { value: 0 } }), true)',
      'packaged-candidate-wait-predicate-define-properties-forges-failure-field',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /\(snapshot\)\s*=>\s*candidateOutcomeSnapshotReady\(\s*snapshot\s*,\s*activeDuplicateOffer\.message\.session\s*\)/,
      '(snapshot) => true',
      'packaged-candidate-canonical-readiness-helper-is-bypassed',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /Number\.isSafeInteger\(observedLocalCandidateSendFailures\)/,
      'true',
      'packaged-candidate-send-failure-type-check-is-bypassed',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /Number\.isSafeInteger\(observedLocalCandidatesSent\)/,
      'true',
      'packaged-candidate-send-success-type-check-is-bypassed',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /observedLocalCandidateSendFailures\s*===\s*0/,
      'observedLocalCandidateSendFailures >= 0',
      'packaged-candidate-send-failure-verdict-allows-failures',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /observedLocalCandidatesSent\s*>\s*0/,
      'observedLocalCandidatesSent >= 0',
      'packaged-candidate-send-success-verdict-allows-no-sends',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /candidateFailureFieldPresent\s*&&/,
      'true &&',
      'packaged-candidate-send-failure-field-presence-is-bypassed',
      'PACKAGED_LOCAL_CANDIDATE_SEND_OUTCOME_IS_PROVEN'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /first\.message\.session\s*!==\s*duplicateRequestSessionA/,
      'first.message.session === duplicateRequestSessionA',
      'initial-offer-echoes-request-session',
      'INITIAL_WIRE_SESSION_IS_PUBLISHER_GENERATED_AND_UUID_SCOPED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /second\.message\.session\s*!==\s*duplicateRequestSessionB/,
      'second.message.session === duplicateRequestSessionB',
      'duplicate-safe-replacement-echoes-second-request-session',
      'INITIAL_WIRE_SESSION_IS_PUBLISHER_GENERATED_AND_UUID_SCOPED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /second\.message\.session\s*!==\s*first\.message\.session\s*&&/,
      'second.message.session === first.message.session &&',
      'unresolved-duplicate-reuses-offer-a-session',
      'UNRESOLVED_DUPLICATE_RECHECK_IS_DELAYED_AND_REPLACES_EXACTLY_ONCE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /earlyDuplicateOffers\.length\s*===\s*0/,
      'earlyDuplicateOffers.length >= 0',
      'unresolved-duplicate-allows-early-offer',
      'UNRESOLVED_DUPLICATE_RECHECK_IS_DELAYED_AND_REPLACES_EXACTLY_ONCE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /duplicateReplacementOffers\.length\s*===\s*1/,
      'duplicateReplacementOffers.length >= 1',
      'unresolved-duplicate-allows-multiple-replacement-offers',
      'UNRESOLVED_DUPLICATE_RECHECK_IS_DELAYED_AND_REPLACES_EXACTLY_ONCE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /duplicateReplacementElapsedMs\s*>=\s*duplicateNoEarlyOfferObservationMs/,
      'duplicateReplacementElapsedMs >= 0',
      'unresolved-duplicate-delay-lower-bound-bypassed',
      'UNRESOLVED_DUPLICATE_RECHECK_IS_DELAYED_AND_REPLACES_EXACTLY_ONCE'
    ),
    mutateFunction(
      source,
      'exactDuplicateOfferRecheckLines',
      /logHasExactToken\(line,\s*`clientGeneration=\$\{identity\.clientGeneration\}`\)/,
      'true',
      'duplicate-recheck-log-drops-client-generation-identity',
      'DUPLICATE_RECHECK_LOGS_BIND_EXACT_OFFER_A_IDENTITY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /scheduledDuplicateRechecks\.length\s*===\s*1/,
      'scheduledDuplicateRechecks.length >= 1',
      'duplicate-recheck-allows-multiple-schedules',
      'DUPLICATE_RECHECK_LOGS_BIND_EXACT_OFFER_A_IDENTITY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /connectedDuringRecheckOffers\.length\s*===\s*0/,
      'connectedDuringRecheckOffers.length >= 0',
      'connected-recheck-allows-replacement-offer',
      'DUPLICATE_RECHECK_IGNORES_PEER_CONNECTED_BEFORE_DEADLINE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /connectedRecheckCancellations\.length\s*===\s*1/,
      'connectedRecheckCancellations.length >= 1',
      'connected-recheck-allows-ambiguous-cancellation',
      'DUPLICATE_RECHECK_IGNORES_PEER_CONNECTED_BEFORE_DEADLINE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+preAnswerOfferUsable\s*=\s*!!preAnswerOfferAUfrag\s*&&\s*!!preAnswerOfferA\.message\.session\s*;/,
      'const preAnswerOfferUsable = !!preAnswerOfferAUfrag &&\n        !!preAnswerOfferA.message.session &&\n        preAnswerOfferA.message.session !== preAnswerRestartSession;',
      'pre-answer-echo-short-circuits-downstream-probe',
      'PRE_ANSWER_PRODUCT_FAILURE_PRESERVES_DOWNSTREAM_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*preAnswerOfferUsable\s*\)\s*\{/,
      'if (preAnswerOfferA.message.session === preAnswerRestartSession) {\n        return;\n      }\n      if (preAnswerOfferUsable) {',
      'pre-answer-echo-returns-before-independent-scenarios',
      'PRE_ANSWER_PRODUCT_FAILURE_PRESERVES_DOWNSTREAM_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*preAnswerOfferUsable\s*\)\s*\{/,
      'if (preAnswerOfferA.message.session === preAnswerRestartSession) return;\n      if (preAnswerOfferUsable) {',
      'pre-answer-alternate-condition-braceless-return',
      'PRE_ANSWER_PRODUCT_FAILURE_PRESERVES_DOWNSTREAM_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+restartRequestAt\s*=\s*Date\.now\(\)\s*;/,
      'return;\n      const restartRequestAt = Date.now();',
      'pre-answer-unconditional-return-before-independent-scenarios',
      'PRE_ANSWER_PRODUCT_FAILURE_PRESERVES_DOWNSTREAM_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /productRestartOfferBElapsedMs\s*<\s*preAnswerRestartImmediateDeadlineMs/,
      'productRestartOfferBElapsedMs >= 0',
      'pre-answer-restart-immediate-deadline-bypassed',
      'PRE_ANSWER_WSS_RESTART_CREATES_FRESH_PC_SESSION_SDP_AND_UFRAG'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /productRestartOffers\.length\s*===\s*1/,
      'productRestartOffers.length >= 1',
      'pre-answer-restart-allows-multiple-offer-b-results',
      'PRE_ANSWER_WSS_RESTART_CREATES_FRESH_PC_SESSION_SDP_AND_UFRAG'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /productRestartOfferB\.message\.session\s*!==\s*preAnswerOfferA\.message\.session/,
      'productRestartOfferB.message.session === preAnswerOfferA.message.session',
      'pre-answer-restart-allows-cached-a-session',
      'PRE_ANSWER_WSS_RESTART_CREATES_FRESH_PC_SESSION_SDP_AND_UFRAG'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /forbiddenCachedRestartLines\.length\s*===\s*0/,
      'forbiddenCachedRestartLines.length >= 0',
      'pre-answer-restart-allows-cached-replay-log',
      'PRE_ANSWER_WSS_RESTART_CREATES_FRESH_PC_SESSION_SDP_AND_UFRAG'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /staleAForbiddenCandidateRoutingLines\.length\s*===\s*0/,
      'staleAForbiddenCandidateRoutingLines.length >= 0',
      'pre-answer-stale-a-candidate-routing-proof-bypassed',
      'PRE_ANSWER_RESTART_STALE_A_CANNOT_CROSS_EXACT_B_WORKFLOW'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /preAnswerBConnected\.ok\s*&&\s*\n\s*preAnswerBMedia\.ok\s*;/,
      'preAnswerBConnected.ok || true;\n          void preAnswerBMedia;',
      'pre-answer-exact-b-media-verdict-forced-true',
      'PRE_ANSWER_RESTART_STALE_A_CANNOT_CROSS_EXACT_B_WORKFLOW'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*!freshPreAnswerRestartVerdict\s*\)/,
      'if (false && !freshPreAnswerRestartVerdict)',
      'pre-answer-restart-product-failure-recovery-disabled',
      'PRE_ANSWER_RESTART_FAILURE_RECOVERY_DOES_NOT_HIDE_RED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /candidate\.sourceGenerationUfrag\s*===\s*answerAUfrag/,
      'candidate.sourceGenerationUfrag === answerBUfrag',
      'generation-b-mislabeled-as-generation-a',
      'STALE_CANDIDATE_SOURCE_PROVENANCE'
    ),
    mutateFunction(
      source,
      'sendExactBrowserCandidate',
      /candidate\s*:\s*wire/,
      'candidate: { ...wire, usernameFragment: candidate.sourceGenerationUfrag }',
      'synthetic-firefox-ufrag',
      'STALE_CANDIDATE_WIRE_FIDELITY'
    ),
    mutateFunction(
      source,
      'browserCandidateWireSha256',
      /update\(canonicalBrowserCandidateFingerprint\(candidate\),\s*['"]utf8['"]\)/,
      'update(canonicalBrowserCandidateWire(candidate), \'utf8\')',
      'candidate-fingerprint-depends-on-browser-object-order',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'canonicalCandidateFingerprintScalar',
      /Buffer\.byteLength\(text,\s*['"]utf8['"]\)/,
      'text.length',
      'candidate-fingerprint-uses-utf16-length',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'canonicalCandidateFingerprintScalar',
      /typeof\s+value\s*===\s*['"]boolean['"]\s*\?\s*['"]b['"]\s*:\s*['"]s['"]/,
      "typeof value === 'boolean' ? 's' : 's'",
      'candidate-fingerprint-collides-boolean-with-string',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'browserCandidateFingerprintCoversWire',
      /Object\.keys\(wire\)\.every/,
      'Object.keys(wire).some',
      'candidate-fingerprint-allows-unaccounted-wire-key',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'browserCandidateFingerprintCoversWire',
      /typeof\s+wire\.candidate\s*===\s*['"]string['"]\s*&&\s*wire\.candidate\.length\s*>\s*0/,
      'true',
      'candidate-fingerprint-allows-missing-candidate-field',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'browserCandidateFingerprintCoversWire',
      /Number\.isInteger\(wire\.sdpMLineIndex\)/,
      'Number.isFinite(wire.sdpMLineIndex)',
      'candidate-fingerprint-allows-noninteger-mline-index',
      'CANDIDATE_REJECTION_FINGERPRINT_IS_CROSS_LANGUAGE_CANONICAL'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /\[Signaling\] Queued remote ICE candidate uuid=/,
      '[Signaling] Queued remote ICE candidate before peer session ready',
      'dead-queue-log-matcher',
      'STALE_CANDIDATE_QUEUE_OBSERVABILITY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /generation-a-candidate-is-not-drained-or-applied-to-offer-b/,
      'generation-a-candidate-post-answer-proof-removed',
      'missing-post-answer-candidate-proof',
      'STALE_CANDIDATE_POST_ANSWER_NON_APPLICATION_PROOF'
    ),
    mutateFunction(
      source,
      'logHasExactToken',
      /return\s+pattern\.test\(String\(line\s*\|\|\s*['"]['"]\)\);/,
      "return String(line || '').includes(token);",
      'exact-log-token-matcher-allows-suffix-collision',
      'EXACT_REJECTION_LOG_IDENTITY_TOKENS_ARE_BOUNDARY_MATCHED'
    ),
    mutateFunction(
      source,
      'signalLineIdentifiesPeer',
      /logHasExactToken\(line,\s*`uuid=\$\{uuid\}`\)/,
      'String(line).includes(`uuid=${uuid}`)',
      'peer-log-identity-allows-uuid-suffix-collision',
      'EXACT_REJECTION_LOG_IDENTITY_TOKENS_ARE_BOUNDARY_MATCHED'
    ),
    mutateFunction(
      source,
      'signalLineIdentifiesSha256',
      /logHasExactToken\(String\(line\s*\|\|\s*['"]['"]\)\.toLowerCase\(\),\s*`sha256=\$\{expected\}`\)/,
      "String(line || '').toLowerCase().includes(`sha256=${expected}`)",
      'hash-log-identity-allows-suffix-collision',
      'EXACT_REJECTION_LOG_IDENTITY_TOKENS_ARE_BOUNDARY_MATCHED'
    ),
    mutateFunction(
      source,
      'explicitStaleCandidateRejectionLines',
      /signalLineIdentifiesPeer\(line,\s*uuid,\s*wireSession\)/,
      'true',
      'uncorrelated-firefox-candidate-rejection',
      'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'explicitStaleCandidateRejectionLines',
      /signalLineIdentifiesSha256\(line,\s*candidateSha256\)/,
      'true',
      'candidate-rejection-ignores-payload-fingerprint',
      'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /explicitStaleCandidateRejectionLines\(\s*staleCandidateOutput,\s*staleUuid,\s*offerA\.message\.session,\s*staleCandidateACandidateSha256/,
      'explicitStaleCandidateRejectionLines(\n            staleCandidateOutput,\n            staleUuid,\n            offerA.message.session,\n            activeCandidateBCandidateSha256',
      'stale-candidate-rejection-matches-active-payload-hash',
      'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /staleCandidateAWireSha256\s*!==\s*activeCandidateBWireSha256/,
      'staleCandidateAWireSha256 === activeCandidateBWireSha256',
      'candidate-fingerprint-distinctness-not-proven',
      'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'explicitStaleAnswerRejectionLines',
      /signalLineIdentifiesPeer\(line,\s*uuid,\s*wireSession\)/,
      'true',
      'answer-rejection-ignores-peer-identity',
      'STALE_ANSWER_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'sendAnswer',
      /description:\s*\{\s*type:\s*['"]answer['"],\s*sdp\s*\}/,
      "description: { type: 'answer', sdp: '' }",
      'send-answer-drops-exact-sdp-fixture',
      'SEND_ANSWER_FORWARDS_EXACT_SDP'
    ),
    mutateFunction(
      source,
      'waitForPublisherOutput',
      /const\s+output\s*=\s*publisher\.output\(\)\.slice\(afterOffset\)/,
      'const output = publisher.output()',
      'stale-answer-poll-reads-pre-event-output',
      'STALE_ANSWER_REJECTION_WAITS_FOR_EVENT_AND_FRESH_COUNTERS'
    ),
    mutateFunction(
      source,
      'waitForPublisherOutput',
      /output:\s*publisher\.output\(\)\.slice\(afterOffset\)/,
      'output: publisher.output()',
      'stale-answer-timeout-returns-pre-event-output',
      'STALE_ANSWER_REJECTION_WAITS_FOR_EVENT_AND_FRESH_COUNTERS'
    ),
    mutateFunction(
      source,
      'waitForPublisherOutput',
      /await\s+wait\(25\)/,
      'await wait(0)',
      'stale-answer-poll-delay-removed',
      'STALE_ANSWER_REJECTION_WAITS_FOR_EVENT_AND_FRESH_COUNTERS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+staleAnswerObservationTimeoutMs\s*=\s*4000/,
      'const staleAnswerObservationTimeoutMs = 1',
      'stale-answer-observation-window-collapsed',
      'STALE_ANSWER_REJECTION_WAITS_FOR_EVENT_AND_FRESH_COUNTERS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /explicitStaleAnswerRejectionLines\(\s*mislabeledActiveAnswerOutput,\s*staleUuid,\s*offerA\.message\.session/,
      'explicitStaleAnswerRejectionLines(\n            mislabeledActiveAnswerOutput,\n            staleUuid,\n            offerB.message.session',
      'mislabeled-answer-rejection-matches-active-session',
      'STALE_ANSWER_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /answerASdpSha256\s*!==\s*answerBSdpSha256/,
      'answerASdpSha256 === answerBSdpSha256',
      'answer-fingerprint-distinctness-not-proven',
      'STALE_ANSWER_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /productOfferB\.message\.session\s*!==\s*offerA\.message\.session/,
      'true',
      'rebuild-wire-session-rotation-bypass',
      'REBUILT_TRANSPORT_ROTATES_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*!productOfferB\s*\|\|\s*!distinctGenerations\s*\|\|\s*productOfferB\.message\.session\s*===\s*offerA\.message\.session\s*\)/,
      'if (false && (!productOfferB || !distinctGenerations ||\n            productOfferB.message.session === offerA.message.session))',
      'offer-b-product-failure-skips-fixture-recovery',
      'OFFER_B_PRODUCT_FAILURE_PRESERVES_GENERATION_PROBE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /activeOfferBDistinctGeneration\s*&&\s*offerB\.message\.session\s*!==\s*offerA\.message\.session/,
      'activeOfferBDistinctGeneration && true',
      'offer-b-active-session-distinctness-bypassed',
      'OFFER_B_PRODUCT_FAILURE_PRESERVES_GENERATION_PROBE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*offerB\s*&&\s*activeOfferBDistinctGeneration\s*\)/,
      'if (offerB && distinctGenerations)',
      'offer-b-recovery-does-not-reach-generation-probe',
      'OFFER_B_PRODUCT_FAILURE_PRESERVES_GENERATION_PROBE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+ownsOnlyActiveOfferB\s*=\s*\(snapshot\)\s*=>\s*!!snapshot\s*&&\s*snapshot\.peerCount\s*===\s*1\s*&&\s*snapshot\.activeWireSession\s*===\s*offerB\.message\.session\s*&&\s*snapshot\.signaling\.answer_received\s*===\s*false\s*;/,
      'const ownsOnlyActiveOfferB = (snapshot) => !!snapshot &&\n          snapshot.peerCount >= 1;',
      'sessionless-baseline-accepts-duplicate-or-wrong-owner',
      'SESSIONLESS_PROBE_STARTS_WITH_SINGLE_ACTIVE_OFFER_B_OWNER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /ownsOnlyActiveOfferB\(preSessionlessOfferBOwner\)/,
      'true',
      'sessionless-baseline-owner-verdict-bypassed',
      'SESSIONLESS_PROBE_STARTS_WITH_SINGLE_ACTIVE_OFFER_B_OWNER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+expectedActiveOfferCount\s*=\s*offerBFixtureRecoveryUsed\s*\?\s*1\s*:\s*2/,
      'const expectedActiveOfferCount = 2',
      'offer-b-replacement-inherits-retired-offer-count',
      'OFFER_B_DIAGNOSTICS_BASELINE_FOLLOWS_ACTIVE_OWNER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(const\s+candidateCounterBefore\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]{0,160}?\(snapshot\)\s*=>\s*)snapshot\.activeWireSession\s*===\s*offerB\.message\.session\s*&&/,
      '$1true &&',
      'offer-b-diagnostics-allows-wrong-active-owner',
      'OFFER_B_DIAGNOSTICS_BASELINE_FOLLOWS_ACTIVE_OWNER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /Number\(snapshot\.signaling\.offer_count\s*\|\|\s*0\)\s*===\s*expectedActiveOfferCount/,
      'Number(snapshot.signaling.offer_count || 0) >= 1',
      'offer-b-diagnostics-allows-aggregate-offer-count',
      'OFFER_B_DIAGNOSTICS_BASELINE_FOLLOWS_ACTIVE_OWNER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+validAnswerB\s*=\s*await\s+answerOffer\(\s*page,\s*stalePeerName/,
      "const validAnswerB = await answerOffer(\n            page, 'older-generation-b'",
      'stale-rebuild-keeps-two-browser-peers',
      'REBUILD_PATHS_REPLACE_ONE_BROWSER_PEER_PER_UUID'
    ),
    mutateFunction(
      source,
      'runDirectStunScenario',
      /const\s+recoveryAnswer\s*=\s*await\s+answerOffer\(\s*page,\s*delayedPeerName/,
      "const recoveryAnswer = await answerOffer(\n      page, 'delayed-recovered-peer'",
      'delayed-recovery-keeps-two-browser-peers',
      'REBUILD_PATHS_REPLACE_ONE_BROWSER_PEER_PER_UUID'
    ),
    mutateFunction(
      source,
      'createBrowserPeerPage',
      /state\.pc\.close\(\)/,
      'Promise.resolve()',
      'browser-rebind-does-not-close-retired-peer',
      'REBUILD_PATHS_REPLACE_ONE_BROWSER_PEER_PER_UUID'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /validAnswerB\.peerInstanceId\s*!==\s*validAnswerA\.peerInstanceId/,
      'true',
      'browser-peer-instance-replacement-proof-bypassed',
      'REBUILD_PATHS_REPLACE_ONE_BROWSER_PEER_PER_UUID'
    ),
    mutateFunction(
      source,
      'createBrowserPeerPage',
      /messageSession\s*!==\s*state\.wireSession/,
      'false',
      'publisher-candidate-session-filter-bypass',
      'PUBLISHER_CANDIDATE_ROUTING_IS_WIRE_SESSION_SCOPED'
    ),
    mutateFunction(
      source,
      'connectNewPeer',
      /activeSession\s*===\s*requestSessionHint/,
      'activeSession !== requestSessionHint',
      'initial-session-hint-echo-accepted',
      'CONNECT_NEW_PEER_SEPARATES_REQUEST_HINT_FROM_ACTIVE_SESSION'
    ),
    mutateFunction(
      source,
      'connectNewPeer',
      /ok:\s*connected\.ok\s*&&\s*media\.ok/,
      'ok: sessionContractOk && connected.ok && media.ok',
      'session-contract-failure-short-circuits-workflow',
      'SESSION_CONTRACT_FAILURE_DOES_NOT_SHORT_CIRCUIT_WORKFLOW'
    ),
    mutateFunction(
      source,
      'remoteFirstRestart',
      /const\s+activeSession\s*=\s*offer\.message\.session/,
      'const activeSession = previousActiveSession',
      'restart-response-reuses-retired-session',
      'REMOTE_FIRST_RESTART_USES_ROTATED_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'remoteFirstRestart',
      /const\s+reuseBrowserPeer\s*=\s*!sessionRotated/,
      'const reuseBrowserPeer = true',
      'restart-reuses-browser-peer',
      'REMOTE_FIRST_RESTART_REPLACES_BROWSER_PEER'
    ),
    mutateFunction(
      source,
      'remoteFirstRestart',
      /signal\.send\(\{\s*UUID:\s*uuid,\s*session:\s*requestSessionHint/,
      'signal.send({ UUID: uuid, session: previousActiveSession',
      'restart-request-keyed-by-active-session',
      'RESTART_REQUEST_HINT_IS_UUID_SCOPED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /session:\s*ignoredPreAnswerRestartHint/,
      'session: preAnswerOfferA.message.session',
      'runtime-restart-request-uses-active-session',
      'RESTART_REQUEST_HINT_IS_UUID_SCOPED'
    ),
    mutateFunction(
      source,
      'runAutoIceScenario',
      /target\.session\s*=\s*restart\.activeSession/,
      'target.session = target.session',
      'restart-caller-keeps-original-session',
      'RESTART_CALLERS_ADVANCE_ACTIVE_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'runAutoIceScenario',
      /if\s*\(\s*!restart\.ok\s*\)/,
      'if (false && !restart.ok)',
      'auto-restart-failure-skips-fixture-recovery',
      'AUTO_RESTART_FAILURE_PRESERVES_LATER_CYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runAutoIceScenario',
      /target\.initialActiveSession\s*!==\s*target\.session/,
      'true',
      'auto-retired-hint-live-session-distinctness-bypassed',
      'AUTO_RESTART_FAILURE_PRESERVES_LATER_CYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'recoverScenarioPeer',
      /recovery\.activeSession\s*!==\s*brokenSession/,
      'true',
      'auto-recovery-allows-reused-broken-session',
      'AUTO_RESTART_FAILURE_PRESERVES_LATER_CYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /const\s+replacementBaseline\s*=\s*requiredMediaCounters\(replacementMediaReady\.state\)/,
      'const replacementBaseline = beforeReset',
      'replacement-media-uses-old-peer-baseline',
      'REPLACEMENT_MEDIA_BASELINE_IS_POST_REBUILD'
    ),
    mutateFunction(
      source,
      'readDiagnosticsPeerSnapshot',
      /matches\.length\s*!==\s*1/,
      'matches.length < 1',
      'diagnostics-allows-duplicate-uuid-peers',
      'DIAGNOSTICS_PEER_SELECTION_IS_UUID_SCOPED_AND_UNIQUE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /duplicatePeerSnapshot\.peerCount\s*===\s*1/,
      'duplicatePeerSnapshot.peerCount >= 1',
      'runtime-diagnostics-allows-duplicate-uuid-peers',
      'DIAGNOSTICS_PEER_SELECTION_IS_UUID_SCOPED_AND_UNIQUE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /duplicatePeerSnapshot\.uuidOwnerHighWatermark\s*===\s*1/,
      'duplicatePeerSnapshot.uuidOwnerHighWatermark >= 1',
      'runtime-diagnostics-allows-transient-duplicate-owner',
      'DIAGNOSTICS_PEER_SELECTION_IS_UUID_SCOPED_AND_UNIQUE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /snapshot\.generatedSteadyMs\s*>\s*preDuplicatePeerSnapshot\.generatedSteadyMs/,
      'true',
      'runtime-diagnostics-accepts-pre-request-snapshot',
      'DIAGNOSTICS_PEER_SELECTION_IS_UUID_SCOPED_AND_UNIQUE'
    ),
    mutateFunction(
      source,
      'remoteFirstRestart',
      /previousBrowserWireSession\s*===\s*previousActiveSession/,
      'true',
      'restart-caller-browser-session-mismatch-accepted',
      'RESTART_BASELINE_IS_ACTUAL_BROWSER_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /UUID:\s*staleUuid,\s*session:\s*offerA\.message\.session,\s*streamID:\s*streamId,\s*iceRestartRequest:\s*true/,
      'UUID: staleUuid,\n          session: offerB.message.session,\n          streamID: streamId,\n          iceRestartRequest: true',
      'retired-stale-peer-restart-hint-not-exercised',
      'RETIRED_SESSION_HINTS_REMAIN_UUID_SCOPED_CONTROLS'
    ),
    mutateFunction(
      source,
      'runAutoIceScenario',
      /cycle\s*>=\s*peers\.length\s*\?\s*target\.initialActiveSession\s*:\s*target\.session/,
      'cycle >= peers.length ? target.session : target.session',
      'retired-restart-request-hint-not-exercised',
      'RETIRED_SESSION_HINTS_REMAIN_UUID_SCOPED_CONTROLS'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /session:\s*cleanupRetiredSession,\s*streamID:\s*streamId\s*\}\);\s*let\s+removed\s*=\s*false/,
      'session: removedActiveSession,\n      streamID: streamId\n    });\n    let removed = false',
      'retired-cleanup-request-hint-not-exercised',
      'RETIRED_SESSION_HINTS_REMAIN_UUID_SCOPED_CONTROLS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sendExactBrowserCandidate\(\s*signal,\s*staleUuid,\s*offerA\.message\.session,\s*activeCandidateB/,
      'sendExactBrowserCandidate(\n            signal,\n            staleUuid,\n            offerB.message.session,\n            activeCandidateB',
      'active-candidate-retired-session-label-not-exercised',
      'ANSWER_AND_CANDIDATE_SESSION_GUARDS_ARE_CONTENT_INDEPENDENT'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sendAnswer\(\s*signal,\s*staleUuid,\s*streamId,\s*offerA\.message\.session,\s*validAnswerB\.sdp/,
      'sendAnswer(\n            signal,\n            staleUuid,\n            streamId,\n            offerB.message.session,\n            validAnswerB.sdp',
      'active-answer-retired-session-label-not-exercised',
      'ANSWER_AND_CANDIDATE_SESSION_GUARDS_ARE_CONTENT_INDEPENDENT'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sendExactBrowserCandidate\(\s*signal,\s*staleUuid,\s*offerB\.message\.session,\s*activeCandidateB/,
      'sendExactBrowserCandidate(\n            signal,\n            staleUuid,\n            offerA.message.session,\n            activeCandidateB',
      'active-candidate-correct-session-label-not-exercised',
      'ANSWER_AND_CANDIDATE_SESSION_GUARDS_ARE_CONTENT_INDEPENDENT'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sendAnswer\(signal,\s*staleUuid,\s*streamId,\s*offerB\.message\.session,\s*validAnswerB\.sdp\)/,
      'sendAnswer(signal, staleUuid, streamId, offerA.message.session, validAnswerB.sdp)',
      'active-answer-correct-session-label-not-exercised',
      'ANSWER_AND_CANDIDATE_SESSION_GUARDS_ARE_CONTENT_INDEPENDENT'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /explicitStaleAnswerRejectionLines\(\s*staleApplyOutput,\s*staleUuid,\s*offerA\.message\.session\s*\)/,
      'explicitStaleAnswerRejectionLines(\n            staleApplyOutput,\n            staleUuid,\n            offerB.message.session\n          )',
      'retired-answer-rejection-is-not-exactly-correlated',
      'STALE_ANSWER_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /\(snapshot\)\s*=>\s*Number\(\s*snapshot\.signaling\.remote_candidates_applied\s*\)\s*===\s*appliedAfterMislabeledActiveCandidate\s*\+\s*1/,
      '(snapshot) => Number(\n              snapshot.signaling.remote_candidates_applied\n            ) >= appliedAfterMislabeledActiveCandidate + 1',
      'isolated-active-candidate-allows-aggregate-growth',
      'ACTIVE_CANDIDATE_APPLICATION_IS_ISOLATED_BEFORE_REMAINDER'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sendAnswer\(signal,\s*staleUuid,\s*streamId,\s*offerB\.message\.session,\s*validAnswerB\.sdp\);/,
      'sendBrowserCandidates(\n            signal,\n            staleUuid,\n            offerB.message.session,\n            remainingActiveCandidatesB\n          );\n          sendAnswer(signal, staleUuid, streamId, offerB.message.session, validAnswerB.sdp);',
      'remaining-active-candidates-sent-before-isolated-measurement',
      'ACTIVE_CANDIDATE_APPLICATION_IS_ISOLATED_BEFORE_REMAINDER'
    ),
    mutateFunction(
      source,
      'enableAlphaAndVerifyMedia',
      /liveAlphaState\.wireSession\s*===\s*session/,
      'true',
      'alpha-browser-session-ownership-bypassed',
      'ALPHA_CALLER_OWNS_CURRENT_BROWSER_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /postCleanupSnapshot\.peerCount\s*===\s*0/,
      'true',
      'cleanup-zero-owner-proof-bypassed',
      'CLEANUP_READD_DIAGNOSTICS_PROVE_SINGLE_UUID_OWNER'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /postReaddSnapshot\.peerCount\s*===\s*1/,
      'postReaddSnapshot.peerCount >= 1',
      'readd-single-owner-proof-bypassed',
      'CLEANUP_READD_DIAGNOSTICS_PROVE_SINGLE_UUID_OWNER'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /snapshot\.fileMtimeMs\s*>=\s*removalStarted/,
      'true',
      'cleanup-diagnostics-freshness-bypassed',
      'CLEANUP_READD_DIAGNOSTICS_PROVE_SINGLE_UUID_OWNER'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /cleanupRetiredSession\s*!==\s*secondary\.session/,
      'true',
      'cleanup-retired-hint-distinctness-bypassed',
      'CLEANUP_RETIRED_HINT_IS_PROVEN_DISTINCT_FROM_LIVE_OWNER'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /addCheck\(report,\s*['"]default-output-tone-is-captured-as-nonzero-audio['"]/,
      "requireHarnessFixture(report, 'default-output-tone-is-captured-as-nonzero-audio'",
      'zero-audio-is-misclassified-as-harness-failure',
      'ZERO_AUDIO_PRODUCT_FAILURE_PRESERVES_LIFECYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /const\s+lifecycleMediaIsNonzero\s*=/,
      'if (!lifecycleRequiresAudio) {\n      return;\n    }\n    const lifecycleMediaIsNonzero =',
      'zero-audio-returns-before-cleanup-and-readd',
      'ZERO_AUDIO_PRODUCT_FAILURE_PRESERVES_LIFECYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /if\s*\(\s*!primaryAlpha\.workflowOk\s*\)/,
      'if (!primaryAlpha.ok)',
      'zero-audio-primary-gate-skips-lifecycle-recovery',
      'ZERO_AUDIO_PRODUCT_FAILURE_PRESERVES_LIFECYCLE_COVERAGE'
    ),
    mutateFunction(
      source,
      'enableAlphaAndVerifyMedia',
      /lateOffer\.message\.session\s*!==\s*initialOffer\.message\.session/,
      'false',
      'alpha-renegotiation-session-rotation-accepted',
      'ALPHA_RENEGOTIATION_RETAINS_ACTIVE_WIRE_SESSION'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /readdedConnection\.activeSession\s*!==\s*removedActiveSession/,
      'true',
      'readd-reuses-retired-publisher-session',
      'UUID_SCOPED_CLEANUP_READD_ROTATES_PUBLISHER_SESSION'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /cleanupRetiredSession\s*!==\s*cleanupActiveConnection\.activeSession/,
      'true',
      'cleanup-remove-readd-session-rotation-bypassed',
      'CLEANUP_RETIRED_SESSION_IS_CREATED_BY_REMOVE_READD'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /session:\s*cleanupRetiredSession,\s*streamID:\s*streamId\s*\}\);\s*let\s+cleanupSetupRemovalLogObserved\s*=\s*false/,
      'session: cleanupReplacementRequestHint,\n      streamID: streamId\n    });\n    let cleanupSetupRemovalLogObserved = false',
      'cleanup-retired-session-setup-does-not-remove-original-session',
      'CLEANUP_RETIRED_SESSION_IS_CREATED_BY_REMOVE_READD'
    ),
    mutateFunction(
      source,
      'runActiveMediaLifecycleScenario',
      /const\s+cleanupSetupRemoved\s*=\s*cleanupSetupRemovalLogObserved\s*&&\s*!!cleanupSetupRemovedSnapshot\s*&&\s*cleanupSetupRemovedSnapshot\.peerCount\s*===\s*0/,
      'const cleanupSetupRemoved = cleanupSetupRemovalLogObserved',
      'cleanup-setup-trusts-removal-log-without-zero-owner-proof',
      'CLEANUP_SETUP_REQUIRES_ZERO_OWNER_SNAPSHOT'
    ),
    mutateFunction(
      source,
      'sendSessionlessAnswer',
      /UUID:\s*uuid,/,
      "UUID: uuid,\n    session: '',",
      'sessionless-answer-helper-adds-empty-session-property',
      'SESSIONLESS_WSS_SEND_HELPERS_OMIT_SESSION_OWN_PROPERTY'
    ),
    mutateFunction(
      source,
      'sendSessionlessBrowserCandidate',
      /UUID:\s*uuid,/,
      "UUID: uuid,\n    session: '',",
      'sessionless-candidate-helper-adds-empty-session-property',
      'SESSIONLESS_WSS_SEND_HELPERS_OMIT_SESSION_OWN_PROPERTY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /!Object\.prototype\.hasOwnProperty\.call\(\s*sessionlessCandidateRawMessage,\s*['"]session['"]\s*\)/,
      'true',
      'sessionless-candidate-serialized-own-property-proof-bypassed',
      'SESSIONLESS_WSS_SEND_HELPERS_OMIT_SESSION_OWN_PROPERTY'
    ),
    mutateFunction(
      source,
      'explicitSessionlessWssAnswerRejectionLines',
      /reason=missing-session/,
      'reason=missing-session-other',
      'sessionless-answer-guard-reason-evidence-deleted',
      'SESSIONLESS_WSS_REJECTIONS_ARE_EXACTLY_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'explicitSessionlessWssCandidateRejectionLines',
      /source=signaling-wss/,
      'source=datachannel',
      'sessionless-candidate-wss-branch-evidence-deleted',
      'SESSIONLESS_WSS_REJECTIONS_ARE_EXACTLY_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /snapshot\.signaling\.sessionless_wss_remote_candidates_rejected\s*\n\s*\)\s*===\s*sessionlessCandidateRejectsBefore\s*\+\s*1/,
      'snapshot.signaling.sessionless_wss_remote_candidates_rejected\n                ) >= sessionlessCandidateRejectsBefore + 1',
      'sessionless-candidate-counter-allows-nonexact-growth',
      'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /snapshot\.signaling\.sessionless_wss_answers_rejected\)\s*===\s*\n\s*sessionlessAnswerRejectsBefore\s*\+\s*1/,
      'snapshot.signaling.sessionless_wss_answers_rejected) >=\n                sessionlessAnswerRejectsBefore + 1',
      'sessionless-answer-counter-allows-nonexact-growth',
      'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY'
    ),
    mutateFunction(
      source,
      'sessionlessWssDownstreamState',
      /pendingRemoteCandidates:\s*Number\(snapshot\.signaling\.pending_remote_candidates\s*\|\|\s*0\)/,
      'pendingRemoteCandidates: 0',
      'sessionless-pending-candidate-state-proof-deleted',
      'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /JSON\.stringify\(sessionlessAnswerDownstreamState\)\s*===\s*\n\s*JSON\.stringify\(sessionlessCandidateDownstreamState\)/,
      'true',
      'sessionless-answer-downstream-state-proof-bypassed',
      'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*!sessionlessOfferStatePreserved\s*\)/,
      'if (false && !sessionlessOfferStatePreserved)',
      'sessionless-product-failure-recovery-disabled',
      'SESSIONLESS_WSS_REJECTIONS_PRESERVE_OFFER_B_STATE_AND_RECOVERY'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(['"]sessionless-generation-a-candidate-is-rejected-before-offer-b-routing['"],\s*)sessionlessCandidateSafelyRejected/,
      '$1true',
      'sessionless-candidate-reporter-forced-true',
      'SESSIONLESS_WSS_BEHAVIOR_VERDICTS_ARE_LOAD_BEARING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(['"]sessionless-generation-a-answer-is-rejected-before-offer-b-routing['"],\s*)sessionlessAnswerSafelyRejected/,
      '$1true',
      'sessionless-answer-reporter-forced-true',
      'SESSIONLESS_WSS_BEHAVIOR_VERDICTS_ARE_LOAD_BEARING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sessionlessCandidateQuiescent\s*;/,
      'sessionlessCandidateQuiescent || true;',
      'sessionless-candidate-verdict-tail-forced-true',
      'SESSIONLESS_WSS_BEHAVIOR_VERDICTS_ARE_LOAD_BEARING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sessionlessAnswerQuiescent\s*;/,
      'sessionlessAnswerQuiescent || true;',
      'sessionless-answer-verdict-tail-forced-true',
      'SESSIONLESS_WSS_BEHAVIOR_VERDICTS_ARE_LOAD_BEARING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /const\s+sessionlessPostEventQuiescenceMs\s*=\s*1000/,
      'const sessionlessPostEventQuiescenceMs = 0',
      'sessionless-post-event-quiescence-collapsed',
      'SESSIONLESS_WSS_REJECTIONS_QUIESCE_AND_FORBID_DOWNSTREAM_LOGS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sessionlessCandidateForbiddenRoutingLines\.length\s*===\s*0/,
      'sessionlessCandidateForbiddenRoutingLines.length >= 0',
      'sessionless-candidate-forbidden-routing-proof-bypassed',
      'SESSIONLESS_WSS_REJECTIONS_QUIESCE_AND_FORBID_DOWNSTREAM_LOGS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /sessionlessAnswerForbiddenApplyLines\.length\s*===\s*0/,
      'sessionlessAnswerForbiddenApplyLines.length >= 0',
      'sessionless-answer-forbidden-apply-proof-bypassed',
      'SESSIONLESS_WSS_REJECTIONS_QUIESCE_AND_FORBID_DOWNSTREAM_LOGS'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /explicitStaleCandidateRejectionLines\(\s*staleCandidateOutput,\s*staleUuid,\s*offerA\.message\.session,\s*staleCandidateACandidateSha256/,
      'explicitStaleCandidateRejectionLines(\n            staleCandidateOutput,\n            staleUuid,\n            offerA.message.session,\n            staleCandidateAWireSha256',
      'stale-candidate-log-uses-full-wire-hash-instead-of-raw-line-hash',
      'STALE_CANDIDATE_REJECTION_IS_EXACT_EVENT_CORRELATED'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /alphaReceive:\s*['"]vp9-dualtrack-v1['"]/,
      "alpha_receive: 'vp9-dualtrack-v1'",
      'alpha-negative-camel-case-control-becomes-exact-positive',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /negativeSnapshotAfter\.alphaAllowed\s*===\s*false/,
      'negativeSnapshotAfter.alphaAllowed === true',
      'alpha-negative-diagnostics-allows-enabled-state',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(`plugin-alpha-negative-\$\{variant\.id\}-remains-disabled`,\s*)negativeCapabilityRejected/,
      '$1true',
      'alpha-negative-reporter-forced-true',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(['"]plugin-alpha-only-exact-snake-case-version-string-is-admitted['"],\s*)alphaNegativeMatrixVerdict/,
      '$1true',
      'alpha-negative-matrix-reporter-forced-true',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /(const\s+pluginInfo\s*=\s*\{[\s\S]{0,500}?alpha_receive:\s*)['"]vp9-dualtrack-v1['"]/,
      "$1'vp9-dualtrack-v2'",
      'alpha-positive-capability-uses-wrong-version',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /exactAlphaCapabilitySnapshot\.alphaReceiveMode\s*===\s*['"]vp9-dualtrack-v1['"]/,
      "exactAlphaCapabilitySnapshot.alphaReceiveMode === ''",
      'alpha-positive-diagnostics-mode-proof-bypassed',
      'PLUGIN_ALPHA_CAPABILITY_REQUIRES_EXACT_SNAKE_CASE_VERSION_STRING'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /alpha-restart-fixture-recovery-does-not-hide-product-failure/,
      'alpha-restart-fixture-recovery-hidden-product-failure',
      'alpha-reset-recovery-evidence-removed',
      'ALPHA_RESET_FAILURE_PRESERVES_PLUGIN_COVERAGE'
    ),
    mutateFunction(
      source,
      'runNegotiationScenario',
      /if\s*\(\s*!restartBeforeCapability\.ok\s*\)\s*\{/,
      'if (!restartBeforeCapability.ok) {\n      return;',
      'alpha-reset-failure-skips-plugin-coverage',
      'ALPHA_RESET_FAILURE_PRESERVES_PLUGIN_COVERAGE'
    )
    ];
  }
  console.log(
    `[SIGNAL-FIXTURE-GATE] GREEN ${checks.length}/${checks.length}; ` +
    `binding mutations ${bindingMutations.length}/${bindingMutations.length} rejected; ` +
    `survivor mutations ${survivorMutations.length}/${survivorMutations.length} rejected; ` +
    `policy mutations ${policyMutations.length}/${policyMutations.length} rejected; ` +
    `registry mutations ${registryMutationContract.cases.length}/` +
    `${registryMutationContract.cases.length} rejected; ` +
    `equivalent variants ${equivalentVariants.cases.length}/` +
    `${equivalentVariants.cases.length} green; ` +
    `phaseSeedSha256=${phaseSeed.sha256}`
  );
}

run();
