'use strict';

const assert = require('assert');
const {
  H265_STARTUP_FALLBACK_WARNING,
  ROOM_QUALITY_REASON,
  resolveH265RoomQualityExpectation
} = require('./dual-quality-requirements-e2e');

const preserved = resolveH265RoomQualityExpectation(
  { committed_codec: 'H.265' },
  ''
);
assert.strictEqual(preserved.codecName, 'H.265');
assert.strictEqual(preserved.assignedTier, 'hq');
assert.strictEqual(preserved.reason, ROOM_QUALITY_REASON.CODEC_NOT_H264);
assert.strictEqual(preserved.noLq, true);
assert.strictEqual(preserved.selectionOutcome, 'preserved');

const unavailableFallback = resolveH265RoomQualityExpectation(
  { committed_codec: 'H.264' },
  `[warning] ${H265_STARTUP_FALLBACK_WARNING}`
);
assert.strictEqual(unavailableFallback.codecName, 'H.264');
assert.strictEqual(unavailableFallback.assignedTier, 'lq');
assert.strictEqual(unavailableFallback.reason, ROOM_QUALITY_REASON.ENABLED);
assert.strictEqual(unavailableFallback.noLq, false);
assert.strictEqual(
  unavailableFallback.selectionOutcome,
  'explicit-encoder-unavailable-fallback'
);

assert.throws(
  () => resolveH265RoomQualityExpectation({ committed_codec: 'H.264' }, ''),
  /without the required explicit encoder-unavailable fallback evidence/
);
assert.throws(
  () => resolveH265RoomQualityExpectation({ committed_codec: 'VP9' }, ''),
  /unexpected codec/
);

console.log('[H265-FALLBACK-REGRESSION] PASS');
