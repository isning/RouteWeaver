import { useId, useLayoutEffect, useRef, useState } from "react";
import { AppForm, useForm } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { ConnectionFields } from "./ConnectionFields";
import { connectorEditReason } from "./server-connector-editor";
import { prepareConnectorConnection, type ConnectorConnectionDraft } from "./server-connector-connection";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { useUnsavedChanges } from "./navigation";
import type { ServerProgram } from "./types";

/** Mount for one connector task. The parent must block its save/check/mode changes while open. */
export function ServerConnectorConnectionDialog({ program, schemaVersion, connectorId, onApply, onClose, onEditingChange }: {
  program: ServerProgram;
  schemaVersion: string;
  connectorId: string;
  onApply: (nextProgram: ServerProgram) => boolean;
  onClose: () => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const [form] = useForm<{ connection: ConnectorConnectionDraft }>();
  const formId = useId();
  const source = useRef({ program, schemaVersion, connectorId });
  const original = source.current.program.connectors?.find((item) => item.id === source.current.connectorId);
  const [initial] = useState(() => ({ connection: structuredClone(original?.connection) as ConnectorConnectionDraft }));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const current = useRef({ program, schemaVersion, connectorId, onApply, onClose });
  current.current = { program, schemaVersion, connectorId, onApply, onClose };
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  const { confirm, confirming } = useDiscardConfirmation(`${program.instance.id}:${program.listener.id}:${connectorId}`);
  useUnsavedChanges(dirty);
  useLayoutEffect(() => {
    active.current = true;
    editingCallback.current(true);
    return () => { active.current = false; editingCallback.current(false); };
  }, []);
  const stale = () => current.current.program !== source.current.program || current.current.schemaVersion !== source.current.schemaVersion || current.current.connectorId !== source.current.connectorId;
  const reason = connectorEditReason(program, schemaVersion, connectorId) ||
    (original?.connection?.transport && "headerRows" in original.connection.transport ? "连接器含有与表单冲突的扩展参数，请在完整 JSON 中编辑。" : undefined);
  const close = () => {
    if (!active.current || confirming) return;
    if (dirty) confirm({ title: "放弃连接参数修改？", description: "尚未采用的连接参数将被丢弃，策略草稿保持不变。", confirmLabel: "放弃修改", cancelLabel: "继续编辑" }, () => {
      active.current = false;
      current.current.onClose();
    });
    else { active.current = false; current.current.onClose(); }
  };
  const accept = (connection: NonNullable<ReturnType<typeof prepareConnectorConnection>["connection"]>) => {
    if (!active.current || stale()) { setError("策略草稿已改变，请关闭后重新打开连接参数，避免覆盖新修改。"); return; }
    const nextProgram = { ...program, connectors: program.connectors!.map((item) => item.id === connectorId ? { ...item, connection } : item) };
    if (!current.current.onApply(nextProgram)) { setError("连接器已改变，未覆盖当前草稿。请关闭后重新打开。"); return; }
    active.current = false;
    current.current.onClose();
  };
  return <TaskDialog open title="编辑连接参数" onOpenChange={(open) => { if (!open) close(); }} pending={confirming}
    footer={<div className="flex flex-wrap justify-end gap-2">
      <ActionButton variant="outline" onClick={close} disabled={confirming}>取消</ActionButton>
      <ActionButton type="submit" form={formId} disabled={!!reason || confirming || stale()}>采用连接参数</ActionButton>
    </div>}>
    <p className="break-all text-sm">连接器 {connectorId}</p>
    <p className="text-sm text-muted-foreground">采用后会修改所有引用此连接器的规则所使用的连接；保存草稿不会自动应用到核心。</p>
    {(reason || error || stale()) && <p role="alert" className="text-sm text-destructive">{reason || error || "策略草稿已改变，请关闭后重新打开连接参数。"}</p>}
    {!reason && original && <AppForm form={form} id={formId} initialValues={initial} disabled={confirming}
      onValuesChange={() => { setDirty(true); setError(""); }}
      onFinish={() => {
        if (!active.current || confirming || stale()) return;
        const prepared = prepareConnectorConnection(original.connection, form.getFieldsValue(true).connection);
        if (prepared.error || !prepared.connection) { setError(prepared.error || "请检查连接参数。"); return; }
        const connection = prepared.connection;
        if (prepared.removedFields.length) confirm({ title: "移除不适用的连接参数？", description: `本次协议、安全或传输切换将移除：${prepared.removedFields.join("、")}。其他参数保留。`, confirmLabel: "移除并采用", cancelLabel: "返回编辑" }, () => accept(connection));
        else accept(connection);
      }}>
      <ConnectionFields targetCore={program.instance.adapterId.replace(/^routeweaver\//, "")} />
    </AppForm>}
  </TaskDialog>;
}
