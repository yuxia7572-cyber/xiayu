import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefactoringMarkdown,
  classifyWorkflowFile,
  computeAuditMetrics,
  DEFAULT_DRIVE_FOLDER_ID,
  DEFAULT_DRIVE_FOLDER_URL,
  detectStaticLogicIssues,
  diagnoseDriveApiError,
  parseDriveFolderId,
} from './workflowAnalyzer';
import { SAMPLE_AUDIT_REPORT, SAMPLE_WORKFLOW_FILES } from '../data/sampleWorkflow';

test('parseDriveFolderId extracts folder ID from standard Drive folder link', () => {
  const res = parseDriveFolderId(DEFAULT_DRIVE_FOLDER_URL);
  assert.equal(res.folderId, DEFAULT_DRIVE_FOLDER_ID);
  assert.equal(res.error, null);
});

test('parseDriveFolderId extracts folder ID from multi-account and query links', () => {
  const uLink = parseDriveFolderId(
    'https://drive.google.com/drive/u/1/folders/16vQib85qlNyF0EFmzPVSY6EoRIdAZWQf'
  );
  assert.equal(uLink.folderId, DEFAULT_DRIVE_FOLDER_ID);
  assert.equal(uLink.error, null);

  const queryLink = parseDriveFolderId(
    'https://drive.google.com/open?id=16vQib85qlNyF0EFmzPVSY6EoRIdAZWQf'
  );
  assert.equal(queryLink.folderId, DEFAULT_DRIVE_FOLDER_ID);
  assert.equal(queryLink.error, null);
});

test('parseDriveFolderId rejects empty or non-folder URLs without silent fallback', () => {
  const empty = parseDriveFolderId('   ');
  assert.equal(empty.folderId, null);
  assert.ok(empty.error);

  const badUrl = parseDriveFolderId('https://example.com/not-a-drive-folder');
  assert.equal(badUrl.folderId, null);
  assert.ok(badUrl.error);

  const shortStr = parseDriveFolderId('abc123');
  assert.equal(shortStr.folderId, null);
  assert.ok(shortStr.error);
});

test('classifyWorkflowFile distinguishes Google Docs, scripts, and configs', () => {
  assert.equal(
    classifyWorkflowFile('剪辑规范', 'application/vnd.google-apps.document'),
    'prose'
  );
  assert.equal(classifyWorkflowFile('auto_cut.py', 'text/x-python'), 'script');
  assert.equal(classifyWorkflowFile('pipeline.json', 'application/json'), 'config');
  assert.equal(
    classifyWorkflowFile('参数表', 'application/vnd.google-apps.spreadsheet'),
    'config'
  );
  assert.equal(classifyWorkflowFile('raw.mp4', 'video/mp4'), 'other');
});

test('detectStaticLogicIssues catches unguarded thresholds, weak-AI timecodes, and missing script refs', () => {
  const findings = detectStaticLogicIssues([
    {
      id: 'f1',
      name: 'sop.md',
      path: 'sop.md',
      mimeType: 'text/markdown',
      kind: 'prose',
      content: '第一步调用 missing_audio_tool.py 完成去气口处理。',
      sizeBytes: 60,
      selected: true,
      source: 'local',
    },
    {
      id: 'f2',
      name: 'cut_ai.py',
      path: 'cut_ai.py',
      mimeType: 'text/x-python',
      kind: 'script',
      content: `
silence_thresh = -35
prompt = "请直接输出每个高光片段的毫秒起止时间码"
resp = openai.chat.completions.create(model="gpt-mini", messages=[{"role":"user","content":prompt}])
`,
      sizeBytes: 180,
      selected: true,
      source: 'local',
    },
  ]);

  const ruleCodes = new Set(findings.map((f) => f.ruleCode));
  assert.ok(ruleCodes.has('PROSE_SCRIPT_REF_MISSING'));
  assert.ok(ruleCodes.has('UNGUARDED_HARD_THRESHOLD'));
  assert.ok(ruleCodes.has('WEAK_AI_UNSTRUCTURED_TIMECODE'));
});

test('computeAuditMetrics calculates exact counts and pass rate on sample report', () => {
  const metrics = computeAuditMetrics(SAMPLE_AUDIT_REPORT);
  assert.equal(metrics.totalIssues, SAMPLE_AUDIT_REPORT.hardLogicIssues.length);
  assert.equal(
    metrics.criticalCount + metrics.highCount + metrics.mediumCount,
    metrics.totalIssues
  );
  assert.equal(metrics.totalAlignments, SAMPLE_AUDIT_REPORT.alignments.length);
  assert.ok(metrics.alignmentPassRate >= 0 && metrics.alignmentPassRate <= 100);
  assert.equal(
    metrics.deterministicCount + metrics.guardrailedCount + metrics.humanGateCount,
    SAMPLE_AUDIT_REPORT.objectificationMatrix.length
  );
});

test('buildRefactoringMarkdown outputs all required refactoring sections', () => {
  const md = buildRefactoringMarkdown(SAMPLE_AUDIT_REPORT, 'Demo Folder');
  assert.ok(md.includes('## 一、核心诊断摘要与“剪辑客观化”可行性结论'));
  assert.ok(md.includes('## 二、硬逻辑漏洞分析'));
  assert.ok(md.includes('## 三、文字逻辑与脚本逻辑对齐审计'));
  assert.ok(md.includes('## 四、“剪辑客观化”三层分层矩阵与边界治理'));
  assert.ok(md.includes('## 五、重构后可执行工作流架构'));
  assert.ok(SAMPLE_WORKFLOW_FILES.length >= 4);
});

test('diagnoseDriveApiError distinguishes insufficient scope, disabled API, and folder permission 403s', () => {
  const scopeErr = diagnoseDriveApiError(
    403,
    JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ reason: 'insufficientPermissions' }],
      },
    })
  );
  assert.equal(scopeErr.kind, 'scope_missing');
  assert.equal(scopeErr.needsReconsent, true);

  const apiErr = diagnoseDriveApiError(
    403,
    JSON.stringify({
      error: {
        code: 403,
        message: 'Google Drive API has not been used in project 123 before or it is disabled.',
        errors: [{ reason: 'accessNotConfigured' }],
      },
    })
  );
  assert.equal(apiErr.kind, 'api_disabled');
  assert.equal(apiErr.needsReconsent, false);

  const forbiddenErr = diagnoseDriveApiError(
    403,
    JSON.stringify({
      error: {
        code: 403,
        message: 'The user does not have sufficient permissions for this file.',
        errors: [{ reason: 'forbidden' }],
      },
    })
  );
  assert.equal(forbiddenErr.kind, 'no_folder_access');
  assert.ok(forbiddenErr.detail.includes('sufficient permissions'));
});
