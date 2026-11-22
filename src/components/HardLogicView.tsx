import React, { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Search } from 'lucide-react';
import type { HardLogicIssue, IssueSeverity, WorkflowAuditReport } from '../types/workflow';
import { computeAuditMetrics } from '../utils/workflowAnalyzer';

interface HardLogicViewProps {
  report: WorkflowAuditReport;
}

const SEVERITY_CONFIG: Record<
  IssueSeverity,
  { label: string; textClass: string; Icon: React.FC<{ className?: string }> }
> = {
  critical: { label: '严重阻塞', textClass: 'text-red-700', Icon: AlertCircle },
  high: { label: '高危冲突', textClass: 'text-amber-700', Icon: AlertTriangle },
  medium: { label: '中度隐患', textClass: 'text-slate-600', Icon: Info },
};

export const HardLogicView: React.FC<HardLogicViewProps> = ({ report }) => {
  const [severityFilter, setSeverityFilter] = useState<'all' | IssueSeverity>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(report.hardLogicIssues[0]?.id || '');

  const metrics = useMemo(() => computeAuditMetrics(report), [report]);

  const filteredIssues = useMemo(() => {
    const q = query.trim().toLowerCase();
    return report.hardLogicIssues.filter((issue) => {
      if (severityFilter !== 'all' && issue.severity !== severityFilter) return false;
      if (!q) return true;
      return (
        issue.title.toLowerCase().includes(q) ||
        issue.rootCause.toLowerCase().includes(q) ||
        issue.stepRef.toLowerCase().includes(q) ||
        issue.fileRefs.some((f) => f.toLowerCase().includes(q))
      );
    });
  }, [report.hardLogicIssues, severityFilter, query]);

  const activeIssue: HardLogicIssue | null = useMemo(() => {
    return (
      filteredIssues.find((i) => i.id === selectedId) || filteredIssues[0] || null
    );
  }, [filteredIssues, selectedId]);

  return (
    <div className="space-y-6">
      {/* Executive Summary & 4-Column Hairline KPI Grid */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="px-6 py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              {report.workflowTitle}
            </h1>
            <span className="text-xs text-slate-500 tabular-nums">
              已审文件 {report.analyzedFileCount} 份 · {report.generatedAt}
            </span>
          </div>
          <p className="mt-2.5 max-w-4xl text-sm leading-relaxed text-slate-700">
            {report.executiveSummary}
          </p>
        </div>

        <div className="grid grid-cols-2 border-t border-slate-200 lg:grid-cols-4">
          <div className="border-b border-r border-slate-200 px-5 py-4 lg:border-b-0 lg:px-6">
            <p className="text-xs text-slate-500">硬逻辑缺陷总数</p>
            <p className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums lg:text-2xl">
              {metrics.totalIssues}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              严重阻塞 {metrics.criticalCount} · 高危 {metrics.highCount}
            </p>
          </div>
          <div className="border-b border-slate-200 px-5 py-4 lg:border-b-0 lg:border-r lg:px-6">
            <p className="text-xs text-slate-500">文脚对齐匹配率</p>
            <p className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums lg:text-2xl">
              {metrics.alignmentPassRate}%
            </p>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              存在偏差 {metrics.mismatchedAlignments} / {metrics.totalAlignments} 项
            </p>
          </div>
          <div className="border-r border-slate-200 px-5 py-4 lg:px-6">
            <p className="text-xs text-slate-500">客观化三层拆分</p>
            <p className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums whitespace-nowrap lg:text-2xl">
              {metrics.deterministicCount} / {metrics.guardrailedCount} / {metrics.humanGateCount}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">纯代码 / 弱AI护栏 / 人工门控</p>
          </div>
          <div className="px-5 py-4 lg:px-6">
            <p className="text-xs text-slate-500">工作流阶段重构</p>
            <p className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums whitespace-nowrap lg:text-2xl">
              {metrics.legacyStepCount} → {metrics.refactoredStepCount}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">非破坏性统一坐标管线</p>
          </div>
        </div>
      </section>

      {/* Master-Detail Issue Inspector */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
            {(['all', 'critical', 'high', 'medium'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                onClick={() => setSeverityFilter(sev)}
                className={`rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  severityFilter === sev
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sev === 'all'
                  ? `全部 (${report.hardLogicIssues.length})`
                  : SEVERITY_CONFIG[sev].label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选步骤、文件或根因关键词…"
              aria-label="筛选硬逻辑缺陷"
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-12 lg:divide-x lg:divide-y-0">
          {/* Left Issue List */}
          <div className="divide-y divide-slate-100 lg:col-span-5">
            {filteredIssues.length === 0 ? (
              <div className="px-6 py-12 text-center text-xs text-slate-500">
                当前筛选条件下无匹配缺陷。
              </div>
            ) : (
              filteredIssues.map((issue) => {
                const sev = SEVERITY_CONFIG[issue.severity] || SEVERITY_CONFIG.medium;
                const SevIcon = sev.Icon;
                const isSelected = activeIssue?.id === issue.id;
                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setSelectedId(issue.id)}
                    className={`block w-full px-6 py-4 text-left transition-colors ${
                      isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <SevIcon className={`h-3.5 w-3.5 shrink-0 ${sev.textClass}`} />
                      <span className={`font-medium ${sev.textClass}`}>{sev.label}</span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className="font-mono text-slate-500 tabular-nums">{issue.id}</span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className="truncate text-slate-500">{issue.stepRef}</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium leading-snug text-slate-900">
                      {issue.title}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {issue.category} · {issue.fileRefs.join(' / ')}
                    </p>
                  </button>
                );
              })
            )}
          </div>

          {/* Right Issue Detail Inspector */}
          <div className="px-6 py-6 lg:col-span-7">
            {activeIssue ? (
              <div className="space-y-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {activeIssue.id}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{activeIssue.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>涉及步骤：{activeIssue.stepRef}</span>
                  </div>
                  <h2 className="mt-1.5 text-lg font-semibold text-slate-900">
                    {activeIssue.title}
                  </h2>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    来源文件：{activeIssue.fileRefs.join(' · ') || '工作流全局'}
                  </p>
                </div>

                <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-medium text-slate-500">原文 / 脚本证据</p>
                  <p className="mt-1 font-mono text-xs leading-relaxed text-slate-800">
                    {activeIssue.evidenceQuote}
                  </p>
                </div>

                <div className="space-y-4 border-t border-slate-200 pt-4 text-sm">
                  <div>
                    <h3 className="text-xs font-semibold text-slate-900">硬逻辑根因</h3>
                    <p className="mt-1 leading-relaxed text-slate-700">{activeIssue.rootCause}</p>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-slate-900">实操与下游后果</h3>
                    <p className="mt-1 leading-relaxed text-slate-700">{activeIssue.impact}</p>
                  </div>
                  <div className="border-t border-slate-200 pt-4">
                    <h3 className="text-xs font-semibold text-blue-800">推荐重构解法</h3>
                    <p className="mt-1 leading-relaxed text-slate-900">
                      {activeIssue.fixStrategy}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="py-12 text-center text-xs text-slate-500">
                请在左侧选择一条缺陷查看详细诊断。
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
