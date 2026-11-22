import type {
  AlignmentStatus,
  StaticPrecheckFinding,
  WorkflowAuditReport,
  WorkflowFile,
  WorkflowFileKind,
} from '../types/workflow';

export const DEFAULT_DRIVE_FOLDER_ID = '16vQib85qlNyF0EFmzPVSY6EoRIdAZWQf';
export const DEFAULT_DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${DEFAULT_DRIVE_FOLDER_ID}?usp=drive_link`;

export interface DriveErrorDiagnosis {
  kind: 'scope_missing' | 'api_disabled' | 'no_folder_access' | 'token_expired' | 'not_found' | 'other';
  title: string;
  detail: string;
  needsReconsent: boolean;
}

export function diagnoseDriveApiError(
  status: number,
  rawBody: string
): DriveErrorDiagnosis {
  let apiMessage = '';
  let reason = '';
  let statusText = '';

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
        details?: Array<{ reason?: string }>;
      };
    };
    apiMessage = parsed.error?.message || '';
    statusText = parsed.error?.status || '';
    reason =
      parsed.error?.errors?.[0]?.reason ||
      parsed.error?.details?.[0]?.reason ||
      '';
  } catch {
    apiMessage = rawBody.slice(0, 220);
  }

  const combined = `${reason} ${statusText} ${apiMessage}`.toLowerCase();

  if (status === 401) {
    return {
      kind: 'token_expired',
      title: 'Google 授权令牌已过期',
      detail: '请重新点击「重新授权 Google Drive」完成登录。',
      needsReconsent: true,
    };
  }

  if (
    status === 403 &&
    (combined.includes('insufficient') ||
      combined.includes('scope') ||
      combined.includes('permission_denied') && combined.includes('authentication'))
  ) {
    return {
      kind: 'scope_missing',
      title: '登录时未授予 Google Drive 读取权限',
      detail:
        'Google 授权弹窗中的「查看并下载您的所有 Google 云端硬盘文件」勾选框默认可能未选中。请点击下方「重新授权并勾选 Drive 权限」，在弹窗中务必勾选 Google Drive 权限后再继续。',
      needsReconsent: true,
    };
  }

  if (
    status === 403 &&
    (combined.includes('accessnotconfigured') ||
      combined.includes('has not been used in project') ||
      combined.includes('is disabled'))
  ) {
    return {
      kind: 'api_disabled',
      title: 'Google Drive API 尚未在当前云项目中启用或正在生效',
      detail: `Google 返回：${apiMessage || 'Drive API not configured'}。若刚完成授权配置，请等待约 1 分钟后重试。`,
      needsReconsent: false,
    };
  }

  if (status === 403) {
    return {
      kind: 'no_folder_access',
      title: '当前 Google 账号无法访问该文件夹（403）',
      detail: `请确认登录账号对该文件夹拥有查看权限，或已在授权弹窗勾选 Google Drive 读取权限。Google 原始信息：${apiMessage || reason || 'Forbidden'}`,
      needsReconsent: true,
    };
  }

  if (status === 404) {
    return {
      kind: 'not_found',
      title: '未找到该 Google Drive 文件夹（404）',
      detail:
        '该文件夹可能不存在、已被移动，或未对当前登录的 Google 账号共享。您也可以点击「切换 Google 账号」或「浏览我的 Drive 文件夹」直接选择目录。',
      needsReconsent: false,
    };
  }

  return {
    kind: 'other',
    title: `Google Drive 请求失败 (${status})`,
    detail: apiMessage || '请稍后重试。',
    needsReconsent: false,
  };
}

const DRIVE_ID_REGEX = /^[a-zA-Z0-9_-]{12,128}$/;

export function parseDriveFolderId(input: string): {
  folderId: string | null;
  error: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return { folderId: null, error: '请输入 Google Drive 文件夹链接或文件夹 ID。' };
  }

  // Match https://drive.google.com/drive/folders/<ID>... or /drive/u/0/folders/<ID>...
  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{12,128})/);
  if (folderPathMatch?.[1]) {
    return { folderId: folderPathMatch[1], error: null };
  }

  // Match ?id=<ID> or &id=<ID>
  const queryIdMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{12,128})/);
  if (queryIdMatch?.[1]) {
    return { folderId: queryIdMatch[1], error: null };
  }

  // Reject arbitrary URLs that are not Drive folder links
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      folderId: null,
      error: '无法从该 URL 提取 Google Drive 文件夹 ID，请粘贴包含 /folders/ 的文件夹链接。',
    };
  }

  // Raw Drive folder ID
  if (DRIVE_ID_REGEX.test(trimmed)) {
    return { folderId: trimmed, error: null };
  }

  return {
    folderId: null,
    error: '文件夹 ID 格式无效，请检查链接是否完整。',
  };
}

const PROSE_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'rtf',
  'doc',
  'docx',
  'prompt',
]);

const SCRIPT_EXTENSIONS = new Set([
  'py',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'lua',
  'edl',
  'fcpxml',
  'xml',
  'applescript',
]);

const CONFIG_EXTENSIONS = new Set([
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'csv',
  'tsv',
  'env',
  'cfg',
]);

export function classifyWorkflowFile(name: string, mimeType: string): WorkflowFileKind {
  const normalizedMime = (mimeType || '').toLowerCase();
  if (
    normalizedMime === 'application/vnd.google-apps.document' ||
    normalizedMime === 'application/vnd.google-apps.presentation'
  ) {
    return 'prose';
  }
  if (normalizedMime === 'application/vnd.google-apps.spreadsheet') {
    return 'config';
  }
  if (normalizedMime === 'application/vnd.google-apps.script') {
    return 'script';
  }

  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (PROSE_EXTENSIONS.has(ext)) return 'prose';

  if (normalizedMime.startsWith('text/')) {
    if (normalizedMime.includes('javascript') || normalizedMime.includes('python')) {
      return 'script';
    }
    if (normalizedMime.includes('csv') || normalizedMime.includes('json')) {
      return 'config';
    }
    return 'prose';
  }
  if (normalizedMime.includes('json') || normalizedMime.includes('yaml')) {
    return 'config';
  }
  if (normalizedMime.includes('javascript') || normalizedMime.includes('x-python')) {
    return 'script';
  }

  return 'other';
}

export function isReadableDriveMime(name: string, mimeType: string): boolean {
  const kind = classifyWorkflowFile(name, mimeType);
  if (kind !== 'other') return true;
  return mimeType === 'application/pdf';
}

export function detectStaticLogicIssues(files: WorkflowFile[]): StaticPrecheckFinding[] {
  const findings: StaticPrecheckFinding[] = [];
  const selectedFiles = files.filter((f) => f.selected && f.content.trim().length > 0);

  const proseFiles = selectedFiles.filter((f) => f.kind === 'prose');
  const scriptFiles = selectedFiles.filter((f) => f.kind === 'script' || f.kind === 'config');

  // 1. Check prose vs script inventory imbalance
  if (proseFiles.length > 0 && scriptFiles.length === 0) {
    findings.push({
      id: 'static-no-scripts',
      fileName: proseFiles[0].name,
      ruleCode: 'INVENTORY_NO_SCRIPT',
      severity: 'high',
      message: '当前选中文件中仅包含文字/文档，缺少脚本或配置文件，无法完整比对文字与脚本逻辑。',
      snippet: `已选文档 ${proseFiles.length} 份，脚本/配置 0 份`,
    });
  }

  for (const file of selectedFiles) {
    const lines = file.content.split(/\r?\n/);

    // 2. Hardcoded rigid thresholds without tolerance/fallback in scripts
    if (file.kind === 'script' || file.kind === 'config') {
      const hasFallback = /(fallback|default|except|catch|retry|margin|buffer|pad)/i.test(file.content);
      lines.forEach((line, idx) => {
        const thresholdMatch = line.match(
          /(silence_thresh|threshold|min_duration|max_gap|cut_score|db|lufs|fps)\s*[:=<>!]+\s*(-?\d+(?:\.\d+)?)/i
        );
        if (thresholdMatch && !hasFallback) {
          findings.push({
            id: `static-threshold-${file.id}-${idx + 1}`,
            fileName: file.name,
            ruleCode: 'UNGUARDED_HARD_THRESHOLD',
            severity: 'high',
            message: `第 ${idx + 1} 行存在硬编码阈值 (${thresholdMatch[1]})，且脚本内未检测到容错缓冲或降级分支。`,
            snippet: line.trim().slice(0, 120),
          });
        }
      });

      // 3. Weak-AI anti-pattern: asking LLM directly for frame/timestamp cuts without schema
      const callsLlm = /(openai|gemini|anthropic|chat\.completions|generateContent|llm|prompt)/i.test(
        file.content
      );
      const asksExactTimecode = /(timecode|timestamp|frame|毫秒|帧号|时间码|起止时间)/i.test(
        file.content
      );
      const hasJsonSchema = /(response_format|responseSchema|json_schema|pydantic|zod|JSON\.parse)/i.test(
        file.content
      );
      if (callsLlm && asksExactTimecode && !hasJsonSchema) {
        findings.push({
          id: `static-llm-timecode-${file.id}`,
          fileName: file.name,
          ruleCode: 'WEAK_AI_UNSTRUCTURED_TIMECODE',
          severity: 'critical',
          message: '脚本让模型直接输出时间码/帧号但未检测到强 Schema 校验，弱自动化 AI 极易产生时间偏移与格式幻觉。',
          snippet: '建议改为让脚本先切分原子片段并分配 ID，模型仅对 segment_id 做分类与打分。',
        });
      }
    }

    // 4. Detect prose referencing script filenames not present in workspace
    if (file.kind === 'prose') {
      const referencedScripts = Array.from(
        new Set(file.content.match(/[a-zA-Z0-9_-]+\.(?:py|js|ts|sh|json|yaml|yml)/g) || [])
      );
      const availableNames = new Set(selectedFiles.map((f) => f.name.toLowerCase()));
      for (const refName of referencedScripts) {
        if (!availableNames.has(refName.toLowerCase())) {
          findings.push({
            id: `static-missing-ref-${file.id}-${refName}`,
            fileName: file.name,
            ruleCode: 'PROSE_SCRIPT_REF_MISSING',
            severity: 'medium',
            message: `文字说明引用了脚本/配置 "${refName}"，但当前已选文件中未找到同名文件。`,
            snippet: `缺失引用：${refName}`,
          });
        }
      }
    }
  }

  return findings;
}

export interface AuditMetrics {
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  totalAlignments: number;
  mismatchedAlignments: number;
  alignmentPassRate: number;
  deterministicCount: number;
  guardrailedCount: number;
  humanGateCount: number;
  legacyStepCount: number;
  refactoredStepCount: number;
}

export function computeAuditMetrics(report: WorkflowAuditReport): AuditMetrics {
  const criticalCount = report.hardLogicIssues.filter((i) => i.severity === 'critical').length;
  const highCount = report.hardLogicIssues.filter((i) => i.severity === 'high').length;
  const mediumCount = report.hardLogicIssues.filter((i) => i.severity === 'medium').length;
  const totalIssues = report.hardLogicIssues.length;

  const totalAlignments = report.alignments.length;
  const matchedAlignments = report.alignments.filter((a) => a.status === 'matched').length;
  const mismatchedAlignments = totalAlignments - matchedAlignments;
  const alignmentPassRate =
    totalAlignments === 0 ? 100 : Math.round((matchedAlignments / totalAlignments) * 100);

  const deterministicCount = report.objectificationMatrix.filter(
    (d) => d.tier === 'deterministic'
  ).length;
  const guardrailedCount = report.objectificationMatrix.filter(
    (d) => d.tier === 'probabilistic_guardrailed'
  ).length;
  const humanGateCount = report.objectificationMatrix.filter(
    (d) => d.tier === 'human_gate'
  ).length;

  return {
    totalIssues,
    criticalCount,
    highCount,
    mediumCount,
    totalAlignments,
    mismatchedAlignments,
    alignmentPassRate,
    deterministicCount,
    guardrailedCount,
    humanGateCount,
    legacyStepCount: report.legacyPipeline.length,
    refactoredStepCount: report.refactoredPipeline.length,
  };
}

export const ALIGNMENT_STATUS_META: Record<
  AlignmentStatus,
  { label: string; toneClass: string }
> = {
  matched: { label: '完全匹配', toneClass: 'text-emerald-700' },
  drifted: { label: '语义漂移', toneClass: 'text-amber-700' },
  missing_in_script: { label: '脚本缺失', toneClass: 'text-red-700' },
  inverted: { label: '逻辑倒置', toneClass: 'text-red-700' },
  hardcoded_override: { label: '硬编码覆盖', toneClass: 'text-amber-700' },
};

export function buildRefactoringMarkdown(
  report: WorkflowAuditReport,
  folderLabel = 'Google Drive 剪辑工作流'
): string {
  const lines: string[] = [];
  lines.push(`# ${report.workflowTitle} — 逻辑审计与重构方案`);
  lines.push('');
  lines.push(`- **来源目录**：${folderLabel}`);
  lines.push(`- **生成时间**：${report.generatedAt}`);
  lines.push(`- **分析文件数**：${report.analyzedFileCount}`);
  lines.push('');
  lines.push('## 一、核心诊断摘要与“剪辑客观化”可行性结论');
  lines.push('');
  lines.push(report.executiveSummary);
  lines.push('');
  lines.push(`**可行性结论**：${report.feasibilityConclusion}`);
  lines.push('');
  lines.push('### 弱自动化 AI 适配核心原则');
  report.weakAiPrinciples.forEach((p, i) => {
    lines.push(`${i + 1}. ${p}`);
  });

  lines.push('');
  lines.push('## 二、硬逻辑漏洞分析（Hard Logic Analysis）');
  lines.push('');
  report.hardLogicIssues.forEach((issue, idx) => {
    lines.push(`### ${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.title}`);
    lines.push(`- **分类**：${issue.category} · **涉及步骤**：${issue.stepRef}`);
    lines.push(`- **涉及文件**：${issue.fileRefs.join(', ') || '工作流全局'}`);
    lines.push(`- **原始证据**：> ${issue.evidenceQuote}`);
    lines.push(`- **根因分析**：${issue.rootCause}`);
    lines.push(`- **实操后果**：${issue.impact}`);
    lines.push(`- **重构解法**：${issue.fixStrategy}`);
    lines.push('');
  });

  lines.push('## 三、文字逻辑与脚本逻辑对齐审计');
  lines.push('');
  lines.push('| 规则项 | 文字规定 | 脚本实际行为 | 匹配状态 | 修正建议 |');
  lines.push('| --- | --- | --- | --- | --- |');
  report.alignments.forEach((a) => {
    const statusLabel = ALIGNMENT_STATUS_META[a.status]?.label || a.status;
    lines.push(
      `| ${a.ruleName} | ${a.proseRule.replace(/\|/g, '\\|')} | ${a.scriptBehavior.replace(/\|/g, '\\|')} | ${statusLabel} | ${a.recommendation.replace(/\|/g, '\\|')} |`
    );
  });

  lines.push('');
  lines.push('## 四、“剪辑客观化”三层分层矩阵与边界治理');
  lines.push('');
  const tierLabels = {
    deterministic: '完全客观化（纯代码规则）',
    probabilistic_guardrailed: '半客观化（弱 AI 打分 + 阈值护栏）',
    human_gate: '主观保留门控（人工轻量复核）',
  };
  report.objectificationMatrix.forEach((item, idx) => {
    lines.push(`### ${idx + 1}. ${item.editingTask}（${tierLabels[item.tier]}）`);
    lines.push(`- **原工作流假设**：${item.currentAssumption}`);
    lines.push(`- **边界失效原因**：${item.whyBoundaryFails}`);
    lines.push(`- **弱 AI 风险**：${item.weakAiRisk}`);
    lines.push(`- **推荐机制**：${item.recommendedMechanism}`);
    lines.push(`- **兜底降级策略**：${item.fallbackRule}`);
    lines.push('');
  });

  lines.push('### 高频实操边界清单');
  report.edgeCases.forEach((ec, idx) => {
    lines.push(
      `${idx + 1}. **${ec.scenario}**（阶段：${ec.affectedStage}）— 触发条件：${ec.triggerCondition}；原失效方式：${ec.currentFailureMode}；护栏解法：${ec.guardrailSolution}`
    );
  });

  lines.push('');
  lines.push('## 五、重构后可执行工作流架构');
  lines.push('');
  report.refactoredPipeline.forEach((stage) => {
    lines.push(`### Step ${stage.order}. ${stage.name}（执行者：${stage.owner}）`);
    lines.push(`- **输入契约**：${stage.inputs.join('、')}`);
    lines.push(`- **输出契约**：${stage.outputs.join('、')}`);
    lines.push(`- **数据结构 / Schema**：\`${stage.contractSchema}\``);
    lines.push(`- **弱 AI 适配改造**：${stage.weakAiAdaptation}`);
    lines.push(`- **失败降级策略**：${stage.fallbackPolicy}`);
    lines.push(`- **替代旧步骤**：${stage.replacesLegacySteps.join('、') || '新增基础设施层'}`);
    lines.push('');
  });

  if (report.refactoredSopNotes) {
    lines.push('## 六、重构落地实施说明');
    lines.push('');
    lines.push(report.refactoredSopNotes);
  }

  return lines.join('\n');
}
