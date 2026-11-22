"""Portable configuration loader and environment capability resolver.

Replaces v1 hardcoded `/usr/bin/ffmpeg` version `n9.0.1` lock with portable
runtime detection of ffmpeg, ffprobe, h264_nvenc, and optional DeepFilterNet3.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY_PATH = REPO_ROOT / "config" / "policy.json"


@dataclass(frozen=True)
class RuntimeCapabilities:
    ffmpeg: str | None
    ffprobe: str | None
    ffmpeg_version: str
    has_nvenc: bool
    has_deepfilternet: bool


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def load_policy(project_root: Path | None = None) -> dict[str, Any]:
    if project_root is not None:
        override = project_root / "config" / "policy.json"
        if override.is_file():
            return load_json(override)
    return load_json(DEFAULT_POLICY_PATH)


def detect_capabilities() -> RuntimeCapabilities:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    ffmpeg_version = "unavailable"
    has_nvenc = False

    if ffmpeg:
        try:
            ver = subprocess.run(
                [ffmpeg, "-version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            first_line = (ver.stdout or "").splitlines()[0] if ver.stdout else "unknown"
            ffmpeg_version = first_line.strip()
        except Exception:
            ffmpeg_version = "unknown"

        try:
            enc = subprocess.run(
                [ffmpeg, "-hide_banner", "-encoders"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            has_nvenc = "h264_nvenc" in (enc.stdout or "")
        except Exception:
            has_nvenc = False

    has_df = shutil.which("deepFilter") is not None
    return RuntimeCapabilities(
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        ffmpeg_version=ffmpeg_version,
        has_nvenc=has_nvenc,
        has_deepfilternet=has_df,
    )
