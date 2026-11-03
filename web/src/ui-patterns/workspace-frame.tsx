import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ContentKind = "settings" | "list";
type ContextKind = "navigation" | "data";

const contentWidth = { settings: "max-w-[52rem]", list: "max-w-[72rem]" };
const columns = {
  navigation: "@min-[54rem]/workspace:grid-cols-[minmax(0,1fr)_14rem]",
  data: "@min-[70rem]/workspace:grid-cols-[minmax(0,1fr)_22rem]",
};

/** Only the task's content is capped. The canvas and context pane remain fluid. */
function PageContent({
  kind,
  contained,
  children,
  className,
}: {
  kind: ContentKind;
  contained: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "workspace-content min-w-0",
        !contained && ["mx-auto w-full", contentWidth[kind]],
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
  contained = false,
  header,
  localNavigation,
  context,
  children,
}: {
  contentKind: ContentKind;
  contextKind: ContextKind;
  contained?: boolean;
  header: ReactNode;
  localNavigation?: ReactNode;
  context?: ReactNode;
  children: ReactNode;
}) {
  const hasContext = context != null;
  const navigation = contextKind === "navigation";
  const aside = (
    <aside
      hidden={!hasContext}
      aria-label={navigation ? "本页导航" : "平台服务概览"}
      className={cn(
        "workspace-context @container/rail min-w-0",
        contained
          ? "@min-[68rem]/workspace:col-start-2 @min-[68rem]/workspace:row-start-2"
          : [
              "border-t bg-muted/20 p-4 sm:p-6",
              navigation
                ? "@min-[54rem]/workspace:col-start-2 @min-[54rem]/workspace:row-start-1 @min-[54rem]/workspace:row-span-2 @min-[54rem]/workspace:border-t-0 @min-[54rem]/workspace:border-l"
                : "@min-[70rem]/workspace:col-start-2 @min-[70rem]/workspace:row-start-1 @min-[70rem]/workspace:row-span-2 @min-[70rem]/workspace:border-t-0 @min-[70rem]/workspace:border-l",
            ],
      )}
    >
      <div
        className={cn(
          "min-w-0",
          navigation &&
            !contained &&
            "@min-[54rem]/workspace:[@media(min-height:40rem)]:sticky @min-[54rem]/workspace:top-6",
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
          navigation
            ? "grid-rows-[auto_auto_1fr]"
            : "grid-rows-[auto_1fr_auto]",
          contained
            ? "@min-[68rem]/workspace:grid-rows-[auto_1fr]"
            : navigation
              ? "@min-[54rem]/workspace:grid-rows-[auto_1fr]"
              : "@min-[70rem]/workspace:grid-rows-[auto_1fr]",
          contained ? "gap-6" : "flex-1",
          hasContext &&
            (contained
              ? "@min-[68rem]/workspace:grid-cols-[minmax(0,1fr)_18rem]"
              : columns[contextKind]),
        )}
      >
        <div
          className={cn(
            "workspace-header min-w-0",
            !contained && "px-4 pt-6 pb-5 sm:px-6",
          )}
        >
          <PageContent kind={contentKind} contained={contained}>
            {header}
          </PageContent>
        </div>
        {navigation && aside}
        <div
          className={cn(
            "workspace-canvas min-w-0",
            !contained && "px-4 pb-8 sm:px-6",
            hasContext &&
              (contained
                ? "@min-[68rem]/workspace:col-start-1 @min-[68rem]/workspace:row-start-2"
                : navigation
                  ? "@min-[54rem]/workspace:col-start-1 @min-[54rem]/workspace:row-start-2"
                  : "@min-[70rem]/workspace:col-start-1 @min-[70rem]/workspace:row-start-2"),
          )}
        >
          <PageContent
            kind={contentKind}
            contained={contained}
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
