// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutingReview as SharedRoutingReview } from "./RoutingSummary";
import type { ComponentProps } from "react";
import type { RoutingSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function advanced(
  kind: "group" | "endpoint" | "direct" | "reject",
  label?: string,
  counts = { ruleCount: 4, groupCount: 2, nodeCount: 3 },
): RoutingSummary {
  return {
    version: 1,
    kind: "advanced",
    advanced: { defaultAction: { kind, label }, ...counts },
  };
}

describe.each([false, true])(
  "summary comparison with update hierarchy %s",
  (decisionReview) => {
    function RoutingReview(props: ComponentProps<typeof SharedRoutingReview>) {
      return <SharedRoutingReview {...props} decisionReview={decisionReview} />;
    }
    it("pairs a direct-to-reject decision in one semantic field without repeating unchanged counts", () => {
      render(
        <RoutingReview
          published={advanced("direct")}
          candidate={advanced("reject")}
        />,
      );
      const field = screen.getByText("未匹配规则的流量").closest("div")!;
      expect(field.querySelector("dt")).not.toBeNull();
      const values = within(field.querySelector("dd")!);
      expect(values.getByText("已发布")).toBeTruthy();
      expect(values.getByText("直连")).toBeTruthy();
      expect(values.getByText("待发布")).toBeTruthy();
      expect(values.getByText("拒绝连接")).toBeTruthy();
      expect(screen.queryByText("配置内容")).toBeNull();
      expect(
        screen.queryByText("4 条分流规则 · 2 个策略组 · 3 个节点"),
      ).toBeNull();
      expect(
        screen.getByText("未比较具体规则、策略组内容和节点设置。"),
      ).toBeTruthy();
    });

    it("states native override comparison limits once instead of repeating two opaque summaries", () => {
      render(
        <RoutingReview
          published={{
            ...advanced("group", "不能推断旧组"),
            kind: "native-override",
          }}
          candidate={{
            ...advanced("endpoint", "不能推断新节点"),
            kind: "native-override",
          }}
        />,
      );
      expect(
        screen.getByText(
          "已发布与待发布均使用原生配置覆盖，无法提供可靠的分流比较。",
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/不能推断/)).toBeNull();
      expect(screen.queryByText(/摘要字段相同/)).toBeNull();
    });

    it("keeps node-only routing separate from unknown node and connection changes", () => {
      render(
        <RoutingReview
          published={{ ...advanced("direct"), kind: "nodes-only" }}
          candidate={{ ...advanced("reject"), kind: "nodes-only" }}
        />,
      );
      expect(
        screen.getByText(
          "纯节点订阅不包含分流规则；节点及连接设置的变化不在此摘要中。",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("直连")).toBeNull();
      expect(screen.queryByText("拒绝连接")).toBeNull();
      expect(screen.queryByText(/摘要字段相同/)).toBeNull();
    });

    it("distinguishes a policy group from a particular endpoint even when their names match", async () => {
      const user = userEvent.setup();
      render(
        <RoutingReview
          published={advanced("group", "东京")}
          candidate={advanced("endpoint", "东京")}
        />,
      );
      const field = screen.getByText("未匹配规则的流量").closest("div")!;
      expect(within(field).getByText("由策略组「东京」决定")).toBeTruthy();
      expect(within(field).getByText("节点「东京」")).toBeTruthy();
      const disclosure = screen.getByText("摘要说明");
      await user.tab();
      expect(document.activeElement).toBe(disclosure);
      await user.click(disclosure);
      expect(disclosure.closest("details")!.open).toBe(true);
      expect(
        screen.getByText(
          "策略组按其配置决定流量去向，不表示客户端当前选中的节点。",
        ),
      ).toBeTruthy();
    });

    it("pairs each changed count with its own published value and omits matching default fields", () => {
      render(
        <RoutingReview
          published={advanced("direct")}
          candidate={advanced("direct", undefined, {
            ruleCount: 6,
            groupCount: 1,
            nodeCount: 0,
          })}
        />,
      );
      for (const [label, before, after] of [
        ["分流规则数", "4 条", "6 条"],
        ["策略组数", "2 个", "1 个"],
        ["节点数", "3 个", "0 个"],
      ]) {
        const field = screen.getByText(label).closest("div")!;
        expect(within(field).getByText(before)).toBeTruthy();
        expect(within(field).getByText(after)).toBeTruthy();
      }
      expect(screen.queryByText("未匹配规则的流量")).toBeNull();
      expect(
        screen.getByText(
          "规则数不含默认处理及规则文件内条目；节点数是配置包含数量，不代表在线状态。",
        ),
      ).toBeTruthy();
    });

    it.each(["group", "endpoint", "direct"] as const)(
      "does not treat matching %s labels and counts as matching rules or object identities",
      (kind) => {
        render(
          <RoutingReview
            published={advanced(kind, "相同显示名称")}
            candidate={advanced(kind, "相同显示名称")}
          />,
        );
        expect(
          screen.getByText("摘要字段相同，不代表配置未变化。"),
        ).toBeTruthy();
        expect(
          screen.getByText("未比较具体规则、策略组内容和节点设置。"),
        ).toBeTruthy();
        expect(
          screen.queryByText(/没有修改|无需更新|配置未发生变化|默认出口相同/),
        ).toBeNull();
        expect(screen.queryByRole("term")).toBeNull();
      },
    );

    it("keeps legacy advanced publication unknown and never backfills it from the candidate", () => {
      render(
        <RoutingReview
          published={{ version: 1, kind: "advanced" }}
          candidate={advanced("endpoint", "候选节点")}
        />,
      );
      const frozen = screen.getByRole("heading", {
        name: "已发布",
      }).parentElement!;
      const pending = screen.getByRole("heading", {
        name: "待发布",
      }).parentElement!;
      expect(
        within(frozen).getByText("这份高级配置暂无可用的分流详情。"),
      ).toBeTruthy();
      expect(within(frozen).queryByText(/候选节点|4 条/)).toBeNull();
      expect(within(pending).getByText("节点「候选节点」")).toBeTruthy();
      expect(screen.queryByText(/摘要字段相同/)).toBeNull();
    });

    it("does not compare an unavailable candidate as if it had zero rules", () => {
      render(<RoutingReview published={advanced("reject")} />);
      const pending = screen.getByRole("heading", {
        name: "待发布",
      }).parentElement!;
      expect(
        within(pending).getByText("这份订阅暂无可用的分流摘要。"),
      ).toBeTruthy();
      expect(within(pending).queryByText(/0 条|拒绝连接/)).toBeNull();
      expect(screen.queryByText(/摘要字段相同/)).toBeNull();
    });

    it("keeps mixed native and advanced summaries separate rather than fabricating a default diff", () => {
      render(
        <RoutingReview
          published={{ version: 1, kind: "native-override" }}
          candidate={advanced("endpoint", "候选节点")}
        />,
      );
      const frozen = screen.getByRole("heading", {
        name: "已发布",
      }).parentElement!;
      expect(
        within(frozen).getByText("使用原生配置覆盖，无法提供可靠的分流摘要。"),
      ).toBeTruthy();
      expect(within(frozen).queryByText(/候选节点/)).toBeNull();
      expect(screen.getByText("节点「候选节点」")).toBeTruthy();
    });

    it("shows first publication as candidate-only even if a published summary is supplied", () => {
      render(
        <RoutingReview
          creation
          published={advanced("group", "不相关旧组")}
          candidate={advanced("endpoint", "首次发布节点")}
        />,
      );
      expect(screen.getByRole("region", { name: "待发布分流" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "待发布分流" })).toBeTruthy();
      expect(screen.getByText("节点「首次发布节点」")).toBeTruthy();
      expect(screen.queryByText(/不相关旧组|已发布|摘要字段相同/)).toBeNull();
    });

    it("also keeps first basic publication out of the update comparison path", () => {
      render(
        <RoutingReview
          creation
          published={{
            version: 1,
            kind: "basic",
            chatGPT: { endpointId: "old", label: "旧线路" },
          }}
          candidate={{
            version: 1,
            kind: "basic",
            chatGPT: { endpointId: "new", label: "新线路" },
          }}
        />,
      );
      expect(screen.getByText("新线路")).toBeTruthy();
      expect(screen.queryByText(/旧线路|已发布 → 待发布/)).toBeNull();
    });

    it("keeps before/after labels and reading order inside each field for narrow reflow", () => {
      const longName =
        "名字很长但必须完整展示的连接名称-without-spaces-0123456789";
      render(
        <RoutingReview
          published={advanced("group", longName)}
          candidate={advanced("endpoint", longName, {
            ruleCount: 1,
            groupCount: 0,
            nodeCount: 2,
          })}
        />,
      );
      const terms = screen.getAllByRole("term");
      expect(terms).toHaveLength(4);
      for (const term of terms) {
        const value = term.nextElementSibling!;
        expect(value.tagName).toBe("DD");
        expect(within(value as HTMLElement).getByText("已发布")).toBeTruthy();
        expect(within(value as HTMLElement).getByText("待发布")).toBeTruthy();
        const before = value.children[0];
        const arrow = value.children[1];
        const after = value.children[2];
        expect(before.textContent).toMatch(/^已发布/);
        expect(arrow.getAttribute("aria-hidden")).toBe("true");
        expect(after.textContent).toMatch(/^待发布/);
      }
      expect(screen.getByText(`由策略组「${longName}」决定`)).toBeTruthy();
      expect(screen.getByText(`节点「${longName}」`)).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "已发布" })).toBeNull();
    });

    it("does not retrieve delivery URLs or offer a draft editor while comparing frozen metadata", () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      render(
        <RoutingReview
          published={advanced("direct")}
          candidate={advanced("reject")}
        />,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
    });
  },
);
