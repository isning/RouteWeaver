import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { APIError, request } from "./api";
import { Checkbox } from "./components/ui/checkbox";
import { Label } from "./components/ui/label";
import { ActionButton } from "./ui-patterns/actions";
import { ChoiceSelect } from "./ui-patterns/choice-select";
import { Notice } from "./ui-patterns/notice";
import { useConfirm } from "./ui-patterns/confirmations";
interface Settings {
  instanceId: string;
  enabled: boolean;
  retentionSeconds: number;
  revision: string;
  historyLimit: number;
  lineBytesLimit: number;
}
function valid(s: Settings, id: string) {
  return (
    s?.instanceId === id &&
    typeof s.enabled === "boolean" &&
    typeof s.revision === "string" &&
    [3600, 86400, 604800].includes(s.retentionSeconds) &&
    s.historyLimit === 128 &&
    s.lineBytesLimit === 4096
  );
}
export function RawCoreLogSettings({
  instanceId,
  onChanged,
}: {
  instanceId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const decision = useRef<{ close: () => void } | null>(null);
  const confirm = useConfirm();
  const path = `/admin/instances/${encodeURIComponent(instanceId)}/core-logs/settings`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      decision.current?.close();
    };
  }, []);
  const query = useQuery({
    queryKey: ["raw-core-log-settings", instanceId],
    enabled: open,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const result = await request<Settings>(path, {
        signal,
        redirect: "error",
      });
      if (!valid(result, instanceId)) throw new Error("设置响应无效");
      return result;
    },
  });
  const value = draft || query.data;
  const reread = async () => {
    const result = await query.refetch();
    if (!alive.current) return;
    if (result.isSuccess && result.data) {
      setDraft((current) =>
        current ? { ...current, revision: result.data.revision } : result.data,
      );
      setError("");
      setBlocked(false);
      setSaved(false);
    }
  };
  const save = () => {
    if (
      !value ||
      decision.current ||
      blocked ||
      query.isError ||
      query.isFetching
    )
      return;
    const selected = { ...value };
    decision.current = confirm({
      title: "保存日志采集设置？",
      description: `${selected.enabled ? "允许平台接收可能含 IP、访问目标、账号或密钥的日志原文；节点仍须在本地明确开启敏感日志权限。" : "停止平台接收日志原文。"}保存会清除当前平台已收集的日志，包括仅修改保留时间。备份、数据库历史副本及已下载文件不会随之删除。`,
      confirmLabel: "确认保存并清除现有日志",
      destructive: true,
      onClosed: () => {
        decision.current = null;
      },
      onConfirm: async () => {
        if (!alive.current) return;
        setSaving(true);
        setSaved(false);
        setError("");
        try {
          const result = await request<Settings>(path, {
            method: "PUT",
            redirect: "error",
            body: JSON.stringify({
              expectedRevision: selected.revision,
              enabled: selected.enabled,
              retentionSeconds: selected.retentionSeconds,
            }),
          });
          if (!alive.current) return;
          if (!valid(result, instanceId)) throw new Error("设置响应无效");
          setDraft(result);
          setSaved(true);
          onChanged();
        } catch (e) {
          if (!alive.current) return;
          setBlocked(true);
          setError(
            e instanceof APIError && e.status === 409
              ? "设置已被修改。你的选择已保留，请重新读取后确认保存。"
              : "未能确认保存结果。你的选择已保留，请重新读取设置，不要重复提交。",
          );
          onChanged();
        } finally {
          if (alive.current) setSaving(false);
        }
      },
    });
  };
  return (
    <section className="space-y-3" aria-label="日志采集设置">
      <ActionButton
        variant="outline"
        onClick={() => setOpen(!open)}
        disabled={saving}
      >
        {open ? "收起采集设置" : "采集设置"}
      </ActionButton>
      {open && (
        <div className="space-y-4 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            默认不接收。节点必须另行在本地使用{" "}
            <code>--raw-core-logs-accept-sensitive</code>
            ；此处不会修改节点权限或重启核心。
          </p>
          {query.isPending && <p role="status">正在读取采集设置…</p>}
          {query.isError && (
            <Notice tone="warning">
              无法读取最新设置，请重试。不能根据旧记录继续保存。
            </Notice>
          )}
          {value && (
            <fieldset
              disabled={saving || query.isFetching || query.isError}
              className="space-y-4"
            >
              <Label className="flex items-start gap-2">
                <Checkbox
                  checked={value.enabled}
                  onCheckedChange={(checked) => {
                    setDraft({ ...value, enabled: checked === true });
                    setSaved(false);
                  }}
                />
                允许平台接收日志原文
              </Label>
              <div className="max-w-xs space-y-2">
                <Label>最长保留时间</Label>
                <ChoiceSelect
                  aria-label="最长保留时间"
                  value={String(value.retentionSeconds)}
                  onValueChange={(n) => {
                    setDraft({ ...value, retentionSeconds: Number(n) });
                    setSaved(false);
                  }}
                  options={[
                    { value: "3600", label: "1 小时" },
                    { value: "86400", label: "24 小时" },
                    { value: "604800", label: "7 天" },
                  ]}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                每个实例始终最多保留 128
                条，多出的旧记录会提前淘汰，不是完整日志归档。超过 4096
                字节的整行不保留。
              </p>
              <ActionButton onClick={save} disabled={blocked} pending={saving}>
                保存设置
              </ActionButton>
            </fieldset>
          )}
          {error && (
            <Notice tone="warning" role="alert">
              {error}
            </Notice>
          )}
          {saved && (
            <p role="status" className="text-sm">
              设置已保存；是否正在采集，仍取决于节点配置与上报。
            </p>
          )}
          <ActionButton
            variant="ghost"
            pending={query.isFetching}
            disabled={saving}
            onClick={reread}
          >
            重新读取设置
          </ActionButton>
        </div>
      )}
    </section>
  );
}
