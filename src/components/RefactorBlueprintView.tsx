import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  FileCode,
  FileText,
  HardDriveUpload,
  Loader2,
  Wand2,
} from 'lucide-react';
import type { PipelineStage, WorkflowAuditReport, WorkflowFile } from '../types/workflow';
import { buildRefactoringMarkdown } from '../utils/workflowAnalyzer';
import { WorkflowBundlePublisher } from './WorkflowBundlePublisher';

interface RefactorBlueprintViewProps {
  report: WorkflowAuditReport;
  folderName: string;
  files: WorkflowFile[];
  hasDriveToken: boolean;
  onRequestDriveSave: (fileName: string, content: string) => void;
  onRequestDriveBundleSave: (
    folderName: string,
    bundleFiles: Array<{ path: string; content: string }>
  ) => void;
  driveSaveResult: { name: string; webViewLink?: string } | null;
}

const OWNER_META: Record<PipelineStage['owner'], { label: string; toneClass: string }> = {
  script: { label: '确定性脚本', toneClass: 'text-emerald-700' },
  weak_ai: { label: '弱 AI 受控节点', toneClass: 'text-blue-700' },
  human: { label: '轻量人工门控', toneClass: 'text-amber-700' },
};

const LAYER_LABELS: Record<PipelineStage['layer'], string> = {
  ingest: '母带索引层',
  deterministic: '确定性规则层',
  ai_assisted: '结构化 AI 初筛层',
  human_gate: '人工复核门控',
  render: '非破坏性装配层',
};

type ArtifactKey = 'refactored_sop' | 'weak_ai_prompts' | 'validator_script';

export const RefactorBlueprintView: React.FC<RefactorBlueprintViewProps> = ({
  report,
  folderName,
  files,
  hasDriveToken,
  onRequestDriveSave,
  onRequestDriveBundleSave,
  driveSaveResult,
}) => {
  const [topologyMode, setTopologyMode] = useState<'refactored' | 'compare'>('refactored');
  const [copiedReport, setCopiedReport] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactKey | null>(null);
  const [artifactCache, setArtifactCache] = useState<Partial<Record<ArtifactKey, string>>>({});
  const [artifactLoading, setArtifactLoading] = useState<ArtifactKey | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [copiedArtifact, setCopiedArtifact] = useState(false);

  const markdownReport = useMemo(
    () => buildRefactoringMarkdown(report, folderName),
    [report, folderName]
  );

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdownReport);
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 1800);
    } catch {
      // Clipboard fallback ignored if restricted
    }
  };

  const handleDownloadMarkdown = () => {
    const blob = new Blob([markdownReport], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CutLogic_工作流重构方案_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleGenerateArtifact = async (type: ArtifactKey) => {
    setActiveArtifact(type);
    setArtifactError(null);
    if (artifactCache[type]) return;

    setArtifactLoading(type);
    try {
      const selectedFiles = files
        .filter((f) => f.selected && f.content.trim().length > 0)
        .map((f) => ({ name: f.name, path: f.path, kind: f.kind, content: f.content }));

      const res = await fetch('/api/rewrite-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: type,
          report,
          files: selectedFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '生成重构产物失败。');
      }
      setArtifactCache((prev) => ({ ...prev, [type]: data.content }));
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : '生成重构产物时发生异常。');
    } finally {
      setArtifactLoading(null);
    }
  };

  const handleCopyArtifact = async () => {
    if (!activeArtifact || !artifactCache[activeArtifact]) return;
    try {
      await navigator.clipboard.writeText(artifactCache[activeArtifact]!);
      setCopiedArtifact(true);
      setTimeout(() => setCopiedArtifact(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const defaultExportFilename = `CutLogic_重构方案_${new Date().toISOString().slice(0, 10)}.md`;

  return (
    <div className="space-y-6">
      {/* Header & Export Actions */}
      <section className="rounded-lg border border-slate-200 bg-white px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              重构后剪辑工作流架构与落地产物
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              以非破坏性母带时间轴为核心，将确定性计算交还脚本、弱 AI 收敛为有界 JSON 分类器，并在关键主观节点保留轻量人工复核。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleCopyMarkdown}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              {copiedReport ? (
                <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copiedReport ? '已复制 Markdown' : '复制完整报告'}
            </button>

            <button
              type="button"
              onClick={handleDownloadMarkdown}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              下载 .md
            </button>

            <button
              type="button"
              onClick={() => onRequestDriveSave(defaultExportFilename, markdownReport)}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 whitespace-nowrap"
            >
              <HardDriveUpload className="h-3.5 w-3.5" aria-hidden="true" />
              {hasDriveToken ? '保存到 Google Drive' : '登录并保存到 Drive'}
            </button>
          </div>
        </div>

        {driveSaveResult && (
          <div className="mt-4 border-t border-slate-200 pt-3 text-xs text-emerald-800">
            已成功保存至 Google Drive：<span className="font-mono">{driveSaveResult.name}</span>
          </div>
        )}
      </section>

      {/* Topology View Toggle */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <h2 className="text-sm font-semibold text-slate-900">工作流执行拓扑</h2>
          <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTopologyMode('refactored')}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                topologyMode === 'refactored'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              重构后管线 ({report.refactoredPipeline.length} 阶段)
            </button>
            <button
              type="button"
              onClick={() => setTopologyMode('compare')}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                topologyMode === 'compare'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              新旧流程并排对比
            </button>
          </div>
        </div>

        {topologyMode === 'compare' ? (
          <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            {/* Legacy Column */}
            <div>
              <div className="border-b border-slate-200 bg-slate-50/70 px-6 py-3">
                <h3 className="text-xs font-semibold text-red-700">
                  旧工作流链路（存在硬逻辑断裂与死循环）
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {report.legacyPipeline.map((node, index) => (
                  <div key={node.id} className="px-6 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {node.name}
                      </span>
                      <span className="font-mono text-xs text-red-700 tabular-nums whitespace-nowrap">
                        {node.issueIds.length > 0
                          ? `问题：${node.issueIds.join(', ')}`
                          : `阶段 ${index + 1}`}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                      {node.summary}
                    </p>
                    {node.nextIds.length > 0 && (
                      <p className="mt-2 font-mono text-[11px] text-slate-500">
                        流向 → {node.nextIds.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Refactored Column */}
            <div>
              <div className="border-b border-slate-200 bg-slate-50/70 px-6 py-3">
                <h3 className="text-xs font-semibold text-emerald-700">
                  重构后分层管线（非破坏性母带坐标 + 弱 AI 有界契约）
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {report.refactoredPipeline.map((stage) => {
                  const owner = OWNER_META[stage.owner];
                  return (
                    <div key={stage.id} className="px-6 py-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900">
                          <span className="mr-1.5 font-mono text-blue-700 tabular-nums">
                            0{stage.order}.
                          </span>
                          {stage.name}
                        </span>
                        <span className={`text-xs font-medium whitespace-nowrap ${owner.toneClass}`}>
                          {owner.label}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-700">
                        {stage.weakAiAdaptation}
                      </p>
                      <p className="mt-2 font-mono text-[11px] text-slate-500">
                        替代：{stage.replacesLegacySteps.join(' / ') || '新增基建层'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {report.refactoredPipeline.map((stage) => {
              const owner = OWNER_META[stage.owner];
              return (
                <div key={stage.id} className="px-6 py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <span className="font-mono text-sm font-semibold text-blue-700 tabular-nums">
                        Stage 0{stage.order}
                      </span>
                      <h3 className="text-base font-semibold text-slate-900">{stage.name}</h3>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-medium ${owner.toneClass}`}>{owner.label}</span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className="text-slate-500">{LAYER_LABELS[stage.layer]}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span className="font-medium text-slate-800">输入：</span>
                    <span>{stage.inputs.join('、')}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span className="font-medium text-slate-800">输出：</span>
                    <span className="font-mono text-slate-700">{stage.outputs.join('、')}</span>
                  </div>

                  <div className="mt-3 rounded-md border border-slate-200 bg-[#F8FAFC] px-4 py-2.5">
                    <p className="text-[11px] font-medium text-slate-500">数据契约 Schema</p>
                    <p className="mt-1 font-mono text-xs text-slate-800">{stage.contractSchema}</p>
                  </div>

                  <div className="mt-3.5 grid grid-cols-1 gap-4 text-xs leading-relaxed md:grid-cols-2">
                    <div>
                      <span className="font-semibold text-blue-800">弱 AI 适配与职责边界：</span>
                      <span className="text-slate-700">{stage.weakAiAdaptation}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-slate-800">失败降级与兜底策略：</span>
                      <span className="text-slate-700">{stage.fallbackPolicy}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {report.refactoredSopNotes && (
          <div className="border-t border-slate-200 bg-slate-50/70 px-6 py-4 text-xs leading-relaxed text-slate-700">
            <span className="font-semibold text-slate-900">落地实施路线建议：</span>
            {report.refactoredSopNotes}
          </div>
        )}
      </section>

      {/* On-Demand Refactored Code & Prompt Generator */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-sm font-semibold text-slate-900">
            按需生成可执行重构产物（基于当前工作流文件与审计结论）
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            直接生成无逻辑矛盾的新版 SOP、拆分后的弱 AI 原子 Prompt 套件，或带 Schema 校验与降级分支的 Python 编排骨架。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-6 py-4">
          <button
            type="button"
            onClick={() => handleGenerateArtifact('refactored_sop')}
            disabled={artifactLoading !== null}
            className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeArtifact === 'refactored_sop'
                ? 'border-blue-700 bg-blue-50 text-blue-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            生成重构版 SOP 文档
          </button>

          <button
            type="button"
            onClick={() => handleGenerateArtifact('weak_ai_prompts')}
            disabled={artifactLoading !== null}
            className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeArtifact === 'weak_ai_prompts'
                ? 'border-blue-700 bg-blue-50 text-blue-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
            生成弱 AI 原子 Prompt 套件
          </button>

          <button
            type="button"
            onClick={() => handleGenerateArtifact('validator_script')}
            disabled={artifactLoading !== null}
            className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeArtifact === 'validator_script'
                ? 'border-blue-700 bg-blue-50 text-blue-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <FileCode className="h-3.5 w-3.5" aria-hidden="true" />
            生成 Python 校验与编排骨架
          </button>
        </div>

        {artifactError && (
          <div className="border-t border-slate-200 px-6 py-3 text-xs font-medium text-red-700" role="alert">
            {artifactError}
          </div>
        )}

        {artifactLoading && (
          <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-6 py-8 text-xs text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin text-blue-700" aria-hidden="true" />
            正在根据您的审计结果编写可执行重构产物，请稍候…
          </div>
        )}

        {activeArtifact && !artifactLoading && artifactCache[activeArtifact] && (
          <div className="border-t border-slate-200">
            <div className="flex items-center justify-between bg-slate-50 px-6 py-2.5">
              <span className="text-xs font-medium text-slate-700">
                生成结果预览
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCopyArtifact}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-950"
                >
                  {copiedArtifact ? (
                    <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {copiedArtifact ? '已复制' : '复制内容'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onRequestDriveSave(
                      `CutLogic_${activeArtifact}_${new Date().toISOString().slice(0, 10)}.md`,
                      artifactCache[activeArtifact]!
                    )
                  }
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-900"
                >
                  <HardDriveUpload className="h-3.5 w-3.5" aria-hidden="true" />
                  存到 Drive
                </button>
              </div>
            </div>
            <div className="max-h-[440px] overflow-auto bg-[#F8FAFC] px-6 py-5">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                {artifactCache[activeArtifact]}
              </pre>
            </div>
          </div>
        )}
      </section>

      {/* Complete Runnable Bundle Generator + GitHub & Drive Uploader */}
      <WorkflowBundlePublisher
        report={report}
        files={files}
        hasDriveToken={hasDriveToken}
        onRequestDriveBundleSave={onRequestDriveBundleSave}
      />
    </div>
  );
};
