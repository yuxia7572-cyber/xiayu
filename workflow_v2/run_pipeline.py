#!/usr/bin/env python3
"""Single-entry CLI for interview-video-objective-agent v2.

Usage:
  python3 run_pipeline.py init ./my_project
  python3 run_pipeline.py run ./my_project
  python3 run_pipeline.py demo ./demo_project
  python3 run_pipeline.py status ./my_project
  python3 run_pipeline.py approve ./my_project
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from engine.audio_ops import run_audio_and_atoms
from engine.config import detect_capabilities, load_json, load_policy, write_json
from engine.ingest import run_ingest
from engine.renderer import render_and_deliver
from engine.subtitles import compile_subtitles
from engine.voice_and_ledger import (
    assemble_voice_manifest,
    build_locked_timeline,
    schedule_broll_candidates,
)
from engine.weak_ai_bridge import run_curate_and_direct


def cmd_init(project_root: Path) -> None:
    for sub in (
        "00-sources",
        "01-ingest",
        "02-analysis",
        "03-director/ai_inputs",
        "04-plan",
        "05-voice/manual",
        "06-render",
        "07-delivery",
    ):
        (project_root / sub).mkdir(parents=True, exist_ok=True)
    print(f"[OK] 初始化项目目录完成：{project_root}")
    print("下一步：将采访视频、空镜、可选 SRT 字幕与企业介绍文档放入 00-sources/，然后运行：")
    print(f"  python3 run_pipeline.py run {project_root}")


def _generate_demo_sources(project_root: Path) -> None:
    """Synthesize realistic test video, audio, SRT, and company brochure via FFmpeg."""
    caps = detect_capabilities()
    if not caps.ffmpeg:
        raise RuntimeError("运行 demo 需要系统已安装 FFmpeg。")

    cmd_init(project_root)
    src_dir = project_root / "00-sources"

    clips = [
        ("20261122_090001_company_entrance.mp4", "color=c=#1e3a5f:s=1280x720:d=5", "sine=f=220:d=5", 5),
        ("20261122_090500_workshop_cnc.mp4", "color=c=#2d4a3e:s=1280x720:d=8", "sine=f=260:d=8", 8),
        ("20261122_091000_lab_team_person.mp4", "color=c=#4a3652:s=1280x720:d=8", "sine=f=300:d=8", 8),
        ("20261122_092000_interview_ceo.mp4", "color=c=#1f2937:s=1280x720:d=18", "sine=f=360:d=18", 18),
        ("20261122_093500_ending_slogan.mp4", "color=c=#0f172a:s=1280x720:d=4.5", "sine=f=180:d=4.5", 4.5),
    ]
    for name, v_src, a_src, _ in clips:
        out = src_dir / name
        subprocess.run(
            [
                caps.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                v_src,
                "-f",
                "lavfi",
                "-i",
                a_src,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "30",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                str(out),
            ],
            capture_output=True,
            check=True,
        )

    (src_dir / "20261122_092000_interview_ceo.srt").write_text(
        """1
00:00:00,200 --> 00:00:02,600
记者：请介绍下你们的核心技术优势？

2
00:00:04,100 --> 00:00:05,800
呃刚才说错了我们重来一遍

3
00:00:06,200 --> 00:00:17,400
受访者：我们从2018年起专注五轴联动数控机床研发，定位精度稳定在微米级，已经服务了三十多家航空制造企业。
""",
        encoding="utf-8",
    )
    (src_dir / "company_brochure.md").write_text(
        "# 星辰精密制造有限公司简介\n"
        "- 成立于2018年，专注五轴联动数控机床底层控制系统研发。\n"
        "- 拥有24项自研发明专利，产品服务30余家航空与精密模具客户。\n",
        encoding="utf-8",
    )


def cmd_run(project_root: Path, skip_render: bool = False) -> dict:
    policy = load_policy(project_root)
    caps = detect_capabilities()

    print(f"[S1] 素材探测与稳定定序 ({project_root}) ...")
    source_manifest, doc_extracts = run_ingest(project_root, policy, caps)
    print(f"     已索引 {source_manifest['source_count']} 个媒体文件，{len(doc_extracts['documents'])} 份文档")

    print("[S2] 非破坏性音频清洗与不可变 segment_id 原子切分 ...")
    audio_atoms = run_audio_and_atoms(project_root, source_manifest, doc_extracts, policy, caps)
    print(f"     已生成 {audio_atoms['atom_count']} 条不可变句段原子")

    print("[S3] 弱 AI 原子定类、采访精剪与保守复核队列 ...")
    asset_catalog, director_plan, review_doc = run_curate_and_direct(
        project_root, source_manifest, doc_extracts, audio_atoms, policy
    )
    kept = sum(1 for d in director_plan["segment_decisions"] if d.get("effective_action") == "keep")
    print(
        f"     事实 {len(asset_catalog['company_facts'])} 条 | 保留句段 {kept}/{len(director_plan['segment_decisions'])} | 待复核 {review_doc['pending_count']} 项"
    )

    print("[S4] 双轨配音装配与三级候选 B-roll 排期 ...")
    voice_manifest = assemble_voice_manifest(project_root, director_plan, policy, caps)
    broll_schedule = schedule_broll_candidates(
        project_root, asset_catalog, voice_manifest, director_plan, audio_atoms, policy
    )

    print("[S5] SQLite 排他锁（自动替补防死锁）+ 零标点伴随字幕编译 ...")
    timeline_plan = build_locked_timeline(
        project_root,
        source_manifest,
        asset_catalog,
        audio_atoms,
        director_plan,
        voice_manifest,
        broll_schedule,
        review_doc,
        policy,
    )
    sub_info = compile_subtitles(project_root, timeline_plan, policy)
    print(
        f"     时间轴总时长 {timeline_plan['total_duration_us'] / 1_000_000:.2f}s | 账本冲突 {timeline_plan['ledger_overlap_count']} | 字幕 {sub_info['cue_count']} 条"
    )

    summary = {
        "sources": source_manifest["source_count"],
        "atoms": audio_atoms["atom_count"],
        "total_duration_s": round(timeline_plan["total_duration_us"] / 1_000_000, 2),
        "ledger_overlaps": timeline_plan["ledger_overlap_count"],
        "auto_swaps": len(timeline_plan["auto_fallback_swaps"]),
        "review_pending": review_doc["pending_count"],
        "subtitles": sub_info["cue_count"],
    }

    if not skip_render:
        print("[S6] FFmpeg 硬件/软件自适应渲染 + 真哈希 QC 交付封包 ...")
        qc_report, delivery_manifest = render_and_deliver(project_root, timeline_plan, policy, caps)
        summary["qc_status"] = qc_report["status"]
        summary["encoder"] = qc_report["encoder_used"]
        summary["delivery_mp4"] = delivery_manifest["artifacts"]["master_video"]["path"]
        print(
            f"[DONE] 渲染与交付完成！状态={qc_report['status']} | 编码器={qc_report['encoder_used']} | 输出={project_root / summary['delivery_mp4']}"
        )
    else:
        print("[DONE] 已完成 S1~S5 规划与字幕编译（--skip-render 模式）。")

    return summary


def cmd_status(project_root: Path) -> None:
    rq_path = project_root / "03-director" / "review_queue.json"
    tl_path = project_root / "04-plan" / "timeline_plan.json"
    qc_path = project_root / "07-delivery" / "qc_report.json"
    out = {
        "project_root": str(project_root),
        "review_queue": load_json(rq_path) if rq_path.is_file() else None,
        "timeline_duration_s": round(load_json(tl_path)["total_duration_us"] / 1_000_000, 2) if tl_path.is_file() else None,
        "qc_status": load_json(qc_path)["status"] if qc_path.is_file() else None,
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_approve(project_root: Path) -> None:
    rq_path = project_root / "03-director" / "review_queue.json"
    if not rq_path.is_file():
        print("未找到 03-director/review_queue.json，请先运行 run。")
        sys.exit(1)
    rq = load_json(rq_path)
    rq["approved"] = True
    write_json(rq_path, rq)
    print(f"[OK] 已确认人工复核队列（共 {rq.get('pending_count', 0)} 条提示已签收）。")


def main() -> int:
    parser = argparse.ArgumentParser(description="Interview Video Objective Agent v2 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="初始化新项目目录")
    p_init.add_argument("project", type=Path)

    p_run = sub.add_parser("run", help="执行完整 6 阶段剪辑工作流")
    p_run.add_argument("project", type=Path)
    p_run.add_argument("--skip-render", action="store_true", help="仅运行 S1~S5 规划与字幕编译，跳过渲染")

    p_demo = sub.add_parser("demo", help="生成合成测试素材并端到端跑通全流程与渲染")
    p_demo.add_argument("project", type=Path)

    p_status = sub.add_parser("status", help="查看当前项目状态与人工复核队列")
    p_status.add_argument("project", type=Path)

    p_approve = sub.add_parser("approve", help="签收 review_queue.json 人工复核门控")
    p_approve.add_argument("project", type=Path)

    args = parser.parse_args()
    project_root = args.project.resolve()

    if args.command == "init":
        cmd_init(project_root)
    elif args.command == "run":
        cmd_run(project_root, skip_render=args.skip_render)
    elif args.command == "demo":
        _generate_demo_sources(project_root)
        cmd_run(project_root, skip_render=False)
    elif args.command == "status":
        cmd_status(project_root)
    elif args.command == "approve":
        cmd_approve(project_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
