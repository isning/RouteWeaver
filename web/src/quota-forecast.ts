import type { Overview } from "./types";
import { dateLabel } from "./model";
const day = 86_400_000;
const timestamp = (value: unknown) =>
  typeof value === "string" ? Date.parse(value) : NaN;
function bytes(value: unknown): bigint | undefined {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
    ? BigInt(value)
    : undefined;
}
/** Only describe the server's estimate; never derive a new rate or allocate traffic. */
export function quotaForecastText(
  overview: Overview,
  now: number,
): string | null {
  const forecast = overview.quotaForecast;
  if (
    forecast?.available !== true ||
    overview.status !== "active" ||
    overview.accountingPending ||
    !Number.isSafeInteger(overview.quotaBytes) ||
    overview.quotaBytes <= 0 ||
    !Number.isSafeInteger(overview.usage.weightedBytes) ||
    overview.usage.weightedBytes < 0
  )
    return null;
  const remaining = bytes(forecast.remainingBytes);
  const reserved = bytes(forecast.reservedBytes);
  if (
    remaining === undefined ||
    reserved === undefined ||
    reserved >= remaining ||
    remaining <= 0n ||
    remaining !==
      BigInt(Math.max(0, overview.quotaBytes - overview.usage.weightedBytes)) ||
    (forecast.weightedBytes !== undefined &&
      bytes(forecast.weightedBytes) === undefined)
  )
    return null;
  const asOf = timestamp(forecast.asOf),
    start = timestamp(forecast.windowStart),
    end = timestamp(forecast.windowEnd);
  if (
    ![asOf, start, end, now].every(Number.isFinite) ||
    asOf > now + 5000 ||
    now - asOf > 90_000 ||
    end > asOf ||
    asOf - end > day ||
    end - start !== 7 * day
  )
    return null;
  const bounds = [
    overview.cycle?.nextReset,
    overview.entitlement?.expiresAt,
  ].filter((value) => value !== undefined);
  const deadlines = bounds.map(timestamp);
  if (deadlines.some((value) => !Number.isFinite(value) || value <= now))
    return null;
  const expectedHorizon = deadlines.length ? Math.min(...deadlines) : undefined;
  const horizon =
    forecast.horizon === undefined ? undefined : timestamp(forecast.horizon);
  if (
    horizon !== expectedHorizon ||
    (horizon !== undefined && (!Number.isFinite(horizon) || horizon <= now))
  )
    return null;
  const exhaustion =
    forecast.estimatedExhaustionAt === undefined
      ? undefined
      : timestamp(forecast.estimatedExhaustionAt);
  if (
    exhaustion !== undefined &&
    (!Number.isFinite(exhaustion) ||
      exhaustion <= now ||
      exhaustion < asOf ||
      exhaustion - asOf > 366 * day)
  )
    return null;
  if (forecast.enoughUntilHorizon === true) {
    if (
      horizon === undefined ||
      horizon - asOf > 366 * day ||
      (exhaustion !== undefined && exhaustion < horizon)
    )
      return null;
    if (forecast.reason === "zero_usage_within_horizon")
      return `观察的7天内未产生用量，当前额度预计足够用到 ${dateLabel(forecast.horizon)}。`;
    return `按已核实的7天平均用量保守估计，当前额度预计足够用到 ${dateLabel(forecast.horizon)}。`;
  }
  if (
    forecast.enoughUntilHorizon !== undefined &&
    forecast.enoughUntilHorizon !== false
  )
    return null;
  if (
    exhaustion === undefined ||
    (horizon !== undefined && exhaustion > horizon)
  )
    return null;
  return `按已核实的7天平均用量保守估计，预计 ${dateLabel(forecast.estimatedExhaustionAt)} 用完当前额度。`;
}
