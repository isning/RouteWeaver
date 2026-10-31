import { useEffect, useRef, useState, type ComponentProps, type Key } from "react";
import { Input } from "@/components/ui/input";

type Props = Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange" | "onInput" | "type" | "min" | "max" | "step"> & {
  value?: number | null;
  onValueChange?: (value: number | null) => void;
  onInputText?: (text: string) => void;
  resetKey?: Key;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
};

/** Preserve incomplete numeric edits locally; never round or commit on blur. */
export function NumericInput({ resetKey, ...props }: Props) {
  return <NumericControl key={resetKey} {...props} />;
}
function NumericControl({ value, onValueChange, onInputText, min, max, step = 1, precision, onKeyDown, ...props }: Props) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const emitted = useRef<number | null | undefined>(undefined);
  const control = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (value !== emitted.current) setText(value == null ? "" : String(value));
  }, [value]);
  const numeric = text.trim() !== "" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : undefined;
  const invalid = text !== "" && (numeric === undefined || !Number.isFinite(numeric) || min !== undefined && numeric < min || max !== undefined && numeric > max || precision === 0 && !Number.isInteger(numeric));
  useEffect(() => { control.current?.setCustomValidity(invalid ? "请输入范围内的有效数值" : ""); }, [invalid]);
  const change = (raw: string) => {
    setText(raw);
    if (raw === "") { emitted.current = null; onValueChange?.(null); }
    else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw))) {
      emitted.current = Number(raw);
      onValueChange?.(Number(raw));
    }
    onInputText?.(raw);
  };
  return <Input {...props} ref={control} type="text" role="spinbutton" inputMode={precision === 0 ? "numeric" : "decimal"} value={text}
    aria-valuenow={Number.isFinite(numeric) ? numeric : undefined} aria-valuemin={min} aria-valuemax={max} aria-invalid={props["aria-invalid"] || invalid || undefined}
    onChange={event => change(event.target.value)} onKeyDown={event => {
      onKeyDown?.(event);
      if (props.readOnly || props.disabled || event.defaultPrevented || event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      let next = (numeric ?? 0) + (event.key === "ArrowUp" ? step : -step);
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      change(String(next));
    }} />;
}
