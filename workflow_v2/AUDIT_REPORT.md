# `interview-video-objective-agent` 原工作流深度逻辑审计报告（v1 → v2 重构依据）

本报告基于对原 Google Drive 仓库 `interview-video-objective-agent`（共 116 个文件、25 个 Python 脚本、32 份 JSON Schema、15 份 Agent 手册与 `config/policy.json` / `config/task_graph.json`）的逐行静态与运行态实测审计得出。

---

## 一、 核心结论：“将剪辑客观化”是否可行？

**可行，但 v1 把“剪辑客观化”做成了“零弹性官僚锁死”。**

原方案在实操中爆发大量边界问题，根源不是“剪辑不能客观化”，而是把本应分层的职责全部压给了脆弱的规则锁与能力有限的自动化 AI：
- **v1 的致命误区**：在 `config/policy.json` 中写死 `"human_decision_nodes_allowed": false`、`"subjective_fallback_allowed": false`、`evidence_consensus` 2+1 盲裁投票、`unresolved_result: "blocked"`、21 个 DAG 节点、8,165 行 `validate_project.py` 与 100 KB 的 `policy.schema.json`。只要现实素材出现一点边界波动（如受访者思考超过 0.8 秒、空镜只有 12 条不是 15 条、本机 FFmpeg 不是 `n9.0.1`），整条流水线直接阻塞或崩溃。
- **v2 的重构原则（三层漏斗）**：
  1. **确定性脚本层（100% 物理与数学客观化）**：媒体探测、稳定定序、非破坏性音频清洗、不可变微秒 `segment_id` 切分、SQLite 区间互斥账本 + 3 级自动替补、零标点伴随字幕编译、NVENC/libx264 自适应渲染、真实 `ffprobe` QC。
  2. **弱 AI 受控层（仅做 3 个极简 ID 级 JSON 分类/精剪任务）**：严禁弱 AI 算时间码、写 SHA-256 或一次同时背 20 条规则；所有弱 AI 输出经过防御性校验修复器（去 Markdown 围栏、剔除幻觉 ID、漏标自动保守 `keep`）。
  3. **轻量人工复核门控（`review_queue.json`）**：低置信度删减（`<0.85`）、素材短缺软降级、缺失事实依据项不再炸毁流水线，而是走保守默认值并集中汇总到 `review_queue.json`，人工 1 分钟即可签收。

---

## 二、 原仓库实测发现的 7 大硬逻辑缺陷（Hard Logic Bugs）

| 编号 | 级别 | 位置 | 实际问题与实测证据 | v2 实施修复 |
| --- | --- | --- | --- | --- |
| **HL-01** | 严重阻塞 | `scripts/pipeline_step_executor.py` | 顶部 `from v2_engine import ...` 引用了仓库中**完全不存在的模块**；且渲染清单硬编码 `"0"*64` 伪造哈希与 `-16.7 LUFS` 假响度；直接导致 `scripts/validate_template.py` 运行即报 `rc=2` 失败。 | 彻底废除悬空入口，重写完整自包含的 `engine/` 内核包与单一入口 `run_pipeline.py`，全链路真实计算 SHA-256 与 `ffprobe` QC。 |
| **HL-02** | 严重阻塞 | `config/task_graph.json` | 存在**层级倒置与竞态隐患**：导演层 `T35_SCHEDULE_BROLL` 反向依赖执行层 `T60_RENDER_CLONED_VOICE`；且 `T50_ALLOCATE_USAGE` 会原地改写 `timeline_plan.json`（替补换镜），但 `T44_BUILD_MERGED_SUBTITLES` 却未将 `T50` 设为前置依赖。 | 收敛为严格的 6 阶段线性 DAG（`config/stages.json`）：`S4` 先定配音与 B-roll 候选，`S5` 先由 SQLite 锁定最终时间轴，再编译 `.ass`/`.srt` 字幕。 |
| **HL-03** | 严重阻塞 | `config/policy.json` (L199-201) | 硬编码 `"ffmpeg_executable": "/usr/bin/ffmpeg"` 与 `"ffmpeg_version": "n9.0.1"`，离开原特定机器即报环境不匹配。 | `engine/config.py` 运行时自动探测 PATH 中的 `ffmpeg`/`ffprobe`、`h264_nvenc` 与 `deepFilter`，无版本锁死。 |
| **HL-04** | 高危 | `config/policy.json` (L305-307) | `maximum_question_answer_pause_us: 800000` + `over_limit_behavior: "exchange_ineligible"`：受访者只要思考超过 **0.8 秒**，整段问答直接被判定无效丢弃。 | `engine/audio_ops.py` 改为自适应停顿压缩（将 >0.8s 停顿平滑收紧至 0.45s），绝不因思考停顿丢弃核心问答。 |
| **HL-05** | 高危 | `config/policy.json` (L238, L282, L293) | 硬写死 `visual_clip_count: 15`、`sentence_count: 10`、`each_visual_clip_duration_us.max: 90000000`（90 秒异常值）、`inventory_shortage_behavior: "blocked"`。空镜少于 15 条即全线死锁。 | 改为按口播时长动态匹配空镜，并在 SQLite 账本实现 5 级降级链（`A -> B -> C -> 池内未用镜头 -> 采访主画/带告警软复用`）。 |
| **HL-06** | 高危 | `config/policy.json` (L83-99) | `interview_person` 硬性要求 `minimum_distinct_speakers: 2`、`fixed_camera_required: true`、`camera_motion_p95 <= 0.025`，单人正面采访（画外提问）或手持云台访谈会被误判。 | 放宽为允许画外记者单声道受访者与任意序号文件，由弱 AI 结合语音时长与标签定类，低置信度走复核而非阻塞。 |
| **HL-07** | 中危 | `scripts/render_project.py` (L990, L1012, L1018) | 交付打包时在缺失报告的情况下悄悄写入 `sha256(b"qc_report_placeholder")` 等占位符假哈希，掩盖真实质检状态。 | `engine/renderer.py` 严禁伪造占位哈希，必须对实际落盘的 `master.mp4`、`subtitles.srt` 与 `qc_report.json` 计算真 SHA-256。 |

---

## 三、 文字规范 vs. 脚本/配置逻辑错配清单（Prose vs. Script Mismatches）

1. **悬空脚本名（文档要求运行不存在的脚本）**：
   - `agents/01_review/R1-source-ingest.md` 指示弱 AI 调用 `scripts/bootstrap_ingest.py`（不存在，实际文件是 `bootstrap_project.py`）。
   - `agents/01_review/R5-inventory-curation.md` 指示弱 AI 调用 `scripts/curate_inventory.py`（不存在）。
2. **字级口癖切除规则直接打架**：
   - `agents/02_director/D1-interview-pruning.md` 第三节要求“零容忍切除口语犹疑（嗯/啊/就是）并标记跳切”；
   - 但 `config/policy.json` L188 仍写着 `"internal_words_may_not_be_silently_deleted": true`。
3. **开头/结尾结构规范与 `policy.json` 脱节**：
   - `agents/02_director/D3-broll-scheduling.md` 要求 Part 1 黄金三连击（`intro_logo` + `company_entrance` + `hero_shot`）与 Part 3 结尾锚定（`ending_slogan`）；
   - 但 `config/policy.json` L270 `merged_version.section_order` 只有 `["company_entrance", "intro", "interview"]`，缺少 `intro_logo` 与 `ending_slogan`。
4. **首尾源文件限制自相矛盾**：
   - `config/policy.json` 中 `company_entrance.must_come_from_first_ordered_source: false`，下一行却写着 `selection_rule: "canonical_earliest_eligible_entrance_in_first_source"`；`ending` 同理自相矛盾。
5. **配音引擎解耦承诺与配置冲突**：
   - `agents/03_execution/E1-voice-assembly.md` 宣称已彻底解除特定配音绑定；但 `config/policy.json` L292 仍锁死 `"narrator_voice": "zhao_jin_clone"`。
6. **残留已废弃版本字段**：
   - `config/policy.json` L249-252 `minimum_distinct_classes_per_version` 仍只定义了已废弃的 `long_interview` 和 `short_company_intro`，未定义现行 `merged_interview_with_intro`。
