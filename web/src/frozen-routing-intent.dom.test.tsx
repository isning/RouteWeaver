// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RoutingReview as SharedRoutingReview } from "./RoutingSummary";
import type { ComponentProps } from "react";
import type { FrozenRoutingIntent } from "./types";

afterEach(cleanup);

const intent = (
  ref = "tokyo",
  label = "东京-ChatGPT",
): FrozenRoutingIntent => ({
  version: 1 as const,
  kind: "portable" as const,
  defaultAction: { kind: "endpoint" as const, ref: "hk", label: "香港-日常" },
  ruleCount: 1,
  rules: [
    {
      id: "chatgpt-domain",
      match: {
        state: "exact" as const,
        expression: { op: "domain-suffix", value: "chatgpt.com" },
      },
      action: { kind: "endpoint" as const, ref, label },
    },
  ],
});

describe.each([false, true])(
  "frozen comparison with update hierarchy %s",
  (decisionReview) => {
    function RoutingReview(props: ComponentProps<typeof SharedRoutingReview>) {
      return <SharedRoutingReview {...props} decisionReview={decisionReview} />;
    }
    it("keeps the exact reviewed match and named destination visible before first publication", () => {
      render(
        <RoutingReview
          creation
          candidate={{
            version: 1,
            kind: "advanced",
            advanced: {
              defaultAction: { kind: "endpoint", label: "香港-日常" },
              ruleCount: 1,
              groupCount: 0,
              nodeCount: 3,
            },
          }}
          candidateIntent={intent()}
        />,
      );
      const review = screen.getByRole("region", { name: "待发布分流" });
      const rule = within(review)
        .getByText("域名后缀 chatgpt.com")
        .closest("li")!;
      expect(within(rule).getByText("节点「东京-ChatGPT」")).toBeTruthy();
      expect(within(review).getByText("节点「香港-日常」")).toBeTruthy();
      expect(within(review).queryByText(/^ChatGPT$/)).toBeNull();
      expect(rule.closest("details")).toBeNull();
    });

    it("shows a same-count rule destination change against its frozen published destination", () => {
      render(
        <RoutingReview
          publishedIntent={intent()}
          candidateIntent={intent("london", "伦敦-工作")}
        />,
      );
      const changes = screen.getByRole("list", { name: "分流规则变更" });
      const rule = within(changes)
        .getByText("域名后缀 chatgpt.com")
        .closest("li")!;
      expect(within(rule).getByText("已发布")).toBeTruthy();
      expect(within(rule).getByText("节点「东京-ChatGPT」")).toBeTruthy();
      expect(within(rule).getByText("待发布")).toBeTruthy();
      expect(within(rule).getByText("节点「伦敦-工作」")).toBeTruthy();
      for (const label of ["已发布", "待发布"]) {
        const version = within(rule).getByText(label).parentElement!;
        expect(version.classList.contains("flex")).toBe(true);
        expect(version.classList.contains("flex-col")).toBe(true);
      }
      expect(screen.queryByText(/摘要字段相同/)).toBeNull();
      expect(
        screen.getByText(/规则文件内容、策略组内容和节点设置/),
      ).toBeTruthy();
    });

    it("distinguishes changed resource references even when their frozen labels are identical", () => {
      const resourceIntent = (id: string): FrozenRoutingIntent => ({
        ...intent(),
        resources: [{ id, label: "业务规则" }],
        rules: [
          {
            ...intent().rules![0],
            match: {
              state: "exact",
              expression: { op: "resource", value: id },
            },
          },
        ],
      });
      render(
        <RoutingReview
          publishedIntent={resourceIntent("file-old")}
          candidateIntent={resourceIntent("file-new")}
        />,
      );
      const changes = screen.getByRole("list", { name: "分流规则变更" });
      expect(within(changes).getByText("匹配条件已更改")).toBeTruthy();
      expect(within(changes).queryByText("顺序已调整")).toBeNull();
    });

    it("identifies a different destination with the same name without exposing its identity in the primary row", () => {
      render(
        <RoutingReview
          publishedIntent={intent()}
          candidateIntent={intent("new-tokyo")}
        />,
      );
      const changes = screen.getByRole("list", { name: "分流规则变更" });
      expect(within(changes).getByText("去向已更换")).toBeTruthy();
      const disclosure = within(changes)
        .getByText("查看去向标识")
        .closest("details")!;
      expect(disclosure.open).toBe(false);
      expect(within(disclosure).getByText("tokyo")).toBeTruthy();
      expect(within(disclosure).getByText("new-tokyo")).toBeTruthy();
    });

    it("shows changed rule priority in candidate order rather than sorting by rule identity", () => {
      const first = intent().rules![0];
      const second = {
        ...first,
        id: "a-first-alphabetically",
        match: {
          state: "exact" as const,
          expression: { op: "domain", value: "openai.com" },
        },
      };
      const published: FrozenRoutingIntent = {
        ...intent(),
        ruleCount: 2,
        rules: [first, second],
      };
      render(
        <RoutingReview
          publishedIntent={published}
          candidateIntent={{ ...published, rules: [second, first] }}
        />,
      );
      const changes = screen.getByRole("list", { name: "分流规则变更" });
      expect(
        within(changes)
          .getAllByRole("heading")
          .map((heading) => heading.textContent),
      ).toEqual(["域名 openai.com", "域名后缀 chatgpt.com"]);
      expect(within(changes).getByText(/顺序 2 → 1/)).toBeTruthy();
      expect(within(changes).getByText(/顺序 1 → 2/)).toBeTruthy();
    });

    it("does not call omitted conditions or omitted rules unchanged", () => {
      const partial: FrozenRoutingIntent = {
        ...intent(),
        ruleCount: 2,
        omittedRuleCount: 1,
        rules: [
          {
            ...intent().rules![0],
            match: { state: "omitted", reason: "sensitive" },
          },
        ],
      };
      render(
        <RoutingReview publishedIntent={partial} candidateIntent={partial} />,
      );
      expect(screen.getByText("匹配条件未展示（含敏感信息）")).toBeTruthy();
      expect(screen.getByText("另有 1 条规则未在摘要中展示。")).toBeTruthy();
      expect(
        screen.getByText("部分规则明细未展示，无法完整比较分流规则。"),
      ).toBeTruthy();
      expect(screen.queryByText(/相同|未配置分流规则/)).toBeNull();
    });

    it("keeps legacy published facts separate from new private candidate rules", () => {
      render(
        <RoutingReview
          published={{
            version: 1,
            kind: "basic",
            chatGPT: { endpointId: "old", label: "旧版东京" },
            default: { endpointId: "hk", label: "旧版香港" },
          }}
          candidateIntent={intent("london", "伦敦-工作")}
        />,
      );
      const frozen = screen.getByRole("heading", {
        name: "已发布",
      }).parentElement!;
      expect(within(frozen).getByText("旧版东京")).toBeTruthy();
      expect(
        within(frozen).getByText("此版本未保存具体规则明细，无法逐条比较。"),
      ).toBeTruthy();
      expect(within(frozen).queryByText(/chatgpt.com|伦敦-工作/)).toBeNull();
      const candidate = screen.getByRole("heading", {
        name: "待发布",
      }).parentElement!;
      expect(within(candidate).getByText("域名后缀 chatgpt.com")).toBeTruthy();
      expect(within(candidate).getByText("节点「伦敦-工作」")).toBeTruthy();
    });

    it.each([
      ["native-override", "使用原生配置覆盖，无法提供可靠的分流摘要。"],
      ["nodes-only", "纯节点订阅，仅交付连接。"],
    ] as const)(
      "does not render portable rules for %s",
      (kind, explanation) => {
        render(
          <RoutingReview creation candidateIntent={{ ...intent(), kind }} />,
        );
        expect(screen.getByText(explanation)).toBeTruthy();
        expect(
          screen.queryByText(/chatgpt.com|东京-ChatGPT|香港-日常/),
        ).toBeNull();
      },
    );
  },
);
