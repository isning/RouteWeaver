import { removeServerConnector } from "./server-connector-collection";
import { ActionButton } from "@/ui-patterns/actions";
import { Input } from "@/components/ui/input";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { connectorEditReason, connectorViaChoices, updateServerConnector, updateServerConnectorVia } from "./server-connector-editor";
import type { ServerProgram } from "./types";

/** Controlled fields participate in the policy draft's existing review and discard flow. */
export function ServerConnectorEditor({ program, schemaVersion, label, onChange, onEditConnection, onRemove, disabled = false }: {
  program: ServerProgram;
  schemaVersion: string;
  label: string;
  onChange: (program: ServerProgram) => void;
  disabled?: boolean;
  onRemove?: (connectorId: string) => void;
  onEditConnection?: (connectorId: string, focusLabel: string) => void;
}) {
  if (!program.connectors?.length) return <p className="text-sm text-muted-foreground">
    {program.egress?.length ? "顺序出口请在完整 JSON 中编辑。" : "未配置连接器"}
  </p>;
  return <div className="space-y-3">
    {program.connectors.map((connector, index) => {
      const reason = connectorEditReason(program, schemaVersion, connector.id);
      const prefix = `${label} 连接器 ${index + 1}`;
      const removalReason = onRemove ? removeServerConnector(program, schemaVersion, connector.id).error : undefined;
      const fields = { host: connector.connection?.host || "", port: String(connector.connection?.port ?? ""), via: connector.via || "" };
      // A temporarily incomplete address does not change topology choices.
      const options = [{ value: "", label: "无上游连接器" }, ...connectorViaChoices(program, connector.id)];
      const addressError = !reason && updateServerConnector(program, schemaVersion, connector.id, fields).error;
      return <div key={`${connector.id}:${index}`} data-connector-instance={program.instance.id} data-connector-listener={program.listener.id} data-connector-id={connector.id} className="min-w-0 space-y-3 rounded-lg bg-muted/30 p-3">
        <p className="break-all font-medium">{connector.id}</p>
        {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : <>
          <label className="block space-y-1 text-sm">
            <span>地址</span>
            <Input aria-label={`${prefix} 地址`} aria-invalid={!!addressError} value={fields.host} disabled={disabled}
              onChange={(event) => onChange({ ...program, connectors: program.connectors!.map((item, itemIndex) => itemIndex === index ? { ...item, connection: { ...item.connection, host: event.target.value } } : item) })} />
          </label>
          {addressError && <p role="alert" className="text-sm text-destructive">{addressError}</p>}
          <div className="space-y-1 text-sm">
            <span>上游连接器</span>
            <ChoiceSelect aria-label={`${prefix} 上游连接器`} value={fields.via} options={options} disabled={disabled}
              onValueChange={(via) => {
                if (via === undefined) return;
                // Only patch via here: retain even an incomplete address in the draft.
                const result = updateServerConnectorVia(program, schemaVersion, connector.id, via);
                if (result.program) onChange(result.program);
              }} />
          </div>
        </>}
        {!reason && onEditConnection && <ActionButton variant="outline" disabled={disabled} aria-label={`${prefix} 编辑连接参数`} onClick={() => onEditConnection(connector.id, `${prefix} 编辑连接参数`)}>编辑连接参数</ActionButton>}
        {onRemove && <div className="space-y-1">
          <ActionButton variant="outline" disabled={disabled || !!removalReason} aria-label={`${prefix} 删除连接器`} onClick={() => onRemove(connector.id)}>删除连接器</ActionButton>
          {removalReason && <p className="text-sm text-muted-foreground">{removalReason}</p>}
        </div>}
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt className="text-muted-foreground">协议</dt><dd>{connector.connection?.protocol || "未知"}</dd>
          <dt className="text-muted-foreground">端口</dt><dd>{connector.connection?.port ?? "未设置"}</dd>
          {reason && <><dt className="text-muted-foreground">上游连接器</dt><dd className="break-all">{connector.via || "无"}</dd></>}
        </dl>
      </div>;
    })}
    <p className="text-sm text-muted-foreground">修改地址、上游或连接参数会影响所有引用此连接器的规则。</p>
  </div>;
}
