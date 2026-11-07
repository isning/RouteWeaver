import { useCallback, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

/** Plain save acknowledgments belong to a page, not the next editing task.
 * Keep this owner mounted through its saved/detail view. Errors, undo actions
 * and other actionable notifications must continue to use their own notices.
 */
export function useSaveNotice(task: object | string | null | undefined) {
  const notice = useRef<string | number | null>(null);
  const mounted = useRef(false);
  const dismiss = useCallback(() => {
    if (notice.current === null) return;
    toast.dismiss(notice.current);
    notice.current = null;
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dismiss();
    };
  }, [dismiss]);
  useLayoutEffect(() => {
    // Closing after a successful save preserves its acknowledgment. Starting
    // another task retires it without touching any other notification's ID.
    if (task) dismiss();
  }, [task, dismiss]);
  return useCallback((message: string) => {
    if (!mounted.current) return;
    dismiss();
    notice.current = toast.success(message);
  }, [dismiss]);
}
