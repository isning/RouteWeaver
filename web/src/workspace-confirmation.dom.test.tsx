// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { workspaceConfirmationState } from "../tests/ui-workspace-confirmation";
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function frame(heading: string) {
  document.body.innerHTML = `<div data-session-workspace aria-busy="false"><h1>${heading}</h1><div role="alert">Business warning</div></div>`;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
}
it.each(["概览", "我的订阅"])(
  "confirms the authenticated %s landing page, but not busy or hidden workspaces",
  (heading) => {
    frame(heading);
    expect(workspaceConfirmationState()).toBe("confirmed");
    const workspace = document.querySelector("[data-session-workspace]")!;
    workspace.setAttribute("aria-busy", "true");
    expect(workspaceConfirmationState()).toBe(false);
    workspace.setAttribute("aria-busy", "false");
    workspace.setAttribute("hidden", "");
    expect(workspaceConfirmationState()).toBe(false);
  },
);
it("still rejects unrelated headings and explicit session recovery errors", () => {
  frame("服务器");
  expect(workspaceConfirmationState()).toBe(false);
  document.body.insertAdjacentHTML(
    "beforeend",
    '<section role="region" aria-label="恢复登录"><p role="alert">Session failed</p></section>',
  );
  expect(workspaceConfirmationState()).toBe("session-error");
});
