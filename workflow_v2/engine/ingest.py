"""Stage 1 (S1_INGEST): Media probing, crash-safe document extraction, and stable source ordering.

Fixes v1 bugs:
- Brochure PDFs, PPTs, images, or notes in 00-sources/ no longer crash the ingest stage.
- Deterministic source ordering uses embedded filename timestamps -> container creation_time -> sequence -> path.
- Generates immutable source_id keys and real SHA-256 digests.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .config import RuntimeCapabilities, detect_capabilities, sha256_file, write_json

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".mxf", ".mts", ".m4v", ".webm"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
TEXT_DOC_EXTS = {".txt", ".md", ".markdown", ".json", ".csv"}
SUBTITLE_EXTS = {".srt", ".vtt"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
OFFICE_DOC_EXTS = {".pdf", ".docx", ".pptx"}


def _parse_fps(rate_str: str | None) -> float:
    if not rate_str or rate_str in {"0/0", "N/A"}:
        return 30.0
    if "/" in rate_str:
        num, den = rate_str.split("/", 1)
        try:
            d = float(den)
            return round(float(num) / d, 3) if d > 0 else 30.0
        except ValueError:
            return 30.0
    try:
        return round(float(rate_str), 3)
    except ValueError:
        return 30.0


def probe_media(path: Path, ffprobe: str | None) -> dict[str, Any]:
    if not ffprobe:
        return {"probed": False, "error": "ffprobe_not_found"}

    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-print_format",
        "json",
        str(path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    if res.returncode != 0:
        return {"probed": False, "error": (res.stderr or "ffprobe_failed").strip()[:240]}

    raw = json.loads(res.stdout or "{}")
    fmt = raw.get("format", {})
    streams = raw.get("streams", [])
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration_sec = float(fmt.get("duration") or 0.0)
    if duration_sec <= 0 and v_stream and v_stream.get("duration"):
        duration_sec = float(v_stream["duration"])
    if duration_sec <= 0 and a_stream and a_stream.get("duration"):
        duration_sec = float(a_stream["duration"])

    creation_time = (fmt.get("tags") or {}).get("creation_time") or ""
    return {
        "probed": True,
        "duration_us": max(0, int(round(duration_sec * 1_000_000))),
        "creation_time": creation_time,
        "has_video": v_stream is not None,
        "has_audio": a_stream is not None,
        "video": (
            {
                "codec": v_stream.get("codec_name", ""),
                "width": int(v_stream.get("width") or 0),
                "height": int(v_stream.get("height") or 0),
                "fps": _parse_fps(v_stream.get("avg_frame_rate") or v_stream.get("r_frame_rate")),
            }
            if v_stream
            else None
        ),
        "audio": (
            {
                "codec": a_stream.get("codec_name", ""),
                "sample_rate_hz": int(a_stream.get("sample_rate") or 0),
                "channels": int(a_stream.get("channels") or 0),
            }
            if a_stream
            else None
        ),
    }


def _extract_order_key(rel_path: str, creation_time: str, policy: dict[str, Any]) -> tuple[int, str, int, str]:
    """Deterministic ordering: embedded timestamp -> container creation_time -> sequence -> path."""
    order_cfg = policy.get("source_order", {})
    patterns = order_cfg.get("embedded_timestamp_patterns", [])
    for pat in patterns:
        m = re.search(pat, rel_path)
        if m:
            d = re.sub(r"[^0-9]", "", m.group("date"))
            t = re.sub(r"[^0-9]", "", m.group("time"))
            return (0, f"{d}_{t}", 0, rel_path)

    if creation_time:
        return (1, creation_time, 0, rel_path)

    seq_pat = order_cfg.get("sequence_token_pattern", r"(?:^|[_-])(?P<sequence>[0-9]{1,6})(?:[_-]|$)")
    m_seq = re.search(seq_pat, Path(rel_path).stem)
    if m_seq:
        return (2, "", int(m_seq.group("sequence")), rel_path)

    return (3, "", 0, rel_path)


def _extract_document_text(path: Path) -> tuple[str, str]:
    ext = path.suffix.lower()
    if ext in TEXT_DOC_EXTS or ext in SUBTITLE_EXTS:
        return path.read_text(encoding="utf-8", errors="replace")[:30000], "plain_text"

    if ext == ".pdf":
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(path))
            chunks = [(page.extract_text() or "") for page in reader.pages[:30]]
            return "\n".join(chunks)[:30000], "pypdf"
        except Exception:
            return "", "pdf_skipped_install_pypdf"

    if ext == ".docx":
        try:
            import docx  # type: ignore

            doc = docx.Document(str(path))
            return "\n".join(p.text for p in doc.paragraphs)[:30000], "python_docx"
        except Exception:
            return "", "docx_skipped_install_python_docx"

    return "", "non_text_skipped"


def run_ingest(
    project_root: Path,
    policy: dict[str, Any],
    caps: RuntimeCapabilities | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    caps = caps or detect_capabilities()
    sources_dir = project_root / "00-sources"
    if not sources_dir.is_dir():
        raise FileNotFoundError(f"素材目录不存在：{sources_dir}（请将采访视频、空镜、字幕或企业文档放入 00-sources/）")

    media_candidates: list[dict[str, Any]] = []
    documents: list[dict[str, Any]] = []
    subtitles_sidecars: list[dict[str, Any]] = []
    skipped_files: list[dict[str, Any]] = []

    for file_path in sorted(sources_dir.rglob("*")):
        if not file_path.is_file() or file_path.name.startswith("."):
            continue
        rel = str(file_path.relative_to(project_root)).replace("\\", "/")
        ext = file_path.suffix.lower()
        digest = sha256_file(file_path)
        size_bytes = file_path.stat().st_size

        if ext in VIDEO_EXTS or ext in AUDIO_EXTS:
            probe = probe_media(file_path, caps.ffprobe)
            if not probe.get("probed"):
                skipped_files.append({"relative_path": rel, "reason": probe.get("error", "unreadable_media")})
                continue
            media_candidates.append(
                {
                    "relative_path": rel,
                    "filename": file_path.name,
                    "media_kind": "video" if probe.get("has_video") else "audio",
                    "size_bytes": size_bytes,
                    "sha256": digest,
                    "duration_us": probe["duration_us"],
                    "creation_time": probe.get("creation_time", ""),
                    "has_video": probe["has_video"],
                    "has_audio": probe["has_audio"],
                    "video": probe["video"],
                    "audio": probe["audio"],
                    "_order_key": _extract_order_key(rel, probe.get("creation_time", ""), policy),
                }
            )
        elif ext in SUBTITLE_EXTS:
            text, method = _extract_document_text(file_path)
            subtitles_sidecars.append(
                {
                    "relative_path": rel,
                    "stem": file_path.stem,
                    "sha256": digest,
                    "method": method,
                    "text": text,
                }
            )
        elif ext in TEXT_DOC_EXTS or ext in OFFICE_DOC_EXTS:
            text, method = _extract_document_text(file_path)
            documents.append(
                {
                    "relative_path": rel,
                    "filename": file_path.name,
                    "sha256": digest,
                    "method": method,
                    "char_count": len(text),
                    "text": text,
                }
            )
        elif ext in IMAGE_EXTS:
            # Images (logos, product stills, PPT slides) are preserved safely without crashing
            media_candidates.append(
                {
                    "relative_path": rel,
                    "filename": file_path.name,
                    "media_kind": "image",
                    "size_bytes": size_bytes,
                    "sha256": digest,
                    "duration_us": 5_000_000,
                    "creation_time": "",
                    "has_video": True,
                    "has_audio": False,
                    "video": None,
                    "audio": None,
                    "_order_key": _extract_order_key(rel, "", policy),
                }
            )
        else:
            skipped_files.append({"relative_path": rel, "reason": f"unsupported_extension:{ext}"})

    # Stable deterministic ordering
    media_candidates.sort(key=lambda item: item["_order_key"])
    ordered_sources: list[dict[str, Any]] = []
    for idx, item in enumerate(media_candidates, 1):
        item.pop("_order_key", None)
        item["source_id"] = f"SRC_{idx:03d}"
        item["order_index"] = idx
        ordered_sources.append(item)

    source_manifest = {
        "schema_version": "2.0.0",
        "project_root": str(project_root),
        "runtime": {
            "ffmpeg": caps.ffmpeg,
            "ffmpeg_version": caps.ffmpeg_version,
            "has_nvenc": caps.has_nvenc,
            "has_deepfilternet": caps.has_deepfilternet,
        },
        "source_count": len(ordered_sources),
        "sources": ordered_sources,
        "subtitle_sidecars": [
            {k: v for k, v in s.items() if k != "text"} for s in subtitles_sidecars
        ],
        "skipped_files": skipped_files,
    }
    doc_extracts = {
        "schema_version": "2.0.0",
        "documents": documents,
        "subtitle_sidecars": subtitles_sidecars,
    }

    write_json(project_root / "01-ingest" / "source_manifest.json", source_manifest)
    write_json(project_root / "01-ingest" / "doc_extracts.json", doc_extracts)
    return source_manifest, doc_extracts
