#!/usr/bin/env python3
"""Environment doctor for interview-video-objective-agent v2."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.config import detect_capabilities


def main() -> int:
    caps = detect_capabilities()
    report = {
        "python_version": sys.version.split()[0],
        "ffmpeg": caps.ffmpeg,
        "ffprobe": caps.ffprobe,
        "ffmpeg_version": caps.ffmpeg_version,
        "gpu_nvenc_available": caps.has_nvenc,
        "deepfilternet3_available": caps.has_deepfilternet,
        "ready": bool(caps.ffmpeg and caps.ffprobe),
        "notes": (
            "环境就绪：可直接运行 python3 run_pipeline.py demo ./demo_project 验证全流程。"
            if caps.ffmpeg and caps.ffprobe
            else "请先安装 FFmpeg 与 FFprobe 并确保位于 PATH 中。"
        ),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
