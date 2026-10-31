// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ownedClickScenario } from "./owned-click-scenario";

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps active clicks and changes on the real UI", async (context) => {
  const clicked = vi.fn();
  const changed = vi.fn();
  render(
    <>
      <button onClick={clicked}>Save</button>
      <input aria-label="Name" onChange={changed} />
    </>,
  );
  const scenario = ownedClickScenario(context);
  scenario.assertActive();
  scenario.change(() => screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Route" },
  });
  await scenario.click(() => screen.getByRole("button", { name: "Save" }));
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("rejects before resolving any target after abort", async (context) => {
  const controller = new AbortController();
  const scenario = ownedClickScenario({
    signal: controller.signal,
    onTestFinished: context.onTestFinished,
  });
  const query = vi.fn(() => screen.getByRole("button", { name: "Save" }));
  controller.abort(new Error("old scenario timed out"));
  render(<button>Save</button>);
  await expect(scenario.click(query)).rejects.toThrow("old scenario timed out");
  expect(query).not.toHaveBeenCalled();
});

it("cannot click a replacement UI when an old target lookup resolves after abort", async (context) => {
  const controller = new AbortController();
  const scenario = ownedClickScenario({
    signal: controller.signal,
    onTestFinished: context.onTestFinished,
  });
  const target = deferred<Element>();
  const click = scenario.click(() => target.promise);
  const rejected = expect(click).rejects.toThrow("old scenario timed out");
  controller.abort(new Error("old scenario timed out"));
  const nextRequest = vi.fn();
  render(<button onClick={nextRequest}>Save</button>);
  target.resolve(screen.getByRole("button", { name: "Save" }));
  await rejected;
  expect(nextRequest).not.toHaveBeenCalled();
});

it("rejects a detached captured target rather than acquiring a replacement", async (context) => {
  const view = render(<button>Save</button>);
  const old = screen.getByRole("button", { name: "Save" });
  view.unmount();
  const nextRequest = vi.fn();
  render(<button onClick={nextRequest}>Save</button>);
  await expect(ownedClickScenario(context).click(() => old)).rejects.toThrow(
    "target is detached",
  );
  expect(nextRequest).not.toHaveBeenCalled();
});

it("rejects after a click settles if that click aborted its owner", async (context) => {
  const controller = new AbortController();
  const scenario = ownedClickScenario({
    signal: controller.signal,
    onTestFinished: context.onTestFinished,
  });
  const next = vi.fn();
  render(
    <button onClick={() => controller.abort(new Error("expired during click"))}>
      Save
    </button>,
  );
  await expect(
    scenario
      .click(() => screen.getByRole("button", { name: "Save" }))
      .then(next),
  ).rejects.toThrow("expired during click");
  expect(next).not.toHaveBeenCalled();
});

it("closes through the registered finish callback even without signal abort", async (context) => {
  let finish!: () => unknown;
  const scenario = ownedClickScenario({
    signal: context.signal,
    onTestFinished: (callback) => {
      finish = () => callback(context);
    },
  });
  finish();
  const query = vi.fn(() => screen.getByRole("button"));
  await expect(scenario.click(query)).rejects.toThrow("scenario has finished");
  expect(query).not.toHaveBeenCalled();
});

it("blocks a post-await fixture mutation after its owner aborts", async (context) => {
  const controller = new AbortController();
  const scenario = ownedClickScenario({
    signal: controller.signal,
    onTestFinished: context.onTestFinished,
  });
  const ready = deferred<void>();
  const replaceFixture = vi.fn();
  const continuation = (async () => {
    await ready.promise;
    scenario.assertActive();
    replaceFixture();
  })();
  const rejected = expect(continuation).rejects.toThrow(
    "expired before fixture replacement",
  );
  controller.abort(new Error("expired before fixture replacement"));
  ready.resolve(undefined);
  await rejected;
  expect(replaceFixture).not.toHaveBeenCalled();
});

it("blocks a post-await fixture mutation after its owner finishes without abort", async (context) => {
  let finish!: () => unknown;
  const scenario = ownedClickScenario({
    signal: context.signal,
    onTestFinished: (callback) => {
      finish = () => callback(context);
    },
  });
  const ready = deferred<void>();
  const replaceFixture = vi.fn();
  const continuation = (async () => {
    await ready.promise;
    scenario.assertActive();
    replaceFixture();
  })();
  const rejected = expect(continuation).rejects.toThrow(
    "scenario has finished",
  );
  finish();
  ready.resolve(undefined);
  await rejected;
  expect(replaceFixture).not.toHaveBeenCalled();
});
