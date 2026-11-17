"""Build the extension ZIP from its manifest and direct runtime dependencies."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile


def runtime_files(root):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    pending = ["manifest.json", "LICENSE", "PRIVACY.md"]
    pending += list(manifest.get("icons", {}).values())
    pending += list(manifest.get("action", {}).get("default_icon", {}).values())
    pending += [manifest["action"]["default_popup"], manifest["options_ui"]["page"]]
    pending += [manifest["background"]["service_worker"]]
    pending += [name for group in manifest["content_scripts"] for name in group.get("js", []) + group.get("css", [])]
    pending += [p.relative_to(root).as_posix() for p in (root / "_locales").glob("*/messages.json")]
    found = set()
    while pending:
        name = pending.pop()
        parts = PurePosixPath(name)
        if parts.is_absolute() or ".." in parts.parts:
            raise ValueError(f"Invalid runtime path: {name}")
        if name in found:
            continue
        path = root / name
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Missing or external runtime file: {name}")
        found.add(name)
        if path.suffix == ".html":
            text = path.read_text(encoding="utf-8")
            for target in re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', text):
                if target.startswith(("#", "data:", "http:", "https:", "mailto:")):
                    continue
                pending.append((parts.parent / target.split("#")[0]).as_posix())
        if path.suffix == ".js":
            text = path.read_text(encoding="utf-8")
            pending += re.findall(r'["\'](icons/[^"\']+\.(?:png|svg))["\']', text)
            for call in re.findall(r"\bimportScripts\((.*?)\)", text, re.S):
                for target in re.findall(r'["\']([^"\']+)["\']', call):
                    if ":" in target:
                        raise ValueError("Remote script import is not allowed")
                    pending.append((parts.parent / target).as_posix())
    return manifest, sorted(found)


def build(root, output):
    manifest, names = runtime_files(root)
    if output.exists():
        raise FileExistsError("Output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (root / name).read_bytes()
            if Path(name).suffix in (".js", ".html", ".json", ".md", ".txt") or name == "LICENSE":
                data = data.replace(b"\r\n", b"\n")
            entry = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            entry.create_system = 0
            entry.external_attr = 0x20
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data, compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == names
        assert json.loads(archive.read("manifest.json"))["version"] == manifest["version"]
        assert all(i.date_time == (2000, 1, 1, 0, 0, 0) and not i.extra and not i.comment for i in archive.infolist())
    return {"version": manifest["version"], "files": len(names), "bytes": output.stat().st_size,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "entries": names}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--extract-to", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.output.resolve()
    if args.extract_to and args.extract_to.exists():
        raise ValueError("Extraction destination must not exist")
    result = build(root, output)
    if args.extract_to:
        if args.extract_to.exists():
            raise ValueError("Extraction destination must not exist")
        with zipfile.ZipFile(output) as archive:
            archive.extractall(args.extract_to)
    print(json.dumps(result, indent=2))
