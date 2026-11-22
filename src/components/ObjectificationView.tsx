import React, { useMemo, useState } from 'react';
import { Cpu, ShieldAlert, SlidersHorizontal, UserCheck } from 'lucide-react';
import type { ObjectificationTier, WorkflowAuditReport } from '../types/workflow';

interface ObjectificationViewProps {
  report: WorkflowAuditReport;
}

const VERDICT_LABELS: Record<WorkflowAuditReport['feasibilityVerdict'], string> = {
  feasible_with_architecture: '路线可行 · 需分层重构以适配弱自动化 AI',
  partially_feasible: '部分可行 · 仅建议客观化确定性工程环节',
  needs_redesign: '需重新定义边界 · 原全自动假设冲突过多',
};

const TIER_META: Record<
  ObjectificationTier,
  {
    label: string;
    shortLabel: string;
    toneClass: string;
    Icon: React.FC<{ className?: string }>;
  }
> = {
  deterministic: {
    label: '第一层：完全客观化（纯确定性代码规则）',
    shortLabel: '完全客观化',
    toneClass: 'text-emerald-700',
    Icon: SlidersHorizontal,
  },
  probabilistic_guardrailed: {
    label: '第二层：半客观化（弱 AI 初筛 + 置信度护栏）',
    shortLabel: '弱 AI + 护栏',
    toneClass: 'text-blue-700',
    Icon: Cpu,
  },
  human_gate: {
    label: '第三层：保留主观决策（轻量人工复核门控）',
    shortLabel: '人工门控',
    toneClass: 'text-amber-700',
    Icon: UserCheck,
  },
};

export const ObjectificationView: React.FC<ObjectificationViewProps> = ({ report }) => {
  const [tierFilter, setTierFilter] = useState<'all' | ObjectificationTier>('all');

  const filteredMatrix = useMemo(() => {
    if (tierFilter === 'all') return report.objectificationMatrix;
    return report.objectificationMatrix.filter((m) => m.tier === tierFilter);
  }, [report.objectificationMatrix, tierFilter]);

  return (
    <div className="space-y-6">
      {/* Feasibility Verdict & Weak AI Principles */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="px-6 py-5">
          <p className="text-xs font-semibold text-blue-800">
            “剪辑客观化”可行性评估结论 · {VERDICT_LABELS[report.feasibilityVerdict]}
          </p>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-slate-900">
            剪辑客观化三层边界与弱 AI 约束治理
          </h1>
          <p className="mt-2.5 max-w-4xl text-sm leading-relaxed text-slate-700">
            {report.feasibilityConclusion}
          </p>
        </div>

        <div className="border-t border-slate-200 bg-slate-50/70 px-6 py-5">
          <h2 className="text-xs font-semibold text-slate-900">
            面向弱自动化 AI 的四项架构约束原则
          </h2>
          <ol className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {report.weakAiPrinciples.map((principle, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2.5 text-xs leading-relaxed text-slate-700"
              >
                <span className="font-mono font-semibold text-blue-700 tabular-nums">
                  0{idx + 1}.
                </span>
                <span>{principle}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 3-Tier Objectification Spectrum */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            剪辑动作客观化分层矩阵
          </h2>
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
            {(['all', 'deterministic', 'probabilistic_guardrailed', 'human_gate'] as const).map(
              (t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTierFilter(t)}
                  className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    tierFilter === t
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t === 'all' ? '全部层级' : TIER_META[t].shortLabel}
                </button>
              )
            )}
          </div>
        </div>

        <div className="divide-y divide-slate-200">
          {filteredMatrix.map((item) => {
            const meta = TIER_META[item.tier];
            const TierIcon = meta.Icon;
            return (
              <article key={item.id} className="px-6 py-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-900">
                    <span className="mr-2 font-mono text-xs text-slate-400 tabular-nums">
                      {item.id}
                    </span>
                    {item.editingTask}
                  </h3>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.toneClass}`}>
                    <TierIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {meta.label}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 text-xs leading-relaxed md:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <p className="font-semibold text-slate-500">原工作流假设</p>
                    <p className="mt-1 text-slate-800">{item.currentAssumption}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-red-700">实操边界失效原因</p>
                    <p className="mt-1 text-slate-700">{item.whyBoundaryFails}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-amber-700">弱 AI 执行风险</p>
                    <p className="mt-1 text-slate-700">{item.weakAiRisk}</p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 text-xs leading-relaxed md:grid-cols-2">
                  <div>
                    <p className="font-semibold text-blue-800">重构推荐机制</p>
                    <p className="mt-1 text-slate-900">{item.recommendedMechanism}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700">失败兜底与保守降级</p>
                    <p className="mt-1 text-slate-700">{item.fallbackRule}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Operational Edge-Case Catalog */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-6 py-4">
          <ShieldAlert className="h-4 w-4 text-amber-700 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-900">
            高频实操边界清单与工程护栏（{report.edgeCases.length} 项）
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-5 py-3 font-semibold whitespace-nowrap">边界场景</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">触发条件</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">当前失效表现</th>
                <th className="px-5 py-3 font-semibold whitespace-nowrap">工程护栏解法</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {report.edgeCases.map((ec) => (
                <tr key={ec.id} className="hover:bg-slate-50/70">
                  <td className="px-5 py-4 font-medium text-slate-900">
                    <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {ec.id} · {ec.affectedStage}
                    </div>
                    <div className="mt-0.5">{ec.scenario}</div>
                  </td>
                  <td className="px-5 py-4 text-slate-600">{ec.triggerCondition}</td>
                  <td className="px-5 py-4 text-red-700/90">{ec.currentFailureMode}</td>
                  <td className="px-5 py-4 font-medium text-slate-900">{ec.guardrailSolution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
