// @vitest-environment jsdom
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import {
  createWorkspaceHistory,
  type WorkspaceHistory,
} from "./workspace-history";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";

afterEach(cleanup);
let complete: (() => void) | undefined;
function View() {
  const replace = useWorkspaceViewEntry();
  const [selection, setSelection] = useState("none");
  return (
    <section aria-label="Local view">
      <output>{selection}</output>
      <button
        onClick={() => {
          setSelection("one");
          replace("#published-routes?line=one");
        }}
      >
        Open one
      </button>
      <button
        onClick={() => {
          setSelection("two");
          replace("#published-routes?line=two");
        }}
      >
        Open two
      </button>
      <button
        onClick={() => {
          setSelection("none");
          replace("#published-routes");
        }}
      >
        Close detail
      </button>
      <button
        onClick={() => {
          void new Promise<void>((resolve) => {
            complete = resolve;
          }).then(() =>
            replace("#published-routes?line=late", () => setSelection("late")),
          );
        }}
      >
        Start delayed result
      </button>
    </section>
  );
}
function Workspace() {
  const controller = useRef<WorkspaceHistory | null>(null);
  const [route, setRoute] = useState(location.hash.split("?")[0]);
  const [active, setActive] = useState(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  useLayoutEffect(() => {
    const current = createWorkspaceHistory({
      isDirty: () => false,
      isActive: () => activeRef.current,
      confirm: () => {},
      accept: (hash) => setRoute(hash.split("?")[0]),
    });
    controller.current = current;
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, []);
  return (
    <WorkspaceHistoryContext.Provider value={controller}>
      <button onClick={() => controller.current?.navigate("#published-routes?scope=fresh")}>
        Navigate within page
      </button>
      <button onClick={() => controller.current?.navigate("#published-routes")}>
        Return within page
      </button>
      <button onClick={() => controller.current?.navigate("#sources")}>
        Leave page
      </button>
      <button
        onClick={() => {
          activeRef.current = false;
          controller.current?.suspend();
          setActive(false);
        }}
      >
        Pause session
      </button>
      <button
        onClick={() => {
          activeRef.current = true;
          controller.current?.resume();
          setActive(true);
        }}
      >
        Resume session
      </button>
      {route === "#published-routes" ? <View /> : <h1>Sources</h1>}
    </WorkspaceHistoryContext.Provider>
  );
}
it("a warm child mounted before its parent's controller safely replaces local views under StrictMode", async () => {
  history.replaceState(null, "", "#published-routes");
  render(
    <StrictMode>
      <Workspace />
    </StrictMode>,
  );
  const length = history.length;
  const position = history.state.routeweaverPosition;
  await userEvent.click(screen.getByRole("button", { name: "Open one" }));
  expect(location.hash).toBe("#published-routes?line=one");
  expect(history.state.routeweaverPosition).toBe(position);
  expect(screen.getByText("one", { selector: "output" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(location.hash).toBe("#published-routes");
  expect(history.length).toBe(length);
  expect(history.state.routeweaverEntry).toBeTruthy();
});
it("a delayed result cannot replace a newer local selection", async () => {
  history.replaceState(null, "", "#published-routes");
  render(<Workspace />);
  await userEvent.click(
    screen.getByRole("button", { name: "Start delayed result" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Open two" }));
  await act(async () => {
    complete?.();
  });
  expect(location.hash).toBe("#published-routes?line=two");
  expect(screen.getByText("two", { selector: "output" })).toBeTruthy();
});
it("an unmounted owner's delayed result cannot revive after Back returns to the same entry", async () => {
  history.replaceState(null, "", "#published-routes");
  render(<Workspace />);
  await userEvent.click(
    screen.getByRole("button", { name: "Start delayed result" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Leave page" }));
  await screen.findByRole("heading", { name: "Sources" });
  act(() => history.back());
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Local view" })).toBeTruthy(),
  );
  await act(async () => {
    complete?.();
  });
  expect(location.hash).toBe("#published-routes");
  expect(screen.getByText("none", { selector: "output" })).toBeTruthy();
});

it("same-account recovery rebinds current actions without reviving callbacks from before suspension", async () => {
  history.replaceState(null, "", "#published-routes");
  render(<Workspace />);
  await userEvent.click(screen.getByRole("button", { name: "Open one" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Start delayed result" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Pause session" }));
  await userEvent.click(screen.getByRole("button", { name: "Resume session" }));
  await act(async () => {
    complete?.();
  });
  expect(location.hash).toBe("#published-routes?line=one");
  expect(screen.getByText("one", { selector: "output" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open two" }));
  expect(location.hash).toBe("#published-routes?line=two");
  await userEvent.click(
    screen.getByRole("button", { name: "Start delayed result" }),
  );
  await act(async () => complete?.());
  expect(location.hash).toBe("#published-routes?line=late");
  expect(screen.getByText("late", { selector: "output" })).toBeTruthy();
});

it("an active originating view accepts its complete asynchronous result", async () => {
  history.replaceState(null, "", "#published-routes");
  render(<Workspace />);
  await userEvent.click(
    screen.getByRole("button", { name: "Start delayed result" }),
  );
  await act(async () => complete?.());
  expect(location.hash).toBe("#published-routes?line=late");
  expect(screen.getByText("late", { selector: "output" })).toBeTruthy();
});

it("a same-hash completion consumes its original lease once without creating history", () => {
  history.replaceState(null, "", "#published-routes?line=one");
  const controller = createWorkspaceHistory({
    isDirty: () => false,
    confirm: () => {},
    accept: () => {},
  });
  try {
    const length = history.length;
    const originalState = history.state;
    const finish = controller.bindView(location.hash);
    let completions = 0;
    expect(
      finish(location.hash, () => {
        completions++;
      }),
    ).toBe(true);
    expect(
      finish(location.hash, () => {
        completions++;
      }),
    ).toBe(false);
    expect(completions).toBe(1);
    expect(history.length).toBe(length);
    expect(history.state).toEqual(originalState);
  } finally {
    controller.dispose();
  }
});

it.each([false, true])("renews current actions after same-page navigation while rejecting old callbacks (return to original hash: %s)", async (returnToOriginal) => {
  history.replaceState(null, "", "#published-routes");
  render(<Workspace />);
  await userEvent.click(screen.getByRole("button", { name: "Start delayed result" }));
  const oldCompletion = complete;
  await userEvent.click(screen.getByRole("button", { name: "Navigate within page" }));
  expect(location.hash).toBe("#published-routes?scope=fresh");
  if (returnToOriginal)
    await userEvent.click(screen.getByRole("button", { name: "Return within page" }));
  const expectedHash = returnToOriginal ? "#published-routes" : "#published-routes?scope=fresh";
  expect(location.hash).toBe(expectedHash);
  await act(async () => oldCompletion?.());
  expect(location.hash).toBe(expectedHash);
  expect(screen.getByText("none", { selector: "output" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Start delayed result" }));
  await act(async () => complete?.());
  expect(location.hash).toBe("#published-routes?line=late");
  expect(screen.getByText("late", { selector: "output" })).toBeTruthy();
});
