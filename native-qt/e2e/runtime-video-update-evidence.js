'use strict';

// Preparation alone is not proof that a replacement became the live encoder.
exports.hasCommittedBitrateUpdate = function(text, expectedKbps) {
  let preparingKbps = null;
  for (const line of String(text).split(/\r?\n/)) {
    const applied = line.match(/\[App\] Applying runtime bitrate update: (\d+) kbps/);
    if (applied && Number(applied[1]) === expectedKbps) return true;
    const preparing = line.match(/\[App\] Preparing runtime encoder replacement while streaming: .*?\s(\d+)kbps/);
    if (preparing) preparingKbps = Number(preparing[1]);
    if (/\[App\] Runtime encoder replacement (failed preparation|became stale)/.test(line)) preparingKbps = null;
    if (line.includes('[App] Runtime encoder replacement committed')) {
      if (preparingKbps === expectedKbps) return true;
      preparingKbps = null;
    }
  }
  return false;
};
