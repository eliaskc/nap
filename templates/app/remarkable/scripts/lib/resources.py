"""Writes the launcher's Qt resource file and its app registry.

    python3 scripts/lib/resources.py <out.qrc> <registry.js>

The resource file holds launcher/ui/ and apps/ at the same paths as in the repo, so an
app's relative imports ("../../launcher/ui/nap") work both from the tablet's resources and
from files in the Mac preview.
"""
import json
import os
import sys

out, registry = sys.argv[1], sys.argv[2]
root = os.getcwd()
SKIP = {".DS_Store"}

apps = []
for slug in sorted(os.listdir("apps")):
    meta = os.path.join("apps", slug, "app.json")
    if not os.path.isfile(meta):
        continue
    info = json.load(open(meta))
    apps.append({
        "slug": slug,
        "title": info.get("title", slug),
        "summary": info.get("summary", ""),
        "site": info.get("site", ""),
    })

with open(registry, "w") as f:
    f.write(".pragma library\n// Written by scripts/build from apps/*/app.json. Do not edit.\n")
    f.write("var list = " + json.dumps(apps, indent=2) + "\n")

files = []
for base in ("launcher/ui", "apps"):
    for dirpath, _, names in os.walk(base):
        for name in sorted(names):
            if name in SKIP or name.endswith((".md", ".py")):
                continue
            files.append(os.path.join(dirpath, name))

with open(out, "w") as f:
    f.write('<!DOCTYPE RCC><RCC version="1.0">\n<qresource prefix="/">\n')
    for path in sorted(files):
        f.write(f'  <file alias="{path}">{os.path.join(root, path)}</file>\n')
    f.write("</qresource>\n</RCC>\n")
