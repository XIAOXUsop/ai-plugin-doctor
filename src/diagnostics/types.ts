export type DiagnosticClient = "codex" | "claude" | "cursor" | "vscode";
export type EvidenceKind = "file" | "cli-config" | "controlled-replay" | "native-service" | "native-session";
export type Confidence = "confirmed" | "inferred" | "possible" | "unknown";
export type JsonPath = Array<string | number>;
export interface ScanOptions {
  workspace: string;
  home?: string;
  clients?: DiagnosticClient[];
  profile?: string | null;
  codexHome?: string;
  claudeConfigDir?: string;
  vscodeConfig?: string;
  location?: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  codexSystemDir?: string;
  claudeManagedDir?: string;
  launchOverrides?: boolean;
  surfaces?: Partial<Record<DiagnosticClient, string>>;
  clientVersions?: Partial<Record<DiagnosticClient, string>>;
}
export interface ScanContext {
  workspace: string;
  home: string;
  clients: DiagnosticClient[];
  profile: string | null;
  codexHome: string;
  claudeConfigDir: string;
  vscodeConfig: string;
  location: "local" | "remote";
  platform: string;
  codexSystemDir: string;
  claudeManagedDir: string;
  launchOverrides: boolean;
  surfaces: Partial<Record<DiagnosticClient, string>>;
  clientVersions: Partial<Record<DiagnosticClient, string>>;
}
export interface ConfigSource {
  id: string;
  client: DiagnosticClient;
  scope: string;
  path: string;
  format: "json" | "jsonc" | "toml";
  state: "missing" | "readable" | "unreadable" | "invalid" | "unsafe";
  contentHash: string | null;
  editable: boolean;
  issues: string[];
  priority: number;
  included: boolean;
}
export interface FieldOrigin { field: string; sourceId: string; keyPath: JsonPath; location?: { offset: number; line: number; column: number } | null; overridden?: Array<{ sourceId: string; keyPath: JsonPath }> }
export interface DiagnosticServer {
  id: string;
  client: DiagnosticClient;
  name: string;
  sourceId: string;
  keyPath: JsonPath;
  transport: "stdio" | "http" | "sse" | "ws" | "unknown";
  enabled: boolean | null;
  commandPresent: boolean;
  resolvedExecutable: string | null;
  argumentCount: number;
  cwd: string | null;
  origin: string | null;
  variables: Array<{ name: string; field: string; status: "present-in-scanner" | "missing-in-scanner" | "client-input" | "unsupported-dialect" | "unobserved" }>;
  origins: FieldOrigin[];
  shadowedSources: string[];
  state: "inferred" | "not-loaded" | "unknown";
}
export interface Finding {
  id: string;
  code: string;
  client: DiagnosticClient;
  serverId: string | null;
  sourceId: string | null;
  keyPath: JsonPath | null;
  severity: "error" | "warning" | "info";
  confidence: Confidence;
  evidenceKind: EvidenceKind;
  title: string;
  detail: string;
  nextStep: string;
  repair: "variable" | "command" | "cwd" | "transport" | "root" | null;
  location?: { offset: number; line: number; column: number } | null;
  rule?: RuleDefinition;
}
export interface RuleDefinition { id: string; applicableVersions: string[]; precondition: string; impact: string; recheck: string; counterexample: string; versionStatus: "verified" | "documented" | "unknown" | "independent" }
export interface ScanReport {
  schemaVersion: 1;
  kind: "configuration-scan";
  createdAt: string;
  context: ScanContext;
  sources: ConfigSource[];
  servers: DiagnosticServer[];
  findings: Finding[];
  comparisons: Array<{ name: string; serverIds: string[]; relation: "candidate" | "confirmed"; differingFields: string[]; credentialRelation: "equal" | "different" | "unknown" }>;
  mapping?: { path: string; contentHash: string | null; state: ConfigSource["state"] };
  network?: import("./network.js").NetworkObservation[];
  observations: Array<{ client: DiagnosticClient; version: string | null; versionSource:"declared"|"package-metadata"|"unobserved"; executable: string | null; evidenceKind: "file"; status: "scanner-context-only" }>;
  notes: string[];
}
export interface EvidenceReport {
  schemaVersion: 1;
  kind: "configuration-check";
  createdAt: string;
  client: DiagnosticClient;
  serverId: string;
  evidenceKind: EvidenceKind;
  status: "PASS" | "FAIL" | "UNKNOWN" | "UNSUPPORTED";
  reason: string;
  toolCount?: number;
  tools?: string[];
  limitations: string[];
  authTarget?: "model" | "mcp" | "unclassified";
  observedVersion?: string | null;
}
export interface RepairEdit { sourceId: string; path: string; format: ConfigSource["format"]; beforeHash: string; keyPath: JsonPath; action: "set" | "move-root"; repair: NonNullable<Finding["repair"]>; value?: string; destination?: string }
export interface RepairPlan {
  schemaVersion: 1;
  kind: "configuration-repair-plan";
  id: string;
  createdAt: string;
  context: ScanContext;
  findings: Array<{ id: string; code: string; serverId: string | null; sourceId: string | null }>;
  edits: RepairEdit[];
  sourceVersions: Array<{ path: string; format: ConfigSource["format"]; state: ConfigSource["state"]; contentHash: string | null }>;
  manualSteps: string[];
  limits: string[];
  mappingVersion?: ScanReport["mapping"];
  manualPatches?: Array<{ path: string; keyPath: JsonPath; snippet: string; action: string }>;
}
export interface RepairOperation {
  schemaVersion: 1;
  kind: "configuration-repair-operation";
  id: string;
  plan: RepairPlan;
  status: "applied" | "rolled-back" | "conflict";
  createdAt: string;
  files: Array<{ path: string; backup: string; beforeHash: string; afterHash: string }>;
  verification?: { configuration: "PASS" | "FAIL"; nativeSession: "UNKNOWN"; reason: string };
}
