import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { APIError, post, request } from "./api";
import { ErrorNotice, Section } from "./components";
import { loadInfrastructure } from "./infrastructure-data";
import { newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import type { PublishedRoute } from "./PublishedRoutes";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import { TLSMaterial } from "./TLSMaterial";
import type { Infrastructure, ServerDeployment, ServerTLS } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
const securityChanges = {
  "tls-disabled": "新出口将停用 TLS",
  "tls-enabled": "新出口将启用 TLS",
  "server-name-changed": "TLS 服务端名称将变更",
  "tls-options-changed": "TLS 连接选项将变更",
  "transport-settings-changed": "传输设置将变更",
  "flow-changed": "流控设置将变更",
  "packet-encoding-changed": "数据包编码将变更",
} as const;
type SecurityChange = keyof typeof securityChanges;
type RetargetInput = {
  replacementEndpointId: string;
  tls?: ServerTLS;
  expectedRouteRevision: string;
  expectedDeploymentRevision: string;
};
type EndpointReview = {
  endpointId: string;
  name: string;
  host: string;
  port: number;
  protocol: string;
  security: "tls" | "none";
  transport: string;
  tlsMaterial?: "none" | "paths-only" | "provided";
};
export type RouteExitReview = {
  routeId: string;
  routeName: string;
  reviewToken: string;
  before: EndpointReview;
  after: EndpointReview;
  affectedUsers: number;
  securityChanges?: SecurityChange[];
  addedProgram: boolean;
  isolatedConnector: boolean;
  legacyNormalized: boolean;
  nativeChecked: false;
  publicEntryPreserved: true;
  credentialsPreserved: true;
  oldProgramRetained: true;
  applicationReadiness:
    | {
        state: "requires-apply-check";
      }
    | {
        state: "blocked";
        code: "tls-material-required";
        endpointIds: string[];
      };
};
type CommitInput = RetargetInput & {
  reviewToken: string;
  operationId: string;
};
type CommitResult = {
  operationId: string;
  routeId: string;
} & (
  | {
      status: "draft-saved";
      routeRevision: string;
      deploymentRevision: string;
    }
  | {
      status: "draft-rejected";
      code: "EXIT_DRAFT_REJECTED";
      detail: string;
    }
);
const securityLabel = (endpoint: EndpointReview) =>
  `${endpoint.protocol.toUpperCase()} · ${endpoint.transport.toUpperCase()} · ${endpoint.security === "tls" ? "TLS" : "未启用 TLS"}`;
const address = (endpoint: EndpointReview) =>
  `${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
/** A route-scoped reviewed draft mutation. The browser never reconstructs server IR. */
export function RouteExitEditor({
  route,
  deployment,
  inventory,
  onClose,
  onSaved,
  open = true,
  onPendingChange,
  onAfterClose,
}: {
  route: PublishedRoute;
  deployment: ServerDeployment;
  inventory: Infrastructure;
  onClose: (pending?: boolean) => void;
  onSaved: () => void;
  open?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onAfterClose?: () => void;
}) {
  const { confirm: confirmDiscard } = useDiscardConfirmation(route.id);
  const client = useQueryClient();
  const [baseline, setBaseline] = useState({ route, deployment, inventory });
  const [endpointId, setEndpointId] = useState<string>();
  const [tls, setTLS] = useState<ServerTLS>({});
  const [selectionPending, setSelectionPending] = useState(false);
  const [reviewed, setReviewed] = useState<{
    input: RetargetInput;
    review: RouteExitReview;
  }>();
  const [commit, setCommit] = useState<CommitInput>();
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const sequence = useRef(0);
  const selectedIdentity = useRef<string | undefined>(undefined);
  const tlsDrafts = useRef<Record<string, ServerTLS>>({});
  const running = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const choiceArea = useRef<HTMLDivElement>(null);
  const returningToChoice = useRef(false);
  const focusTLS = useRef(false);
  useLayoutEffect(() => {
    if (!reviewed && returningToChoice.current) {
      const material = focusTLS.current
        ? choiceArea.current?.querySelector<HTMLElement>(
            ".tls-material textarea",
          )
        : null;
      (
        material ||
        choiceArea.current?.querySelector<HTMLElement>('[role="combobox"]')
      )?.focus();
      focusTLS.current = false;
      returningToChoice.current = false;
    }
  }, [reviewed]);
  useEffect(() => {
    if (reviewed) reviewHeading.current?.focus({ preventScroll: true });
  }, [reviewed]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  useUnsavedChanges(open && (!!endpointId || selectionPending || uncertain));
  const selected = baseline.inventory.endpoints.find(
    (entry) => entry.id === endpointId,
  );
  const existingProgram = baseline.deployment.ir.programs.find(
    (program) => program.listener.id === endpointId,
  );
  const needsTLS = !!selected?.connection.tls?.enabled && !existingProgram;
  const entry = baseline.deployment.ir.programs.find(
    (program) => program.listener.id === baseline.route.endpointIds[0],
  );
  const missingRevision =
    !baseline.route.revisionToken || !baseline.deployment.revisionToken;
  const locked = busy !== null || uncertain;
  const materialGeneration = sequence.current;
  const formEditable = useRef(false);
  formEditable.current = open && !reviewed && !locked && !selectionPending;
  const resetReview = () => {
    sequence.current++;
    setReviewed(undefined);
    setCommit(undefined);
    setConflict(false);
    setError(null);
  };
  const choose = (id: string) => {
    resetReview();
    if (selectedIdentity.current)
      tlsDrafts.current[selectedIdentity.current] = tls;
    selectedIdentity.current = id;
    setEndpointId(id);
    // Each explicit endpoint owns its own local material draft. Switching cannot
    // copy a key to another endpoint or lose a previous endpoint's entered values.
    setTLS(tlsDrafts.current[id] || {});
  };
  const pendingSelection = useCallback((pending: boolean) => {
    setSelectionPending(pending);
    if (pending) {
      sequence.current++;
      setReviewed(undefined);
      setCommit(undefined);
    }
  }, []);
  const inspect = async (refresh = false) => {
    if (!endpointId || selectionPending || running.current || uncertain) return;
    running.current = true;
    const currentSequence = ++sequence.current;
    setBusy("check");
    setError(null);
    setReviewed(undefined);
    setCommit(undefined);
    try {
      let next = baseline;
      if (refresh || missingRevision) {
        const [latestRoute, latestInventory] = await Promise.all([
          request<PublishedRoute>(
            `/published-routes/${encodeURIComponent(route.id)}/resolve`,
          ),
          loadInfrastructure(),
        ]);
        const latestDeployment = latestInventory.deployments.find(
          (item) => item.id === latestRoute.deploymentId,
        );
        if (!latestDeployment)
          throw new Error("转发路径暂不可用。请重新核对线路。");
        next = {
          route: latestRoute,
          deployment: latestDeployment,
          inventory: latestInventory,
        };
        if (mounted.current && sequence.current === currentSequence)
          setBaseline(next);
      }
      if (!next.route.revisionToken || !next.deployment.revisionToken)
        throw new Error("无法取得线路的最新版本，请重新核对后再试。");
      const target = next.inventory.endpoints.find(
        (item) => item.id === endpointId,
      );
      if (!target)
        throw new Error("所选出口已不可用。选择已保留，请选择其他端点。");
      const suppliedTLS =
        target.connection.tls?.enabled &&
        !next.deployment.ir.programs.some(
          (program) => program.listener.id === endpointId,
        );
      const input: RetargetInput = {
        replacementEndpointId: endpointId,
        ...(suppliedTLS && Object.keys(tls).length ? { tls } : {}),
        expectedRouteRevision: next.route.revisionToken,
        expectedDeploymentRevision: next.deployment.revisionToken,
      };
      const review = await post<RouteExitReview>(
        `/published-routes/${encodeURIComponent(route.id)}/retarget/preview`,
        input,
      );
      if (
        review.routeId !== route.id ||
        review.after?.endpointId !== endpointId ||
        typeof review.reviewToken !== "string" ||
        !review.reviewToken ||
        typeof review.before?.name !== "string" ||
        typeof review.before?.host !== "string" ||
        !Number.isFinite(review.before?.port) ||
        typeof review.after?.name !== "string" ||
        typeof review.after?.host !== "string" ||
        !Number.isFinite(review.after?.port) ||
        !Number.isInteger(review.affectedUsers) ||
        review.affectedUsers < 0 ||
        review.nativeChecked !== false ||
        [review.before, review.after].some(
          (endpoint) =>
            typeof endpoint.protocol !== "string" ||
            typeof endpoint.transport !== "string" ||
            !["tls", "none"].includes(endpoint.security),
        ) ||
        (review.securityChanges !== undefined &&
          (!Array.isArray(review.securityChanges) ||
            review.securityChanges.some(
              (code) => !Object.hasOwn(securityChanges, code),
            ))) ||
        review.publicEntryPreserved !== true ||
        review.credentialsPreserved !== true ||
        review.oldProgramRetained !== true ||
        !review.applicationReadiness ||
        !["blocked", "requires-apply-check"].includes(
          review.applicationReadiness.state,
        ) ||
        (review.applicationReadiness.state === "blocked" &&
          (review.applicationReadiness.code !== "tls-material-required" ||
            !Array.isArray(review.applicationReadiness.endpointIds)))
      )
        throw new Error("检查结果与所选线路或出口不一致，请重新检查。");
      if (mounted.current && sequence.current === currentSequence) {
        setReviewed({ input, review });
        setConflict(false);
      }
    } catch (caught) {
      if (mounted.current && sequence.current === currentSequence) {
        setError(caught as Error);
        if (caught instanceof APIError && caught.status === 409)
          setConflict(true);
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const save = async () => {
    if (!reviewed || running.current || selectionPending) return;
    running.current = true;
    const input = commit || {
      ...reviewed.input,
      reviewToken: reviewed.review.reviewToken,
      operationId: newID("retarget"),
    };
    setCommit(input);
    setBusy("save");
    setError(null);
    onPendingChange?.(true);
    try {
      const result = await post<CommitResult>(
        `/published-routes/${encodeURIComponent(route.id)}/retarget`,
        input,
      );
      if (
        result.operationId !== input.operationId ||
        result.routeId !== route.id
      )
        throw new Error("保存响应无法核对，请核对本次保存结果。");
      if (result.status === "draft-rejected") {
        if (
          result.code !== "EXIT_DRAFT_REJECTED" ||
          typeof result.detail !== "string" ||
          !result.detail.trim()
        )
          throw new Error("保存响应无法核对，请核对本次保存结果。");
        if (mounted.current) {
          returningToChoice.current = true;
          setUncertain(false);
          setCommit(undefined);
          setReviewed(undefined);
          setConflict(true);
          setError(new Error(`本次修改未保存：${result.detail}`));
          onPendingChange?.(false);
        }
        return;
      }
      if (
        result.status !== "draft-saved" ||
        typeof result.routeRevision !== "string" ||
        !result.routeRevision ||
        typeof result.deploymentRevision !== "string" ||
        !result.deploymentRevision
      )
        throw new Error("保存响应无法核对，请核对本次保存结果。");
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      client.invalidateQueries({ queryKey: ["published-routes"] });
      client.invalidateQueries({
        queryKey: ["published-route-resolve", route.id],
      });
      if (mounted.current) {
        setUncertain(false);
        onSaved();
      }
    } catch (caught) {
      if (mounted.current) {
        // Only an exact durable terminal receipt resolves a sent command.
        // Auth, validation/status and transport failures are not such a receipt.
        setUncertain(true);
        onPendingChange?.(true);
        setError(caught as Error);
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const close = () => {
    if (busy === "save" || uncertain) {
      onClose(true);
      return;
    }
    if (!endpointId && !selectionPending) {
      onClose();
      return;
    }
    confirmDiscard(
      {
        title: "放弃尚未保存的出口变更？",
        description: "已保存的线路和服务器配置不受影响。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(false),
    );
  };
  return (
    <TaskSheet
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      title={`更换「${route.name}」的出口`}
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onReady={() =>
        ((visible) => {
          if (visible && reviewed)
            reviewHeading.current?.focus({ preventScroll: true });
          if (!visible) onAfterClose?.();
        })(true)
      }
      onClosed={() => {
        ((visible) => {
          if (visible && reviewed)
            reviewHeading.current?.focus({ preventScroll: true });
          if (!visible) onAfterClose?.();
        })(false);
      }}
      size="lg"
      onCloseAutoFocus={(event) => event.preventDefault()}
      footer={
        reviewed ? (
          <ActionButton
            aria-label={uncertain ? "核对保存结果" : "保存出口草稿"}
            pending={busy === "save"}
            disabled={busy === "check" || selectionPending}
            onClick={save}
            variant="default"
          >
            {uncertain ? "核对保存结果" : "保存出口草稿"}
          </ActionButton>
        ) : (
          <ActionButton
            aria-label={
              conflict || missingRevision ? "检查最新变更" : "检查变更"
            }
            pending={busy === "check"}
            disabled={!endpointId || selectionPending || busy === "save"}
            onClick={() => inspect(conflict)}
            variant="default"
          >
            {conflict || missingRevision ? "检查最新变更" : "检查变更"}
          </ActionButton>
        )
      }
    >
      <ErrorNotice error={error} />
      {(uncertain || busy === "save") && (
        <Notice
          tone="warning"
          title="保存结果尚未确认"
          action={
            <ActionButton onClick={() => onClose(true)} variant="outline">
              返回线路
            </ActionButton>
          }
        >
          {
            "\u5173\u95ED\u4E0D\u4F1A\u53D6\u6D88\u5DF2\u53D1\u9001\u7684\u8BF7\u6C42\uFF1B\u8FD4\u56DE\u540E\u53EF\u7EE7\u7EED\u6838\u5BF9\u540C\u4E00\u6B21\u4FDD\u5B58\u3002"
          }
        </Notice>
      )}
      {!reviewed && (
        <div ref={choiceArea} inert={locked}>
          <Section title="选择新出口">
            <p>
              入口保持为{" "}
              <strong>
                {entry?.listener.name || baseline.route.endpointIds[0]}
              </strong>
              。
            </p>
            <ServerEndpointSelect
              inventory={baseline.inventory}
              label="新出口"
              value={endpointId}
              allowedIds={baseline.inventory.endpoints
                .filter((item) => !baseline.route.endpointIds.includes(item.id))
                .map((item) => item.id)}
              unavailableReason="入口和当前出口不在本次替换范围内。"
              onChange={choose}
              onPendingChange={pendingSelection}
            />
            {needsTLS && !selectionPending && (
              <Section title={`${selected?.name || "新出口"}的 TLS 设置`}>
                <p>
                  此端点尚未加入转发路径，请提供它的服务端证书设置。不会关闭端点的
                  TLS。
                </p>
                <div className="form-grid grid gap-4 sm:grid-cols-2">
                  <label className="standalone-label grid gap-2 text-sm font-medium">
                    证书路径
                    <Input
                      value={tls.certificatePath}
                      onChange={(event) => {
                        resetReview();
                        setTLS({ ...tls, certificatePath: event.target.value });
                      }}
                    />
                  </label>
                  <label className="standalone-label grid gap-2 text-sm font-medium">
                    私钥路径
                    <Input
                      value={tls.keyPath}
                      onChange={(event) => {
                        resetReview();
                        setTLS({ ...tls, keyPath: event.target.value });
                      }}
                    />
                  </label>
                </div>
                <TLSMaterial
                  key={endpointId}
                  value={tls}
                  onChange={(next) => {
                    if (
                      selectedIdentity.current !== endpointId ||
                      sequence.current !== materialGeneration ||
                      running.current ||
                      !formEditable.current
                    )
                      return;
                    resetReview();
                    setTLS(next);
                  }}
                />
              </Section>
            )}
          </Section>
        </div>
      )}
      {reviewed && (
        <Section>
          <h2
            className="rounded-sm text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
            ref={reviewHeading}
            tabIndex={-1}
          >
            核对草稿变更
          </h2>
          <dl className="route-exit-diff my-5 grid gap-4 md:grid-cols-2 [&>div]:min-w-0 [&>div]:rounded-lg [&>div]:bg-muted/50 [&>div]:p-4 [&_dt]:mb-1 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:break-words [&_dd]:font-semibold [&_small]:mt-1 [&_small]:block [&_small]:font-normal [&_small]:text-muted-foreground">
            <div>
              <dt>已保存出口</dt>
              <dd>
                {reviewed.review.before.name} ·{" "}
                {address(reviewed.review.before)}
                <small>{securityLabel(reviewed.review.before)}</small>
              </dd>
            </div>
            <div>
              <dt>新出口</dt>
              <dd>
                {reviewed.review.after.name} · {address(reviewed.review.after)}
                <small>{securityLabel(reviewed.review.after)}</small>
              </dd>
            </div>
          </dl>
          {!!reviewed.review.securityChanges?.length && (
            <Notice tone="warning" title="连接安全与传输变更">
              {reviewed.review.securityChanges
                .map((code) => securityChanges[code])
                .join("；")}
            </Notice>
          )}
          <ul className="route-exit-impact my-5 list-disc space-y-2 pl-5">
            <li>影响此线路的 {reviewed.review.affectedUsers} 位关联用户</li>
            <li>其他线路和默认转发不变</li>
            <li>入口和用户凭据不变</li>
          </ul>
          {reviewed.review.applicationReadiness.state === "blocked" && (
            <Notice
              tone="warning"
              title="仅保存证书路径，尚不能应用。请补充证书和私钥 PEM。"
              action={
                needsTLS &&
                reviewed.review.applicationReadiness.endpointIds.includes(
                  endpointId || "",
                ) ? (
                  <ActionButton
                    disabled={locked}
                    onClick={() => {
                      focusTLS.current = true;
                      returningToChoice.current = true;
                      setReviewed(undefined);
                      setCommit(undefined);
                    }}
                    variant="outline"
                  >
                    补充 TLS 材料
                  </ActionButton>
                ) : (
                  <ActionButton variant="outline" asChild>
                    <a
                      href={`#routes?deployment=${encodeURIComponent(baseline.deployment.id)}&line=${encodeURIComponent(route.id)}`}
                      aria-disabled={locked}
                      tabIndex={locked ? -1 : undefined}
                      onClick={(event) => {
                        if (locked) {
                          event.preventDefault();
                          return;
                        }
                      }}
                    >
                      检查转发路径的 TLS 设置
                    </a>
                  </ActionButton>
                )
              }
            >
              {reviewed.review.applicationReadiness.endpointIds
                .map(
                  (id) =>
                    baseline.inventory.endpoints.find((item) => item.id === id)
                      ?.name || id,
                )
                .join("、")}
            </Notice>
          )}
          <p>
            保存后需单独应用，不会重新发布订阅；应用生效后，使用此入口的已有客户端也会改用新出口。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              disabled={locked}
              onClick={() => {
                returningToChoice.current = true;
                setReviewed(undefined);
                setCommit(undefined);
              }}
              variant="outline"
            >
              继续选择出口
            </ActionButton>
          </div>
        </Section>
      )}
    </TaskSheet>
  );
}
