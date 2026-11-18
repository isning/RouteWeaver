import type { ComponentProps } from "react";
import { EmptyState } from "../components";

export function MaterialEmptyState(props: ComponentProps<typeof EmptyState>) {
  return <EmptyState {...props} />;
}
