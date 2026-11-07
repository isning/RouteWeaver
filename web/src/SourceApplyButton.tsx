import { useLayoutEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ActionButton } from "@/ui-patterns/actions";
import { APIError, post } from "./api";
import { invalidateOutputInputs } from "./output-comparison";
import { useUnsavedChanges } from "./navigation";
import {
  sourceAcceptanceReceipt,
  type SourceAcceptanceReceipt,
} from "./SourceUpdateContinuation";
import type { Source, SourceApplicationResult } from "./types";

export interface SourceApplyRecovery {
  candidateId: string;
  sourceRevision?: string;
  conflict: boolean;
  error: Error;
}

/** One explicit application intent. Recovery never retries a possibly committed write. */
export function useSourceApplication({
  scope,
  onApplied,
  onRecover,
}: {
  scope?: string | null;
  onApplied: (source: Source, receipt: SourceAcceptanceReceipt) => void;
  onRecover: (source: Source, recovery: SourceApplyRecovery) => void;
}) {
  const client = useQueryClient();
  const alive = useRef(true);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  type Command = { pending: Source; scope?: string | null };
  const running = useRef<Command | null>(null);
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mutation = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    mutationFn: async ({ pending }: Command) => {
      const result = await post<SourceApplicationResult>(
        `/me/sources/${encodeURIComponent(pending.id)}/apply`,
        {
          candidateId: pending.candidate!.id,
          sourceRevision: pending.revision,
        },
      );
      if (
        result?.id !== pending.id ||
        !result.revision ||
        result.candidate ||
        !result.enabled ||
        !result.snapshot
      )
        throw new Error("应用结果需要核对，请先读取来源当前状态。");
      return {
        source: result,
        receipt: sourceAcceptanceReceipt(pending, result),
      };
    },
    onSuccess: (result, command) => {
      if (
        alive.current &&
        running.current === command &&
        command.scope === currentScope.current
      )
        onApplied(result.source, result.receipt);
    },
    onError: (error, command) => {
      const pending = command.pending;
      if (
        alive.current &&
        running.current === command &&
        command.scope === currentScope.current
      )
        onRecover(pending, {
          candidateId: pending.candidate!.id,
          sourceRevision: pending.revision,
          conflict: error instanceof APIError && error.status === 409,
          error,
        });
    },
    onSettled: (_data, _error, command) => {
      if (running.current === command) running.current = null;
      invalidateOutputInputs(client);
      for (const key of [
        "sources",
        "collections",
        "profiles",
        "outputs",
        "overview",
      ])
        client.invalidateQueries({ queryKey: [key] });
    },
  });
  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      running.current = null;
      mutation.reset();
    }
  }, [scope, mutation.reset]);
  const ownedPending = mutation.isPending && mutation.variables.scope === scope;
  useUnsavedChanges(ownedPending);
  return {
    pending: ownedPending,
    isRunning: () =>
      !!running.current && running.current.scope === currentScope.current,
    pendingId: ownedPending ? mutation.variables?.pending.id : undefined,
    apply(source: Source) {
      if (running.current || !source.candidate || !source.enabled) return;
      const command = { pending: source, scope: currentScope.current };
      running.current = command;
      mutation.mutate(command);
    },
  };
}

export function SourceApplyButton({
  source,
  application,
  disabled = false,
}: {
  source: Source;
  disabled?: boolean;
  application: ReturnType<typeof useSourceApplication>;
}) {
  return (
    <ActionButton
      aria-label={`应用更新 ${source.name}`}
      variant="outline"
      pending={application.pendingId === source.id}
      disabled={
        disabled || !source.enabled || !source.candidate || application.pending
      }
      onKeyDown={(event) => {
        if (event.repeat && (event.key === "Enter" || event.key === " "))
          event.preventDefault();
      }}
      onClick={(event) => {
        if (!disabled && event.detail <= 1) application.apply(source);
      }}
    >
      应用更新
    </ActionButton>
  );
}
