import React from 'react';
import { HardDriveUpload, X } from 'lucide-react';

interface DriveConfirmModalProps {
  open: boolean;
  mode: 'single' | 'bundle';
  targetName: string;
  contentPreviewChars: number;
  bundleFilePaths?: string[];
  isSaving: boolean;
  onTargetNameChange: (name: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export const DriveConfirmModal: React.FC<DriveConfirmModalProps> = ({
  open,
  mode,
  targetName,
  contentPreviewChars,
  bundleFilePaths = [],
  isSaving,
  onTargetNameChange,
  onCancel,
  onConfirm,
}) => {
  if (!open) return null;

  const isBundle = mode === 'bundle';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-save-dialog-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <HardDriveUpload className="h-4 w-4 text-blue-700" aria-hidden="true" />
            <h2
              id="drive-save-dialog-title"
              className="text-base font-semibold text-slate-900"
            >
              {isBundle ? '确认在 Google Drive 创建重构工作流目录' : '确认保存到 Google Drive'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            aria-label="关闭确认窗口"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5 text-sm text-slate-600">
          <p className="leading-relaxed">
            {isBundle
              ? `此操作将在您的 Google Drive 中新建 1 个目录，并写入以下 ${bundleFilePaths.length} 个可直接使用的工作流文件，不会修改或删除您原始文件夹中的现有文件。`
              : '此操作将在您的 Google Drive 中创建一个新的 Markdown 重构方案文件，不会修改或覆盖您原始文件夹中的任何现有文档。'}
          </p>

          <div>
            <label
              htmlFor="drive-export-filename"
              className="mb-1.5 block text-xs font-medium text-slate-700"
            >
              {isBundle ? '新建文件夹名称' : '新建文件名'}
            </label>
            <input
              id="drive-export-filename"
              type="text"
              value={targetName}
              onChange={(e) => onTargetNameChange(e.target.value)}
              disabled={isSaving}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15"
            />
          </div>

          {isBundle && bundleFilePaths.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-700">即将创建的文件清单：</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 font-mono text-[11px] text-slate-700">
                {bundleFilePaths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
            <span>{isBundle ? '类型：新建文件夹 + 多文件' : '格式：text/markdown'}</span>
            <span aria-hidden="true">·</span>
            <span>预计大小：{contentPreviewChars.toLocaleString()} 字符</span>
            <span aria-hidden="true">·</span>
            <span>影响新建数：{isBundle ? `${bundleFilePaths.length} 个文件` : '1 个文件'}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSaving || !targetName.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isSaving ? '正在写入 Google Drive…' : '确认创建并保存'}
          </button>
        </div>
      </div>
    </div>
  );
};
