// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntitlementPolicyComparison } from "./EntitlementPolicyComparison";
import type { EntitlementPolicyResource } from "./access-policy-model";
import type { Entitlement } from "./types";

afterEach(cleanup);
const entitlement = (serviceId?: string): Entitlement => ({
  userId: "u1",
  serviceId,
  startsAt: "0001-01-01T00:00:00Z",
  paused: false,
  cycle: { mode: "none", day: 17, days: 23, timezone: "UTC" },
});
const resource = (
  after: Entitlement,
  before: Entitlement | null = null,
): EntitlementPolicyResource => ({
  target: { kind: "entitlement", id: "u1" },
  before: before ? { entitlement: before } : null,
  after: { entitlement: after },
});
const planRow = () =>
  within(
    screen
      .getByRole("rowheader", { name: "个人指定方案" })
      .closest("tr")!,
  );

it("names the personal plan in the main creation summary and keeps its exact ID in contextual details", async () => {
  const input = resource(entitlement("invite-unique-id"));
  const saved = JSON.stringify(input);
  render(
    <EntitlementPolicyComparison
      resource={input}
      services={[{ id: "invite-unique-id", name: "受邀体验服务" }]}
    />,
  );
  expect(planRow().getByText("受邀体验服务")).toBeTruthy();
  const identity = planRow().getByText("方案标识", { selector: "summary" });
  expect(identity.parentElement?.hasAttribute("open")).toBe(false);
  await userEvent.click(identity);
  expect(identity.parentElement?.hasAttribute("open")).toBe(true);
  expect(
    within(identity.parentElement!).getByText("invite-unique-id"),
  ).toBeTruthy();
  expect(JSON.stringify(input)).toBe(saved);
});

it("retains the changed row and distinct identities when the old and new plans share a name", async () => {
  const input = resource(entitlement("plan-b"), entitlement("plan-a"));
  const saved = JSON.stringify(input);
  render(
    <EntitlementPolicyComparison
      resource={input}
      services={[
        { id: "plan-a", name: "团队方案" },
        { id: "plan-b", name: "团队方案" },
      ]}
    />,
  );
  const cells = planRow().getAllByRole("cell");
  expect(cells).toHaveLength(2);
  for (const [index, id] of ["plan-a", "plan-b"].entries()) {
    expect(within(cells[index]).getByText("团队方案")).toBeTruthy();
    const identity = within(cells[index]).getByText("方案标识", {
      selector: "summary",
    });
    await userEvent.click(identity);
    expect(identity.parentElement?.hasAttribute("open")).toBe(true);
    expect(within(identity.parentElement!).getByText(id)).toBeTruthy();
  }
  expect(JSON.stringify(input)).toBe(saved);
});

it.each(
  [
    [],
    [{ id: "plan-a", name: "" }],
    [{ id: "plan-a", name: "   " }],
    [{ id: "different-id", name: "其他方案" }],
    [
      { id: "plan-a", name: "候选一" },
      { id: "plan-a", name: "候选二" },
    ],
  ].map((services) => ({ services })),
)(
  "shows unavailable name without claiming inheritance or guessing another plan: %j",
  ({ services }) => {
    render(
      <EntitlementPolicyComparison
        resource={resource(entitlement("plan-a"))}
        services={services}
      />,
    );
    expect(planRow().getByText("方案名称不可用")).toBeTruthy();
    expect(planRow().getByText("plan-a")).toBeTruthy();
    expect(planRow().queryByText("继承用户组方案")).toBeNull();
    expect(planRow().queryByText("其他方案")).toBeNull();
  },
);

it("keeps inherited personal settings separate from the effective service", () => {
  render(
    <EntitlementPolicyComparison
      resource={resource(entitlement())}
      services={[{ id: "group-plan", name: "用户组方案" }]}
    />,
  );
  expect(planRow().getByText("继承用户组方案")).toBeTruthy();
  expect(planRow().queryByText("用户组方案", { exact: true })).toBeNull();
  expect(planRow().queryByText("方案标识")).toBeNull();
});
