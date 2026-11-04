import { Children, Fragment, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Keep independent facts readable and wrap-safe without punctuation as layout. */
export function Metadata({
  children,
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1",
        className,
      )}
      {...props}
    >
      {Children.toArray(children).map((child, index) => (
        <Fragment key={index}>
          {index > 0 ? " " : null}
          {child}
        </Fragment>
      ))}
    </span>
  );
}

export function MetadataItem({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("min-w-0 wrap-anywhere", className)} {...props} />;
}
