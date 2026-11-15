// Fault injection only: reproduce the reported HRESULT for the selected HWND.
// The packaged app's PrintWindow frames, encoder, WebRTC and browser stay real.
const replaced = new Set();
const callbacks = [];
const interopIid = '1be82836ac3c604cb7f423ce0e0c3356';
rpc.exports = {
    threadstacks() {
        return Process.enumerateThreads().map(t => ({id: t.id, state: t.state,
            stack: Thread.backtrace(t.context, Backtracer.ACCURATE).map(a => DebugSymbol.fromAddress(a).toString())}));
    }
};
function guid(p) {
    return Array.from(new Uint8Array(p.readByteArray(16)), b => b.toString(16).padStart(2, '0')).join('');
}
Process.attachModuleObserver({onAdded(module) {
    if (module.name.toLowerCase() !== 'combase.dll') return;
    Interceptor.attach(module.getExportByName('RoGetActivationFactory'), {
        onEnter(args) { this.output = guid(args[1]) === interopIid ? args[2] : null; },
        onLeave(result) {
            if (!this.output || result.toInt32() < 0) return;
            const address = this.output.readPointer().readPointer().add(Process.pointerSize * 3).readPointer();
            if (replaced.has(address.toString())) return;
            replaced.add(address.toString());
            const original = new NativeFunction(address, 'int32', ['pointer', 'pointer', 'pointer', 'pointer']);
            const replacement = new NativeCallback((self, hwnd, iid, output) => {
                if (!hwnd.equals(ptr(TARGET_HWND))) return original(self, hwnd, iid, output);
                output.writePointer(ptr(0));
                send({kind: 'wgc-rejection-injected', hwnd: hwnd.toString(), hresult: '0x80070057'});
                return -2147024809;
            }, 'int32', ['pointer', 'pointer', 'pointer', 'pointer']);
            callbacks.push(replacement);
            Interceptor.replace(address, replacement);
            send({kind: 'wgc-rejection-hook-ready'});
        }
    });
}});
