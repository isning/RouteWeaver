import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ContextHeader } from "./page-layout";

import { contentWidth, type ContentKind } from "./content-width";
type ContextKind = "navigation" | "data";

const columns = {
  navigation: "@min-[56rem]/workspace:grid-cols-[minmax(0,1fr)_14rem]",
  data: "@min-[62rem]/workspace:grid-cols-[minmax(0,1fr)_20rem]",
};

/** Only the task's content is capped. The canvas and context pane remain fluid. */
function PageContent({
  kind,
  fluid = false,
  children,
  className,
}: {
  kind: ContentKind;
  fluid?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "workspace-content min-w-0",
        "mx-auto w-full", !fluid && contentWidth[kind],
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Opt-in page composition. The same owner/DOM survives contained alias views and
 * settings tab changes. Context never shares the centered content's max-width.
 * Breakout is centralized here and mirrors the shell's p-4/sm:p-6 contract.
 */
export function WorkspaceFrame({
  contentKind,
  contextKind,
  contextPosition = "side",
  contained = false,
  nestedContext,
  header,
  localNavigation,
  context,
  children,
}: {
  contentKind: ContentKind;
  contextKind: ContextKind;
  /** A full-width overview before the task, retaining the same context owner. */
  contextPosition?: "side" | "top";
  contained?: boolean;
  /** The child owns its own context grid; do not cap that whole grid. */
  nestedContext?: ContextKind;
  header: ReactNode;
  localNavigation?: ReactNode;
  context?: ReactNode;
  children: ReactNode;
}) {
  const hasContext = context != null;
  const navigation = contextKind === "navigation";
  const topContext = contextPosition === "top";
  const aside = (
    <aside
      hidden={!hasContext}
      aria-label={navigation ? "本页导航" : "平台服务概览"}
      className={cn(
        "workspace-context @container/rail min-w-0",
        topContext
          ? "col-start-1 row-start-2 px-4 pb-6 sm:px-6"
          : contained
          ? "@min-[62rem]/workspace:col-start-2 @min-[62rem]/workspace:row-start-2"
          : [
              "border-t bg-muted/20 p-4 sm:p-6",
              navigation
                ? "@min-[56rem]/workspace:col-start-2 @min-[56rem]/workspace:row-start-1 @min-[56rem]/workspace:row-span-2 @min-[56rem]/workspace:border-t-0 @min-[56rem]/workspace:border-l"
                : "@min-[62rem]/workspace:col-start-2 @min-[62rem]/workspace:row-start-1 @min-[62rem]/workspace:row-span-2 @min-[62rem]/workspace:border-t-0 @min-[62rem]/workspace:border-l",
            ],
      )}
    >
      <div
        className={cn(
          "min-w-0",
          topContext && ["mx-auto w-full", contentWidth[contentKind]],
          navigation &&
            !contained &&
            "@min-[56rem]/workspace:[@media(min-height:40rem)]:sticky @min-[56rem]/workspace:top-6",
        )}
      >
        {context}
      </div>
    </aside>
  );
  return (
    <div
      className={cn(
        "workspace-frame @container/workspace min-w-0",
        !contained &&
          "-mx-4 -my-4 flex min-h-[calc(100svh-3.5rem)] flex-col sm:-mx-6 sm:-my-6",
      )}
      data-content-kind={contentKind}
      data-presentation={contained ? "contained" : "workspace"}
      data-context-kind={contextKind}
      data-context-position={contextPosition}
    >
      {localNavigation && (
        <div
          className={cn(
            "workspace-local-navigation",
            contained && "mb-6",
            !contained && "border-b px-4 py-2 sm:px-6",
          )}
        >
          {localNavigation}
        </div>
      )}
      <div
        className={cn(
          "workspace-grid grid min-w-0",
          topContext
            ? "grid-rows-[auto_auto_1fr]"
            : navigation
            ? "grid-rows-[auto_auto_1fr]"
            : "grid-rows-[auto_1fr_auto]",
          !topContext && (contained
            ? "@min-[62rem]/workspace:grid-rows-[auto_1fr]"
            : navigation
              ? "@min-[56rem]/workspace:grid-rows-[auto_1fr]"
              : "@min-[62rem]/workspace:grid-rows-[auto_1fr]"),
          contained ? "gap-6" : "flex-1",
          hasContext && !topContext &&
            (contained
              ? "@min-[62rem]/workspace:grid-cols-[minmax(0,1fr)_20rem]"
              : columns[contextKind]),
        )}
      >
        <div
          className={cn(
            "workspace-header min-w-0",
            !contained && "px-4 pt-6 pb-5 sm:px-6",
          )}
        >
          <PageContent kind={contentKind} fluid={!!nestedContext}>
            {nestedContext ? <ContextHeader navigation={nestedContext === "navigation"} contentKind={contentKind}>{header}</ContextHeader> : header}
          </PageContent>
        </div>
        {navigation && aside}
        <div
          className={cn(
            "workspace-canvas min-w-0",
            !contained && "px-4 pb-8 sm:px-6",
            topContext && "col-start-1 row-start-3",
            hasContext && !topContext &&
              (contained
                ? "@min-[62rem]/workspace:col-start-1 @min-[62rem]/workspace:row-start-2"
                : navigation
                  ? "@min-[56rem]/workspace:col-start-1 @min-[56rem]/workspace:row-start-2"
                  : "@min-[62rem]/workspace:col-start-1 @min-[62rem]/workspace:row-start-2"),
          )}
        >
          <PageContent
            kind={contentKind}
            fluid={!!nestedContext}
            className="space-y-6"
          >
            {children}
          </PageContent>
        </div>
        {!navigation && aside}
      </div>
    </div>
  );
}
