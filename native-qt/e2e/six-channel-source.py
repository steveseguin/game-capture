"""Real six-channel Windows playback in a capturable window; no device changes."""
import ctypes as c
import math
import struct
import tkinter as tk

winmm = c.WinDLL('winmm')
class Header(c.Structure):
    _fields_ = [('data', c.c_void_p), ('size', c.c_uint32), ('recorded', c.c_uint32),
                ('user', c.c_size_t), ('flags', c.c_uint32), ('loops', c.c_uint32),
                ('next', c.c_void_p), ('reserved', c.c_size_t)]

# WAVEFORMATEXTENSIBLE, PCM16, 5.1 channel slots in Windows order.
fmt = c.create_string_buffer(struct.pack('<HHIIHHHHI', 0xfffe, 6, 48000, 48000*12, 12, 16, 22, 16, 0x3f)
    + bytes.fromhex('0100000000001000800000aa00389b71'))
pcm = bytearray()
for frame in range(48000):
    for frequency in [300, 500, 700, 90, 1100, 1300]:
        pcm += struct.pack('<h', round(1600 * math.sin(2*math.pi*frequency*frame/48000)))
buffer = c.create_string_buffer(bytes(pcm))
handle = c.c_void_p()
result = winmm.waveOutOpen(c.byref(handle), c.c_uint32(0xffffffff), fmt, 0, 0, 0)
assert result == 0, ('waveOutOpen', result)
header = Header(c.cast(buffer, c.c_void_p), len(pcm), 0, 0, 0x4 | 0x8, 0xffffffff, None, 0)
assert winmm.waveOutPrepareHeader(handle, c.byref(header), c.sizeof(header)) == 0
assert winmm.waveOutWrite(handle, c.byref(header), c.sizeof(header)) == 0
window = tk.Tk()
window.title('Game Capture Six Channel Source')
window.geometry('640x360+20+20')
label = tk.Label(window, text='Six independent audio tones\n300 / 500 / 700 / 90 / 1100 / 1300 Hz',
                 bg='#18304a', fg='white', font=('Arial', 18))
label.pack(fill='both', expand=True)
print('SIX_CHANNEL_SOURCE_READY', flush=True)
try:
    window.mainloop()
finally:
    winmm.waveOutReset(handle)
    winmm.waveOutUnprepareHeader(handle, c.byref(header), c.sizeof(header))
    winmm.waveOutClose(handle)
