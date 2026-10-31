import type { TestContext } from "vitest";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Lifetime = Pick<TestContext, "signal" | "onTestFinished">;
type Target = () => Element | Promise<Element>;

// Own command continuation, not arbitrary promises or in-flight input events.
// Deliberately click/change-only: keyboard/type can retarget document focus.
export function ownedClickScenario(context: Lifetime) {
  let closed = false;
  context.onTestFinished(() => {
    closed = true;
  });
  function assertActive() {
    context.signal.throwIfAborted();
    if (closed) throw new Error("DOM scenario has finished");
  }
  function assertTarget(target: Element) {
    assertActive();
    if (!target.isConnected) throw new Error("DOM scenario target is detached");
  }
  return {
    // A synchronous checkpoint after an existing await; does not cancel it.
    assertActive,
    async click(resolveTarget: Target) {
      assertActive();
      const resolved = resolveTarget();
      const target = resolved instanceof Promise ? await resolved : resolved;
      assertTarget(target);
      await userEvent.click(target);
      assertActive();
    },
    change(
      resolveTarget: () => Element,
      init: Parameters<typeof fireEvent.change>[1],
    ) {
      assertActive();
      const target = resolveTarget();
      assertTarget(target);
      fireEvent.change(target, init);
      assertActive();
    },
  };
}
