import { PasswordInput } from "@/ui-patterns/password-input";
import { useEffect, useRef, type ComponentProps } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  AppField,
  FormList,
  useFormInstance,
  useWatch,
} from "@/ui-patterns/form";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { NumericInput } from "@/ui-patterns/numeric-input";
import { Notice } from "@/ui-patterns/notice";
import type { Connection } from "./types";

type HeaderRow = { name: string; value: string };
type DraftTransport = NonNullable<Connection["transport"]> & {
  headerRows?: HeaderRow[];
};
// Validate the decimal spelling before Number can round a fractional port into
// an integer. Decimal/exponent spellings accepted by NumericInput stay supported.
function connectionPort(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 && value <= 65535
      ? value
      : undefined;
  if (typeof value !== "string" || value.length > 256) return undefined;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] || "") + fraction).replace(/^0+/, "");
  if (!digits) return undefined;
  const significant = digits.replace(/0+$/, "");
  const scale = Number(match[4] || 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(scale) || scale < 0 || significant.length + scale > 5)
    return undefined;
  const port = Number(significant) * 10 ** scale;
  return port >= 1 && port <= 65535 ? port : undefined;
}

// Keep raw edits in the form, including incomplete input. This makes the host
// editors' existing dirty guards and resetFields lifecycle cover every edit.
function ConnectionPortInput({
  value,
  onPortChange,
  ...props
}: Omit<
  ComponentProps<typeof NumericInput>,
  "value" | "onValueChange" | "onInputText"
> & {
  value?: number | string | null;
  onPortChange?: (raw: string) => void;
}) {
  const numeric = useRef<number | null>(null);
  if (value == null || value === "") numeric.current = null;
  else if (
    (typeof value === "number" ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) &&
    Number.isFinite(Number(value))
  ) numeric.current = Number(value);
  // Incomplete text must not change NumericInput's numeric prop: it would
  // overwrite the user's local spelling with the previous accepted value.
  return (
    <NumericInput
      {...props}
      value={numeric.current}
      min={1}
      max={65535}
      step={1}
      precision={0}
      aria-invalid={
        props["aria-invalid"] ||
        (value != null && value !== "" && connectionPort(value) === undefined) ||
        undefined
      }
      onInputText={onPortChange}
    />
  );
}

// Absent transport is TCP intent, but confirming its displayed default is not
// an edit. Filter that confirmation before the form marks the field touched.
function ConnectionTransportSelect({
  implicitTCP,
  value,
  onValueChange,
  ...props
}: ComponentProps<typeof ChoiceSelect<string>> & { implicitTCP?: boolean }) {
  return (
    <ChoiceSelect
      {...props}
      value={implicitTCP ? "tcp" : value}
      onValueChange={(next) => {
        if (implicitTCP && next === "tcp") return;
        onValueChange?.(next);
      }}
    />
  );
}

export function normalizeConnection(connection: Connection): Connection {
  const copy = { ...connection };
  const port = connectionPort(copy.port);
  // This normalizer is also used for render-time comparisons. Invalid drafts
  // stay invalid here; the field validator prevents submitting them.
  if (port !== undefined) copy.port = port;
  // Direct-only TLS protocols have their own protocol envelope. Preserve unsupported values so
  // validation can reject them rather than silently erasing imported intent.
  if (["hysteria2", "anytls"].includes(copy.protocol)) return copy;
  const secured = ["vless", "trojan", "vmess"].includes(copy.protocol);
  if (!secured) {
    delete copy.uuid;
    delete copy.flow;
    delete copy.packetEncoding;
    delete copy.tls;
    delete copy.transport;
  } else {
    delete copy.username;
    delete copy.method;
    if (copy.protocol !== "trojan") delete copy.password;
    if (copy.protocol !== "vless") {
      delete copy.flow;
      delete copy.packetEncoding;
    }
    if (copy.protocol === "trojan") delete copy.uuid;
    if (!copy.tls?.enabled) delete copy.tls;
    else if (
      copy.protocol !== "vless" ||
      (copy.tls.reality &&
        !copy.tls.reality.publicKey &&
        !copy.tls.reality.shortId)
    )
      copy.tls = { ...copy.tls, reality: undefined };
    const transport = copy.transport as DraftTransport | undefined;
    if (!transport?.type || transport.type === "tcp") delete copy.transport;
    else if (transport.type === "grpc")
      copy.transport = {
        type: "grpc",
        serviceName: transport.serviceName,
        ...(transport.authority ? { authority: transport.authority } : {}),
      };
    else {
      const headers = transport.headerRows
        ? Object.fromEntries(
            transport.headerRows
              .filter((row) => row.name.trim())
              .map((row) => [row.name.trim(), row.value]),
          )
        : transport.headers;
      copy.transport = {
        type: transport.type,
        path: transport.path,
        host: transport.host,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      };
    }
  }
  if (copy.protocol !== "vmess") delete copy.vmessSecurity;
  if (copy.protocol === "socks") delete copy.method;
  if (copy.protocol === "shadowsocks") delete copy.username;
  return copy;
}

export function ConnectionFields({
  prefix = ["connection"],
  server = false,
  showAddressLegend = true,
  authentication,
  managedEntryTarget = false,
  targetCore,
  targetVersion,
  allowUnchangedUnsupportedProtocol = false,
  directTlsUnavailableReason,
  anytlsUnavailableReason,
  anytlsConnector = false,
}: {
  prefix?: string[];
  server?: boolean;
  showAddressLegend?: boolean;
  authentication?: string;
  managedEntryTarget?: boolean;
  targetCore?: string;
  targetVersion?: string;
  allowUnchangedUnsupportedProtocol?: boolean;
  directTlsUnavailableReason?: string;
  anytlsUnavailableReason?: string;
  anytlsConnector?: boolean;
}) {
  const form = useFormInstance();
  // useWatch subscribes after the first commit. Conditional controls must read
  // the connected form's current values immediately, not an empty placeholder.
  const protocol = useWatch([...prefix, "protocol"], form) ??
    form.getFieldValue([...prefix, "protocol"]);
  const tls = useWatch([...prefix, "tls"], { form, preserve: true }) ??
    form.getFieldValue([...prefix, "tls"]);
  const transport = useWatch([...prefix, "transport", "type"], {
    form,
    preserve: true,
  }) ?? form.getFieldValue([...prefix, "transport", "type"]);
  const authority = useWatch([...prefix, "transport", "authority"], {
    form,
    preserve: true,
  }) ?? form.getFieldValue([...prefix, "transport", "authority"]);
  const hostTemplateOnly =
    server && targetCore === "sing-box" && transport === "ws";
  const flow = useWatch([...prefix, "flow"], { form, preserve: true }) ??
    form.getFieldValue([...prefix, "flow"]);
  const vmessSecurity = useWatch([...prefix, "vmessSecurity"], {
    form,
    preserve: true,
  }) ?? form.getFieldValue([...prefix, "vmessSecurity"]);
  const packetEncoding = useWatch([...prefix, "packetEncoding"], {
    form,
    preserve: true,
  }) ?? form.getFieldValue([...prefix, "packetEncoding"]);
  const principalListener = server && authentication === "principals";
  const limited =
    server &&
    (managedEntryTarget ||
      targetCore === "managed-xray" ||
      targetCore === "routeweaver/managed-xray");
  const hysteria2 = protocol === "hysteria2";
  const directTls = hysteria2 || protocol === "anytls";
  const protocolUnavailableReason = hysteria2 ? directTlsUnavailableReason : anytlsUnavailableReason;
  const directTlsName = hysteria2 ? "Hysteria2" : "AnyTLS";
  const directTlsTarget = !targetCore || (targetCore === "sing-box" &&
    (!targetVersion || ["1.14.3", "1.14.4"].includes(targetVersion)));
  const currentConnection = useWatch(prefix, { form, preserve: true }) ?? form.getFieldValue(prefix);
  const directTlsConflicts = directTls ? [
    ...["uuid", "flow", "packetEncoding", "method", "username", "vmessSecurity", "transport"]
      .filter((key) => currentConnection?.[key] != null && currentConnection[key] !== "")
      .map((key) => ({ path: [...prefix, key], label: ({ uuid: "UUID", flow: "Flow", packetEncoding: "数据包编码", method: "加密方式", username: "用户名", vmessSecurity: "VMess 加密方式", transport: "传输参数" } as Record<string, string>)[key] })),
    ...(tls?.reality ? [{ path: [...prefix, "tls", "reality"], label: "REALITY" }] : []),
    ...(tls?.fingerprint ? [{ path: [...prefix, "tls", "fingerprint"], label: "客户端指纹" }] : []),
  ] : [];
  const secured = ["vless", "trojan", "vmess", "hysteria2", "anytls"].includes(protocol);
  const security = tls?.enabled ? (tls.reality ? "reality" : "tls") : "none";
  const xrayReality = targetCore === "xray" && security === "reality";
  const realityTransportBlocked =
    targetCore === "xray" && ["ws", "httpupgrade"].includes(transport);
  const authorityUnsupported =
    server || (!!targetCore && targetCore !== "xray");
  const fingerprints = [
    "chrome",
    "firefox",
    "safari",
    "ios",
    "android",
    "edge",
    "360",
    "qq",
    "random",
    ...(targetCore === "mihomo" ? [] : ["randomized"]),
  ];
  const fingerprintUnsupported =
    ["mihomo", "sing-box"].includes(targetCore || "") &&
    tls?.fingerprint &&
    !fingerprints.includes(tls.fingerprint);
  const field = (name: string) => [...prefix, name];
  const transportOptions = [
    { value: "tcp", label: "TCP" },
    { value: "ws", label: "WebSocket", disabled: xrayReality },
    { value: "httpupgrade", label: "HTTP Upgrade", disabled: xrayReality },
    { value: "grpc", label: "gRPC" },
  ];
  const unsupported =
    limited &&
    (tls?.reality ||
      flow ||
      (transport && transport !== "tcp") ||
      packetEncoding);
  return (
    <div className="space-y-5">
      <FieldSet
        className="min-w-0"
        aria-label={server ? "监听地址" : "连接地址"}
      >
        {showAddressLegend && (
          <FieldLegend variant="label">
            {server ? "监听地址" : "连接地址"}
          </FieldLegend>
        )}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <AppField
            name={field("host")}
            label={server ? "监听 IP" : "连接地址"}
            rules={[
              {
                required: true,
                message: server ? "填写具体监听 IP" : "填写连接地址",
              },
            ]}
          >
            <Input placeholder={server ? "0.0.0.0" : "server.example.com"} />
          </AppField>
          <AppField
            name={field("port")}
            label="端口"
            trigger="onPortChange"
            rules={[
              { required: true, message: "填写端口" },
              {
                validator: (_, value) => connectionPort(value) !== undefined
                  ? Promise.resolve()
                  : Promise.reject(new Error("端口范围为 1–65535，且必须是整数")),
              },
            ]}
          >
            <ConnectionPortInput />
          </AppField>
        </div>
        {server && (
          <p className="text-xs text-muted-foreground">
            监听地址属于服务器；客户端使用的公开地址在线路中配置。
          </p>
        )}
      </FieldSet>
      <FieldSet
        className="grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-2"
        aria-label="协议与认证"
      >
        <FieldLegend variant="label" className="col-span-full">
          协议与认证
        </FieldLegend>
        <AppField
          name={field("protocol")}
          label="协议"
          trigger="onValueChange"
          rules={[
            { required: true, message: "选择协议" },
            { validator: (_, value) => !["hysteria2", "anytls"].includes(value) || !protocolUnavailableReason
              ? Promise.resolve() : Promise.reject(new Error(protocolUnavailableReason)) },
            { validator: (_, value) => !["hysteria2", "anytls"].includes(value) || allowUnchangedUnsupportedProtocol || directTlsTarget
              ? Promise.resolve() : Promise.reject(new Error(`${directTlsName} 目前仅支持 sing-box 1.14.3 / 1.14.4，请更换核心或协议。`)) },
            { validator: (_, value) => !["hysteria2", "anytls"].includes(value) || allowUnchangedUnsupportedProtocol || !directTlsConflicts.length
              ? Promise.resolve() : Promise.reject(new Error(`请先移除 ${directTlsName} 不支持的参数。`)) },
            {
              validator: (_rule, value) =>
                !limited ||
                value === "vless" ||
                allowUnchangedUnsupportedProtocol
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error(
                        "此托管核心的监听端点仅支持 VLESS，请明确改为 VLESS",
                      ),
                    ),
            },
          ]}
        >
          <ChoiceSelect
            disabled={principalListener && (!limited || protocol === "vless")}
            searchable={false}
            options={[
              { value: "socks", label: "SOCKS5", disabled: limited },
              { value: "shadowsocks", label: "Shadowsocks", disabled: limited },
              { value: "vless", label: "VLESS" },
              { value: "trojan", label: "Trojan", disabled: limited },
              { value: "vmess", label: "VMess AEAD", disabled: limited },
              { value: "hysteria2", label: "Hysteria2", disabled: limited || !directTlsTarget || !!directTlsUnavailableReason },
              { value: "anytls", label: "AnyTLS", disabled: limited || !directTlsTarget || !!anytlsUnavailableReason },
            ]}
          />
        </AppField>
        {limited && protocol && protocol !== "vless" && (
          <Notice
            className="sm:col-span-2"
            tone="warning"
            title="当前托管监听协议不受支持"
          >
            {allowUnchangedUnsupportedProtocol
              ? "此托管核心的监听端点仅支持 VLESS。当前仅允许保持连接、认证和核心不变时保存元数据；这不代表此监听端点可部署。"
              : "此托管核心的监听端点仅支持 VLESS。已有协议仍保留；请明确改为 VLESS 后再保存。"}
          </Notice>
        )}
        {principalListener && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            请在公开线路的「配置用户入口」中管理 UUID，无需设置共享 UUID。
          </p>
        )}
        {protocol === "socks" && (
          <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
            <AppField
              name={field("username")}
              label="用户名"
              rules={
                server
                  ? [{ required: true, message: "受管入口必须设置认证" }]
                  : []
              }
            >
              <Input autoComplete="off" />
            </AppField>
            <AppField
              name={field("password")}
              label="密码"
              rules={
                server ? [{ required: true, message: "填写连接密码" }] : []
              }
            >
              <PasswordInput autoComplete="new-password" />
            </AppField>
          </div>
        )}
        {protocol === "shadowsocks" && (
          <>
            <AppField
              name={field("method")}
              label="加密方式"
              trigger="onValueChange"
              rules={[{ required: true, message: "选择加密方式" }]}
            >
              <ChoiceSelect
                options={[
                  "aes-128-gcm",
                  "aes-256-gcm",
                  "chacha20-ietf-poly1305",
                ].map((value) => ({ value, label: value }))}
              />
            </AppField>
            <AppField
              name={field("password")}
              label="连接密码"
              rules={[{ required: true, message: "填写连接密码" }]}
            >
              <PasswordInput autoComplete="new-password" />
            </AppField>
          </>
        )}
        {directTls && (
          <div className="space-y-2 sm:col-span-2">
            <p className="text-sm text-muted-foreground">{hysteria2 ? "Hysteria2 使用 QUIC（UDP）和 TLS；目前仅支持 sing-box 直接连接。" : anytlsConnector ? "AnyTLS 使用密码和 TLS；可直接连接，或经由一个无上游的 SOCKS5 连接器。" : "AnyTLS 使用密码和 TLS；目前仅支持 sing-box。"}</p>
            {protocolUnavailableReason && <p className="text-sm text-destructive">{protocolUnavailableReason}</p>}
            {!!directTlsConflicts.length && <Notice tone="warning" title={`以下参数不适用于 ${directTlsName}`}>
              <div className="flex flex-wrap gap-2">{directTlsConflicts.map(({ path, label }) => (
                <AppField key={path.join(".")} name={path} noStyle trigger="onClear">
                  <ClearValueButton>移除{label}</ClearValueButton>
                </AppField>
              ))}</div>
            </Notice>}
          </div>
        )}
        {["trojan", "hysteria2", "anytls"].includes(protocol) && (
          <AppField
            name={field("password")}
            label="连接密码"
            rules={[{ required: true, message: `填写 ${directTls ? directTlsName : "Trojan"} 连接密码` }]}
          >
            <PasswordInput autoComplete="new-password" />
          </AppField>
        )}
        {["vless", "vmess"].includes(protocol) && !principalListener && (
          <AppField
            name={field("uuid")}
            label="用户 UUID"
            rules={[
              { required: true, message: "填写用户 UUID" },
              {
                pattern:
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
                message: "请输入有效 UUID",
              },
            ]}
          >
            <PasswordInput revealLabel="用户 UUID" autoComplete="off" />
          </AppField>
        )}
        {protocol === "vmess" && (
          <AppField
            name={field("vmessSecurity")}
            label="VMess 加密方式"
            rules={
              server
                ? [
                    {
                      validator: (_, value) =>
                        !value || value === "auto"
                          ? Promise.resolve()
                          : Promise.reject(
                              new Error(
                                "监听端仅支持自动模式；指定加密方式仅用于出站连接。",
                              ),
                            ),
                    },
                  ]
                : []
            }
            trigger="onValueChange"
            description={
              server
                ? "监听端由客户端选择加密方式，使用自动模式。"
                : "仅支持 AEAD（alterId = 0），不接受旧版认证。"
            }
          >
            <ChoiceSelect
              clearable
              placeholder="自动（auto）"
              options={(server
                ? ["auto"]
                : ["auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero"]
              ).map((value) => ({ value, label: value }))}
            />
          </AppField>
        )}
        {protocol === "vmess" &&
          server &&
          vmessSecurity &&
          vmessSecurity !== "auto" && (
            <Notice
              className="sm:col-span-2"
              tone="warning"
              title="现有 VMess 加密方式仅适用于出站连接"
            >
              参数仍保留；请改为自动模式或清除选择后保存。
            </Notice>
          )}
        {protocol === "vmess" && ["none", "zero"].includes(vmessSecurity) && (
          <Notice
            className="sm:col-span-2"
            tone="warning"
            title="VMess 载荷不加密"
          >
            此设置不提供 VMess 载荷加密；TLS 是独立的连接保护设置。
          </Notice>
        )}
      </FieldSet>
      {secured && (
        <>
          {unsupported && (
            <Notice
              tone="warning"
              title="此核心仅支持普通 TLS 与 TCP，不支持 REALITY、Vision 或数据包封装。"
            >
              已有参数会保留，直到你明确修改；不支持的组合无法发布。
            </Notice>
          )}
          {!directTls && <FieldSet className="min-w-0 border-t pt-4" aria-label="传输设置">
            <FieldLegend variant="label">传输设置</FieldLegend>
            {xrayReality && realityTransportBlocked && (
              <Notice tone="warning" title="当前 Xray REALITY 传输组合不受支持">
                已有参数仍保留；请改用 TCP / gRPC，或将安全模式改为普通 TLS。
              </Notice>
            )}
            <AppField
              name={[...prefix, "transport", "type"]}
              getValueProps={(value) => ({
                value,
                implicitTCP: value === undefined &&
                  form.getFieldValue([...prefix, "transport"]) == null,
              })}
              className="sm:grid sm:grid-cols-[7rem_minmax(0,18rem)] sm:items-center [&>[data-slot=field-error]]:sm:col-span-2"
              label="传输方式"
              rules={
                xrayReality
                  ? [
                      {
                        validator: (_, value) =>
                          !value || ["tcp", "grpc"].includes(value)
                            ? Promise.resolve()
                            : Promise.reject(
                                new Error("Xray REALITY 仅支持 TCP 或 gRPC。"),
                              ),
                      },
                    ]
                  : []
              }
              trigger="onValueChange"
            >
              <ConnectionTransportSelect
                searchable={false}
                placeholder="TCP"
                options={
                  limited
                    ? [
                        transportOptions[0],
                        ...(transport && transport !== "tcp"
                          ? [
                              {
                                value: transport,
                                label: `${transportOptions.find((o) => o.value === transport)?.label || transport}（此核心不支持）`,
                                disabled: true,
                              },
                            ]
                          : []),
                      ]
                    : transportOptions
                }
              />
            </AppField>
            {["ws", "httpupgrade"].includes(transport) && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <AppField
                    name={[...prefix, "transport", "path"]}
                    label="路径"
                    description={
                      server
                        ? "填写不含查询参数、片段或百分号编码的路径；WebSocket 使用 URI 安全字符。"
                        : undefined
                    }
                  >
                    <Input placeholder="/" />
                  </AppField>
                  <AppField
                    name={[...prefix, "transport", "host"]}
                    label={
                      hostTemplateOnly
                        ? "客户端请求 Host（该监听核心不校验 Host）"
                        : "Host"
                    }
                    description={
                      hostTemplateOnly
                        ? "保留为客户端拨号模板参数，不作为 sing-box WebSocket 服务端访问校验。"
                        : undefined
                    }
                  >
                    <Input placeholder="example.com" />
                  </AppField>
                </div>
                {server ? (
                  <AppField
                    name={[...prefix, "transport", "headers"]}
                    noStyle
                    rules={[
                      {
                        validator: (_, value) =>
                          value && Object.keys(value).length
                            ? Promise.reject(
                                new Error(
                                  "监听端不支持自定义请求头，请先移除。",
                                ),
                              )
                            : Promise.resolve(),
                      },
                    ]}
                  >
                    <UnsupportedListenerHeaders />
                  </AppField>
                ) : (
                  <Accordion type="single" collapsible>
                    <AccordionItem value="headers">
                      <AccordionTrigger>自定义请求头</AccordionTrigger>
                      <AccordionContent
                        forceMount
                        className="data-[state=closed]:hidden"
                      >
                        <TransportHeaders prefix={prefix} />
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}
              </>
            )}
            {transport === "grpc" && (
              <>
                <AppField
                  name={[...prefix, "transport", "serviceName"]}
                  label="gRPC 服务名称"
                >
                  <Input />
                </AppField>
                {(!authorityUnsupported || authority) && (
                  <AppField
                    name={[...prefix, "transport", "authority"]}
                    label="gRPC Authority"
                    rules={
                      authorityUnsupported
                        ? [
                            {
                              validator: (_, value) =>
                                value
                                  ? Promise.reject(
                                      new Error(
                                        "此目标不支持 gRPC Authority，请清除此值。",
                                      ),
                                    )
                                  : Promise.resolve(),
                            },
                          ]
                        : []
                    }
                    description={
                      authorityUnsupported
                        ? "已有参数仅供 Xray 出站连接使用，当前目标不支持；请清除此值后保存。"
                        : "仅普通 Xray 的出站连接支持；其他目标会阻止生成，不会忽略该值。"
                    }
                  >
                    <Input placeholder="可选" />
                  </AppField>
                )}
              </>
            )}
          </FieldSet>}
          <FieldSet className="min-w-0 border-t pt-4" aria-label="连接安全">
            <FieldLegend variant="label">连接安全</FieldLegend>
            <AppField
              name={[...prefix, "tls", "enabled"]}
              label="安全模式"
              description={
                security === "reality"
                  ? realityTransportBlocked
                    ? "Xray 的 REALITY 仅支持 TCP / gRPC；请先调整传输方式。"
                    : !targetCore
                      ? "REALITY 的兼容性取决于目标核心；Xray 仅支持 TCP / gRPC，且不接受显式 ALPN。"
                      : undefined
                  : undefined
              }
              valuePropName="checked"
              trigger="onCheckedChange"
              rules={
                ["trojan", "hysteria2", "anytls"].includes(protocol)
                  ? [
                      {
                        validator: (_, value) =>
                          value
                            ? Promise.resolve()
                            : Promise.reject(new Error(`${directTls ? directTlsName : "Trojan"} 必须启用 TLS`)),
                      },
                    ]
                  : []
              }
            >
              <SecurityModePicker
                protocol={protocol}
                limited={limited}
                realityDisabled={realityTransportBlocked}
                reality={tls?.reality}
                onRealityChange={(value) =>
                  form.setFieldValue([...prefix, "tls", "reality"], value)
                }
              />
            </AppField>
            {protocol === "trojan" && (
              <p className="text-xs text-muted-foreground">
                Trojan 使用密码认证，并要求启用 TLS。
              </p>
            )}
            {server && (
              <Notice title="监听与客户端参数分开管理">
                下方填写客户端连接参数；服务端证书和 REALITY 私钥在线路的「TLS
                证书与安全参数」中配置。
              </Notice>
            )}
            {tls?.enabled && (
              <>
                <AppField
                  name={[...prefix, "tls", "serverName"]}
                  label="服务器名称（SNI）"
                >
                  <Input placeholder="example.com" />
                </AppField>
                <div className="grid gap-4 sm:grid-cols-2">
                  {!directTls && <AppField
                    name={[...prefix, "tls", "fingerprint"]}
                    label="客户端指纹"
                    description={
                      fingerprintUnsupported
                        ? "当前目标不支持现有指纹；值仍保留，请选择支持的指纹或清除。"
                        : targetCore === "xray"
                          ? "Xray 指纹按所选核心版本校验。"
                          : undefined
                    }
                    rules={
                      fingerprintUnsupported
                        ? [
                            {
                              validator: () =>
                                Promise.reject(
                                  new Error("当前目标不支持此客户端指纹。"),
                                ),
                            },
                          ]
                        : []
                    }
                    trigger="onValueChange"
                  >
                    <ChoiceSelect
                      clearable
                      options={fingerprints.map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  </AppField>}
                  {(!xrayReality || tls.alpn?.length > 0) && (
                    <AppField
                      name={[...prefix, "tls", "alpn"]}
                      label="ALPN"
                      trigger="onValueChange"
                      description={
                        xrayReality
                          ? "Xray REALITY 不支持显式 ALPN；已有值仍保留，请移除后保存。"
                          : hysteria2 ? "仅支持 h3；也可留空使用默认值。" : undefined
                      }
                      rules={
                        xrayReality
                          ? [
                              {
                                validator: (_, value) =>
                                  value?.length
                                    ? Promise.reject(
                                        new Error(
                                          "Xray REALITY 不支持显式 ALPN。",
                                        ),
                                      )
                                    : Promise.resolve(),
                              },
                            ]
                          : hysteria2 ? [{ validator: (_, value) =>
                              !value?.length || (value.length === 1 && value[0] === "h3")
                                ? Promise.resolve()
                                : Promise.reject(new Error("Hysteria2 的 ALPN 只能留空或选择一个 h3，请移除其他值或重复项。")),
                            }] : []
                      }
                    >
                      <MultiChoice
                        creatable={!xrayReality && !hysteria2}
                        clearable={xrayReality || hysteria2}
                        searchable={!xrayReality && !hysteria2}
                        options={
                          xrayReality
                            ? []
                            : (hysteria2 ? ["h3"] : ["h2", "http/1.1"]).map((value) => ({
                                value,
                                label: value,
                              }))
                        }
                      />
                    </AppField>
                  )}
                  {xrayReality && !tls.alpn?.length && (
                    <p className="text-xs text-muted-foreground">
                      Xray REALITY 不使用显式 ALPN。
                    </p>
                  )}
                </div>
                {!directTls && security === "reality" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <AppField
                      name={[...prefix, "tls", "reality", "publicKey"]}
                      label="REALITY 公钥"
                      rules={[{ required: true, message: "填写 REALITY 公钥" }]}
                    >
                      <Input />
                    </AppField>
                    <AppField
                      name={[...prefix, "tls", "reality", "shortId"]}
                      label="REALITY Short ID"
                    >
                      <Input />
                    </AppField>
                    {limited && (
                      <AppField
                        noStyle
                        name={[...prefix, "tls", "reality"]}
                        trigger="onClear"
                      >
                        <ClearValueButton>
                          移除不支持的 REALITY 设置
                        </ClearValueButton>
                      </AppField>
                    )}
                  </div>
                )}
              </>
            )}
          </FieldSet>
          {protocol === "vless" && (!limited || flow || packetEncoding) && (
            <Accordion
              type="single"
              collapsible
              defaultValue={
                limited && (flow || packetEncoding) ? "advanced" : undefined
              }
            >
              <AccordionItem value="advanced">
                <AccordionTrigger>高级协议参数</AccordionTrigger>
                <AccordionContent
                  forceMount
                  className="space-y-4 data-[state=closed]:hidden"
                >
                  {((!principalListener && !limited) || (limited && flow)) && (
                    <AppField
                      name={field("flow")}
                      label="Flow"
                      trigger="onValueChange"
                    >
                      <ChoiceSelect
                        clearable
                        options={
                          limited
                            ? [
                                {
                                  value: flow,
                                  label: `${flow}（此核心不支持）`,
                                  disabled: true,
                                },
                              ]
                            : [
                                {
                                  value: "xtls-rprx-vision",
                                  label: "XTLS Vision",
                                },
                              ]
                        }
                      />
                    </AppField>
                  )}
                  {limited && flow && (
                    <AppField noStyle name={field("flow")} trigger="onClear">
                      <ClearValueButton>移除不支持的 Flow</ClearValueButton>
                    </AppField>
                  )}
                  {(!limited || packetEncoding) && (
                    <AppField
                      name={field("packetEncoding")}
                      label={
                        limited ? "数据包封装（此核心不支持）" : "数据包封装"
                      }
                      trigger="onValueChange"
                      description="按客户端目标选择；不支持的目标会明确拒绝生成。"
                    >
                      <ChoiceSelect
                        clearable
                        options={
                          limited
                            ? [
                                {
                                  value: packetEncoding,
                                  label: packetEncoding,
                                  disabled: true,
                                },
                              ]
                            : [
                                { value: "xudp", label: "XUDP" },
                                { value: "packetaddr", label: "PacketAddr" },
                              ]
                        }
                      />
                    </AppField>
                  )}
                  {limited && packetEncoding && (
                    <AppField
                      noStyle
                      name={field("packetEncoding")}
                      trigger="onClear"
                    >
                      <ClearValueButton>移除数据包封装</ClearValueButton>
                    </AppField>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </>
      )}
    </div>
  );
}

function TransportHeaders({ prefix }: { prefix: string[] }) {
  const form = useFormInstance();
  const initialized = useRef(false);
  const rowNames = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const name = [...prefix, "transport", "headerRows"];
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const existing = form.getFieldValue(name);
    if (!existing)
      form.setFieldValue(
        name,
        Object.entries(
          form.getFieldValue([...prefix, "transport", "headers"]) || {},
        ).map(([name, value]) => ({ name, value })),
      );
  }, [form]);
  return (
    <FormList name={name}>
      {(fields, { add, remove }) => (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Host 请使用上方专用字段。请求头名称不可重复，不支持换行。
          </p>
          {fields.map((field, index) => (
            <div
              key={field.key}
              data-header-row
              className="grid grid-cols-[1fr_1fr_auto] items-start gap-2"
            >
              <AppField
                name={[field.name, "name"]}
                label="请求头名称"
                rules={[
                  { required: true, message: "填写请求头名称" },
                  {
                    pattern: /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
                    message: "请求头名称含有无效字符",
                  },
                  {
                    validator: (_, value) => {
                      const rows: HeaderRow[] = form.getFieldValue(name) || [];
                      const key = String(value).toLowerCase();
                      return key === "host"
                        ? Promise.reject(new Error("请使用 Host 专用字段"))
                        : [
                              "connection",
                              "upgrade",
                              "sec-websocket-key",
                              "sec-websocket-version",
                              "sec-websocket-extensions",
                              "content-length",
                              "transfer-encoding",
                              "trailer",
                            ].includes(key)
                          ? Promise.reject(
                              new Error("此请求头由传输核心管理，不能覆盖"),
                            )
                          : rows.filter(
                                (row) =>
                                  row.name?.toLowerCase() ===
                                  String(value).toLowerCase(),
                              ).length > 1
                            ? Promise.reject(new Error("请求头名称不能重复"))
                            : Promise.resolve();
                    },
                  },
                ]}
              >
                <Input
                  placeholder="X-Custom"
                  ref={(input) => {
                    if (input) rowNames.current.set(field.key, input);
                    else rowNames.current.delete(field.key);
                  }}
                />
              </AppField>
              <AppField
                name={[field.name, "value"]}
                label="请求头值"
                rules={[
                  { pattern: /^[^\r\n]*$/, message: "请求头值不能包含换行" },
                ]}
              >
                <Input />
              </AppField>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-6"
                aria-label={`移除请求头 ${field.name + 1}`}
                onClick={(event) => {
                  // Move focus before deletion: remaining keyed rows keep their DOM
                  // identity, with no deferred callback that can steal newer focus.
                  if (
                    event.currentTarget
                      .closest("[data-header-row]")
                      ?.contains(document.activeElement)
                  ) {
                    const neighbor = fields[index + 1] || fields[index - 1];
                    const target = neighbor
                      ? rowNames.current.get(neighbor.key)
                      : addButton.current;
                    target?.focus();
                  }
                  remove(field.name);
                }}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={fields.length >= 32}
            ref={addButton}
            onClick={() => add({ name: "", value: "" })}
          >
            <Plus aria-hidden="true" />
            添加请求头
          </Button>
        </div>
      )}
    </FormList>
  );
}

function SecurityModePicker({
  checked,
  onCheckedChange,
  protocol,
  limited,
  realityDisabled = false,
  reality,
  onRealityChange,
  ...aria
}: {
  checked?: boolean;
  onCheckedChange?: (value: boolean) => void;
  protocol: string;
  limited: boolean;
  realityDisabled?: boolean;
  reality?: NonNullable<Connection["tls"]>["reality"];
  onRealityChange: (value: NonNullable<Connection["tls"]>["reality"]) => void;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const mode = checked ? (reality ? "reality" : "tls") : "none";
  return (
    <RadioGroup
      {...aria}
      value={mode}
      className="flex flex-wrap gap-4"
      onValueChange={(value) => {
        onCheckedChange?.(value !== "none");
        onRealityChange(
          value === "reality"
            ? reality || { publicKey: "", shortId: "" }
            : undefined,
        );
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <RadioGroupItem value="none" disabled={["trojan", "hysteria2", "anytls"].includes(protocol)} />无
      </label>
      <label className="flex items-center gap-2 text-sm">
        <RadioGroupItem value="tls" />
        TLS
      </label>
      {!["hysteria2", "anytls"].includes(protocol) && ((!limited && protocol === "vless") || reality) && (
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem
            value="reality"
            disabled={limited || realityDisabled}
          />
          REALITY
        </label>
      )}
    </RadioGroup>
  );
}

function ClearValueButton({
  onClear,
  children,
}: {
  value?: unknown;
  onClear?: (value: undefined) => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => onClear?.(undefined)}
    >
      {children}
    </Button>
  );
}

function UnsupportedListenerHeaders({
  value,
  onChange,
}: {
  value?: Record<string, string>;
  onChange?: (value: undefined) => void;
}) {
  if (!value || !Object.keys(value).length) return null;
  return (
    <Notice tone="warning" title="监听端不支持自定义请求头">
      <p>
        这些参数仅用于客户端出站请求，不会转换成服务端响应头。已有参数仍保留，请明确移除后保存。
      </p>
      <p className="mt-2 break-words text-xs">
        已有请求头：{Object.keys(value).join("、")}（值已隐藏）
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-3"
        onClick={() => onChange?.(undefined)}
      >
        移除不支持的请求头
      </Button>
    </Notice>
  );
}
