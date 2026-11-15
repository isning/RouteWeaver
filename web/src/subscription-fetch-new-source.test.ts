import { expect, it } from "vitest";
import { hasRecentNewFetchSource } from "./SubscriptionFetchDetails";
import type { FetchHistory } from "./SubscriptionFetchAlerts";
const now = Date.parse("2026-11-15T12:00:00Z");
const item = (ip: string, hours: number, newSource = false, outputId = "phone") => ({outputId,sourceIp:ip,at:new Date(now-hours*3600000).toISOString(),delivery:"feed" as const,newSource});
const history = (items: FetchHistory["items"]): FetchHistory => ({items,trackSourceIps:true,limit:100,windowDays:30});
it("retains a new IP badge on repeated pulls without restarting its 24-hour window", () => {
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",1,true),item("192.0.2.1",2)]),"phone",now)).toBe(true);
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",0),item("192.0.2.2",1,true),item("192.0.2.1",2)]),"phone",now)).toBe(true);
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",0),item("192.0.2.2",24,true),item("192.0.2.1",25)]),"phone",now)).toBe(false);
});
it("does not mark another current IP, another output, a future event, or disabled tracking", () => {
  expect(hasRecentNewFetchSource(history([item("192.0.2.1",0),item("192.0.2.2",1,true),item("192.0.2.1",2)]),"phone",now)).toBe(false);
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",0),item("192.0.2.2",1,true,"other")]),"phone",now)).toBe(false);
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",0),item("192.0.2.2",-1,true)]),"phone",now)).toBe(false);
  expect(hasRecentNewFetchSource({...history([item("192.0.2.2",1,true)]),trackSourceIps:false},"phone",now)).toBe(false);
  expect(hasRecentNewFetchSource(history([item("192.0.2.2",1)]),"phone",now)).toBe(false);
  expect(hasRecentNewFetchSource(history([]),"phone",now)).toBe(false);
});
