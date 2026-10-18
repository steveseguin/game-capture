'use strict';
// Replayable action selection. Network scheduling is deliberately not claimed
// deterministic: retain the realized timings and browser/native evidence too.
module.exports = function roomFuzzPlan(seed, steps) {
  const assert = require('assert/strict');
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Seed must be uint32');
  assert(Number.isInteger(steps) && steps >= 6 && steps <= 24, 'Fuzz steps must be 6..24');
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const kinds = ['guest', 'guest', 'bitrate', 'audio', 'video', 'keyframe'];
  const actions = [...kinds];
  while (actions.length < steps) actions.push(kinds[next() % kinds.length]);
  for (let i = actions.length - 1; i > 0; i--) {
    const j = next() % (i + 1); [actions[i], actions[j]] = [actions[j], actions[i]];
  }
  return actions.map((kind, index) => ({index, kind, delayMs: next() % 1201,
    holdMs: 400 + next() % 1601, bitrateKbps: [1500, 2500, 3500, 4000][next() % 4]}));
};
