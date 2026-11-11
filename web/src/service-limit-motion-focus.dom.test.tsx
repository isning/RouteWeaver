// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
let owner: ReturnType<typeof ownedClickScenario>;
beforeEach(context => {
  owner = ownedClickScenario(context);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() { return {}; } });
function motionEnd(target: HTMLElement, name = "accordion-down") {
  // React uses the prefixed DOM event in jsdom, which lacks AnimationEvent.
  const event = new Event("AnimationEvent" in window ? "animationend" : "webkitAnimationEnd", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: name });
  fireEvent(target, event);
}
async function setup() {
  const service = { id: "motion-plan", name: "Motion plan", quotaBytes: 1073741824, routeIds: [], onlineIpLimit: 2,
    connectionLimit: 10, entryRateBps: 250000, cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" } };
  const fixture = serviceEditFixture(service, "motion-opened");
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) !== "/api/access-policy/edit-context/service/motion-plan" || (init?.method && init.method !== "GET"))
      throw new Error("Unexpected motion fixture request");
    reads.push("opening");
    return new Response(JSON.stringify(fixture.context()), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><UIProviders>
    <ServicePolicyEditor initial={service} users={[]} services={[service]} routes={[]} onClose={() => {}} />
  </UIProviders></QueryClientProvider>);
  const name = await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  const input = await screen.findByRole("spinbutton", { name: "每个入口限速（Mbps）" }) as HTMLInputElement;
  const content = input.closest<HTMLElement>('[data-slot="accordion-content"]')!;
  const body = input.closest<HTMLElement>("[data-task-overlay-body]")!;
  let scroll = 10, max = 20;
  // jsdom has no layout. Model the public clip and an opening rail that clamps
  // synchronous focus scrolling before its final capacity becomes available.
  Object.defineProperty(body, "scrollTop", { configurable: true, get: () => scroll, set: value => { scroll = Math.min(max, Math.max(0, value)); } });
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(rect(20, 100, 300, 400));
  for (const [key, value] of Object.entries({ clientLeft: 2, clientTop: 2, clientWidth: 296, clientHeight: 396 }))
    vi.spyOn(body, key as "clientLeft", "get").mockReturnValue(value);
  vi.spyOn(input, "getBoundingClientRect").mockImplementation(() => rect(50, 560 - scroll, 100, 38));
  input.style.setProperty("--tw-ring-shadow", "0 0 0 3px rgb(180,180,180)");
  const focus = vi.spyOn(input, "focus");
  input.focus({ preventScroll: true });
  owner.change(() => input, { target: { value: "-" } });
  return { ...view, input, content, body, name, focus, reads, completeLayout: () => { max = 200; } };
}

it("reveals the same fast-entered service field after its opening motion frees the rail without refocusing", async () => {
  const task = await setup();
  expect(task.body.scrollTop).toBe(20);
  expect(task.input.getBoundingClientRect().bottom).toBe(578);
  task.completeLayout();
  motionEnd(task.content);
  expect(task.body.scrollTop).toBe(103); // Ring bottom601 minus clip bottom498.
  expect(task.input.getBoundingClientRect().bottom).toBe(495);
  expect(document.activeElement).toBe(task.input);
  expect(task.input.value).toBe("-");
  expect(task.focus).toHaveBeenCalledTimes(1);
  expect(task.reads).toEqual(["opening"]);
  motionEnd(task.content);
  expect(task.body.scrollTop).toBe(103); // Repeated completion does not oscillate.
});

it("retains synchronous focus reveal when opening layout has no motion", async () => {
  const task = await setup();
  task.completeLayout();
  task.name.focus();
  task.input.focus({ preventScroll: true });
  expect(task.body.scrollTop).toBe(103);
  expect(task.input.value).toBe("-");
});

it.each(["newer-field", "cancel", "closed", "unmounted", "nested-animation", "foreign-animation", "hidden", "inert", "session-busy", "document-hidden", "disabled"] as const)(
  "does not recover the old field after %s takes ownership or invalidates completion", async reason => {
    const task = await setup();
    task.completeLayout();
    if (reason === "newer-field") task.name.focus();
    if (reason === "cancel") {
      await owner.click(() => screen.getByRole("button", { name: "取消" }));
      await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
    }
    if (reason === "closed") task.content.setAttribute("data-state", "closed");
    if (reason === "unmounted") task.unmount();
    if (reason === "hidden") task.content.hidden = true;
    if (reason === "inert") task.content.setAttribute("inert", "");
    if (reason === "session-busy") {
      task.body.setAttribute("data-session-workspace", "");
      task.body.setAttribute("aria-busy", "true");
    }
    if (reason === "document-hidden") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    if (reason === "disabled") task.input.disabled = true;
    const active = document.activeElement, before = task.body.scrollTop;
    motionEnd(reason === "nested-animation" ? task.input : task.content, reason === "foreign-animation" ? "spin" : "accordion-down");
    expect(task.body.scrollTop).toBe(before);
    expect(document.activeElement).toBe(active);
    expect(task.focus).toHaveBeenCalledTimes(1);
    expect(task.reads).toEqual(["opening"]);
  });

it("keeps inline ring clearance inside the service limits clip without opening its overflow", async () => {
  const task = await setup();
  expect(task.content.classList.contains("overflow-hidden")).toBe(true);
  expect(task.content.firstElementChild?.classList.contains("px-1")).toBe(true);
});
