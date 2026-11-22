import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  FileCode2,
  FileJson,
  FileText,
  FolderOpen,
  FolderSync,
  Loader2,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { StaticPrecheckFinding, WorkflowFile, WorkflowFileKind } from '../types/workflow';
import { classifyWorkflowFile, type DriveErrorDiagnosis } from '../utils/workflowAnalyzer';
import type { DriveFolderSummary } from '../services/driveClient';

interface SourcesWorkspaceProps {
  folderUrl: string;
  onFolderUrlChange: (val: string) => void;
  folderUrlError: string | null;
  folderName: string;
  userEmail: string | null;
  hasDriveToken: boolean;
  isLoggingIn: boolean;
  isLoadingDrive: boolean;
  driveProgress: string;
  driveError: string | null;
  driveDiagnosis: DriveErrorDiagnosis | null;
  accessibleFolders: DriveFolderSummary[];
  isBrowsingFolders: boolean;
  files: WorkflowFile[];
  staticFindings: StaticPrecheckFinding[];
  userContext: string;
  onUserContextChange: (val: string) => void;
  isAnalyzing: boolean;
  analyzeError: string | null;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  onLoadDriveFolder: () => void;
  onBrowseDriveFolders: () => void;
  onSelectBrowsedFolder: (folder: DriveFolderSummary) => void;
  onToggleFileSelect: (id: string) => void;
  onToggleAllFiles: (selected: boolean) => void;
  onAddManualFile: (file: WorkflowFile) => void;
  onRemoveFile: (id: string) => void;
  onResetSample: () => void;
  onRunAnalysis: () => void;
}

const KIND_LABELS: Record<WorkflowFileKind, string> = {
  prose: '文字/规范',
  script: '自动化脚本',
  config: '配置/参数',
  other: '媒体/其他',
};

export const SourcesWorkspace: React.FC<SourcesWorkspaceProps> = ({
  folderUrl,
  onFolderUrlChange,
  folderUrlError,
  folderName,
  userEmail,
  hasDriveToken,
  isLoggingIn,
  isLoadingDrive,
  driveProgress,
  driveError,
  driveDiagnosis,
  accessibleFolders,
  isBrowsingFolders,
  files,
  staticFindings,
  userContext,
  onUserContextChange,
  isAnalyzing,
  analyzeError,
  onGoogleLogin,
  onGoogleLogout,
  onLoadDriveFolder,
  onBrowseDriveFolders,
  onSelectBrowsedFolder,
  onToggleFileSelect,
  onToggleAllFiles,
  onAddManualFile,
  onRemoveFile,
  onResetSample,
  onRunAnalysis,
}) => {
  const [activeFileId, setActiveFileId] = useState<string>(files[0]?.id || '');
  const [kindFilter, setKindFilter] = useState<'all' | WorkflowFileKind>('all');
  const [showPastePanel, setShowPastePanel] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  const selectedFile = useMemo(() => {
    return files.find((f) => f.id === activeFileId) || files[0] || null;
  }, [files, activeFileId]);

  const filteredFiles = useMemo(() => {
    if (kindFilter === 'all') return files;
    return files.filter((f) => f.kind === kindFilter);
  }, [files, kindFilter]);

  const selectedCount = useMemo(
    () => files.filter((f) => f.selected && f.content.trim().length > 0).length,
    [files]
  );

  const proseCount = files.filter((f) => f.kind === 'prose').length;
  const scriptCount = files.filter((f) => f.kind === 'script' || f.kind === 'config').length;

  const handleLocalUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    for (const file of Array.from(fileList)) {
      const text = await file.text();
      const kind = classifyWorkflowFile(file.name, file.type);
      const newFile: WorkflowFile = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        path: file.name,
        mimeType: file.type || 'text/plain',
        kind: kind === 'other' ? 'prose' : kind,
        content: text,
        sizeBytes: file.size,
        modifiedTime: new Date(file.lastModified).toISOString(),
        selected: text.trim().length > 0,
        source: 'local',
      };
      onAddManualFile(newFile);
      setActiveFileId(newFile.id);
    }
    e.target.value = '';
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = pasteName.trim();
    const cleanContent = pasteContent.trim();
    if (!cleanName) {
      setPasteError('请填写文件名（如 sop.md 或 cut_step.py）。');
      return;
    }
    if (!cleanContent) {
      setPasteError('请粘贴文档或脚本内容。');
      return;
    }
    const kind = classifyWorkflowFile(cleanName, 'text/plain');
    const newFile: WorkflowFile = {
      id: `paste-${Date.now()}`,
      name: cleanName,
      path: cleanName,
      mimeType: 'text/plain',
      kind: kind === 'other' ? 'prose' : kind,
      content: cleanContent,
      sizeBytes: cleanContent.length,
      modifiedTime: new Date().toISOString(),
      selected: true,
      source: 'local',
    };
    onAddManualFile(newFile);
    setActiveFileId(newFile.id);
    setPasteName('');
    setPasteContent('');
    setPasteError(null);
    setShowPastePanel(false);
  };

  const renderKindIcon = (kind: WorkflowFileKind) => {
    if (kind === 'script') return <FileCode2 className="h-4 w-4 text-blue-700 shrink-0" aria-hidden="true" />;
    if (kind === 'config') return <FileJson className="h-4 w-4 text-amber-700 shrink-0" aria-hidden="true" />;
    return <FileText className="h-4 w-4 text-slate-600 shrink-0" aria-hidden="true" />;
  };

  return (
    <div className="space-y-6">
      {/* Drive Folder Connector Bar */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Google Drive 工作流数据源
            </h1>
            <p className="text-sm text-slate-600">
              授权后递归读取目标文件夹中的文字规范、口述草稿、自动化脚本与配置文件，再进入四维逻辑审计与重构。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {hasDriveToken && userEmail ? (
              <div className="flex items-center gap-3 text-xs text-slate-600">
                <span>已连接：{userEmail}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onGoogleLogout}
                  className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-slate-950 whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  断开连接
                </button>
              </div>
            ) : (
              <span className="text-xs text-slate-500">
                当前未连接 Google Drive · 示例数据可先预览
              </span>
            )}
          </div>
        </div>

        <div className="mt-5 border-t border-slate-200 pt-5">
          <label
            htmlFor="drive-folder-url"
            className="mb-1.5 block text-xs font-medium text-slate-700"
          >
            目标 Google Drive 文件夹链接或 ID
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="drive-folder-url"
              type="text"
              value={folderUrl}
              onChange={(e) => onFolderUrlChange(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/..."
              className="flex-1 rounded-md border border-slate-300 bg-white px-3.5 py-2 font-mono text-xs text-slate-900 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15"
            />
            <button
              type="button"
              onClick={onLoadDriveFolder}
              disabled={isLoadingDrive}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {isLoadingDrive ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FolderSync className="h-3.5 w-3.5 text-blue-700" aria-hidden="true" />
              )}
              {isLoadingDrive
                ? '正在拉取目录…'
                : hasDriveToken
                  ? '同步拉取 Drive 文件'
                  : '登录并拉取 Drive 文件'}
            </button>
            {hasDriveToken && (
              <button
                type="button"
                onClick={onBrowseDriveFolders}
                disabled={isBrowsingFolders || isLoadingDrive}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {isBrowsingFolders ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
                )}
                浏览我的文件夹
              </button>
            )}
          </div>

          {folderUrlError && (
            <p className="mt-2 text-xs font-medium text-red-700" role="alert">
              {folderUrlError}
            </p>
          )}
          {driveProgress && isLoadingDrive && (
            <p className="mt-2 text-xs text-blue-700">{driveProgress}</p>
          )}
          {driveError && (
            <div
              role="alert"
              className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-xs text-red-900"
            >
              <p className="font-semibold text-red-800">
                {driveDiagnosis?.title || 'Google Drive 读取失败'}
              </p>
              <p className="mt-1 leading-relaxed text-red-800/90">
                {driveDiagnosis?.detail || driveError}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={onGoogleLogin}
                  disabled={isLoggingIn}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  {isLoggingIn ? '正在打开授权…' : '重新授权并勾选 Drive 权限'}
                </button>
                <button
                  type="button"
                  onClick={onBrowseDriveFolders}
                  disabled={isBrowsingFolders}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
                >
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                  浏览我可访问的文件夹
                </button>
              </div>
            </div>
          )}

          {accessibleFolders.length > 0 && (
            <div className="mt-4 border-t border-slate-200 pt-4">
              <p className="text-xs font-semibold text-slate-900">
                选择您账号下可访问的 Google Drive 文件夹（共 {accessibleFolders.length} 个最近目录）
              </p>
              <div className="mt-2 grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {accessibleFolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onSelectBrowsedFolder(folder)}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2 text-left text-xs text-slate-800 hover:border-blue-400 hover:bg-blue-50/50"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-700" aria-hidden="true" />
                      <span className="truncate font-medium">{folder.name}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      {folder.shared ? '已共享' : '我的云端硬盘'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Main Split: File Inventory (Left) + Content Inspector & Analysis Trigger (Right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left File List */}
        <section className="flex flex-col rounded-lg border border-slate-200 bg-white lg:col-span-5">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-900">
                文件清单 · {folderName}
              </h2>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 tabular-nums">
                <span>已选 {selectedCount}/{files.length}</span>
                <span aria-hidden="true">·</span>
                <span>文字 {proseCount}</span>
                <span aria-hidden="true">·</span>
                <span>脚本与配置 {scriptCount}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap">
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                上传
                <input
                  type="file"
                  multiple
                  accept=".md,.txt,.py,.js,.ts,.tsx,.jsx,.json,.yaml,.yml,.sh,.edl,.xml,.fcpxml,.csv"
                  onChange={handleLocalUpload}
                  className="sr-only"
                />
              </label>
              <button
                type="button"
                onClick={() => setShowPastePanel((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                粘贴
              </button>
            </div>
          </div>

          {showPastePanel && (
            <form
              onSubmit={handlePasteSubmit}
              className="space-y-3 border-b border-slate-200 bg-slate-50 px-5 py-4"
            >
              <div>
                <label
                  htmlFor="paste-file-name"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  文件名（通过后缀自动区分文字或脚本）
                </label>
                <input
                  id="paste-file-name"
                  type="text"
                  value={pasteName}
                  onChange={(e) => setPasteName(e.target.value)}
                  placeholder="例如：my_cut_rules.md 或 auto_edit.py"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900"
                />
              </div>
              <div>
                <label
                  htmlFor="paste-file-content"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  内容
                </label>
                <textarea
                  id="paste-file-content"
                  rows={4}
                  value={pasteContent}
                  onChange={(e) => setPasteContent(e.target.value)}
                  placeholder="粘贴您的工作流口述文字、Prompt 或脚本文本…"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                />
              </div>
              {pasteError && (
                <p className="text-xs font-medium text-red-700" role="alert">
                  {pasteError}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowPastePanel(false);
                    setPasteError(null);
                  }}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                >
                  添加到工作区
                </button>
              </div>
            </form>
          )}

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-2.5">
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-0.5">
              {(['all', 'prose', 'script', 'config'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    kindFilter === k
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {k === 'all' ? '全部' : KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <button
                type="button"
                onClick={() => onToggleAllFiles(true)}
                className="hover:text-slate-900 whitespace-nowrap"
              >
                全选
              </button>
              <button
                type="button"
                onClick={onResetSample}
                className="inline-flex items-center gap-1 hover:text-slate-900 whitespace-nowrap"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                示例
              </button>
            </div>
          </div>

          {/* File Rows */}
          <div className="max-h-[460px] divide-y divide-slate-100 overflow-y-auto">
            {filteredFiles.length === 0 ? (
              <div className="px-5 py-10 text-center text-xs text-slate-500">
                当前筛选下暂无文件，可切换「全部」或从 Google Drive 同步。
              </div>
            ) : (
              filteredFiles.map((file) => {
                const isActive = selectedFile?.id === file.id;
                const hasContent = file.content.trim().length > 0;
                return (
                  <div
                    key={file.id}
                    className={`flex items-center gap-3 px-5 py-3 transition-colors ${
                      isActive ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={file.selected}
                      disabled={!hasContent}
                      onChange={() => onToggleFileSelect(file.id)}
                      aria-label={`选择文件 ${file.name}`}
                      className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                    />
                    <button
                      type="button"
                      onClick={() => setActiveFileId(file.id)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <span className="mt-0.5">{renderKindIcon(file.kind)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-slate-900">
                          {file.path || file.name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
                          <span>{KIND_LABELS[file.kind]}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {hasContent
                              ? `${file.content.length.toLocaleString()} 字符`
                              : '无可读文本'}
                          </span>
                          {file.source === 'sample' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>示例</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                    {file.source === 'local' && (
                      <button
                        type="button"
                        onClick={() => onRemoveFile(file.id)}
                        aria-label={`移除文件 ${file.name}`}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Preview & Run AI Audit */}
        <section className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white lg:col-span-7">
          <div>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-slate-900">
                  {selectedFile ? selectedFile.path || selectedFile.name : '文件预览'}
                </h2>
                {selectedFile && (
                  <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                    {KIND_LABELS[selectedFile.kind]} · {selectedFile.mimeType} ·{' '}
                    {selectedFile.content.length.toLocaleString()} 字符
                  </p>
                )}
              </div>
            </div>

            {selectedFile?.readWarning && (
              <div className="border-b border-amber-200 bg-amber-50/70 px-5 py-2.5 text-xs text-amber-800">
                提示：{selectedFile.readWarning}
              </div>
            )}

            <div className="max-h-[300px] overflow-auto bg-[#F8FAFC] px-5 py-4">
              {selectedFile && selectedFile.content ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                  {selectedFile.content}
                </pre>
              ) : (
                <p className="py-8 text-center text-xs text-slate-500">
                  请选择一个文本、Markdown、脚本或配置文件以预览内容。
                </p>
              )}
            </div>

            {/* Static Deterministic Pre-Check */}
            {staticFindings.length > 0 && (
              <div className="border-t border-slate-200 px-5 py-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  <span>本地静态逻辑预检（发现 {staticFindings.length} 项结构风险）</span>
                </div>
                <ul className="mt-2.5 space-y-2">
                  {staticFindings.slice(0, 4).map((finding) => (
                    <li
                      key={finding.id}
                      className="text-xs leading-relaxed text-slate-600"
                    >
                      <span
                        className={`font-medium ${
                          finding.severity === 'critical'
                            ? 'text-red-700'
                            : finding.severity === 'high'
                              ? 'text-amber-700'
                              : 'text-slate-700'
                        }`}
                      >
                        [{finding.severity === 'critical' ? '严重' : finding.severity === 'high' ? '高危' : '提示'}]
                      </span>{' '}
                      <span className="font-mono text-slate-800">{finding.fileName}</span>：
                      {finding.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Analysis Trigger Footer */}
          <div className="space-y-4 border-t border-slate-200 bg-white px-5 py-5">
            <div>
              <label
                htmlFor="audit-user-context"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                补充约束与痛点（随文件一并提交给审计引擎）
              </label>
              <textarea
                id="audit-user-context"
                rows={2}
                value={userContext}
                onChange={(e) => onUserContextChange(e.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs leading-relaxed text-slate-800 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/15"
              />
            </div>

            {analyzeError && (
              <p className="text-xs font-medium text-red-700" role="alert">
                {analyzeError}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500 tabular-nums">
                将对已勾选的 <strong className="font-semibold text-slate-900">{selectedCount}</strong>{' '}
                份文件执行硬逻辑诊断、文脚对齐与弱 AI 重构
              </p>
              <button
                type="button"
                onClick={onRunAnalysis}
                disabled={isAnalyzing || selectedCount === 0}
                className="inline-flex items-center gap-2 rounded-md bg-blue-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {isAnalyzing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {isAnalyzing ? '正在深度分析工作流逻辑…' : '运行深度逻辑分析与重构'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
