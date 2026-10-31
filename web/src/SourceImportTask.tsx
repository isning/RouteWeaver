import { useLayoutEffect, useRef, useState } from "react";
import { SourceEditorDialog } from "./SourceEditorDialog";
import { SourceUpdateReview } from "./SourceUpdateReview";
import type { Source } from "./types";

export type SourceImportResult =
  { kind: "ready"; source: Source } | { kind: "deferred"; source?: Source };

/** Saved clean options can resume review, but must be read back before use. */
export function canResumeSourceReview(source?: Source) {
  return (
    !!source &&
    (!!source.candidate ||
      (source.enabled &&
        !!source.snapshot &&
        !source.lastError &&
        source.refreshStatus !== "failed" &&
        source.refreshStatus !== "review-required"))
  );
}

/** A source-only task. The caller owns its draft and decides how to reference
 * a ready source. Open this in the owning editor session, never reuse it across
 * different parent drafts. No parent save or publication happens here. */
export function SourceImportTask({
  open,
  ...props
}: {
  open: boolean;
  source?: Source;
  onFinish: (result: SourceImportResult) => void;
}) {
  return open ? <SourceImportSession {...props} /> : null;
}
function SourceImportSession({
  source: initial,
  onFinish,
}: {
  source?: Source;
  onFinish: (result: SourceImportResult) => void;
}) {
  const [source, setSource] = useState(initial);
  const [reviewing, setReviewing] = useState(canResumeSourceReview(initial));
  const phase = useRef(canResumeSourceReview(initial) ? "review" : "edit");
  const current = useRef(true);
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const finish = (result: SourceImportResult) => {
    if (!current.current || phase.current === "finished") return;
    phase.current = "finished";
    onFinish(result);
  };
  const saved = (result: Source) => {
    if (!current.current) return;
    setSource(result);
    if (result.candidate) {
      // A saved manual update is not a second mandatory import task.
      finish({ kind: "deferred", source: result });
    } else if (
      result.enabled &&
      result.snapshot &&
      !result.lastError &&
      result.refreshStatus !== "failed" &&
      result.refreshStatus !== "review-required"
    ) {
      finish({ kind: "ready", source: result });
    } else finish({ kind: "deferred", source: result });
  };
  return (
    <>
      <SourceEditorDialog
        open={!reviewing}
        source={initial}
        primaryActionText="导入来源"
        successFeedback="parent"
        onSaved={saved}
        onClose={(retained) => {
          // onSaved runs before onClose in the same stack. Its new review owns
          // the task now; the editor's completion must not dismiss that review.
          if (phase.current === "edit")
            finish({ kind: "deferred", source: retained || source });
        }}
      />
      <SourceUpdateReview
        source={reviewing ? source || null : null}
        onClose={(result) =>
          finish({ kind: "deferred", source: result || source })
        }
        onUseCurrent={(result) => finish({ kind: "ready", source: result })}
        onAccepted={(_receipt, result) => saved(result)}
        onRejected={(result) => finish({ kind: "deferred", source: result })}
      />
    </>
  );
}
