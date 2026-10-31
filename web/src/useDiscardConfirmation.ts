import { useLayoutEffect, useRef, useState } from "react";
import {
  useConfirm,
  type ConfirmationHandle,
  type ConfirmationOptions,
} from "./ui-patterns/confirmations";

/** Nested confirmation returns focus before its owning editor is unmounted. */
export function useDiscardConfirmation(identity: string) {
  const requestConfirmation = useConfirm();
  const [confirming, setConfirming] = useState(false);
  const active = useRef(true);
  const owner = useRef({ identity });
  if (owner.current.identity !== identity) owner.current = { identity };
  const task = owner.current;
  const stillCurrent = () => active.current && owner.current === task;
  const current = useRef<ConfirmationHandle | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    setConfirming(false);
    return () => {
      active.current = false;
      const review = current.current;
      current.current = null;
      review?.close();
    };
  }, [identity]);
  const confirm = (
    options: Pick<
      ConfirmationOptions,
      "title" | "description" | "confirmLabel" | "cancelLabel" | "contentProps"
    >,
    discard: (stillCurrent: () => boolean) => void,
  ) => {
    if (!stillCurrent() || current.current) return;
    setConfirming(true);
    let confirmed = false;
    const review = requestConfirmation({
      ...options,
      destructive: true,
      onConfirm: () => {
        if (stillCurrent() && current.current === review) confirmed = true;
      },
      onCancel: () => {
        confirmed = false;
      },
      onClosed: () => {
        if (current.current !== review) return;
        current.current = null;
        setConfirming(false);
        if (confirmed && stillCurrent()) discard(stillCurrent);
      },
    });
    current.current = review;
  };
  return { confirm, confirming };
}
