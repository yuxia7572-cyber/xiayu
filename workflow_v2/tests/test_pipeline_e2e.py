"""End-to-end & unit verification tests for interview-video-objective-agent v2."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from engine.audio_ops import trim_long_thinking_pauses
from engine.config import detect_capabilities, load_policy
from engine.voice_and_ledger import MaterialLedger
from engine.weak_ai_bridge import (
    extract_json_object,
    split_semantic_subtitle_chunks,
    validate_and_repair_director,
)
from run_pipeline import _generate_demo_sources, cmd_run


class WorkflowV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = load_policy()

    def test_extract_json_from_noisy_weak_ai_output(self) -> None:
        noisy = '好的，以下是结果：\n```json\n{"segment_decisions": [], "narration_sentences": []}\n```\n希望对您有帮助！'
        parsed = extract_json_object(noisy)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["segment_decisions"], [])

    def test_weak_ai_guardrail_keeps_missing_and_low_conf_drops(self) -> None:
        audio_atoms = {
            "atoms": [
                {"segment_id": "SEG_0001", "source_id": "SRC_001", "text": "核心研发成果介绍"},
                {"segment_id": "SEG_0002", "source_id": "SRC_001", "text": "这段可能有点口语化"},
                {"segment_id": "SEG_0003", "source_id": "SRC_001", "text": "弱AI漏标的段落"},
            ]
        }
        asset_catalog = {
            "company_facts": [{"fact_id": "F01", "claim": "五轴机床研发"}],
            "assets": [{"source_id": "SRC_001", "base_class": "interview_person"}],
        }
        raw_ai = {
            "segment_decisions": [
                # Low-confidence drop (<0.85) MUST become conservative keep + review!
                {"segment_id": "SEG_0002", "decision": "drop", "confidence": 0.62, "reason": "不确定"},
                # Hallucinated ID MUST be ignored
                {"segment_id": "SEG_9999", "decision": "drop", "confidence": 0.99, "reason": "幻觉"},
                {"segment_id": "SEG_0001", "decision": "keep", "confidence": 0.93, "reason": "核心内容"},
            ],
            "narration_sentences": [],
        }
        review_queue: list[dict] = []
        fallback = {"segment_decisions": [], "narration_sentences": [{"sentence_id": "N01", "text": "测试。", "fact_ids": ["F01"], "suggested_visual_theme": "机床", "subtitle_chunks": ["测试"]}]}
        repaired = validate_and_repair_director(raw_ai, audio_atoms, asset_catalog, fallback, self.policy, review_queue)

        by_id = {d["segment_id"]: d for d in repaired["segment_decisions"]}
        self.assertNotIn("SEG_9999", by_id)
        self.assertEqual(by_id["SEG_0001"]["effective_action"], "keep")
        # Low-confidence drop downgraded to keep
        self.assertEqual(by_id["SEG_0002"]["effective_action"], "keep")
        # Missing SEG_0003 conservatively repaired to keep
        self.assertEqual(by_id["SEG_0003"]["effective_action"], "keep")
        self.assertGreaterEqual(len(review_queue), 2)

    def test_thinking_pause_trimmed_not_dropped(self) -> None:
        atoms = [
            {"segment_id": "SEG_0001", "source_id": "SRC_001", "source_start_us": 0, "source_end_us": 2_000_000},
            {"segment_id": "SEG_0002", "source_id": "SRC_001", "source_start_us": 3_500_000, "source_end_us": 8_000_000},
        ]
        result = trim_long_thinking_pauses(atoms, self.policy)
        self.assertEqual(len(result), 2)
        self.assertTrue(result[1]["adaptive_pause_trimmed"])
        self.assertEqual(result[1]["target_gap_after_prev_us"], 450_000)

    def test_sqlite_ledger_zero_overlaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = MaterialLedger(Path(tmp) / "ledger.sqlite")
            s1 = ledger.reserve_free_slice("v2", "video", "SRC_002", 10_000_000, 4_000_000, "E1")
            s2 = ledger.reserve_free_slice("v2", "video", "SRC_002", 10_000_000, 4_000_000, "E2")
            s3 = ledger.reserve_free_slice("v2", "video", "SRC_002", 10_000_000, 4_000_000, "E3")
            self.assertEqual(s1, (0, 4_000_000))
            self.assertEqual(s2, (4_000_000, 8_000_000))
            self.assertEqual(s3, (8_000_000, 10_000_000))
            self.assertEqual(ledger.audit_overlaps(), [])
            ledger.close()

    def test_zero_punctuation_semantic_subtitles(self) -> None:
        chunks = split_semantic_subtitle_chunks("我们自主研发了五轴联动控制系统，定位精度稳定在微米级！", max_chars=18)
        self.assertEqual(chunks, ["我们自主研发了五轴联动控制系统", "定位精度稳定在微米级"])
        for c in chunks:
            for p in "，。！？、；：,.!?;:":
                self.assertNotIn(p, c)

    def test_full_end_to_end_demo_render(self) -> None:
        caps = detect_capabilities()
        if not caps.ffmpeg or not caps.ffprobe:
            self.skipTest("FFmpeg not available in environment")

        tmp_dir = Path(tempfile.mkdtemp(prefix="cutlogic_v2_e2e_"))
        try:
            _generate_demo_sources(tmp_dir)
            summary = cmd_run(tmp_dir, skip_render=False)

            self.assertEqual(summary["ledger_overlaps"], 0)
            self.assertEqual(summary["qc_status"], "pass")
            self.assertTrue((tmp_dir / "07-delivery" / "interview_with_intro.mp4").is_file())
            self.assertTrue((tmp_dir / "07-delivery" / "subtitles.srt").is_file())
            self.assertTrue((tmp_dir / "07-delivery" / "delivery_manifest.json").is_file())

            qc = json.loads((tmp_dir / "07-delivery" / "qc_report.json").read_text(encoding="utf-8"))
            self.assertNotEqual(qc["master_sha256"], "0" * 64)
            self.assertEqual(qc["video"]["width"], 1920)
            self.assertEqual(qc["video"]["height"], 1080)
            self.assertTrue(qc["checks"]["has_video_and_audio"])

            srt = (tmp_dir / "07-delivery" / "subtitles.srt").read_text(encoding="utf-8")
            self.assertNotIn("重来一遍", srt)  # NG take properly dropped
            self.assertIn("五轴联动数控机床", srt)
            self.assertNotIn("，", srt)
            self.assertNotIn("。", srt)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
