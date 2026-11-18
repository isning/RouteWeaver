import type { ReactNode } from "react";
import { Fingerprint, Globe2, Hash, KeyRound, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMutation } from "@tanstack/react-query";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { AppField, useFormInstance, useWatch } from "@/ui-patterns/form";
import { NumericInput } from "@/ui-patterns/numeric-input";
import { useConfirm } from "@/ui-patterns/confirmations";
import { PasswordInput } from "@/ui-patterns/password-input";
import { post } from "./api";
import { ErrorNotice } from "./components";
import { realityTargetHosts } from "./reality-targets";

type RealityKeys = { privateKey: string; publicKey: string; shortId: string };

function RealityGroup({ title, label, icon, status, children }: {
  title: string;
  label?: string;
  icon: ReactNode;
  status?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label || title} className="min-w-0 space-y-4 rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-4">
            {icon}
          </span>
          {title}
        </h4>
        {status && <Badge variant="secondary">{status}</Badge>}
      </div>
      {children}
    </section>
  );
}

export function EndpointRealityFields({ required, allowMultipleSNI }: { required: boolean; allowMultipleSNI: boolean }) {
  const form = useFormInstance();
  const confirm = useConfirm();
  const privateKey = useWatch(["realityServer", "privateKey"], { form, preserve: true });
  const host = useWatch(["realityServer", "handshakeServer"], form);
  const port = useWatch(["realityServer", "handshakePort"], form);
  const primarySNI = useWatch(["connection", "tls", "serverName"], { form, preserve: true });
  const primaryShortID = useWatch(["connection", "tls", "reality", "shortId"], { form, preserve: true });
  const publicKey = useWatch(["connection", "tls", "reality", "publicKey"], { form, preserve: true });
  const additionalShortIDs = useWatch(["realityServer", "shortIds"], { form, preserve: true }) || [];
  const count = new Set([primaryShortID, ...additionalShortIDs].filter(Boolean)).size;
  const preset = port === 443 && realityTargetHosts.includes(host) ? host : undefined;
  const setDefaultFingerprint = () => {
    const field = ["connection", "tls", "fingerprint"];
    if (!form.getFieldValue(field)) form.setFieldValue(field, "chrome");
  };
  const keys = useMutation({
    gcTime: 0,
    mutationFn: () => post<RealityKeys>("/managed-endpoints/reality-keys", {}),
  });
  const generate = () => keys.mutate(undefined, {
    onSuccess: ({ privateKey, publicKey, shortId }) => {
      form.setFieldValue(["realityServer", "privateKey"], privateKey);
      form.setFieldValue(["connection", "tls", "reality", "publicKey"], publicKey);
      const shortIDField = ["connection", "tls", "reality", "shortId"];
      if (!form.getFieldValue(shortIDField)) form.setFieldValue(shortIDField, shortId);
      setDefaultFingerprint();
      keys.reset();
    },
  });
  const newShortID = () => Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return (
    <div className="grid min-w-0 gap-3">
      <RealityGroup title="目标与 SNI" icon={<Globe2 />} status={preset ? "预设网站" : host ? "自定义目标" : undefined}>
        <ChoiceSelect
          aria-label="选择 REALITY 网站"
          placeholder="选择网站候选"
          value={preset}
          options={realityTargetHosts.map((host) => ({ value: host, label: host, description: "HTTPS 443" }))}
          onValueChange={(host) => {
            if (!host) return;
            const targetPath = ["realityServer", "handshakeServer"];
            if (form.getFieldValue(targetPath) !== host)
              form.setFieldValue(["realityServer", "serverNames"], []);
            form.setFieldValue(targetPath, host);
            form.setFieldValue(["realityServer", "handshakePort"], 443);
            form.setFieldValue(["connection", "tls", "serverName"], host);
            setDefaultFingerprint();
          }}
        />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <AppField name={["realityServer", "handshakeServer"]} label="握手目标"
            rules={[{ required, message: "请选择或填写握手目标" }]}>
            <Input placeholder="www.microsoft.com" />
          </AppField>
          <AppField name={["realityServer", "handshakePort"]} label="握手端口"
            rules={[{ type: "integer", min: 1, max: 65535, message: "端口应在 1–65535 之间" }]}>
            <NumericInput placeholder="443" />
          </AppField>
        </div>
        <AppField name={["connection", "tls", "serverName"]} label="服务器名称（SNI）">
          <Input placeholder="example.com" />
        </AppField>
        {allowMultipleSNI && (
          <Accordion type="single" collapsible>
            <AccordionItem value="sni">
              <AccordionTrigger>其他允许的 SNI</AccordionTrigger>
              <AccordionContent forceMount>
                <AppField
                  name={["realityServer", "serverNames"]}
                  label="添加允许的 SNI"
                  description="填写握手目标证书覆盖的其他域名"
                  trigger="onValueChange"
                  getValueProps={(values: string[] | undefined) => ({ value: values?.filter((name) => name !== primarySNI) })}
                  rules={[{ validator: (_, values: string[] | undefined) =>
                    (values || []).every((name) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*$/i.test(name))
                      ? Promise.resolve()
                      : Promise.reject(new Error("请输入具体域名，例如 example.com")),
                  }]}
                >
                  <MultiChoice options={[]} creatable placeholder="添加域名" />
                </AppField>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </RealityGroup>
      <RealityGroup title="密钥" label="REALITY 密钥" icon={<KeyRound />} status={privateKey && publicKey ? "已填写" : privateKey || publicKey ? "待补全" : "未填写"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <AppField name={["realityServer", "privateKey"]} label="服务端私钥"
            rules={[{ required, message: "请生成密钥或填写已有私钥" }]}>
            <PasswordInput autoComplete="new-password" />
          </AppField>
          <AppField name={["connection", "tls", "reality", "publicKey"]} label="REALITY 公钥"
            rules={[{ required: true, message: "请生成密钥或填写对应公钥" }]}>
            <Input />
          </AppField>
        </div>
        <ActionButton
          variant="outline"
          leadingIcon={privateKey ? <RefreshCw aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
          pending={keys.isPending}
          onClick={() => {
          if (!privateKey) {
            generate();
            return;
          }
          confirm({
            title: "更换 REALITY 密钥？",
            description: "应用新配置后，客户端需要更新订阅才能继续连接",
            confirmLabel: "生成新密钥",
            onConfirm: generate,
          });
        }}>{privateKey ? "更换密钥" : "生成密钥"}</ActionButton>
        <ErrorNotice error={keys.error} />
      </RealityGroup>
      <RealityGroup title="Short ID" icon={<Hash />} status={count ? `${count} 个` : "未填写"}>
        <div className="flex flex-wrap items-end gap-2">
          <AppField name={["connection", "tls", "reality", "shortId"]} label="客户端 Short ID" className="min-w-48 flex-1">
            <Input />
          </AppField>
          {!primaryShortID && (
            <ActionButton variant="outline" leadingIcon={<Fingerprint aria-hidden="true" />} onClick={() => {
              form.setFieldValue(["connection", "tls", "reality", "shortId"], newShortID());
            }}>生成 Short ID</ActionButton>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <AppField
            name={["realityServer", "shortIds"]}
            label="其他允许的 Short ID"
            className="min-w-48 flex-1"
            trigger="onValueChange"
            getValueProps={(values: string[] | undefined) => ({ value: values?.filter((id) => id && id !== primaryShortID) })}
            rules={[{ validator: (_, values: string[] | undefined) =>
              (values || []).every((id) => /^(?:[a-f\d]{2}){0,8}$/i.test(id))
                ? Promise.resolve()
                : Promise.reject(new Error("使用 2–16 位十六进制字符，长度须为偶数")),
            }]}
          >
            <MultiChoice options={[]} creatable placeholder="添加 Short ID" />
          </AppField>
          <ActionButton variant="outline" leadingIcon={<Plus aria-hidden="true" />} onClick={() => {
            const field = ["realityServer", "shortIds"];
            form.setFieldValue(field, [...(form.getFieldValue(field) || []), newShortID()]);
          }}>生成额外的 Short ID</ActionButton>
        </div>
      </RealityGroup>
    </div>
  );
}
