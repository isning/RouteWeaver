import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useState } from "react";
import { DraftIntegerInput, exactDraftInteger } from "./draft-integer";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowUp, Trash2, Plus } from "lucide-react";
import type { EndpointFilter, PipelineStep } from "./types";
import { moveItem, newStep } from "./model";
const kinds = [
  { value: "keep", label: "保留匹配" },
  { value: "drop", label: "排除匹配" },
  { value: "rename", label: "重新命名" },
  { value: "sort", label: "排序" },
  { value: "deduplicate", label: "去除重复连接" },
  { value: "override", label: "字段覆盖" },
];
export function processingStepLabel(kind: string) {
  return kinds.find((item) => item.value === kind)?.label || kind;
}
export function FilterFields({
  value,
  onChange,
}: {
  value: EndpointFilter;
  onChange: (v: EndpointFilter) => void;
}) {
  return (
    <div className="form-grid grid min-w-0 gap-4 sm:col-span-2 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
      <label>
        名称正则
        <Input
          value={value.namePattern ?? ""}
          placeholder="例如 HK|香港"
          onChange={(e) => onChange({ ...value, namePattern: e.target.value })}
        />
      </label>
      <label>
        地区
        <Input
          value={value.region ?? ""}
          placeholder="全部地区"
          onChange={(e) => onChange({ ...value, region: e.target.value })}
        />
      </label>
      <label>
        连接协议
        <ChoiceSelect
          clearable
          value={value.protocol || undefined}
          options={["socks", "shadowsocks", "vless"].map((v) => ({
            value: v,
            label: v,
          }))}
          placeholder="所有协议"
          onValueChange={(protocol) => onChange({ ...value, protocol })}
        />
      </label>
      <label>
        包含标签
        <MultiChoice
          value={value.tags || []}
          placeholder="输入标签"
          onValueChange={(tags) => onChange({ ...value, tags })}
          creatable
          options={[]}
        />
      </label>
    </div>
  );
}
export function StepsEditor({
  value,
  onChange,
  label = "处理步骤",
  emptyText = "未添加处理步骤",
  portDrafts,
  onPortInput,
  portFocus,
  onPortFocused,
}: {
  portDrafts?: Record<string, string>;
  onPortInput?: (id: string, raw: string) => void;
  portFocus?: { id: string; request: number };
  onPortFocused?: () => void;
  value: PipelineStep[];
  onChange: (v: PipelineStep[]) => void;
  label?: string;
  /** Context-specific empty state; null keeps the step controls without prose. */
  emptyText?: string | null;
}) {
  const [localPortDrafts, setLocalPortDrafts] = useState<Record<string, string>>({});
  const rawPorts = portDrafts ?? localPortDrafts;
  const update = (index: number, patch: Partial<PipelineStep>) =>
    onChange(
      value.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  return (
    <div className="steps-editor space-y-4" role="group" aria-label={label}>
      <div className="section-heading compact mb-4 flex flex-wrap items-center justify-between gap-3 [&>h3]:font-semibold">
        <h3>{label}</h3>
        <ChoiceSelect
          aria-label="添加处理步骤"
          placeholder="添加处理步骤"
          options={kinds}
          value={undefined}
          onValueChange={(kind) => {
            if (kind === undefined) return;
            return onChange([...value, newStep(kind)]);
          }}
        />
      </div>
      {!value.length && emptyText && (
        <div className="inline-empty rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      )}
      {value.map((step, index) => (
        <div
          className={`processing-step space-y-3 rounded-lg border bg-card p-4 ${step.enabled ? "" : "step-disabled"}`}
          key={step.id}
        >
          <div className="step-top flex flex-wrap items-center justify-between gap-3">
            <div className="step-heading flex min-w-0 flex-wrap items-center gap-2">
              <span className="step-index flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {index + 1}
              </span>
              <strong className="text-sm font-medium">
                {processingStepLabel(step.kind)}
              </strong>
              <span className="step-state text-xs text-muted-foreground">
                {step.enabled ? "已启用" : "已停用"}
              </span>
            </div>
            <div className="step-actions ml-auto flex shrink-0 items-center gap-1">
              <Switch
                className="data-[size=default]:h-11 data-[size=default]:w-11 rounded-md px-1.5 data-checked:bg-transparent data-unchecked:bg-transparent dark:data-unchecked:bg-transparent after:inset-0 before:absolute before:inset-x-1.5 before:top-1/2 before:h-[18.4px] before:-translate-y-1/2 before:rounded-full before:bg-input data-checked:before:bg-primary dark:data-unchecked:before:bg-input/80"
                checked={step.enabled}
                aria-label={`启用步骤 ${index + 1}`}
                onCheckedChange={(enabled) => update(index, { enabled })}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <ActionButton
                    aria-label={`上移步骤 ${index + 1}`}
                    aria-disabled={index === 0}
                    leadingIcon={<ArrowUp aria-hidden="true" />}
                    onClick={() =>
                      index > 0 && onChange(moveItem(value, index, index - 1))
                    }
                    variant="ghost"
                    size="sm"
                    className="aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
                  />
                </TooltipTrigger>
                <TooltipContent>上移</TooltipContent>
              </Tooltip>
              <ActionButton
                aria-label={`下移步骤 ${index + 1}`}
                aria-disabled={index === value.length - 1}
                leadingIcon={<ArrowDown aria-hidden="true" />}
                onClick={() =>
                  index < value.length - 1 &&
                  onChange(moveItem(value, index, index + 1))
                }
                variant="ghost"
                size="sm"
                className="aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
              />
              <ActionButton
                aria-label={`删除步骤 ${index + 1}`}
                leadingIcon={<Trash2 aria-hidden="true" />}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                variant="ghost"
                size="sm"
              />
            </div>
          </div>
          <div className="step-fields mt-4 grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
            {["keep", "drop", "override"].includes(step.kind) && (
              <FilterFields
                value={step.filter || {}}
                onChange={(filter) => update(index, { filter })}
              />
            )}
            {step.kind === "rename" && (
              <label className="field-full sm:col-span-2">
                命名模板
                <Input
                  value={step.template}
                  aria-label={`步骤 ${index + 1} 命名模板`}
                  onChange={(e) => update(index, { template: e.target.value })}
                />
                <small className="grid gap-2 font-normal leading-relaxed text-muted-foreground">
                  <span className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <span>
                      原名称 <code>{"{name}"}</code>
                    </span>
                    <span>
                      来源名称 <code>{"{source}"}</code>
                    </span>
                    <span>
                      地区 <code>{"{region}"}</code>
                    </span>
                    <span>
                      节点标识 <code>{"{id}"}</code>
                    </span>
                  </span>
                  <span>改名后保留节点身份。</span>
                </small>
              </label>
            )}
            {step.kind === "sort" && (
              <>
                <label>
                  排序依据
                  <ChoiceSelect
                    value={step.sortBy}
                    options={[
                      { value: "name", label: "名称" },
                      { value: "region", label: "地区" },
                      { value: "protocol", label: "协议" },
                    ]}
                    onValueChange={(sortBy) => {
                      if (sortBy === undefined) return;
                      return update(index, { sortBy });
                    }}
                  />
                </label>
                <label>
                  顺序
                  <ChoiceSelect
                    value={step.descending ? "desc" : "asc"}
                    options={[
                      { value: "asc", label: "升序" },
                      { value: "desc", label: "降序" },
                    ]}
                    onValueChange={(value) => {
                      if (value === undefined) return;
                      return update(index, { descending: value === "desc" });
                    }}
                  />
                </label>
              </>
            )}
            {step.kind === "deduplicate" && (
              <p className="muted field-full text-sm text-muted-foreground sm:col-span-2">
                按连接内容合并重复项，保留同名的不同连接及来源信息。
              </p>
            )}
            {step.kind === "override" && (
              <>
                <label>
                  覆盖地区
                  <Input
                    value={step.override?.region}
                    onChange={(e) =>
                      update(index, {
                        override: { ...step.override, region: e.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  覆盖端口
                  <DraftIntegerInput
                    max={65535}
                    value={step.override?.port}
                    raw={rawPorts[step.id]}
                    focusRequest={portFocus?.id === step.id ? portFocus.request : 0}
                    onFocusHandled={onPortFocused}
                    onInput={(raw) => {
                      if (onPortInput) onPortInput(step.id, raw);
                      else setLocalPortDrafts((previous) => ({ ...previous, [step.id]: raw }));
                      const port = raw === "" ? undefined : exactDraftInteger(raw, 65535);
                      if (raw === "" || port !== undefined) update(index, {
                        override: { ...step.override, port },
                      });
                    }}
                  />
                </label>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
