import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_NAME = 'gemini-4-hydrogen';

interface GithubSession {
  accessToken: string;
  user: {
    login: string;
    avatar_url: string;
    html_url: string;
    name?: string;
  };
  createdAt: number;
}

const githubSessions = new Map<string, GithubSession>();
const githubOauthStates = new Map<string, number>();

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const val = decodeURIComponent(part.slice(idx + 1).trim());
      result[key] = val;
    }
  }
  return result;
}

function getGithubSession(req: express.Request): GithubSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['cutlogic_gh_sid'];
  if (!sid) return null;
  return githubSessions.get(sid) || null;
}

function getBaseAppUrl(req: express.Request): string {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured && configured !== 'MY_APP_URL') {
    return configured;
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 未配置，请在 Settings > Secrets 面板检查 API Key。');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const WORKFLOW_AUDIT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    workflowTitle: { type: Type.STRING },
    executiveSummary: { type: Type.STRING },
    feasibilityVerdict: {
      type: Type.STRING,
      description:
        'Must be one of: feasible_with_architecture, partially_feasible, needs_redesign',
    },
    feasibilityConclusion: { type: Type.STRING },
    weakAiPrinciples: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    hardLogicIssues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          severity: { type: Type.STRING, description: 'critical | high | medium' },
          category: {
            type: Type.STRING,
            description:
              '循环依赖与状态死锁 | 前后置契约断裂 | 时间轴与帧率假设冲突 | 弱AI能力错配 | 异常与边界黑洞',
          },
          stepRef: { type: Type.STRING },
          fileRefs: { type: Type.ARRAY, items: { type: Type.STRING } },
          evidenceQuote: { type: Type.STRING },
          rootCause: { type: Type.STRING },
          impact: { type: Type.STRING },
          fixStrategy: { type: Type.STRING },
        },
        required: [
          'id',
          'title',
          'severity',
          'category',
          'stepRef',
          'fileRefs',
          'evidenceQuote',
          'rootCause',
          'impact',
          'fixStrategy',
        ],
      },
    },
    alignments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          ruleName: { type: Type.STRING },
          proseSource: { type: Type.STRING },
          proseRule: { type: Type.STRING },
          scriptSource: { type: Type.STRING },
          scriptBehavior: { type: Type.STRING },
          status: {
            type: Type.STRING,
            description:
              'matched | drifted | missing_in_script | inverted | hardcoded_override',
          },
          discrepancyDetail: { type: Type.STRING },
          recommendation: { type: Type.STRING },
        },
        required: [
          'id',
          'ruleName',
          'proseSource',
          'proseRule',
          'scriptSource',
          'scriptBehavior',
          'status',
          'discrepancyDetail',
          'recommendation',
        ],
      },
    },
    objectificationMatrix: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          editingTask: { type: Type.STRING },
          tier: {
            type: Type.STRING,
            description: 'deterministic | probabilistic_guardrailed | human_gate',
          },
          currentAssumption: { type: Type.STRING },
          whyBoundaryFails: { type: Type.STRING },
          weakAiRisk: { type: Type.STRING },
          recommendedMechanism: { type: Type.STRING },
          fallbackRule: { type: Type.STRING },
        },
        required: [
          'id',
          'editingTask',
          'tier',
          'currentAssumption',
          'whyBoundaryFails',
          'weakAiRisk',
          'recommendedMechanism',
          'fallbackRule',
        ],
      },
    },
    edgeCases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          scenario: { type: Type.STRING },
          triggerCondition: { type: Type.STRING },
          currentFailureMode: { type: Type.STRING },
          guardrailSolution: { type: Type.STRING },
          affectedStage: { type: Type.STRING },
        },
        required: [
          'id',
          'scenario',
          'triggerCondition',
          'currentFailureMode',
          'guardrailSolution',
          'affectedStage',
        ],
      },
    },
    legacyPipeline: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          summary: { type: Type.STRING },
          issueIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          nextIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['id', 'name', 'summary', 'issueIds', 'nextIds'],
      },
    },
    refactoredPipeline: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          order: { type: Type.INTEGER },
          name: { type: Type.STRING },
          layer: {
            type: Type.STRING,
            description: 'ingest | deterministic | ai_assisted | human_gate | render',
          },
          owner: { type: Type.STRING, description: 'script | weak_ai | human' },
          inputs: { type: Type.ARRAY, items: { type: Type.STRING } },
          outputs: { type: Type.ARRAY, items: { type: Type.STRING } },
          contractSchema: { type: Type.STRING },
          fallbackPolicy: { type: Type.STRING },
          replacesLegacySteps: { type: Type.ARRAY, items: { type: Type.STRING } },
          weakAiAdaptation: { type: Type.STRING },
        },
        required: [
          'id',
          'order',
          'name',
          'layer',
          'owner',
          'inputs',
          'outputs',
          'contractSchema',
          'fallbackPolicy',
          'replacesLegacySteps',
          'weakAiAdaptation',
        ],
      },
    },
    refactoredSopNotes: { type: Type.STRING },
  },
  required: [
    'workflowTitle',
    'executiveSummary',
    'feasibilityVerdict',
    'feasibilityConclusion',
    'weakAiPrinciples',
    'hardLogicIssues',
    'alignments',
    'objectificationMatrix',
    'edgeCases',
    'legacyPipeline',
    'refactoredPipeline',
    'refactoredSopNotes',
  ],
};

const WORKFLOW_BUNDLE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    versionTag: { type: Type.STRING },
    releaseNotes: { type: Type.STRING },
    files: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          description: { type: Type.STRING },
          content: { type: Type.STRING },
        },
        required: ['path', 'description', 'content'],
      },
    },
  },
  required: ['versionTag', 'releaseNotes', 'files'],
};

function formatErrorResponse(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return {
      status: 403,
      message: 'Gemini API 密钥无效或权限不足，请在 Settings > Secrets 面板检查配置。',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message: '当前 API 配额已达上限，请稍后重试或在 Settings > Secrets 面板检查计费密钥。',
    };
  }
  return {
    status: 500,
    message: raw || '服务器分析工作流时发生未知错误。',
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: MODEL_NAME });
  });

  // --- GitHub OAuth & Repository Publishing Routes ---
  app.get('/api/github/status', (req, res) => {
    const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
    const configured =
      Boolean(clientId && clientSecret) &&
      clientId !== 'MY_GITHUB_CLIENT_ID' &&
      clientSecret !== 'MY_GITHUB_CLIENT_SECRET';
    const session = getGithubSession(req);
    const callbackUrl = `${getBaseAppUrl(req)}/auth/github/callback`;
    res.json({
      configured,
      authenticated: Boolean(session),
      user: session?.user || null,
      callbackUrl,
    });
  });

  app.get('/api/github/auth-url', (req, res) => {
    const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
    const callbackUrl = `${getBaseAppUrl(req)}/auth/github/callback`;

    if (
      !clientId ||
      !clientSecret ||
      clientId === 'MY_GITHUB_CLIENT_ID' ||
      clientSecret === 'MY_GITHUB_CLIENT_SECRET'
    ) {
      res.status(400).json({
        error:
          '尚未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 环境变量，无法发起 GitHub OAuth 授权。',
        callbackUrl,
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    githubOauthStates.set(state, Date.now());
    // Clean expired states (>10 min)
    const now = Date.now();
    for (const [k, ts] of githubOauthStates.entries()) {
      if (now - ts > 10 * 60 * 1000) githubOauthStates.delete(k);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'repo',
      state,
    });
    res.json({
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
      callbackUrl,
    });
  });

  const handleGithubCallback = async (req: express.Request, res: express.Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';

      if (!code || !state || !githubOauthStates.has(state)) {
        res.status(400).send('<p>GitHub OAuth state 校验失败或已过期，请关闭窗口后重试。</p>');
        return;
      }
      githubOauthStates.delete(state);

      const clientId = process.env.GITHUB_CLIENT_ID!;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET!;
      const callbackUrl = `${getBaseAppUrl(req)}/auth/github/callback`;

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error_description?: string;
      };
      if (!tokenData.access_token) {
        res
          .status(400)
          .send(`<p>GitHub 换取令牌失败：${tokenData.error_description || '未知错误'}</p>`);
        return;
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CutLogic-Workbench',
        },
      });
      if (!userRes.ok) {
        res.status(400).send('<p>无法读取 GitHub 用户资料，请重试。</p>');
        return;
      }
      const ghUser = (await userRes.json()) as {
        login: string;
        avatar_url: string;
        html_url: string;
        name?: string;
      };

      const sid = crypto.randomBytes(24).toString('hex');
      githubSessions.set(sid, {
        accessToken: tokenData.access_token,
        user: {
          login: ghUser.login,
          avatar_url: ghUser.avatar_url,
          html_url: ghUser.html_url,
          name: ghUser.name,
        },
        createdAt: Date.now(),
      });

      res.cookie('cutlogic_gh_sid', sid, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.send(`<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 24px;">
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'GITHUB_OAUTH_SUCCESS' }, '*');
        window.close();
      } else {
        window.location.href = '/';
      }
    </script>
    <p>GitHub 授权成功，窗口将自动关闭…</p>
  </body>
</html>`);
    } catch (err) {
      res
        .status(500)
        .send(`<p>GitHub 回调异常：${err instanceof Error ? err.message : '未知错误'}</p>`);
    }
  };

  app.get(['/auth/github/callback', '/auth/github/callback/'], handleGithubCallback);

  app.post('/api/github/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies['cutlogic_gh_sid']) {
      githubSessions.delete(cookies['cutlogic_gh_sid']);
    }
    res.clearCookie('cutlogic_gh_sid', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    });
    res.json({ ok: true });
  });

  app.get('/api/github/repos', async (req, res) => {
    const session = getGithubSession(req);
    if (!session) {
      res.status(401).json({ error: '请先连接 GitHub 账号。' });
      return;
    }
    try {
      const ghRes = await fetch(
        'https://api.github.com/user/repos?sort=updated&per_page=30&affiliation=owner,collaborator',
        {
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'CutLogic-Workbench',
          },
        }
      );
      if (!ghRes.ok) {
        const errText = await ghRes.text();
        res.status(ghRes.status).json({ error: `获取仓库列表失败：${errText.slice(0, 160)}` });
        return;
      }
      const repos = (await ghRes.json()) as Array<{
        full_name: string;
        name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
        html_url: string;
      }>;
      res.json({
        repos: repos.map((r) => ({
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          defaultBranch: r.default_branch,
          isPrivate: r.private,
          htmlUrl: r.html_url,
        })),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '请求 GitHub 仓库列表失败。',
      });
    }
  });

  app.post('/api/github/publish', async (req, res) => {
    const session = getGithubSession(req);
    if (!session) {
      res.status(401).json({ error: '请先连接 GitHub 账号后再上传。' });
      return;
    }

    const { owner, repo, branch, basePath, commitMessage, files } = req.body as {
      owner?: string;
      repo?: string;
      branch?: string;
      basePath?: string;
      commitMessage?: string;
      files?: Array<{ path: string; content: string }>;
    };

    if (!owner || !repo || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: '缺少目标仓库名或待上传的工作流文件列表。' });
      return;
    }

    const cleanPrefix = (basePath || 'cutlogic-workflow-v2').replace(/^\/+|\/+$/g, '');
    const targetBranch = (branch || 'main').trim();
    const committed: Array<{ path: string; htmlUrl?: string }> = [];

    try {
      for (const file of files) {
        const cleanRel = file.path.replace(/^\/+/, '').replace(/\.\./g, '');
        const fullPath = cleanPrefix ? `${cleanPrefix}/${cleanRel}` : cleanRel;
        const encodedPath = fullPath
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');

        // Check existing SHA so we can cleanly update if file exists
        let existingSha: string | undefined;
        const getRes = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(targetBranch)}`,
          {
            headers: {
              Authorization: `Bearer ${session.accessToken}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'CutLogic-Workbench',
            },
          }
        );
        if (getRes.ok) {
          const existing = (await getRes.json()) as { sha?: string };
          existingSha = existing.sha;
        }

        const putRes = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${session.accessToken}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'CutLogic-Workbench',
            },
            body: JSON.stringify({
              message: commitMessage || `chore(workflow): upload refactored editing workflow (${fullPath})`,
              content: Buffer.from(file.content, 'utf8').toString('base64'),
              branch: targetBranch,
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          }
        );

        if (!putRes.ok) {
          const errBody = await putRes.text();
          res.status(putRes.status).json({
            error: `上传 ${fullPath} 失败 (${putRes.status})：${errBody.slice(0, 200)}`,
          });
          return;
        }

        const putJson = (await putRes.json()) as {
          content?: { html_url?: string };
        };
        committed.push({ path: fullPath, htmlUrl: putJson.content?.html_url });
      }

      res.json({
        ok: true,
        repoUrl: `https://github.com/${owner}/${repo}/tree/${targetBranch}/${cleanPrefix}`,
        committed,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '推送工作流文件到 GitHub 失败。',
      });
    }
  });

  app.post('/api/analyze-workflow', async (req, res) => {
    try {
      const { files, userContext, folderName, sourceMode } = req.body as {
        files?: Array<{
          name: string;
          path: string;
          kind: string;
          content: string;
        }>;
        userContext?: string;
        folderName?: string;
        sourceMode?: 'drive_ai' | 'local_ai';
      };

      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: '请至少选择一个包含文本或脚本内容的工作流文件。' });
        return;
      }

      const validFiles = files.filter((f) => typeof f.content === 'string' && f.content.trim().length > 0);
      if (validFiles.length === 0) {
        res.status(400).json({ error: '所选文件均为空或无法读取纯文本内容，无法执行逻辑分析。' });
        return;
      }

      const corpusParts: string[] = [];
      let totalChars = 0;
      const MAX_TOTAL_CHARS = 180000;

      for (const file of validFiles) {
        const header = `\n===== FILE: ${file.path || file.name} (TYPE: ${file.kind}) =====\n`;
        const remaining = MAX_TOTAL_CHARS - totalChars - header.length;
        if (remaining <= 200) break;
        const body =
          file.content.length > remaining
            ? file.content.slice(0, remaining) + '\n... [truncated]'
            : file.content;
        corpusParts.push(header + body);
        totalChars += header.length + body.length;
      }

      const systemInstruction = `你是一位资深视频后期自动化架构师、编译原理与工作流逻辑审计专家，同时深度理解弱/中等能力 LLM 在自动化管线中的真实失效模式。

用户的核心诉求：
1. 先分析（Analysis）其剪辑工作流的硬逻辑问题（前后置依赖断裂、时间轴坐标系错位、循环依赖、隐含假设冲突、无兜底异常等）。
2. 逐项梳理“文字逻辑（用户口述/文档规范）”与“脚本逻辑（实际代码/配置/Prompt）”是否匹配，精准指出语义漂移、逻辑倒置、脚本缺失或硬编码覆盖。
3. 深度评估用户“将剪辑客观化”这条路线在实操上是否可行，为什么会出现大量边界问题，并将每个剪辑动作严谨划分为三层：
   - deterministic（可完全客观化、应由确定性脚本接管）
   - probabilistic_guardrailed（半客观化、弱 AI 只做结构化初筛 + 置信度护栏与降级兜底）
   - human_gate（必须保留轻量人工决策门控的主观边界）
4. 针对“自动化 AI 能力不足”这一核心现实约束，彻底重构工作流逻辑：
   - 严禁让弱 AI 直接算时间码或一次性耦合多项主观判断；
   - 强制非破坏性统一坐标系、分块原子 ID 契约、严格 JSON Schema 与保守降级策略；
   - 输出清晰的新旧流程对比与可直接落地的重构步骤。

要求：
- 所有结论必须严格基于用户提供的真实文件内容，直接引用具体文件名、步骤名、变量名或原话作为 evidenceQuote，绝不空泛说教。
- 全程使用简体中文，表达精准、克制、工程化。`;

      const userPrompt = `请对以下来自「${folderName || '用户剪辑工作流目录'}」的 ${validFiles.length} 个工作流文件进行全面逻辑分析与工作流重构。

${userContext ? `用户补充背景：\n${userContext}\n` : ''}
工作流文件内容如下：
${corpusParts.join('\n')}`;

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: userPrompt,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: 'application/json',
          responseSchema: WORKFLOW_AUDIT_SCHEMA,
        },
      });

      const rawText = (response.text || '').trim();
      if (!rawText) {
        throw new Error('模型未返回有效分析内容，请稍后重试。');
      }

      const parsed = JSON.parse(rawText);
      res.json({
        ...parsed,
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        sourceMode: sourceMode || 'drive_ai',
        analyzedFileCount: validFiles.length,
      });
    } catch (err) {
      const formatted = formatErrorResponse(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/generate-workflow-bundle', async (req, res) => {
    try {
      const { report, files } = req.body as {
        report?: Record<string, unknown>;
        files?: Array<{ name: string; path: string; kind: string; content: string }>;
      };

      if (!report) {
        res.status(400).json({ error: '缺少审计报告上下文，请先完成工作流分析。' });
        return;
      }

      const fileSummaries = (files || [])
        .slice(0, 12)
        .map((f) => `### ${f.path || f.name} (${f.kind})\n${f.content.slice(0, 4500)}`)
        .join('\n\n');

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `请基于以下剪辑工作流审计报告与原始文件，生成一套**可直接投入使用、无硬逻辑冲突、专为弱自动化 AI 做了防御性降级改造**的完整工作流版本包。

必须包含以下 4 个文件（路径严格如下）：
1. README.md — 重构版剪辑工作流总览、客观化三层边界说明、目录结构与运行步骤。
2. config/workflow_v2_config.json — 合法的 JSON 配置文件，消除文字与脚本参数打架，包含自适应底噪留白、三态置信度阈值（keep/drop/review）、max_retries=1 有界迭代及 BGM 区间吸附参数。
3. prompts/weak_ai_atomic_prompts.md — 将原工作流耦合 AI 任务拆分后的单职责原子 Prompt 模板，每个 Prompt 强制要求仅基于 segment_id 输出严格 JSON Schema，附边界 Few-shot 示例。
4. scripts/run_workflow_v2.py — 可直接运行的 Python 3 编排与校验脚本（使用标准库即可运行校验流程，含母带非破坏性坐标结构、转折词停顿保护、JSON Schema 强校验、缺失 ID 自动保守回填 Keep 与人工复核清单导出）。

审计报告（JSON）：
${JSON.stringify(report).slice(0, 35000)}

原始参考文件：
${fileSummaries}`,
        config: {
          systemInstruction:
            '你是视频剪辑自动化流水线首席架构师。请输出完整、严谨、可直接提交到 GitHub 仓库或保存到 Google Drive 使用的生产级工作流版本包，所有代码与 JSON 必须语法合法。',
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: 'application/json',
          responseSchema: WORKFLOW_BUNDLE_SCHEMA,
        },
      });

      const rawText = (response.text || '').trim();
      if (!rawText) {
        throw new Error('模型未返回工作流版本包，请重试。');
      }
      const parsed = JSON.parse(rawText);
      res.json({
        ...parsed,
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    } catch (err) {
      const formatted = formatErrorResponse(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/rewrite-artifact', async (req, res) => {
    try {
      const { artifactType, report, files } = req.body as {
        artifactType?: 'refactored_sop' | 'weak_ai_prompts' | 'validator_script';
        report?: Record<string, unknown>;
        files?: Array<{ name: string; path: string; kind: string; content: string }>;
      };

      if (!artifactType || !report) {
        res.status(400).json({ error: '缺少生成目标类型或审计报告上下文。' });
        return;
      }

      const artifactPrompts: Record<string, string> = {
        refactored_sop:
          '请基于审计报告与原文件，重写一份严谨、无逻辑矛盾、可直接给团队和脚本对照执行的《重构版剪辑客观化工作流规范（Markdown）》，明确标注每一步的输入契约、阈值护栏与人工复核门控。',
        weak_ai_prompts:
          '请针对“弱自动化 AI 能力不足”的限制，将原工作流中耦合过重的 AI 环节拆解为 2~3 个单职责原子 Prompt 模板，每个模板都必须附带严格的 JSON Output Schema、Few-shot 边界示例以及解析失败时的降级规则。',
        validator_script:
          '请编写一份可直接运行的 Python 校验与编排骨架脚本（含 dataclass / JSON schema 校验、母带时间轴映射、置信度三态分流 Keep/Drop/Review 及保守降级逻辑），用来替代原工作流中存在硬逻辑冲突的脚本层。',
      };

      const fileSummaries = (files || [])
        .slice(0, 12)
        .map((f) => `### ${f.path || f.name} (${f.kind})\n${f.content.slice(0, 4500)}`)
        .join('\n\n');

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `${artifactPrompts[artifactType] || artifactPrompts.refactored_sop}

审计报告摘要（JSON）：
${JSON.stringify(report).slice(0, 35000)}

原始工作流参考文件：
${fileSummaries}`,
        config: {
          systemInstruction:
            '你是视频剪辑自动化流水线架构师。输出高质量、无废话、可直接复制落地的简体中文工程文档或代码。',
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        },
      });

      res.json({
        artifactType,
        content: response.text || '',
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    } catch (err) {
      const formatted = formatErrorResponse(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CutLogic server listening on http://localhost:${PORT}`);
  });
}

startServer();
