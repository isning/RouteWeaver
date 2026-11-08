// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerConnectorEditor } from "./ServerConnectorEditor";
import { connectorInputError } from "./server-connector-editor";
import type { ServerProgram } from "./types";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture(): ServerProgram {
  return {
    instance: { id: "core", hostId: "host", adapterId: "routeweaver/xray", version: "26.10.31" },
    listener: { id: "entry", name: "Entry", instanceId: "core", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } },
    egress: [], rules: [], resources: [], defaultAction: { kind: "forward", ref: "exit" },
    connectors: [{ id: "exit", connection: { protocol: "socks", host: "exit.example", port: 1080, username: "fixture", password: "synthetic-private-value" } }],
  };
}
function Harness({ initial = fixture() }: { initial?: ServerProgram }) {
  const [program, setProgram] = useState(initial);
  return <>
    <ServerConnectorEditor program={program} schemaVersion="1.0" label="入口" onChange={setProgram} />
    <button disabled={!!connectorInputError(program, "1.0")}>保存草稿</button>
    <output aria-label="当前上游">{program.connectors![0].via || "无"}</output>
    <output aria-label="当前地址">{program.connectors![0].connection.host}</output>
  </>;
}
it("keeps incomplete addresses in the controlled draft, then allows correction without exposing credentials", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const address = screen.getByRole("textbox", { name: "入口 连接器 1 地址" });
  await user.clear(address);
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  expect(address).toHaveValue("");
  await user.type(address, "new.example");
  expect(screen.getByLabelText("当前地址")).toHaveTextContent("new.example");
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeEnabled();
  expect(document.body.textContent).not.toContain("synthetic-private-value");
  expect(document.querySelector('input[type="password"]')).toBeNull();
});
it("shows protected managed connectors without editable fields", () => {
  const initial = fixture();
  initial.instance.adapterId = "routeweaver/managed-xray";
  render(<Harness initial={initial} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText(/关联用户入口或托管计量/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("synthetic-private-value");
});

it("changes upstream through a user choice without changing credentials or accepting a cycle", async () => {
  const user = userEvent.setup();
  const initial = fixture();
  initial.connectors!.push({ id: "relay", connection: { protocol: "socks", host: "relay.example", port: 1080 } });
  render(<Harness initial={initial} />);
  await user.click(screen.getByRole("combobox", { name: "入口 连接器 1 上游连接器" }));
  await user.click(screen.getByRole("option", { name: "relay" }));
  expect(screen.getByLabelText("当前上游")).toHaveTextContent("relay");
  await user.click(screen.getByRole("combobox", { name: "入口 连接器 2 上游连接器" }));
  expect(screen.getByRole("option", { name: /^exit/ })).toHaveAttribute("aria-disabled", "true");
  expect(document.body.textContent).not.toContain("synthetic-private-value");
});
