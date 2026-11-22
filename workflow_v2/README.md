# Interview Video Objective Agent v2（剪辑客观化工作流 · 弱 AI 友好重构版）

本仓库是对原 `interview-video-objective-agent` 的**完整工程化重构实施版本**。它彻底清除了原仓库中 21 节点官僚锁死、8,165 行过拟合校验脚本、悬空的 `v2_engine` / `curate_inventory.py` 引用以及文字规范与 `policy.json` 的 13 处逻辑矛盾，重构为一套**开箱即用、零硬逻辑死锁、专为弱自动化 AI 优化的 6 阶段剪辑流水线**。

> 完整的原仓库逐行逻辑诊断与新旧对照表，请查看 [`AUDIT_REPORT.md`](./AUDIT_REPORT.md)。

---

## 核心架构：三层客观化漏斗

| 层级 | 负责模块 | 职责边界 |
| --- | --- | --- |
| **1. 确定性物理内核** | `engine/ingest.py`, `audio_ops.py`, `voice_and_ledger.py`, `subtitles.py`, `renderer.py` | 100% 接管时间轴微秒计算、`ffprobe` 探测、音频降噪响度归一、SQLite 防重互斥锁、3 级候选自动替补、零标点 `.ass`/`.srt` 编译与 FFmpeg 渲染。 |
| **2. 弱 AI 原子决策层** | `prompts/01~03` + `engine/weak_ai_bridge.py` | 弱 AI 只做 3 个极简 JSON 分类/精剪任务，**严禁接触时间码和文件哈希**；引擎自动剥离 Markdown 废话、剔除幻觉 ID、对低置信度删减（`<0.85`）和漏标句段执行保守 `keep` 兜底。 |
| **3. 轻量人工复核门控** | `03-director/review_queue.json` + `run_pipeline.py approve` | 遇到模糊语义、低置信度边界或空镜短缺时**绝不崩溃打回**，而是走保守安全默认值并集中记录到复核清单，人工 1 分钟确认即可。 |

---

## 目录结构

```text
.
├── run_pipeline.py              # 单一 CLI 入口（init / run / demo / status / approve）
├── config/
│   ├── policy.json              # 唯一真相配置（无硬件/版本/人物锁死）
│   └── stages.json              # 6 阶段严格线性 DAG（无层级倒置）
├── schemas/
│   └── contracts.json           # 精简版弱 AI JSON 契约（替代原 32 份臃肿 Schema）
├── prompts/
│   ├── 01_asset_curator.md      # 原子任务 1：素材定类 + 双源企业事实提炼
│   ├── 02_interview_director.md # 原子任务 2：采访三态精剪 + 伴随式零标点字幕 + 口播稿
│   └── 03_broll_scheduler.md    # 原子任务 3：语义对题 B-roll 三级替补调度
├── engine/
│   ├── config.py                # 便携配置加载与 FFmpeg/NVENC/DeepFilterNet3 自动探测
│   ├── ingest.py                # S1：防崩素材扫描、文档提取与稳定时序定序
│   ├── audio_ops.py             # S2：非破坏性音频清洗 + 不可变 segment_id + 自适应停顿压缩
│   ├── weak_ai_bridge.py        # S3：弱 AI 接口桥接、JSON 容错修复与复核队列
│   ├── voice_and_ledger.py      # S4 & S5A：双轨配音 + SQLite 互斥账本 + 自动替补换镜
│   ├── subtitles.py             # S5B：白字黑边零标点伴随式 ASS/SRT 双编译
│   └── renderer.py              # S6：NVENC/libx264 自适应 1080p 渲染 + 真哈希 QC 交付
├── scripts/
│   └── check_env.py             # 环境体检脚本
├── tests/
│   └── test_pipeline_e2e.py     # 单元测试 + 真实 FFmpeg 端到端出片回归测试
├── AUDIT_REPORT.md              # 原仓库硬逻辑缺陷与文脚错配审计报告
└── requirements.txt             # 零强依赖（Python 3.10+ 标准库 + FFmpeg 即可运行）
```

---

## 30 秒快速上手

### 1. 环境体检
```bash
python3 scripts/check_env.py
```

### 2. 一键运行端到端 Demo（自动合成素材并渲染真实 1080p 成片）
```bash
python3 run_pipeline.py demo ./demo_project
```
完成后可在 `./demo_project/07-delivery/` 查看：
- `interview_with_intro.mp4`（1080p 30fps 成片）
- `subtitles.srt` / `subtitles.ass`（零标点伴随字幕）
- `review_queue.json`（需人工一眼确认的边界清单）
- `qc_report.json` & `delivery_manifest.json`（真实 SHA-256 校验与 `ffprobe` 质检报告）

### 3. 运行你自己的真实采访项目
```bash
# 1) 初始化项目目录
python3 run_pipeline.py init ./my_client_project

# 2) 将视频素材、空镜、企业文档（.md/.txt/.pdf/.docx）及可选同名 .srt 字幕放入 00-sources/
#    如有已录制的口播配音，按 N01.wav, N02.wav 放入 05-voice/manual/

# 3) （可选）接入任意兼容 OpenAI 协议的弱/中等模型（DeepSeek / Qwen / OpenAI / 本地 Ollama）：
export LLM_API_BASE="https://api.deepseek.com/v1"
export LLM_API_KEY="your_api_key"
export LLM_MODEL="deepseek-chat"

#    或者不配 API Key，直接把 prompts/01~03 的 JSON 结果放到 03-director/ai_inputs/
#    （01_curator.json / 02_director.json / 03_broll.json），也可离线直接运行确定性兜底！

# 4) 执行完整 6 阶段流水线
python3 run_pipeline.py run ./my_client_project

# 5) 查看复核队列并签收
python3 run_pipeline.py status ./my_client_project
python3 run_pipeline.py approve ./my_client_project
```

### 4. 运行自动化测试套件
```bash
python3 -m unittest discover -s tests -v
```
