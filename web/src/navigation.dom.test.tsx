// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useState } from "react";
import {
  getNavigationWarning,
  hasNavigationWarning,
  hasUnsavedChanges,
  useUnsavedChanges,
} from "./navigation";

afterEach(cleanup);

it("registers committed dirty input before a native navigation can observe the pre-passive-effect window", () => {
  const observed: boolean[] = [];
  function Editor() {
    const [dirty, setDirty] = useState(false);
    useUnsavedChanges(dirty);
    // Browser history events can arrive after commit but before passive effects.
    // Observe that exact boundary rather than awaiting an effect-flushing helper.
    useLayoutEffect(() => {
      if (dirty) observed.push(hasUnsavedChanges());
    }, [dirty]);
    return <button onClick={() => setDirty(true)}>Edit draft</button>;
  }
  const view = render(
    <StrictMode>
      <Editor />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  expect(observed).toEqual([true]);
  expect(hasUnsavedChanges()).toBe(true);
  view.unmount();
  expect(hasUnsavedChanges()).toBe(false);
});

// Public hook contract: simultaneous mounted editors must disclose every loss.
it("combines unresolved operations and separate drafts and removes only the resolved owner", () => {
  function Owner({ active, warning }: { active: boolean; warning?: string }) {
    useUnsavedChanges(active, warning);
    return null;
  }
  function Workspace() {
    const [pending, setPending] = useState(true);
    const [description, setDescription] = useState("");
    return <>
      <Owner active warning="出口保存可能已完成；离开将丢失核对信息。" />
      <Owner active warning="出口保存可能已完成；离开将丢失核对信息。" />
      <Owner active={pending} warning="离开不会取消接入凭据操作。" />
      <Owner active />
      <button onClick={() => setPending(false)}>Resolve enrollment</button>
      <button onClick={() => setDescription(getNavigationWarning())}>Leave</button>
      <p role="status">{description}</p>
    </>;
  }
  const view = render(<StrictMode><Workspace /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  expect(screen.getByRole("status").textContent).toBe(
    "出口保存可能已完成；离开将丢失核对信息。 离开不会取消接入凭据操作。 当前编辑尚未保存。离开会放弃尚未保存的内容。",
  );
  fireEvent.click(screen.getByRole("button", { name: "Resolve enrollment" }));
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  expect(screen.getByRole("status").textContent).toBe(
    "出口保存可能已完成；离开将丢失核对信息。 当前编辑尚未保存。离开会放弃尚未保存的内容。",
  );
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  view.unmount();
  expect(hasUnsavedChanges()).toBe(false);
  expect(hasNavigationWarning()).toBe(false);
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});
