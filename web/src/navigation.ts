import { useLayoutEffect, useId, useRef } from "react";
const unsavedDraftWarning = "当前编辑尚未保存。离开会放弃尚未保存的内容。";
const dirtyEditors = new Map<string, { warning?: string; onReview(): void }>();
/** Retire task continuations before an independent navigation decision opens. */
export const beginNavigationReview = () => {
  for (const editor of [...dirtyEditors.values()]) editor.onReview();
};
/** Custom consequences coexist with ordinary unsaved drafts, never first-wins. */
export const getNavigationWarning = () =>
  [
    ...new Set(
      [...dirtyEditors.values()].map(
        ({ warning }) => warning || unsavedDraftWarning,
      ),
    ),
  ].join(" ");
/** Whether a registered owner has consequences beyond dropping an unsaved draft. */
export const hasNavigationWarning = () =>
  [...dirtyEditors.values()].some(({ warning }) => !!warning);
export const hasUnsavedChanges = () => dirtyEditors.size > 0;
/** Keep transient editor state in memory only; prevent navigation from silently dropping it. */
export function useUnsavedChanges(
  dirty: boolean,
  warning?: string,
  onReview?: () => void,
) {
  const id = useId();
  const review = useRef(onReview);
  useLayoutEffect(() => {
    review.current = onReview;
  });
  // Commit the guard before native history events can run. A passive effect
  // leaves a window where an input is visible but its editor is not protected.
  useLayoutEffect(() => {
    if (!dirty) return;
    dirtyEditors.set(id, { warning, onReview: () => review.current?.() });
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
