export type WorkflowFileKind = 'prose' | 'script' | 'config' | 'other';

export interface WorkflowFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: WorkflowFileKind;
  content: string;
  sizeBytes: number;
  modifiedTime?: string;
  selected: boolean;
  source: 'drive' | 'local' | 'sample';
  truncated?: boolean;
  readWarning?: string;
}

export type IssueSeverity = 'critical' | 'high' | 'medium';

export interface HardLogicIssue {
  id: string;
  title: string;
  severity: IssueSeverity;
  category:
    | '循环依赖与状态死锁'
    | '前后置契约断裂'
    | '时间轴与帧率假设冲突'
    | '弱AI能力错配'
    | '异常与边界黑洞';
  stepRef: string;
  fileRefs: string[];
  evidenceQuote: string;
  rootCause: string;
  impact: string;
  fixStrategy: string;
}

export type AlignmentStatus =
  | 'matched'
  | 'drifted'
  | 'missing_in_script'
  | 'inverted'
  | 'hardcoded_override';

export interface TextScriptAlignmentItem {
  id: string;
  ruleName: string;
  proseSource: string;
  proseRule: string;
  scriptSource: string;
  scriptBehavior: string;
  status: AlignmentStatus;
  discrepancyDetail: string;
  recommendation: string;
}

export type ObjectificationTier =
  | 'deterministic'
  | 'probabilistic_guardrailed'
  | 'human_gate';

export interface ObjectificationDimension {
  id: string;
  editingTask: string;
  tier: ObjectificationTier;
  currentAssumption: string;
  whyBoundaryFails: string;
  weakAiRisk: string;
  recommendedMechanism: string;
  fallbackRule: string;
}

export interface EdgeCaseItem {
  id: string;
  scenario: string;
  triggerCondition: string;
  currentFailureMode: string;
  guardrailSolution: string;
  affectedStage: string;
}

export interface LegacyStageNode {
  id: string;
  name: string;
  summary: string;
  issueIds: string[];
  nextIds: string[];
}

export interface PipelineStage {
  id: string;
  order: number;
  name: string;
  layer: 'ingest' | 'deterministic' | 'ai_assisted' | 'human_gate' | 'render';
  owner: 'script' | 'weak_ai' | 'human';
  inputs: string[];
  outputs: string[];
  contractSchema: string;
  fallbackPolicy: string;
  replacesLegacySteps: string[];
  weakAiAdaptation: string;
}

export interface WorkflowAuditReport {
  workflowTitle: string;
  executiveSummary: string;
  feasibilityVerdict: 'feasible_with_architecture' | 'partially_feasible' | 'needs_redesign';
  feasibilityConclusion: string;
  weakAiPrinciples: string[];
  hardLogicIssues: HardLogicIssue[];
  alignments: TextScriptAlignmentItem[];
  objectificationMatrix: ObjectificationDimension[];
  edgeCases: EdgeCaseItem[];
  legacyPipeline: LegacyStageNode[];
  refactoredPipeline: PipelineStage[];
  refactoredSopNotes: string;
  generatedAt: string;
  sourceMode: 'drive_ai' | 'local_ai' | 'sample';
  analyzedFileCount: number;
}

export interface StaticPrecheckFinding {
  id: string;
  fileName: string;
  ruleCode: string;
  severity: IssueSeverity;
  message: string;
  snippet: string;
}

export type ActiveTab =
  | 'delivery'
  | 'logic'
  | 'alignment'
  | 'objectification'
  | 'sources'
  | 'refactor';
