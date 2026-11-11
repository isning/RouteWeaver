import React from "react";
import { createRoot } from "react-dom/client";
import { Tabs, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollableTabsList } from "@/ui-patterns/scrollable-tabs-list";
import { CollectionPreview } from "@/CollectionPreview";
import { UIProviders } from "@/ui-patterns/providers";
import type { Source } from "@/types";
import "../../src/shadcn.css";

// Test-owned document served by existing Vite. No app route, API, substitute
// primitive CSS, focus injection, altered focus samples or theme samples.
const query = new URLSearchParams(location.search);
const collection = query.get("kind") === "collection";
const sources: Source[] = Array.from({length: 9}, (_, i) => ({
  id: `source-${i}`, name: `来源 ${i + 1} ${"完整连接来源身份".repeat(8)}`,
  enabled: true, kind: "text",
}));
const labels = Array.from({length: 24}, (_, i) =>
  `${["分流规则", "策略组", "检查与预览", "运行设置"][i % 4]} ${i + 1}`,
);
createRoot(document.getElementById("root")!).render(
  <UIProviders><main className="min-w-0 space-y-4 bg-background p-4 text-foreground">
    <h1 className="text-lg">Synthetic compact tabs</h1>
    <button type="button">Keyboard starting point</button>
    <section aria-label="Tab composition" className="min-w-0">
      {collection ? <CollectionPreview
        collection={{id: "synthetic", name: "Synthetic", sources: sources.map(source => ({sourceId: source.id, steps: []})), steps: []}}
        sources={sources}
        value={{endpoints: [], stages: sources.map(source => ({scope: "raw", sourceId: source.id, endpoints: []}))}}
      /> : <Tabs defaultValue="0" className="min-w-0">
        <ScrollableTabsList aria-label="配置内容">
          {labels.map((label, i) => <TabsTrigger key={i} value={String(i)}>{label}</TabsTrigger>)}
        </ScrollableTabsList>
        {labels.map((label, i) => <TabsContent key={i} value={String(i)}>{label}</TabsContent>)}
      </Tabs>}
    </section>
  </main></UIProviders>,
);
