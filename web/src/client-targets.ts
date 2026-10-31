export const clientTargets = [
  { value: "mihomo", label: "Mihomo 1.19.32", version: "1.19.32" },
  { value: "sing-box", label: "sing-box 1.14.3", version: "1.14.3" },
];
export function clientTarget(adapterId: string) {
  const selected = clientTargets.find((t) => t.value === adapterId);
  if (!selected) throw new Error("请选择受支持的客户端");
  return { adapterId: selected.value, version: selected.version };
}
