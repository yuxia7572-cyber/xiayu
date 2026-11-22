"""Stages 4 & 5A: Dual-track Voiceover Assembly, 3-Tier B-roll Scheduling, and SQLite Atomic Ledger.

Fixes v1 hard logic bugs:
- Removes `zhao_jin_clone` hardcoding: supports manual `.wav` drop-in (`05-voice/manual/*.wav`)
  OR auto-estimated speech pacing when voice files are pending.
- Fixes DAG layer inversion: voiceover duration is resolved BEFORE timeline assembly, and
  SQLite ledger locks ALL intervals BEFORE subtitle compilation & render.
- Eliminates deadlock on interval collision or clip shortage: tries Candidate A -> B -> C ->
  next unused visual clip -> interview camera fallback (with explicit review_queue warning),
  NEVER crashing the entire pipeline!
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .config import RuntimeCapabilities, detect_capabilities, load_json, sha256_file, write_json
from .ingest import probe_media
from .weak_ai_bridge import call_weak_ai_if_configured


def assemble_voice_manifest(
    project_root: Path,
    director_plan: dict[str, Any],
    policy: dict[str, Any],
    caps: RuntimeCapabilities | None = None,
) -> dict[str, Any]:
    """Dual-track voiceover resolver: imports manual WAVs if provided, else estimates pacing."""
    caps = caps or detect_capabilities()
    manual_dir = project_root / "05-voice" / "manual"
    pause_us = int(policy.get("merged_version", {}).get("intro", {}).get("sentence_pause_us", 350_000))

    items: list[dict[str, Any]] = []
    total_us = 0
    for sent in director_plan.get("narration_sentences", []):
        sid = sent["sentence_id"]
        text = sent["text"]
        # Check for manual recording: N01.wav / N01.mp3 / N01.m4a
        found_audio: Path | None = None
        for ext in (".wav", ".mp3", ".m4a", ".flac"):
            cand = manual_dir / f"{sid}{ext}"
            if cand.is_file():
                found_audio = cand
                break

        if found_audio is not None:
            probe = probe_media(found_audio, caps.ffprobe)
            dur_us = max(1_500_000, int(probe.get("duration_us") or 3_500_000))
            rel = str(found_audio.relative_to(project_root)).replace("\\", "/")
            mode = "manual_recording"
            digest = sha256_file(found_audio)
        else:
            # Deterministic Chinese speaking rate estimate (~4.2 chars/sec, min 3.0s, max 9.0s)
            est_sec = max(3.0, min(9.0, len(text) / 4.2))
            dur_us = int(round(est_sec * 1_000_000))
            rel = None
            mode = "silent_voicebed_pending_dub"
            digest = None

        items.append(
            {
                "sentence_id": sid,
                "text": text,
                "fact_ids": sent.get("fact_ids", []),
                "suggested_visual_theme": sent.get("suggested_visual_theme", ""),
                "subtitle_chunks": sent.get("subtitle_chunks", []),
                "audio_mode": mode,
                "relative_path": rel,
                "sha256": digest,
                "duration_us": dur_us,
                "pause_after_us": pause_us,
            }
        )
        total_us += dur_us + pause_us

    manifest = {
        "schema_version": "2.0.0",
        "voice_provider": policy.get("merged_version", {}).get("intro", {}).get("voice_provider", "dual_track_manual_or_tts"),
        "sentence_count": len(items),
        "total_duration_us": total_us,
        "has_pending_dub": any(i["audio_mode"] == "silent_voicebed_pending_dub" for i in items),
        "sentences": items,
    }
    write_json(project_root / "05-voice" / "voice_manifest.json", manifest)
    return manifest


def _score_visual_match(theme_text: str, asset: dict[str, Any]) -> int:
    text = (theme_text or "").lower()
    score = 0
    for tag in asset.get("semantic_tags", []):
        if tag and tag.lower() in text:
            score += 3
    summary = (asset.get("visual_summary") or "").lower()
    for token in set(text.split()):
        if len(token) >= 2 and token in summary:
            score += 1
    if asset.get("base_class") == "company_scene":
        score += 1
    return score


def schedule_broll_candidates(
    project_root: Path,
    asset_catalog: dict[str, Any],
    voice_manifest: dict[str, Any],
    director_plan: dict[str, Any],
    audio_atoms: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Build 3-tier fallback B-roll candidates (A -> B -> C) for Part 1 intro & Part 2 long answers."""
    visual_pool = [
        a for a in asset_catalog.get("assets", []) if a["base_class"] in {"company_scene", "person_scene"}
    ]
    valid_pool_ids = {a["source_id"] for a in visual_pool}
    atom_map = {a["segment_id"]: a for a in audio_atoms.get("atoms", [])}
    min_answer_us = int(policy.get("merged_version", {}).get("interview", {}).get("min_answer_for_broll_us", 14_000_000))

    slots_needed: list[dict[str, Any]] = []
    for sent in voice_manifest.get("sentences", []):
        slots_needed.append(
            {
                "slot_id": sent["sentence_id"],
                "section": "intro",
                "theme": sent.get("suggested_visual_theme") or sent["text"],
                "target_duration_us": sent["duration_us"],
            }
        )

    for dec in director_plan.get("segment_decisions", []):
        if dec.get("effective_action") != "keep" or dec.get("speaker_role") == "interviewer":
            continue
        atom = atom_map.get(dec["segment_id"])
        if atom and atom["duration_us"] >= min_answer_us:
            slots_needed.append(
                {
                    "slot_id": f"BROLL_{dec['segment_id']}",
                    "section": "interview_cutaway",
                    "segment_id": dec["segment_id"],
                    "theme": atom["text"][:40],
                    "target_duration_us": int(
                        policy.get("merged_version", {})
                        .get("interview", {})
                        .get("broll_clip_duration_us", {})
                        .get("target", 4_800_000)
                    ),
                }
            )

    manual_path = project_root / "03-director" / "ai_inputs" / "03_broll.json"
    raw_ai = load_json(manual_path) if manual_path.is_file() else None
    if raw_ai is None and slots_needed and visual_pool:
        raw_ai = call_weak_ai_if_configured(
            "03_broll_scheduler.md",
            {
                "slots": slots_needed,
                "visual_catalog": visual_pool,
            },
        )

    ai_by_slot: dict[str, dict[str, Any]] = {}
    if isinstance(raw_ai, dict) and isinstance(raw_ai.get("slots"), list):
        for row in raw_ai["slots"]:
            if isinstance(row, dict) and row.get("slot_id"):
                cands = [str(c) for c in (row.get("candidates") or []) if str(c) in valid_pool_ids]
                if cands:
                    ai_by_slot[str(row["slot_id"])] = {
                        "candidates": cands[:3],
                        "match_reason": str(row.get("match_reason") or "AI 语义匹配"),
                        "confidence": float(row.get("confidence", 0.8)),
                    }

    scheduled: list[dict[str, Any]] = []
    for idx, slot in enumerate(slots_needed):
        if slot["slot_id"] in ai_by_slot:
            entry = ai_by_slot[slot["slot_id"]]
            cands = entry["candidates"]
            reason = entry["match_reason"]
            conf = entry["confidence"]
        else:
            ranked = sorted(
                visual_pool,
                key=lambda a: (-_score_visual_match(slot["theme"], a), (a["source_id"] != f"SRC_{(idx % max(1, len(visual_pool))) + 1:03d}"), a["source_id"]),
            )
            # Rotate top tie-breaks so consecutive slots get distinct primary candidates
            if len(ranked) > 1:
                shift = idx % len(ranked)
                ranked = ranked[shift:] + ranked[:shift]
            cands = [a["source_id"] for a in ranked[:3]]
            reason = "启发式语义标签排序 + 三级替补队列"
            conf = 0.78 if cands else 0.4

        scheduled.append(
            {
                **slot,
                "candidates": cands,
                "match_reason": reason,
                "confidence": conf,
            }
        )

    broll_schedule = {
        "schema_version": "2.0.0",
        "slot_count": len(scheduled),
        "slots": scheduled,
    }
    write_json(project_root / "04-plan" / "broll_schedule.json", broll_schedule)
    return broll_schedule


class MaterialLedger:
    """SQLite atomic interval reservation ledger with non-overlapping slice allocation."""

    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        if db_path.exists():
            db_path.unlink()
        self.conn = sqlite3.connect(str(db_path))
        self.conn.execute(
            """
            CREATE TABLE reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version_id TEXT NOT NULL,
                modality TEXT NOT NULL,
                source_id TEXT NOT NULL,
                start_us INTEGER NOT NULL,
                end_us INTEGER NOT NULL,
                event_id TEXT NOT NULL
            )
            """
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def _get_used(self, version_id: str, modality: str, source_id: str) -> list[tuple[int, int]]:
        cur = self.conn.execute(
            """
            SELECT start_us, end_us FROM reservations
            WHERE version_id = ? AND modality = ? AND source_id = ?
            ORDER BY start_us ASC
            """,
            (version_id, modality, source_id),
        )
        return [(int(r[0]), int(r[1])) for r in cur.fetchall()]

    def reserve_exact(
        self,
        version_id: str,
        modality: str,
        source_id: str,
        start_us: int,
        end_us: int,
        event_id: str,
    ) -> bool:
        if end_us <= start_us:
            return False
        for u_s, u_e in self._get_used(version_id, modality, source_id):
            if start_us < u_e and end_us > u_s:
                return False
        self.conn.execute(
            """
            INSERT INTO reservations (version_id, modality, source_id, start_us, end_us, event_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (version_id, modality, source_id, start_us, end_us, event_id),
        )
        self.conn.commit()
        return True

    def reserve_free_slice(
        self,
        version_id: str,
        modality: str,
        source_id: str,
        source_duration_us: int,
        desired_duration_us: int,
        event_id: str,
        min_duration_us: int = 1_500_000,
    ) -> tuple[int, int] | None:
        """Find the earliest non-overlapping interval inside source_id and reserve it atomically."""
        if source_duration_us < min_duration_us:
            return None
        used = self._get_used(version_id, modality, source_id)
        cursor = 0
        for u_s, u_e in used:
            avail = u_s - cursor
            if avail >= min(desired_duration_us, source_duration_us) and avail >= min_duration_us:
                take = min(desired_duration_us, avail)
                if self.reserve_exact(version_id, modality, source_id, cursor, cursor + take, event_id):
                    return (cursor, cursor + take)
            cursor = max(cursor, u_e)
        avail = source_duration_us - cursor
        if avail >= min_duration_us:
            take = min(desired_duration_us, avail)
            if self.reserve_exact(version_id, modality, source_id, cursor, cursor + take, event_id):
                return (cursor, cursor + take)
        return None

    def audit_overlaps(self) -> list[str]:
        """Return list of any overlapping reservations (must be empty!)."""
        cur = self.conn.execute(
            """
            SELECT a.event_id, b.event_id, a.source_id, a.modality
            FROM reservations a
            JOIN reservations b
              ON a.id < b.id
             AND a.version_id = b.version_id
             AND a.modality = b.modality
             AND a.source_id = b.source_id
             AND a.start_us < b.end_us
             AND a.end_us > b.start_us
            """
        )
        return [
            f"Overlap between {r[0]} and {r[1]} on {r[2]} ({r[3]})"
            for r in cur.fetchall()
        ]


def build_locked_timeline(
    project_root: Path,
    source_manifest: dict[str, Any],
    asset_catalog: dict[str, Any],
    audio_atoms: dict[str, Any],
    director_plan: dict[str, Any],
    voice_manifest: dict[str, Any],
    broll_schedule: dict[str, Any],
    review_doc: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Assemble the unified non-destructive timeline and lock all intervals in SQLite BEFORE subtitles/render."""
    version_id = policy.get("merged_version", {}).get("version_id", "merged_interview_with_intro")
    source_map = {s["source_id"]: s for s in source_manifest.get("sources", [])}
    atom_map = {a["segment_id"]: a for a in audio_atoms.get("atoms", [])}
    cleaned_tracks = audio_atoms.get("cleaned_tracks", {})
    broll_by_slot = {s["slot_id"]: s for s in broll_schedule.get("slots", [])}
    visual_assets = [
        a for a in asset_catalog.get("assets", []) if a["base_class"] in {"company_scene", "person_scene"}
    ]

    db_path = project_root / "04-plan" / "material_ledger.sqlite"
    ledger = MaterialLedger(db_path)

    video_events: list[dict[str, Any]] = []
    audio_events: list[dict[str, Any]] = []
    subtitle_cues: list[dict[str, Any]] = []
    swap_log: list[dict[str, Any]] = []

    cursor_us = 0
    v_idx = 0
    a_idx = 0

    def reserve_visual_with_fallback(
        slot_id: str,
        candidates: list[str],
        desired_us: int,
        allow_reuse_fallback: bool = True,
    ) -> tuple[str, int, int, str] | None:
        nonlocal v_idx
        tried: list[str] = []
        # Tier 1-3: Explicit candidates A -> B -> C
        for rank, sid in enumerate(candidates):
            src = source_map.get(sid)
            if not src or not src.get("has_video"):
                continue
            tried.append(sid)
            sl = ledger.reserve_free_slice(
                version_id,
                "video",
                sid,
                int(src["duration_us"]),
                desired_us,
                f"V_{slot_id}",
                min_duration_us=min(1_000_000, int(src["duration_us"])),
            )
            if sl:
                tier = f"candidate_tier_{rank + 1}"
                if rank > 0:
                    swap_log.append(
                        {
                            "slot_id": slot_id,
                            "swapped_from": candidates[0],
                            "swapped_to": sid,
                            "reason": "primary_interval_occupied_auto_fallback",
                        }
                    )
                return (sid, sl[0], sl[1], tier)

        # Tier 4: Any other unused visual clip in pool
        for asset in visual_assets:
            sid = asset["source_id"]
            if sid in tried:
                continue
            src = source_map.get(sid)
            if not src or not src.get("has_video"):
                continue
            sl = ledger.reserve_free_slice(
                version_id,
                "video",
                sid,
                int(src["duration_us"]),
                desired_us,
                f"V_{slot_id}",
                min_duration_us=min(1_000_000, int(src["duration_us"])),
            )
            if sl:
                swap_log.append(
                    {
                        "slot_id": slot_id,
                        "swapped_from": candidates[0] if candidates else "none",
                        "swapped_to": sid,
                        "reason": "pool_auto_fallback",
                    }
                )
                return (sid, sl[0], sl[1], "pool_fallback")

        # Tier 5: Graceful shortage fallback instead of crashing pipeline
        if allow_reuse_fallback and visual_assets:
            sid = visual_assets[0]["source_id"]
            src = source_map[sid]
            take = min(desired_us, int(src["duration_us"]))
            review_doc["items"].append(
                {
                    "stage": "S5_LEDGER",
                    "item_id": slot_id,
                    "severity": "warning",
                    "reason": f"空镜总时长不足，槽位 {slot_id} 已触发软降级复用 {sid}（避免阻塞渲染），建议补充空镜素材。",
                    "default_action": "soft_reuse_with_warning",
                }
            )
            return (sid, 0, take, "shortage_soft_reuse")

        return None

    # --- PART 1A: Golden Trio Optional Opener (intro_logo / company_entrance) ---
    for special_role, cfg_key in (
        ("intro_logo", "intro_logo_duration_us"),
        ("company_entrance", "company_entrance_duration_us"),
    ):
        matched = next(
            (a for a in asset_catalog.get("assets", []) if a.get("special_role") == special_role),
            None,
        )
        if not matched:
            continue
        dur_us = int(policy.get("merged_version", {}).get("golden_trio", {}).get(cfg_key, 3_500_000))
        res = reserve_visual_with_fallback(f"OPEN_{special_role}", [matched["source_id"]], dur_us, allow_reuse_fallback=False)
        if res:
            sid, s_start, s_end, tier = res
            ev_dur = s_end - s_start
            v_idx += 1
            video_events.append(
                {
                    "event_id": f"V{v_idx:03d}",
                    "section": special_role,
                    "source_id": sid,
                    "relative_path": source_map[sid]["relative_path"],
                    "source_start_us": s_start,
                    "source_end_us": s_end,
                    "timeline_start_us": cursor_us,
                    "timeline_end_us": cursor_us + ev_dur,
                    "allocation_tier": tier,
                }
            )
            a_idx += 1
            audio_events.append(
                {
                    "event_id": f"A{a_idx:03d}",
                    "section": special_role,
                    "binding_mode": "silence_pad",
                    "source_id": None,
                    "relative_path": None,
                    "source_start_us": 0,
                    "source_end_us": ev_dur,
                    "timeline_start_us": cursor_us,
                    "timeline_end_us": cursor_us + ev_dur,
                }
            )
            cursor_us += ev_dur

    # --- PART 1B: Documentary Intro Narration + Semantic B-roll ---
    for sent in voice_manifest.get("sentences", []):
        sid_slot = sent["sentence_id"]
        slot_dur = int(sent["duration_us"]) + int(sent.get("pause_after_us", 0))
        sched = broll_by_slot.get(sid_slot, {})
        res = reserve_visual_with_fallback(sid_slot, sched.get("candidates", []), slot_dur, allow_reuse_fallback=True)
        if not res:
            continue
        vis_sid, s_start, s_end, tier = res
        actual_dur = min(slot_dur, s_end - s_start)
        if actual_dur < slot_dur and source_map[vis_sid]["duration_us"] >= slot_dur:
            actual_dur = slot_dur
        v_idx += 1
        video_events.append(
            {
                "event_id": f"V{v_idx:03d}",
                "section": "intro",
                "slot_id": sid_slot,
                "source_id": vis_sid,
                "relative_path": source_map[vis_sid]["relative_path"],
                "source_start_us": s_start,
                "source_end_us": s_start + min(actual_dur, s_end - s_start),
                "timeline_start_us": cursor_us,
                "timeline_end_us": cursor_us + actual_dur,
                "allocation_tier": tier,
            }
        )
        a_idx += 1
        audio_events.append(
            {
                "event_id": f"A{a_idx:03d}",
                "section": "intro",
                "binding_mode": "narration_voiceover" if sent.get("relative_path") else "silence_pad",
                "source_id": sid_slot,
                "relative_path": sent.get("relative_path"),
                "source_start_us": 0,
                "source_end_us": min(sent["duration_us"], actual_dur),
                "timeline_start_us": cursor_us,
                "timeline_end_us": cursor_us + actual_dur,
            }
        )
        subtitle_cues.append(
            {
                "cue_id": f"SUB_{sid_slot}",
                "section": "intro",
                "timeline_start_us": cursor_us,
                "timeline_end_us": cursor_us + min(sent["duration_us"], actual_dur),
                "chunks": sent.get("subtitle_chunks") or [sent["text"]],
            }
        )
        cursor_us += actual_dur

    # --- PART 2: Interview Q&A (Non-Destructive Master Coords + Optional Mid-Answer B-roll) ---
    head_us = int(policy.get("merged_version", {}).get("interview", {}).get("answer_head_interview_us", 8_000_000))
    tail_us = int(policy.get("merged_version", {}).get("interview", {}).get("answer_tail_interview_us", 3_000_000))

    for dec in director_plan.get("segment_decisions", []):
        if dec.get("effective_action") != "keep":
            continue
        seg_id = dec["segment_id"]
        atom = atom_map.get(seg_id)
        if not atom:
            continue
        src = source_map.get(atom["source_id"])
        if not src:
            continue
        s_start = int(atom["source_start_us"])
        s_end = int(atom["source_end_us"])
        seg_dur = s_end - s_start
        if seg_dur < 300_000:
            continue

        # Reserve audio interval in SQLite ledger
        ledger.reserve_exact(version_id, "audio", atom["source_id"], s_start, s_end, f"A_{seg_id}")
        clean_audio_rel = cleaned_tracks.get(atom["source_id"], {}).get("clean_audio_path") or src["relative_path"]

        a_idx += 1
        audio_events.append(
            {
                "event_id": f"A{a_idx:03d}",
                "section": "interview",
                "segment_id": seg_id,
                "binding_mode": "same_source_cleaned",
                "source_id": atom["source_id"],
                "relative_path": clean_audio_rel,
                "source_start_us": s_start,
                "source_end_us": s_end,
                "timeline_start_us": cursor_us,
                "timeline_end_us": cursor_us + seg_dur,
            }
        )

        # Check if this long interviewee answer has a scheduled semantic B-roll cutaway
        cutaway_slot = broll_by_slot.get(f"BROLL_{seg_id}")
        placed_cutaway = False
        if (
            cutaway_slot
            and dec.get("speaker_role") != "interviewer"
            and seg_dur >= head_us + tail_us + 2_500_000
        ):
            broll_dur = min(cutaway_slot["target_duration_us"], seg_dur - head_us - tail_us)
            res = reserve_visual_with_fallback(
                cutaway_slot["slot_id"],
                cutaway_slot.get("candidates", []),
                broll_dur,
                allow_reuse_fallback=False,
            )
            if res:
                b_sid, b_start, b_end, tier = res
                b_take = min(broll_dur, b_end - b_start)
                mid_start = s_start + head_us
                mid_end = mid_start + b_take
                # Head interview camera
                ledger.reserve_exact(version_id, "video", atom["source_id"], s_start, mid_start, f"V_{seg_id}_head")
                v_idx += 1
                video_events.append(
                    {
                        "event_id": f"V{v_idx:03d}",
                        "section": "interview",
                        "segment_id": seg_id,
                        "source_id": atom["source_id"],
                        "relative_path": src["relative_path"],
                        "source_start_us": s_start,
                        "source_end_us": mid_start,
                        "timeline_start_us": cursor_us,
                        "timeline_end_us": cursor_us + head_us,
                        "allocation_tier": "interview_camera",
                    }
                )
                # Middle B-roll cutaway
                v_idx += 1
                video_events.append(
                    {
                        "event_id": f"V{v_idx:03d}",
                        "section": "interview_cutaway",
                        "segment_id": seg_id,
                        "source_id": b_sid,
                        "relative_path": source_map[b_sid]["relative_path"],
                        "source_start_us": b_start,
                        "source_end_us": b_start + b_take,
                        "timeline_start_us": cursor_us + head_us,
                        "timeline_end_us": cursor_us + head_us + b_take,
                        "allocation_tier": tier,
                    }
                )
                # Tail interview camera
                ledger.reserve_exact(version_id, "video", atom["source_id"], mid_end, s_end, f"V_{seg_id}_tail")
                v_idx += 1
                video_events.append(
                    {
                        "event_id": f"V{v_idx:03d}",
                        "section": "interview",
                        "segment_id": seg_id,
                        "source_id": atom["source_id"],
                        "relative_path": src["relative_path"],
                        "source_start_us": mid_end,
                        "source_end_us": s_end,
                        "timeline_start_us": cursor_us + head_us + b_take,
                        "timeline_end_us": cursor_us + seg_dur,
                        "allocation_tier": "interview_camera",
                    }
                )
                placed_cutaway = True

        if not placed_cutaway:
            # Conservative default: stay on synced interview camera (never fails!)
            ledger.reserve_exact(version_id, "video", atom["source_id"], s_start, s_end, f"V_{seg_id}")
            v_idx += 1
            video_events.append(
                {
                    "event_id": f"V{v_idx:03d}",
                    "section": "interview",
                    "segment_id": seg_id,
                    "source_id": atom["source_id"],
                    "relative_path": src["relative_path"],
                    "source_start_us": s_start,
                    "source_end_us": s_end,
                    "timeline_start_us": cursor_us,
                    "timeline_end_us": cursor_us + seg_dur,
                    "allocation_tier": "interview_camera",
                }
            )

        subtitle_cues.append(
            {
                "cue_id": f"SUB_{seg_id}",
                "section": "interview",
                "segment_id": seg_id,
                "timeline_start_us": cursor_us,
                "timeline_end_us": cursor_us + seg_dur,
                "chunks": dec.get("clean_subtitle_chunks") or [atom["text"]],
            }
        )
        cursor_us += seg_dur

    # --- PART 3: Ending Slogan Anchor (Restored in v2!) ---
    ending_asset = next(
        (a for a in asset_catalog.get("assets", []) if a.get("special_role") == "ending_slogan"),
        None,
    )
    if ending_asset:
        end_dur = int(policy.get("merged_version", {}).get("ending_slogan", {}).get("duration_us", 4_500_000))
        res = reserve_visual_with_fallback("ENDING_SLOGAN", [ending_asset["source_id"]], end_dur, allow_reuse_fallback=False)
        if res:
            sid, s_start, s_end, tier = res
            ev_dur = s_end - s_start
            v_idx += 1
            video_events.append(
                {
                    "event_id": f"V{v_idx:03d}",
                    "section": "ending_slogan",
                    "source_id": sid,
                    "relative_path": source_map[sid]["relative_path"],
                    "source_start_us": s_start,
                    "source_end_us": s_end,
                    "timeline_start_us": cursor_us,
                    "timeline_end_us": cursor_us + ev_dur,
                    "allocation_tier": tier,
                }
            )
            a_idx += 1
            audio_events.append(
                {
                    "event_id": f"A{a_idx:03d}",
                    "section": "ending_slogan",
                    "binding_mode": "silence_pad",
                    "source_id": None,
                    "relative_path": None,
                    "source_start_us": 0,
                    "source_end_us": ev_dur,
                    "timeline_start_us": cursor_us,
                    "timeline_end_us": cursor_us + ev_dur,
                }
            )
            cursor_us += ev_dur

    overlaps = ledger.audit_overlaps()
    ledger.close()

    review_doc["pending_count"] = len(review_doc["items"])
    write_json(project_root / "03-director" / "review_queue.json", review_doc)

    timeline_plan = {
        "schema_version": "2.0.0",
        "version_id": version_id,
        "fps_num": int(policy.get("time_model", {}).get("target_fps_num", 30)),
        "fps_den": int(policy.get("time_model", {}).get("target_fps_den", 1)),
        "total_duration_us": cursor_us,
        "ledger_overlap_count": len(overlaps),
        "ledger_overlaps": overlaps,
        "auto_fallback_swaps": swap_log,
        "video_events": video_events,
        "audio_events": audio_events,
        "subtitle_cues": subtitle_cues,
    }
    write_json(project_root / "04-plan" / "timeline_plan.json", timeline_plan)
    return timeline_plan
