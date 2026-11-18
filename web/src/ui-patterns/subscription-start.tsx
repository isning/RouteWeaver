import { useId, useState } from "react";
import { ArrowRight, Link, Route } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ActionButton } from "./actions";

/** Chooses an existing task; subsequent steps belong to its real editor. */
export function SubscriptionStart({ onImport, onConfigure }: {
  onImport?: () => void;
  onConfigure: () => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(onImport ? "import" : "configure");
  const choices = [
    ...(onImport ? [{ value: "import", title: "导入已有代理", description: "使用代理连接或订阅链接。", icon: Link, action: onImport }] : []),
    { value: "configure", title: "选择可用连接", description: "从已有来源或平台线路开始配置。", icon: Route, action: onConfigure },
  ];
  return <section aria-label="创建首个订阅" className="overflow-hidden rounded-xl border bg-card text-left">
    <div className="border-b bg-muted/30 px-5 py-5 sm:px-8">
      <ol aria-label="创建订阅流程" className="grid grid-cols-3 gap-3 text-xs sm:text-sm">
        {["选择连接来源", "配置分流", "获取订阅"].map((title, index) => <li key={title} aria-current={index === 0 ? "step" : undefined} className={index === 0 ? "font-medium text-foreground" : "text-muted-foreground"}>
          <span aria-hidden="true" className={`mb-2 flex size-6 items-center justify-center rounded-full text-xs ${index === 0 ? "bg-primary text-primary-foreground" : "border bg-background"}`}>{index + 1}</span>{title}
        </li>)}
      </ol>
    </div>
    <div className="space-y-6 p-5 sm:p-8">
      <div className="space-y-2"><p className="text-xs font-medium text-muted-foreground">暂无订阅</p><h2 className="text-xl font-semibold tracking-tight">添加代理连接</h2><p className="text-sm text-muted-foreground">导入代理链接，或选择已有连接</p></div>
      <RadioGroup value={selected} onValueChange={setSelected} aria-label="连接来源" className="gap-3">
        {choices.map(({ value, title, description, icon: Icon }) => <Label key={value} htmlFor={`${id}-${value}`} className="flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 hover:bg-muted/50 motion-reduce:transition-none">
          <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 space-y-1"><span className="block text-sm font-medium">{title}</span><span className="block text-sm font-normal leading-relaxed text-muted-foreground">{description}</span></span>
          <RadioGroupItem id={`${id}-${value}`} value={value} />
        </Label>)}
      </RadioGroup>
      <div className="flex justify-end border-t pt-5"><ActionButton onClick={() => choices.find((choice) => choice.value === selected)?.action()}>继续<ArrowRight aria-hidden="true" className="size-4" /></ActionButton></div>
    </div>
  </section>;
}
