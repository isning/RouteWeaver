// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NativeConfigPreview } from "./ui-patterns/native-config-preview";
afterEach(cleanup);
it("highlights configuration without altering text or executing markup", () => {
 const content='{\n  "dns": {},\n  "name": "<script>alert(1)</script>"\n}';
 const { container } = render(<NativeConfigPreview content={content} />);
 expect(screen.getByLabelText("配置预览").textContent).toBe(content);
 expect(container.querySelector("script")).toBeNull();
 expect(screen.queryByRole("switch")).toBeNull();
 expect(screen.queryByRole("note")).toBeNull();
});
