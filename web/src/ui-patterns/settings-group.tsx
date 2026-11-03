import type { ReactNode } from "react";

/** A settings group names the task outside its surface; rows own their padding. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-group @container/settings space-y-3">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold leading-6">{title}</h2>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div className="settings-surface rounded-lg border bg-card text-card-foreground">
        {children}
      </div>
    </div>
  );
}

/** Label, current value, explanation and action have distinct reading roles. */
export function SettingsRow({
  label,
  children,
  description,
  action,
}: {
  label: string;
  children: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="settings-row grid min-w-0 items-start gap-x-5 gap-y-1.5 px-4 py-4 @min-[40rem]/settings:grid-cols-[10rem_minmax(0,1fr)_auto] sm:px-5">
      <dt className="text-sm font-medium leading-6">{label}</dt>
      <dd className="min-w-0 text-sm leading-6 wrap-anywhere @min-[40rem]/settings:col-start-2 @min-[40rem]/settings:row-start-1">
        {children}
      </dd>
      {description && (
        <dd className="min-w-0 text-sm leading-relaxed text-muted-foreground @min-[40rem]/settings:col-start-2 @min-[40rem]/settings:row-start-2">
          {description}
        </dd>
      )}
      {action && (
        <dd className="mt-2 @min-[40rem]/settings:col-start-3 @min-[40rem]/settings:row-start-1 @min-[40rem]/settings:row-span-2 @min-[40rem]/settings:mt-0">
          {action}
        </dd>
      )}
    </div>
  );
}
