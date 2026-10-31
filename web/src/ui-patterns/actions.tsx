import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  type ReactElement,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** A task button keeps its target and accessible name stable while a request settles. */
export function ActionButton({
  pending,
  pendingLabel,
  keepFocusableWhilePending,
  leadingIcon,
  children,
  disabled,
  asChild,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  pending?: boolean;
  pendingLabel?: string;
  keepFocusableWhilePending?: boolean;
  leadingIcon?: ReactNode;
}) {
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{
      children?: ReactNode;
      href?: string;
      role?: string;
      tabIndex?: number;
    }>;
    const blockedLink = child.type === "a" && (disabled || pending);
    return (
      <Button
        {...props}
        className={cn("min-h-11 min-w-11", className)}
        asChild
        disabled={disabled || pending}
        aria-disabled={
          disabled || pending || props["aria-disabled"] || undefined
        }
        aria-busy={pending || undefined}
        onClick={(event) => {
          if (disabled || pending) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onClick?.(event);
        }}
      >
        {cloneElement(
          child,
          blockedLink
            ? {
                href: undefined,
                role: child.props.role ?? "link",
                tabIndex:
                  pending && keepFocusableWhilePending && !disabled ? 0 : -1,
              }
            : {},
          pending ? <Spinner aria-hidden="true" /> : leadingIcon,
          pending && pendingLabel ? pendingLabel : child.props.children,
        )}
      </Button>
    );
  }
  return (
    <Button
      type="button"
      {...props}
      className={cn("min-h-11 min-w-11", className)}
      disabled={disabled || (pending && !keepFocusableWhilePending)}
      aria-disabled={disabled || pending || props["aria-disabled"] || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (disabled || pending) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        props.onClick?.(event);
      }}
    >
      {pending ? <Spinner aria-hidden="true" /> : leadingIcon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
