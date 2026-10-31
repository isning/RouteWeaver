import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

/** Explicit reveal control; the input retains its native form and accessibility props. */
export function PasswordInput({ className, disabled, revealLabel = "密码", ...props }: Omit<ComponentProps<typeof InputGroupInput>, "type"> & { revealLabel?: string }) {
 const [visible,setVisible]=useState(false);
 return <InputGroup className={className}>
  <InputGroupInput {...props} disabled={disabled} type={visible?"text":"password"}/>
  <InputGroupAddon align="inline-end"><InputGroupButton type="button" size="icon-xs" disabled={disabled} aria-label={`${visible?"隐藏":"显示"}${revealLabel}`} aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>{visible?<EyeOff aria-hidden="true"/>:<Eye aria-hidden="true"/>}</InputGroupButton></InputGroupAddon>
 </InputGroup>;
}
