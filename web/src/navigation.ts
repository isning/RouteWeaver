import { useLayoutEffect, useId } from "react";
const dirtyEditors = new Set<string>();
export const hasUnsavedChanges = () => dirtyEditors.size > 0;
/** Keep transient editor state in memory only; prevent navigation from silently dropping it. */
export function useUnsavedChanges(dirty: boolean) {
  const id = useId();
  // Commit the guard before native history events can run. A passive effect
  // leaves a window where an input is visible but its editor is not protected.
  useLayoutEffect(() => {
    if (!dirty) return;
    dirtyEditors.add(id);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      dirtyEditors.delete(id);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, id]);
}
