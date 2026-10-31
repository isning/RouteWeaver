import type { Session } from "./types";
import { APIError, getSession, setCSRF, setToken } from "./api";
export type SessionSnapshot = {
  session: Session | null;
  phase: "checking" | "accepting" | "active" | "recovery" | "offline";
  concealed: boolean;
  refreshQueries: boolean;
  accountEpoch: number;
  generation: number;
  error: Error | null;
};
/** One in-memory owner for UI identity, transport credentials and recovery. */
export class SessionLifecycle {
  private snapshot: SessionSnapshot = {
    session: null,
    phase: "checking",
    concealed: true,
    refreshQueries: true,
    accountEpoch: 0,
    generation: 0,
    error: null,
  };
  private listeners = new Set<() => void>();
  private attempt = 0;
  private checkController: AbortController | null = null;
  private cancelCheck() {
    this.checkController?.abort();
    this.checkController = null;
  }
  private disposed = false;
  private notifyChange: () => void = () => {};
  setNotifier = (notify: () => void) => {
    this.notifyChange = notify;
  };
  changed = () => {
    this.notifyChange();
  };
  signedIn = (_session: Session) => {
    if (this.disposed) return;
    // Authentication may have changed the cookie before its body arrived.
    // Even an obsolete form completion must reconcile, never accept its payload.
    void this.check();
    this.changed();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(next: SessionSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  accept = (session: Session, refreshQueries = true) => {
    this.attempt++;
    this.cancelCheck();
    const previous = this.snapshot;
    const changedWorkspace =
      previous.session?.user.id !== session.user.id ||
      previous.session?.user.role !== session.user.role;
    const changedSession =
      changedWorkspace || previous.session?.csrfToken !== session.csrfToken;
    // Stay write-blocked until React has committed the matching account tree.
    this.publish({
      session,
      phase: "accepting",
      concealed: previous.concealed || changedWorkspace,
      accountEpoch: previous.accountEpoch + (changedWorkspace ? 1 : 0),
      generation: previous.generation + (changedSession ? 1 : 0),
      refreshQueries: refreshQueries || changedSession,
      error: null,
    });
  };
  commit = (generation: number) => {
    if (
      this.snapshot.phase !== "accepting" ||
      generation !== this.snapshot.generation
    )
      return;
    setCSRF(this.snapshot.session!.csrfToken);
    this.publish({ ...this.snapshot, phase: "active", concealed: false });
  };
  check = async (reason: "routine" | "changed" | "forbidden" = "routine") => {
    if (this.disposed) return;
    const attempt = ++this.attempt;
    this.cancelCheck();
    const controller = new AbortController();
    this.checkController = controller;
    let timedOut = false;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            new APIError(
              timedOut ? "确认登录状态超时。请重试。" : "登录状态检查已取消。",
              0,
            ),
          ),
        { once: true },
      );
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);
    this.publish({
      ...this.snapshot,
      phase: "checking",
      concealed: this.snapshot.concealed || reason === "changed",
      generation: this.snapshot.generation + (reason === "changed" ? 1 : 0),
      error: null,
    });
    try {
      const session = await Promise.race([
        getSession(controller.signal),
        cancelled,
      ]);
      if (this.disposed || attempt !== this.attempt) return;
      this.accept(session, reason !== "forbidden");
    } catch (error) {
      if (this.disposed || attempt !== this.attempt) return;
      this.publish({
        ...this.snapshot,
        concealed: true,
        generation: this.snapshot.generation + 1,
        phase:
          error instanceof APIError && [401, 403, 404].includes(error.status)
            ? "recovery"
            : "offline",
        error: error as Error,
      });
    } finally {
      clearTimeout(timeout);
      if (this.checkController === controller) this.checkController = null;
    }
  };
  pause = () => {
    this.attempt++;
    this.cancelCheck();
    this.publish({
      ...this.snapshot,
      phase: "offline",
      concealed: true,
      generation: this.snapshot.generation + 1,
      error: new APIError(
        "网络已断开。恢复连接后会先确认登录状态，当前输入保留在此页面。",
        0,
      ),
    });
  };
  expire = () => {
    this.attempt++;
    this.cancelCheck();
    this.publish({
      ...this.snapshot,
      phase: "recovery",
      concealed: true,
      generation: this.snapshot.generation + 1,
      error: null,
    });
  };
  forget = () => {
    if (this.disposed) return false;
    this.attempt++;
    this.cancelCheck();
    setCSRF("");
    setToken("");
    this.publish({
      session: null,
      phase: "recovery",
      concealed: true,
      refreshQueries: true,
      accountEpoch: this.snapshot.accountEpoch + 1,
      generation: this.snapshot.generation + 1,
      error: null,
    });
    this.changed();
    return true;
  };
  beforeRequest = () => {
    const generation = this.snapshot.generation;
    if (this.snapshot.phase !== "active") {
      if (
        this.snapshot.phase === "checking" ||
        this.snapshot.phase === "accepting"
      )
        throw new APIError(
          "正在确认登录状态，本次操作未发送。确认后请重试。",
          409,
        );
      if (this.snapshot.phase === "offline")
        throw new APIError(
          "暂时无法确认登录状态，本次操作未发送。恢复连接后请重试。",
          0,
        );
      throw new APIError("请先恢复登录，再检查当前输入并重试。", 401);
    }
    const beforeSend = () => {
      if (
        this.disposed ||
        this.snapshot.generation !== generation ||
        this.snapshot.phase !== "active"
      )
        throw new APIError(
          "无法确认本次操作的结果。请先检查最新内容，再决定是否重试。",
          409,
        );
    };
    const waitForResponse = async () => {
      // A routine check does not revoke an already-sent operation. Hold its
      // result until identity is confirmed; never resend the operation.
      const awaitingConfirmation = () =>
        !this.disposed &&
        !this.snapshot.concealed &&
        (this.snapshot.phase === "checking" ||
          this.snapshot.phase === "accepting");
      if (awaitingConfirmation())
        await new Promise<void>((resolve) => {
          const unsubscribe = this.subscribe(() => {
            if (!awaitingConfirmation()) {
              unsubscribe();
              resolve();
            }
          });
        });
      beforeSend();
    };
    return { waitForResponse, beforeSend };
  };
  failed = (error: APIError) => {
    if (error.status === 401) this.expire();
    else if (error.status === 403) void this.check("forbidden");
  };
  dispose = () => {
    this.disposed = true;
    this.attempt++;
    this.cancelCheck();
    this.listeners.forEach((listener) => listener());
  };
  start = () => {
    this.disposed = false;
    void this.check();
  };
}
