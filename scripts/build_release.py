"""Build a self-contained Data QuickLook release envelope for PlanHub."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import stat


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "analysis_engine.py",
    "app.py",
    "comparison.py",
    "excel_parser.py",
    "runtime_paths.py",
    "server.py",
    "shared_sync.py",
    "source_paths.py",
    "warehouse.py",
    "workspace_relocation.py",
    "requirements.txt",
    "README.md",
    "启动数据速查.cmd",
)
REQUIRED_WEB_FILES = {"web/index.html", "web/vendor/echarts.min.js", "web/vendor/NOTICE.md"}
WEB_EXTENSIONS = {
    ".html", ".css", ".js", ".mjs", ".svg", ".png", ".ico", ".jpg",
    ".jpeg", ".webp", ".gif", ".woff", ".woff2",
}
PRIVATE_NAMES = {
    "data", "input_file", "output_file", "logs", "backups", "uploads",
    "node_modules", "runtime", "tests", "__pycache__", "secrets",
}


def reject_links(path: Path) -> None:
    """Reject symbolic links and Windows reparse points in the path."""
    for ancestor in (path, *path.parents):
        try:
            details = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Release paths must not contain links or reparse points: {ancestor}")


def web_file_names(source: Path) -> list[str]:
    web = source / "web"
    reject_links(web)
    if not web.is_dir():
        raise ValueError("The web/ runtime directory is missing.")
    files = []
    directories = [web]
    while directories:
        for path in directories.pop().iterdir():
            reject_links(path)
            relative = path.relative_to(source).as_posix()
            name = path.name
            if (re.search(r'[\\:*?"<>|\x00-\x1f]', name)
                    or name.startswith(".") or name.endswith((".", " "))
                    or name.casefold() in PRIVATE_NAMES
                    or re.match(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I)):
                raise ValueError(f"Unexpected non-public path under web/: {relative}")
            if path.is_dir():
                directories.append(path)
            elif path.is_file() and (path.suffix.lower() in WEB_EXTENSIONS or relative in REQUIRED_WEB_FILES):
                files.append(relative)
            else:
                raise ValueError(f"Unexpected non-public file under web/: {relative}")
    missing = REQUIRED_WEB_FILES - set(files)
    if missing:
        raise ValueError("Missing required web files: " + ", ".join(sorted(missing)))
    return files


def build_release(source: Path, destination: Path, version: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", version) or version.endswith("."):
        raise ValueError("Version must match the PlanHub version format.")
    source = source.absolute()
    destination = destination.absolute()
    reject_links(source)
    reject_links(destination)
    source = source.resolve()
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("Release destination already exists. Choose a new version directory.")
    if destination.is_relative_to(source / "web"):
        raise ValueError("A release must not be built inside web/.")

    names = sorted((*RUNTIME_FILES, *web_file_names(source)))
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError("Release contains duplicate file paths.")
    snapshots = {}
    for name in names:
        path = source / name
        reject_links(path)
        if not path.is_file():
            raise ValueError(f"Missing runtime file: {name}")
        snapshots[name] = path.read_bytes()
    for name, contents in snapshots.items():
        path = source / name
        reject_links(path)
        if path.read_bytes() != contents:
            raise ValueError(f"Source changed during the build: {name}. Retry after edits are complete.")

    files = [
        {"path": name, "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}
        for name, contents in snapshots.items()
    ]
    fingerprint = hashlib.sha256(
        json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "appId": "quicklook",
        "version": version,
        "type": "service",
        "basePath": "/quicklook/",
        "entryPoint": "server.py",
        "sourceRevision": f"payload-sha256:{fingerprint}",
        "dataMode": "external",
        "healthPath": "/healthz",
        "files": files,
    }
    destination.mkdir(parents=True, exist_ok=False)
    payload = destination / "payload"
    for name, contents in snapshots.items():
        target = payload / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(contents)
        if target.read_bytes() != contents:
            raise OSError(f"Could not verify the copied release file: {name}")
    # An interrupted copy remains ineligible for publication without its manifest.
    with (destination / "app-release.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Unique PlanHub release version")
    parser.add_argument("--destination", type=Path, help="New release directory (default: output_file/releases)")
    args = parser.parse_args()
    destination = args.destination or ROOT / "output_file" / "releases" / f"quicklook-{args.version}"
    try:
        manifest = build_release(ROOT, destination, args.version)
    except (OSError, ValueError) as error:
        parser.exit(1, f"QuickLook release failed: {error}\n")
    print(f"{destination.resolve()} ({manifest['version']}, {len(manifest['files'])} payload files)")


if __name__ == "__main__":
    main()
