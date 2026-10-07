// Observe the real Windows Graphics Capture COM session. The optional fault
// returns the same E_NOINTERFACE as Windows 10 for IGraphicsCaptureSession3.
// Frames, encoding, signaling, and receiver playback remain real.
const captureHooks = new Set();
const captureIids = {
    poolStatics2: '3f109b58bc6bf55da99102e28b3b66d5',
    session3: '66d9cdf2ae22a15e95963a289344c3be',
    accessStatics: '70d33e74ec064050a58a901f0f757095'
};
function captureGuid(address) {
    return Array.from(new Uint8Array(address.readByteArray(16)),
        b => b.toString(16).padStart(2, '0')).join('');
}
function captureMethod(instance, slot) {
    return instance.readPointer().add(Process.pointerSize * slot).readPointer();
}
function captureAttach(address, callbacks) {
    const key = address.toString();
    if (captureHooks.has(key)) return;
    captureHooks.add(key);
    Interceptor.attach(address, callbacks);
}
function captureObserveSession(session) {
    send({kind: 'capture_session_created', publisher: Process.mainModule.path});
    captureAttach(captureMethod(session, 0), {
        onEnter(args) {
            this.output = captureGuid(args[1]) === captureIids.session3 ? args[2] : null;
        },
        onLeave(result) {
            if (!this.output) return;
            const original = result.toInt32();
            if (CAPTURE_SESSION3_UNAVAILABLE) {
                if (original >= 0) {
                    const iface = this.output.readPointer();
                    new NativeFunction(captureMethod(iface, 2), 'uint32', ['pointer'])(iface);
                }
                this.output.writePointer(ptr(0));
                result.replace(ptr('0x80004002'));
            } else if (original >= 0) {
                captureAttach(captureMethod(this.output.readPointer(), 7), {
                    onEnter(args) { send({kind: 'capture_border_preference', required: args[1].toInt32()}); }
                });
            }
            send({kind: 'capture_session3_query', originalHresult: original,
                  denied: CAPTURE_SESSION3_UNAVAILABLE, hresult: result.toInt32()});
        }
    });
}
Process.attachModuleObserver({onAdded(module) {
    if (module.name.toLowerCase() !== 'combase.dll') return;
    captureAttach(module.getExportByName('RoGetActivationFactory'), {
        onEnter(args) {
            this.iid = captureGuid(args[1]);
            this.output = args[2];
            if (this.iid === captureIids.accessStatics) send({kind: 'capture_border_access_requested'});
        },
        onLeave(result) {
            if (result.toInt32() < 0 || this.iid !== captureIids.poolStatics2) return;
            captureAttach(captureMethod(this.output.readPointer(), 6), {
                onEnter(args) { this.output = args[5]; },
                onLeave(result) {
                    if (result.toInt32() < 0) return;
                    captureAttach(captureMethod(this.output.readPointer(), 10), {
                        onEnter(args) { this.output = args[2]; },
                        onLeave(result) {
                            if (result.toInt32() >= 0) captureObserveSession(this.output.readPointer());
                        }
                    });
                }
            });
        }
    });
    send({kind: 'hook', api: 'Windows Graphics Capture session compatibility'});
}});
