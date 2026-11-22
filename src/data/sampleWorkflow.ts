import type { WorkflowAuditReport, WorkflowFile } from '../types/workflow';

export const SAMPLE_WORKFLOW_FILES: WorkflowFile[] = [
  {
    id: 'sample-doc-1',
    name: '01_剪辑客观化总纲与SOP.md',
    path: '01_剪辑客观化总纲与SOP.md',
    mimeType: 'text/markdown',
    kind: 'prose',
    selected: true,
    source: 'sample',
    sizeBytes: 1420,
    modifiedTime: '2026-10-18T14:22:00Z',
    content: `# 剪辑客观化工作流设计（个人草稿）

核心目标：把主观“感觉好不好看”拆成客观量化指标，让自动化 AI 能直接执行剪辑。

1. 素材去噪与静音裁切（调用 step1_silence_cut.py）：
   - 凡是停顿超过 0.45 秒且音量低于 -38dB 的段落全部切掉，提升信息密度。
   - 但如果说话人是在做“反转停顿”或“情绪留白”，要保留 0.6 秒呼吸感。

2. 文稿精简与结构重组（调用 step2_llm_director.py）：
   - 将 ASR 字幕整篇喂给 AI，让 AI 一次性删除口癖、重复句、跑题内容，并直接输出新的时间码 EDL。
   - 要求：每 6 秒必须切换一次景别或插入 B-roll，保证观众不流失。

3. B-roll 客观匹配与节奏卡点（调用 step3_broll_and_bgm.py）：
   - 根据句子关键词自动去素材库检索 B-roll，分数高于 0.75 自动覆盖主画面。
   - BGM 鼓点必须与画面切换点严格对齐（误差不超过 2 帧）。

4. 成片质检：
   - 如果信息密度评分低于 80 分，自动打回第 2 步让 AI 重新删减，直到达标。`,
  },
  {
    id: 'sample-script-1',
    name: 'step1_silence_cut.py',
    path: 'scripts/step1_silence_cut.py',
    mimeType: 'text/x-python',
    kind: 'script',
    selected: true,
    source: 'sample',
    sizeBytes: 980,
    modifiedTime: '2026-10-19T09:10:00Z',
    content: `# step1_silence_cut.py
import subprocess, json

SILENCE_THRESH = -32  # dB (实测 -38 切不干净所以改成了 -32)
MIN_SILENCE_LEN = 0.30 # seconds

def cut_silence(video_path: str, out_path: str):
    # 直接用 ffmpeg silencedetect 硬切，未保存原时间轴映射表
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silenceremove=stop_periods=-1:stop_duration={MIN_SILENCE_LEN}:stop_threshold={SILENCE_THRESH}dB",
        out_path
    ]
    subprocess.run(cmd, check=True)
    return out_path`,
  },
  {
    id: 'sample-script-2',
    name: 'step2_llm_director.py',
    path: 'scripts/step2_llm_director.py',
    mimeType: 'text/x-python',
    kind: 'script',
    selected: true,
    source: 'sample',
    sizeBytes: 1240,
    modifiedTime: '2026-10-20T16:40:00Z',
    content: `# step2_llm_director.py
# 注意：传入的是原视频的 ASR SRT，而非 step1 裁切后的时间轴！

def run_ai_director(raw_srt: str, llm_client):
    prompt = f"""
    你是专业剪辑师。请阅读以下整段字幕：
    1. 删除口癖、废话、低价值内容；
    2. 保留情绪反转前的留白；
    3. 每 6 秒安排一个 B-roll 关键词；
    4. 直接输出剪辑时间码列表（MM:SS.mmm - MM:SS.mmm）。
    字幕内容：
    {raw_srt}
    """
    # 弱 AI 经常输出 Markdown 说明文字导致解析崩溃
    output = llm_client.complete(prompt)
    return output`,
  },
  {
    id: 'sample-config-1',
    name: 'workflow_rules.json',
    path: 'config/workflow_rules.json',
    mimeType: 'application/json',
    kind: 'config',
    selected: true,
    source: 'sample',
    sizeBytes: 620,
    modifiedTime: '2026-10-20T17:05:00Z',
    content: `{
  "target_fps": 30,
  "broll_interval_sec": 6,
  "broll_min_similarity": 0.75,
  "bgm_beat_tolerance_frames": 2,
  "quality_loop": {
    "min_density_score": 80,
    "max_retries": null
  },
  "audio_target_lufs": -14
}`,
  },
];

export const SAMPLE_AUDIT_REPORT: WorkflowAuditReport = {
  workflowTitle: '客观化视频剪辑自动化工作流（示例诊断报告）',
  executiveSummary:
    '“将剪辑客观化”的方向在工程上完全可行，但必须修正一个根本前提：客观化不是把所有主观剪辑感都写死成单一数值阈值，而是把剪辑拆解为“确定性工程规则 + 概率型弱 AI 语义初筛 + 轻量人工门控”三层漏斗。当前示例工作流存在时间轴坐标系撕裂、无终止条件的质检死循环、文字规范与脚本硬编码阈值严重背离等 4 处硬逻辑缺陷。请连接您的 Google Drive 文件夹以对您的真实文档与脚本执行完整分析。',
  feasibilityVerdict: 'feasible_with_architecture',
  feasibilityConclusion:
    '路线可行，但需要从“端到端让弱 AI 直接做剪辑决策”重构为“脚本管时间轴与硬规则、弱 AI 只做结构化原子标签、人工只审低置信度边界”的混合管线架构。',
  weakAiPrinciples: [
    '禁止弱 AI 直接计算或生成时间戳/帧号：由确定性脚本先将素材切分为带唯一 segment_id 的原子句段，AI 仅输出 segment_id 的保留/删减决策与原因。',
    '单任务原子化拆分：将“删口癖 + 控节奏 + 选 B-roll + 判情绪”拆成 3 个独立微任务，每次只要求输出严格 JSON Schema，避免多目标指令漂移。',
    '引入三态置信度输出（Keep / Drop / Review）替代二元硬切：当弱 AI 把握度低于阈值时默认走保守保留并进入人工复核队列，杜绝灾难性误切。',
    '所有自动化步骤必须声明无损非破坏性中间文件（如 OTIO / JSON Timeline），直到最终渲染前永不破坏原始素材时间轴。',
  ],
  hardLogicIssues: [
    {
      id: 'HLI-01',
      title: 'Step 1 破坏性静音硬切导致 Step 2 字幕时间轴坐标系撕裂',
      severity: 'critical',
      category: '前后置契约断裂',
      stepRef: 'Step 1 -> Step 2',
      fileRefs: ['step1_silence_cut.py', 'step2_llm_director.py'],
      evidenceQuote:
        'silenceremove=stop_periods=-1... 未保存原时间轴映射表；step2 传入的是原视频的 ASR SRT',
      rootCause:
        'Step 1 直接用 FFmpeg 对视频做了物理剪裁（改变了视频总时长与时间坐标），但没有输出原时间轴到新时间轴的偏移映射表（Timecode Offset Map）；Step 2 仍拿着原始视频的 SRT 字幕让 AI 生成时间码，导致后续裁剪点全部错位。',
      impact:
        '后续自动生成的切点会切在说话人句中，画面与声音出现累积性漂移，且随视频长度增加误差线性放大。',
      fixStrategy:
        '禁止在 Step 1 做破坏性视频重编码。改为仅用 VAD/FFmpeg 检测静音区间并生成非破坏性的 timeline_segments.json（保留原始 source_in/source_out），全流程统一在原始母带坐标系下做标记，最后一步统一渲染。',
    },
    {
      id: 'HLI-02',
      title: '让弱 AI 一次性承担 4 项耦合任务并直接输出毫秒级时间码',
      severity: 'critical',
      category: '弱AI能力错配',
      stepRef: 'Step 2',
      fileRefs: ['01_剪辑客观化总纲与SOP.md', 'step2_llm_director.py'],
      evidenceQuote: '同时删除口癖、保留情绪留白、每 6 秒安排 B-roll，并直接输出 MM:SS.mmm 时间码',
      rootCause:
        '弱自动化 AI 在长上下文中对数字和精确时间区间极不敏感，且“删除废话（缩短时长）”与“每 6 秒插一个 B-roll（依赖删后新时长）”存在因果循环：删减尚未完成前，每 6 秒的落点根本无法计算。',
      impact:
        'AI 频繁幻觉不存在的时间码、输出非标准 Markdown 导致下游解析报错，且删减后 B-roll 密度完全失控。',
      fixStrategy:
        '解耦因果顺序：先基于词级时间戳生成原子句段列表，让 AI 仅返回每个 segment_id 的 action (keep/trim/drop)；由脚本重算新时间轴后，再在独立阶段计算 B-roll 候选窗口。',
    },
    {
      id: 'HLI-03',
      title: '成片质检打回机制缺少最大重试次数与收敛条件（死循环风险）',
      severity: 'high',
      category: '循环依赖与状态死锁',
      stepRef: 'Step 4 -> Step 2',
      fileRefs: ['01_剪辑客观化总纲与SOP.md', 'workflow_rules.json'],
      evidenceQuote: '"min_density_score": 80, "max_retries": null — 低于 80 分自动打回第 2 步直到达标',
      rootCause:
        '原始口播素材本身的信息密度存在物理上限，若原始素材信息稀疏，无限打回删减会导致主线逻辑被删空或陷入无限重试；且打回时未携带具体扣分项作为负反馈参数。',
      impact:
        '自动化任务挂死、Token 成本失控，或者把一段完整论述剪成支离破碎的片段。',
      fixStrategy:
        '将质检改为有界迭代（max_retries = 1）+ 降级退出机制：若首轮未达标，仅标记低密度区间进入人工复核清单，严禁无界自动重剪。',
    },
    {
      id: 'HLI-04',
      title: '“每 6 秒切画面”与“BGM 鼓点误差 ≤ 2 帧”的双硬约束无解冲突',
      severity: 'high',
      category: '时间轴与帧率假设冲突',
      stepRef: 'Step 3',
      fileRefs: ['01_剪辑客观化总纲与SOP.md', 'workflow_rules.json'],
      evidenceQuote: 'broll_interval_sec: 6, bgm_beat_tolerance_frames: 2, target_fps: 30',
      rootCause:
        '固定 6 秒周期与大多数非 120 BPM 的 BGM 节拍网格不同步；同时把“画面切换点”同时绑定给语义句尾、6 秒节拍和 BGM 鼓点三个硬条件，在数学上经常无交集。',
      impact:
        '脚本要么找不到合法切点直接跳过 B-roll，要么为了凑 2 帧鼓点强行在词语中间切断画面，造成视听割裂。',
      fixStrategy:
        '将硬数值改为“区间窗口 + 优先级吸附”：定义允许切换区间 [4.5s, 8.5s]，优先吸附语义句边界，再在 ±0.35s 窗口内就近吸附 BGM 强拍；若素材帧率非 30fps 则统一换算为秒/毫秒基准。',
    },
  ],
  alignments: [
    {
      id: 'ALN-01',
      ruleName: '静音裁切阈值与最小时长',
      proseSource: '01_剪辑客观化总纲与SOP.md',
      proseRule: '停顿超过 0.45 秒且音量低于 -38dB 的段落切掉',
      scriptSource: 'step1_silence_cut.py',
      scriptBehavior: '硬编码为 MIN_SILENCE_LEN = 0.30s 且 SILENCE_THRESH = -32dB',
      status: 'hardcoded_override',
      discrepancyDetail:
        '脚本将阈值大幅收紧（-38dB -> -32dB，0.45s -> 0.30s），会直接吃掉轻声气口、尾音和正常语速的逗号停顿。',
      recommendation:
        '将参数抽离到统一配置文件，并改用基于当前视频底噪分布的自适应相对阈值（如底噪均值 + 6dB）加 80ms 前后安全留白（pad_ms）。',
    },
    {
      id: 'ALN-02',
      ruleName: '情绪反转与留白保护规则',
      proseSource: '01_剪辑客观化总纲与SOP.md',
      proseRule: '如果是“反转停顿”或“情绪留白”，需保留 0.6 秒呼吸感',
      scriptSource: 'step1_silence_cut.py',
      scriptBehavior: 'Step 1 为纯音量硬切，根本无语义上下文，所有停顿在进 Step 2 前已被切光',
      status: 'inverted',
      discrepancyDetail:
        '这是典型的执行顺序逻辑倒置：需要语义理解才能保护的“情绪停顿”，在没有任何语义分析的 Step 1 就被物理销毁了，导致 Step 2 的 Prompt 要求形同虚设。',
      recommendation:
        '顺序反转：先完成 ASR 词级对齐与标点/反转词检测，给每个停顿打上“普通停顿 / 逻辑转折停顿”标签，再按不同保护时长执行虚拟裁切。',
    },
    {
      id: 'ALN-03',
      ruleName: 'B-roll 相似度匹配与鼓点对齐',
      proseSource: '01_剪辑客观化总纲与SOP.md',
      proseRule: '关键词检索分数 > 0.75 自动覆盖主画面，且与 BGM 鼓点对齐误差 ≤ 2 帧',
      scriptSource: 'step3_broll_and_bgm.py (缺失)',
      scriptBehavior: '仓库中仅有配置项 workflow_rules.json，未发现实际可执行脚本',
      status: 'missing_in_script',
      discrepancyDetail:
        '文字与配置均依赖该模块完成节奏客观化，但脚本层尚未落地，且 0.75 绝对分数阈值在不同向量模型下无统一物理含义。',
      recommendation:
        '改用 Top-K 相对排序 + 人工备选槽（提供前 3 候选 B-roll），并落地基于 librosa / onset 检测的软吸附脚本。',
    },
    {
      id: 'ALN-04',
      ruleName: '音频响度标准化目标',
      proseSource: '01_剪辑客观化总纲与SOP.md',
      proseRule: '保证整体听感一致与去噪稳定',
      scriptSource: 'workflow_rules.json',
      scriptBehavior: '已定义 audio_target_lufs: -14，但 Step 1 脚本尚未调用 loudnorm 滤镜',
      status: 'drifted',
      discrepancyDetail:
        '配置已明确目标响度，但执行脚本仅运行了 silenceremove，未在渲染链中挂载 EBU R128 响度归一化。',
      recommendation:
        '在最终确定性渲染阶段显式挂载双遍 loudnorm (-14 LUFS, -1.0 dBTP True Peak)。',
    },
  ],
  objectificationMatrix: [
    {
      id: 'OBJ-01',
      editingTask: '静音检测、气口缓冲与音频响度标准化',
      tier: 'deterministic',
      currentAssumption: '固定 -32dB / 0.3s 一刀切',
      whyBoundaryFails: '不同录音环境的底噪和说话人音量波动极大，绝对阈值在安静轻语或户外环境下必然误切。',
      weakAiRisk: '不需要也不应该交给 AI 处理，AI 无法读取波形能量。',
      recommendedMechanism: '基于音频 RMS 百分位动态计算底噪基准 + VAD 语音活动检测 + 强制保留前后 80~120ms 淡入淡出缓冲。',
      fallbackRule: '若底噪信噪比 < 10dB，自动跳过自动切静音，仅输出静音建议标记轨道。',
    },
    {
      id: 'OBJ-02',
      editingTask: '口癖、重录NG句与冗余赘述筛选',
      tier: 'probabilistic_guardrailed',
      currentAssumption: '让弱 AI 整篇阅读后直接重写时间轴',
      whyBoundaryFails: '长文本下弱 AI 容易误删铺垫句或把反问句当成废话，且无法准确感知连续重录的“哪一遍语气最好”。',
      weakAiRisk: '弱 AI 缺乏全局叙事记忆，容易过度删减导致语义断层。',
      recommendedMechanism: '按自然段（≤ 15 句）分块输入，脚本先用规则标出“疑似重复句/填充词”，弱 AI 仅对每句输出 {segment_id, decision, confidence, reason}。',
      fallbackRule: '置信度 < 0.80 或删除将导致句子主谓残缺时，强制降级为 Keep + 黄色复核标记。',
    },
    {
      id: 'OBJ-03',
      editingTask: 'B-roll 语义配图与画面节奏切换',
      tier: 'probabilistic_guardrailed',
      currentAssumption: '每 6 秒必须硬切 + 相似度 > 0.75 自动覆盖',
      whyBoundaryFails: '讲解抽象概念或人物微表情高光时刻强行切 B-roll 会破坏情绪连接；纯关键词匹配常出现“字面相关但情绪违和”的尴尬画面。',
      weakAiRisk: '弱 AI 容易机械堆砌字面素材（说到“时间”就贴钟表）。',
      recommendedMechanism: '由脚本先划出“允许插入窗口（非强调表情、非核心板书）”，AI 从带语义标签的素材库做 Top-3 推荐，默认以“轨外候选”写入时间轴。',
      fallbackRule: '若无匹配度达标素材，降级为轻量 106% 景别推拉（Jump-in Cut）替代生硬 B-roll。',
    },
    {
      id: 'OBJ-04',
      editingTask: '情绪反转留白、幽默节奏与叙事结构重组',
      tier: 'human_gate',
      currentAssumption: '试图用规则定义“反转留白 0.6 秒”让 AI 自动执行',
      whyBoundaryFails: '喜剧停顿、反讽语气和叙事钩子高度依赖表演微表情、声调上扬与观众预期差，纯文本与弱 AI 无法可靠捕捉。',
      weakAiRisk: '弱 AI 几乎必然误判反讽语义，把最精彩的停顿当作冷场删掉。',
      recommendedMechanism: '保留 1 个轻量“人类导演复核门控（3~5 分钟）”：系统只把高情绪波动/转折点高亮展示在审片列表，由人一键勾选保留或调整。',
      fallbackRule: '所有被标记为“转折词/高音调峰值/长停顿”的区间在未经人工确认前一律锁定禁止自动删除。',
    },
  ],
  edgeCases: [
    {
      id: 'EC-01',
      scenario: '吸气声与轻声尾音被当作静音切断（“机关枪效应”）',
      triggerCondition: '说话人句尾音量渐弱低于 -32dB 或句首吸气声被硬切',
      currentFailureMode: '成片听起来喘不过气，字尾发“咔哒”爆音，观众听觉疲劳。',
      guardrailSolution: '强制应用 pre-pad 60ms + post-pad 100ms + 15ms 音频交叉淡化（crossfade），绝不做 0ms 硬切。',
      affectedStage: 'Stage 2 · 确定性音频与句段分析',
    },
    {
      id: 'EC-02',
      scenario: '连续 NG 重录同一句话（前两遍卡壳，第三遍完整）',
      triggerCondition: '相邻 3 个句段文本相似度 > 0.65 且前段未说完',
      currentFailureMode: '普通静音裁切会把 3 遍重录全部连在一起保留，弱 AI 经常误留第一遍删掉第三遍。',
      guardrailSolution: '脚本层先做“相邻句前缀重叠检测”聚合成 Retake Group，默认高亮最后一遍完整句为 Keep，前几遍标为 Drop 候选供确认。',
      affectedStage: 'Stage 3 · 弱 AI 结构化语义初筛',
    },
    {
      id: 'EC-03',
      scenario: '弱 AI 输出非法 JSON 或编造不存在的 segment_id',
      triggerCondition: '模型长上下文注意力衰减或输出多余解释文本',
      currentFailureMode: '下游脚本 JSON.parse 直接崩溃，整条自动化流水线中断。',
      guardrailSolution: '引入确定性校验层（Validator）：过滤非法的 segment_id、对缺失 ID 自动回填默认 Keep，并限制单次请求 ≤ 20 个句段。',
      affectedStage: 'Stage 3 · 弱 AI 结构化语义初筛',
    },
    {
      id: 'EC-04',
      scenario: '反讽停顿 / 金句前蓄力留白被自动删短',
      triggerCondition: '转折连接词（“但是”、“其实”、“结果呢”）前后出现 0.5~1.2s 停顿',
      currentFailureMode: '金句失去节奏张力，变得平铺直叙。',
      guardrailSolution: '在停顿分级规则中增加“转折词保护白名单”，匹配到白名单前后的停顿自动进入保留态，不触发压缩。',
      affectedStage: 'Stage 4 · 轻量人工边界门控',
    },
  ],
  legacyPipeline: [
    {
      id: 'L1',
      name: 'Step 1 · 静音物理硬切',
      summary: 'FFmpeg 直接重编码删静音（-32dB / 0.3s），销毁原时间轴坐标与留白',
      issueIds: ['HLI-01'],
      nextIds: ['L2'],
    },
    {
      id: 'L2',
      name: 'Step 2 · 弱 AI 整篇导演',
      summary: '一次性喂入原始 SRT，要求同时删口癖、护留白、配 B-roll 并手算毫秒时间码',
      issueIds: ['HLI-01', 'HLI-02'],
      nextIds: ['L3'],
    },
    {
      id: 'L3',
      name: 'Step 3 · 硬约束 B-roll 与鼓点',
      summary: '同时要求每 6 秒切换、相似度 > 0.75 且鼓点误差 ≤ 2 帧（脚本缺失）',
      issueIds: ['HLI-04'],
      nextIds: ['L4'],
    },
    {
      id: 'L4',
      name: 'Step 4 · 无界质检打回',
      summary: '信息密度 < 80 自动循环打回 Step 2，无最大重试限制',
      issueIds: ['HLI-03'],
      nextIds: ['L2'],
    },
  ],
  refactoredPipeline: [
    {
      id: 'R1',
      order: 1,
      name: '母带索引与词级时间轴对齐',
      layer: 'ingest',
      owner: 'script',
      inputs: ['原始视频素材', '多轨音频'],
      outputs: ['master_manifest.json', 'word_level_asr.json'],
      contractSchema:
        '{ media_id, fps, duration_ms, words: [{ word_id, text, start_ms, end_ms, rms_db }] }',
      fallbackPolicy: '素材帧率非标准时统一以毫秒时间基记录，渲染时再做帧对齐。',
      replacesLegacySteps: ['原始未对齐的 SRT 输入'],
      weakAiAdaptation: '零 AI 参与，100% 确定性建立唯一母带坐标系，彻底消除后续时间漂移。',
    },
    {
      id: 'R2',
      order: 2,
      name: '确定性声学分析与原子句段切分',
      layer: 'deterministic',
      owner: 'script',
      inputs: ['word_level_asr.json', '音频波形'],
      outputs: ['atomic_segments.json', 'retake_groups.json'],
      contractSchema:
        '{ segment_id, source_in_ms, source_out_ms, text, pause_after_ms, pause_type, retake_group_id }',
      fallbackPolicy: '高底噪素材自动关闭自动压缩停顿，统一加 80ms 安全前后缓冲与交叉淡化。',
      replacesLegacySteps: ['Step 1 · 静音物理硬切'],
      weakAiAdaptation:
        '用代码先做自适应底噪检测、转折词停顿保护和 NG 重录聚类，绝不破坏原始文件。',
    },
    {
      id: 'R3',
      order: 3,
      name: '分块弱 AI 语义初筛（严格 ID 契约）',
      layer: 'ai_assisted',
      owner: 'weak_ai',
      inputs: ['atomic_segments.json (按 ≤20 句分块)'],
      outputs: ['segment_decisions.json'],
      contractSchema:
        '{ segment_id, action: "keep"|"drop"|"review", confidence: 0..1, broll_intent?: string }',
      fallbackPolicy: 'Schema 校验失败自动重试 1 次；缺失 ID 或 confidence < 0.8 强制降级为 keep + review。',
      replacesLegacySteps: ['Step 2 · 弱 AI 整篇导演'],
      weakAiAdaptation:
        '弱 AI 不再碰任何时间码，只对已有 segment_id 输出枚举决策，大幅降低幻觉率。',
    },
    {
      id: 'R4',
      order: 4,
      name: '轻量人工边界复核门控（3 分钟审校）',
      layer: 'human_gate',
      owner: 'human',
      inputs: ['segment_decisions.json (仅过滤 review 与转折留白项)'],
      outputs: ['approved_edl.json'],
      contractSchema: '{ approved_segment_ids: string[], locked_pauses: string[] }',
      fallbackPolicy: '若跳过人工复核，仅自动执行 confidence ≥ 0.90 的确定性口癖与重录删减。',
      replacesLegacySteps: ['Step 4 · 无界质检打回'],
      weakAiAdaptation:
        '把弱 AI 最容易翻车的“反讽/情绪/高风险删减”集中给人类一键决策，避免死循环。',
    },
    {
      id: 'R5',
      order: 5,
      name: '区间窗口节奏装配与非破坏性工程导出',
      layer: 'render',
      owner: 'script',
      inputs: ['approved_edl.json', 'B-roll 标签库', 'BGM 节拍图'],
      outputs: ['project.otio / project.fcpxml', 'final_preview.mp4'],
      contractSchema:
        '{ tracks: [main_video, broll_candidates, bgm], loudnorm: -14, crossfade_ms: 15 }',
      fallbackPolicy: 'B-roll 无高匹配素材时降级为 106% 景别推拉；BGM 吸附窗口 [4.5s, 8.5s] 软对齐。',
      replacesLegacySteps: ['Step 3 · 硬约束 B-roll 与鼓点'],
      weakAiAdaptation:
        '输出可二次精修的 FCPXML/OTIO 工程文件而非“一锤子死视频”，人机协作成本最低。',
    },
  ],
  refactoredSopNotes:
    '建议落地顺序：先将所有脚本改为输出统一中间结构 timeline.json（非破坏性母带坐标），再拆分弱 AI Prompt 为“口癖重录筛选”和“B-roll 意图打标”两个独立微任务。请立即点击右上角连接您的 Google Drive，导入文件夹 16vQib85qlNyF0EFmzPVSY6EoRIdAZWQf 中的真实文档与脚本，获取针对您实际工作流的逐文件深度诊断与重构代码方案。',
  generatedAt: '示例预载模式（连接 Google Drive 后实时生成）',
  sourceMode: 'sample',
  analyzedFileCount: 4,
};
