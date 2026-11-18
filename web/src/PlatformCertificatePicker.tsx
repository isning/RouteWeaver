import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { ActionButton } from "@/ui-patterns/actions";
import { list, request } from "./api";
import { ErrorNotice } from "./components";
import { dateLabel } from "./model";
import { TLSMaterial } from "./TLSMaterial";
import type { ServerTLS } from "./types";

type Certificate = { id: string; name: string; expiresAt: string; dnsNames?: string[] };

export function PlatformCertificatePicker({
  value,
  onValueChange,
  disabled,
  onUseServerName,
  ...aria
}: {
  value?: string;
  onValueChange?: (id: string | undefined) => void;
  id?: string;
  disabled?: boolean;
  onUseServerName?: (name: string) => void;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const client = useQueryClient();
  const queryKey = ["server-tls-certificates"];
  const catalog = useQuery({
    queryKey,
    queryFn: () => list<Certificate>("/server-tls-certificates"),
  });
  const [uploading, setUploading] = useState(false);
  const [reading, setReading] = useState(false);
  const [material, setMaterial] = useState<ServerTLS>({});
  const upload = useMutation({
    gcTime: 0,
    mutationFn: ({ certificatePem, privateKeyPem }: ServerTLS) =>
      request<Certificate>("/server-tls-certificates", {
        method: "POST",
        body: JSON.stringify({ certificatePem, privateKeyPem }),
      }),
    onSuccess: (certificate) => {
      client.setQueryData<Certificate[]>(queryKey, (previous) => [
        ...(previous || []).filter((item) => item.id !== certificate.id),
        certificate,
      ]);
      void client.invalidateQueries({ queryKey });
    },
  });
  const serverNames = catalog.data?.find((certificate) => certificate.id === value)?.dnsNames
    ?.filter((name) => !name.includes("*")) || [];
  return (
    <div className="space-y-3">
      <ChoiceSelect
        {...aria}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled || upload.isPending || (!catalog.data?.length && !value)}
        placeholder={catalog.isPending ? "正在读取证书" : catalog.isError ? "无法读取证书" : catalog.data?.length ? "选择平台证书" : "暂无平台证书"}
        options={(catalog.data || []).map(({ id, name, expiresAt }) => ({
          value: id,
          label: name,
          description: `到期时间 ${dateLabel(expiresAt)}`,
        }))}
      />
      {onUseServerName && serverNames.length > 0 && (
        <ChoiceSelect
          aria-label="从证书选择 SNI"
          placeholder="从证书选择 SNI"
          disabled={disabled}
          options={serverNames.map((name) => ({ value: name, label: name }))}
          onValueChange={(name) => { if (name) onUseServerName(name); }}
        />
      )}
      {catalog.isError && <ActionButton variant="ghost" onClick={() => void catalog.refetch()}>重新读取证书</ActionButton>}
      {uploading ? (
        <>
          <TLSMaterial showReuseHint={false} value={material} onChange={setMaterial} onPendingChange={setReading} />
          <ErrorNotice error={upload.error} />
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="outline" disabled={upload.isPending} onClick={() => {
              setUploading(false);
              setMaterial({});
              upload.reset();
            }}>取消上传</ActionButton>
            <ActionButton
              variant="outline"
              pending={upload.isPending}
              disabled={disabled || reading || !material.certificatePem || !material.privateKeyPem}
              onClick={() => upload.mutate(material, { onSuccess: (certificate) => {
                onValueChange?.(certificate.id);
                setMaterial({});
                setUploading(false);
                upload.reset();
              } })}
            >上传并选用</ActionButton>
          </div>
        </>
      ) : (
        <ActionButton variant="outline" disabled={disabled} onClick={() => setUploading(true)}>上传证书</ActionButton>
      )}
    </div>
  );
}
