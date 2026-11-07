import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionButton } from "@/ui-patterns/actions";
import { useLayoutEffect, useRef, useState } from "react";
import { ErrorNotice } from "./components";
import type { ServerTLS } from "./types";
export function TLSMaterial({
  value,
  onChange,
  onPendingChange,
}: {
  value: ServerTLS;
  onChange: (next: ServerTLS) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const latest = useRef(value);
  latest.current = value;
  const callbacks = useRef({ onChange, onPendingChange });
  callbacks.current = { onChange, onPendingChange };
  const certificateRead = useRef(0);
  const keyRead = useRef(0);
  const mounted = useRef(true);
  const pending = useRef(new Set<string>());
  const [reading, setReading] = useState(false);
  const reportPending = () => {
    const next = pending.current.size > 0;
    setReading(next);
    callbacks.current.onPendingChange?.(next);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      // Revoke ownership during the commit, before a replaced reader can settle.
      mounted.current = false;
      certificateRead.current++;
      keyRead.current++;
      pending.current.clear();
      callbacks.current.onPendingChange?.(false);
    };
  }, []);
  const apply = (patch: Partial<ServerTLS>) => {
    const next = {
      ...latest.current,
      certificatePath: latest.current.certificatePath || "tls/certificate.pem",
      keyPath: latest.current.keyPath || "tls/key.pem",
      ...patch,
    };
    latest.current = next;
    callbacks.current.onChange(next);
  };
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const load = async (
    file: File | undefined,
    key: "certificatePem" | "privateKeyPem",
  ) => {
    if (!file) return;
    const sequence = key === "certificatePem" ? certificateRead : keyRead;
    const revision = ++sequence.current;
    pending.current.delete(key);
    reportPending();
    setError(null);
    if (file.size > 128 * 1024) {
      setError(new Error("证书和私钥文件分别不能超过 128 KB。"));
      return;
    }
    pending.current.add(key);
    reportPending();
    try {
      const text = await file.text();
      if (mounted.current && revision === sequence.current)
        apply({ [key]: text });
    } catch {
      if (mounted.current && revision === sequence.current)
        setError(new Error("读取失败，请重新选择 PEM 文件。"));
    } finally {
      if (mounted.current && revision === sequence.current) {
        pending.current.delete(key);
        reportPending();
      }
    }
  };
  return (
    <div className="tls-material space-y-4 rounded-lg border bg-muted/20 p-4">
      <ErrorNotice error={error} />
      {reading && (
        <div role="status" className="flex items-center justify-between gap-3">
          正在读取 TLS 文件
          <ActionButton
            variant="outline"
            onClick={() => {
              certificateRead.current++;
              keyRead.current++;
              pending.current.clear();
              reportPending();
              setError(null);
            }}
          >
            取消读取
          </ActionButton>
        </div>
      )}
      <div className="form-grid grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">
          读取证书文件
          <Input
            type="file"
            accept=".pem,.crt,.cer"
            aria-label="读取 TLS 证书"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void load(file, "certificatePem");
            }}
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          读取私钥文件
          <Input
            type="file"
            accept=".pem,.key"
            aria-label="读取 TLS 私钥"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void load(file, "privateKeyPem");
            }}
          />
        </label>
      </div>
      <label className="standalone-label grid gap-2 text-sm font-medium">
        证书 PEM
        <Textarea
          rows={4}
          className="font-mono text-xs"
          value={value.certificatePem}
          onChange={(e) => (
            certificateRead.current++,
            pending.current.delete("certificatePem"),
            reportPending(),
            setError(null),
            apply({ certificatePem: e.target.value })
          )}
          placeholder="-----BEGIN CERTIFICATE-----"
          spellCheck={false}
        />
      </label>
      <div className="section-heading flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>
          {value.privateKeyPem ? "已填入 TLS 私钥" : "尚未填入 TLS 私钥"}
        </span>
        <ActionButton onClick={() => setShowKey(!showKey)} variant="ghost">
          {showKey ? "隐藏私钥" : "编辑私钥 PEM"}
        </ActionButton>
      </div>
      {showKey && (
        <label className="standalone-label grid gap-2 text-sm font-medium">
          私钥 PEM
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={value.privateKeyPem}
            onChange={(e) => (
              keyRead.current++,
              pending.current.delete("privateKeyPem"),
              reportPending(),
              setError(null),
              apply({ privateKeyPem: e.target.value })
            )}
            autoComplete="off"
            spellCheck={false}
            placeholder="-----BEGIN PRIVATE KEY-----"
          />
        </label>
      )}
      <p className="muted text-sm text-muted-foreground">
        校验时检查证书与私钥是否匹配，应用时随该实例配置一起交付。私钥不会进入客户端订阅。
      </p>
    </div>
  );
}
