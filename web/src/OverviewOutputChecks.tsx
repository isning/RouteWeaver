import { useEffect, useState } from "react";
import type { Output } from "./types";
import {
  useOutputComparison,
  useOutputComparisonChecks,
} from "./output-comparison";
import { ActionButton } from "@/ui-patterns/actions";
export interface UncheckedOutput {
  id: string;
  revision: string;
}

function CheckRow({
  target,
  output,
  disabled,
  check,
  refresh,
  go,
}: {
  target: UncheckedOutput;
  output?: Output;
  disabled: boolean;
  check(output: Output, target: UncheckedOutput): void;
  refresh(): void;
  go(hash: string): void;
}) {
  // This hook only observes; mounting a row never starts a comparison.
  return output ? (
    <ObservedRow {...{ target, output, disabled, check, refresh, go }} />
  ) : (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="flex-1 text-sm text-muted-foreground">
        订阅信息尚未读取
      </span>
      <ActionButton
        size="sm"
        variant="outline"
        onClick={refresh}
        disabled={disabled}
      >
        重新读取
      </ActionButton>
    </li>
  );
}
function ObservedRow({
  target,
  output,
  disabled,
  check,
  refresh,
  go,
}: {
  target: UncheckedOutput;
  output: Output;
  disabled: boolean;
  check(output: Output, target: UncheckedOutput): void;
  refresh(): void;
  go(hash: string): void;
}) {
  const comparison = useOutputComparison(output);
  const matches =
    output.status === "published" && output.revision === target.revision;
  const actionable = matches && ["changed", "repair"].includes(comparison.kind);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium wrap-anywhere">{output.name}</p>
        <p role="status" className="text-xs text-muted-foreground">
          {matches ? comparison.text : "订阅已变化，请重新读取。"}
        </p>
      </div>
      {actionable && (
        <ActionButton
          size="sm"
          variant="outline"
          onClick={() =>
            go(`#subscriptions?output=${encodeURIComponent(output.id)}`)
          }
        >
          检查订阅
        </ActionButton>
      )}
      <ActionButton
        size="sm"
        variant={actionable ? "ghost" : "outline"}
        disabled={disabled}
        onClick={() => (matches ? check(output, target) : refresh())}
      >
        {!matches
          ? "重新读取"
          : comparison.kind === "checking"
            ? "正在检查"
            : comparison.kind === "unverified"
              ? "检查变更"
              : "重新检查"}
      </ActionButton>
    </li>
  );
}

/** Explicit, single-object checks reuse the publication/input-version fenced comparison flow. */
export function OverviewOutputChecks({
  targets,
  outputs,
  ready,
  readInventory,
  refresh,
  go,
}: {
  targets: UncheckedOutput[];
  outputs: Output[];
  ready: boolean;
  readInventory(): Promise<Output[]>;
  refresh(): void;
  go(hash: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string>();
  const bounded = [
    ...new Map(
      targets.slice(0, 32).map((target) => [target.id, target]),
    ).values(),
  ];
  const scope = JSON.stringify(
    bounded.map((target) => [target.id, target.revision]),
  );
  const checks = useOutputComparisonChecks(scope);
  useEffect(() => setError(undefined), [scope]);
  const check = (output: Output, target: UncheckedOutput) => {
    if (!ready || checks.running) return;
    setError(undefined);
    void checks
      .run([output], async () => {
        const fresh = await readInventory();
        const selected = fresh.find((item) => item.id === target.id);
        if (
          !selected ||
          selected.status !== "published" ||
          selected.revision !== target.revision
        )
          throw Error("订阅已变化，请重新读取后再检查。");
        return fresh;
      })
      .catch(() => setError("未能完成检查，请重新读取后再试。"));
  };
  if (!bounded.length) return null;
  return (
    <section
      aria-labelledby="overview-output-checks"
      className="rounded-xl border bg-card text-card-foreground"
    >
      <h2
        id="overview-output-checks"
        className="px-4 py-3 text-sm font-semibold"
      >
        订阅变更检查
      </h2>
      {error && (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y">
        {(expanded ? bounded : bounded.slice(0, 5)).map((target) => (
          <CheckRow
            key={`${target.id}:${target.revision}`}
            target={target}
            output={outputs.find((output) => output.id === target.id)}
            disabled={!ready || checks.running}
            check={check}
            refresh={refresh}
            go={go}
          />
        ))}
      </ul>
      {bounded.length > 5 && (
        <ActionButton
          size="sm"
          variant="ghost"
          className="m-2"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : `展开其余 ${bounded.length - 5} 份订阅`}
        </ActionButton>
      )}
    </section>
  );
}
