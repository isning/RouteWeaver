import { Textarea } from "@/components/ui/textarea";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Notice } from "@/ui-patterns/notice";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import type {
  NativeClientOverride,
  NativeOverrideReview,
  Profile,
} from "./types";
export function NativeOverrideEditor({
  value,
  target,
  mode,
  onChange,
  useFullMode,
}: {
  value?: NativeClientOverride;
  target: Profile["target"];
  mode?: string;
  onChange: (value: NativeClientOverride | undefined) => void;
  useFullMode: () => void;
}) {
  const confirm = useConfirm();
  if (!value)
    return (
      <div className="space-y-3">
        <p className="muted text-sm text-muted-foreground">
          用目标客户端的原生字段补充
          DNS、分流或策略。原生覆盖与当前客户端版本绑定，不会自动转换为其他客户端格式。
        </p>
        <ActionButton
          onClick={() =>
            onChange({
              schemaVersion: "1",
              namespace: "routeweaver/native-client",
              target: { ...target },
              format: "json",
              ruleMode: "prepend",
              content: "{}",
            })
          }
          variant="outline"
        >
          添加原生覆盖
        </ActionButton>
      </div>
    );
  const mismatched =
    value.target.adapterId !== target.adapterId ||
    value.target.version !== target.version;
  const update = (patch: Partial<NativeClientOverride>) =>
    onChange({ ...value, ...patch });
  return (
    <div className="native-override-editor space-y-4">
      <div className="section-heading mb-4 flex flex-wrap items-center justify-between gap-3 [&>h3]:font-semibold">
        <div className={"flex flex-wrap items-center gap-2"}>
          <Badge variant="secondary">
            {value.target.adapterId} {value.target.version}
          </Badge>
          <span className="muted text-sm text-muted-foreground">
            目标专用 · 不自动转换
          </span>
        </div>
        <ActionButton
          onClick={() =>
            confirm({
              title: "移除这段原生覆盖？",
              description: "只从当前草稿移除。已发布订阅不会随之改变。",
              confirmLabel: "移除覆盖",
              cancelLabel: "保留",
              destructive: true,
              onConfirm: () => onChange(undefined),
            })
          }
          variant="destructive"
        >
          移除覆盖
        </ActionButton>
      </div>
      {mismatched && (
        <Notice tone="warning" title="原生覆盖与当前客户端版本不一致">
          {
            <>
              <p>
                文本仍绑定 {value.target.adapterId} {value.target.version}。请按{" "}
                {target.adapterId} {target.version}{" "}
                的格式调整内容，再确认改绑；不会自动改写或丢弃原文。
              </p>
              <ActionButton
                onClick={() =>
                  confirm({
                    title: "将原生覆盖绑定到当前客户端？",
                    description:
                      "此操作只改变目标声明，不转换语法。需要重新预览检查后才能发布。",
                    confirmLabel: "确认改绑",
                    cancelLabel: "继续编辑",
                    onConfirm: () => update({ target: { ...target } }),
                  })
                }
                variant="outline"
              >
                改绑到当前客户端
              </ActionButton>
            </>
          }
        </Notice>
      )}
      {mode === "nodes-only" && (
        <Notice tone="warning" title="原生覆盖需要完整配置模式">
          {
            <ActionButton onClick={useFullMode} variant="outline">
              改用完整配置
            </ActionButton>
          }
        </Notice>
      )}
      <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
        <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
          文本格式
          <ChoiceSelect
            aria-label="原生覆盖文本格式"
            value={value.format}
            options={[
              { value: "json", label: "JSON" },
              { value: "yaml", label: "YAML" },
            ]}
            onValueChange={(format) => {
              if (format === undefined) return;
              return update({ format });
            }}
          />
        </label>
        <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
          原生规则合并方式
          <ChoiceSelect
            aria-label="原生规则合并方式"
            value={value.ruleMode}
            options={[
              { value: "prepend", label: "放在结构化规则之前" },
              { value: "append", label: "放在结构化规则之后" },
              { value: "replace", label: "替换结构化规则" },
            ]}
            onValueChange={(ruleMode) => {
              if (ruleMode === undefined) return;
              return update({ ruleMode });
            }}
          />
        </label>
      </div>
      {value.ruleMode === "replace" && (
        <p className="inline-note space-y-2 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          生成结果不再使用结构化规则列表；默认流量行为仍保留。结构化规则仍保存在草稿中。
        </p>
      )}
      <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
        原生配置文本
        <Textarea
          aria-label="原生配置文本"
          className="json-editor min-h-48 font-mono text-xs"
          value={value.content}
          onChange={(e) => update({ content: e.target.value })}
          rows={14}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <p className="muted text-sm text-muted-foreground">
        连接凭据、生成的连接身份与规则文件由结构化配置管理，不能在这里覆盖。引用已有策略或连接时，使用生成预览中的原生名称；预览会检查可用字段和引用。文本有误也可以保存草稿。
      </p>
    </div>
  );
}
export function NativeOverrideResult({
  value,
}: {
  value: NativeOverrideReview;
}) {
  return (
    <div className="inline-note space-y-2 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
      <strong>已合并目标原生覆盖</strong>
      <p>
        {value.target.adapterId} {value.target.version} ·{" "}
        {
          {
            prepend: "规则前置",
            append: "规则后置",
            replace: "替换结构化规则",
          }[value.ruleMode]
        }
      </p>
      <details>
        <summary className="min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          查看合并字段
        </summary>
        {value.changedPaths.length ? (
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs wrap-anywhere">
            {value.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        ) : (
          <p>没有新增字段。</p>
        )}
        {!!value.replacedPaths?.length && (
          <>
            <p>替换字段：</p>
            <ul className="list-disc space-y-1 pl-5 font-mono text-xs wrap-anywhere">
              {value.replacedPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </>
        )}
        <p className="muted text-sm text-muted-foreground">
          检查范围：
          {value.validation === "upstream-json-schema-and-references"
            ? "目标 JSON 结构与引用"
            : "支持的字段结构与引用"}
          。
        </p>
      </details>
    </div>
  );
}
