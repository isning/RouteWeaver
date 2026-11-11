import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
export default function RouteGraphCanvas(props: ReactFlowProps) {
  return (
    <ReactFlow {...props}>
      <Background color="var(--border)" gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
