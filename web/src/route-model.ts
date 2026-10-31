export function connectHop(
  hops: string[],
  source: string,
  target: string,
  maxHops: number,
): string[] {
  if (source === target || hops.includes(target))
    throw new Error("线路不能形成循环，也不能重复使用同一节点。");
  if (hops.length && hops[hops.length - 1] !== source)
    throw new Error("请从当前线路末端连接，首版暂不支持分支线路。");
  const next = hops.length ? [...hops, target] : [source, target];
  if (next.length > maxHops)
    throw new Error(`当前渲染器最多支持 ${maxHops} 跳，请先缩短线路。`);
  return next;
}
export function displayRouteName(
  route: { id: string; name: string; hops: string[]; engine: string },
  nodes: { id: string; name: string }[],
): string {
  const path = route.hops
    .map((id) => nodes.find((n) => n.id === id)?.name || "未知节点")
    .join(" → ");
  return `${route.name || "未命名线路"} · ${path || "未选择节点"} · ${route.engine}`;
}
