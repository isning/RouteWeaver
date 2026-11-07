import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { exactDraftInteger } from "./draft-integer";

// Only these positive-integer forms use this adapter. Form state owns raw text;
// keyboard stepping is an explicit correction, never a blur-time conversion.
export function DiagnosticProviderInteger({
  value, onRawChange, max, onKeyDown, ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type" | "min" | "max" | "step"> & {
  value?: number | string;
  onRawChange?: (raw: string) => void;
  max: number;
}) {
  const text = value == null ? "" : String(value);
  const integer = exactDraftInteger(text, max);
  return <Input {...props} type="text" inputMode="numeric" role="spinbutton"
    value={text} min={1} max={max} step={1}
    aria-valuemin={1} aria-valuemax={max} aria-valuenow={integer}
    aria-invalid={props["aria-invalid"] || (text !== "" && integer === undefined) || undefined}
    onChange={(event) => onRawChange?.(event.target.value)}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (props.disabled || props.readOnly || event.defaultPrevented ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      onRawChange?.(stepInteger(text, event.key === "ArrowUp", max));
    }} />;
}

function stepInteger(raw: string, up: boolean, max: number): string {
  // Exact floor/ceil preserves even a fractional tail that Number would erase.
  // Bounds keep bigint parsing and powers small for untrusted pasted text.
  const match = raw.length <= 256
    ? /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,3}))?$/.exec(raw)
    : null;
  if (!match || match[0] !== raw) return "1";
  const fraction = match[3] ?? match[4] ?? "";
  const shift = Number(match[5] || 0) - fraction.length;
  let numerator = BigInt((match[2] || "0") + fraction);
  if (match[1] === "-") numerator = -numerator;
  const denominator = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const floor = quotient - (remainder < 0n ? 1n : 0n);
  const ceil = quotient + (remainder > 0n ? 1n : 0n);
  const next = up ? floor + 1n : ceil - 1n;
  return String(next < 1n ? 1n : next > BigInt(max) ? BigInt(max) : next);
}
