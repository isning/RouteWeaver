import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Activity, ArrowLeftRight, Network } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { AppField, useFormInstance, useWatch } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { NumericInput } from "@/ui-patterns/numeric-input";
import type { ManagedEndpoint } from "./types";

const toggleRow = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 [&>[data-slot=field-description]]:col-span-2";
const pairedFields = "grid min-w-0 gap-4 @min-[29rem]:grid-cols-2";

function NetworkToggle({ name, label, description }: { name: string[]; label: string; description?: string }) {
  return (
    <AppField name={name} label={label} trigger="onValueChange" description={description}
      getValueProps={(value?: boolean) => ({ value: value == null ? undefined : String(value) })}
      getValueFromEvent={(value?: string) => value === undefined ? undefined : value === "true"}>
      <ChoiceSelect clearable placeholder="核心默认" options={[
        { value: "true", label: "启用" }, { value: "false", label: "关闭" },
      ]} />
    </AppField>
  );
}

function Seconds({ name, label }: { name: string[]; label: string }) {
  return (
    <AppField name={name} label={label} trigger="onValueChange"
      rules={[{ type: "integer", min: 0, max: 2147483647, message: "请输入 0–2147483647 的整数" }]}>
      <NumericInput min={0} max={2147483647} placeholder="核心默认" />
    </AppField>
  );
}

export function ListenerNetworkFields({ adapter, protocol }: { adapter?: string; protocol?: string }) {
  const form = useFormInstance();
  const tcp = useWatch("tcp", { form, preserve: true }) as ManagedEndpoint["tcp"];
  const udp = useWatch("udp", { form, preserve: true }) as ManagedEndpoint["udp"];
  const proxy = useWatch("acceptProxyProtocol", { form, preserve: true });
  const xray = adapter === "routeweaver/xray";
  const singBox = adapter === "routeweaver/sing-box";
  const showTCP = (xray || singBox) && !!protocol && !["hysteria2", "tuic"].includes(protocol);
  const showUDP = singBox && ["socks", "shadowsocks", "hysteria2", "tuic"].includes(protocol || "");
  const incompatibleTCP = !!tcp && (!showTCP || (!singBox && tcp.disableKeepAlive));
  const incompatibleUDP = !!udp && !showUDP;
  const incompatibleProxy = !!proxy && !xray;
  if (!showTCP && !showUDP && !xray && !incompatibleTCP && !incompatibleUDP && !incompatibleProxy) return null;
  return (
    <FieldSet aria-label="高级网络设置" className="@container min-w-0 gap-3">
      <FieldLegend variant="label">高级网络设置</FieldLegend>
      {(showTCP || showUDP || xray) && (
        <Accordion type="multiple" className="gap-2">
          {showTCP && (
            <AccordionItem value="tcp" className="rounded-lg border bg-card">
              <AccordionTrigger className="items-center gap-2 px-3">
                <Activity aria-hidden="true" className="size-4 text-muted-foreground" />
                TCP 设置
              </AccordionTrigger>
              <AccordionContent forceMount className="space-y-4 px-3 pb-3">
                <NetworkToggle name={["tcp", "fastOpen"]} label="TCP Fast Open" description="启用后仍需要服务器内核支持" />
                <FieldSet aria-label="TCP Keepalive" className="min-w-0 gap-3 rounded-lg bg-muted/40 p-3">
                  <FieldLegend variant="label" className="mb-0 px-1">TCP Keepalive</FieldLegend>
                  {singBox && (
                    <AppField name={["tcp", "disableKeepAlive"]} label="关闭 TCP Keepalive"
                      className={toggleRow} valuePropName="checked" trigger="onCheckedChange"
                      description={tcp?.disableKeepAlive && (tcp.keepAliveIdleSeconds || tcp.keepAliveIntervalSeconds) ? "请清空下方的时间设置，或重新开启 Keepalive" : undefined}>
                      <Switch />
                    </AppField>
                  )}
                  <div className={pairedFields}>
                    <Seconds name={["tcp", "keepAliveIdleSeconds"]} label="Keepalive 空闲时间（秒）" />
                    <Seconds name={["tcp", "keepAliveIntervalSeconds"]} label="Keepalive 探测间隔（秒）" />
                  </div>
                </FieldSet>
              </AccordionContent>
            </AccordionItem>
          )}
          {showUDP && (
            <AccordionItem value="udp" className="rounded-lg border bg-card">
              <AccordionTrigger className="items-center gap-2 px-3">
                <Network aria-hidden="true" className="size-4 text-muted-foreground" />
                UDP 设置
              </AccordionTrigger>
              <AccordionContent forceMount className="px-3 pb-3">
                <div className={pairedFields}>
                  <NetworkToggle name={["udp", "fragment"]} label="UDP 分片" />
                  <Seconds name={["udp", "timeoutSeconds"]} label="UDP NAT 超时（秒）" />
                </div>
              </AccordionContent>
            </AccordionItem>
          )}
          {xray && (
            <AccordionItem value="proxy" className="rounded-lg border bg-card">
              <AccordionTrigger className="items-center gap-2 px-3">
                <ArrowLeftRight aria-hidden="true" className="size-4 text-muted-foreground" />
                反向代理接入
              </AccordionTrigger>
              <AccordionContent forceMount className="px-3 pb-3">
                <AppField name="acceptProxyProtocol" label="接受 PROXY protocol"
                  description="启用后，前置代理须在每次连接时发送 PROXY 协议头"
                  className={toggleRow} valuePropName="checked" trigger="onCheckedChange">
                  <Switch />
                </AppField>
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      )}
      {(incompatibleTCP || incompatibleUDP || incompatibleProxy) && (
        <Notice tone="warning" title="当前核心或协议不支持部分网络设置">
          <ActionButton variant="outline" onClick={() => {
            if (incompatibleTCP) form.setFieldValue("tcp", undefined);
            if (incompatibleUDP) form.setFieldValue("udp", undefined);
            if (incompatibleProxy) form.setFieldValue("acceptProxyProtocol", undefined);
          }}>清除不支持的设置</ActionButton>
        </Notice>
      )}
    </FieldSet>
  );
}
