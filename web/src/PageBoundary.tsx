import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { Component, lazy, type ComponentType, type ReactNode } from "react";
import { hasUnsavedChanges } from "./navigation";
class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("Page resources could not be loaded", { cause });
  }
}
/** Tag only module failures, retaining the same recovery for every route loader. */
export async function loadPageModule<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new PageLoadError(error);
  }
}
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() => loadPageModule(load));
}

type Props = {
  children: ReactNode;
  reload?: () => void;
};
type State = {
  failed: boolean;
  loadFailed: boolean;
  hadUnsavedChanges: boolean;
};
const cleanState: State = {
  failed: false,
  loadFailed: false,
  hadUnsavedChanges: false,
};
/** A page can fail without taking the surrounding navigation down with it. */
export class PageBoundary extends Component<Props, State> {
  state = cleanState;
  static getDerivedStateFromError(error: unknown): State {
    // Read before failed descendants unmount and unregister their dirty state.
    return {
      failed: true,
      loadFailed: error instanceof PageLoadError,
      hadUnsavedChanges: hasUnsavedChanges(),
    };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <PageRecovery
        loadFailed={this.state.loadFailed}
        hadUnsavedChanges={this.state.hadUnsavedChanges}
        retry={() => this.setState(cleanState)}
        reload={this.props.reload || (() => window.location.reload())}
      />
    );
  }
}
function PageRecovery({
  loadFailed,
  hadUnsavedChanges,
  retry,
  reload,
}: {
  loadFailed: boolean;
  hadUnsavedChanges: boolean;
  retry: () => void;
  reload: () => void;
}) {
  const confirm = useConfirm();
  const recover = (action: () => void) => {
    if (hadUnsavedChanges || hasUnsavedChanges()) {
      confirm({
        title: "放弃未保存内容并重新打开？",
        description: "重新打开可能丢失尚未保存的内容。你也可以暂时留在这里。",
        confirmLabel: "放弃修改并继续",
        cancelLabel: "暂不操作",
        destructive: true,
        onConfirm: action,
      });
    } else action();
  };
  return (
    <section
      className="space-y-4 rounded-xl border bg-card p-6 text-card-foreground"
      role="alert"
      aria-labelledby="page-recovery-title"
    >
      <h2 id="page-recovery-title">
        {loadFailed ? "页面资源未能加载" : "这个页面暂时无法显示"}
      </h2>
      <p>
        {loadFailed
          ? "可能是网络中断或页面版本已更新。请检查连接后刷新工作空间，也可以先打开其他页面。"
          : "请重新打开这个页面，或通过导航切换到其他页面。"}
      </p>
      {hadUnsavedChanges && <p>页面出现异常，未保存的编辑可能无法恢复。</p>}
      <div className={"flex flex-wrap items-center gap-2"}>
        {!loadFailed && (
          <ActionButton onClick={() => recover(retry)} variant="default">
            重新打开页面
          </ActionButton>
        )}
        <ActionButton onClick={() => recover(reload)} variant="outline">
          刷新工作空间
        </ActionButton>
      </div>
    </section>
  );
}
