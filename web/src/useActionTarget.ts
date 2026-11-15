import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WORKSPACE_NAVIGATION_EVENT } from "./workspace-history";

/** Consume an overview link once, only after the owner-scoped inventory is ready. */
export function useActionTarget<T extends { id: string }>(
  page: string,
  key: string,
  items: T[] | undefined,
  ready: boolean,
  open: (item: T, params: URLSearchParams) => void,
) {
  const [hash, setHash] = useState(() => location.hash);
  const consumed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const update = () => setHash(location.hash);
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, update);
    };
  }, []);
  useEffect(() => {
    if (!ready || !hash.startsWith(`#${page}?`) || consumed.current === hash)
      return;
    const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
    const id = params.get(key);
    if (!id) return;
    consumed.current = hash;
    // A missing or inaccessible object never opens another record or starts a mutation.
    const item = items?.find((item) => item.id === id);
    if (item) open(item, params);
    else toast.error("该项目已不存在或不可访问。");
  }, [hash, items, ready, page, key, open]);
}
