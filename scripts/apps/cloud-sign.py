#!/usr/bin/env python3
"""
Signs one iOS build for Nap with Apple's cloud-managed distribution certificate, on a Mac.

This is the signing job of cloud signing (napConfig.apps.ios.signing.cloud, see
src/lib/cloud-signing.ts). The workflow infra/config-repo-sign-ios.yml runs it in the deployment's
config repository when Nap starts it for a build. It:

1. asks Nap what to sign, and downloads the unsigned build an agent uploaded;
2. sets the bundle id and build number, like the signer container does;
3. wraps the app in an archive and exports it with `xcodebuild -exportArchive`, signed in with
   the App Store Connect key. With no distribution certificate in the keychain, Xcode signs with
   the team's cloud-managed one and makes the App Store profile itself;
4. hands the .ipa back to Nap, which uploads it to TestFlight and makes the build live.

Any failure is reported to Nap, so the build fails with the reason instead of waiting.

Environment:
  NAP_URL             Nap's root, such as https://nap.example.com
  NAP_BUILD           the build's id
  NAP_SIGNING_SECRET  the deployment's signing secret
  ASC_PRIVATE_KEY     the App Store Connect team key (the .p8's text), with ASC_KEY_ID and
                      ASC_ISSUER_ID

Needs only Xcode and the Python that comes with macOS.
"""

import datetime
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

# What every App Store build is signed with. Xcode fills these in from the profile.
BASIC_ENTITLEMENTS = (
    "application-identifier",
    "com.apple.developer.team-identifier",
    "get-task-allow",
    "beta-reports-active",
)


class SigningError(Exception):
    """Something about the build or Apple's answer that the person publishing should read."""


def log(message):
    print(message, flush=True)


def run(command, **options):
    return subprocess.run(command, text=True, capture_output=True, **options)


def nap(url, method="GET", data=None, headers=None, timeout=300):
    """A request to Nap as the signing job. Returns the open response."""
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("authorization", f"Bearer {os.environ['NAP_SIGNING_SECRET']}")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            detail = json.loads(body).get("error") or body
        except ValueError:
            detail = body
        raise SigningError(f"Nap answered {error.code}: {detail[:500]}") from None


def read_plist(path):
    with open(path, "rb") as handle:
        return plistlib.load(handle)


def is_wildcard(value):
    if isinstance(value, str):
        return value.endswith("*")
    if isinstance(value, list):
        return any(is_wildcard(item) for item in value)
    return False


def find_app(folder):
    apps = [name for name in os.listdir(folder) if name.endswith(".app")]
    if len(apps) != 1:
        raise SigningError("The build must be a zip of one .app")
    return os.path.join(folder, apps[0])


def prepare(app, job):
    """Makes the unsigned app the app record's: bundle id, build number, warnings."""
    info_path = os.path.join(app, "Info.plist")
    if not os.path.isfile(info_path):
        raise SigningError("The app has no Info.plist")
    info = read_plist(info_path)
    if info.get("DTPlatformName") != "iphoneos":
        raise SigningError(
            f"This is a {info.get('DTPlatformName', 'unknown')} build. Build for iphoneos."
        )
    executable = os.path.join(app, info.get("CFBundleExecutable", ""))
    if not info.get("CFBundleExecutable") or not os.path.isfile(executable):
        raise SigningError("The app's executable is missing")
    if not info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {}).get("CFBundleIconName"):
        raise SigningError(
            "TestFlight builds need an app icon: an AppIcon set in an asset catalog of the "
            "launcher (the app template has one in ios/Launcher/Resources)."
        )
    info["CFBundleIdentifier"] = job["bundleId"]
    info["CFBundleVersion"] = str(job["buildNumber"])
    if job.get("warnings"):
        info["NapCapabilityWarnings"] = job["warnings"]
    else:
        info.pop("NapCapabilityWarnings", None)
    with open(info_path, "wb") as handle:
        plistlib.dump(info, handle, fmt=plistlib.FMT_BINARY)
    # Leftovers from a signed build would make the signature lie about the bundle.
    shutil.rmtree(os.path.join(app, "_CodeSignature"), ignore_errors=True)
    if os.path.exists(os.path.join(app, "embedded.mobileprovision")):
        os.remove(os.path.join(app, "embedded.mobileprovision"))
    # App extensions each need an App ID and profile of their own, which cloud signing does not
    # make yet. Like an extension without a profile in the signer container: left out.
    plugins = os.path.join(app, "PlugIns")
    if os.path.isdir(plugins):
        log(f"Leaving out app extensions: {', '.join(sorted(os.listdir(plugins)))}")
        shutil.rmtree(plugins)
    return info


def make_archive(app, archive, job, info):
    """An .xcarchive around the app, which is all `xcodebuild -exportArchive` needs."""
    shutil.rmtree(archive, ignore_errors=True)
    applications = os.path.join(archive, "Products", "Applications")
    os.makedirs(applications)
    name = os.path.basename(app)
    # ditto keeps symlinks and permissions, which frameworks need.
    subprocess.run(["ditto", app, os.path.join(applications, name)], check=True)
    with open(os.path.join(archive, "Info.plist"), "wb") as handle:
        plistlib.dump(
            {
                "ApplicationProperties": {
                    "ApplicationPath": f"Applications/{name}",
                    "Architectures": ["arm64"],
                    "CFBundleIdentifier": job["bundleId"],
                    "CFBundleShortVersionString": info.get("CFBundleShortVersionString", "1.0"),
                    "CFBundleVersion": str(job["buildNumber"]),
                    "SigningIdentity": "",
                    "Team": job["teamId"],
                },
                "ArchiveVersion": 2,
                "CreationDate": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
                "Name": os.path.splitext(name)[0],
                "SchemeName": os.path.splitext(name)[0],
            },
            handle,
        )
    return os.path.join(applications, name)


def export(archive, folder, job, work):
    """Signs the archive for the App Store with the cloud-managed certificate: the .ipa's path."""
    options = os.path.join(work, "ExportOptions.plist")
    with open(options, "wb") as handle:
        plistlib.dump(
            {
                "method": "app-store-connect",
                "destination": "export",
                "teamID": job["teamId"],
                "signingStyle": "automatic",
                "manageAppVersionAndBuildNumber": False,
                "uploadSymbols": False,
            },
            handle,
        )
    shutil.rmtree(folder, ignore_errors=True)
    result = run(
        [
            "xcodebuild",
            "-exportArchive",
            "-archivePath", archive,
            "-exportPath", folder,
            "-exportOptionsPlist", options,
            "-allowProvisioningUpdates",
            "-authenticationKeyPath", key_path(work),
            "-authenticationKeyID", os.environ["ASC_KEY_ID"],
            "-authenticationKeyIssuerID", os.environ["ASC_ISSUER_ID"],
        ]
    )  # fmt: skip
    output = result.stdout + result.stderr
    if result.returncode != 0:
        log(output[-6000:])
        errors = [line.strip() for line in output.splitlines() if "error:" in line.lower()]
        reason = " ".join(dict.fromkeys(errors))[:1200] or output.strip()[-600:]
        raise SigningError(f"Xcode could not sign the build: {reason}")
    ipas = [name for name in os.listdir(folder) if name.endswith(".ipa")]
    if len(ipas) != 1:
        raise SigningError("Xcode exported no .ipa")
    return os.path.join(folder, ipas[0])


def key_path(work):
    """The App Store Connect key as a file, which xcodebuild wants. Removed with the folder."""
    path = os.path.join(work, f"AuthKey_{os.environ['ASC_KEY_ID']}.p8")
    if not os.path.exists(path):
        with open(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600), "w") as handle:
            handle.write(os.environ["ASC_PRIVATE_KEY"].replace("\\n", "\n").strip() + "\n")
    return path


def signed_app(ipa, folder):
    """Unpacks an .ipa: the path of the app inside."""
    shutil.rmtree(folder, ignore_errors=True)
    subprocess.run(["ditto", "-x", "-k", ipa, folder], check=True)
    return find_app(os.path.join(folder, "Payload"))


def entitlements_of(app):
    result = run(["codesign", "-d", "--entitlements", "-", "--xml", app])
    if result.returncode != 0 or not result.stdout.strip():
        return {}
    return plistlib.loads(result.stdout.encode())


def profile_entitlements(app):
    result = subprocess.run(
        ["security", "cms", "-D", "-i", os.path.join(app, "embedded.mobileprovision")],
        capture_output=True,
        check=True,
    )
    return plistlib.loads(result.stdout).get("Entitlements", {})


def sign_ad_hoc(app, entitlements, work):
    """
    Signs the archive's app ad hoc with these entitlements. Export signs with the entitlements
    the app already has, so this is how it learns which ones the build wants.
    """
    path = os.path.join(work, "entitlements.plist")
    with open(path, "wb") as handle:
        plistlib.dump(entitlements, handle)
    frameworks = os.path.join(app, "Frameworks")
    nested = sorted(os.listdir(frameworks)) if os.path.isdir(frameworks) else []
    for name in nested:
        subprocess.run(
            ["codesign", "--force", "--sign", "-", os.path.join(frameworks, name)],
            check=True,
            capture_output=True,
        )
    subprocess.run(
        ["codesign", "--force", "--sign", "-", "--entitlements", path, app],
        check=True,
        capture_output=True,
    )


def sign(job, unsigned_zip, work):
    """The whole of signing, between the download and the upload. Returns the .ipa and its Info."""
    unpacked = os.path.join(work, "unsigned")
    subprocess.run(["ditto", "-x", "-k", unsigned_zip, unpacked], check=True)
    app = find_app(unpacked)
    info = prepare(app, job)
    archive = os.path.join(work, "Nap.xcarchive")
    archived = make_archive(app, archive, job, info)
    log("Signing with the cloud-managed certificate...")
    ipa = export(archive, os.path.join(work, "export"), job, work)
    result = signed_app(ipa, os.path.join(work, "signed"))

    # Capabilities: the profile Xcode just made carries their entitlements. Sign again, asking
    # for those, with the profile's values. Never wildcards, as in the signer container.
    wanted = [key for key in job.get("entitlementKeys", []) if key not in BASIC_ENTITLEMENTS]
    if wanted:
        profile = profile_entitlements(result)
        entitlements = entitlements_of(result)
        missing = [key for key in wanted if key not in profile]
        if missing:
            raise SigningError(
                "The App Store profile Xcode made lacks entitlements the build needs: "
                + ", ".join(missing)
                + ". Check the App ID's capabilities in the developer account."
            )
        for key in wanted:
            if not is_wildcard(profile[key]):
                entitlements[key] = profile[key]
        log(f"Signing again with: {', '.join(sorted(entitlements))}")
        sign_ad_hoc(archived, entitlements, work)
        ipa = export(archive, os.path.join(work, "export"), job, work)
        result = signed_app(ipa, os.path.join(work, "signed"))
        got = entitlements_of(result)
        dropped = [key for key in wanted if key in entitlements and key not in got]
        if dropped:
            raise SigningError(f"Xcode signed without the entitlements: {', '.join(dropped)}")

    verified = run(["codesign", "--verify", "--deep", "--strict", result])
    if verified.returncode != 0:
        raise SigningError(f"The signature does not verify: {verified.stderr.strip()[-500:]}")
    described = run(["codesign", "-dvv", result]).stderr
    for line in described.splitlines():
        if line.startswith(("Identifier=", "Authority=", "TeamIdentifier=")):
            log(f"  {line}")
    log(f"  Entitlements: {', '.join(sorted(entitlements_of(result)))}")
    signed_info = read_plist(os.path.join(result, "Info.plist"))
    if signed_info.get("CFBundleIdentifier") != job["bundleId"]:
        raise SigningError("Xcode changed the bundle id")
    return ipa, signed_info


def main():
    base = f"{os.environ['NAP_URL'].rstrip('/')}/_nap/api/signing/builds/{os.environ['NAP_BUILD']}"
    work = tempfile.mkdtemp(prefix="nap-sign-")
    try:
        with nap(base) as response:
            job = json.load(response)
        log(f"Build {job['buildNumber']} of {job['bundleId']} (team {job['teamId']})")
        unsigned_zip = os.path.join(work, "unsigned.zip")
        with nap(job["unsigned"]) as response, open(unsigned_zip, "wb") as handle:
            shutil.copyfileobj(response, handle)
        ipa, info = sign(job, unsigned_zip, work)
        query = urllib.parse.urlencode(
            {
                "name": info.get("CFBundleDisplayName") or info.get("CFBundleName") or "",
                "version": info.get("CFBundleShortVersionString", ""),
                "xcode": info.get("DTXcode", ""),
            }
        )
        size = os.path.getsize(ipa)
        log(f"Handing the signed app to Nap ({size / 1e6:.1f} MB)...")
        with open(ipa, "rb") as handle:
            # Nap uploads it to TestFlight before it answers, which takes a while.
            with nap(
                f"{job['signed']}?{query}",
                method="PUT",
                data=handle,
                headers={"content-type": "application/octet-stream", "content-length": str(size)},
                timeout=900,
            ) as response:
                json.load(response)
        log(f"Build {job['buildNumber']} is on its way to TestFlight.")
    except Exception as error:
        message = str(error) if isinstance(error, SigningError) else f"The signing job failed: {error}"
        log(f"::error::{message}")
        try:
            nap(
                f"{base}/failed",
                method="POST",
                data=json.dumps({"error": message}).encode(),
                headers={"content-type": "application/json"},
                timeout=60,
            ).close()
        except Exception as report:
            log(f"Could not tell Nap: {report}")
        if not isinstance(error, SigningError):
            raise
        sys.exit(1)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
