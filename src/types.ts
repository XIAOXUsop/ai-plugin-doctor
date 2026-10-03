export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "SKIP";
export type ClientName = "codex" | "claude";

export interface ServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface CaseConfig {
  id: string;
  prompt: string;
  expect: {
    tool?: string;
    arguments?: Record<string, unknown>;
    argumentsContains?: Record<string, string>;
    noToolCalls?: boolean;
    forbiddenTools?: string[];
    finalContains?: string;
    toolError?: boolean;
  };
  trials?: number;
}
export interface DoctorConfig {
  schemaVersion: 1;
  manifestPath?: string;
  server: ServerConfig;
  clients: ClientName[];
  cases: CaseConfig[];
  approvedTools?: string[];
  codexModel?: string;
  claudeModel?: string;
  probeCall?: { tool: string; arguments?: Record<string, unknown> };
  timeoutMs?: number;
  maxClaudeBudgetUsd?: number;
  proxyUrl?: string;
}
export interface LayerResult {
  verdict: Verdict;
  reason: string;
  evidence: string[];
}
export interface TrialResult {
  id: string;
  runId?: string;
  caseId: string;
  client: ClientName;
  clientVersion: string;
  clientExecutable?: string;
  modelId: string | null;
  modelCostUsd?: number | null;
  protocolVersion?: string | null;
  reproduceCommand?: string;
  errorCode?: string | null;
  fixHint?: string | null;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  finalAnswer: string;
  layers: { E0: LayerResult; E1: LayerResult; E2: LayerResult; E3: LayerResult; E4: LayerResult };
  files: Record<string, string>;
  evidenceHashes: Record<string, string>;
}
export interface RunReport {
  schemaVersion: 1;
  runEvidenceHashes?: Record<string, string>;
  createdAt: string;
  configHash: string;
  serverHash: string;
  toolSurfaceHash?: string | null;
  manifestHash?: string | null;
  pluginVersion?: string | null;
  serverVersion?: string | null;
  protocolVersion: string | null;
  trials: TrialResult[];
  notes: string[];
}
