import { NumericInput } from "@/ui-patterns/numeric-input";
import { Input } from "@/components/ui/input";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { useFormInstance, useWatch, AppField } from "@/ui-patterns/form";
import { useState, type Key } from "react";
import { ByteQuantityInput } from "./ByteQuantityInput";
import { isPolicyTimestamp } from "./policy-date-model";
const nonnegativeIntegerRule = (message: string) => ({
    validator: (_: unknown, value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
        ? Promise.resolve()
        : Promise.reject(new Error(message)),
});
export const wholeNumberRules = [
    nonnegativeIntegerRule("请输入安全范围内的非负整数"),
];
export const byteQuantityRules = [
    nonnegativeIntegerRule("请输入可精确换算为整数字节的非负数值，且不超过安全范围"),
];
const supportedCycleTimezone = (value: unknown) => value === undefined ||
    value === "" ||
    value === "UTC+8" ||
    value === "Asia/Shanghai";
const positiveIntegerRule = (maximum: number) => ({
    validator: (_: unknown, value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum
        ? Promise.resolve()
        : Promise.reject(new Error(`请输入 1–${maximum} 之间的整数`)),
});
type CycleNumericControl = {
    onInput?: (text: string) => void;
    resetKey?: Key;
};
export function CycleFields({ planDefaults = false, numericControls, modeDisabled }: {
    planDefaults?: boolean;
    numericControls?: {
        day?: CycleNumericControl;
        days?: CycleNumericControl;
    };
    modeDisabled?: boolean;
} = {}) {
    const form = useFormInstance(), watchedMode = useWatch(["cycle", "mode"], form), watchedTimezone = useWatch(["cycle", "timezone"], {
        form,
        preserve: true,
    });
    const mode = watchedMode === undefined
        ? form.getFieldValue(["cycle", "mode"])
        : watchedMode;
    const timezone = watchedTimezone === undefined
        ? form.getFieldValue(["cycle", "timezone"])
        : watchedTimezone;
    // Keep a deliberate repair input mounted after correction; valid retained
    // values (including zero/absent anchors) are not ordinary plan questions.
    const [repair] = useState(() => {
        const cycle = form.getFieldValue("cycle") || {};
        return {
            anchor: cycle.anchor !== undefined &&
                (typeof cycle.anchor !== "string" || !isPolicyTimestamp(cycle.anchor)),
            timezone: !supportedCycleTimezone(cycle.timezone),
        };
    });
    return (<div className="form-grid grid gap-5 sm:grid-cols-2">
      <AppField name={["cycle", "mode"]} label={planDefaults ? "默认重置规则" : "流量重置规则"} description={planDefaults
            ? !supportedCycleTimezone(timezone)
                ? "先修正周期时区；规则支持的时区为 UTC+8。"
                : mode === "monthly" || mode === "anniversary"
                    ? "每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。"
                    : "周期时区：UTC+8"
            : undefined} rules={[{ required: true }]} trigger="onValueChange">
        <ChoiceSelect disabled={modeDisabled} options={[
            { value: "monthly", label: "每月固定日" },
            { value: "anniversary", label: "按周期起点日每月重置" },
            { value: "fixed-days", label: "固定天数周期" },
            { value: "none", label: "不自动重置" },
        ]}/>
      </AppField>
      {mode === "monthly" && (<AppField name={["cycle", "day"]} label="每月几号" rules={[
                { required: true },
                ...(planDefaults ? [positiveIntegerRule(31)] : []),
            ]} trigger="onValueChange">
          <NumericInput key={numericControls?.day?.resetKey} onInputText={numericControls?.day?.onInput} min={1} max={31}/>
        </AppField>)}
      {mode === "fixed-days" && (<AppField name={["cycle", "days"]} label="每周期天数" rules={[
                { required: true },
                ...wholeNumberRules,
                ...(planDefaults ? [positiveIntegerRule(3660)] : []),
            ]} trigger="onValueChange">
          <NumericInput key={numericControls?.days?.resetKey} onInputText={numericControls?.days?.onInput} min={1} max={planDefaults ? 3660 : undefined}/>
        </AppField>)}
      {(!planDefaults || repair.anchor) && (<AppField name={["cycle", "anchor"]} label={planDefaults ? "修正周期起点" : "周期起点"} description={planDefaults
                ? "原有时间格式无效，请明确修正；不会自动替换为当前时间。"
                : undefined} rules={planDefaults
                ? [{
                        validator: (_: unknown, value: unknown) => typeof value === "string" && isPolicyTimestamp(value)
                            ? Promise.resolve()
                            : Promise.reject(new Error("请输入有效的完整时间并包含时区，例如 2026-10-25T08:00:00+08:00")),
                    }]
                : [{ required: true }]}>
          <Input placeholder="2026-10-19T00:00:00+08:00"/>
        </AppField>)}
      {!planDefaults && (<AppField name={["cycle", "timezone"]} label="周期时区" trigger="onValueChange">
          <ChoiceSelect options={[{ value: "UTC+8", label: "UTC+8" }]}/>
        </AppField>)}
      {planDefaults && repair.timezone && (<AppField name={["cycle", "timezone"]} label="修正周期时区" description="原有时区不受支持。请输入 UTC+8 或 Asia/Shanghai；留空使用 UTC+8。" rules={[{
                    validator: (_: unknown, value: unknown) => supportedCycleTimezone(value)
                        ? Promise.resolve()
                        : Promise.reject(new Error("周期时区仅支持 UTC+8 或 Asia/Shanghai")),
                }]}>
          <Input />
        </AppField>)}
    </div>);
}
type CountInput = {
    onInput: (text: string) => void;
    valid: () => boolean;
    resetKey?: Key;
    initialInputText?: string;
};
const countRules = (input?: CountInput) => input ? [{
    validator: () => input.valid() ? Promise.resolve() : Promise.reject(new Error("请输入安全范围内的非负整数")),
}] : wholeNumberRules;
export function LimitFields({ rateInput, countInputs }: {
    countInputs?: Partial<Record<"onlineIpLimit" | "connectionLimit", CountInput>>;
    rateInput?: {
        onInput: (text: string) => void;
        valid: () => boolean;
        resetKey?: Key;
        initialInputText?: string;
    };
} = {}) {
    return (<>
      <div className="form-grid grid gap-5 sm:grid-cols-2">
        <AppField name="onlineIpLimit" label="账号在线 IP 数上限" description="跨入口合并去重，不按设备计数。" rules={countRules(countInputs?.onlineIpLimit)} trigger="onValueChange" validateTrigger={countInputs?.onlineIpLimit ? "onInputText" : undefined}>
          <NumericInput min={0} max={Number.MAX_SAFE_INTEGER} onInputText={countInputs?.onlineIpLimit?.onInput} resetKey={countInputs?.onlineIpLimit?.resetKey} initialInputText={countInputs?.onlineIpLimit?.initialInputText}/>
        </AppField>
        <AppField name="connectionLimit" label="账号并发逻辑流数上限" description="跨入口累加；同一 IP 的多个流分别计数。" rules={countRules(countInputs?.connectionLimit)} trigger="onValueChange" validateTrigger={countInputs?.connectionLimit ? "onInputText" : undefined}>
          <NumericInput min={0} max={Number.MAX_SAFE_INTEGER} onInputText={countInputs?.connectionLimit?.onInput} resetKey={countInputs?.connectionLimit?.resetKey} initialInputText={countInputs?.connectionLimit?.initialInputText}/>
        </AppField>
        <AppField name="entryRateBps" label="每个入口限速（Mbps）" description="按账号 × 逻辑入口计算，上下行与多个流共用。" rules={rateInput ? [{
            validator: () => rateInput.valid() ? Promise.resolve() : Promise.reject(new Error("请输入非负 Mbps 数值，需为 0.000008 Mbps 的整数倍且不超过上限")),
        }] : byteQuantityRules} validateTrigger={rateInput ? "onInput" : undefined}>
          <ByteQuantityInput unit="Mbps" onInput={rateInput?.onInput} inputResetKey={rateInput?.resetKey} initialInputText={rateInput?.initialInputText}/>
        </AppField>
      </div>
      <p className="muted text-sm text-muted-foreground">
        0 为不限制。这些均不是设备数量限制。
      </p>
    </>);
}
