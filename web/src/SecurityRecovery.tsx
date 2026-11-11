import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { APIError, request } from "./api";
import { ErrorNotice } from "./components";
import { ActionButton } from "./ui-patterns/actions";
import { Notice } from "./ui-patterns/notice";
import { useConfirm } from "./ui-patterns/confirmations";

// Browser recovery records attempts, not server receipts. Never store input or results.
type RecoveryRecord = {
  actor: string;
  target: string;
  action: string;
  startedAt: string;
};
const labels: Record<string, string> = {
  password: "修改密码",
  "revoke-others": "退出其他会话",
  "revoke-session": "退出所选会话",
  disable: "停用账号",
  enable: "恢复账号",
  retire: "永久退役账号",
  "reset-password": "重置账号密码",
  "reset-mfa": "重置二次验证",
  "mfa-setup": "设置二次验证",
  "mfa-enable": "验证并启用二次验证",
};
type RecoveryState = {
  record: RecoveryRecord | null;
  error: Error | null;
  checking: boolean;
  inFlight: boolean;
  state: string | null;
};
function readRecoveryRecord(actor: string, key: string) {
  let record: RecoveryRecord | null = null,
    error: Error | null = null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw) as RecoveryRecord;
      if (
        !value ||
        Object.keys(value).sort().join(",") !==
          "action,actor,startedAt,target" ||
        value.actor !== actor ||
        typeof value.target !== "string" ||
        !value.target ||
        value.target.length > 512 ||
        !Object.hasOwn(labels, value.action) ||
        typeof value.startedAt !== "string" ||
        !Number.isFinite(Date.parse(value.startedAt))
      )
        throw new Error("invalid recovery record");
      record = {
        actor,
        target: value.target,
        action: value.action,
        startedAt: value.startedAt,
      };
    }
  } catch {
    error = new Error(
      "无法读取安全操作记录。请恢复浏览器会话存储后重新检查操作记录；暂不提交新的安全操作。",
    );
  }
  return { record, error };
}
class SecurityOperationOwner {
  private key: string;
  private snapshot: RecoveryState;
  private listeners = new Set<() => void>();
  constructor(
    private actor: string,
    private authorize: (actor: string) => void | (() => void),
    private reconcile: (
      actor: string,
      action: string,
      receipt?: unknown,
    ) => Promise<boolean | void> = async () => {},
  ) {
    this.key = `routeweaver.security-recovery.v1:${encodeURIComponent(actor)}`;
    this.snapshot = {
      ...readRecoveryRecord(actor, this.key),
      checking: false,
      inFlight: false,
      state: null,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<RecoveryState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private clear(attempt: RecoveryRecord) {
    if (
      this.snapshot.record !== attempt ||
      sessionStorage.getItem(this.key) !== JSON.stringify(attempt)
    )
      throw new Error("安全操作记录已变化。请刷新整个页面后查看操作提醒。");
    sessionStorage.removeItem(this.key);
    this.publish({ record: null, state: null });
  }
  recheckStorage = () => {
    // A retry may recover a recordless storage failure, never erase uncertainty
    // or turn a live dispatch into a dismissible persisted reminder.
    if (
      this.snapshot.record ||
      this.snapshot.inFlight ||
      this.snapshot.checking
    )
      return;
    try {
      this.authorize(this.actor);
      this.publish({
        ...readRecoveryRecord(this.actor, this.key),
        state: null,
      });
    } catch {
      this.publish({
        error: new Error("请先恢复当前账号的登录状态，再重新检查操作记录。"),
      });
    }
  };
  hasRecord = () => Boolean(this.snapshot.record);
  run = async <T,>(
    action: string,
    target: string,
    execute: () => Promise<T>,
    valid: (value: T) => boolean,
    unknownMessage = "安全操作结果尚未确认。请查看当前状态，不要直接重复提交。",
  ) => {
    // Dispatch refusal is not an attempted write. Check authority before recording.
    this.authorize(this.actor);
    if (this.snapshot.record || this.snapshot.error || this.snapshot.inFlight)
      throw new Error("请先查看尚未确认的安全操作。");
    const attempt = {
      actor: this.actor,
      target,
      action,
      startedAt: new Date().toISOString(),
    };
    try {
      sessionStorage.setItem(this.key, JSON.stringify(attempt));
    } catch {
      const error = new Error(
        "无法保存安全操作记录，本次尚未提交。请检查浏览器会话存储。",
      );
      this.publish({ error });
      throw error;
    }
    this.publish({ record: attempt, inFlight: true, state: null });
    let reconciled = false,
      received = false;
    try {
      const value = await execute();
      received = true;
      if (!valid(value)) throw new Error("安全操作响应不完整");
      reconciled = true;
      const signedOut = await this.reconcile(
        this.actor,
        action,
        action === "revoke-session" ? value : undefined,
      );
      if (!signedOut) this.authorize(this.actor);
      this.clear(attempt);
      return value;
    } catch (error) {
      // Only the dispatched operation can definitively reject. A later authority
      // check cannot turn a received result into a rejected write. 409 remains unknown.
      if (
        !received &&
        error instanceof APIError &&
        [400, 401, 403, 429].includes(error.status)
      ) {
        try {
          this.clear(attempt);
        } catch {
          /* retain recovery if storage changed */
        }
        throw error;
      }
      if (!reconciled) {
        try {
          await this.reconcile(this.actor, action);
        } catch {
          /* preserve unknown attempt */
        }
      }
      throw new Error(unknownMessage);
    } finally {
      this.publish({ inFlight: false });
    }
  };
  inspect = async () => {
    const attempt = this.snapshot.record;
    if (!attempt || this.snapshot.checking || this.snapshot.inFlight) return;
    this.publish({ checking: true, error: null, state: null });
    try {
      const assertCurrent = this.authorize(this.actor);
      let summary: string;
      if (attempt.action.startsWith("mfa-")) {
        const value = await request<{
          user: { id: string; mfaEnabled: boolean };
        }>("/auth/me");
        if (
          value?.user?.id !== this.actor ||
          typeof value.user.mfaEnabled !== "boolean"
        )
          throw new Error("账号状态响应不完整");
        summary = `当前账号${value.user.mfaEnabled ? "已启用" : "未启用"}二次验证。当前状态不能确认上次设置或启用操作是否结束。`;
      } else if (
        ["password", "revoke-others", "revoke-session"].includes(attempt.action)
      ) {
        const entries =
          await request<
            Array<{ id: string; current: boolean; expiresAt: string }>
          >("/auth/sessions");
        if (
          !Array.isArray(entries) ||
          !entries.every(
            (entry) =>
              entry &&
              typeof entry.id === "string" &&
              typeof entry.current === "boolean" &&
              typeof entry.expiresAt === "string" &&
              Number.isFinite(Date.parse(entry.expiresAt)),
          )
        )
          throw new Error("会话列表响应不完整");
        summary = `当前可见有效会话：${entries.length}。`;
        if (attempt.action === "revoke-session")
          summary += entries.some((entry) => entry.id === attempt.target)
            ? "目标会话仍在当前列表中。"
            : "目标会话不在当前列表中，不能确认消失原因。";
      } else {
        const entries = await request<
          Array<{
            id: string;
            retired: boolean;
            disabled: boolean;
            mfaEnabled: boolean;
            passwordChangeRequired: boolean;
          }>
        >("/admin/accounts");
        if (
          !Array.isArray(entries) ||
          !entries.every((entry) => entry && typeof entry.id === "string")
        )
          throw new Error("账号列表响应不完整");
        const account = entries.find((entry) => entry.id === attempt.target);
        if (
          account &&
          ![
            account.retired,
            account.disabled,
            account.mfaEnabled,
            account.passwordChangeRequired,
          ].every((value) => typeof value === "boolean")
        )
          throw new Error("账号状态响应不完整");
        summary = account
          ? `目标账号当前状态：${account.retired ? "已永久退役" : account.disabled ? "已停用" : "未停用"}；${account.mfaEnabled ? "已启用二次验证" : "未启用二次验证"}；${account.passwordChangeRequired ? "须更换密码" : "未要求更换密码"}。`
          : "当前账号列表中未找到目标，不能确认原因。";
      }
      // /auth/me is a session-entry read: retain the dispatch generation fence.
      assertCurrent?.();
      this.authorize(this.actor);
      if (this.snapshot.record === attempt) this.publish({ state: summary });
    } catch {
      this.publish({
        error: new Error(
          "无法读取当前状态。请确认登录和网络后再次查看；原操作仍未确认。",
        ),
      });
    } finally {
      this.publish({ checking: false });
    }
  };
  dismiss = () => {
    if (
      !this.snapshot.record ||
      !this.snapshot.state ||
      this.snapshot.inFlight ||
      this.snapshot.checking
    )
      return;
    try {
      this.authorize(this.actor);
      this.clear(this.snapshot.record);
      this.publish({ error: null });
    } catch {
      this.publish({
        error: new Error("无法清除操作提醒。请检查浏览器会话存储，并刷新整个页面后重新查看。"),
      });
    }
  };
}
const OwnerContext = createContext<
  ((actor: string) => SecurityOperationOwner) | null
>(null);
export function SecurityRecoveryProvider({
  authorize,
  reconcile,
  children,
}: {
  authorize: (actor: string) => void | (() => void);
  reconcile: (
    actor: string,
    action: string,
    receipt?: unknown,
  ) => Promise<boolean | void>;
  children: ReactNode;
}) {
  // Above route/account/generation remounts: pending work retains its original owner.
  const [owners] = useState(() => new Map<string, SecurityOperationOwner>());
  return (
    <OwnerContext.Provider
      value={(actor) => {
        let owner = owners.get(actor);
        if (!owner) {
          owner = new SecurityOperationOwner(actor, authorize, reconcile);
          owners.set(actor, owner);
        }
        return owner;
      }}
    >
      {children}
    </OwnerContext.Provider>
  );
}
export function useSecurityRecovery(actor: string) {
  const getOwner = useContext(OwnerContext);
  const active = useRef(true);
  const [local] = useState(() =>
    getOwner
      ? null
      : new SecurityOperationOwner(actor, () => {
          if (!active.current)
            throw new Error("账号已变化，本次安全操作尚未提交。");
        }),
  );
  const owner = getOwner?.(actor) ?? local!;
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [owner]);
  return {
    ...snapshot,
    shared: Boolean(getOwner),
    blocked: Boolean(snapshot.record || snapshot.error || snapshot.inFlight),
    hasRecord: owner.hasRecord,
    recheckStorage: owner.recheckStorage,
    inspect: owner.inspect,
    dismiss: owner.dismiss,
    run: <T,>(...args: Parameters<typeof owner.run<T>>) => {
      if (!active.current)
        return Promise.reject<T>(
          new Error("账号已变化，本次安全操作尚未提交。"),
        );
      return owner.run(...args);
    },
  };
}
export type SecurityRecovery = ReturnType<typeof useSecurityRecovery>;
export function SecurityRecoveryNotice({
  recovery,
  pending = false,
}: {
  recovery: SecurityRecovery;
  pending?: boolean;
}) {
  const confirm = useConfirm();
  pending = pending || recovery.inFlight;
  if (!recovery.record)
    return (
      <>
        <ErrorNotice error={recovery.error} />
        {recovery.error && (
          <ActionButton
            variant="outline"
            disabled={pending || recovery.checking}
            onClick={recovery.recheckStorage}
          >
            重新检查操作记录
          </ActionButton>
        )}
      </>
    );
  return (
    <Notice
      tone="warning"
      title={pending ? "正在提交安全操作" : "安全操作结果尚未确认"}
    >
      <p>
        操作：{labels[recovery.record.action]}。目标标识：
        {recovery.record.target}。
      </p>
      <p>
        当前状态不能证明上次操作是否完成，也不能验证密码。请勿直接重试；需要重新登录时，先确认当前账号。
      </p>
      <ErrorNotice error={recovery.error} />
      {recovery.state && <p>{recovery.state}</p>}
      <ActionButton
        variant="outline"
        disabled={pending || recovery.checking}
        onClick={() => void recovery.inspect()}
      >
        查看当前状态
      </ActionButton>
      {recovery.state && (
        <p>
          关闭提醒不会取消原操作，也不表示原操作失败。再次提交可能重复执行，请先核实后再决定。
        </p>
      )}
      {recovery.state && (
        <ActionButton
          variant="ghost"
          disabled={pending || recovery.checking}
          onClick={() =>
            confirm({
              title: "关闭未确认操作的提醒？",
              description:
                "关闭提醒不会取消原操作，也不表示原操作失败。再次提交可能重复执行。请确认已核实当前状态，并自行决定是否进行新的操作。",
              confirmLabel: "关闭提醒",
              cancelLabel: "保留提醒",
              onConfirm: recovery.dismiss,
            })
          }
        >
          已查看状态，关闭提醒
        </ActionButton>
      )}
    </Notice>
  );
}
