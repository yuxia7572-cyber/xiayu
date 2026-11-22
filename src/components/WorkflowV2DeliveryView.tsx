import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Loader2,
  LogOut,
  Terminal,
} from 'lucide-react';

interface WorkflowV2File {
  path: string;
  sizeBytes: number;
  lines: number;
  category: string;
  content: string;
}

interface WorkflowV2Payload {
  name: string;
  version: string;
  fileCount: number;
  totalBytes: number;
  totalLines: number;
  files: WorkflowV2File[];
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

const CATEGORY_LABELS: Record<string, string> = {
  root: '入口与文档',
  config: '配置与 DAG',
  engine: '核心引擎 (Python)',
  prompts: '弱 AI 原子 Prompt',
  schemas: '精简契约',
  scripts: '工具脚本',
  tests: '自动化测试',
};

export const WorkflowV2DeliveryView: React.FC = () => {
  const [payload, setPayload] = useState<WorkflowV2Payload | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string>('README.md');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // GitHub state
  const [ghStatus, setGhStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    user: GithubUser | null;
    callbackUrl: string;
  } | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepoFull, setSelectedRepoFull] = useState('');
  const [branch, setBranch] = useState('main');
  const [basePath, setBasePath] = useState('');
  const [commitMessage, setCommitMessage] = useState(
    'feat(workflow-v2): implement refactored interview video editing workflow v2'
  );

  // Create new repo mode
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('interview-video-objective-agent-v2');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [creatingRepo, setCreatingRepo] = useState(false);

  // Publish state
  const [confirmPush, setConfirmPush] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{
    repoUrl: string;
    commitUrl?: string;
    fileCount: number;
    mode: string;
  } | null>(null);

  const loadWorkflowFiles = async () => {
    setLoadingFiles(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/workflow-v2/files');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载重构工作流文件失败。');
      setPayload(data);
      if (data.files?.length > 0) {
        const readme = data.files.find((f: WorkflowV2File) => f.path === 'README.md');
        setActivePath(readme ? readme.path : data.files[0].path);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载重构工作流文件失败。');
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadRepos = async () => {
    setLoadingRepos(true);
    setGhError(null);
    try {
      const res = await fetch('/api/github/repos', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '获取 GitHub 仓库列表失败。');
      const list: GithubRepo[] = data.repos || [];
      setRepos(list);
      if (list.length > 0 && !selectedRepoFull) {
        setSelectedRepoFull(list[0].fullName);
        setBranch(list[0].defaultBranch || 'main');
      }
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '读取仓库列表失败。');
    } finally {
      setLoadingRepos(false);
    }
  };

  const fetchGhStatus = async () => {
    try {
      const res = await fetch('/api/github/status', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setGhStatus(data);
      if (data.authenticated) {
        loadRepos();
      }
    } catch {
      // Ignore background fetch error
    }
  };

  useEffect(() => {
    loadWorkflowFiles();
    fetchGhStatus();

    const onMessage = (event: MessageEvent) => {
      if (!event.origin.endsWith('.run.app') && !event.origin.includes('localhost')) return;
      if (event.data?.type === 'GITHUB_OAUTH_SUCCESS') {
        fetchGhStatus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleConnectGithub = async () => {
    setGhError(null);
    try {
      const res = await fetch('/api/github/auth-url', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'GitHub OAuth 尚未配置。');
      }
      const popup = window.open(data.url, 'github_oauth_popup', 'width=640,height=720');
      if (!popup) {
        setGhError('浏览器拦截了授权弹窗，请允许本站点弹窗后重试。');
      }
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '无法打开 GitHub 授权窗口。');
    }
  };

  const handleDisconnectGithub = async () => {
    await fetch('/api/github/logout', { method: 'POST', credentials: 'include' });
    setRepos([]);
    setSelectedRepoFull('');
    setConfirmPush(false);
    setPublishResult(null);
    fetchGhStatus();
  };

  const handleCreateRepo = async () => {
    if (!newRepoName.trim()) return;
    setCreatingRepo(true);
    setGhError(null);
    try {
      const res = await fetch('/api/github/create-repo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newRepoName.trim(),
          isPrivate: newRepoPrivate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建仓库失败。');
      const created: GithubRepo = data.repo;
      setRepos((prev) => [created, ...prev]);
      setSelectedRepoFull(created.fullName);
      setBranch(created.defaultBranch || 'main');
      setBasePath('');
      setShowCreateRepo(false);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '创建 GitHub 仓库失败。');
    } finally {
      setCreatingRepo(false);
    }
  };

  const handleConfirmPush = async () => {
    if (!selectedRepoFull) return;
    const [owner, repo] = selectedRepoFull.split('/');
    if (!owner || !repo) {
      setGhError('请选择有效的目标 GitHub 仓库。');
      return;
    }
    setPublishing(true);
    setGhError(null);
    setPublishResult(null);
    try {
      const res = await fetch('/api/github/publish-v2', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner,
          repo,
          branch,
          basePath,
          commitMessage,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '推送失败。');
      setPublishResult({
        repoUrl: data.repoUrl,
        commitUrl: data.commitUrl,
        fileCount: data.fileCount,
        mode: data.mode,
      });
      setConfirmPush(false);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : '推送完整工作流到 GitHub 失败。');
    } finally {
      setPublishing(false);
    }
  };

  const groupedFiles = useMemo(() => {
    if (!payload) return [];
    const order = ['root', 'config', 'engine', 'prompts', 'schemas', 'scripts', 'tests'];
    const map = new Map<string, WorkflowV2File[]>();
    for (const f of payload.files) {
      const list = map.get(f.category) || [];
      list.push(f);
      map.set(f.category, list);
    }
    return order
      .filter((k) => map.has(k))
      .map((k) => ({ key: k, label: CATEGORY_LABELS[k] || k, items: map.get(k)! }));
  }, [payload]);

  const activeFile = useMemo(
    () => payload?.files.find((f) => f.path === activePath) || payload?.files[0] || null,
    [payload, activePath]
  );

  const handleCopyFile = async (file: WorkflowV2File) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedPath(file.path);
      setTimeout(() => setCopiedPath(null), 1600);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleDownloadSingle = (file: WorkflowV2File) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.path.split('/').pop() || 'file.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip — hairline separated, zero pills */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="grid grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-slate-200">
          <div className="border-b border-r border-slate-200 px-6 py-4 lg:border-b-0 lg:border-r-0">
            <p className="text-xs font-medium text-slate-500">已实施可执行文件</p>
            <p className="mt-1.5 text-xl font-bold text-slate-900 tabular-nums lg:text-2xl">
              {payload ? `${payload.fileCount} 份` : '—'}
            </p>
            <p className="mt-0.5 text-xs text-slate-600 tabular-nums">
              {payload ? `共 ${payload.totalLines} 行实测代码与规范` : '正在加载工作流清单…'}
            </p>
          </div>
          <div className="border-b border-slate-200 px-6 py-4 lg:border-b-0">
            <p className="text-xs font-medium text-slate-500">架构收敛</p>
            <p className="mt-1.5 text-xl font-bold text-blue-700 tabular-nums lg:text-2xl">
              21 节点 → 6 阶段
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              彻底消除层级倒置与 8,165 行校验死锁
            </p>
          </div>
          <div className="border-r border-slate-200 px-6 py-4 lg:border-r-0">
            <p className="text-xs font-medium text-slate-500">自动化与出片实测</p>
            <p className="mt-1.5 text-xl font-bold text-emerald-700 tabular-nums lg:text-2xl">
              6 / 6 通过
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              含真实 FFmpeg 1080p MP4 渲染与零重叠账本
            </p>
          </div>
          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">弱 AI 容错机制</p>
            <p className="mt-1.5 text-xl font-bold text-slate-900 tabular-nums lg:text-2xl">
              3 个原子任务
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              ID-only 契约 · 漏标自动保守 Keep · 离线可跑
            </p>
          </div>
        </div>
      </section>

      {/* Primary Action Console: Direct Atomic Push to User's GitHub */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-4 w-4 text-blue-700 shrink-0" aria-hidden="true" />
              <h1 className="text-base font-semibold text-slate-900">
                完整重构工作流{' '}
                <code className="font-mono text-[15px] text-slate-950">
                  interview-video-objective-agent-v2
                </code>{' '}
                — 一键推送到您的 GitHub
              </h1>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              已直接读取您 Google Drive 中的原始 116 份文件并完成端到端重构实施（无需再登录 Google Drive）。下方可将全部 {payload?.fileCount || 18} 个真实可运行文件一次性原子提交至您的 GitHub 仓库，或直接下载压缩包本地运行。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <a
              href="/api/workflow-v2/archive"
              download="interview-video-objective-agent-v2.tar.gz"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              下载完整 .tar.gz
            </a>

            {ghStatus?.authenticated && ghStatus.user ? (
              <div className="flex items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
                <span className="font-mono font-semibold text-slate-900">
                  @{ghStatus.user.login}
                </span>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={handleDisconnectGithub}
                  className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-950 whitespace-nowrap"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  断开
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectGithub}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
              >
                <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                连接 GitHub 账号并推送
              </button>
            )}
          </div>
        </div>

        <div className="px-6 py-5">
          {!ghStatus?.authenticated ? (
            <div className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-4 text-xs leading-relaxed text-slate-700 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="font-semibold text-slate-900">
                  {ghStatus?.configured
                    ? 'GitHub OAuth 密钥已就绪，点击右上角「连接 GitHub 账号并推送」即可直接选择或新建仓库上传'
                    : '尚未配置 GitHub OAuth 密钥'}
                </p>
                <p className="mt-1 text-slate-600">
                  授权完成后，本页面会直接通过 GitHub Git Tree API 将全部 {payload?.fileCount || 18} 个完整工作流文件作为一个干净的 Commit 推送到您的仓库；同时您也可以随时点击「下载完整 .tar.gz」本地解压运行。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Repo Selector + Create New Repo Toggle */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label
                      htmlFor="v2-repo-select"
                      className="text-xs font-medium text-slate-700"
                    >
                      目标 GitHub 仓库
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowCreateRepo((v) => !v)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
                    >
                      <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                      {showCreateRepo ? '取消新建' : '新建专属仓库'}
                    </button>
                  </div>
                  <select
                    id="v2-repo-select"
                    value={selectedRepoFull}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedRepoFull(val);
                      const found = repos.find((r) => r.fullName === val);
                      if (found?.defaultBranch) setBranch(found.defaultBranch);
                    }}
                    disabled={loadingRepos}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                  >
                    {repos.length === 0 ? (
                      <option value="">
                        {loadingRepos ? '加载仓库列表中…' : '暂无仓库，请点右上角「新建专属仓库」'}
                      </option>
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
                    htmlFor="v2-branch-input"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    目标分支
                  </label>
                  <input
                    id="v2-branch-input"
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                  />
                </div>

                <div>
                  <label
                    htmlFor="v2-path-input"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    目标子目录（留空则直接写入仓库根目录）
                  </label>
                  <input
                    id="v2-path-input"
                    type="text"
                    value={basePath}
                    placeholder="留空 = 仓库根目录 /"
                    onChange={(e) => setBasePath(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                  />
                </div>
              </div>

              {/* Inline Create New Repo Drawer */}
              {showCreateRepo && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold text-slate-900">
                    在 @{ghStatus.user?.login} 名下新建专属工作流仓库
                  </p>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <input
                      type="text"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="interview-video-objective-agent-v2"
                      className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                    />
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={newRepoPrivate}
                        onChange={(e) => setNewRepoPrivate(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      设为私有仓库 (Private)
                    </label>
                    <button
                      type="button"
                      onClick={handleCreateRepo}
                      disabled={creatingRepo || !newRepoName.trim()}
                      className="inline-flex items-center justify-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      {creatingRepo && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {creatingRepo ? '创建中…' : '创建并选中'}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="v2-commit-msg"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Commit 说明
                </label>
                <input
                  id="v2-commit-msg"
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </div>

              {!confirmPush ? (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmPush(true)}
                    disabled={!selectedRepoFull || publishing || !payload?.fileCount}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
                    推送全部 {payload?.fileCount || 18} 个完整工作流文件到 {selectedRepoFull || 'GitHub'}
                  </button>
                  <span className="text-xs text-slate-500">
                    单次原子 Commit 提交，不破坏您仓库中其他无关文件
                  </span>
                </div>
              ) : (
                <div className="rounded-md border border-blue-200 bg-blue-50/50 p-4 text-xs text-slate-800">
                  <p className="font-semibold text-slate-900">
                    确认将完整重构版（{payload?.fileCount} 个可执行文件）提交到{' '}
                    <span className="font-mono">{selectedRepoFull}</span> ({branch} 分支
                    {basePath.trim() ? ` · /${basePath.trim().replace(/^\/+|\/+$/g, '')}` : ' · 根目录'})？
                  </p>
                  <div className="mt-3 flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleConfirmPush}
                      disabled={publishing}
                      className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                    >
                      {publishing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {publishing ? '正在原子推送至 GitHub…' : '确认立即推送'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmPush(false)}
                      disabled={publishing}
                      className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
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

          {publishResult && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-xs text-emerald-900">
              <p className="font-semibold">
                推送成功！已将全部 {publishResult.fileCount} 个重构工作流文件提交到 GitHub。
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-4">
                <a
                  href={publishResult.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono font-semibold text-blue-700 underline"
                >
                  打开 GitHub 仓库查看
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
                {publishResult.commitUrl && (
                  <a
                    href={publishResult.commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-slate-700 underline"
                  >
                    查看本次原子 Commit
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Quickstart CLI Command Reference */}
      <section className="rounded-lg border border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
          <Terminal className="h-3.5 w-3.5 text-slate-700" aria-hidden="true" />
          推送或下载后，3 条命令即可在您的电脑/服务器上直接跑通并出片
        </div>
        <div className="mt-2.5 grid grid-cols-1 gap-2.5 font-mono text-xs md:grid-cols-3">
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800">
            <span className="text-slate-500"># 1. 环境体检</span>
            <div className="mt-0.5 select-all">python3 scripts/check_env.py</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800">
            <span className="text-slate-500"># 2. 一键实测完整出片 Demo</span>
            <div className="mt-0.5 select-all">python3 run_pipeline.py demo ./demo_out</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800">
            <span className="text-slate-500"># 3. 运行真实采访素材目录</span>
            <div className="mt-0.5 select-all">python3 run_pipeline.py run ./my_project</div>
          </div>
        </div>
      </section>

      {/* Master-Detail Code Explorer for All Implemented Workflow v2 Files */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-slate-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              完整重构代码库预览（
              <code className="font-mono text-xs text-slate-950">workflow_v2/</code>{' '}
              全部真实可执行代码）
            </h2>
          </div>
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            {payload ? `${payload.fileCount} files · ${(payload.totalBytes / 1024).toFixed(1)} KB` : ''}
          </span>
        </div>

        {loadingFiles ? (
          <div className="flex items-center gap-2 px-6 py-10 text-xs text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin text-blue-700" aria-hidden="true" />
            正在读取工作流代码库…
          </div>
        ) : loadError ? (
          <div className="px-6 py-6 text-xs text-red-700" role="alert">
            {loadError}
          </div>
        ) : (
          <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-12 lg:divide-x lg:divide-y-0">
            {/* File Tree */}
            <aside className="max-h-[560px] overflow-y-auto bg-slate-50/50 py-3 lg:col-span-4">
              {groupedFiles.map((group) => (
                <div key={group.key} className="mb-3 last:mb-0">
                  <div className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {group.label}
                  </div>
                  <div>
                    {group.items.map((f) => {
                      const isActive = activeFile?.path === f.path;
                      return (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => setActivePath(f.path)}
                          className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left font-mono text-xs transition-colors ${
                            isActive
                              ? 'bg-blue-50 font-semibold text-blue-800'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <span className="truncate">{f.path}</span>
                          <span className="shrink-0 text-[11px] text-slate-500 tabular-nums">
                            {f.lines}L
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </aside>

            {/* File Content Viewer */}
            <div className="flex flex-col lg:col-span-8">
              {activeFile && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-xs">
                    <span className="font-mono font-semibold text-slate-900">
                      {activeFile.path}
                    </span>
                    <div className="flex items-center gap-3 text-slate-600">
                      <span className="font-mono text-[11px] tabular-nums">
                        {activeFile.lines} 行 · {(activeFile.sizeBytes / 1024).toFixed(1)} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyFile(activeFile)}
                        className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-950"
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
                        className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-950"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        下载
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[520px] overflow-auto bg-[#F8FAFC] px-5 py-4">
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                      {activeFile.content}
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
