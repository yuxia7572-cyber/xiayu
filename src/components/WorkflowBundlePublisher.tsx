import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderUp,
  GitBranch,
  HardDriveUpload,
  Loader2,
  LogOut,
  Package,
} from 'lucide-react';
import type { WorkflowAuditReport, WorkflowFile } from '../types/workflow';

export interface GeneratedBundleFile {
  path: string;
  description: string;
  content: string;
}

export interface GeneratedWorkflowBundle {
  versionTag: string;
  releaseNotes: string;
  files: GeneratedBundleFile[];
  generatedAt: string;
}

interface GithubUser {
  login: string;
  avatar_url: string;
  html_url: string;
  name?: string;
}

interface GithubRepo {
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
}

interface WorkflowBundlePublisherProps {
  report: WorkflowAuditReport;
  files: WorkflowFile[];
  hasDriveToken: boolean;
  onRequestDriveBundleSave: (
    folderName: string,
    bundleFiles: Array<{ path: string; content: string }>
  ) => void;
}

export const WorkflowBundlePublisher: React.FC<WorkflowBundlePublisherProps> = ({
  report,
  files,
  hasDriveToken,
  onRequestDriveBundleSave,
}) => {
  const [bundle, setBundle] = useState<GeneratedWorkflowBundle | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // GitHub OAuth & Publish state
  const [ghStatus, setGhStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    user: GithubUser | null;
    callbackUrl: string;
  } | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [selectedRepoFull, setSelectedRepoFull] = useState('');
  const [branch, setBranch] = useState('main');
  const [basePath, setBasePath] = useState('cutlogic-workflow-v2');
  const [commitMessage, setCommitMessage] = useState(
    'chore(workflow): upload refactored editing workflow v2'
  );
  const [showGhConfirm, setShowGhConfirm] = useState(false);
  const [isPublishingGh, setIsPublishingGh] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghSuccessUrl, setGhSuccessUrl] = useState<string | null>(null);

  const fetchGithubStatus = async () => {
    try {
      const res = await fetch('/api/github/status', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setGhStatus(data);
      if (data.authenticated) {
        loadGithubRepos();
      }
    } catch {
      // Ignore network error on background status check
    }
  };

  const loadGithubRepos = async () => {
    setIsLoadingRepos(true);
    setGhError(null);
    try {
      const res = await fetch('/api/github/repos', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '无法加载 GitHub 仓库列表。');
      }
      const list: GithubRepo[] = data.repos || [];
      setRepos(list);
      if (list.length > 0 && !selectedRepoFull) {
        setSelectedRepoFull(list[0].fullName);
        setBranch(list[0].defaultBranch || 'main');
      }
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '读取仓库失败。');
    } finally {
      setIsLoadingRepos(false);
    }
  };

  useEffect(() => {
    fetchGithubStatus();

    const onMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'GITHUB_OAUTH_SUCCESS') {
        fetchGithubStatus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleGenerateBundle = async () => {
    setIsGenerating(true);
    setGenError(null);
    setGhSuccessUrl(null);
    try {
      const selectedFiles = files
        .filter((f) => f.selected && f.content.trim().length > 0)
        .map((f) => ({ name: f.name, path: f.path, kind: f.kind, content: f.content }));

      const res = await fetch('/api/generate-workflow-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report,
          files: selectedFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '生成完整可用工作流版本包失败。');
      }
      const generated = data as GeneratedWorkflowBundle;
      setBundle(generated);
      setActiveFilePath(generated.files[0]?.path || '');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : '生成版本包时发生异常。');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConnectGithub = async () => {
    setGhError(null);
    try {
      const res = await fetch('/api/github/auth-url', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(
          data.error || 'GitHub OAuth 尚未配置，请先在环境变量中设置 GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET。'
        );
      }
      const popup = window.open(data.url, 'github_oauth_popup', 'width=640,height=720');
      if (!popup) {
        setGhError('浏览器拦截了授权弹窗，请允许弹窗后重试。');
      }
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '无法打开 GitHub 授权窗口。');
    }
  };

  const handleDisconnectGithub = async () => {
    await fetch('/api/github/logout', { method: 'POST', credentials: 'include' });
    setRepos([]);
    setSelectedRepoFull('');
    setShowGhConfirm(false);
    setGhSuccessUrl(null);
    fetchGithubStatus();
  };

  const handleConfirmGithubPublish = async () => {
    if (!bundle || !selectedRepoFull) return;
    const [owner, repo] = selectedRepoFull.split('/');
    if (!owner || !repo) {
      setGhError('目标仓库格式无效，请选择有效仓库。');
      return;
    }
    setIsPublishingGh(true);
    setGhError(null);
    setGhSuccessUrl(null);
    try {
      const res = await fetch('/api/github/publish', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner,
          repo,
          branch,
          basePath,
          commitMessage,
          files: bundle.files.map((f) => ({ path: f.path, content: f.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '推送到 GitHub 失败。');
      }
      setGhSuccessUrl(data.repoUrl);
      setShowGhConfirm(false);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '推送工作流文件到 GitHub 失败。');
    } finally {
      setIsPublishingGh(false);
    }
  };

  const handleDownloadSingle = (file: GeneratedBundleFile) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.path.split('/').pop() || 'workflow_file.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadBundleJson = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cutlogic_workflow_bundle_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleCopyFile = async (file: GeneratedBundleFile) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedPath(file.path);
      setTimeout(() => setCopiedPath(null), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const activeFile =
    bundle?.files.find((f) => f.path === activeFilePath) || bundle?.files[0] || null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-blue-700 shrink-0" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900">
              直接可用的重构工作流版本包（生成 & 一键上传）
            </h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            一键生成成套可落地文件（README 规范、统一配置 JSON、弱 AI 原子 Prompt 套件、Python 校验编排脚本），生成后可直接提交至 GitHub 仓库或打包保存到 Google Drive 新文件夹。
          </p>
        </div>

        <button
          type="button"
          onClick={handleGenerateBundle}
          disabled={isGenerating}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Package className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isGenerating
            ? '正在组装 4 份可执行文件…'
            : bundle
              ? '重新生成完整版本包'
              : '一键生成完整可用版本包'}
        </button>
      </div>

      {genError && (
        <div className="border-b border-slate-200 bg-red-50/60 px-6 py-3 text-xs font-medium text-red-700" role="alert">
          {genError}
        </div>
      )}

      {bundle && (
        <div>
          {/* Release Notes & Bundle Actions */}
          <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="text-xs text-slate-700">
              <span className="font-mono font-semibold text-slate-900">{bundle.versionTag}</span>
              <span className="mx-2 text-slate-300" aria-hidden="true">·</span>
              <span>{bundle.releaseNotes}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDownloadBundleJson}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                下载整包 JSON
              </button>
              <button
                type="button"
                onClick={() =>
                  onRequestDriveBundleSave(
                    `CutLogic_可用工作流_${bundle.versionTag || 'v2'}_${new Date().toISOString().slice(0, 10)}`,
                    bundle.files.map((f) => ({ path: f.path, content: f.content }))
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-700 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100 whitespace-nowrap"
              >
                <HardDriveUpload className="h-3.5 w-3.5" aria-hidden="true" />
                {hasDriveToken ? '整包保存到 Google Drive 新目录' : '登录并整包存到 Drive'}
              </button>
            </div>
          </div>

          {/* File Tabs & Code Preview */}
          <div className="border-b border-slate-200 px-6 pt-3">
            <div className="flex items-center gap-4 overflow-x-auto">
              {bundle.files.map((file) => {
                const isActive = activeFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setActiveFilePath(file.path)}
                    className={`border-b-2 pb-2.5 font-mono text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'border-blue-700 text-slate-950'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {file.path}
                  </button>
                );
              })}
            </div>
          </div>

          {activeFile && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-6 py-2.5 text-xs text-slate-600">
                <span>{activeFile.description}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopyFile(activeFile)}
                    className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-950 whitespace-nowrap"
                  >
                    {copiedPath === activeFile.path ? (
                      <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {copiedPath === activeFile.path ? '已复制' : '复制'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadSingle(activeFile)}
                    className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-950 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    下载此文件
                  </button>
                </div>
              </div>
              <div className="max-h-[360px] overflow-auto bg-[#F8FAFC] px-6 py-4">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                  {activeFile.content}
                </pre>
              </div>
            </div>
          )}

          {/* GitHub Direct Upload Panel */}
          <div className="border-t border-slate-200 px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-slate-700 shrink-0" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">
                  一键推送至 GitHub 仓库
                </h3>
              </div>

              {ghStatus?.authenticated && ghStatus.user ? (
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span>已连接 GitHub：@{ghStatus.user.login}</span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={handleDisconnectGithub}
                    className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-950 whitespace-nowrap"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                    断开
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleConnectGithub}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50 whitespace-nowrap"
                >
                  <FolderUp className="h-3.5 w-3.5" aria-hidden="true" />
                  连接 GitHub 账号
                </button>
              )}
            </div>

            {ghStatus && !ghStatus.configured && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
                <p className="font-medium text-slate-800">
                  提示：直接从本应用推送到 GitHub 需配置 GitHub OAuth 凭据
                </p>
                <p className="mt-1">
                  请在 AI Studio 的 <strong>Settings &gt; Secrets</strong> 面板配置{' '}
                  <code className="font-mono text-slate-900">GITHUB_CLIENT_ID</code> 和{' '}
                  <code className="font-mono text-slate-900">GITHUB_CLIENT_SECRET</code>，并将 GitHub OAuth App 的回调地址设为{' '}
                  <code className="font-mono text-slate-900">{ghStatus.callbackUrl}</code>；或者直接使用上方的「整包保存到 Google Drive 新目录」与「下载整包 JSON」。
                </p>
              </div>
            )}

            {ghStatus?.authenticated && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div>
                    <label
                      htmlFor="gh-repo-select"
                      className="mb-1 block text-xs font-medium text-slate-700"
                    >
                      目标仓库
                    </label>
                    <select
                      id="gh-repo-select"
                      value={selectedRepoFull}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedRepoFull(val);
                        const match = repos.find((r) => r.fullName === val);
                        if (match?.defaultBranch) setBranch(match.defaultBranch);
                      }}
                      disabled={isLoadingRepos}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                    >
                      {repos.length === 0 ? (
                        <option value="">{isLoadingRepos ? '加载仓库中…' : '暂无可用仓库'}</option>
                      ) : (
                        repos.map((r) => (
                          <option key={r.fullName} value={r.fullName}>
                            {r.fullName} ({r.isPrivate ? 'Private' : 'Public'})
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="gh-branch-input"
                      className="mb-1 block text-xs font-medium text-slate-700"
                    >
                      分支名
                    </label>
                    <input
                      id="gh-branch-input"
                      type="text"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="gh-path-input"
                      className="mb-1 block text-xs font-medium text-slate-700"
                    >
                      目标目录路径
                    </label>
                    <input
                      id="gh-path-input"
                      type="text"
                      value={basePath}
                      onChange={(e) => setBasePath(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="gh-commit-msg"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Commit 说明
                  </label>
                  <input
                    id="gh-commit-msg"
                    type="text"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                  />
                </div>

                {!showGhConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowGhConfirm(true)}
                    disabled={!selectedRepoFull || isPublishingGh}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <FolderUp className="h-3.5 w-3.5" aria-hidden="true" />
                    准备推送 {bundle.files.length} 个文件到 {selectedRepoFull || 'GitHub'}
                  </button>
                ) : (
                  <div className="rounded-md border border-blue-200 bg-blue-50/50 p-4 text-xs text-slate-800">
                    <p className="font-semibold text-slate-900">
                      确认将以下 {bundle.files.length} 个工作流文件提交到 {selectedRepoFull} ({branch} 分支)？
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-[11px] text-slate-700">
                      {bundle.files.map((f) => (
                        <li key={f.path}>
                          {basePath.replace(/^\/+|\/+$/g, '')}/{f.path}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleConfirmGithubPublish}
                        disabled={isPublishingGh}
                        className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                      >
                        {isPublishingGh && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {isPublishingGh ? '正在提交文件…' : '确认提交并推送'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowGhConfirm(false)}
                        disabled={isPublishingGh}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {ghError && (
              <p className="mt-3 text-xs font-medium text-red-700" role="alert">
                {ghError}
              </p>
            )}

            {ghSuccessUrl && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-emerald-800">
                <span>已成功上传完整工作流版本包至 GitHub：</span>
                <a
                  href={ghSuccessUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono font-semibold text-blue-700 underline"
                >
                  {ghSuccessUrl}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
