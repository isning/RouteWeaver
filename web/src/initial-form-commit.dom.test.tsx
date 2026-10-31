// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AppForm } from "./ui-patterns/form";
import { ConnectionFields } from "./ConnectionFields";
import { CycleFields } from "./PolicyFields";

// Capture the committed task before passive subscriptions synchronize. This
// observes visible controls, not rc-form state or implementation callbacks.
function FirstCommittedTask({
  children,
  observe,
}: {
  children: ReactNode;
  observe: (task: HTMLElement) => void;
}) {
  const task = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    observe(task.current!);
  }, [observe]);
  return <div ref={task}>{children}</div>;
}
afterEach(cleanup);

it("opens a stored TLS connection with its authentication and security controls already present", () => {
  let initial:
    | { uuid: string | null; sni: string | null; security: string | null }
    | undefined;
  render(
    <FirstCommittedTask
      observe={(task) => {
        const form = within(task);
        initial = {
          uuid:
            (form.queryByLabelText("用户 UUID") as HTMLInputElement | null)
              ?.value ?? null,
          sni:
            (
              form.queryByLabelText(
                "服务器名称（SNI）",
              ) as HTMLInputElement | null
            )?.value ?? null,
          security:
            form
              .queryByRole("radio", { name: "TLS" })
              ?.getAttribute("aria-checked") ?? null,
        };
      }}
    >
      <AppForm
        initialValues={{
          connection: {
            protocol: "vless",
            host: "entry.example.invalid",
            port: 443,
            uuid: "00000000-0000-4000-8000-000000000001",
            tls: { enabled: true, serverName: "entry.example.invalid" },
          },
        }}
      >
        <ConnectionFields />
      </AppForm>
    </FirstCommittedTask>,
  );
  expect(initial).toEqual({
    uuid: "00000000-0000-4000-8000-000000000001",
    sni: "entry.example.invalid",
    security: "true",
  });
});

it("opens a monthly cycle with its saved day and matching reset consequence on the first commit", () => {
  let initial: { day: string | null; description: string | null } | undefined;
  render(
    <FirstCommittedTask
      observe={(task) => {
        const form = within(task);
        const rule = form.getByLabelText("默认重置规则");
        const descriptionId = rule.getAttribute("aria-describedby");
        initial = {
          day:
            (form.queryByLabelText("每月几号") as HTMLInputElement | null)
              ?.value ?? null,
          description: descriptionId
            ? (document.getElementById(descriptionId)?.textContent ?? null)
            : null,
        };
      }}
    >
      <AppForm
        initialValues={{
          cycle: { mode: "monthly", day: 31, timezone: "UTC+8" },
        }}
      >
        <CycleFields planDefaults />
      </AppForm>
    </FirstCommittedTask>,
  );
  expect(initial).toEqual({
    day: "31",
    description: "每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。",
  });
});
