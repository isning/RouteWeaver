export const historyLegacyName = "欧洲与亚太跨区域维护的历史链路配置";
const name = historyLegacyName;
export const historyLegacyFixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "layout-admin", name: "Admin", role: "admin" },
    csrfToken: "fixture",
  },
  "/state": {
    nodes: [
      {
        id: "node",
        name: "Office endpoint",
        host: "office.example",
        port: 1080,
        protocol: "socks",
      },
    ],
    users: [],
    capabilities: [],
    routes: [
      { id: "route", name, engine: "sing-box", hops: ["node"], userIds: [] },
    ],
    revisions: [
      {
        id: "revision",
        routeId: "route",
        engine: "sing-box",
        status: "rendered",
        createdAt: "2026-10-29T10:00:00Z",
        artifacts: [{ path: "config.json", content: '{"log":{}}' }],
        digest: "fixture-digest",
        nativeChecked: false,
      },
    ],
  },
  "/settings": {},
  "/audit": [],
  "/services": [],
  "/published-routes": [],
  "/rates": [],
  "/user-groups": [],
};
