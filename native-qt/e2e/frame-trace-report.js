'use strict';

// Usage: node e2e/frame-trace-report.js <encoder-receiver-review results.json>
// Run the packaged publisher with --frame-identity=1 --frame-trace=1 first.
const fs = require('fs');
const path = require('path');

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(result, rows) {
  const captures = new Map(), submissions = new Map();
  for (const row of rows) {
    if (row.stage === 'capture') captures.set(row.capture, row.now);
    if (row.stage === 'submit') submissions.set(row.output, row);
  }
  const windows = [{name: 'initial', before: result.initialCapture?.before,
    after: result.initialCapture?.after}, ...(result.videoControls || []).map((control, index) => ({
    name: `control-${index + 1}`, target: control.target,
    before: control.captureBefore, after: control.diagnostics
  }))].filter(window => window.before && window.after);
  return {
    name: result.name,
    traceRows: rows.length,
    possiblyTruncated: rows.length >= 100000,
    expiredSlots: rows.filter(row => row.stage === 'expired').length,
    windows: windows.map(window => {
      const start = window.before.generated_steady_ms * 10000;
      const end = window.after.generated_steady_ms * 10000;
      const seconds = (end - start) / 1e7;
      const inWindow = rows.filter(row => row.now >= start && row.now <= end);
      const stages = {};
      for (const stage of ['capture', 'submit', 'packet']) {
        const selected = inWindow.filter(row => row.stage === stage);
        // Packets carry the submission PTS, not raw pixels. Attribute their ID
        // through that exact PTS; missing joins are unknown, never ID zero.
        const ids = selected.map(row => stage === 'packet'
          ? (submissions.get(row.output)?.id ?? -1) : row.id);
        let unique = 0, previous = -1;
        for (const id of ids) {
          if (id >= 0 && id !== previous) unique++;
          previous = id;
        }
        stages[stage] = {count: selected.length, fps: selected.length / seconds,
          uniqueFps: unique / seconds, unknownIds: ids.filter(id => id < 0).length};
      }
      const ages = inWindow.filter(row => row.stage === 'submit' && captures.has(row.capture))
        .map(row => (row.now - captures.get(row.capture)) / 10000);
      const packetAges = inWindow.filter(row => row.stage === 'packet')
        .map(row => (row.now - row.output) / 10000);
      // Use the callback's steady clock. WGC's source timestamp can describe
      // a future compositor presentation, so it is not a callback arrival time.
      return {name: window.name, target: window.target, seconds, stages,
        captureCallbackToSubmissionMs: {median: percentile(ages, .5), p95: percentile(ages, .95)},
        outputSlotToEncodedPacketMs: {median: percentile(packetAges, .5), p95: percentile(packetAges, .95)}};
    })
  };
}

const input = process.argv[2];
if (!input) throw Error('Pass the packaged E2E results.json path');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const summaries = report.results.map(result => {
  const file = path.join(path.dirname(input), result.name + '-frames.csv');
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const [stage, now, capture, output, id] = line.split(',');
    return {stage, now: Number(now), capture: Number(capture), output: Number(output), id: Number(id)};
  });
  return summarize(result, rows);
});
console.log(JSON.stringify({publisher: report.publisher, sha256: report.sha256, summaries}, null, 2));
