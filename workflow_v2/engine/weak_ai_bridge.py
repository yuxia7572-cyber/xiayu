"""Stage 3 (S3_CURATE_AND_DIRECT): Weak-AI Bridge, Defensive Repair & Human Review Queue.

Designed specifically for limited/weak automation AI:
1. Extracts JSON robustly even if the weak AI wraps it in markdown fences or prose.
2. Enforces strict ID-only contracts (`source_id` / `segment_id`) — rejects hallucinated IDs.
3. Conservatively repairs missing `segment_id`s to `keep` + appends an explicit item to `review_queue.json`.
4. Enforces three-state confidence thresholds (`auto_keep`, `auto_drop`, `review`).
5. Supports 3 drop-in modes:
   - Live OpenAI-compatible API (`LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL` env vars)
   - Manual JSON drop-in (`03-director/ai_inputs/01_curator.json`, `02_director.json`, `03_broll.json`)
   - Built-in deterministic safe fallback (so the pipeline NEVER deadlocks offline!).
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path
from typing import Any

from .config import REPO_ROOT, load_json, write_json

PUNCTUATION_RE = re.compile(r"[，。！？、；：,.!?;:\"'“”‘’（）()《》【】\[\]—…·]+")
NG_MARKERS = ("重来", "重新来", "再来一遍", "刚才说错了", "前面不算", "停一下", "cut")
FILLER_ONLY_RE = re.compile(r"^[\s嗯啊呃哦唉然后就是那个对吧]+$")


def strip_punctuation(text: str) -> str:
    cleaned = PUNCTUATION_RE.sub(" ", text or "")
    return re.sub(r"\s+", " ", cleaned).strip()


def split_semantic_subtitle_chunks(text: str, max_chars: int = 18) -> list[str]:
    """Split text along natural clause punctuation/spaces — NEVER blind `len(text)//2`."""
    raw = (text or "").strip()
    if not raw:
        return []
    # First split on natural Chinese/English clause delimiters before stripping punctuation
    clauses = [strip_punctuation(c) for c in re.split(r"[，。！？；：,.!?;:\n]+", raw)]
    clauses = [c for c in clauses if c]
    if not clauses:
        clean = strip_punctuation(raw)
        return [clean] if clean else []

    lines: list[str] = []
    for clause in clauses:
        if len(clause) <= max_chars:
            lines.append(clause)
            continue
        # Soft word/space split without cutting inside short phrases
        words = clause.split(" ")
        if len(words) > 1:
            buf = ""
            for w in words:
                cand = f"{buf} {w}".strip()
                if len(cand) <= max_chars or not buf:
                    buf = cand
                else:
                    lines.append(buf)
                    buf = w
            if buf:
                lines.append(buf)
        else:
            # Prefer natural Chinese conjunction/verb boundaries rather than blind midpoint
            parts = re.split(r"(但是|而且|所以|因为|并且|同时|以及|通过|实现)", clause)
            buf = ""
            for p in parts:
                if not p:
                    continue
                if len(buf) + len(p) <= max_chars or not buf:
                    buf += p
                else:
                    lines.append(buf)
                    buf = p
            if buf:
                while len(buf) > max_chars + 4:
                    lines.append(buf[:max_chars])
                    buf = buf[max_chars:]
                if buf:
                    lines.append(buf)
    return [ln for ln in lines if ln]


def extract_json_object(raw_text: str) -> dict[str, Any] | None:
    """Recover a JSON object from noisy weak-AI responses (markdown fences, trailing prose)."""
    if not raw_text:
        return None
    text = raw_text.strip()
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    else:
        first = text.find("{")
        last = text.rfind("}")
        if first != -1 and last > first:
            text = text[first : last + 1]
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def call_weak_ai_if_configured(prompt_name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Call an OpenAI-compatible endpoint if LLM_API_BASE & LLM_API_KEY are configured."""
    base = (os.environ.get("LLM_API_BASE") or "").strip().rstrip("/")
    api_key = (os.environ.get("LLM_API_KEY") or "").strip()
    model = (os.environ.get("LLM_MODEL") or "gpt-4o-mini").strip()
    if not base or not api_key:
        return None

    prompt_path = REPO_ROOT / "prompts" / prompt_name
    system_prompt = prompt_path.read_text(encoding="utf-8") if prompt_path.is_file() else ""
    body = json.dumps(
        {
            "model": model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        return extract_json_object(content)
    except Exception:
        return None


def _heuristic_curate_assets(
    source_manifest: dict[str, Any],
    doc_extracts: dict[str, Any],
    audio_atoms: dict[str, Any],
) -> dict[str, Any]:
    """Deterministic safe asset classifier & fact extractor when weak AI is offline."""
    facts: list[dict[str, Any]] = []
    for doc in doc_extracts.get("documents", []):
        for ln in (doc.get("text") or "").splitlines():
            clean = ln.strip().lstrip("#-*0123456789. ")
            if len(clean) >= 8 and len(facts) < 8:
                facts.append(
                    {
                        "fact_id": f"F{len(facts) + 1:02d}",
                        "claim": clean[:120],
                        "evidence_source": doc["filename"],
                    }
                )
    if not facts:
        for atom in audio_atoms.get("atoms", [])[:4]:
            t = atom.get("text", "").strip()
            if t and not t.startswith("[语音段"):
                facts.append(
                    {
                        "fact_id": f"F{len(facts) + 1:02d}",
                        "claim": t[:120],
                        "evidence_source": atom["segment_id"],
                    }
                )
    if not facts:
        facts.append(
            {
                "fact_id": "F01",
                "claim": "企业现场实拍与核心团队深度访谈纪实",
                "evidence_source": "source_manifest.json",
            }
        )

    speech_dur_by_src: dict[str, int] = {}
    for atom in audio_atoms.get("atoms", []):
        speech_dur_by_src[atom["source_id"]] = speech_dur_by_src.get(atom["source_id"], 0) + int(
            atom.get("duration_us") or 0
        )

    assets: list[dict[str, Any]] = []
    for src in source_manifest.get("sources", []):
        fname = src["filename"].lower()
        sid = src["source_id"]
        speech_us = speech_dur_by_src.get(sid, 0)

        special_role = "none"
        if any(k in fname for k in ("logo", "intro_logo", "片头")):
            base_class, special_role, tags = "company_scene", "intro_logo", ["企业Logo", "片头"]
            conf = 0.9
        elif any(k in fname for k in ("entrance", "gate", "门头", "入口", "大门")):
            base_class, special_role, tags = "company_scene", "company_entrance", ["公司大门", "外景"]
            conf = 0.9
        elif any(k in fname for k in ("ending", "slogan", "片尾", "结尾")):
            base_class, special_role, tags = "company_scene", "ending_slogan", ["结尾", "企业愿景"]
            conf = 0.9
        elif any(k in fname for k in ("interview", "采访", "访谈", "qa")) or speech_us >= 4_000_000:
            base_class, tags = "interview_person", ["人物采访", "核心问答"]
            conf = 0.85 if any(k in fname for k in ("interview", "采访", "访谈")) else 0.72
        elif any(k in fname for k in ("person", "team", "engineer", "员工", "研发", "人物")):
            base_class, tags = "person_scene", ["团队工作", "人物实拍"]
            conf = 0.8
        else:
            base_class, tags = "company_scene", ["企业环境", "设备产线", "空镜"]
            conf = 0.76

        assets.append(
            {
                "source_id": sid,
                "base_class": base_class,
                "special_role": special_role,
                "semantic_tags": tags,
                "visual_summary": f"素材 {src['filename']} ({base_class})",
                "confidence": conf,
            }
        )

    return {"company_facts": facts, "assets": assets}


def validate_and_repair_curator(
    raw_ai: dict[str, Any] | None,
    source_manifest: dict[str, Any],
    fallback: dict[str, Any],
    review_queue: list[dict[str, Any]],
) -> dict[str, Any]:
    valid_ids = {s["source_id"] for s in source_manifest.get("sources", [])}
    valid_classes = {"company_scene", "person_scene", "interview_person"}
    valid_roles = {"none", "intro_logo", "company_entrance", "hero_shot", "ending_slogan"}

    if not raw_ai or not isinstance(raw_ai.get("assets"), list):
        review_queue.append(
            {
                "stage": "S3_CURATE",
                "item_id": "asset_catalog",
                "severity": "info",
                "reason": "未提供外部 AI 定类输出，已启用确定性启发式定类兜底，建议快速核对素材分类。",
                "default_action": "keep_heuristic_classification",
            }
        )
        return fallback

    repaired_by_id: dict[str, dict[str, Any]] = {}
    for row in raw_ai.get("assets", []):
        if not isinstance(row, dict):
            continue
        sid = str(row.get("source_id") or "")
        if sid not in valid_ids:
            continue  # Drop hallucinated source_id
        bc = row.get("base_class") if row.get("base_class") in valid_classes else "company_scene"
        sr = row.get("special_role") if row.get("special_role") in valid_roles else "none"
        conf = float(row.get("confidence", 0.6))
        repaired_by_id[sid] = {
            "source_id": sid,
            "base_class": bc,
            "special_role": sr,
            "semantic_tags": [str(t) for t in (row.get("semantic_tags") or []) if str(t).strip()][:8],
            "visual_summary": str(row.get("visual_summary") or ""),
            "confidence": max(0.0, min(1.0, conf)),
        }
        if conf < 0.75:
            review_queue.append(
                {
                    "stage": "S3_CURATE",
                    "item_id": sid,
                    "severity": "review",
                    "reason": f"弱 AI 对素材 {sid} 分类置信度偏低 ({conf:.2f})，已暂按 {bc} 处理。",
                    "default_action": f"keep_as_{bc}",
                }
            )

    # Fill any source_id omitted by weak AI
    fallback_map = {a["source_id"]: a for a in fallback["assets"]}
    final_assets: list[dict[str, Any]] = []
    for src in source_manifest.get("sources", []):
        sid = src["source_id"]
        if sid in repaired_by_id:
            final_assets.append(repaired_by_id[sid])
        else:
            fb = fallback_map[sid]
            final_assets.append(fb)
            review_queue.append(
                {
                    "stage": "S3_CURATE",
                    "item_id": sid,
                    "severity": "review",
                    "reason": f"弱 AI 漏掉了素材 {sid}，引擎已自动保守回填为 {fb['base_class']}。",
                    "default_action": f"keep_as_{fb['base_class']}",
                }
            )

    facts = [
        f
        for f in (raw_ai.get("company_facts") or [])
        if isinstance(f, dict) and f.get("fact_id") and f.get("claim")
    ] or fallback["company_facts"]

    return {"company_facts": facts, "assets": final_assets}


def _heuristic_direct_edit(
    audio_atoms: dict[str, Any],
    asset_catalog: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    interview_src_ids = {
        a["source_id"] for a in asset_catalog["assets"] if a["base_class"] == "interview_person"
    }
    max_chars = int(policy.get("subtitles", {}).get("max_chars_per_line", 18))

    decisions: list[dict[str, Any]] = []
    for atom in audio_atoms.get("atoms", []):
        if interview_src_ids and atom["source_id"] not in interview_src_ids:
            continue
        text = (atom.get("text") or "").strip()
        is_ng = any(m in text.lower() for m in NG_MARKERS)
        is_filler_only = bool(FILLER_ONLY_RE.match(strip_punctuation(text)))
        is_question = text.endswith("？") or text.endswith("?") or text.startswith(("记者", "问：", "Q:"))

        if is_ng or is_filler_only:
            decision, conf, reason = "drop", 0.92, "命中 NG 重录或纯口癖词"
        elif len(strip_punctuation(text)) < 4 and not is_question:
            decision, conf, reason = "review", 0.58, "语义偏短，保守保留并等待人工复核"
        else:
            decision, conf, reason = "keep", 0.88, "有效采访内容"

        clean_text = re.sub(r"^(记者|受访者|主持人|问|答|Q|A)\s*[:：]\s*", "", text)
        decisions.append(
            {
                "segment_id": atom["segment_id"],
                "speaker_role": "interviewer" if is_question else "interviewee",
                "decision": decision,
                "confidence": conf,
                "reason": reason,
                "clean_subtitle_chunks": split_semantic_subtitle_chunks(clean_text, max_chars),
            }
        )

    narration_sentences: list[dict[str, Any]] = []
    for idx, fact in enumerate(asset_catalog.get("company_facts", [])[:6], 1):
        claim = fact["claim"].rstrip("。.")
        text = f"{claim}。"
        narration_sentences.append(
            {
                "sentence_id": f"N{idx:02d}",
                "text": text,
                "fact_ids": [fact["fact_id"]],
                "suggested_visual_theme": claim[:24],
                "subtitle_chunks": split_semantic_subtitle_chunks(text, max_chars),
            }
        )

    return {"segment_decisions": decisions, "narration_sentences": narration_sentences}


def validate_and_repair_director(
    raw_ai: dict[str, Any] | None,
    audio_atoms: dict[str, Any],
    asset_catalog: dict[str, Any],
    fallback: dict[str, Any],
    policy: dict[str, Any],
    review_queue: list[dict[str, Any]],
) -> dict[str, Any]:
    """Enforce weak-AI guardrails: 3-state confidence gating + missing segment conservative keep."""
    guard = policy.get("weak_ai_guardrails", {}).get("confidence_thresholds", {})
    auto_drop_min = float(guard.get("auto_drop_min", 0.85))
    auto_keep_min = float(guard.get("auto_keep_min", 0.75))
    max_chars = int(policy.get("subtitles", {}).get("max_chars_per_line", 18))

    interview_src_ids = {
        a["source_id"] for a in asset_catalog["assets"] if a["base_class"] == "interview_person"
    }
    target_atoms = [
        a for a in audio_atoms.get("atoms", []) if not interview_src_ids or a["source_id"] in interview_src_ids
    ]
    valid_seg_ids = {a["segment_id"]: a for a in target_atoms}
    valid_fact_ids = {f["fact_id"] for f in asset_catalog.get("company_facts", [])}

    if not raw_ai or not isinstance(raw_ai.get("segment_decisions"), list):
        repaired_decisions = []
        for row in fallback["segment_decisions"]:
            effective = "keep" if row["decision"] == "review" else row["decision"]
            if row["decision"] == "review":
                review_queue.append(
                    {
                        "stage": "S3_DIRECT",
                        "item_id": row["segment_id"],
                        "severity": "review",
                        "reason": row["reason"],
                        "default_action": "conservative_keep",
                    }
                )
            repaired_decisions.append({**row, "effective_action": effective})
        return {
            "segment_decisions": repaired_decisions,
            "narration_sentences": fallback["narration_sentences"],
        }

    by_seg: dict[str, dict[str, Any]] = {}
    for row in raw_ai.get("segment_decisions", []):
        if not isinstance(row, dict):
            continue
        seg_id = str(row.get("segment_id") or "")
        if seg_id not in valid_seg_ids:
            continue  # Ignore hallucinated segment_id

        decision = row.get("decision") if row.get("decision") in {"keep", "drop", "review"} else "review"
        conf = max(0.0, min(1.0, float(row.get("confidence", 0.6))))
        role = row.get("speaker_role") if row.get("speaker_role") in {"interviewer", "interviewee", "narration", "ambient"} else "interviewee"

        # Three-state confidence guardrail: low-confidence drops become conservative keep + review!
        if decision == "drop" and conf < auto_drop_min:
            effective = "keep"
            review_queue.append(
                {
                    "stage": "S3_DIRECT",
                    "item_id": seg_id,
                    "severity": "review",
                    "reason": f"弱 AI 建议删除 {seg_id} 但置信度仅 {conf:.2f} (<{auto_drop_min})，已自动保守保留并入复核队列。",
                    "default_action": "conservative_keep",
                }
            )
        elif decision == "review" or (decision == "keep" and conf < auto_keep_min):
            effective = "keep"
            review_queue.append(
                {
                    "stage": "S3_DIRECT",
                    "item_id": seg_id,
                    "severity": "review",
                    "reason": f"段落 {seg_id} 处于低置信度边界 ({conf:.2f})：{row.get('reason', '需人工确认')}",
                    "default_action": "conservative_keep",
                }
            )
        else:
            effective = decision

        raw_chunks = row.get("clean_subtitle_chunks")
        if isinstance(raw_chunks, list) and any(str(c).strip() for c in raw_chunks):
            chunks = [strip_punctuation(str(c)) for c in raw_chunks if strip_punctuation(str(c))]
        else:
            chunks = split_semantic_subtitle_chunks(valid_seg_ids[seg_id]["text"], max_chars)

        by_seg[seg_id] = {
            "segment_id": seg_id,
            "speaker_role": role,
            "decision": decision,
            "effective_action": effective,
            "confidence": conf,
            "reason": str(row.get("reason") or ""),
            "clean_subtitle_chunks": chunks,
        }

    # Conservative repair for any segment_id omitted by weak AI
    final_decisions: list[dict[str, Any]] = []
    for atom in target_atoms:
        seg_id = atom["segment_id"]
        if seg_id in by_seg:
            final_decisions.append(by_seg[seg_id])
        else:
            final_decisions.append(
                {
                    "segment_id": seg_id,
                    "speaker_role": "interviewee",
                    "decision": "review",
                    "effective_action": "keep",
                    "confidence": 0.5,
                    "reason": "弱 AI 漏标该句段，已触发保守保留兜底",
                    "clean_subtitle_chunks": split_semantic_subtitle_chunks(atom["text"], max_chars),
                }
            )
            review_queue.append(
                {
                    "stage": "S3_DIRECT",
                    "item_id": seg_id,
                    "severity": "review",
                    "reason": f"弱 AI 漏输出 {seg_id}，引擎已自动回填为保守保留（keep）。",
                    "default_action": "conservative_keep",
                }
            )

    # Validate narration sentences and fact_ids
    narration: list[dict[str, Any]] = []
    for idx, row in enumerate(raw_ai.get("narration_sentences") or [], 1):
        if not isinstance(row, dict) or not str(row.get("text") or "").strip():
            continue
        fids = [fid for fid in (row.get("fact_ids") or []) if fid in valid_fact_ids]
        if not fids and valid_fact_ids:
            review_queue.append(
                {
                    "stage": "S3_DIRECT",
                    "item_id": str(row.get("sentence_id") or f"N{idx:02d}"),
                    "severity": "review",
                    "reason": "口播句未绑定合法 fact_id，请人工核对事实依据。",
                    "default_action": "keep_with_warning",
                }
            )
        text = str(row["text"]).strip()
        raw_sc = row.get("subtitle_chunks")
        chunks = (
            [strip_punctuation(str(c)) for c in raw_sc if strip_punctuation(str(c))]
            if isinstance(raw_sc, list) and raw_sc
            else split_semantic_subtitle_chunks(text, max_chars)
        )
        narration.append(
            {
                "sentence_id": str(row.get("sentence_id") or f"N{idx:02d}"),
                "text": text,
                "fact_ids": fids,
                "suggested_visual_theme": str(row.get("suggested_visual_theme") or text[:24]),
                "subtitle_chunks": chunks,
            }
        )

    if not narration:
        narration = fallback["narration_sentences"]

    return {"segment_decisions": final_decisions, "narration_sentences": narration}


def run_curate_and_direct(
    project_root: Path,
    source_manifest: dict[str, Any],
    doc_extracts: dict[str, Any],
    audio_atoms: dict[str, Any],
    policy: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    review_queue: list[dict[str, Any]] = []
    ai_input_dir = project_root / "03-director" / "ai_inputs"

    # 1. Asset Curator
    manual_curator_path = ai_input_dir / "01_curator.json"
    raw_curator = load_json(manual_curator_path) if manual_curator_path.is_file() else None
    if raw_curator is None:
        raw_curator = call_weak_ai_if_configured(
            "01_asset_curator.md",
            {
                "sources": [
                    {
                        "source_id": s["source_id"],
                        "filename": s["filename"],
                        "media_kind": s["media_kind"],
                        "duration_us": s["duration_us"],
                        "has_audio": s["has_audio"],
                    }
                    for s in source_manifest.get("sources", [])
                ],
                "documents": [
                    {"filename": d["filename"], "text": d["text"][:4000]}
                    for d in doc_extracts.get("documents", [])
                ],
                "sample_transcripts": [
                    {"segment_id": a["segment_id"], "source_id": a["source_id"], "text": a["text"]}
                    for a in audio_atoms.get("atoms", [])[:40]
                ],
            },
        )
    fb_curator = _heuristic_curate_assets(source_manifest, doc_extracts, audio_atoms)
    asset_catalog = validate_and_repair_curator(raw_curator, source_manifest, fb_curator, review_queue)

    # 2. Interview Director + Narration Writer
    manual_director_path = ai_input_dir / "02_director.json"
    raw_director = load_json(manual_director_path) if manual_director_path.is_file() else None
    if raw_director is None:
        raw_director = call_weak_ai_if_configured(
            "02_interview_director.md",
            {
                "company_facts": asset_catalog["company_facts"],
                "segments": [
                    {"segment_id": a["segment_id"], "source_id": a["source_id"], "text": a["text"]}
                    for a in audio_atoms.get("atoms", [])
                ],
            },
        )
    fb_director = _heuristic_direct_edit(audio_atoms, asset_catalog, policy)
    director_plan = validate_and_repair_director(
        raw_director, audio_atoms, asset_catalog, fb_director, policy, review_queue
    )

    review_doc = {
        "schema_version": "2.0.0",
        "pending_count": len(review_queue),
        "approved": False,
        "items": review_queue,
    }

    write_json(project_root / "03-director" / "asset_catalog.json", asset_catalog)
    write_json(project_root / "03-director" / "director_plan.json", director_plan)
    write_json(project_root / "03-director" / "review_queue.json", review_doc)
    return asset_catalog, director_plan, review_doc
