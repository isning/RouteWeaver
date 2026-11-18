export const clientTargets = [
  { value: "mihomo", label: "Mihomo 1.19.32", version: "1.19.32" },
  { value: "sing-box", label: "sing-box 1.14.3", version: "1.14.3" },
  { value: "sing-box@1.14.4", label: "sing-box 1.14.4", version: "1.14.4" },
];
export function clientTarget(adapterId: string) {
  const selected = clientTargets.find((t) => t.value === adapterId);
  if (!selected) throw new Error("请选择受支持的客户端");
  return { adapterId: selected.value.split("@")[0], version: selected.version };
}

export function clientTargetValue(target: {adapterId: string; version: string}) {
  return target.adapterId === "sing-box" && target.version === "1.14.4" ? "sing-box@1.14.4" : target.adapterId;
}
