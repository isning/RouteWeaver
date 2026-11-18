import type { ReactNode } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function SettingsGroup({title,description,children}:{title:string;description?:string;children:ReactNode}) {
 return <Card className="settings-group @container/settings min-w-0 gap-0 rounded-xl py-0 shadow-none">
  <CardHeader className="gap-1 px-5 py-5 sm:px-6"><h2 className="text-base font-semibold tracking-tight">{title}</h2>{description && <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{description}</p>}</CardHeader>
  <CardContent className="settings-surface min-w-0 px-0 pb-0">{children}</CardContent>
 </Card>;
}

/** A compact label/value row on desktop, stacked content with a trailing action on mobile. */
export function SettingsRow({label,children,description,action}:{label:string;children:ReactNode;description?:ReactNode;action?:ReactNode}) {
 return <div className="settings-row grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-5 py-4 sm:px-6 @min-[40rem]/settings:grid-cols-[10rem_minmax(0,1fr)_auto]">
  <dt className="col-start-1 row-start-1 text-sm text-muted-foreground">{label}</dt>
  <dd className="col-start-1 row-start-2 min-w-0 text-sm font-medium leading-6 wrap-anywhere @min-[40rem]/settings:col-start-2 @min-[40rem]/settings:row-start-1">{children}</dd>
  {description && <dd className="col-start-1 row-start-3 min-w-0 text-sm leading-relaxed text-muted-foreground @min-[40rem]/settings:col-start-2 @min-[40rem]/settings:row-start-2">{description}</dd>}
  {action && <dd className="col-start-2 row-start-1 row-span-3 self-center @min-[40rem]/settings:col-start-3 @min-[40rem]/settings:row-span-2">{action}</dd>}
 </div>;
}
