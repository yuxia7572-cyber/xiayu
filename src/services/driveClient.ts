import type { WorkflowFile } from '../types/workflow';
import {
  classifyWorkflowFile,
  diagnoseDriveApiError,
  type DriveErrorDiagnosis,
} from '../utils/workflowAnalyzer';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const MAX_TEXT_CHARS = 45000;

interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
  };
}

export interface DriveFolderSummary {
  id: string;
  name: string;
  modifiedTime?: string;
  shared?: boolean;
}

export interface DriveFolderLoadResult {
  folderId: string;
  folderName: string;
  files: WorkflowFile[];
  skippedCount: number;
}

export class DriveApiError extends Error {
  diagnosis: DriveErrorDiagnosis;
  status: number;

  constructor(status: number, diagnosis: DriveErrorDiagnosis) {
    super(`${diagnosis.title}：${diagnosis.detail}`);
    this.name = 'DriveApiError';
    this.status = status;
    this.diagnosis = diagnosis;
  }
}

async function driveFetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    const diagnosis = diagnoseDriveApiError(res.status, rawBody);
    throw new DriveApiError(res.status, diagnosis);
  }
  return res;
}

export async function listAccessibleDriveFolders(
  accessToken: string
): Promise<DriveFolderSummary[]> {
  const params = new URLSearchParams({
    q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id, name, modifiedTime, shared)',
    pageSize: '30',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
  const data = (await res.json()) as { files?: DriveFolderSummary[] };
  return data.files || [];
}

async function listFolderChildren(folderId: string, accessToken: string): Promise<DriveFileItem[]> {
  const items: DriveFileItem[] = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        'nextPageToken, files(id, name, mimeType, size, modifiedTime, shortcutDetails(targetId, targetMimeType))',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'folder,name',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
    const data = (await res.json()) as {
      files?: DriveFileItem[];
      nextPageToken?: string;
    };
    if (data.files) {
      items.push(...data.files);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken && items.length < 250);

  return items;
}

async function readDriveFileContent(
  item: DriveFileItem,
  accessToken: string
): Promise<{ content: string; truncated: boolean; readWarning?: string }> {
  const effectiveId =
    item.mimeType === SHORTCUT_MIME && item.shortcutDetails?.targetId
      ? item.shortcutDetails.targetId
      : item.id;
  const mime =
    item.mimeType === SHORTCUT_MIME && item.shortcutDetails?.targetMimeType
      ? item.shortcutDetails.targetMimeType
      : item.mimeType;

  let fetchUrl: string | null = null;
  if (mime === 'application/vnd.google-apps.document') {
    fetchUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(effectiveId)}/export?mimeType=${encodeURIComponent('text/plain')}`;
  } else if (mime === 'application/vnd.google-apps.spreadsheet') {
    fetchUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(effectiveId)}/export?mimeType=${encodeURIComponent('text/csv')}`;
  } else if (mime === 'application/vnd.google-apps.presentation') {
    fetchUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(effectiveId)}/export?mimeType=${encodeURIComponent('text/plain')}`;
  } else if (mime === 'application/vnd.google-apps.script') {
    fetchUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(effectiveId)}/export?mimeType=${encodeURIComponent('application/vnd.google-apps.script+json')}`;
  } else {
    const kind = classifyWorkflowFile(item.name, mime);
    if (kind === 'prose' || kind === 'script' || kind === 'config') {
      const sizeNum = Number(item.size || 0);
      if (sizeNum > 2 * 1024 * 1024) {
        return {
          content: '',
          truncated: true,
          readWarning: '文件超过 2MB，已跳过自动读取，可按需手动截取核心片段。',
        };
      }
      fetchUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(effectiveId)}?alt=media&supportsAllDrives=true`;
    } else {
      return {
        content: '',
        truncated: false,
        readWarning: `非纯文本/脚本格式 (${mime})，仅保留目录索引不送入逻辑解析。`,
      };
    }
  }

  try {
    const res = await driveFetch(fetchUrl, accessToken);
    const rawText = await res.text();
    if (rawText.length > MAX_TEXT_CHARS) {
      return {
        content: rawText.slice(0, MAX_TEXT_CHARS),
        truncated: true,
        readWarning: `原文共 ${rawText.length.toLocaleString()} 字符，已截取前 ${MAX_TEXT_CHARS.toLocaleString()} 字符用于审计。`,
      };
    }
    return { content: rawText, truncated: false };
  } catch (err) {
    return {
      content: '',
      truncated: false,
      readWarning: err instanceof Error ? err.message : '读取该文件内容时发生异常。',
    };
  }
}

export async function fetchDriveFolderWorkflow(
  folderId: string,
  accessToken: string,
  onProgress?: (msg: string) => void
): Promise<DriveFolderLoadResult> {
  onProgress?.('正在读取目标文件夹元数据…');
  const metaParams = new URLSearchParams({
    fields: 'id, name, mimeType, shortcutDetails(targetId, targetMimeType)',
    supportsAllDrives: 'true',
  });
  const metaRes = await driveFetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?${metaParams.toString()}`,
    accessToken
  );
  const folderMeta = (await metaRes.json()) as DriveFileItem;
  const resolvedFolderId =
    folderMeta.mimeType === SHORTCUT_MIME && folderMeta.shortcutDetails?.targetId
      ? folderMeta.shortcutDetails.targetId
      : folderMeta.id;
  const folderName = folderMeta.name || folderId;

  const collected: Array<{ item: DriveFileItem; relativePath: string }> = [];

  async function walk(currentId: string, prefix: string, depth: number) {
    if (depth > 3) return;
    onProgress?.(`正在扫描目录：${prefix || folderName}`);
    const children = await listFolderChildren(currentId, accessToken);
    for (const child of children) {
      const childPath = prefix ? `${prefix}/${child.name}` : child.name;
      const isFolder =
        child.mimeType === FOLDER_MIME ||
        (child.mimeType === SHORTCUT_MIME &&
          child.shortcutDetails?.targetMimeType === FOLDER_MIME);

      if (isFolder) {
        const nextId =
          child.mimeType === SHORTCUT_MIME && child.shortcutDetails?.targetId
            ? child.shortcutDetails.targetId
            : child.id;
        await walk(nextId, childPath, depth + 1);
      } else {
        collected.push({ item: child, relativePath: childPath });
      }
    }
  }

  await walk(resolvedFolderId, '', 0);

  const files: WorkflowFile[] = [];
  let skippedCount = 0;

  for (let i = 0; i < collected.length; i++) {
    const { item, relativePath } = collected[i];
    const effectiveMime =
      item.mimeType === SHORTCUT_MIME && item.shortcutDetails?.targetMimeType
        ? item.shortcutDetails.targetMimeType
        : item.mimeType;
    const kind = classifyWorkflowFile(item.name, effectiveMime);
    onProgress?.(`正在读取文件 (${i + 1}/${collected.length})：${item.name}`);

    const readResult = await readDriveFileContent(item, accessToken);
    if (!readResult.content && kind === 'other') {
      skippedCount += 1;
    }

    files.push({
      id: item.id,
      name: item.name,
      path: relativePath,
      mimeType: effectiveMime,
      kind,
      content: readResult.content,
      sizeBytes: Number(item.size || readResult.content.length),
      modifiedTime: item.modifiedTime,
      selected: readResult.content.trim().length > 0,
      source: 'drive',
      truncated: readResult.truncated,
      readWarning: readResult.readWarning,
    });
  }

  return {
    folderId: resolvedFolderId,
    folderName,
    files,
    skippedCount,
  };
}

export async function saveMarkdownToGoogleDrive(
  accessToken: string,
  params: {
    fileName: string;
    content: string;
  }
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const metadata = {
    name: params.fileName,
    mimeType: 'text/markdown',
  };

  const boundary = 'cutlogic_drive_upload_boundary_' + Date.now();
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/markdown; charset=UTF-8',
    '',
    params.content,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await driveFetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  return (await res.json()) as { id: string; name: string; webViewLink?: string };
}

export async function saveBundleToGoogleDrive(
  accessToken: string,
  params: {
    folderName: string;
    files: Array<{ path: string; content: string }>;
  }
): Promise<{ folderId: string; folderName: string; uploadedCount: number; webViewLink?: string }> {
  // 1. Create a brand-new folder owned by this app (drive.file scope)
  const folderRes = await driveFetch(
    `${DRIVE_API_BASE}/files?fields=id,name,webViewLink`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.folderName,
        mimeType: FOLDER_MIME,
      }),
    }
  );
  const folder = (await folderRes.json()) as { id: string; name: string; webViewLink?: string };

  // 2. Upload each file into that newly created folder
  let uploadedCount = 0;
  for (const file of params.files) {
    const flatName = file.path.replace(/\//g, '__');
    const mimeType = file.path.endsWith('.json')
      ? 'application/json'
      : file.path.endsWith('.py')
        ? 'text/x-python'
        : 'text/markdown';

    const metadata = {
      name: flatName,
      mimeType,
      parents: [folder.id],
    };

    const boundary = 'cutlogic_bundle_boundary_' + Date.now() + '_' + uploadedCount;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}; charset=UTF-8`,
      '',
      file.content,
      `--${boundary}--`,
    ].join('\r\n');

    await driveFetch(
      `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`,
      accessToken,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    uploadedCount += 1;
  }

  return {
    folderId: folder.id,
    folderName: folder.name,
    uploadedCount,
    webViewLink: folder.webViewLink,
  };
}
