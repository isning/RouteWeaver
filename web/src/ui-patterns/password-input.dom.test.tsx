// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PasswordInput } from "./password-input";
afterEach(cleanup);
it.each(["邀请码", "管理员令牌", "订阅地址", "验证器设置密钥", "签名密钥", "用户 UUID"])("names the reveal action for %s without changing its value", (label) => {
 render(<PasswordInput aria-label={label} revealLabel={label} value="local-demo-only" readOnly/>);
 const input=screen.getByLabelText(label) as HTMLInputElement;
 fireEvent.click(screen.getByRole("button",{name:`显示${label}`}));
 expect(input.type).toBe("text");
 expect(input.value).toBe("local-demo-only");
 expect(input.hasAttribute("revealLabel")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:`隐藏${label}`}));
 expect(input.type).toBe("password");
});
it("reveals the same controlled secret without submitting or changing it", () => {
 render(<form onSubmit={event=>{event.preventDefault();throw Error("unexpected submit");}}><label htmlFor="secret">密钥</label><PasswordInput id="secret" value="exact secret" readOnly aria-describedby="help"/><span id="help">安全保存</span></form>);
 const input=screen.getByLabelText("密钥") as HTMLInputElement;
 expect(input.type).toBe("password");expect(input.getAttribute("aria-describedby")).toBe("help");
 fireEvent.click(screen.getByRole("button",{name:"显示密码"}));
 expect(input.type).toBe("text");expect(input.value).toBe("exact secret");expect(input.readOnly).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"隐藏密码"}));expect(input.type).toBe("password");
});
