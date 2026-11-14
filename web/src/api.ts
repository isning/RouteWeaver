import type { State, Session, UserRecord, NodeRecord } from "./types";
import { readNodeRecord } from "./node-creation";
let adminToken = "";
let tokenRevision = 0;
let legacyTokenValidated = false;
let csrfToken = "";
type SessionTransport = {
  beforeRequest: () => {
    waitForResponse: () => Promise<void>;
    beforeSend: () => void;
  };
  failed: (error: APIError) => void;
};
let sessionTransport: SessionTransport | null = null;
const responseGuards = new WeakMap<Response, () => Promise<void>>();
export function installSessionTransport(value: SessionTransport) {
  sessionTransport = value;
  return () => {
    if (sessionTransport === value) sessionTransport = null;
  };
}
const isSessionEntry = (path: string) =>
  ["/auth/me", "/auth/login", "/auth/accept-invite", "/auth/oidc", "/auth/oidc/start", "/auth/oidc/complete"].includes(path);
export function setToken(value: string) {
  tokenRevision++;
  adminToken = value;
  legacyTokenValidated = false;
}
export function setCSRF(value: string) {
  csrfToken = value;
}
export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "APIError";
  }
}
async function send(
  path: string,
  init: RequestInit = {},
  sessionEntry = false,
): Promise<Response> {
  const transport =
    sessionEntry || isSessionEntry(path) ? null : sessionTransport;
  const guard = transport?.beforeRequest();
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (adminToken) headers.set("Authorization", `Bearer ${adminToken}`);
  if (csrfToken && init.method && init.method !== "GET")
    headers.set("X-CSRF-Token", csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new APIError("无法连接服务。请检查网络后重试，当前输入已保留。", 0);
  }
  await guard?.waitForResponse();
  if (guard) responseGuards.set(response, guard.waitForResponse);
  if (transport && [401, 403].includes(response.status))
    transport.failed(new APIError("登录状态需要确认。", response.status));
  return response;
}
async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  // Auth failures retain their original status; successful stale responses never escape.
  if (response.ok) await responseGuards.get(response)?.();
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    if (!response.ok)
      throw new APIError(
        response.status === 401
          ? "登录已失效，请重新登录。"
          : `请求失败 (${response.status})，请重试。`,
        response.status,
      );
    throw new APIError(
      "服务返回了无法识别的响应，请稍后重试。",
      response.status,
    );
  }
  if (!response.ok) {
    const error = data as { message?: string; error?: string; detail?: string };
    throw new APIError(
      error?.detail ||
        error?.message ||
        error?.error ||
        `请求失败 (${response.status})`,
      response.status,
      data,
    );
  }
  return data as T;
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return readResponse<T>(await send(path, init));
}
export class UserCreationError extends Error {
  constructor(
    message: string,
    public outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}
/** Only Add user opts into atomic absence; legacy saveRecord remains an upsert. */
export async function createUser(draft: UserRecord): Promise<UserRecord> {
  try {
    sessionTransport?.beforeRequest().beforeSend();
  } catch (error) {
    throw new UserCreationError(
      error instanceof Error ? error.message : "本次创建未发送。",
      "rejected",
    );
  }
  let response: Response;
  try {
    response = await send("/users", {
      method: "POST",
      headers: { "If-None-Match": "*" },
      body: JSON.stringify(draft),
    });
  } catch {
    throw new UserCreationError("尚未确认用户是否创建", "unknown");
  }
  let value: unknown;
  try {
    value = await readResponse<unknown>(response);
  } catch (error) {
    // Status alone cannot establish non-commit: legacy user storage errors also
    // use 400. Only the guarded endpoint's explicit pre-write codes are definite.
    const code =
      error instanceof APIError
        ? (error.details as { code?: string } | null)?.code
        : undefined;
    if (
      response.status === 400 &&
      ["USER_CREATION_INVALID", "USER_CREATION_PRECONDITION_INVALID"].includes(
        code || "",
      )
    )
      throw new UserCreationError(
        error instanceof Error ? error.message : "用户未创建。",
        "rejected",
      );
    throw new UserCreationError("尚未确认用户是否创建", "unknown");
  }
  const receipt = value as Partial<UserRecord> | null;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.id !== draft.id ||
    typeof receipt.name !== "string" ||
    typeof receipt.enabled !== "boolean" ||
    !Number.isSafeInteger(receipt.quotaBytes) ||
    Number(receipt.quotaBytes) < 0 ||
    typeof receipt.usedBytes !== "number" ||
    !Number.isFinite(receipt.usedBytes) ||
    receipt.usedBytes < 0
  )
    throw new UserCreationError("尚未确认用户是否创建", "unknown");
  return receipt as UserRecord;
}

export class NodeCreationError extends Error {
  constructor(
    message: string,
    public outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}
/** Add endpoint uses a create-only command; legacy saveRecord stays an upsert. */
export async function createNode(draft: NodeRecord): Promise<NodeRecord> {
  const record = readNodeRecord({ ...draft, status: "unregistered" });
  if (!record)
    throw new NodeCreationError("端点资料格式不正确，请检查输入。", "rejected");
  try {
    sessionTransport?.beforeRequest().beforeSend();
  } catch {
    throw new NodeCreationError(
      "本次创建未发送，请先确认登录状态。",
      "rejected",
    );
  }
  let response: Response;
  try {
    response = await send("/nodes", {
      method: "POST",
      headers: { "If-None-Match": "*" },
      body: JSON.stringify(record),
    });
  } catch {
    throw new NodeCreationError("尚未确认端点是否创建", "unknown");
  }
  let value: unknown;
  try {
    value = await readResponse<unknown>(response);
  } catch (error) {
    const code =
      error instanceof APIError
        ? (error.details as { code?: string } | null)?.code
        : undefined;
    // Neither an untagged 400 nor a conflict rules out an earlier commit.
    if (
      response.status === 400 &&
      ["NODE_CREATION_INVALID", "NODE_CREATION_PRECONDITION_INVALID"].includes(
        code || "",
      )
    )
      throw new NodeCreationError(
        "端点未创建，请检查连接参数后重试。",
        "rejected",
      );
    // Do not echo arbitrary response detail, which could contain connection data.
    throw new NodeCreationError("尚未确认端点是否创建", "unknown");
  }
  const receipt = readNodeRecord(value);
  if (!receipt || receipt.id !== record.id)
    throw new NodeCreationError("尚未确认端点是否创建", "unknown");
  return receipt;
}

export type InvitationDraft = {
  name: string;
  role: string;
  expiresInHours?: number;
};
export type InvitationReceipt = {
  id: string;
  token: string;
  name: string;
  role: string;
  expiresAt: string;
};
export class InvitationCreationError extends Error {
  constructor(
    message: string,
    public outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}
/** No invitation read-back or idempotent retry exists: a lost receipt is unknown. */
export async function createInvitation(
  draft: InvitationDraft,
): Promise<InvitationReceipt> {
  try {
    sessionTransport?.beforeRequest().beforeSend();
  } catch (error) {
    throw new InvitationCreationError(
      error instanceof Error ? error.message : "本次邀请未发送。",
      "rejected",
    );
  }
  let response: Response;
  try {
    response = await send("/invites", {
      method: "POST",
      body: JSON.stringify(draft),
    });
  } catch {
    throw new InvitationCreationError("邀请创建结果尚未确认", "unknown");
  }
  let value: unknown;
  try {
    value = await readResponse<unknown>(response);
  } catch (error) {
    // Only a server rejection is definite. Session guards can also throw 409
    // after dispatch, so classify by the actual HTTP response, not error status.
    if ([400, 401, 403, 404, 405, 413, 429].includes(response.status))
      throw new InvitationCreationError(
        error instanceof Error ? error.message : "邀请未创建。",
        "rejected",
      );
    throw new InvitationCreationError("邀请创建结果尚未确认", "unknown");
  }
  // Treat identifiers as opaque; the UI URL-encodes the confirmed token.
  const receipt = value as Partial<InvitationReceipt> | null;
  if (
    response.status !== 201 ||
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.id !== "string" ||
    !receipt.id.trim() ||
    typeof receipt.token !== "string" ||
    !receipt.token.trim() ||
    receipt.name !== draft.name ||
    receipt.role !== draft.role ||
    typeof receipt.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      receipt.expiresAt,
    ) ||
    !Number.isFinite(Date.parse(receipt.expiresAt))
  )
    throw new InvitationCreationError("邀请创建结果尚未确认", "unknown");
  try {
    encodeURIComponent(receipt.token);
  } catch {
    throw new InvitationCreationError("邀请创建结果尚未确认", "unknown");
  }
  return receipt as InvitationReceipt;
}

export async function requestFile(path: string, value: unknown): Promise<Blob> {
  const response = await send(path, {
    method: "POST",
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    try {
      await readResponse<never>(response);
    } catch (error) {
      if (
        path === "/admin/backups" &&
        error instanceof APIError &&
        error.status === 503 &&
        typeof error.details === "object" &&
        error.details !== null &&
        "reason" in error.details &&
        error.details.reason === "backup_export_deadline_exceeded"
      ) {
        throw new APIError(
          "备份创建超时。请检查服务资源和备份时限后重新创建。",
          error.status,
          error.details,
        );
      }
      throw error;
    }
  }
  if (
    !(response.headers.get("content-type") || "").includes(
      "application/octet-stream",
    )
  )
    throw new APIError("服务器没有返回预期的加密备份文件。", response.status);
  const blob = await response.blob();
  await responseGuards.get(response)?.();
  return blob;
}
// Token-only operators cannot authenticate an ordinary browser download link.
export const usesTokenAuthentication = () => !!adminToken;
export async function requestOutputBundle(id: string, signal?: AbortSignal) {
  const owner = tokenRevision;
  const transport = sessionTransport;
  const guard = transport?.beforeRequest();
  const assertCurrent = () => {
    if (owner !== tokenRevision || transport !== sessionTransport)
      throw new APIError("登录状态已变化，请重新获取配置包。", 409);
    guard?.beforeSend();
  };
  assertCurrent();
  // Never follow a URL supplied in access metadata with operator credentials.
  const response = await send(`/me/outputs/${encodeURIComponent(id)}/bundle`, {
    redirect: "error",
    signal,
  });
  if (!response.ok) await readResponse<never>(response);
  if (
    response.headers.get("content-type")?.split(";")[0].trim() !== "application/zip"
  )
    throw new APIError("服务器没有返回配置包，请重试。", response.status);
  const blob = await response.blob();
  await guard?.waitForResponse();
  assertCurrent();
  // The caller checks again immediately before handing bytes to the browser.
  return { blob, assertCurrent };
}
export const loadState = () => request<State>("/state");
async function validateLegacyToken(signal?: AbortSignal): Promise<Session> {
  if (!adminToken) throw new APIError("请输入管理员令牌。", 401);
  // Only an explicit token login (or its subsequent validation) can use this
  // bootstrap read. The ordinary /state request remains behind the session gate.
  await readResponse(await send("/state", { signal }, true));
  return {
    user: { id: "operator", name: "管理员", role: "admin" },
    csrfToken: "",
  };
}
export const getSession = async (signal?: AbortSignal): Promise<Session> => {
  try {
    return await request<Session>("/auth/me", { signal });
  } catch (error) {
    if (legacyTokenValidated) return validateLegacyToken(signal);
    throw error;
  }
};
export async function loginWithToken(token: string): Promise<Session> {
  setToken(token);
  const owner = tokenRevision;
  const requireOwner = () => {
    if (owner !== tokenRevision)
      throw new APIError("登录方式已变更，请使用当前登录结果。", 409);
  };
  try {
    try {
      const session = await getSession();
      requireOwner();
      return session;
    } catch {
      requireOwner();
      const session = await validateLegacyToken();
      requireOwner();
      legacyTokenValidated = true;
      return session;
    }
  } catch (error) {
    if (owner === tokenRevision) setToken("");
    throw error;
  }
}
export const post = <T>(path: string, value: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(value) });
export const put = <T>(path: string, value: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(value) });
export function saveRecord<T>(kind: string, value: object, isNew = false) {
  const { revisionToken, ...record } = value as {
    id?: string;
    revisionToken?: string;
  };
  const id = record.id;
  const guarded =
    kind === "server-deployments" ||
    kind === "published-routes" ||
    kind === "me/profiles" ||
    kind === "me/collections";
  return request<T>(
    `/${kind}${!isNew && id ? `/${encodeURIComponent(id)}` : ""}`,
    {
      method: !isNew && id ? "PUT" : "POST",
      ...(guarded && !isNew && id && revisionToken
        ? { headers: { "If-Match": revisionToken } }
        : {}),
      ...((kind === "me/sources" || kind === "me/collections") && isNew
        ? { headers: { "If-None-Match": "*" } }
        : {}),
      body: JSON.stringify(guarded ? record : value),
    },
  );
}
export const deleteRecord = (kind: string, id: string) =>
  request(`/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
export const list = <T>(path: string) =>
  request<T[] | { items: T[] }>(path).then((result) =>
    Array.isArray(result) ? result : (result?.items ?? []),
  );

export async function postArchive<T>(
  path: string,
  metadata: object,
  archive: File,
): Promise<T> {
  const body = new FormData();
  body.append("metadata", JSON.stringify(metadata));
  body.append("archive", archive);
  try {
    return await request<T>(path, { method: "POST", body });
  } catch (error) {
    if (
      path === "/admin/backups/preview" &&
      error instanceof APIError &&
      error.status === 400 &&
      typeof error.details === "object" &&
      error.details !== null &&
      "reason" in error.details &&
      error.details.reason === "backup_archive_unverified"
    ) {
      throw new APIError(
        "备份无法验证。请核对密码，并确认文件完整后重试。",
        error.status,
        error.details,
      );
    }
    throw error;
  }
}

/** Keep an asynchronous file preparation tied to the authority that began it. */
export function prepareFilePost(isCurrent?: () => boolean) {
  const guard = sessionTransport?.beforeRequest();
  return async <T>(path: string, value: unknown, headers?: HeadersInit): Promise<T> => {
    try {
      await guard?.waitForResponse();
      // No await between this final scope check and dispatching the POST.
      guard?.beforeSend();
    } catch {
      throw new APIError(
        "登录状态已变化，文件尚未上传。请确认当前账号后重新导入。",
        409,
      );
    }
    // Recheck dialog ownership after the session wait, immediately before dispatch.
    if (isCurrent && !isCurrent())
      throw new APIError("文件导入已取消，请重新选择文件。", 409);
    return request<T>(path, { method: "POST", body: JSON.stringify(value), headers });
  };
}

export interface BackupRestoreResult {
  status: "restored";
  target: string;
  activated: false;
}
export class BackupRestoreError extends APIError {
  constructor(
    message: string,
    status: number,
    public outcome: "not_published" | "uncertain" | "unknown",
    details?: unknown,
    public target?: string,
  ) {
    super(message, status, details);
    this.name = "BackupRestoreError";
  }
}
const isRestoreTarget = (value: unknown): value is string =>
  typeof value === "string" && /^restore_[A-Za-z0-9_-]{43}\.db$/.test(value);
const restoreUnknownMessage =
  "恢复结果尚未确认。新数据库可能已创建。本次恢复不会自动切换服务。请确认操作已结束并检查恢复目录，再决定是否再次恢复。";

const restoreReasonMessages = new Map<string, string>([
  [
    "restore_storage_prepare_failed",
    "无法准备恢复目录。请检查目录权限和可用空间后重试。",
  ],
  [
    "restore_target_reservation_failed",
    "无法分配恢复目标。请检查恢复目录后重试。",
  ],
  [
    "restore_publication_failed",
    "未能创建恢复数据库。请检查恢复目录和可用空间后重试。",
  ],
  [
    "restore_prepublication_cancelled",
    "恢复已停止，尚未创建恢复数据库。请检查备份大小和服务资源后重试。",
  ],
]);

/** A lost response is not evidence that a restore failed before publication. */
export async function restoreArchive(
  metadata: object,
  archive: File,
): Promise<BackupRestoreResult> {
  const body = new FormData();
  body.append("metadata", JSON.stringify(metadata));
  body.append("archive", archive);
  // Preserve a known local authority refusal before dispatch, distinct from a
  // stale/lost response after dispatch. No await between this check and send.
  try {
    sessionTransport?.beforeRequest().beforeSend();
  } catch (error) {
    if (error instanceof APIError) {
      throw new BackupRestoreError(
        error.message,
        error.status,
        "not_published",
        error.details,
      );
    }
    throw error;
  }
  let response: Response;
  try {
    response = await send("/admin/backups/restore", { method: "POST", body });
  } catch {
    throw new BackupRestoreError(restoreUnknownMessage, 0, "unknown");
  }
  let value: unknown;
  try {
    value = await readResponse<unknown>(response);
  } catch (error) {
    if (!response.ok && error instanceof APIError) {
      const details = error.details;
      const outcome =
        details && typeof details === "object"
          ? (details as {
              restoreOutcome?: unknown;
              activated?: unknown;
              target?: unknown;
              restoreReason?: unknown;
            })
          : null;
      if (
        outcome?.activated === false &&
        outcome.restoreOutcome === "uncertain" &&
        isRestoreTarget(outcome.target)
      ) {
        throw new BackupRestoreError(
          error.message,
          error.status,
          "uncertain",
          details,
          outcome.target,
        );
      }
      if (
        (outcome?.activated === false &&
          outcome.restoreOutcome === "not_published") ||
        [400, 401, 403, 409, 413, 429].includes(response.status)
      ) {
        const reason = outcome?.restoreReason;
        const message =
          [500, 503].includes(response.status) &&
          outcome?.activated === false &&
          outcome.restoreOutcome === "not_published" &&
          typeof reason === "string"
            ? (restoreReasonMessages.get(reason) ?? error.message)
            : error.message;
        throw new BackupRestoreError(
          message,
          error.status,
          "not_published",
          details,
        );
      }
    }
    throw new BackupRestoreError(
      restoreUnknownMessage,
      response.status,
      "unknown",
    );
  }
  if (
    response.status !== 201 ||
    !value ||
    typeof value !== "object" ||
    (value as BackupRestoreResult).status !== "restored" ||
    (value as BackupRestoreResult).activated !== false ||
    !isRestoreTarget((value as BackupRestoreResult).target)
  ) {
    throw new BackupRestoreError(
      restoreUnknownMessage,
      response.status,
      "unknown",
    );
  }
  return value as BackupRestoreResult;
}

export interface CoreLogFilters { stream?: "stdout" | "stderr"; q?: string; since?: string }
export function coreLogPath(instanceId: string, filters: CoreLogFilters, exportFile = false) {
  const query = new URLSearchParams();
  if (filters.stream) query.set("stream", filters.stream);
  if (filters.q) query.set("q", filters.q);
  if (filters.since) query.set("since", filters.since);
  if (exportFile) query.set("format", "ndjson");
  const suffix = query.toString();
  return `/admin/instances/${encodeURIComponent(instanceId)}/core-logs${suffix ? `?${suffix}` : ""}`;
}
export async function requestCoreLogExport(instanceId: string, filters: CoreLogFilters, signal?: AbortSignal) {
  const owner = tokenRevision;
  const transport = sessionTransport;
  const guard = transport?.beforeRequest();
  const assertCurrent = () => {
    if (owner !== tokenRevision || transport !== sessionTransport)
      throw new APIError("登录状态已变化，请重新导出日志。", 409);
    guard?.beforeSend();
  };
  assertCurrent();
  const response = await send(coreLogPath(instanceId, filters, true), { redirect: "error", signal });
  if (!response.ok) await readResponse<never>(response);
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/x-ndjson")
    throw new APIError("服务器未返回日志文件，请重试。", response.status);
  const blob = await response.blob();
  await guard?.waitForResponse();
  assertCurrent();
  return { blob, assertCurrent };
}
