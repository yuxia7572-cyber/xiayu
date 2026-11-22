import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { Download } from 'lucide-react';
import type { ActiveTab, WorkflowAuditReport, WorkflowFile } from './types/workflow';
import {
  DEFAULT_DRIVE_FOLDER_URL,
  detectStaticLogicIssues,
  parseDriveFolderId,
  type DriveErrorDiagnosis,
} from './utils/workflowAnalyzer';
import { SAMPLE_WORKFLOW_FILES } from './data/sampleWorkflow';
import { REAL_AUDIT_REPORT } from './data/realAuditReport';
import { getAccessToken, googleSignIn, initAuth, logout } from './services/googleAuth';
import {
  DriveApiError,
  fetchDriveFolderWorkflow,
  listAccessibleDriveFolders,
  saveBundleToGoogleDrive,
  saveMarkdownToGoogleDrive,
  type DriveFolderSummary,
} from './services/driveClient';
import { WorkflowV2DeliveryView } from './components/WorkflowV2DeliveryView';
import { SourcesWorkspace } from './components/SourcesWorkspace';
import { HardLogicView } from './components/HardLogicView';
import { AlignmentView } from './components/AlignmentView';
import { ObjectificationView } from './components/ObjectificationView';
import { RefactorBlueprintView } from './components/RefactorBlueprintView';
import { DriveConfirmModal } from './components/DriveConfirmModal';

const NAV_TABS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'delivery', label: '完整工作流交付' },
  { id: 'logic', label: '硬逻辑审计' },
  { id: 'alignment', label: '文脚错配' },
  { id: 'objectification', label: '客观化边界' },
  { id: 'refactor', label: '架构对比' },
];

const DEFAULT_USER_CONTEXT =
  '基于 Google Drive 原仓库 interview-video-objective-agent 的真实 116 份文件，重构为弱 AI 友好的 6 阶段剪辑工作流并直接交付至 GitHub。';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('delivery');

  // Google Auth state (kept for optional Drive re-analysis / Drive backup)
  const [user, setUser] = useState<User | null>(null);
  const [hasDriveToken, setHasDriveToken] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Drive folder & workflow files state
  const [folderUrl, setFolderUrl] = useState(DEFAULT_DRIVE_FOLDER_URL);
  const [folderUrlError, setFolderUrlError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('interview-video-objective-agent（已实测重构）');
  const [files, setFiles] = useState<WorkflowFile[]>(SAMPLE_WORKFLOW_FILES);
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [driveProgress, setDriveProgress] = useState('');
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveDiagnosis, setDriveDiagnosis] = useState<DriveErrorDiagnosis | null>(null);
  const [accessibleFolders, setAccessibleFolders] = useState<DriveFolderSummary[]>([]);
  const [isBrowsingFolders, setIsBrowsingFolders] = useState(false);

  // Audit report defaults to the REAL forensic audit of interview-video-objective-agent
  const [userContext, setUserContext] = useState(DEFAULT_USER_CONTEXT);
  const [report, setReport] = useState<WorkflowAuditReport>(REAL_AUDIT_REPORT);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // Mandatory explicit Drive save confirmation modal state
  const [pendingSave, setPendingSave] = useState<{
    open: boolean;
    mode: 'single' | 'bundle';
    targetName: string;
    content: string;
    bundleFiles: Array<{ path: string; content: string }>;
  }>({ open: false, mode: 'single', targetName: '', content: '', bundleFiles: [] });
  const [isSavingDrive, setIsSavingDrive] = useState(false);
  const [driveSaveResult, setDriveSaveResult] = useState<{
    name: string;
    webViewLink?: string;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser) => {
        setUser(authedUser);
        setHasDriveToken(true);
      },
      () => {
        setUser(null);
        setHasDriveToken(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const staticFindings = useMemo(() => detectStaticLogicIssues(files), [files]);

  const handleFolderUrlChange = (value: string) => {
    setFolderUrl(value);
    setFolderUrlError(null);
    setDriveError(null);
    setDriveDiagnosis(null);
  };

  const loadFolderWithToken = async (folderId: string, token: string) => {
    setIsLoadingDrive(true);
    setDriveError(null);
    setDriveDiagnosis(null);
    setDriveProgress('正在连接 Google Drive…');
    try {
      const result = await fetchDriveFolderWorkflow(folderId, token, setDriveProgress);
      setFolderName(result.folderName);
      setFiles(result.files);
      if (result.files.length === 0) {
        setDriveError('该文件夹下未找到任何文件，请确认文件夹链接或子目录权限。');
      }
    } catch (err) {
      if (err instanceof DriveApiError) {
        setDriveDiagnosis(err.diagnosis);
        setDriveError(err.message);
      } else {
        setDriveDiagnosis(null);
        setDriveError(err instanceof Error ? err.message : '读取 Google Drive 文件夹失败。');
      }
    } finally {
      setIsLoadingDrive(false);
      setDriveProgress('');
    }
  };

  const handleGoogleLogin = async (): Promise<string | null> => {
    setIsLoggingIn(true);
    setDriveError(null);
    setDriveDiagnosis(null);
    try {
      const result = await googleSignIn({ forceConsent: true });
      setUser(result.user);
      setHasDriveToken(true);

      if (result.scopeCheck && !result.scopeCheck.hasDriveRead) {
        const missingScopeDiag: DriveErrorDiagnosis = {
          kind: 'scope_missing',
          title: '登录成功，但尚未勾选 Google Drive 读取权限',
          detail:
            'Google 授权弹窗中的「查看并下载您的所有 Google 云端硬盘文件」勾选框未被选中。请重新授权并勾选该选项。',
          needsReconsent: true,
        };
        setDriveDiagnosis(missingScopeDiag);
        setDriveError(`${missingScopeDiag.title}：${missingScopeDiag.detail}`);
        return result.accessToken;
      }

      const parsed = parseDriveFolderId(folderUrl);
      if (parsed.folderId) {
        await loadFolderWithToken(parsed.folderId, result.accessToken);
      }
      return result.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google 授权登录未完成。';
      setDriveError(msg);
      return null;
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logout();
    setUser(null);
    setHasDriveToken(false);
    setAccessibleFolders([]);
    setDriveDiagnosis(null);
    setDriveError(null);
  };

  const handleBrowseDriveFolders = async () => {
    let token = await getAccessToken();
    if (!token) {
      token = await handleGoogleLogin();
      if (!token) return;
    }
    setIsBrowsingFolders(true);
    setDriveError(null);
    setDriveDiagnosis(null);
    try {
      const list = await listAccessibleDriveFolders(token);
      setAccessibleFolders(list);
      if (list.length === 0) {
        setDriveError('当前账号下未列出可访问的 Google Drive 文件夹。');
      }
    } catch (err) {
      if (err instanceof DriveApiError) {
        setDriveDiagnosis(err.diagnosis);
        setDriveError(err.message);
      } else {
        setDriveError(err instanceof Error ? err.message : '列出 Drive 文件夹失败。');
      }
    } finally {
      setIsBrowsingFolders(false);
    }
  };

  const handleSelectBrowsedFolder = async (folder: DriveFolderSummary) => {
    const url = `https://drive.google.com/drive/folders/${folder.id}`;
    setFolderUrl(url);
    setFolderUrlError(null);
    setAccessibleFolders([]);
    const token = await getAccessToken();
    if (token) {
      await loadFolderWithToken(folder.id, token);
    }
  };

  const handleLoadDriveFolder = async () => {
    const parsed = parseDriveFolderId(folderUrl);
    if (!parsed.folderId) {
      setFolderUrlError(parsed.error);
      return;
    }
    setFolderUrlError(null);

    const token = await getAccessToken();
    if (!token) {
      await handleGoogleLogin();
      return;
    }
    await loadFolderWithToken(parsed.folderId, token);
  };

  const handleToggleFileSelect = (id: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f))
    );
  };

  const handleToggleAllFiles = (selected: boolean) => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        selected: selected && f.content.trim().length > 0,
      }))
    );
  };

  const handleAddManualFile = (file: WorkflowFile) => {
    setFiles((prev) => [file, ...prev]);
  };

  const handleRemoveFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleResetSample = () => {
    setFiles(SAMPLE_WORKFLOW_FILES);
    setFolderName('interview-video-objective-agent（已实测重构）');
    setReport(REAL_AUDIT_REPORT);
    setAnalyzeError(null);
    setDriveError(null);
  };

  const handleRunAnalysis = async () => {
    const selectedFiles = files.filter((f) => f.selected && f.content.trim().length > 0);
    if (selectedFiles.length === 0) {
      setAnalyzeError('请至少勾选一份包含可读文本或脚本的工作流文件。');
      return;
    }

    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const hasDriveFile = selectedFiles.some((f) => f.source === 'drive');
      const res = await fetch('/api/analyze-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: selectedFiles.map((f) => ({
            name: f.name,
            path: f.path,
            kind: f.kind,
            content: f.content,
          })),
          userContext,
          folderName,
          sourceMode: hasDriveFile ? 'drive_ai' : 'local_ai',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '工作流分析请求失败。');
      }
      setReport(data as WorkflowAuditReport);
      setActiveTab('logic');
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : '执行工作流深度分析失败。');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRequestDriveSave = async (fileName: string, content: string) => {
    let token = await getAccessToken();
    if (!token) {
      token = await handleGoogleLogin();
      if (!token) return;
    }
    setPendingSave({
      open: true,
      mode: 'single',
      targetName: fileName,
      content,
      bundleFiles: [],
    });
  };

  const handleRequestDriveBundleSave = async (
    targetFolderName: string,
    bundleFiles: Array<{ path: string; content: string }>
  ) => {
    let token = await getAccessToken();
    if (!token) {
      token = await handleGoogleLogin();
      if (!token) return;
    }
    setPendingSave({
      open: true,
      mode: 'bundle',
      targetName: targetFolderName,
      content: '',
      bundleFiles,
    });
  };

  const handleConfirmDriveSave = async () => {
    const token = await getAccessToken();
    if (!token) {
      setPendingSave({ open: false, mode: 'single', targetName: '', content: '', bundleFiles: [] });
      setDriveError('授权令牌已失效，请重新登录 Google。');
      return;
    }
    setIsSavingDrive(true);
    try {
      if (pendingSave.mode === 'bundle') {
        const saved = await saveBundleToGoogleDrive(token, {
          folderName: pendingSave.targetName.trim(),
          files: pendingSave.bundleFiles,
        });
        setDriveSaveResult({
          name: `${saved.folderName}（共 ${saved.uploadedCount} 个工作流文件）`,
          webViewLink: saved.webViewLink,
        });
      } else {
        const saved = await saveMarkdownToGoogleDrive(token, {
          fileName: pendingSave.targetName.trim(),
          content: pendingSave.content,
        });
        setDriveSaveResult({ name: saved.name, webViewLink: saved.webViewLink });
      }
      setPendingSave({ open: false, mode: 'single', targetName: '', content: '', bundleFiles: [] });
    } catch (err) {
      if (err instanceof DriveApiError) {
        setDriveDiagnosis(err.diagnosis);
        setDriveError(err.message);
      } else {
        setDriveError(err instanceof Error ? err.message : '保存到 Google Drive 失败。');
      }
      setPendingSave({ open: false, mode: 'single', targetName: '', content: '', bundleFiles: [] });
    } finally {
      setIsSavingDrive(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-slate-900">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3">
          {/* Zone 1: Single-line Brand Wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('delivery');
            }}
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            CutLogic v2
          </a>

          {/* Zone 2: 5 Concise Single-Line Nav Tabs */}
          <nav
            aria-label="主工作区导航"
            className="hidden items-center gap-6 md:flex"
          >
            {NAV_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`border-b-2 py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-blue-700 text-slate-950'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            <a
              href="/api/workflow-v2/archive"
              download="interview-video-objective-agent-v2.tar.gz"
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              下载工作流 v2
            </a>
          </div>
        </div>

        {/* Mobile Single-Row Scrollable Tab Bar */}
        <nav
          aria-label="移动端工作区导航"
          className="flex items-center gap-5 overflow-x-auto border-t border-slate-100 px-6 py-2 md:hidden"
        >
          {NAV_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`text-xs font-medium whitespace-nowrap shrink-0 ${
                  isActive ? 'text-blue-700' : 'text-slate-600'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Main Content Container */}
      <main id="top" className="mx-auto max-w-[1440px] px-6 py-6">
        {activeTab === 'delivery' && <WorkflowV2DeliveryView />}
        {activeTab === 'logic' && <HardLogicView report={report} />}
        {activeTab === 'alignment' && <AlignmentView report={report} />}
        {activeTab === 'objectification' && <ObjectificationView report={report} />}
        {activeTab === 'refactor' && (
          <RefactorBlueprintView
            report={report}
            folderName={folderName}
            files={files}
            hasDriveToken={hasDriveToken}
            onRequestDriveSave={handleRequestDriveSave}
            onRequestDriveBundleSave={handleRequestDriveBundleSave}
            driveSaveResult={driveSaveResult}
          />
        )}
        {activeTab === 'sources' && (
          <SourcesWorkspace
            folderUrl={folderUrl}
            onFolderUrlChange={handleFolderUrlChange}
            folderUrlError={folderUrlError}
            folderName={folderName}
            userEmail={user?.email || null}
            hasDriveToken={hasDriveToken}
            isLoggingIn={isLoggingIn}
            isLoadingDrive={isLoadingDrive}
            driveProgress={driveProgress}
            driveError={driveError}
            driveDiagnosis={driveDiagnosis}
            accessibleFolders={accessibleFolders}
            isBrowsingFolders={isBrowsingFolders}
            files={files}
            staticFindings={staticFindings}
            userContext={userContext}
            onUserContextChange={setUserContext}
            isAnalyzing={isAnalyzing}
            analyzeError={analyzeError}
            onGoogleLogin={handleGoogleLogin}
            onGoogleLogout={handleGoogleLogout}
            onLoadDriveFolder={handleLoadDriveFolder}
            onBrowseDriveFolders={handleBrowseDriveFolders}
            onSelectBrowsedFolder={handleSelectBrowsedFolder}
            onToggleFileSelect={handleToggleFileSelect}
            onToggleAllFiles={handleToggleAllFiles}
            onAddManualFile={handleAddManualFile}
            onRemoveFile={handleRemoveFile}
            onResetSample={handleResetSample}
            onRunAnalysis={handleRunAnalysis}
          />
        )}
      </main>

      <DriveConfirmModal
        open={pendingSave.open}
        mode={pendingSave.mode}
        targetName={pendingSave.targetName}
        contentPreviewChars={
          pendingSave.mode === 'bundle'
            ? pendingSave.bundleFiles.reduce((sum, f) => sum + f.content.length, 0)
            : pendingSave.content.length
        }
        bundleFilePaths={pendingSave.bundleFiles.map((f) => f.path)}
        isSaving={isSavingDrive}
        onTargetNameChange={(name) => setPendingSave((prev) => ({ ...prev, targetName: name }))}
        onCancel={() =>
          setPendingSave({ open: false, mode: 'single', targetName: '', content: '', bundleFiles: [] })
        }
        onConfirm={handleConfirmDriveSave}
      />
    </div>
  );
}
