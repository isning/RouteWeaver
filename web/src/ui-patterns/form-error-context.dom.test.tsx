// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppField, AppForm } from "./form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { revealFocusedDrawerControl } from "../drawer-control-visibility";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  {
    scenario: "clipped label",
    labelTop: 60,
    errorTop: 160,
    expected: 60,
    wholeTask: false,
    inputTop: 110,
  },
  {
    scenario: "already visible context",
    labelTop: 100,
    errorTop: 160,
    expected: 100,
    wholeTask: false,
    inputTop: 110,
  },
  {
    scenario: "oversized context",
    labelTop: 60,
    errorTop: 460,
    expected: 100,
    wholeTask: false,
    inputTop: 110,
  },
  {
    scenario: "whole-task scroller",
    labelTop: 60,
    errorTop: 160,
    expected: 60,
    wholeTask: true,
    inputTop: 110,
  },
  {
    scenario: "oversized context with clipped control",
    labelTop: 0,
    errorTop: 460,
    expected: 50,
    wholeTask: false,
    inputTop: 50,
  },
])(
  "keeps fitting invalid field context visible without unnecessary movement: $scenario",
  async ({ labelTop, errorTop, expected, wholeTask, inputTop }) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const finish = vi.fn();
    const { container } = render(
      <section
        role="dialog"
        aria-label="Edit"
        data-task-scroll={wholeTask ? "task" : "body"}
      >
        <div data-task-overlay-body>
          <AppForm
            submitErrorFocusOwner={{}}
            onFinish={finish}
            onFocusCapture={revealFocusedDrawerControl}
            initialValues={{ title: "Retained title" }}
          >
            <AppField name="title" label="Title">
              <Input />
            </AppField>
            <AppField
              name="body"
              label="Body"
              rules={[{ required: true, message: "Enter body" }]}
            >
              <Input />
            </AppField>
            <Button type="submit">Save</Button>
          </AppForm>
        </div>
      </section>,
    );
    const body = container.querySelector<HTMLElement>(
      wholeTask ? '[role="dialog"]' : "[data-task-overlay-body]",
    )!;
    const input = screen.getByRole("textbox", { name: "Body" });
    const label = screen.getByText("Body", { selector: "label" });
    // jsdom has no layout. Browser geometry is the only mocked boundary; real
    // validation, associated label/error DOM, focus ownership and reveal execute.
    const box = (top: number, height: number) =>
      new DOMRect(20, top, 240, height);
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const shift = 100 - body.scrollTop;
        if (this === body) return box(100, 300);
        if (this === input) return box(inputTop + shift, 40);
        if (this === label) return box(labelTop + shift, 20);
        if (this.id === `${input.id}-error`) return box(errorTop + shift, 20);
        return original.call(this);
      },
    );
    for (const [name, value] of Object.entries({
      clientTop: 0,
      clientLeft: 0,
      clientWidth: 240,
      clientHeight: 300,
    }))
      vi.spyOn(body, name as "clientTop", "get").mockReturnValue(value);
    body.scrollTop = 100;
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Enter body");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(
      (screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement)
        .value,
    ).toBe("Retained title");
    expect(finish).not.toHaveBeenCalled();
    expect(body.scrollTop).toBe(expected);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(body.scrollTop).toBe(expected);
  },
);

it.each(["newer interaction", "owner replacement"])(
  "does not reveal held validation after %s",
  async (mode) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let reject!: (reason: Error) => void;
    const held = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    function Task({ owner }: { owner: object }) {
      return (
        <section role="dialog" aria-label="Edit">
          <div data-task-overlay-body>
            <AppForm submitErrorFocusOwner={owner}>
              <AppField
                name="name"
                label="Name"
                rules={[{ validator: () => held }]}
              >
                <Input />
              </AppField>
              <Button type="submit">Save</Button>
            </AppForm>
          </div>
        </section>
      );
    }
    const rendered = render(<Task owner={{}} />);
    const body = rendered.container.querySelector<HTMLElement>(
      "[data-task-overlay-body]",
    )!;
    const input = screen.getByRole("textbox", { name: "Name" });
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 100, 300, 300),
    );
    vi.spyOn(body, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(body, "clientHeight", "get").mockReturnValue(300);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 50, 240, 40),
    );
    body.scrollTop = 100;
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    if (mode === "newer interaction") fireEvent.pointerDown(document.body);
    else rendered.rerender(<Task owner={{}} />);
    const focused = document.activeElement;
    await act(async () => reject(new Error("Invalid name")));
    await screen.findByText("Invalid name");
    expect(document.activeElement).toBe(focused);
    expect(body.scrollTop).toBe(100);
  },
);

it.each(["closed details", "sr-only", "clipped ancestor"])(
  "does not scroll to optional context hidden by %s",
  async (mode) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const note = <span id="optional-context">Additional context</span>;
    const { container } = render(
      <section role="dialog" aria-label="Edit">
        <div data-task-overlay-body>
          <AppForm submitErrorFocusOwner={{}}>
            <AppField
              name="name"
              label="Name"
              rules={[{ required: true, message: "Enter name" }]}
            >
              <Input aria-describedby="optional-context" />
            </AppField>
            {mode === "closed details" ? (
              <details>
                <summary>Details</summary>
                {note}
              </details>
            ) : (
              <div
                style={
                  mode === "sr-only"
                    ? { position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" }
                    : { overflow: "hidden" }
                }
              >
                {note}
              </div>
            )}
            <Button type="submit">Save</Button>
          </AppForm>
        </div>
      </section>,
    );
    const body = container.querySelector<HTMLElement>(
      "[data-task-overlay-body]",
    )!;
    const input = screen.getByRole("textbox", { name: "Name" });
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 100, 300, 300),
    );
    vi.spyOn(body, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(body, "clientHeight", "get").mockReturnValue(300);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 110, 240, 40),
    );
    // Closed/clipped content may retain a layout box without visible pixels.
    vi.spyOn(
      screen.getByText("Additional context"),
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(10, 60, 240, 20));
    body.scrollTop = 100;
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Enter name");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(body.scrollTop).toBe(100);
  },
);
