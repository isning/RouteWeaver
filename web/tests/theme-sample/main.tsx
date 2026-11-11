import { createRoot } from "react-dom/client";
import { UIProviders } from "@/ui-patterns/providers";
import { ThemePreference } from "@/ui-patterns/theme-preference";
import RouteGraphCanvas from "@/route-graph-canvas";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import "../../src/shadcn.css";
createRoot(document.getElementById("root")!).render(
  <UIProviders>
    <main className="space-y-4 p-6">
      <ThemePreference />
      <section
        aria-label="Card"
        className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
      >
        <p>Route appearance</p>
        <Input aria-label="Route name" placeholder="Name" />
        <Button onClick={() => toast.success("Saved")}>Notify</Button>
        <div className="h-80">
          <RouteGraphCanvas
            defaultNodes={[
              { id: "one", position: { x: 0, y: 0 }, data: { label: "Entry" } },
              { id: "two", position: { x: 180, y: 160 }, data: { label: "Exit" } },
            ]}
            defaultEdges={[{ id: "sample-edge", source: "one", target: "two", ariaLabel: "Entry to Exit" }]}
            ariaLabelConfig={{
              "controls.zoomIn.ariaLabel": "Zoom in",
              "controls.zoomOut.ariaLabel": "Zoom out",
              "controls.fitView.ariaLabel": "Fit view",
            }}
            fitView
          />
        </div>
      </section>
    </main>
  </UIProviders>,
);
