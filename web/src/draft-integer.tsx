import { useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

/** Check decimal intent before binary floating point can erase a fractional tail. */
export function exactDraftInteger(raw: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (raw.length > 256) return undefined;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,3}))?$/.exec(raw);
  if (!match || match[0] !== raw) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  let digits = ((match[1] || "0") + fraction).replace(/^0+/, "") || "0";
  const shift = Number(match[4] || "0") - fraction.length;
  if (shift < 0) {
    const removed = -shift;
    if (removed >= digits.length || !/^0*$/.test(digits.slice(-removed))) return undefined;
    digits = digits.slice(0, -removed);
  } else {
    if (digits.length + shift > 16) return undefined;
    digits += "0".repeat(shift);
  }
  if (digits.length > 16) return undefined;
  const number = Number(digits);
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : undefined;
}

/** Task-owned raw text survives hidden fields and temporary editor unmounts. */
export function DraftIntegerInput({ value, raw, onInput, max, focusRequest = 0, onFocusHandled }: {
  value?: number;
  raw?: string;
  onInput: (raw: string) => void;
  max?: number;
  focusRequest?: number;
  onFocusHandled?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const text = raw ?? (value === undefined ? "" : String(value));
  const invalid = raw !== undefined && raw !== "" && exactDraftInteger(raw, max) === undefined;
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      input.current?.scrollIntoView?.({ block: "center" });
      input.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  return <Input ref={input} type="text" role="spinbutton" inputMode="numeric"
    value={text} aria-invalid={invalid || undefined} aria-valuemin={1} aria-valuemax={max}
    aria-valuenow={Number.isFinite(Number(text)) && text !== "" ? Number(text) : undefined}
    onFocus={() => { if (focusRequest) onFocusHandled?.(); }}
    onChange={(event) => onInput(event.target.value)}
    onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : 0;
      const next = Math.max(1, Math.min(max ?? Number.MAX_SAFE_INTEGER, numeric + (event.key === "ArrowUp" ? 1 : -1)));
      onInput(String(next));
    }} />;
}
