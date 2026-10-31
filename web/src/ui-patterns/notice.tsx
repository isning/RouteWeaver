import type { ReactNode, ComponentProps } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertAction,
} from "@/components/ui/alert";
import { cn } from "@/lib/utils";

const icons = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
  ...props
}: Omit<ComponentProps<typeof Alert>, "title"> & {
  tone?: keyof typeof icons;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = icons[tone];
  return (
    <Alert
      {...props}
      variant={tone === "error" ? "destructive" : "default"}
      className={cn("min-w-0 has-data-[slot=alert-action]:pr-2.5", className)}
    >
      <Icon aria-hidden="true" />
      {title && <AlertTitle className="min-w-0 [overflow-wrap:anywhere]">{title}</AlertTitle>}
      {children && (
        <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">
          {children}
        </AlertDescription>
      )}
      {action && (
        <AlertAction className="static col-start-2 mt-3 flex flex-wrap items-center gap-2">
          {action}
        </AlertAction>
      )}
    </Alert>
  );
}
