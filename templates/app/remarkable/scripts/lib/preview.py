"""The launcher on this Mac, with its real backend, for development (run through scripts/preview).

    preview.py [--app <slug>] [--shot out.png] [--steps steps.json] [--scale 0.5]

A stand-in for AppLoad's QML type (net.asivery.AppLoad) carries messages to the backend, which
runs here with `entry --dev <socket>` (the same code as on the tablet). Writing works with the
mouse: in QML a real mouse press looks like the tablet's pen, and finger taps are synthesized.

Steps (JSON list) drive it without a person, for checks and screenshots:
    {"wait": 500}
    {"shot": "name.png"}
    {"eval": "js expression, with `root` the launcher"}
    {"click": [x, y]}                      a tap, in tablet pixels (1404 × 1872)
    {"pen": [[x, y], [x, y], ...]}         one pen stroke, in tablet pixels
"""
import argparse
import json
import os
import socket
import struct
import sys
import threading

os.environ.setdefault("QT_QUICK_BACKEND", "software")
from enum import IntEnum

from PySide6.QtCore import (QEnum, QEventLoop, QObject, QPointF, Property, QTimer, QUrl, Qt, Signal,
                            Slot)
from PySide6.QtGui import QGuiApplication, QMouseEvent
from PySide6.QtQml import QQmlExpression, qmlRegisterType
from PySide6.QtQuick import QQuickItem, QQuickView

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))

parser = argparse.ArgumentParser()
parser.add_argument("--socket", required=True)
parser.add_argument("--app", default="")
parser.add_argument("--shot", default="")
parser.add_argument("--steps", default="")
parser.add_argument("--scale", type=float, default=0.5)
parser.add_argument("--quit", action="store_true")
args = parser.parse_args()


class AppLoad(QObject):
    """net.asivery.AppLoad's AppLoad, over a stream socket to `entry --dev`."""

    messageReceived = Signal(int, str)
    _incoming = Signal(int, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._id = ""
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.connect(args.socket)
        self._lock = threading.Lock()
        self._incoming.connect(self.messageReceived, Qt.QueuedConnection)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        f = self._sock.makefile("rb")
        while True:
            header = f.read(8)
            if len(header) < 8:
                return
            kind, length = struct.unpack("<ii", header)
            body = f.read(length).decode("utf-8", "replace")
            self._incoming.emit(kind, body)

    def getApplicationID(self):
        return self._id

    def setApplicationID(self, value):
        self._id = value

    applicationID = Property(str, getApplicationID, setApplicationID)

    @Property(bool, constant=True)
    def isStub(self):
        return False

    @Slot(int, str)
    def sendMessage(self, kind, contents):
        body = contents.encode("utf-8")
        with self._lock:
            self._sock.sendall(struct.pack("<ii", kind, len(body)) + body)

    @Slot()
    def terminate(self):
        pass


class DisplayMethodArea(QQuickItem):
    """AppLoad's e-ink refresh mode for an area. Nothing to do on a Mac."""

    @QEnum
    class DisplayMethod(IntEnum):
        Default = 0
        Fast = 1
        Content = 2

    def __init__(self, parent=None):
        super().__init__(parent)
        self._method = 0

    def getMethod(self):
        return self._method

    def setMethod(self, value):
        self._method = value

    displayMethod = Property(int, getMethod, setMethod)


qmlRegisterType(AppLoad, "net.asivery.AppLoad", 1, 0, "AppLoad")
qmlRegisterType(DisplayMethodArea, "net.asivery.ApploadUtils", 1, 0, "DisplayMethodArea")

app = QGuiApplication(sys.argv)
view = QQuickView()
view.setResizeMode(QQuickView.SizeRootObjectToView)
w, h = int(1404 * args.scale), int(1872 * args.scale)
view.resize(w, h)
wrapper = os.path.join(ROOT, ".preview", "Preview.qml")
os.makedirs(os.path.dirname(wrapper), exist_ok=True)
with open(wrapper, "w") as f:
    f.write(f"""import QtQuick
import "../launcher/ui" as L
Item {{
    width: {w}; height: {h}
    L.Main {{ objectName: "launcher"; startApp: "{args.app}" }}
}}
""")
view.setSource(QUrl.fromLocalFile(wrapper))
for e in view.errors():
    print("QML error:", e.toString())
view.show()
launcher = view.rootObject().findChild(QObject, "launcher")


def wait(ms):
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def to_view(x, y):
    return QPointF(x * args.scale, y * args.scale)


def mouse(kind, pos, buttons):
    button = Qt.LeftButton
    ev = QMouseEvent(kind, pos, pos, button if kind != QMouseEvent.Type.MouseMove else Qt.NoButton, buttons, Qt.NoModifier)
    QGuiApplication.sendEvent(view, ev)


def stroke(points, step_ms=8):
    p = [to_view(*pt) for pt in points]
    mouse(QMouseEvent.Type.MouseButtonPress, p[0], Qt.LeftButton)
    for q in p[1:]:
        wait(step_ms)
        mouse(QMouseEvent.Type.MouseMove, q, Qt.LeftButton)
    mouse(QMouseEvent.Type.MouseButtonRelease, p[-1], Qt.NoButton)


def run_steps(steps):
    for step in steps:
        if "wait" in step:
            wait(step["wait"])
        elif "shot" in step:
            wait(50)
            path = step["shot"]
            view.grabWindow().save(path)
            print("shot", path)
        elif "eval" in step:
            expr = QQmlExpression(view.engine().rootContext(), launcher, step["eval"])
            value, error = expr.evaluate()
            if expr.hasError():
                print("eval error:", expr.error().toString())
            else:
                print("eval:", value)
        elif "click" in step:
            x, y = step["click"]
            stroke([(x, y), (x, y)], 0)
        elif "approve" in step:
            # Development: approve the sign-in on the local Nap as this email, as /connect would.
            import urllib.request
            signin = view.rootObject().findChild(QObject, "signin")
            start = signin.property("start") if signin else None
            code = start.toVariant()["userCode"] if hasattr(start, "toVariant") else (start or {}).get("userCode")
            origin = step.get("origin", "http://localhost:8790")
            req = urllib.request.Request(f"{origin}/api/connect/{code}", data=b'{"action":"approve"}', method="POST",
                                         headers={"content-type": "application/json", "x-nap-dev-email": step["approve"]})
            print("approve", code, urllib.request.urlopen(req).status)
        elif "pen" in step:
            stroke(step["pen"], step.get("ms", 8))
        wait(10)


if args.steps or args.shot:
    steps = json.load(open(args.steps)) if args.steps else [{"wait": 2500}]
    if args.shot:
        steps.append({"shot": args.shot})
    run_steps(steps)
    if args.quit or args.shot or args.steps:
        sys.exit(0)

sys.exit(app.exec())
