export interface NodeRecord extends Connection {
  id: string;
  name: string;
  region?: string;
  tags?: string[];
  coreId?: string;
  coreVersion?: string;
  status?: string;
}
export interface UserRecord {
  id: string;
  name: string;
  enabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  expiresAt?: string;
  serviceId?: string;
  onlineIPLimit?: number;
  rateLimitBps?: number;
  resetPolicy?: ResetPolicy;
}
export interface RouteRecord {
  id: string;
  name: string;
  hops: string[];
  engine: string;
  userIds: string[];
  nameTemplate?: string;
  rateMicros?: number;
}
export interface Artifact {
  path: string;
  content: string;
}
export interface Revision {
  id: string;
  routeId: string;
  engine: string;
  status: string;
  createdAt: string;
  artifacts: Artifact[];
  digest: string;
  nativeChecked?: boolean;
}
export interface Capability {
  id: string;
  name: string;
  protocols: string[];
  maxHops: number;
}
export interface State {
  publishedRoutes?: { id: string; name: string; status: string }[];
  nodes: NodeRecord[];
  users: UserRecord[];
  routes: RouteRecord[];
  revisions: Revision[];
  capabilities: Capability[];
  deploymentAvailable: boolean;
  services?: Service[];
  settings?: Record<string, unknown>;
}
export interface Validation {
  fingerprint?: string;
  valid: boolean;
  diagnostics: string[];
  artifacts: Artifact[];
  revision?: Revision;
  nativeChecked?: boolean;
}
export interface Session {
  user: {
    id: string;
    name: string;
    role: string;
    mfaEnabled?: boolean;
    passwordChangeRequired?: boolean;
  };
  csrfToken: string;
}
export interface ResetPolicy {
  mode: string;
  day?: number;
  days?: number;
  timezone?: string;
  anchor?: string;
}
export interface Service {
  id: string;
  name: string;
  quotaBytes: number;
  routeIds: string[];
  cycle: ResetPolicy;
  onlineIpLimit?: number;
  connectionLimit?: number;
  entryRateBps?: number;
}
export interface Overview {
  accountingPending?: boolean;
  status: string;
  quotaBytes: number;
  remainingBytes?: number;
  service?: Service;
  user: UserRecord;
  entitlement?: {
    status?: string;
    serviceName?: string;
    expiresAt?: string;
    quotaBytes?: number;
    onlineIPLimit?: number;
    rateLimitBps?: number;
  };
  usage: { rawBytes: number; weightedBytes: number; providerBytes?: number };
  cycle?: { start?: string; nextReset?: string; timezone?: string };
  routes: { id: string; name: string; rateMicros?: number }[];
}
export interface Connection {
  host: string;
  port: number;
  protocol: string;
  username?: string;
  password?: string;
  method?: string;
  uuid?: string;
  flow?: string;
  packetEncoding?: string;
  vmessSecurity?: string;
  tls?: {
    enabled: boolean;
    serverName?: string;
    fingerprint?: string;
    alpn?: string[];
    reality?: { publicKey: string; shortId: string };
  };
  transport?: {
    type: string;
    path?: string;
    host?: string;
    serviceName?: string;
    headers?: Record<string, string>;
    authority?: string;
  };
}
export interface ClientNode {
  id: string;
  name: string;
  ownerId?: string;
  origin?: string;
  connection: Connection;
  region?: string;
  tags?: string[];
  provenance?: { sourceId: string; snapshotId: string; endpointId: string }[];
}
export interface EndpointFilter {
  namePattern?: string;
  protocol?: string;
  region?: string;
  tags?: string[];
  sourceId?: string;
}
export interface PipelineStep {
  id: string;
  kind: string;
  enabled: boolean;
  filter?: EndpointFilter;
  template?: string;
  sortBy?: string;
  descending?: boolean;
  override?: { region?: string; tags?: string[]; host?: string; port?: number };
}
export interface SourceChange {
  beforeConnection?: string;
  afterConnection?: string;
  id: string;
  name: string;
  fields?: string[];
}
export interface SourceCandidate {
  id: string;
  createdAt: string;
  diff: {
    added: SourceChange[];
    removed: SourceChange[];
    connectionChanged: SourceChange[];
    renamed: SourceChange[];
    beforeCount: number;
    afterCount: number;
    reordered?: boolean;
  };
  affected: {
    kind: string;
    id: string;
    name: string;
    profileName?: string;
    reason: string;
  }[];
  diagnostics?: Array<string | { message?: string; code?: string }>;
}
export interface SourceApplyEvent {
  id: string;
  appliedAt: string;
  mode: "auto" | "manual";
  beforeCount: number;
  afterCount: number;
  added: number;
  removed: number;
  connectionChanged: number;
  renamed: number;
  reordered: boolean;
}
export interface Source {
  applyMode?: "auto" | "manual";
  applyHistory?: SourceApplyEvent[];
  revision?: string;
  candidate?: SourceCandidate;
  refreshStatus?: string;
  checkedAt?: string;
  id: string;
  name: string;
  kind: string;
  content?: string;
  url?: string;
  enabled: boolean;
  endpoints?: ClientNode[];
  snapshot?: { endpoints: ClientNode[] };
  nodeCount?: number;
  updatedAt?: string;
  lastSuccessAt?: string;
  diagnostics?: Array<
    string | { message?: string; code?: string; line?: number }
  >;
  lastError?: string;
  /** Server-owned, optional classification; unknown/legacy values use safe copy. */
  lastErrorCode?: string;
  format?: string;
  acceptPartial?: boolean;
}
export interface Collection {
  id: string;
  name: string;
  ownerId?: string;
  sources: { sourceId: string; steps: PipelineStep[] }[];
  steps: PipelineStep[];
}
export interface ActionRef {
  kind: string;
  ref?: string;
}
export interface Group {
  id: string;
  name: string;
  kind: string;
  members: ActionRef[];
  dynamic?: EndpointFilter;
  testUrl?: string;
  intervalSeconds?: number;
  toleranceMs?: number;
  strategy?: string;
}
export interface MatchExpression {
  op: string;
  value?: string;
  children?: MatchExpression[];
}
export interface Rule {
  id: string;
  match: MatchExpression;
  action: ActionRef;
}
export interface RuleResource {
  revisionToken?: string;
  acceptedVersion?: string;
  sizeBytes?: number;
  canRefresh?: boolean;
  acceptedAt?: string;
  refreshStatus?: string;
  lastRefreshError?: string;
  inspection?: string;
  id: string;
  name?: string;
  ownerId?: string;
  revision: string;
  digest: string;
  format: string;
  formatVersion?: number;
  behavior?: string;
  location: string;
  path?: string;
  url?: string;
  visibility?: string;
  updatePolicy: string;
  intervalSeconds?: number;
}
export interface Runtime {
  mixedPort?: number;
  dns?: {
    servers: { id: string; type: string; address: string; port?: number }[];
    final: string;
  };
  sniff?: boolean;
  tun?: { enabled: boolean; addresses?: string[]; autoRoute: boolean };
}
export interface NativeClientOverride {
  schemaVersion: "1";
  namespace: "routeweaver/native-client";
  target: { adapterId: string; version: string };
  format: "json" | "yaml";
  ruleMode: "prepend" | "append" | "replace";
  content: string;
}
export interface NativeOverrideReview {
  target: { adapterId: string; version: string };
  ruleMode: NativeClientOverride["ruleMode"];
  changedPaths: string[];
  replacedPaths: string[];
  nonportable: true;
  validation:
    "bounded-schema-and-references" | "upstream-json-schema-and-references";
}
export interface ProfileIR {
  schemaVersion: string;
  id: string;
  name: string;
  ownerId: string;
  revision: string;
  endpoints: ClientNode[];
  groups: Group[];
  rules: Rule[];
  resources: RuleResource[];
  defaultAction: ActionRef;
  runtime: Runtime;
  nativeOverride?: NativeClientOverride;
}
export interface Profile {
  revisionToken?: string;
  id: string;
  name: string;
  target: { adapterId: string; version: string };
  mode?: string;
  sourceIds?: string[];
  platformEntryIds?: string[];
  collectionId?: string;
  ir: ProfileIR;
  updatedAt?: string;
  revision?: number;
}
export type NodeChanges =
  | { version: 1; state: "unavailable" }
  | {
      version: 1;
      state: "available";
      beforeCount: number;
      afterCount: number;
      addedCount: number;
      removedCount: number;
      modifiedCount: number;
      affectedNodeCount: number;
      orderChanged: boolean;
      omittedRowCount: number;
      rows: {
        kind: "added" | "removed" | "modified";
        label: string;
        beforeLabel?: string;
        nameChanged?: boolean;
        settingsChanged?: boolean;
      }[];
    };

export type SemanticCategory<T> =
  | {
      state: "unavailable";
      reason:
        | "baseline-missing"
        | "unsupported"
        | "size-limit"
        | "invalid-snapshot"
        | "redaction-unavailable";
    }
  | {
      state: "available";
      beforeCount: number;
      afterCount: number;
      changedCount: number;
      rows: T[];
      omittedRowCount: number;
    };
export interface SafeRef {
  kind: "endpoint" | "group" | "direct";
  ref?: string;
  label?: string;
}
export interface Uses {
  scope: "direct";
  state: "available" | "partial" | "unavailable";
  default: boolean;
  rules: { id: string; index: number }[];
  groups: SafeRef[];
  omittedRuleCount: number;
  omittedGroupCount: number;
}
export interface GroupValue {
  label: string;
  selection: "manual" | "url-test" | "fallback" | "load-balance";
  strategy?: "consistent-hashing" | "round-robin" | "sticky-sessions";
  memberCount: number;
}
export interface GroupChange {
  id: string;
  kind: "added" | "removed" | "modified";
  before?: GroupValue;
  after?: GroupValue;
  nameChanged: boolean;
  strategyChanged: boolean;
  parametersChanged: boolean;
  membersAdded: SafeRef[];
  membersRemoved: SafeRef[];
  omittedAddedMemberCount: number;
  omittedRemovedMemberCount: number;
  memberOrderChanged: boolean;
  usesBefore: Uses;
  usesAfter: Uses;
}
export interface NodeChange {
  id: string;
  kind: "added" | "removed" | "modified";
  beforeLabel?: string;
  afterLabel?: string;
  nameChanged: boolean;
  settingsChanged: boolean;
  changedCategories: (
    | "endpoint"
    | "protocol"
    | "authentication"
    | "security"
    | "transport"
    | "protocol-options"
    | "other"
  )[];
  usesBefore: Uses;
  usesAfter: Uses;
}
export interface SemanticChanges {
  version: 1;
  renderedConfigurationChanged: boolean;
  groups: SemanticCategory<GroupChange>;
  nodes: SemanticCategory<NodeChange>;
}

export interface Preview {
  resources?: RuleResource[];
  semanticChanges?: SemanticChanges;
  nodeChanges?: NodeChanges;
  platformEntryRefresh?: { version: 1; count: number };
  publicationEffect?: { version: 1; link: "preserve" | "replace" };
  routingSummary?: RoutingSummary;
  publishedRoutingSummary?: RoutingSummary;
  routingIntent?: FrozenRoutingIntent;
  publishedRoutingIntent?: FrozenRoutingIntent;
  previewDigest?: string;
  outputId?: string;
  previewScope?: "output-update" | "profile-draft" | "new-output";
  nativeOverride?: NativeOverrideReview;
  valid?: boolean;
  endpoints?: ClientNode[];
  stages?: {
    name?: string;
    stage?: string;
    scope?: string;
    sourceId?: string;
    stepId?: string;
    comparison?: "step-input" | "snapshot";
    addedIds?: string[];
    removedIds?: string[];
    changedIds?: string[];
    endpoints: ClientNode[];
    diagnostics?: string[];
  }[];
  diagnostics?: string[];
  artifacts?: Artifact[];
  content?: string;
  nodeCount?: number;
}
export type OutputCreation = Pick<
  Output,
  "id" | "name" | "profileId" | "target" | "mode"
>;
export interface RoutingSummary {
  version: 1;
  kind: "basic" | "advanced" | "native-override" | "nodes-only";
  chatGPT?: { endpointId: string; label: string };
  default?: { endpointId: string; label: string };
  advanced?: {
    defaultAction: {
      kind: "group" | "endpoint" | "direct" | "reject";
      label?: string;
    };
    ruleCount: number;
    groupCount: number;
    nodeCount: number;
  };
}
export interface OutputStatus extends Output {
  routingIntent?: FrozenRoutingIntent;
  draftComparison: DraftComparison;
}
export interface DraftComparison {
  state: "unchanged" | "changed" | "unavailable";
  reason?: "missing-action-reference";
  location?: "default" | "group" | "rule";
}
// Explicit owner check only. This is not a private policy/detail or access DTO.
export interface OutputComparison {
  id: string;
  profileId: string;
  target: { adapterId: string; version: string };
  mode: string;
  status: string;
  revision?: string;
  draftComparison: DraftComparison;
}

// Private, publication-frozen detail: returned by owner review/status only,
// never inferred from a current Profile or included in ordinary Output metadata.
export interface FrozenRoutingAction {
  kind: "group" | "endpoint" | "direct" | "reject";
  ref?: string;
  label?: string;
}
export interface FrozenRoutingRule {
  id: string;
  match: {
    state: "exact" | "omitted";
    expression?: MatchExpression;
    reason?: "sensitive" | "size-limit";
  };
  action: FrozenRoutingAction;
}
export interface FrozenRoutingIntent {
  version: 1;
  kind: "portable" | "native-override" | "nodes-only";
  defaultAction?: FrozenRoutingAction;
  ruleCount?: number;
  rules?: FrozenRoutingRule[];
  omittedRuleCount?: number;
  resources?: { id: string; label: string }[];
}
export interface Output {
  revision?: string;
  routingSummary?: RoutingSummary;
  creationReviewDigest?: string;
  delivery?: "feed" | "bundle";
  downloadPath?: string;
  bundlePath?: string;
  id: string;
  name: string;
  profileId: string;
  target: { adapterId: string; version: string };
  mode: string;
  status: string;
  url?: string;
  feedPath?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
}

export interface Entitlement {
  userId: string;
  serviceId?: string;
  startsAt: string;
  expiresAt?: string;
  cycle: ResetPolicy;
  quotaOverride?: number | null;
  paused?: boolean;
  routeIdsOverride?: string[] | null;
  onlineIpLimitOverride?: number | null;
  connectionLimitOverride?: number | null;
  entryRateBpsOverride?: number | null;
}

export interface HostRecord {
  id: string;
  name: string;
  address: string;
  group?: string;
  tags?: string[];
}
export interface CoreInstance {
  id: string;
  name?: string;
  hostId: string;
  adapterId: string;
  version: string;
}
export interface ManagedEndpoint {
  revisionToken?: string;
  authentication?: string;
  id: string;
  instanceId: string;
  name: string;
  connection: Connection;
}
export interface ManagedLink {
  id: string;
  from: string;
  to: string;
}
export interface ServerTLS {
  certificatePem?: string;
  privateKeyPem?: string;
  certificatePath?: string;
  keyPath?: string;
  reality?: {
    privateKey: string;
    handshakeServer: string;
    handshakePort: number;
    shortIds: string[];
    serverNames: string[];
  };
}
export interface ServerProgram {
  destinationPolicy?: { allowCidrs: string[] };
  principals?: {
    subjectId: string;
    accountId: string;
    routeId: string;
    credentialVersion: string;
    credential: { uuid: string; flow?: string };
    action: { kind: string; ref?: string };
    policyRevision?: string;
    cycleId?: string;
  }[];
  instance: CoreInstance;
  listener: ManagedEndpoint;
  egress: Connection[];
  rules: Rule[];
  resources: RuleResource[];
  tls?: ServerTLS;
  defaultAction?: ActionRef;
  connectors?: { id: string; connection: Connection; via?: string }[];
}
export interface ServerDeployment {
  revisionToken?: string;
  id: string;
  name: string;
  status: string;
  diagnostics: string[];
  updatedAt?: string;
  ir: {
    schemaVersion: string;
    id: string;
    topologyRevision: string;
    programs: ServerProgram[];
  };
}
export interface AgentState {
  instanceId: string;
  serviceIntent?: {
    id: string;
    running: boolean;
    status: string;
    automaticAttempts: number;
    nextAttemptAt?: string;
    leaseExpiresAt: string;
  };
  phase: string;
  desired?: {
    generation: string;
    revisionId: string;
    operationId: string;
    digest: string;
  };
  state?: {
    phase: string;
    code?: string;
    nativeChecked: boolean;
    recoveryRequired: boolean;
    accessDecision?: string;
    observed?: {
      known: boolean;
      observedAt: string;
      generation: string;
      evidence: string;
    };
  };
}
export interface Infrastructure {
  hosts: HostRecord[];
  instances: CoreInstance[];
  endpoints: ManagedEndpoint[];
  links: ManagedLink[];
  deployments: ServerDeployment[];
}
export interface PlatformEntry {
  id: string;
  name: string;
  routeId: string;
  credentialVersion: string;
  status: string;
}

export type TemplateRoutingReviewSide =
  | { state: "available"; intent: FrozenRoutingIntent }
  | { state: "unavailable"; reason: "render-failed" | "size-limit" };
export interface TemplateRoutingReview {
  version: 1;
  scope: "profile-routing";
  current: TemplateRoutingReviewSide;
  candidate: TemplateRoutingReviewSide;
}
