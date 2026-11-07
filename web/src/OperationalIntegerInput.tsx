import { useRef, type ComponentProps } from "react";
import { NumericInput } from "@/ui-patterns/numeric-input";

// Operational leases, stages and client ports are bounded positive integers.
// Inspect decimal intent before Number can round a fraction onto an integer.
export function operationalInteger(raw: string | number, min: number, max: number): number | undefined {
  const text = String(raw);
  if (text.length > 256) return undefined;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || match[0] !== text) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] || "") + fraction).replace(/^0+/, "");
  if (!digits) return undefined;
  const significant = digits.replace(/0+$/, "");
  const scale = Number(match[4] || 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(scale) || scale < 0 || significant.length + scale > String(max).length)
    return undefined;
  const value = Number(significant) * 10 ** scale;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

// NumericInput owns spelling and stepping; callers own every raw edit and validate
// again at their request boundary. Do not send its rounded display value.
export function OperationalIntegerInput({ value, onInputText, min, max, ...props }: Omit<ComponentProps<typeof NumericInput>, "value" | "onValueChange" | "min" | "max"> & {
  value: string | number;
  min: number;
  max: number;
}) {
  const numeric = useRef<number | null>(null);
  if (value === "") numeric.current = null;
  else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value)) && Number.isFinite(Number(value)))
    numeric.current = Number(value);
  return <NumericInput {...props} value={numeric.current} min={min} max={max} precision={0}
    aria-invalid={props["aria-invalid"] || operationalInteger(value, min, max) === undefined || undefined}
    onInputText={onInputText} />;
}
