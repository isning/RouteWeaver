import { useEffect, useRef, useState, type AriaAttributes, type Key } from "react";
import { Input } from "@/components/ui/input";
export type ByteUnit = "GiB" | "Mbps";
const byteScale: Record<ByteUnit, number> = {
  GiB: 1024 ** 3,
  Mbps: 1_000_000 / 8,
};
/** Display human units; Form storage stays bytes (or bytes/second), never rounded. */
export function ByteQuantityInput({
  value,
  onChange,
  id,
  unit,
  disabled,
  onInput,
  inputResetKey,
  ...aria
}: Pick<AriaAttributes, "aria-labelledby" | "aria-describedby" | "aria-invalid" | "aria-required"> & {
  value?: number | null;
  onChange?: (value: number | null) => void;
  id?: string;
  unit: ByteUnit;
  disabled?: boolean;
  /** Public raw input; its ownership/settlement belongs to the caller. */
  onInput?: (text: string) => void;
  /** Explicitly discard only this control's unaccepted input, not Form values. */
  inputResetKey?: Key;
}) {
  return <ByteQuantityControl key={inputResetKey} {...{ value, onChange, id, unit, disabled, onInput }} {...aria} />;
}

function ByteQuantityControl({ value, onChange, id, unit, disabled, onInput, ...aria }: Pick<AriaAttributes, "aria-labelledby" | "aria-describedby" | "aria-invalid" | "aria-required"> & {
  value?: number | null;
  onChange?: (value: number | null) => void;
  id?: string;
  unit: ByteUnit;
  disabled?: boolean;
  onInput?: (text: string) => void;
}) {
  const scale = byteScale[unit];
  const [text, setText] = useState(value == null ? "" : String(value / scale));
  const emitted = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (value === emitted.current) return;
    setText(value == null ? "" : String(value / scale));
  }, [value, scale]);
  const update = (raw: string) => {
    setText(raw);
    if (raw === "") {
      emitted.current = null;
      onChange?.(null);
    } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      const amount = Number(raw);
      if (Number.isFinite(amount)) {
        emitted.current = amount * scale;
        onChange?.(amount * scale);
      }
    }
    onInput?.(raw);
  };
  return (
    <Input
      type="text"
      inputMode="decimal"
      role="spinbutton"
      id={id}
      {...aria}
      disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={Number.MAX_SAFE_INTEGER / scale}
      aria-valuenow={text.trim() && Number.isFinite(Number(text)) ? Number(text) : undefined}
      value={text}
      onChange={(event) => update(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const current = Number(text);
        if (!Number.isFinite(current)) return;
        update(String(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER / scale, current + (event.key === "ArrowUp" ? 1 : -1)))));
      }}
    />
  );
}
