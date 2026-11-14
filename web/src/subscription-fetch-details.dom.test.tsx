// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SubscriptionFetchDetails } from "./SubscriptionFetchDetails";
import type { FetchHistory } from "./SubscriptionFetchAlerts";
afterEach(cleanup);
const now = Date.parse("2026-11-14T12:00:00Z");
const history: FetchHistory = {
  limit: 100, windowDays: 30, trackSourceIps: true,
  items: [
    {outputId:"phone", at:"2026-11-14T11:00:00Z",delivery:"feed",sourceIp:"192.0.2.4",newSource:true},
    {outputId:"phone", at:"2026-11-14T10:00:00Z",delivery:"bundle"},
    {outputId:"other", at:"2026-11-14T10:00:00Z",delivery:"feed",sourceIp:"192.0.2.99"},
    {outputId:"phone", at:"2026-11-13T12:00:00Z",delivery:"feed"},
    {outputId:"phone", at:"2026-11-15T12:00:00Z",delivery:"feed"},
  ],
};
it("shows only opted-in last source and exact retained recent records for this output", () => {
  const {rerender} = render(<SubscriptionFetchDetails history={history} outputId="phone" now={now} />);
  expect(screen.getByText("192.0.2.4")).toBeTruthy();
  expect(screen.getByText("新地址")).toBeTruthy();
  expect(screen.queryByText("192.0.2.99")).toBeNull();
  expect(screen.getByText("近 24 小时已保留 2 条拉取记录")).toBeTruthy();
  rerender(<SubscriptionFetchDetails history={{...history,trackSourceIps:false}} outputId="phone" now={now} />);
  expect(screen.queryByText("192.0.2.4")).toBeNull();
  expect(screen.queryByText("新地址")).toBeNull();
  expect(screen.getByText("近 24 小时已保留 2 条拉取记录")).toBeTruthy();
  rerender(<SubscriptionFetchDetails history={{...history,trackSourceIps:undefined}} outputId="phone" now={now} />);
  expect(screen.queryByText("192.0.2.4")).toBeNull();
});
it("does not borrow an old source when the latest delivery has no recorded IP", () => {
  render(<SubscriptionFetchDetails history={{...history, items:[{outputId:"phone",at:"2026-11-14T12:00:00Z",delivery:"bundle"},...history.items]}} outputId="phone" now={now} />);
  expect(screen.getByText("本次未记录来源 IP")).toBeTruthy();
  expect(screen.queryByText("192.0.2.4")).toBeNull();
  expect(screen.getByText("近 24 小时已保留 3 条拉取记录")).toBeTruthy();
});
