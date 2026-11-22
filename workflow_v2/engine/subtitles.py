"""Stage 5B (S5_SUBTITLES): Zero-punctuation accompanying semantic subtitle dual-compiler (.ass & .srt).

Fixes v1 bugs:
- Consumes Director accompanying `chunks` directly — NEVER does mechanical `len(text)//2` midpoint splits.
- Replaces unreadable black-text-with-white-outline styling with crisp broadcast white text + dark outline/shadow.
- Zero punctuation marks, zero role prefixes ("记者：/受访者："), zero hardcoded placeholder strings.
- Runs strictly AFTER SQLite ledger locking so subtitle timestamps 100% match final locked timeline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .weak_ai_bridge import strip_punctuation


def _format_ass_time(us: int) -> str:
    cs_total = max(0, int(round(us / 10_000)))
    cs = cs_total % 100
    sec_total = cs_total // 100
    sec = sec_total % 60
    min_total = sec_total // 60
    minute = min_total % 60
    hour = min_total // 60
    return f"{hour}:{minute:02d}:{sec:02d}.{cs:02d}"


def _format_srt_time(us: int) -> str:
    ms_total = max(0, int(round(us / 1_000)))
    ms = ms_total % 1000
    sec_total = ms_total // 1000
    sec = sec_total % 60
    min_total = sec_total // 60
    minute = min_total % 60
    hour = min_total // 60
    return f"{hour:02d}:{minute:02d}:{sec:02d},{ms:03d}"


def compile_subtitles(
    project_root: Path,
    timeline_plan: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    sub_cfg = policy.get("subtitles", {})
    style = sub_cfg.get("style", {})
    font_name = style.get("font_name", "Noto Sans CJK SC")
    font_size = int(style.get("font_size", 52))
    primary = style.get("primary_colour_ass", "&H00FFFFFF")
    outline_col = style.get("outline_colour_ass", "&H00181818")
    back_col = style.get("back_colour_ass", "&H80000000")
    outline_px = float(style.get("outline_px", 2.5))
    shadow_px = float(style.get("shadow_px", 1.2))
    margin_v = int(style.get("margin_v", 58))
    alignment = int(style.get("alignment", 2))

    ass_lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font_name},{font_size},{primary},&H000000FF,{outline_col},{back_col},0,0,0,0,100,100,1,0,1,{outline_px},{shadow_px},{alignment},80,80,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    srt_blocks: list[str] = []

    srt_index = 0
    for cue in timeline_plan.get("subtitle_cues", []):
        t_start = int(cue["timeline_start_us"])
        t_end = int(cue["timeline_end_us"])
        if t_end <= t_start:
            continue

        raw_chunks = cue.get("chunks") or []
        clean_chunks = [strip_punctuation(str(c)) for c in raw_chunks if strip_punctuation(str(c))]
        if not clean_chunks:
            continue

        # Distribute cue duration proportionally by character count across semantic chunks
        weights = [max(1, len(c)) for c in clean_chunks]
        total_w = sum(weights)
        chunk_cursor = t_start
        for idx, (chunk_text, w) in enumerate(zip(clean_chunks, weights)):
            if idx == len(clean_chunks) - 1:
                c_end = t_end
            else:
                c_end = chunk_cursor + int(round((t_end - t_start) * (w / total_w)))
                c_end = min(t_end, max(chunk_cursor + 250_000, c_end))

            ass_lines.append(
                f"Dialogue: 0,{_format_ass_time(chunk_cursor)},{_format_ass_time(c_end)},Default,,0,0,0,,{chunk_text}"
            )
            srt_index += 1
            srt_blocks.append(
                f"{srt_index}\n{_format_srt_time(chunk_cursor)} --> {_format_srt_time(c_end)}\n{chunk_text}\n"
            )
            chunk_cursor = c_end

    ass_path = project_root / "04-plan" / "subtitles.ass"
    srt_path = project_root / "04-plan" / "subtitles.srt"
    ass_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path.write_text("\n".join(ass_lines) + "\n", encoding="utf-8")
    srt_path.write_text("\n".join(srt_blocks) + "\n", encoding="utf-8")

    return {
        "ass_path": "04-plan/subtitles.ass",
        "srt_path": "04-plan/subtitles.srt",
        "cue_count": srt_index,
        "zero_punctuation": True,
    }
