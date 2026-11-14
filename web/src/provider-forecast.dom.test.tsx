// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,render,screen} from "@testing-library/react";
import {ProviderForecast} from "./ServerOverview";
import type {NodeObservationView} from "./observability-model";
const fixture=()=>({config:{provider:{mode:"limited"}},provider:{fresh:true,observedAt:new Date().toISOString()},forecast:{status:"estimated",reason:"constant_rate_from_reconciliation",exhaustedAt:new Date(Date.now()+86400000).toISOString(),averageBytesPerSecond:1024,basisStart:new Date(Date.now()-86400000).toISOString(),basisEnd:new Date().toISOString()}} as NodeObservationView);
afterEach(()=>{cleanup();vi.useRealTimers()});
it("labels the real-rate projection and never promises a shutdown",()=>{render(<ProviderForecast data={fixture()}/>);expect(screen.getByText(/预计 .* 耗尽/)).toBeTruthy();expect(screen.getByText(/此预测不会自动停机/)).toBeTruthy();expect(screen.getByText(/平均 1 KiB\/s/)).toBeTruthy()});
it("hides old projections on refresh errors and stale readings",()=>{const data=fixture();const view=render(<ProviderForecast data={data} readFailed/>);expect(screen.queryByText(/预计 .* 耗尽/)).toBeNull();expect(screen.getByText(/资源读取失败/)).toBeTruthy();view.rerender(<ProviderForecast data={{...data,provider:{...data.provider,fresh:false}}}/>);expect(screen.queryByText(/预计 .* 耗尽/)).toBeNull()});
it("explains insufficient history rather than inventing a date",()=>{const data=fixture();data.forecast={status:"unavailable",reason:"less_than_24_hours"};render(<ProviderForecast data={data}/>);expect(screen.getByText(/还不足 24 小时/)).toBeTruthy();expect(screen.queryByText(/预计 .* 耗尽/)).toBeNull()});

it("expires cached predictions and stale data on a local clock without a fetch",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
 const data=fixture();data.forecast!.exhaustedAt=new Date(Date.now()+60000).toISOString();
 const view=render(<ProviderForecast data={data}/>);expect(screen.getByText(/预计 .* 耗尽/)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(60000));expect(screen.queryByText(/预计 .* 耗尽/)).toBeNull();expect(screen.getByText(/预测时间或周期已到/)).toBeTruthy();
 const other=fixture();other.forecast!.horizon=new Date(Date.now()+60000).toISOString();other.forecast!.status="beyond_horizon";
 view.rerender(<ProviderForecast data={other}/>);expect(screen.getByText(/预计不会耗尽/)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(60000));expect(screen.queryByText(/预计不会耗尽/)).toBeNull();
 const fresh=fixture();view.rerender(<ProviderForecast data={fresh}/>);
 act(()=>vi.advanceTimersByTime(16*60000));expect(screen.queryByText(/预计 .* 耗尽/)).toBeNull();expect(screen.getByText(/最近用量未更新/)).toBeTruthy();
});

it("does not round a positive tiny projection rate to zero",()=>{const data=fixture();data.forecast!.averageBytesPerSecond=0.1;render(<ProviderForecast data={data}/>);expect(screen.getByText(/平均 <1 B\/s/)).toBeTruthy()});
