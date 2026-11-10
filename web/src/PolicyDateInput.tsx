import { useEffect, useId, useRef, useState, type AriaAttributes } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { zhCN } from "react-day-picker/locale/zh-CN";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isPolicyTimestamp } from "./policy-date-model";

type Props = Pick<AriaAttributes, "aria-labelledby" | "aria-describedby" | "aria-invalid" | "aria-required"> & {
  value?: string;
  onChange?: (value: string) => void;
  id?: string;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
};
const pad = (part: number) => String(part).padStart(2, "0");
// UTC fields carry fixed UTC+8 wall time. Browser-local Date setters can
// normalize a valid policy time through a local DST gap before it is confirmed.
function wallClock(instant: number) {
  return new Date(instant + 8 * 60 * 60 * 1000);
}
function asInstant(wall: Date) {
  return wall.getTime() - 8 * 60 * 60 * 1000;
}
function wallTime(date: Date) { return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`; }
function displayDate(value?: string) {
  if (!value || !isPolicyTimestamp(value)) return value || "";
  const date = wallClock(Date.parse(value));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${wallTime(date)}`;
}

/** A stored RFC3339 value is unchanged until the user confirms or clears it. */
export function PolicyDateInput({ value, onChange, allowClear = true, onOpenChange, onPendingChange, id, disabled, placeholder = "选择日期与时间", ...aria }: Props) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | undefined>();
  const [time, setTime] = useState("00:00:00");
  const trigger = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(true);
  const invalid = !!value && !isPolicyTimestamp(value);
  const changeOpen = (next: boolean) => {
    if (disabled && next) return;
    if (next) {
      restoreFocus.current = true;
      const nextDate = wallClock(value && !invalid ? Date.parse(value) : Date.now());
      setDraft(nextDate);
      setTime(wallTime(nextDate));
    }
    setOpen(next);
    onOpenChange?.(next);
    if (!next) onPendingChange?.(false);
  };
  const changeDraft = (date: Date | undefined, nextTime = time) => {
    if (disabled || !open || !date) return;
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(nextTime);
    const next = new Date(date);
    if (match) next.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3] || 0), draft?.getUTCMilliseconds() || 0);
    setDraft(next);
    onPendingChange?.(!match || !value || asInstant(next) !== Date.parse(value));
  };
  const timeValid = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time);
  const confirm = () => {
    if (disabled || !open || !draft || !timeValid) return;
    const [hour, minute, second = 0] = time.split(":").map(Number);
    const selected = new Date(draft);
    selected.setUTCHours(hour, minute, second);
    onPendingChange?.(false);
    const instant = asInstant(selected);
    onChange?.(value && instant === Date.parse(value) ? value : new Date(instant).toISOString());
    changeOpen(false);
  };
  useEffect(() => {
    if (disabled && open) {
      restoreFocus.current = false;
      changeOpen(false);
    }
  }, [disabled, open]);
  return (
    <div className="space-y-1.5">
      {invalid ? <Input id={inputId} {...aria} disabled={disabled} value={value} onChange={(event) => onChange?.(event.target.value)} /> : (
        <Popover open={open} onOpenChange={changeOpen}>
          <div className="flex items-center gap-2">
            <PopoverTrigger asChild>
              <Input type="text" ref={trigger} id={inputId} {...aria} readOnly disabled={disabled} value={displayDate(value)} placeholder={placeholder} aria-haspopup="dialog" aria-expanded={open} className="cursor-pointer" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); changeOpen(!open); } }} />
            </PopoverTrigger>
            {allowClear && value ? <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label="清除日期" onClick={() => { if (disabled) return; onPendingChange?.(false); onChange?.(""); }}><XIcon /></Button> : <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          </div>
          <PopoverContent align="start" collisionPadding={12} className="w-auto max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain p-0 [&>*]:shrink-0" aria-label="选择日期与时间" aria-hidden={!open || undefined} inert={!open} onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!restoreFocus.current || disabled || open) return;
            const active = document.activeElement;
            const closing = event.target;
            const parent = trigger.current?.closest('[role="dialog"], [role="alertdialog"]');
            // Closing motion does not own a newer field or task's focus.
            if (active && active !== document.body && active !== parent && active.isConnected && !(closing instanceof HTMLElement && closing.contains(active))) return;
            trigger.current?.focus();
          }}>
            <Calendar disabled={disabled || !open} timeZone="UTC" today={wallClock(Date.now())} mode="single" selected={draft} defaultMonth={draft} onSelect={(date) => changeDraft(date)} locale={zhCN} weekStartsOn={1} labels={{ labelNext: () => "下个月", labelPrevious: () => "上个月", labelDayButton: (day) => `${day.getUTCFullYear()}年${day.getUTCMonth() + 1}月${day.getUTCDate()}日` }} />
            <div className="space-y-3 border-t p-3">
              <div className="space-y-1.5"><Label htmlFor={`${inputId}-time`}>时间（UTC+8）</Label><Input id={`${inputId}-time`} type="time" step="1" value={time} disabled={disabled || !open} onChange={(event) => { if (disabled || !open) return; setTime(event.target.value); changeDraft(draft, event.target.value); }} /></div>
              <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={!open} onClick={() => changeOpen(false)}>取消</Button><Button type="button" disabled={disabled || !open || !draft || !timeValid} onClick={confirm}>确定</Button></div>
            </div>
          </PopoverContent>
        </Popover>
      )}
      <span className="text-xs text-muted-foreground">UTC+8</span>
    </div>
  );
}
