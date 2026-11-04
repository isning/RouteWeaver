import { RouteContent } from "@/ui-patterns/route-content";
import { PasswordInput } from "@/ui-patterns/password-input";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import {
  Bell as BellOutlined,
  Workflow as ApartmentOutlined,
  Grid2X2 as AppstoreOutlined,
  ArrowRight as ArrowRightOutlined,
  BookOpen as BookOutlined,
  Server as CloudServerOutlined,
  Compass as CompassOutlined,
  Database as DatabaseOutlined,
  Folder as FolderOutlined,
  Link as LinkOutlined,
  LogOut as LogoutOutlined,
  Menu as MenuOutlined,
  Settings as SettingOutlined,
  Users as TeamOutlined,
  Zap as ThunderboltOutlined,
} from "lucide-react";
import { usePublicationRequest } from "./usePublicationRequest";
import type { SourceProfileEntry } from "./Subscriptions";
import {
  createWorkspaceHistory,
  currentWorkspaceHistoryState,
  type WorkspaceHistory,
} from "./workspace-history";
import {
  SubscriptionContextProvider,
  WorkspaceHistoryContext,
} from "./SubscriptionContext";
import { hasUnsavedChanges } from "./navigation";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { lazyPage, PageBoundary } from "./PageBoundary";
import { SessionBoundary, useSessionAccess } from "./SessionBoundary";
import { APIError, loginWithToken, post, setToken } from "./api";
import type { Session } from "./types";
import type { SourceAcceptanceReceipt } from "./SourceUpdateContinuation";
import { ErrorNotice } from "./components";
import { PageSkeleton } from "./ui-patterns/loading-state";
const SubscriptionsPage = lazyPage(() => import("./Subscriptions").then(m => ({ default: m.SubscriptionsPage })));
const AccountMFA = lazyPage(() =>
  import("./Security").then((m) => ({ default: m.SecuritySettings })),
);
const AccountSecurityPage = lazyPage(() =>
  import("./AccountSecurity").then((m) => ({ default: m.AccountSecurityPage })),
);
const SourcesPage = lazyPage(() =>
  import("./Sources").then((m) => ({ default: m.SourcesPage })),
);
const CollectionsPage = lazyPage(() =>
  import("./Sources").then((m) => ({ default: m.CollectionsPage })),
);
const ResourcesPage = lazyPage(() =>
  import("./Sources").then((m) => ({ default: m.ResourcesPage })),
);
const AdminPage = lazyPage(() =>
  import("./Admin").then((m) => ({ default: m.AdminPage })),
);
const ServersPage = lazyPage(() =>
  import("./Infrastructure").then((m) => ({ default: m.ServersPage })),
);
const ServerRoutesPage = lazyPage(() =>
  import("./ServerRoutes").then((m) => ({ default: m.ServerRoutesPage })),
);
const TemplatesPage = lazyPage(() =>
  import("./Templates").then((m) => ({ default: m.TemplatesPage })),
);
const PublishedRoutesPage = lazyPage(() =>
  import("./PublishedRoutes").then((m) => ({ default: m.PublishedRoutesPage })),
);
const InboxPage = lazyPage(() =>
  import("./Notifications").then((m) => ({ default: m.InboxPage })),
);
const NotificationsAdminPage = lazyPage(() =>
  import("./Notifications").then((m) => ({
    default: m.NotificationsAdminPage,
  })),
);
const FleetPage = lazyPage(() =>
  import("./Fleet").then((m) => ({ default: m.FleetPage })),
);
export type Page =
  | "account-security"
  | "fleet"
  | "published-routes"
  | "notifications"
  | "inbox"
  | "templates"
  | "subscriptions"
  | "profiles"
  | "sources"
  | "collections"
  | "resources"
  | "outputs"
  | "routes"
  | "nodes"
  | "users"
  | "services"
  | "activity"
  | "settings"
  | "servers"
  | "legacy-routes";
const personal = [
  {
    id: "account-security",
    label: "账号安全",
    icon: <SettingOutlined aria-hidden="true" />,
  },
  {
    id: "subscriptions",
    label: "我的订阅",
    icon: <CompassOutlined aria-hidden="true" />,
  },
  {
    id: "sources",
    label: "订阅来源",
    icon: <LinkOutlined aria-hidden="true" />,
  },
  {
    id: "collections",
    label: "节点集合",
    icon: <FolderOutlined aria-hidden="true" />,
  },
  {
    id: "resources",
    label: "规则资源",
    icon: <BookOutlined aria-hidden="true" />,
  },
  {
    id: "templates",
    label: "模板与预设",
    icon: <BookOutlined aria-hidden="true" />,
  },
  { id: "inbox", label: "消息", icon: <BellOutlined aria-hidden="true" /> },
];
const admin = [
  {
    id: "published-routes",
    label: "线路",
    icon: <CompassOutlined aria-hidden="true" />,
  },
  {
    id: "routes",
    label: "转发路径",
    icon: <ApartmentOutlined aria-hidden="true" />,
  },
  {
    id: "servers",
    label: "服务器",
    icon: <CloudServerOutlined aria-hidden="true" />,
  },
  {
    id: "fleet",
    label: "执行任务",
    icon: <ThunderboltOutlined aria-hidden="true" />,
  },
  { id: "users", label: "用户", icon: <TeamOutlined aria-hidden="true" /> },
  {
    id: "services",
    label: "服务方案",
    icon: <AppstoreOutlined aria-hidden="true" />,
  },
  {
    id: "activity",
    label: "变更记录",
    icon: <DatabaseOutlined aria-hidden="true" />,
  },
  {
    id: "settings",
    label: "平台设置",
    icon: <SettingOutlined aria-hidden="true" />,
  },
  { id: "nodes", label: "连接端点", icon: <LinkOutlined aria-hidden="true" /> },
  {
    id: "legacy-routes",
    label: "链路配置",
    icon: <ApartmentOutlined aria-hidden="true" />,
  },
  {
    id: "notifications",
    label: "公告与通知",
    icon: <BellOutlined aria-hidden="true" />,
  },
];
const navigationGroups: {
  label: string;
  pages: Page[];
  adminOnly?: boolean;
  discoverable?: boolean;
}[] = [
  { label: "订阅与分流", pages: ["subscriptions"], discoverable: true },
  {
    label: "订阅素材",
    pages: ["sources", "collections", "resources", "templates"],
  },
  {
    label: "网络资源",
    pages: ["servers", "nodes", "published-routes", "routes"],
    discoverable: true,
    adminOnly: true,
  },
  { label: "用户与权限", pages: ["users", "services"], adminOnly: true },
  {
    label: "运维与设置",
    pages: ["fleet", "activity", "notifications", "settings"],
    adminOnly: true,
  },
  { label: "连接诊断", pages: ["legacy-routes"], adminOnly: true },
];
function initialPage(): Page {
  const name = location.hash.slice(1).split("?")[0];
  return name === "profiles" ||
    name === "outputs" ||
    [...personal, ...admin].some((i) => i.id === name)
    ? (name as Page)
    : "subscriptions";
}
// One-shot draft requests are not subscription inventory scopes or browser-stored drafts.
function subscriptionInventoryHash(hash: string) {
  const [page, search] = hash.split("?");
  const params = new URLSearchParams(search);
  params.delete("sourceDraft");
  return `${page}${params.size ? `?${params}` : ""}`;
}
// Exit animation retains the DOM briefly; closed links must stop being interactive immediately.
export function SidebarNavigationGroup({
  defaultOpen,
  label,
  children,
}: {
  defaultOpen: boolean;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        // Only recover focus owned by this group, never a newer destination elsewhere.
        if (!nextOpen && contentRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus();
        }
        setOpen(nextOpen);
      }}
      className="group/collapsible"
    >
      <CollapsibleTrigger asChild>
        <SidebarGroupLabel asChild>
          <button
            ref={triggerRef}
            className="w-full cursor-pointer text-xs font-medium"
          >
            {label}
            <ChevronDown
              className="ml-auto size-4 transition-transform group-data-[state=closed]/collapsible:-rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </button>
        </SidebarGroupLabel>
      </CollapsibleTrigger>
      <CollapsibleContent ref={contentRef} inert={!open} aria-hidden={!open}>
        <SidebarGroupContent>{children}</SidebarGroupContent>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function App() {
  return (
    <SessionBoundary login={(props) => <Login {...props} />}>
      <Workspace />
    </SessionBoundary>
  );
}
function Workspace() {
  const confirm = useConfirm();
  const { lifecycle, snapshot } = useSessionAccess();
  const session = snapshot.session!;
  const publicationRequests = usePublicationRequest(lifecycle, snapshot);
  // Only this authenticated browser session may retain source acceptance evidence.
  // CSRF identity is compared in memory; it is never part of a receipt or a URL.
  const receiptScope = session
    ? `${session.user.id}:${session.csrfToken}`
    : null;
  const receiptScopeRef = useRef(receiptScope);
  const [sourceReceipts, setSourceReceipts] = useState<{
    scope: string | null;
    values: Record<string, SourceAcceptanceReceipt>;
  }>({ scope: receiptScope, values: {} });
  useLayoutEffect(() => {
    receiptScopeRef.current = receiptScope;
    setSourceReceipts((current) =>
      current.scope === receiptScope
        ? current
        : { scope: receiptScope, values: {} },
    );
  }, [receiptScope]);
  const retainSourceAcceptance = (receipt: SourceAcceptanceReceipt) => {
    if (!receiptScope || receiptScopeRef.current !== receiptScope) return;
    setSourceReceipts((current) => ({
      scope: receiptScope,
      values: {
        ...(current.scope === receiptScope ? current.values : {}),
        [receipt.sourceId]: receipt,
      },
    }));
  };
  const [requestedPage, setPage] = useState<Page>(initialPage);
  const passwordRequired = !!session.user.passwordChangeRequired;
  const page = passwordRequired ? "account-security" : requestedPage;
  const sourceProfileRequest = useRef<{
    entry: SourceProfileEntry;
    scope: string | null;
  } | null>(null);
  const [sourceProfileEntry, setSourceProfileEntry] =
    useState<SourceProfileEntry | null>(null);
  useLayoutEffect(() => {
    if (sourceProfileRequest.current?.scope !== receiptScope) {
      sourceProfileRequest.current = null;
      setSourceProfileEntry(null);
    }
  }, [receiptScope]);
  const [discardGeneration, setDiscardGeneration] = useState(0);
  const workspaceHistory = useRef<WorkspaceHistory | null>(null);
  const lastSubscriptionHash = useRef(
    ["subscriptions", "profiles", "outputs"].includes(
      location.hash.slice(1).split("?")[0],
    )
      ? subscriptionInventoryHash(location.hash)
      : "#subscriptions",
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuTrigger = useRef<HTMLButtonElement>(null);
  const mobilePanel = useRef<HTMLDivElement>(null);
  const mobileOpenRef = useRef(false);
  const mobileCycle = useRef(0);
  const mobileReview = useRef<{
    panel: HTMLElement | null;
  } | null>(null);
  const mobileCloseIntent = useRef<{
    target: "trigger" | "main";
    hash: string;
    cycle: number;
    generation: number;
    accountEpoch: number;
    panel: HTMLElement | null;
    review: {
      panel: HTMLElement | null;
    } | null;
    closed: boolean;
  } | null>(null);
  const finishMobileFocus = () => {
    const intent = mobileCloseIntent.current;
    if (
      !intent?.closed ||
      (intent.review && mobileReview.current === intent.review)
    )
      return;
    mobileCloseIntent.current = null;
    const current = lifecycle.getSnapshot();
    if (
      mobileOpenRef.current ||
      intent.cycle !== mobileCycle.current ||
      !window.matchMedia("(max-width: 1023px)").matches ||
      current.phase !== "active" ||
      current.concealed ||
      current.generation !== intent.generation ||
      current.accountEpoch !== intent.accountEpoch ||
      location.hash !== intent.hash
    )
      return;
    const focused = document.activeElement;
    if (
      focused !== document.body &&
      !intent.panel?.contains(focused) &&
      !intent.review?.panel?.contains(focused)
    )
      return;
    // A newly opened editor owns focus even before its autofocus has run.
    if (
      [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
        (dialog) =>
          dialog !== intent.panel &&
          dialog !== intent.review?.panel &&
          !intent.panel?.contains(dialog) &&
          dialog.getClientRects().length > 0 &&
          !dialog.closest('[hidden], [inert], [aria-hidden="true"]') &&
          getComputedStyle(dialog).visibility !== "hidden",
      )
    )
      return;
    const target =
      intent.target === "main"
        ? document.getElementById("main")
        : mobileMenuTrigger.current;
    if (target?.isConnected && !target.closest('[inert], [aria-hidden="true"]'))
      target.focus({ preventScroll: intent.target === "trigger" });
  };
  const closeMobileNavigation = (
    target: "trigger" | "main",
    hash = location.hash,
  ) => {
    if (!mobileOpenRef.current) return;
    mobileOpenRef.current = false;
    const current = lifecycle.getSnapshot();
    mobileCloseIntent.current = {
      target,
      hash,
      cycle: mobileCycle.current,
      generation: current.generation,
      accountEpoch: current.accountEpoch,
      panel:
        mobilePanel.current?.closest<HTMLElement>("[data-task-overlay]") ||
        mobilePanel.current,
      review: mobileReview.current,
      closed: false,
    };
    setMobileOpen(false);
  };
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setNarrow(media.matches);
      if (!media.matches) {
        mobileOpenRef.current = false;
        mobileCloseIntent.current = null;
        mobileCycle.current++;
        setMobileOpen(false);
      }
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [authError, setAuthError] = useState<Error | null>(null);
  const isAdmin = session?.user.role === "admin";
  const adminMode = admin.some((i) => i.id === page);
  const subscriptionPage = (value: Page) =>
    ["subscriptions", "profiles", "outputs"].includes(value);
  const navigate = (next: Page) => {
    if (next === page) {
      closeMobileNavigation("trigger");
      return;
    }
    const scope = subscriptionPage(next)
      ? subscriptionInventoryHash(
          subscriptionPage(page) ? location.hash : lastSubscriptionHash.current,
        ).split("?")[1]
      : undefined;
    workspaceHistory.current?.navigate(`#${next}${scope ? `?${scope}` : ""}`);
  };
  const createProfileFromSource = (sourceId: string) => {
    if (
      lifecycle.getSnapshot().phase !== "active" ||
      receiptScopeRef.current !== receiptScope ||
      location.hash.split("?")[0] !== "#sources"
    )
      return;
    const entry = { token: crypto.randomUUID(), sourceId };
    sourceProfileRequest.current = { entry, scope: receiptScope };
    workspaceHistory.current?.navigate(
      `#subscriptions?sourceDraft=${entry.token}`,
    );
  };
  const consumeSourceProfileEntry = (token: string) => {
    if (sourceProfileRequest.current?.entry.token === token)
      sourceProfileRequest.current = null;
    setSourceProfileEntry((current) =>
      current?.token === token ? null : current,
    );
  };
  const navigationGeneration = useRef(snapshot.generation);
  const navigationCallbacks = useRef({ confirm });
  navigationCallbacks.current = { confirm };
  useLayoutEffect(() => {
    const controller = createWorkspaceHistory({
      isDirty: hasUnsavedChanges,
      isActive: () => lifecycle.getSnapshot().phase === "active",
      confirm: (proceed, cancel, context) => {
        const review = mobileOpenRef.current
          ? { panel: null as HTMLElement | null }
          : null;
        if (review) mobileReview.current = review;
        const handle = navigationCallbacks.current.confirm({
          title: "放弃未保存的修改？",
          description: context?.unowned
            ? "继续编辑会建立新的历史记录，并清除浏览器的前进记录。"
            : "当前编辑尚未保存。离开会放弃尚未保存的内容。",
          confirmLabel: "放弃修改并离开",
          cancelLabel: "继续编辑",
          destructive: true,
          onConfirm: proceed,
          onCancel: cancel,
          contentProps: review
            ? {
                ref: (element: HTMLDivElement | null) => {
                  if (element) review.panel = element;
                },
              }
            : undefined,
          onClosed: () => {
            if (review && mobileReview.current === review) {
              mobileReview.current = null;
              finishMobileFocus();
            }
          },
        });
        return { destroy: handle.close };
      },
      accept: (hash, discarded) => {
        const next = initialPage();
        const token = new URLSearchParams(hash.split("?")[1]).get(
          "sourceDraft",
        );
        const pending = sourceProfileRequest.current;
        const entry =
          next === "subscriptions" &&
          pending?.entry.token === token &&
          pending.scope === receiptScopeRef.current
            ? pending.entry
            : null;
        setSourceProfileEntry(entry);
        if (!entry) sourceProfileRequest.current = null;
        if (subscriptionPage(next))
          lastSubscriptionHash.current = subscriptionInventoryHash(hash);
        setPage(next);
        if (discarded) setDiscardGeneration((generation) => generation + 1);
        closeMobileNavigation("main", hash);
        if (!subscriptionPage(next)) window.scrollTo({ top: 0 });
      },
    });
    workspaceHistory.current = controller;
    return () => {
      mobileCloseIntent.current = null;
      mobileReview.current = null;
      mobileOpenRef.current = false;
      mobileCycle.current++;
      controller.dispose();
      workspaceHistory.current = null;
    };
  }, [lifecycle]);
  useLayoutEffect(() => {
    if (
      snapshot.concealed ||
      navigationGeneration.current !== snapshot.generation
    ) {
      workspaceHistory.current?.suspend();
      navigationGeneration.current = snapshot.generation;
    }
    if (snapshot.phase === "active") workspaceHistory.current?.resume();
  }, [snapshot.phase, snapshot.concealed, snapshot.generation]);
  const logout = async () => {
    const ownerEpoch = snapshot.accountEpoch;
    try {
      await post("/auth/logout");
      if (lifecycle.forget()) {
        history.replaceState(
          currentWorkspaceHistoryState(),
          "",
          location.pathname,
        );
      }
    } catch (error) {
      setAuthError(error as Error);
      // A sent logout may have changed the cookie even if its result was
      // superseded. Never let an old 401 forget a newer account's workspace.
      await lifecycle.check();
      const current = lifecycle.getSnapshot();
      if (
        current.accountEpoch === ownerEpoch &&
        current.phase === "recovery" &&
        current.error instanceof APIError &&
        current.error.status === 401 &&
        lifecycle.forget()
      ) {
        history.replaceState(
          currentWorkspaceHistoryState(),
          "",
          location.pathname,
        );
      } else lifecycle.changed();
    }
  };
  const menu = passwordRequired
    ? personal.filter((item) => item.id === "account-security")
    : isAdmin
      ? [...personal, ...admin]
      : personal;
  const navigationPage = subscriptionPage(page) ? "subscriptions" : page;
  const current = menu.find((item) => item.id === navigationPage);
  const groups = navigationGroups.filter(
    (group) => !passwordRequired && (!group.adminOnly || isAdmin),
  );
  const currentGroup = groups.find((group) =>
    group.pages.includes(navigationPage),
  );
  const navButton = (id: Page) => {
    const item = menu.find((entry) => entry.id === id);
    if (!item) return null;
    return (
      <SidebarMenuItem key={id}>
        <SidebarMenuButton
          isActive={navigationPage === id}
          onClick={() => navigate(id)}
          aria-current={navigationPage === id ? "page" : undefined}
          className="nav-item h-9 data-[active=true]:font-medium"
        >
          {item.icon}
          <span>{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };
  const sidebar = (
    <Sidebar
      collapsible="none"
      id="workspace-navigation"
      className={narrow ? "h-full w-full bg-sidebar" : "h-full w-64 bg-sidebar"}
    >
      <SidebarHeader className="h-16 justify-center px-4">
        <a
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="#subscriptions"
          aria-label="RouteWeaver 首页"
          onClick={(event) => {
            event.preventDefault();
            navigate("subscriptions");
          }}
        >
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ThunderboltOutlined className="size-4" aria-hidden="true" />
          </div>
          <span className="font-semibold tracking-tight">RouteWeaver</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="工作空间导航" className="space-y-0">
          {groups.map((group) => (
            <SidebarGroup key={group.label} className="py-1">
              <SidebarNavigationGroup
                defaultOpen={Boolean(
                  group.discoverable || group.pages.includes(navigationPage),
                )}
                key={`${group.label}:${group.pages.includes(navigationPage)}`}
                label={group.label}
              >
                <SidebarMenu>{group.pages.map(navButton)}</SidebarMenu>
              </SidebarNavigationGroup>
            </SidebarGroup>
          ))}
          <SidebarGroup>
            <SidebarMenu>
              {navButton("inbox")}
              {navButton("account-security")}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="h-14">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">
                  {session.user.name.slice(0, 1)}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 text-left">
                <strong className="truncate text-sm font-medium">
                  {session.user.name}
                </strong>
                <small className="text-xs text-muted-foreground">
                  {isAdmin ? "管理员" : "个人账号"}
                </small>
              </span>
              <ChevronDown aria-hidden="true" className="size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56">
            <DropdownMenuItem onSelect={() => navigate("account-security")}>
              账号安全
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void logout()}>
              <LogoutOutlined aria-hidden="true" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
  return (
    <SidebarProvider
      className="app-shell min-h-svh"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const anchor =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>("a[href]")
            : null;
        const href = anchor?.getAttribute("href");
        if (
          !anchor ||
          !href?.startsWith("#") ||
          anchor.hasAttribute("download") ||
          (anchor.target && anchor.target !== "_self")
        )
          return;
        const route = href.slice(1).split("?")[0];
        if (
          ![
            "profiles",
            "outputs",
            ...personal.map((item) => item.id),
            ...admin.map((item) => item.id),
          ].includes(route)
        )
          return;
        event.preventDefault();
        workspaceHistory.current?.navigate(href);
      }}
    >
      <a
        href="#main"
        className="skip-link sr-only z-100 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳至主要内容
      </a>
      {narrow ? (
        <TaskSheet
          title="导航"
          side="left"
          open={mobileOpen}
          contentRef={mobilePanel}
          onOpenChange={(open) => {
            if (!open) closeMobileNavigation("trigger");
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onClosed={() => {
            if (mobileCloseIntent.current) {
              mobileCloseIntent.current.closed = true;
              finishMobileFocus();
            }
          }}
          size="sm"
          className="navigation-drawer w-72"
          bodyProps={{ className: "p-0" }}
        >
          {sidebar}
        </TaskSheet>
      ) : (
        <aside className="sticky top-0 h-svh shrink-0 border-r">
          {sidebar}
        </aside>
      )}
      <div className="main-shell flex min-w-0 flex-1 flex-col">
        <header
          aria-label="工作空间"
          className="topbar flex h-14 shrink-0 items-center border-b px-4 sm:px-6"
        >
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              ref={mobileMenuTrigger}
              className={narrow ? "mobile-menu" : "hidden"}
              aria-label="打开导航"
              aria-expanded={mobileOpen}
              aria-controls="workspace-navigation"
              leadingIcon={<MenuOutlined aria-hidden="true" />}
              onClick={() => {
                mobileCycle.current++;
                mobileCloseIntent.current = null;
                mobileOpenRef.current = true;
                setMobileOpen(true);
              }}
              variant="ghost"
            />
            {narrow ? (
              <span className="text-sm font-semibold tracking-tight">
                RouteWeaver
              </span>
            ) : (
              <span className="breadcrumb flex items-center gap-2 text-sm">
                <span className="breadcrumb-root hidden items-center gap-2 text-muted-foreground sm:inline-flex">
                  工作空间
                  <span aria-hidden="true">/</span>
                </span>
                {currentGroup && (
                  <span className="breadcrumb-scope hidden items-center gap-2 text-muted-foreground md:inline-flex">
                    {currentGroup.label}
                    <span aria-hidden="true">/</span>
                  </span>
                )}
                <strong className="font-medium">
                  {current?.label || (adminMode ? "受限页面" : "我的订阅")}
                </strong>
              </span>
            )}
          </div>
        </header>
        <main
          id="main"
          className="main-content w-full min-w-0 flex-1 space-y-6 p-4 outline-none sm:p-6"
          tabIndex={-1}
        >
          <ErrorNotice error={authError} />
          <WorkspaceHistoryContext.Provider value={workspaceHistory}>
            <SubscriptionContextProvider>
              <PageBoundary
                key={`${["subscriptions", "profiles", "outputs"].includes(page) ? "subscriptions" : page}:${discardGeneration}`}
              >
                <RouteContent page={page}>
                <Suspense
                  fallback={<PageSkeleton page={page} />}
                >
                  {page === "account-security" ? (
                    <AccountSecurityPage
                      session={session}
                      onSessionChanged={(next) => {
                        lifecycle.accept(next);
                        lifecycle.changed();
                      }}
                      onSignedOut={() => {
                        lifecycle.forget();
                      }}
                      mfaSettings={
                        isAdmin && !passwordRequired ? <AccountMFA /> : undefined
                      }
                    />
                  ) : adminMode ? (
                    isAdmin ? (
                      page === "notifications" ? (
                        <NotificationsAdminPage />
                      ) : page === "published-routes" ? (
                        <PublishedRoutesPage />
                      ) : page === "fleet" ? (
                        <FleetPage
                          pendingDeploymentId={
                            publicationRequests.pendingDeploymentId
                          }
                        />
                      ) : page === "servers" ? (
                        <ServersPage />
                      ) : page === "routes" ? (
                        <ServerRoutesPage
                          publicationRequests={publicationRequests}
                        />
                      ) : (
                        <AdminPage page={page} />
                      )
                    ) : (
                      <Notice tone="warning" title="需要管理员权限" />
                    )
                  ) : page === "inbox" ? (
                    <InboxPage />
                  ) : ["subscriptions", "profiles", "outputs"].includes(
                      page,
                    ) ? (
                    <SubscriptionsPage
                      navigate={navigate}
                      sourceDraft={
                        sourceProfileRequest.current?.scope === receiptScope
                          ? (sourceProfileEntry ?? undefined)
                          : undefined
                      }
                      onSourceDraftConsumed={consumeSourceProfileEntry}
                      view={
                        page === "profiles"
                          ? "profiles"
                          : page === "outputs"
                            ? "outputs"
                            : "overview"
                      }
                    />
                  ) : page === "sources" ? (
                    <SourcesPage
                      acceptanceScope={receiptScope}
                      acceptanceReceipts={
                        sourceReceipts.scope === receiptScope
                          ? sourceReceipts.values
                          : {}
                      }
                      onAccepted={retainSourceAcceptance}
                      onCreateProfile={createProfileFromSource}
                    />
                  ) : page === "collections" ? (
                    <CollectionsPage />
                  ) : page === "templates" ? (
                    <TemplatesPage admin={isAdmin} />
                  ) : page === "resources" ? (
                    <ResourcesPage />
                  ) : (
                    <SubscriptionsPage navigate={navigate} />
                  )}
                </Suspense>
                </RouteContent>
              </PageBoundary>
            </SubscriptionContextProvider>
          </WorkspaceHistoryContext.Provider>
        </main>
        <footer className="app-footer border-t px-4 py-4 sm:px-6 text-xs text-muted-foreground">
          RouteWeaver
        </footer>
      </div>
    </SidebarProvider>
  );
}
function Login({
  onSuccess,
  initialError,
}: {
  onSuccess: (s: Session) => void;
  initialError: Error | null;
}) {
  const [mode, setMode] = useState<"login" | "invite" | "admin">(
    new URLSearchParams(location.search).has("invite") ? "invite" : "login",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(initialError);
  const [form] = useForm();
  const submission = useRef(0);
  useEffect(() => {
    setBusy(false);
    return () => {
      submission.current++;
    };
  }, [mode]);
  const submit = async (values: Record<string, string>) => {
    const owner = ++submission.current;
    setBusy(true);
    setError(null);
    try {
      if (mode === "admin") {
        const state = await loginWithToken(values.token);
        onSuccess(state);
      } else {
        setToken("");
        const result = await post<Session>(
          mode === "invite" ? "/auth/accept-invite" : "/auth/login",
          values,
        );
        onSuccess(result);
      }
    } catch (e) {
      // Token-login cleanup belongs to its API attempt, not an old form.
      if (owner === submission.current) setError(e as Error);
    } finally {
      if (owner === submission.current) setBusy(false);
    }
  };
  return (
    <div className="login-page flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm">
        <div className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight">
            {mode === "invite"
              ? "加入工作空间"
              : mode === "admin"
                ? "管理员登录"
                : "登录 RouteWeaver"}
          </h1>
          {mode !== "login" && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {mode === "invite"
                ? "使用邀请加入，创建自己的账号。"
                : "使用平台管理员提供的令牌登录。"}
            </p>
          )}
          <ErrorNotice error={error} />
          <AppForm
            form={form}
            onFinish={submit}
            initialValues={{
              token: new URLSearchParams(location.search).get("invite") || "",
            }}
          >
            {mode === "admin" ? (
              <AppField
                name="token"
                label="管理员令牌"
                description="令牌仅保存在当前页面内存中。"
                rules={[{ required: true, message: "请输入管理员令牌" }]}
              >
                <PasswordInput revealLabel="管理员令牌" autoComplete="off" />
              </AppField>
            ) : (
              <>
                {mode === "invite" && (
                  <AppField
                    name="token"
                    label="邀请码"
                    rules={[{ required: true, message: "请输入邀请码" }]}
                  >
                    <PasswordInput revealLabel="邀请码" autoComplete="off" />
                  </AppField>
                )}
                <AppField
                  name="username"
                  label="账号"
                  rules={[{ required: true, message: "请输入账号" }]}
                >
                  <Input autoComplete="username" placeholder="你的账号" />
                </AppField>
                <AppField
                  name="password"
                  label="密码"
                  rules={[{ required: true, message: "请输入密码" }]}
                >
                  <PasswordInput
                    autoComplete={
                      mode === "invite" ? "new-password" : "current-password"
                    }
                  />
                </AppField>
                {mode === "login" && (
                  <details className="space-y-3 text-sm">
                    <summary>使用二次验证码</summary>
                    <AppField name="totp" label="验证码">
                      <Input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                      />
                    </AppField>
                  </details>
                )}
              </>
            )}
            <ActionButton
              type="submit"
              pending={busy}
              leadingIcon={<ArrowRightOutlined aria-hidden="true" />}
              variant="default"
              size="lg"
              className={"w-full " + ""}
            >
              {mode === "invite" ? "创建账号并继续" : "进入工作空间"}
            </ActionButton>
          </AppForm>
          <div className="flex flex-wrap justify-between gap-2">
            {mode === "login" ? (
              <>
                <ActionButton
                  onClick={() => {
                    setMode("invite");
                    setError(null);
                  }}
                  variant="link"
                >
                  我有邀请码
                </ActionButton>
                <ActionButton
                  onClick={() => {
                    setMode("admin");
                    setError(null);
                  }}
                  variant="ghost"
                >
                  管理员令牌登录
                </ActionButton>
              </>
            ) : (
              <ActionButton
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
                variant="link"
              >
                返回账号登录
              </ActionButton>
            )}
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>邀请制工作空间</p>
            <p>你的来源仅由你管理</p>
          </div>
        </div>
      </div>
    </div>
  );
}
