"""
Nap's app signer. One endpoint: POST /sign.

Body: a zip of an unsigned iOS .app (built with CODE_SIGNING_ALLOWED=NO).
Headers:
  x-bundle-id      the bundle id Nap assigns, e.g. com.example.nap.launcher
  x-build-number   CFBundleVersion, assigned by Nap
  x-profile        the provisioning profile, base64
  x-distribution   "ad-hoc" (default) or "app-store", for TestFlight
Environment:
  SIGNING_PEM      the distribution private key and certificate, PEM

Returns the signed .ipa, with x-app-* headers describing the build. Errors are JSON with status
400 (the build is wrong) or 500. The container has no internet access: it signs without a
timestamp server, which iOS does not need.
"""

import base64
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


def safe_extract(archive: zipfile.ZipFile, root: str):
    for member in archive.infolist():
        target = os.path.realpath(os.path.join(root, member.filename))
        if not target.startswith(os.path.realpath(root) + os.sep):
            raise BuildError(f"Unsafe path in the zip: {member.filename}")
        # Zips from ditto and zip keep symlinks as entries with the link mode. Apps for iOS
        # have none, so refuse them rather than follow one out of the bundle.
        if (member.external_attr >> 16) & 0o170000 == 0o120000:
            raise BuildError(f"Symlinks are not allowed: {member.filename}")
    archive.extractall(root)


def check_executable(path: str):
    with open(path, "rb") as handle:
        head = handle.read(8)
    magic, cpu = head[:4], int.from_bytes(head[4:8], "little")
    if (magic, cpu) != MACHO_ARM64:
        raise BuildError(
            "The app's executable is not an arm64 iOS binary. Build for a device "
            "(-sdk iphoneos -destination 'generic/platform=iOS'), not the Simulator."
        )


def app_store_entitlements(entitlements: dict) -> dict:
    """
    What an App Store build may claim: the profile's entitlements without its wildcards (such as
    the keychain group TEAM.*), which only say what the profile allows. App Store Connect refuses
    builds that claim wildcards.
    """
    kept = {}
    for key, value in entitlements.items():
        if key == "keychain-access-groups":
            continue
        if isinstance(value, str) and value.endswith("*"):
            continue
        if isinstance(value, list) and any(isinstance(v, str) and v.endswith("*") for v in value):
            continue
        kept[key] = value
    return kept


def sign(
    body: bytes,
    bundle_id: str,
    build_number: str,
    profile_bytes: bytes,
    distribution: str = "ad-hoc",
):
    pem = os.environ.get("SIGNING_PEM", "")
    if "PRIVATE KEY" not in pem or "CERTIFICATE" not in pem:
        raise RuntimeError("SIGNING_PEM is not set")
    if not BUNDLE_ID.match(bundle_id):
        raise BuildError("Bad bundle id")
    if not build_number.isdigit():
        raise BuildError("Bad build number")
    if distribution not in ("ad-hoc", "app-store"):
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
    if distribution == "app-store":
        if "beta-reports-active" not in entitlements:
            raise BuildError("The profile is not an App Store profile")
        entitlements = app_store_entitlements(entitlements)

    work = tempfile.mkdtemp()
    try:
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
        if info.get("DTPlatformName") != "iphoneos":
            raise BuildError(
                f"This is a {info.get('DTPlatformName', 'unknown')} build. Build for iphoneos."
            )
        executable = os.path.join(app, info.get("CFBundleExecutable", ""))
        if not info.get("CFBundleExecutable") or not os.path.isfile(executable):
            raise BuildError("The app's executable is missing")
        check_executable(executable)
        if distribution == "app-store" and not info.get("CFBundleIcons", {}).get(
            "CFBundlePrimaryIcon", {}
        ).get("CFBundleIconName"):
            raise BuildError(
                "TestFlight builds need an app icon: an AppIcon set in an asset catalog of the "
                "launcher (the app template has one in Apps/Launcher/Resources)."
            )

        info["CFBundleIdentifier"] = bundle_id
        info["CFBundleVersion"] = build_number
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
        if self.path != "/sign":
            return self._json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BYTES:
                raise BuildError("The upload is empty or too large")
            body = self.rfile.read(length)
            profile = base64.b64decode(self.headers.get("x-profile", ""))
            signed, meta = sign(
                body,
                self.headers.get("x-bundle-id", ""),
                self.headers.get("x-build-number", ""),
                profile,
                self.headers.get("x-distribution", "") or "ad-hoc",
            )
        except BuildError as error:
            return self._json(400, {"error": str(error)})
        except zipfile.BadZipFile:
            return self._json(400, {"error": "The upload is not a zip of an .app"})
        except Exception as error:  # noqa: BLE001
            print(f"signing failed: {error}")
            return self._json(500, {"error": "Signing failed"})
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
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
