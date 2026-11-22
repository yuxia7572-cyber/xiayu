"""Stage 2 (S2_AUDIO_AND_ATOMS): Non-destructive audio preprocessing & immutable segment_id atoms.

Fixes v1 hard logic bugs:
- Never hard-cuts audio in place before subtitle/timeline mapping (non-destructive master coordinates).
- DeepFilterNet3 is supported when installed, with clean automatic fallback to FFmpeg highpass+afftdn+loudnorm.
- >0.8s thinking pause between Q and A is trimmed adaptively (never drops the entire Q&A exchange!).
- Emits immutable integer-microsecond `segment_id` atoms so weak AI NEVER touches raw timestamps.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .config import RuntimeCapabilities, detect_capabilities, sha256_file, write_json


SRT_TIME_RE = re.compile(
    r"(?P<h1>\d{2}):(?P<m1>\d{2}):(?P<s1>\d{2})[,.](?P<ms1>\d{3})\s*-->\s*"
    r"(?P<h2>\d{2}):(?P<m2>\d{2}):(?P<s2>\d{2})[,.](?P<ms2>\d{3})"
)
SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)")


def _hms_to_us(h: str, m: str, s: str, ms: str) -> int:
    return ((int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(ms)) * 1000


def parse_srt_text(srt_text: str) -> list[dict[str, Any]]:
    blocks = re.split(r"\r?\n\s*\r?\n", srt_text.strip())
    entries: list[dict[str, Any]] = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        time_line_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if time_line_idx is None:
            continue
        m = SRT_TIME_RE.search(lines[time_line_idx])
        if not m:
            continue
        start_us = _hms_to_us(m.group("h1"), m.group("m1"), m.group("s1"), m.group("ms1"))
        end_us = _hms_to_us(m.group("h2"), m.group("m2"), m.group("s2"), m.group("ms2"))
        text = " ".join(lines[time_line_idx + 1 :]).strip()
        if end_us > start_us and text:
            entries.append({"start_us": start_us, "end_us": end_us, "text": text})
    return entries


def clean_audio_track(
    source_path: Path,
    out_wav: Path,
    policy: dict[str, Any],
    caps: RuntimeCapabilities,
) -> dict[str, Any]:
    """Produce a non-destructive cleaned 48kHz stereo WAV derivative alongside the master."""
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    if not caps.ffmpeg:
        return {"cleaned": False, "processor": "none", "reason": "ffmpeg_missing"}

    cfg = policy.get("audio_processing", {})
    sr = str(cfg.get("target_sample_rate_hz", 48000))
    ch = str(cfg.get("target_channels", 2))
    filter_chain = cfg.get(
        "ffmpeg_fallback_filter",
        "highpass=f=80:poles=2,afftdn=nf=-25,loudnorm=I=-16:LRA=7:TP=-1.5",
    )
    minimal_chain = cfg.get(
        "ffmpeg_minimal_filter",
        "highpass=f=80:poles=2,loudnorm=I=-16:LRA=7:TP=-1.5",
    )

    processor = "ffmpeg_highpass_afftdn_loudnorm"
    cmd = [
        caps.ffmpeg,
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-af",
        filter_chain,
        "-ar",
        sr,
        "-ac",
        ch,
        "-c:a",
        "pcm_s16le",
        str(out_wav),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
    if res.returncode != 0:
        # Fallback if a minimal FFmpeg build lacks afftdn
        processor = "ffmpeg_highpass_loudnorm_fallback"
        cmd_fb = [
            caps.ffmpeg,
            "-y",
            "-i",
            str(source_path),
            "-vn",
            "-af",
            minimal_chain,
            "-ar",
            sr,
            "-ac",
            ch,
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ]
        res = subprocess.run(cmd_fb, capture_output=True, text=True, timeout=180, check=False)

    if res.returncode != 0 or not out_wav.is_file():
        return {
            "cleaned": False,
            "processor": processor,
            "reason": (res.stderr or "ffmpeg_audio_clean_failed")[-240:],
        }

    # Optional DeepFilterNet3 pass if installed and enabled
    if cfg.get("prefer_deepfilternet") and caps.has_deepfilternet:
        df_dir = out_wav.parent / "df_tmp"
        df_dir.mkdir(parents=True, exist_ok=True)
        df_res = subprocess.run(
            ["deepFilter", str(out_wav), "-o", str(df_dir)],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        df_out = df_dir / out_wav.name
        if df_res.returncode == 0 and df_out.is_file():
            df_out.replace(out_wav)
            processor = "deepfilternet3_plus_loudnorm"

    return {
        "cleaned": True,
        "processor": processor,
        "sha256": sha256_file(out_wav),
    }


def detect_speech_spans(
    media_path: Path,
    duration_us: int,
    policy: dict[str, Any],
    caps: RuntimeCapabilities,
) -> list[tuple[int, int]]:
    """Detect non-silent speech spans on master timeline coordinates via FFmpeg silencedetect."""
    if not caps.ffmpeg or duration_us <= 0:
        return [(0, duration_us)] if duration_us > 0 else []

    cfg = policy.get("audio_processing", {})
    thresh_db = cfg.get("silence_threshold_db", -36.0)
    min_sil = cfg.get("min_silence_duration_sec", 0.45)
    preroll = int(cfg.get("boundary_preroll_us", 120_000))
    tail = int(cfg.get("boundary_tail_us", 180_000))

    cmd = [
        caps.ffmpeg,
        "-hide_banner",
        "-i",
        str(media_path),
        "-af",
        f"silencedetect=noise={thresh_db}dB:d={min_sil}",
        "-f",
        "null",
        "-",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    stderr = res.stderr or ""

    silences: list[tuple[int, int]] = []
    cur_start: int | None = None
    for line in stderr.splitlines():
        m_start = SILENCE_START_RE.search(line)
        if m_start:
            cur_start = int(round(float(m_start.group(1)) * 1_000_000))
        m_end = SILENCE_END_RE.search(line)
        if m_end:
            end_us = int(round(float(m_end.group(1)) * 1_000_000))
            start_us = cur_start if cur_start is not None else max(0, end_us - int(round(float(m_end.group(2)) * 1_000_000)))
            silences.append((max(0, start_us), min(duration_us, end_us)))
            cur_start = None
    if cur_start is not None and cur_start < duration_us:
        silences.append((max(0, cur_start), duration_us))

    if not silences:
        return [(0, duration_us)]

    spans: list[tuple[int, int]] = []
    cursor = 0
    for s_start, s_end in sorted(silences):
        if s_start - cursor >= 400_000:
            a = max(0, cursor - preroll)
            b = min(duration_us, s_start + tail)
            if spans and a <= spans[-1][1]:
                spans[-1] = (spans[-1][0], max(spans[-1][1], b))
            else:
                spans.append((a, b))
        cursor = max(cursor, s_end)
    if duration_us - cursor >= 400_000:
        a = max(0, cursor - preroll)
        if spans and a <= spans[-1][1]:
            spans[-1] = (spans[-1][0], duration_us)
        else:
            spans.append((a, duration_us))

    return spans or [(0, duration_us)]


def trim_long_thinking_pauses(atoms: list[dict[str, Any]], policy: dict[str, Any]) -> list[dict[str, Any]]:
    """Annotate inter-segment thinking pauses (>0.8s) to trim smoothly instead of deleting Q&A."""
    qa_cfg = policy.get("audio_processing", {}).get("qa_pause_handling", {})
    max_pause = int(qa_cfg.get("max_natural_pause_us", 800_000))
    trim_to = int(qa_cfg.get("trim_long_pause_to_us", 450_000))

    by_source: dict[str, list[dict[str, Any]]] = {}
    for atom in atoms:
        by_source.setdefault(atom["source_id"], []).append(atom)

    for src_atoms in by_source.values():
        src_atoms.sort(key=lambda a: a["source_start_us"])
        for i in range(1, len(src_atoms)):
            prev = src_atoms[i - 1]
            curr = src_atoms[i]
            gap = curr["source_start_us"] - prev["source_end_us"]
            curr["leading_gap_us"] = max(0, gap)
            if gap > max_pause:
                curr["adaptive_pause_trimmed"] = True
                curr["target_gap_after_prev_us"] = trim_to
            else:
                curr["adaptive_pause_trimmed"] = False
                curr["target_gap_after_prev_us"] = max(0, gap)
    return atoms


def run_audio_and_atoms(
    project_root: Path,
    source_manifest: dict[str, Any],
    doc_extracts: dict[str, Any],
    policy: dict[str, Any],
    caps: RuntimeCapabilities | None = None,
) -> dict[str, Any]:
    caps = caps or detect_capabilities()
    sidecar_by_stem: dict[str, list[dict[str, Any]]] = {}
    for sc in doc_extracts.get("subtitle_sidecars", []):
        parsed = parse_srt_text(sc.get("text", ""))
        if parsed:
            sidecar_by_stem[sc["stem"].lower()] = parsed

    cleaned_tracks: dict[str, dict[str, Any]] = {}
    atoms: list[dict[str, Any]] = []
    seg_counter = 0

    for src in source_manifest.get("sources", []):
        if not src.get("has_audio"):
            continue
        src_path = project_root / src["relative_path"]
        src_id = src["source_id"]
        stem = Path(src["filename"]).stem.lower()
        duration_us = int(src.get("duration_us") or 0)

        clean_rel = f"02-analysis/clean_audio/{src_id}_clean.wav"
        clean_info = clean_audio_track(src_path, project_root / clean_rel, policy, caps)
        cleaned_tracks[src_id] = {
            "source_id": src_id,
            "clean_audio_path": clean_rel if clean_info.get("cleaned") else src["relative_path"],
            **clean_info,
        }

        # Prefer sidecar SRT timestamps if provided; otherwise derive from FFmpeg silencedetect
        if stem in sidecar_by_stem:
            for entry in sidecar_by_stem[stem]:
                seg_counter += 1
                s_us = max(0, min(duration_us, entry["start_us"]))
                e_us = max(s_us + 200_000, min(duration_us, entry["end_us"]))
                atoms.append(
                    {
                        "segment_id": f"SEG_{seg_counter:04d}",
                        "source_id": src_id,
                        "source_filename": src["filename"],
                        "source_start_us": s_us,
                        "source_end_us": e_us,
                        "duration_us": e_us - s_us,
                        "text": entry["text"],
                        "transcript_origin": "sidecar_srt",
                    }
                )
        else:
            spans = detect_speech_spans(src_path, duration_us, policy, caps)
            for s_us, e_us in spans:
                seg_counter += 1
                atoms.append(
                    {
                        "segment_id": f"SEG_{seg_counter:04d}",
                        "source_id": src_id,
                        "source_filename": src["filename"],
                        "source_start_us": s_us,
                        "source_end_us": e_us,
                        "duration_us": e_us - s_us,
                        "text": f"[语音段 {src['filename']} {s_us / 1_000_000:.1f}s-{e_us / 1_000_000:.1f}s]",
                        "transcript_origin": "ffmpeg_silencedetect",
                    }
                )

    trim_long_thinking_pauses(atoms, policy)

    audio_atoms = {
        "schema_version": "2.0.0",
        "cleaned_tracks": cleaned_tracks,
        "atom_count": len(atoms),
        "atoms": atoms,
    }
    write_json(project_root / "02-analysis" / "audio_atoms.json", audio_atoms)
    return audio_atoms
