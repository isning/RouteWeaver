import { Component, lazy, Suspense, type ReactNode } from "react";
import type { ReactFlowProps } from "@xyflow/react";
import { LoadingState } from "./ui-patterns/loading-state";
const Canvas = lazy(() => import("./route-graph-canvas"));
class GraphBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert" className="p-6 text-sm text-muted-foreground">
        图形编辑暂时无法加载。请切换到顺序编辑继续。
      </p>
    ) : (
      this.props.children
    );
  }
}
export function RouteGraph(props: ReactFlowProps) {
  return (
    <GraphBoundary>
      <Suspense
        fallback={
          <LoadingState
            layout="cards"
            label="正在加载图形编辑"
            className="p-4"
          />
        }
      >
        <Canvas {...props} />
      </Suspense>
    </GraphBoundary>
  );
}
