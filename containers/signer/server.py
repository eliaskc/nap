"""
Nap's app signer. POST /sign signs an iOS build; POST /inspect reads what an iOS build asks for;
POST /sign-android signs an Android App Bundle (android.py).

Body: a zip of an unsigned iOS .app (built with CODE_SIGNING_ALLOWED=NO).
Headers:
  x-bundle-id      the bundle id of the app record, e.g. com.example.nap
  x-build-number   CFBundleVersion, assigned by Nap
  x-profile        the App Store provisioning profile, base64
  x-distribution   "app-store" (the only kind: builds go to TestFlight)
  x-entitlement-keys  entitlements beyond the basic ones to take from the profile,
                   comma-separated (those of the capabilities Nap turned on)
  x-warnings       optional, base64 JSON {app slug: [sentence]}: capabilities the build
                   asked for and does not get. Written into Info.plist as NapCapabilityWarnings.
Environment:
  SIGNING_PEM      the distribution private key and certificate, PEM

POST /inspect takes the same body and answers {"capabilities": {slug: [name]}}, from the
NapCapabilities key the app template writes into Info.plist.

POST /sign-android takes an unsigned .aab, with x-package-name (the Play app's package name) and
x-build-number (its versionCode, assigned by Nap), and signs it with ANDROID_UPLOAD_PEM, the Play
upload key and its certificate.

/sign returns the signed .ipa, with x-app-* headers describing the build. Errors are JSON with status
400 (the build is wrong) or 500. The container has no internet access: it signs without a
timestamp server, which iOS does not need.
"""

import base64
import json
import os
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import android

MAX_BYTES = 200 * 1024 * 1024
BUNDLE_ID = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
MACHO_ARM64 = (b"\xcf\xfa\xed\xfe", 0x0100000C)


class BuildError(Exception):
    pass


def read_profile(data: bytes) -> dict:
    """A provisioning profile is a CMS envelope around a plain XML plist."""
    start, end = data.find(b"<?xml"), data.find(b"</plist>")
    if start < 0 or end < 0:
        raise BuildError("The provisioning profile is not readable")
    return plistlib.loads(data[start : end + len(b"</plist>")])


def matches(pattern: str, value: str) -> bool:
    return pattern == value or (pattern.endswith("*") and value.startswith(pattern[:-1]))


def is_mac_metadata(name: str) -> bool:
    """
    Files macOS adds to a zip: AppleDouble "._" files, which ditto writes for extended
    attributes, and the __MACOSX folder. Signed into an app, App Store Connect refuses it.
    """
    parts = [part for part in name.split("/") if part]
    return any(part == "__MACOSX" or part.startswith("._") for part in parts)


def safe_extract(archive: zipfile.ZipFile, root: str):
    members = [m for m in archive.infolist() if not is_mac_metadata(m.filename)]
    for member in members:
        target = os.path.realpath(os.path.join(root, member.filename))
        if not target.startswith(os.path.realpath(root) + os.sep):
            raise BuildError(f"Unsafe path in the zip: {member.filename}")
        # Zips from ditto and zip keep symlinks as entries with the link mode. Apps for iOS
        # have none, so refuse them rather than follow one out of the bundle.
        if (member.external_attr >> 16) & 0o170000 == 0o120000:
            raise BuildError(f"Symlinks are not allowed: {member.filename}")
    archive.extractall(root, members)


def check_executable(path: str):
    with open(path, "rb") as handle:
        head = handle.read(8)
    magic, cpu = head[:4], int.from_bytes(head[4:8], "little")
    if (magic, cpu) != MACHO_ARM64:
        raise BuildError(
            "The app's executable is not an arm64 iOS binary. Build for a device "
            "(-sdk iphoneos -destination 'generic/platform=iOS'), not the Simulator."
        )


BASIC_APP_STORE_ENTITLEMENTS = (
    "application-identifier",
    "com.apple.developer.team-identifier",
    "get-task-allow",
    "beta-reports-active",
)


def is_wildcard(value) -> bool:
    if isinstance(value, str):
        return value.endswith("*")
    if isinstance(value, list):
        return any(isinstance(v, str) and v.endswith("*") for v in value)
    return False


def app_store_entitlements(entitlements: dict, extra_keys: list) -> dict:
    """
    What an App Store build claims: the basic entitlements, and those of the capabilities Nap
    turned on, with the profile's values. Never wildcards (such as the keychain group TEAM.*):
    they only say what the profile allows, and App Store Connect refuses builds that claim them.
    """
    kept = {}
    for key in (*BASIC_APP_STORE_ENTITLEMENTS, *extra_keys):
        if key in entitlements and not is_wildcard(entitlements[key]):
            kept[key] = entitlements[key]
    return kept


def unpack(body: bytes, work: str):
    """The one .app in an uploaded zip, and its Info.plist."""
    with zipfile.ZipFile(_bytes_file(work, "unsigned.zip", body)) as archive:
        unpacked = os.path.join(work, "in")
        safe_extract(archive, unpacked)
    apps = [
        os.path.join(dirpath, name)
        for dirpath, dirnames, _ in os.walk(unpacked)
        for name in dirnames
        if name.endswith(".app")
    ]
    top = [app for app in apps if not any(app.startswith(other + os.sep) for other in apps)]
    if len(top) != 1:
        raise BuildError("The zip must hold exactly one .app")
    app = top[0]
    info_path = os.path.join(app, "Info.plist")
    if not os.path.exists(info_path):
        raise BuildError("The app has no Info.plist")
    with open(info_path, "rb") as handle:
        info = plistlib.load(handle)
    return app, info_path, info


def inspect(body: bytes) -> dict:
    work = tempfile.mkdtemp()
    try:
        _, _, info = unpack(body, work)
        requests = info.get("NapCapabilities", {})
        return {"capabilities": requests if isinstance(requests, dict) else {}}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def sign(
    body: bytes,
    bundle_id: str,
    build_number: str,
    profile_bytes: bytes,
    distribution: str = "app-store",
    extra_keys: list = (),
    warnings: dict = None,
):
    pem = os.environ.get("SIGNING_PEM", "")
    if "PRIVATE KEY" not in pem or "CERTIFICATE" not in pem:
        raise RuntimeError("SIGNING_PEM is not set")
    if not BUNDLE_ID.match(bundle_id):
        raise BuildError("Bad bundle id")
    if not build_number.isdigit():
        raise BuildError("Bad build number")
    if distribution != "app-store":
        raise BuildError("Bad distribution")

    profile = read_profile(profile_bytes)
    team = profile["TeamIdentifier"][0]
    entitlements = dict(profile["Entitlements"])
    app_id = f"{team}.{bundle_id}"
    if not matches(entitlements["application-identifier"], app_id):
        raise BuildError(f"The profile does not cover {bundle_id}")
    if profile["ExpirationDate"].replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise BuildError("The provisioning profile has expired")
    entitlements["application-identifier"] = app_id
    entitlements["get-task-allow"] = False
    if "beta-reports-active" not in entitlements:
        raise BuildError("The profile is not an App Store profile")
    entitlements = app_store_entitlements(entitlements, list(extra_keys))

    work = tempfile.mkdtemp()
    try:
        app, info_path, info = unpack(body, work)
        if info.get("DTPlatformName") != "iphoneos":
            raise BuildError(
                f"This is a {info.get('DTPlatformName', 'unknown')} build. Build for iphoneos."
            )
        executable = os.path.join(app, info.get("CFBundleExecutable", ""))
        if not info.get("CFBundleExecutable") or not os.path.isfile(executable):
            raise BuildError("The app's executable is missing")
        check_executable(executable)
        if not info.get("CFBundleIcons", {}).get(
            "CFBundlePrimaryIcon", {}
        ).get("CFBundleIconName"):
            raise BuildError(
                "TestFlight builds need an app icon: an AppIcon set in an asset catalog of the "
                "launcher (the app template has one in ios/Launcher/Resources)."
            )

        info["CFBundleIdentifier"] = bundle_id
        info["CFBundleVersion"] = build_number
        if warnings:
            info["NapCapabilityWarnings"] = warnings
        else:
            info.pop("NapCapabilityWarnings", None)
        with open(info_path, "wb") as handle:
            plistlib.dump(info, handle, fmt=plistlib.FMT_BINARY)
        with open(os.path.join(app, "embedded.mobileprovision"), "wb") as handle:
            handle.write(profile_bytes)
        # Leftovers from a signed build would make the signature lie about the bundle.
        shutil.rmtree(os.path.join(app, "_CodeSignature"), ignore_errors=True)

        key = _bytes_file(work, "signer.pem", pem.encode())
        ents = _bytes_file(work, "entitlements.plist", plistlib.dumps(entitlements))
        result = subprocess.run(
            [
                "rcodesign", "sign",
                "--pem-file", key,
                "--entitlements-xml-file", ents,
                "--timestamp-url", "none",
                app,
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(f"rcodesign failed: {result.stderr[-2000:]}")

        ipa = os.path.join(work, "signed.ipa")
        with zipfile.ZipFile(ipa, "w", zipfile.ZIP_DEFLATED) as out:
            for dirpath, _, filenames in os.walk(app):
                for name in filenames:
                    full = os.path.join(dirpath, name)
                    arcname = os.path.join(
                        "Payload", os.path.basename(app), os.path.relpath(full, app)
                    )
                    info_entry = zipfile.ZipInfo.from_file(full, arcname)
                    with open(full, "rb") as handle:
                        out.writestr(info_entry, handle.read(), zipfile.ZIP_DEFLATED)
        with open(ipa, "rb") as handle:
            signed = handle.read()
        meta = {
            "x-app-name": info.get("CFBundleDisplayName") or info.get("CFBundleName") or "",
            "x-app-short-version": info.get("CFBundleShortVersionString", ""),
            "x-app-xcode": info.get("DTXcode", ""),
            "x-app-sdk": info.get("DTSDKName", ""),
            "x-app-minimum-os": info.get("MinimumOSVersion", ""),
        }
        return signed, meta
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _bytes_file(directory: str, name: str, data: bytes) -> str:
    path = os.path.join(directory, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._json(200, {"ok": True})

    def do_POST(self):
        if self.path not in ("/sign", "/inspect", "/sign-android"):
            return self._json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BYTES:
                raise BuildError("The upload is empty or too large")
            body = self.rfile.read(length)
            if self.path == "/inspect":
                return self._json(200, inspect(body))
            if self.path == "/sign-android":
                signed, meta = android.sign_bundle(
                    body,
                    self.headers.get("x-package-name", ""),
                    self.headers.get("x-build-number", ""),
                    os.environ.get("ANDROID_UPLOAD_PEM", ""),
                )
                return self._send_signed(signed, meta)
            profile = base64.b64decode(self.headers.get("x-profile", ""))
            keys = self.headers.get("x-entitlement-keys", "")
            warnings_header = self.headers.get("x-warnings", "")
            warnings = json.loads(base64.b64decode(warnings_header)) if warnings_header else None
            if warnings is not None and not isinstance(warnings, dict):
                raise BuildError("Bad warnings")
            signed, meta = sign(
                body,
                self.headers.get("x-bundle-id", ""),
                self.headers.get("x-build-number", ""),
                profile,
                self.headers.get("x-distribution", "") or "app-store",
                [key for key in keys.split(",") if key],
                warnings,
            )
        except (BuildError, android.BundleError) as error:
            return self._json(400, {"error": str(error)})
        except zipfile.BadZipFile:
            return self._json(400, {"error": "The upload is not a zip of an .app"})
        except Exception as error:  # noqa: BLE001
            print(f"signing failed: {error}")
            return self._json(500, {"error": "Signing failed"})
        self._send_signed(signed, meta)

    def _send_signed(self, signed, meta):
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(len(signed)))
        for name, value in meta.items():
            self.send_header(name, base64.b64encode(str(value).encode()).decode())
        self.end_headers()
        self.wfile.write(signed)

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(fmt % args)


if __name__ == "__main__":
    # The server is the container's PID 1, which ignores SIGTERM unless it handles it. Without
    # this, the container never sleeps: the Worker signals it to stop when idle and nothing
    # happens, so it runs on, with the environment (the signing keys) it started with.
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
