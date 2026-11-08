"""
Android: signs an unsigned Android App Bundle (.aab) with the Play upload key, for Google Play.

An .aab is a zip. Nap sets its versionCode (the build number) in base/manifest/AndroidManifest.xml,
which aapt2 writes as a protocol buffer (aapt.pb.XmlNode, frameworks/base/tools/aapt2/
Resources.proto), and signs the zip the way jarsigner does (JAR signing, v1): META-INF/MANIFEST.MF
with a digest of every entry, NAP.SF with digests of the manifest, and NAP.RSA, a PKCS #7
signature of NAP.SF with the upload certificate. Google Play checks that signature against the
app's upload key, and signs the APKs it makes for phones with the app signing key it keeps.
"""

import base64
import hashlib
import io
import re
import zipfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs7

MANIFEST = "base/manifest/AndroidManifest.xml"
ANDROID_NS = "http://schemas.android.com/apk/res/android"
PACKAGE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$")
# Play takes version codes up to 2100000000.
MAX_VERSION_CODE = 2_100_000_000
SIGNATURE_FILE = re.compile(r"^META-INF/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF|SIG-[^/]*)$", re.I)


class BundleError(Exception):
    """The bundle is wrong: the agent gets the message."""


# ---- Protocol buffers, at the wire level ----
# Only the fields Nap reads or changes are named; everything else is kept byte for byte.


def _varint(data: bytes, pos: int):
    result = shift = 0
    while True:
        if pos >= len(data):
            raise BundleError("The bundle's manifest is not readable")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise BundleError("The bundle's manifest is not readable")


def _encode_varint(value: int) -> bytes:
    value &= (1 << 64) - 1
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def parse(data: bytes):
    """A message as [(field, wire type, value)]: ints for varints, bytes otherwise."""
    fields, pos = [], 0
    while pos < len(data):
        key, pos = _varint(data, pos)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = _varint(data, pos)
        elif wire == 2:
            length, pos = _varint(data, pos)
            value, pos = data[pos : pos + length], pos + length
            if len(value) != length:
                raise BundleError("The bundle's manifest is not readable")
        elif wire == 1:
            value, pos = data[pos : pos + 8], pos + 8
        elif wire == 5:
            value, pos = data[pos : pos + 4], pos + 4
        else:
            raise BundleError("The bundle's manifest is not readable")
        fields.append((number, wire, value))
    return fields


def encode(fields) -> bytes:
    out = bytearray()
    for number, wire, value in fields:
        out += _encode_varint((number << 3) | wire)
        if wire == 0:
            out += _encode_varint(value)
        elif wire == 2:
            out += _encode_varint(len(value)) + value
        else:
            out += value
    return bytes(out)


def _text(fields, number: int) -> str:
    for n, wire, value in fields:
        if n == number and wire == 2:
            return value.decode("utf-8", "replace")
    return ""


# XmlNode: element = 1. XmlElement: namespace_uri = 2, name = 3, attribute = 4, child = 5.
# XmlAttribute: namespace_uri = 1, name = 2, value = 3, compiled_item = 6.
# Item: prim = 7. Primitive: int_decimal_value = 6, boolean_value = 8.


def _element(node: bytes):
    for n, wire, value in parse(node):
        if n == 1 and wire == 2:
            return parse(value)
    return None


def _attributes(element):
    """{(namespace, name): (index in element, attribute fields)}"""
    found = {}
    for index, (n, wire, value) in enumerate(element):
        if n == 4 and wire == 2:
            attribute = parse(value)
            found[(_text(attribute, 1), _text(attribute, 2))] = (index, attribute)
    return found


def _children(element):
    return [_element(value) for n, wire, value in element if n == 5 and wire == 2]


def _compiled(attribute):
    """The attribute's compiled primitive as {field: value}, or {}."""
    for n, wire, value in attribute:
        if n == 6 and wire == 2:
            for m, w, prim in parse(value):
                if m == 7 and w == 2:
                    return {k: v for k, _, v in parse(prim)}
    return {}


def read_manifest(data: bytes) -> dict:
    """What Nap checks in the manifest: package, versions, SDKs, and whether it is debuggable."""
    element = _element(data)
    if not element or _text(element, 3) != "manifest":
        raise BundleError("The bundle's manifest is not readable")
    attributes = _attributes(element)
    value = lambda attrs, ns, name: _text(attrs[(ns, name)][1], 3) if (ns, name) in attrs else ""
    info = {
        "package": value(attributes, "", "package"),
        "versionName": value(attributes, ANDROID_NS, "versionName"),
        "minSdk": "",
        "targetSdk": "",
        "debuggable": False,
        "testOnly": False,
    }
    for child in _children(element):
        if not child:
            continue
        child_attributes = _attributes(child)
        if _text(child, 3) == "uses-sdk":
            info["minSdk"] = value(child_attributes, ANDROID_NS, "minSdkVersion")
            info["targetSdk"] = value(child_attributes, ANDROID_NS, "targetSdkVersion")
        if _text(child, 3) == "application":
            for name in ("debuggable", "testOnly"):
                if (ANDROID_NS, name) in child_attributes:
                    _, attribute = child_attributes[(ANDROID_NS, name)]
                    compiled = _compiled(attribute)
                    on = compiled.get(8) == 1 or _text(attribute, 3) == "true"
                    info[name] = on
    return info


def set_version_code(data: bytes, version_code: int) -> bytes:
    """The manifest with android:versionCode set, everything else as it was."""
    node = parse(data)
    for node_index, (n, wire, value) in enumerate(node):
        if n == 1 and wire == 2:
            break
    else:
        raise BundleError("The bundle's manifest is not readable")
    element = parse(node[node_index][2])
    attributes = _attributes(element)
    if (ANDROID_NS, "versionCode") not in attributes:
        raise BundleError("The bundle's manifest has no android:versionCode")
    index, attribute = attributes[(ANDROID_NS, "versionCode")]
    prim = encode([(6, 0, version_code)])
    item = encode([(7, 2, prim)])
    rebuilt, seen_value, seen_item = [], False, False
    for m, w, v in attribute:
        if m == 3 and w == 2:
            rebuilt.append((3, 2, str(version_code).encode()))
            seen_value = True
        elif m == 6 and w == 2:
            rebuilt.append((6, 2, item))
            seen_item = True
        else:
            rebuilt.append((m, w, v))
    if not seen_value:
        rebuilt.append((3, 2, str(version_code).encode()))
    if not seen_item:
        rebuilt.append((6, 2, item))
    element[index] = (4, 2, encode(rebuilt))
    node[node_index] = (1, 2, encode(element))
    return encode(node)


# ---- JAR signing ----


def _manifest_line(text: str) -> bytes:
    """A manifest header line, wrapped at 72 bytes with continuation lines that start with a space."""
    data = text.encode("utf-8")
    lines, first = [], True
    while data:
        limit = 72 if first else 71
        cut = min(limit, len(data))
        # Never split a UTF-8 character.
        while cut < len(data) and cut > 0 and (data[cut] & 0xC0) == 0x80:
            cut -= 1
        lines.append((b"" if first else b" ") + data[:cut])
        data, first = data[cut:], False
    return b"".join(line + b"\r\n" for line in lines)


def _b64sha256(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


def _load_key(pem: str):
    key_pem = re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", pem, re.S)
    cert_pem = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S)
    if not key_pem or not cert_pem:
        raise RuntimeError("ANDROID_UPLOAD_PEM is not set")
    key = serialization.load_pem_private_key(key_pem.group(0).encode(), password=None)
    cert = x509.load_pem_x509_certificate(cert_pem.group(0).encode())
    return key, cert


def jar_sign(entries, pem: str) -> bytes:
    """
    A signed zip of entries [(ZipInfo, data)], in their order, after the signature files
    (META-INF/MANIFEST.MF, META-INF/NAP.SF, META-INF/NAP.RSA), as jarsigner writes them.
    """
    key, cert = _load_key(pem)
    main = _manifest_line("Manifest-Version: 1.0") + _manifest_line("Created-By: Nap") + b"\r\n"
    sections = []
    for info, data in entries:
        if info.is_dir():
            continue
        section = (
            _manifest_line(f"Name: {info.filename}")
            + _manifest_line(f"SHA-256-Digest: {_b64sha256(data)}")
            + b"\r\n"
        )
        sections.append((info.filename, section))
    manifest = main + b"".join(section for _, section in sections)
    sf = (
        _manifest_line("Signature-Version: 1.0")
        + _manifest_line("Created-By: Nap")
        + _manifest_line(f"SHA-256-Digest-Manifest: {_b64sha256(manifest)}")
        + _manifest_line(f"SHA-256-Digest-Manifest-Main-Attributes: {_b64sha256(main)}")
        + b"\r\n"
        + b"".join(
            _manifest_line(f"Name: {name}")
            + _manifest_line(f"SHA-256-Digest: {_b64sha256(section)}")
            + b"\r\n"
            for name, section in sections
        )
    )
    block = (
        pkcs7.PKCS7SignatureBuilder()
        .set_data(sf)
        .add_signer(cert, key, hashes.SHA256())
        .sign(
            serialization.Encoding.DER,
            [pkcs7.PKCS7Options.DetachedSignature, pkcs7.PKCS7Options.NoAttributes],
        )
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for name, data in (
            ("META-INF/MANIFEST.MF", manifest),
            ("META-INF/NAP.SF", sf),
            ("META-INF/NAP.RSA", block),
        ):
            info = zipfile.ZipInfo(name, date_time=(1981, 1, 1, 1, 1, 2))
            archive.writestr(info, data, zipfile.ZIP_DEFLATED)
        for info, data in entries:
            archive.writestr(info, data, info.compress_type)
    return out.getvalue()


def sign_bundle(body: bytes, package: str, version_code: str, pem: str):
    """The signed .aab and x-app-* headers describing it."""
    if not PACKAGE.match(package):
        raise BundleError("Bad package name")
    if not version_code.isdigit() or not 0 < int(version_code) <= MAX_VERSION_CODE:
        raise BundleError("Bad build number")
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        raise BundleError("The upload is not an Android App Bundle (.aab)") from None
    with archive:
        names = set(archive.namelist())
        if MANIFEST not in names or "BundleConfig.pb" not in names:
            raise BundleError(
                "The upload is not an Android App Bundle: build it with bundleRelease "
                "(android/scripts/build), not an APK."
            )
        entries = []
        for info in archive.infolist():
            name = info.filename
            if name.startswith("/") or ".." in name.split("/"):
                raise BundleError(f"Unsafe path in the bundle: {name}")
            # A signed bundle's signature would cover the old manifest: Nap signs it anew.
            if SIGNATURE_FILE.match(name):
                continue
            entries.append((info, archive.read(info)))
    manifest_index = next(i for i, (info, _) in enumerate(entries) if info.filename == MANIFEST)
    manifest = read_manifest(entries[manifest_index][1])
    if manifest["package"] != package:
        raise BundleError(
            f"The bundle's applicationId is {manifest['package'] or 'missing'}, and this Nap's "
            f"Play app is {package}. Set applicationId to {package} in android/launcher/build.gradle.kts."
        )
    if manifest["debuggable"]:
        raise BundleError("The bundle is debuggable. Build the release variant (bundleRelease).")
    if manifest["testOnly"]:
        raise BundleError("The bundle is test-only (android:testOnly). Google Play refuses it.")
    info = entries[manifest_index][0]
    entries[manifest_index] = (info, set_version_code(entries[manifest_index][1], int(version_code)))
    signed = jar_sign(entries, pem)
    meta = {
        "x-app-name": "",
        "x-app-short-version": manifest["versionName"],
        "x-app-sdk": manifest["targetSdk"],
        "x-app-minimum-os": manifest["minSdk"],
    }
    return signed, meta
