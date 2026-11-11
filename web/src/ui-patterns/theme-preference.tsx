import { useId } from "react";
import { useTheme } from "next-themes";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

export function ThemePreference() {
  const id = useId();
  const { theme = "system", setTheme } = useTheme();
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        外观
      </label>
      <NativeSelect
        id={id}
        value={theme}
        onChange={(event) => setTheme(event.target.value)}
      >
        <NativeSelectOption value="system">跟随系统</NativeSelectOption>
        <NativeSelectOption value="light">浅色</NativeSelectOption>
        <NativeSelectOption value="dark">深色</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}
