import { useLayoutEffect, useId } from "react";
const unsavedDraftWarning = "当前编辑尚未保存。离开会放弃尚未保存的内容。";
const dirtyEditors = new Map<string, string | undefined>();
/** Custom consequences coexist with ordinary unsaved drafts, never first-wins. */
export const getNavigationWarning = () =>
  [
    ...new Set(
      [...dirtyEditors.values()].map((warning) => warning || unsavedDraftWarning),
    ),
  ].join(" ");
/** Whether a registered owner has consequences beyond dropping an unsaved draft. */
export const hasNavigationWarning = () =>
  [...dirtyEditors.values()].some((warning) => !!warning);
export const hasUnsavedChanges = () => dirtyEditors.size > 0;
/** Keep transient editor state in memory only; prevent navigation from silently dropping it. */
export function useUnsavedChanges(dirty: boolean, warning?: string) {
  const id = useId();
  // Commit the guard before native history events can run. A passive effect
  // leaves a window where an input is visible but its editor is not protected.
  useLayoutEffect(() => {
    if (!dirty) return;
    dirtyEditors.set(id, warning);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      dirtyEditors.delete(id);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, id, warning]);
}
