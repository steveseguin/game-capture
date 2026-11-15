// Instrument ONLY the owned publisher's six-channel process capture buffer.
// This verifies the packaged pipeline, not a physical multichannel endpoint.
const hooked = new Set();
const method = (object, index) => object.readPointer().add(index * Process.pointerSize).readPointer();
const guid = p => Array.from(new Uint8Array(p.readByteArray(16)), b => b.toString(16).padStart(2, '0')).join('');
function attach(address, handlers) {
  const key = address.toString();
  if (!hooked.has(key)) { hooked.add(key); Interceptor.attach(address, handlers); }
}
let framesSeen = 0;
function capture(client) {
  attach(method(client, 3), {
    onEnter(args) { this.data = args[1]; this.frames = args[2]; this.flags = args[3]; },
    onLeave(result) {
      if (result.toInt32() < 0) return;
      const frames = this.frames.readU32();
      if (!frames) return;
      const pcm = new Float32Array(frames * 6);
      const frequencies = globalThis.fixtureFrequencies || [300, 500, 700, 90, 1100, 1300];
      for (let frame = 0; frame < frames; ++frame)
        for (let ch = 0; ch < 6; ++ch)
          pcm[frame * 6 + ch] = .05 * Math.sin(2 * Math.PI * frequencies[ch] * (framesSeen + frame) / 48000);
      // Keep the allocation alive until the next GetBuffer, after ReleaseBuffer.
      capture.buffer = Memory.alloc(pcm.byteLength);
      capture.buffer.writeByteArray(pcm.buffer);
      this.data.writePointer(capture.buffer);
      this.flags.writeU32(this.flags.readU32() & ~2);
      if (!framesSeen) send({ kind: 'synthetic-six-channel-capture', channels: 6, rate: 48000, frequencies });
      framesSeen += frames;
    }
  });
}
function audioClient(client) {
  let sixChannels = false;
  attach(method(client, 3), {
    onEnter(args) { sixChannels = args[5].add(2).readU16() === 6 && args[5].add(4).readU32() === 48000; }
  });
  attach(method(client, 14), {
    onEnter(args) { this.output = sixChannels && guid(args[1]) === '64bdadc81ee7a048a4de185c395cd317' ? args[2] : null; },
    onLeave(result) { if (this.output && result.toInt32() >= 0) capture(this.output.readPointer()); }
  });
}
function unknown(client) {
  attach(method(client, 0), {
    onEnter(args) { this.output = guid(args[1]) === '4cadb91cfadb324cb178c2f568a703b2' ? args[2] : null; },
    onLeave(result) { if (this.output && result.toInt32() >= 0) audioClient(this.output.readPointer()); }
  });
}
Process.attachModuleObserver({ onAdded(module) {
  if (module.name.toLowerCase() !== 'mmdevapi.dll') return;
  attach(module.getExportByName('ActivateAudioInterfaceAsync'), {
    onEnter(args) {
      if (!args[0].readUtf16String().includes('Process_Loopback')) return;
      attach(method(args[3], 3), { onEnter(args) {
        attach(method(args[1], 3), {
          onEnter(args) { this.output = args[2]; },
          onLeave(result) { if (result.toInt32() >= 0 && !this.output.readPointer().isNull()) unknown(this.output.readPointer()); }
        });
      } });
    }
  });
} });
