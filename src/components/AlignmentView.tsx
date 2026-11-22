import React, { useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  GitCompareArrows,
  XCircle,
} from 'lucide-react';
import type {
  AlignmentStatus,
  TextScriptAlignmentItem,
  WorkflowAuditReport,
} from '../types/workflow';
import { ALIGNMENT_STATUS_META } from '../utils/workflowAnalyzer';

interface AlignmentViewProps {
  report: WorkflowAuditReport;
}

const STATUS_ICONS: Record<AlignmentStatus, React.FC<{ className?: string }>> = {
  matched: CheckCircle2,
  drifted: GitCompareArrows,
  missing_in_script: XCircle,
  inverted: AlertOctagon,
  hardcoded_override: AlertTriangle,
};

export const AlignmentView: React.FC<AlignmentViewProps> = ({ report }) => {
  const [statusFilter, setStatusFilter] = useState<'all' | AlignmentStatus>('all');
  const [selectedId, setSelectedId] = useState<string>(report.alignments[0]?.id || '');

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return report.alignments;
    return report.alignments.filter((a) => a.status === statusFilter);
  }, [report.alignments, statusFilter]);

  const activeItem: TextScriptAlignmentItem | null = useMemo(() => {
    return filtered.find((a) => a.id === selectedId) || filtered[0] || null;
  }, [filtered, selectedId]);

  const filterButtons: Array<{ key: 'all' | AlignmentStatus; label: string }> = [
    { key: 'all', label: `全部规则 (${report.alignments.length})` },
    { key: 'inverted', label: '逻辑倒置' },
    { key: 'missing_in_script', label: '脚本缺失' },
    { key: 'hardcoded_override', label: '硬编码覆盖' },
    { key: 'drifted', label: '语义漂移' },
    { key: 'matched', label: '完全匹配' },
  ];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              文字逻辑与脚本逻辑对齐审计
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              逐项比对您口述或文档中定义的剪辑原则与自动化脚本的实际执行行为，定位顺序倒置、硬编码篡改和未落地环节。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
            {filterButtons.map((btn) => (
              <button
                key={btn.key}
                type="button"
                onClick={() => setStatusFilter(btn.key)}
                className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  statusFilter === btn.key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* High-Density Alignment Matrix Table */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-5 py-3 font-semibold whitespace-nowrap">规则项</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">文字/口述来源</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">脚本/配置来源</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">匹配结论</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-slate-500">
                    该状态下暂无对齐记录。
                  </td>
                </tr>
              ) : (
                filtered.map((item) => {
                  const meta = ALIGNMENT_STATUS_META[item.status] || {
                    label: item.status,
                    toneClass: 'text-slate-700',
                  };
                  const StatusIcon = STATUS_ICONS[item.status] || GitCompareArrows;
                  const isActive = activeItem?.id === item.id;
                  return (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`cursor-pointer transition-colors ${
                        isActive ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-5 py-3.5 font-medium text-slate-900">
                        <span className="mr-2 font-mono text-slate-400 tabular-nums">
                          {item.id}
                        </span>
                        {item.ruleName}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-slate-600">
                        {item.proseSource}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-slate-600">
                        {item.scriptSource}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 font-medium ${meta.toneClass}`}>
                          <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Side-by-Side Comparison Inspector */}
      {activeItem && (
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">
              {activeItem.id} · {activeItem.ruleName}
            </h2>
            <span
              className={`text-xs font-semibold ${
                ALIGNMENT_STATUS_META[activeItem.status]?.toneClass || 'text-slate-700'
              }`}
            >
              状态：{ALIGNMENT_STATUS_META[activeItem.status]?.label || activeItem.status}
            </span>
          </div>

          <div className="grid grid-cols-1 divide-y divide-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="px-6 py-5">
              <p className="text-xs font-medium text-slate-500">
                文字规定 · <span className="font-mono text-slate-700">{activeItem.proseSource}</span>
              </p>
              <p className="mt-2.5 text-sm leading-relaxed text-slate-900">
                {activeItem.proseRule}
              </p>
            </div>
            <div className="bg-[#F8FAFC] px-6 py-5">
              <p className="text-xs font-medium text-slate-500">
                脚本实际行为 · <span className="font-mono text-slate-700">{activeItem.scriptSource}</span>
              </p>
              <p className="mt-2.5 font-mono text-xs leading-relaxed text-slate-800">
                {activeItem.scriptBehavior}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 border-t border-slate-200 px-6 py-5 md:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-900">偏差深度解析</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                {activeItem.discrepancyDetail}
              </p>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-blue-800">对齐修正方案</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-900">
                {activeItem.recommendation}
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
