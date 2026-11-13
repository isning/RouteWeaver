// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { ServerConnectorConnectionDialog } from "./ServerConnectorConnectionDialog";
import type { ServerProgram } from "./types";
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture(): ServerProgram {
  return { instance: { id: "core", hostId: "host", adapterId: "routeweaver/xray", version: "26.10.31" }, listener: { id: "entry", name: "Entry", instanceId: "core", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } }, egress: [], rules: [], resources: [], defaultAction: { kind: "forward", ref: "exit" }, connectors: [{ id: "exit", connection: { protocol: "socks", host: "exit.example", port: 1080, username: "fixture", password: "synthetic-private-value" } }] };
}
it("keeps invalid raw port for correction and applies to the same connector without modifying identity or password", async () => {
  const user = userEvent.setup();
  const program = fixture();
  const apply = vi.fn((_program: ServerProgram) => true), close = vi.fn(), editing = vi.fn();
  render(<UIProviders><ServerConnectorConnectionDialog program={program} schemaVersion="1.0" connectorId="exit" onApply={apply} onClose={close} onEditingChange={editing} /></UIProviders>);
  expect(editing).toHaveBeenCalledWith(true);
  const port = screen.getByRole("spinbutton", { name: "端口" });
  await user.clear(port);
  await user.click(screen.getByRole("button", { name: "采用连接参数" }));
  expect(apply).not.toHaveBeenCalled();
  await user.type(port, "8443");
  await user.click(screen.getByRole("button", { name: "采用连接参数" }));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  const next = apply.mock.calls[0][0] as ServerProgram;
  expect(next.connectors![0]).toEqual({ id: "exit", connection: { ...program.connectors![0].connection, port: 8443 } });
  expect(program.connectors![0].connection.port).toBe(1080);
  expect(document.body.textContent).not.toContain("synthetic-private-value");
  expect(close).toHaveBeenCalledTimes(1);
});
it("refuses an apply after the source program has changed", async () => {
  const program = fixture();
  const props = { schemaVersion: "1.0", connectorId: "exit", onApply: vi.fn(() => true), onClose: vi.fn(), onEditingChange: vi.fn() };
  const view = render(<UIProviders><ServerConnectorConnectionDialog {...props} program={program} /></UIProviders>);
  view.rerender(<UIProviders><ServerConnectorConnectionDialog {...props} program={{ ...program }} /></UIProviders>);
  expect((screen.getByRole("button", { name: "采用连接参数" }) as HTMLButtonElement).disabled).toBe(true);
  expect(props.onApply).not.toHaveBeenCalled();
});
it("retains unknown REALITY metadata after switching modes and returning to REALITY", async () => {
  const user = userEvent.setup();
  const program = fixture();
  const reality = { publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shortId: "aa", extension: { retain: true } };
  program.connectors![0].connection = { protocol: "vless", host: "exit.example", port: 443, uuid: "00000000-0000-4000-8000-000000000001", tls: { enabled: true, serverName: "tls.example", fingerprint: "chrome", reality } };
  const apply = vi.fn((_program: ServerProgram) => true);
  render(<UIProviders><ServerConnectorConnectionDialog program={program} schemaVersion="1.0" connectorId="exit" onApply={apply} onClose={vi.fn()} onEditingChange={vi.fn()} /></UIProviders>);
  await user.click(screen.getByRole("radio", { name: "TLS" }));
  await user.click(screen.getByRole("radio", { name: "REALITY" }));
  const key = screen.getByRole("textbox", { name: "REALITY 公钥" });
  await user.clear(key);
  await user.type(key, reality.publicKey);
  const shortId = screen.getByRole("textbox", { name: "REALITY Short ID" });
  await user.clear(shortId);
  await user.type(shortId, "bb");
  await user.click(screen.getByRole("button", { name: "采用连接参数" }));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(apply.mock.calls[0][0].connectors![0].connection.tls?.reality).toEqual({ publicKey: reality.publicKey, shortId: "bb", extension: { retain: true } });
});

it.each(["hysteria2", "anytls"])("direct %s saves while chained selections remain disabled", async (protocol) => {
  const program = fixture();
  program.instance = { ...program.instance, adapterId: "routeweaver/sing-box", version: "1.14.4" };
  program.connectors![0].connection = { protocol, host: "hy2.example", port: 443, password: "synthetic", tls: { enabled: true, serverName: "hy2.example" } };
  const apply = vi.fn((_program: ServerProgram) => true);
  const view = render(<UIProviders><ServerConnectorConnectionDialog program={program} schemaVersion="1.0" connectorId="exit" onApply={apply} onClose={vi.fn()} onEditingChange={vi.fn()} /></UIProviders>);
  await userEvent.click(screen.getByRole("button", { name: "采用连接参数" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(apply.mock.calls[0][0].connectors![0].connection).toEqual(program.connectors![0].connection);
  view.unmount();
  const chained = fixture();
  chained.instance = program.instance;
  chained.connectors!.push({ id: "relay", connection: { protocol: "socks", host: "relay.example", port: 1080 } });
  chained.connectors![0].via = "relay";
  render(<UIProviders><ServerConnectorConnectionDialog program={chained} schemaVersion="1.0" connectorId="exit" onApply={vi.fn(() => true)} onClose={vi.fn()} onEditingChange={vi.fn()} /></UIProviders>);
  await userEvent.click(screen.getByLabelText("协议"));
  expect(screen.getByRole("option", { name: protocol === "hysteria2" ? /^Hysteria2$/ : /^AnyTLS$/ }).getAttribute("aria-disabled")).toBe("true");
});
