"""AT-SPI metadata only. No strings, labels, passwords or document contents are read."""
import json
import os
import sys

try:
    import gi
    gi.require_version('Atspi', '2.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Atspi, Gdk
    Gdk.init([])
except (ImportError, ValueError):
    Atspi = None

def snapshot():
    if Atspi is None or os.environ.get('WAYLAND_DISPLAY'):
        return {'available': False, 'reason': 'unsupported'}
    display_name = os.environ.get('DISPLAY', '')
    display = Gdk.Display.get_default()
    if not display or not display_name or any(display.get_monitor(i).get_scale_factor() != 1 for i in range(display.get_n_monitors())):
        return {'available': False, 'reason': 'unsupported'}
    if display.get_n_monitors() > 32:
        return {'available': False, 'reason': 'unsupported'}
    captures = []
    for i in range(display.get_n_monitors()):
        r = display.get_monitor(i).get_geometry()
        captures.append(dict(x=r.x, y=r.y, width=r.width, height=r.height))
    if not captures:
        return {'available': False, 'reason': 'unavailable'}
    left, top = min(r['x'] for r in captures), min(r['y'] for r in captures)
    full = dict(x=left, y=top, width=max(r['x']+r['width'] for r in captures)-left,
                height=max(r['y']+r['height'] for r in captures)-top)
    desktop = Atspi.get_desktop(0)
    pending, visited = [desktop], 0
    while pending and visited < 512:
        node = pending.pop(); visited += 1
        states = node.get_state_set()
        if states.contains(Atspi.StateType.FOCUSED):
            # Same-user AT-SPI buses can span Xvnc and the console. Require this process's actual X display.
            pid = node.get_process_id()
            with open('/proc/%d/environ' % pid, 'rb') as stream:
                environment = stream.read(32768)
            node_display = next((item[8:].decode('ascii', 'strict') for item in environment.split(b'\0') if item.startswith(b'DISPLAY=')), '')
            del environment
            if node_display != display_name:
                return {'available': False, 'reason': 'unavailable'}
            component = node.get_component_iface()
            box = component.get_extents(Atspi.CoordType.SCREEN) if component else None
            text = node.get_text_iface()
            caret = None
            if text and text.get_caret_offset() >= 0:
                value = text.get_character_extents(text.get_caret_offset(), Atspi.CoordType.SCREEN)
                caret = dict(x=value.x, y=value.y, width=value.width, height=value.height)
            editable = states.contains(Atspi.StateType.EDITABLE)
            role = node.get_role()
            text_roles = [Atspi.Role.ENTRY, Atspi.Role.TEXT, Atspi.Role.PASSWORD_TEXT]
            nontext_roles = [Atspi.Role.PUSH_BUTTON, Atspi.Role.CHECK_BOX, Atspi.Role.RADIO_BUTTON, Atspi.Role.MENU_ITEM]
            focus_kind = 'editable' if editable else ('readOnly' if role in text_roles else ('nonText' if role in nontext_roles else 'unknown'))
            return dict(available=True, captureRects=captures, desktopRect=full, focusKind=focus_kind, desktopId='x11:' + display_name, coordinateUnit='physicalPx',
                        focusToken=str(pid) + ':' + str(hash(node)), editable=editable, readOnly=not editable,
                        enabled=states.contains(Atspi.StateType.ENABLED), visible=states.contains(Atspi.StateType.SHOWING),
                        inputKind='password' if node.get_role() == Atspi.Role.PASSWORD_TEXT else 'text',
                        controlRect=dict(x=box.x, y=box.y, width=box.width, height=box.height) if box else None,
                        caretRect=caret)
        count = min(node.get_child_count(), 64)
        for i in range(count):
            child = node.get_child_at_index(i)
            if child: pending.append(child)
    # A bounded tree walk cannot prove that no editable focus exists.
    return {'available': False, 'reason': 'unavailable'}

for _ in sys.stdin:
    try:
        value = snapshot()
    except Exception:
        value = {'available': False, 'reason': 'unavailable'}
    print(json.dumps(value, separators=(',', ':')), flush=True)
