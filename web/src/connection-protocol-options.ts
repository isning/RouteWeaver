import type { Connection } from "./types";

// Canonicalize editable protocol values without discarding unsupported intent.
export function normalizeProtocolOptions(connection: Connection): Connection {
  const copy = { ...connection };
  if (copy.hysteria2) {
    const h = { ...copy.hysteria2 };
    if (h.obfs) {
      h.obfs = { ...h.obfs, type: h.obfs.type || "salamander" };
      if (!h.obfs.password && h.obfs.type === "salamander") delete h.obfs;
    }
    for (const key of ["upMbps", "downMbps", "hopIntervalSeconds"] as const) {
      const raw = h[key] as unknown;
      if (raw === "" || raw == null) delete h[key];
      else if (/^\d+$/.test(String(raw))) h[key] = Number(raw);
    }
    if (Array.isArray(h.serverPorts) && h.serverPorts.every(value => typeof value === "string")) {
      h.serverPorts = h.serverPorts.map((s) => s.trim()).filter(Boolean);
      if (!h.serverPorts.length) delete h.serverPorts;
    }
    if (Object.values(h).every((value) => value == null)) delete copy.hysteria2;
    else copy.hysteria2 = h;
  }
  if (
    copy.tuic &&
    Object.values(copy.tuic).every((value) => value == null || value === "")
  )
    delete copy.tuic;
  return copy;
}
