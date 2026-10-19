#!/usr/bin/env python3
"""Owned native GTK barcode window; JSON lines on stdin/stdout control its lifecycle."""
import json
import sys

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk


def main():
    window = Gtk.Window(title='Owned Linux Capture Native GTK Source')
    window.set_default_size(720, 480)
    area = Gtk.DrawingArea()
    window.add(area)
    state = {'id': 0, 'draws': 0, 'paused': False}

    def draw(widget, context):
        state['draws'] += 1
        if not state['paused']:
            state['id'] = (state['id'] + 1) % 65536
        w, h = widget.get_allocated_width(), widget.get_allocated_height()
        state.update(width=w, height=h)
        context.set_source_rgb(.094, .188, .259)
        context.paint()
        for x, color in ((.1, (0, 1, 1)), (.85, (1, 0, 1))):
            context.set_source_rgb(*color)
            context.rectangle(x*w, .25*h, .05*w, .5*h)
            context.fill()
        for bit in range(16):
            value = 1 if state['id'] & (1 << bit) else 0
            context.set_source_rgb(value, value, value)
            context.rectangle((.2+bit*.6/16)*w, .25*h, .6/16*w, .5*h)
            context.fill()

    def command(fd, condition):
        line = sys.stdin.readline()
        if not line:
            Gtk.main_quit()
            return False
        request = json.loads(line)
        action = request['action']
        if action == 'pause': state['paused'] = True
        elif action == 'resume': state['paused'] = False
        elif action == 'resize': window.resize(request['width'], request['height'])
        elif action == 'present': window.present()
        else: assert action == 'state'
        print(json.dumps(state), flush=True)
        return True

    area.connect('draw', draw)
    window.connect('destroy', Gtk.main_quit)
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    GLib.timeout_add(16, lambda: (area.queue_draw(), True)[1])
    window.show_all()
    Gtk.main()


if __name__ == '__main__':
    main()
