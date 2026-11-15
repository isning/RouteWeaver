// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useActionTarget } from "./useActionTarget";
import { WORKSPACE_NAVIGATION_EVENT } from "./workspace-history";
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "#overview");
});
it("waits for owner inventory, consumes a valid target once, and ignores raw navigation", () => {
  history.replaceState(null, "", "#sources?source=s&review=1");
  const open = vi.fn();
  function Target({ ready }: { ready: boolean }) {
    useActionTarget(
      "sources",
      "source",
      [{ id: "s" }, { id: "other" }],
      ready,
      open,
    );
    return null;
  }
  const view = render(<Target ready={false} />);
  expect(open).not.toHaveBeenCalled();
  view.rerender(<Target ready />);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0][0]).toEqual({ id: "s" });
  view.rerender(<Target ready />);
  expect(open).toHaveBeenCalledTimes(1);
  act(() => {
    history.replaceState(null, "", "#sources?source=other");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(open).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
  });
  expect(open).toHaveBeenCalledTimes(2);
});
it("never opens an object outside the returned inventory", () => {
  history.replaceState(null, "", "#resources?resource=someone-elses");
  const open = vi.fn();
  function Target() {
    useActionTarget("resources", "resource", [{ id: "mine" }], true, open);
    return null;
  }
  render(<Target />);
  expect(open).not.toHaveBeenCalled();
});
