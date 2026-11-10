// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmationProvider } from "./ui-patterns/confirmations";
import { InventoryEditor, type InventoryEditTask } from "./InventoryEditor";
import { AppField, AppForm } from "./ui-patterns/form";
import { Input } from "./components/ui/input";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each(["hosts", "core-instances", "managed-endpoints"] as const)(
  "recovers invalid %s submission from the external footer",
  async (kind) => {
    const finish = vi.fn();
    const entity: InventoryEditTask = { kind, id: "audit", value: null };
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ConfirmationProvider>
          <InventoryEditor
            entity={entity}
            inventory={{
              hosts: [],
              instances: [],
              endpoints: [],
              links: [],
              deployments: [],
            }}
            onClose={vi.fn()}
            onHostCreated={finish}
            onCoreCreated={finish}
            onEndpointSaved={finish}
          />
        </ConfirmationProvider>
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.form).toBeTruthy();
    expect(save.closest("form")).toBeNull();
    await userEvent.click(save);
    expect(
      (await within(dialog).findAllByRole("alert")).length,
    ).toBeGreaterThan(0);
    const firstLabel = {
      hosts: "服务器名称",
      "core-instances": "所属服务器",
      "managed-endpoints": "端点名称",
    }[kind];
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText(firstLabel),
    );
    expect(document.activeElement?.getAttribute("aria-invalid")).toBe("true");
    expect(save.form?.contains(document.activeElement)).toBe(true);
    expect(finish).not.toHaveBeenCalled();
  },
);
it("explicit submit does not move focus from an unrelated newer control", async () => {
  let reject!: (error: Error) => void;
  render(
    <>
      <AppForm id="audit-form">
        <AppField
          name="name"
          label="Name"
          rules={[
            {
              validator: () =>
                new Promise((_resolve, fail) => {
                  reject = fail;
                }),
            },
          ]}
        >
          <Input />
        </AppField>
      </AppForm>
      <button type="submit" form="audit-form">
        Save
      </button>
      <button>New task</button>
    </>,
  );
  await userEvent.click(screen.getByText("Save"));
  await userEvent.click(screen.getByText("New task"));
  reject(new Error("Required"));
  await screen.findByText("Required");
  expect(document.activeElement).toBe(screen.getByText("New task"));
});

const task = {};
function RequiredForm({
  owner = task,
  custom,
  hiddenFirst = false,
  disabledFirst = false,
}: {
  owner?: object | null;
  custom?: () => void;
  hiddenFirst?: boolean;
  disabledFirst?: boolean;
}) {
  return (
    <>
      <AppForm
        id="recovery-form"
        submitErrorFocusOwner={owner}
        onFinishFailed={custom}
      >
        <AppField
          name="first"
          label="First"
          hidden={hiddenFirst}
          rules={[{ required: true }]}
        >
          <Input disabled={disabledFirst} />
        </AppField>
        <AppField name="second" label="Second" rules={[{ required: true }]}>
          <Input />
        </AppField>
      </AppForm>
      <button form="recovery-form" type="submit">
        Save
      </button>
    </>
  );
}
it("recovers keyboard submission to the first visible invalid field", async () => {
  render(<RequiredForm />);
  screen.getByText("Save").focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("请填写First");
  expect(document.activeElement).toBe(screen.getByLabelText("First"));
});
it.each(["hidden", "disabled", "inert", "aria-disabled", "css-hidden"])(
  "skips a %s invalid field without changing its validation",
  async (mode) => {
    render(
      <RequiredForm
        hiddenFirst={mode === "hidden"}
        disabledFirst={mode === "disabled"}
      />,
    );
    const first = screen.getByLabelText("First");
    if (mode === "inert") first.parentElement!.setAttribute("inert", "");
    if (mode === "aria-disabled")
      first.parentElement!.setAttribute("aria-disabled", "true");
    if (mode === "css-hidden") first.parentElement!.style.display = "none";
    await userEvent.click(screen.getByText("Save"));
    await screen.findByText("请填写Second");
    expect(document.activeElement).toBe(screen.getByLabelText("Second"));
    expect(first.getAttribute("aria-invalid")).toBe("true");
  },
);
it("leaves custom failure recovery in control even when opted in", async () => {
  const custom = vi.fn(() => screen.getByLabelText("Second").focus());
  render(<RequiredForm custom={custom} />);
  await userEvent.click(screen.getByText("Save"));
  await screen.findByText("请填写First");
  expect(custom).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByLabelText("Second"));
});
it("does not change focus for forms without the explicit opt in", async () => {
  render(<RequiredForm owner={null} />);
  await userEvent.click(screen.getByText("Save"));
  await screen.findByText("请填写First");
  expect(document.activeElement).toBe(screen.getByText("Save"));
});

it.each([
  "new-focus",
  "away-and-back",
  "edit",
  "owner-change",
  "close",
  "unmount",
])("does not reclaim focus after %s during async validation", async (mode) => {
  let reject!: (error: Error) => void;
  const deferred = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const validator = () => deferred;
  function DeferredForm({ owner }: { owner: object | null }) {
    return (
      <>
        <AppForm id="delayed-form" submitErrorFocusOwner={owner}>
          <AppField name="name" label="Delayed" rules={[{ validator }]}>
            <Input />
          </AppField>
        </AppForm>
        <button form="delayed-form" type="submit">
          Save delayed
        </button>
        <button>New task</button>
      </>
    );
  }
  const view = render(<DeferredForm owner={task} />);
  const save = screen.getByText("Save delayed");
  await userEvent.click(save);
  let expected: Element | null = save;
  if (mode === "new-focus" || mode === "away-and-back") {
    await userEvent.click(screen.getByText("New task"));
    expected = screen.getByText("New task");
    if (mode === "away-and-back") {
      save.focus();
      expected = save;
    }
  }
  if (mode === "edit") {
    await userEvent.type(screen.getByLabelText("Delayed"), "changed");
    expected = screen.getByLabelText("Delayed");
  }
  if (mode === "owner-change") view.rerender(<DeferredForm owner={{}} />);
  if (mode === "close") view.rerender(<DeferredForm owner={null} />);
  if (mode === "unmount") {
    view.unmount();
    expected = document.body;
  }
  reject(new Error("Delayed invalid"));
  if (mode !== "unmount") await screen.findByText("Delayed invalid");
  else await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(expected);
});
it("recovers a delayed current validation when no newer interaction occurs", async () => {
  let reject!: (error: Error) => void;
  render(
    <>
      <AppForm id="async-form" submitErrorFocusOwner={task}>
        <AppField
          name="name"
          label="Async"
          rules={[
            {
              validator: () =>
                new Promise((_resolve, fail) => {
                  reject = fail;
                }),
            },
          ]}
        >
          <Input />
        </AppField>
      </AppForm>
      <button form="async-form" type="submit">
        Save async
      </button>
    </>,
  );
  await userEvent.click(screen.getByText("Save async"));
  reject(new Error("Async invalid"));
  await screen.findByText("Async invalid");
  expect(document.activeElement).toBe(screen.getByLabelText("Async"));
});

it("ignores superseded validation and recovers only the latest native submission", async () => {
  const rejections: Array<(error: Error) => void> = [];
  render(
    <>
      <AppForm id="overlap-form" submitErrorFocusOwner={task}>
        <AppField
          name="name"
          label="Overlap"
          rules={[
            {
              validator: () =>
                new Promise((_resolve, reject) => {
                  rejections.push(reject);
                }),
            },
          ]}
        >
          <Input />
        </AppField>
      </AppForm>
      <button form="overlap-form" type="submit">
        Save overlap
      </button>
    </>,
  );
  const save = screen.getByText("Save overlap");
  await userEvent.click(save);
  await userEvent.click(save);
  await act(async () => {
    rejections[0](new Error("Old invalid"));
  });
  expect(document.activeElement).toBe(save);
  await act(async () => {
    rejections[1](new Error("Current invalid"));
  });
  await screen.findByText("Current invalid");
  expect(document.activeElement).toBe(screen.getByLabelText("Overlap"));
});
it("does not move focus for ordinary field validation", async () => {
  render(<RequiredForm />);
  screen.getByText("Save").focus();
  fireEvent.change(screen.getByLabelText("First"), {
    target: { value: "temporary" },
  });
  fireEvent.change(screen.getByLabelText("First"), { target: { value: "" } });
  await screen.findByText("请填写First");
  expect(document.activeElement).toBe(screen.getByText("Save"));
});

it("recovers a native implicit submission with no submitter from an input", async () => {
  render(<RequiredForm />);
  const second = screen.getByLabelText("Second");
  second.focus();
  // Native submission seam: user-event cannot infer an external submit button.
  fireEvent.submit(second.closest("form")!);
  await screen.findByText("请填写First");
  expect(document.activeElement).toBe(screen.getByLabelText("First"));
});

it.each(["before validation settles", "after invalid save"])(
  "does not carry a submission into the same InventoryEditor entity reopened %s",
  async (timing) => {
    const writes = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unexpected write" }), {
          status: 500,
        }),
    );
    vi.stubGlobal("fetch", writes);
    const entity: InventoryEditTask = {
      kind: "hosts",
      id: "same-server-task",
      value: null,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const finish = vi.fn();
    const close = vi.fn();
    const viewFor = (current: InventoryEditTask | null) => (
      <QueryClientProvider client={client}>
        <ConfirmationProvider>
          <button>Inventory opener</button>
          <InventoryEditor
            entity={current}
            inventory={{
              hosts: [],
              instances: [],
              endpoints: [],
              links: [],
              deployments: [],
            }}
            onClose={close}
            onHostCreated={finish}
            onCoreCreated={finish}
            onEndpointSaved={finish}
          />
        </ConfirmationProvider>
      </QueryClientProvider>
    );
    const view = render(viewFor(entity));
    const first = await screen.findByRole("dialog", { name: "添加服务器" });
    const save = within(first).getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    save.focus();
    // Close and reopen at the owner seam before rc-form's asynchronous validation
    // settles. Reuse the exact entity object, rather than a replacement identity.
    if (timing === "before validation settles") {
      fireEvent.submit(save.form!);
    } else {
      await userEvent.click(save);
      await within(first).findByText("请填写服务器名称");
      await userEvent.click(
        within(first).getByRole("button", { name: "取消" }),
      );
      expect(close).toHaveBeenCalledOnce();
    }
    view.rerender(viewFor(null));
    view.rerender(viewFor(entity));
    const reopened = screen.getByRole("dialog", { name: "添加服务器" });
    const address = within(reopened).getByLabelText("服务器连接地址");
    address.focus();
    await act(async () => {});
    expect(document.activeElement).toBe(address);
    expect(within(reopened).queryByRole("alert")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();

    // The reopened task still owns its own next invalid submission.
    await userEvent.click(
      within(reopened).getByRole("button", { name: "保存" }),
    );
    await within(reopened).findByText("请填写服务器名称");
    expect(document.activeElement).toBe(
      within(reopened).getByLabelText("服务器名称"),
    );
    await userEvent.click(
      within(reopened).getByRole("button", { name: "取消" }),
    );
    expect(close).toHaveBeenCalledTimes(
      timing === "after invalid save" ? 2 : 1,
    );
    expect(finish).not.toHaveBeenCalled();
  },
);

it.each(["stale success", "overlapping new submit", "newer focus"])(
  "keeps valid InventoryEditor submission owned with %s",
  async (scenario) => {
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const entity: InventoryEditTask = {
      kind: "hosts",
      id: "valid-host",
      value: null,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const finish = vi.fn();
    const viewFor = (current: InventoryEditTask | null) => (
      <QueryClientProvider client={client}>
        <ConfirmationProvider>
          <InventoryEditor
            entity={current}
            inventory={{
              hosts: [],
              instances: [],
              endpoints: [],
              links: [],
              deployments: [],
            }}
            onClose={vi.fn()}
            onHostCreated={finish}
            onCoreCreated={vi.fn()}
            onEndpointSaved={vi.fn()}
          />
        </ConfirmationProvider>
      </QueryClientProvider>
    );
    const view = render(viewFor(entity));
    await screen.findByRole("dialog");
    await userEvent.type(screen.getByLabelText("服务器名称"), "Old name");
    await userEvent.type(
      screen.getByLabelText("服务器连接地址"),
      "old.example",
    );
    const oldSave = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    oldSave.focus();
    fireEvent.submit(oldSave.form!);
    if (scenario === "newer focus") {
      screen.getByLabelText("服务器连接地址").focus();
      await waitFor(() => expect(finish).toHaveBeenCalledOnce());
      expect(writes).toEqual([
        { id: "valid-host", name: "Old name", address: "old.example" },
      ]);
      return;
    }
    view.rerender(viewFor(null));
    view.rerender(viewFor(entity));
    if (scenario === "stale success") {
      await act(async () => {});
      expect(writes).toEqual([]);
      expect(finish).not.toHaveBeenCalled();
    }
    // Same-stack overlap is intentional here: do not let the older validation
    // consume the reopened task's newly authorized native submission.
    fireEvent.change(screen.getByLabelText("服务器名称"), {
      target: { value: "New name" },
    });
    fireEvent.change(screen.getByLabelText("服务器连接地址"), {
      target: { value: "new.example" },
    });
    const currentSave = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    currentSave.focus();
    fireEvent.submit(currentSave.form!);
    await waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(writes).toEqual([
      { id: "valid-host", name: "New name", address: "new.example" },
    ]);
  },
);
