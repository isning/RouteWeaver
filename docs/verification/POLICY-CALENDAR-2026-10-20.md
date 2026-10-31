# Timezone-explicit user policy calendar

Official panel references show calendar-style expiry controls rather than requiring operators to type RFC3339. User policy start/expiry now use the existing Ant Design DatePicker with an explicit UTC+8 display. Dates are selected and confirmed with the picker; the ordinary display is read-only, avoiding a misleading partially typed but uncommitted timestamp. Existing invalid wire timestamps remain visible in a repair input and are not normalized away.

The Form retains the original string until a confirmed edit, including explicit offsets and nanosecond precision. Opening/closing the calendar does not emit a change. New selections are interpreted as UTC+8 wall time and serialized to UTC; existing cycle anchors are untouched. An implicit start remains optional/blank with the original zero sentinel restored on submit. Explicit starts cannot be cleared through the picker; optional expiry can be cleared deliberately.

Uses [Ant Design DatePicker](https://ant.design/components/date-picker/) and [Day.js UTC offset](https://day.js.org/docs/en/manipulate/utc-offset). Day.js 1.11.23 was already installed transitively and locked; it is now an exact direct dependency. An offline npm metadata lookup failed because it was not cached; package and lock root declarations were updated against the existing locked entry, and npm ls --package-lock-only verifies that exact dependency. No new runtime download or date-picker implementation was introduced.

## Evidence

- Red: raw input failed the UTC+8 calendar display assertion.
- During integration, simple date-cell selection did not commit a date/time picker. Tests now perform the real explicit OK action rather than faking an input change. Dirty drawer guards remain tested after confirmed date changes.
- A focused timezone test caught defaultPickerValue incorrectly forcing the current month over an existing date. It is now supplied only for empty fields.
- Focused calendar + complete access-policy suite: 33/33 passed. Includes UTC date-boundary conversion, unchanged high-precision timestamp payload, invalid calendar dates, optional clearing, no cycle reset/reanchor, stale apply and draft guards.
- Typecheck, dependency-lock inspection and diff check passed. Full integrated UI/browser checks remain pending; no independent post-implementation review is claimed.

Cloud Chrome follow-up at fa96a06 confirmed the calendar renders Chinese weekdays and year/month headings, explicitly displays UTC+8, and Escape closes the picker without selecting a date. A separate 100 Mbps draft preview displayed 100 Mbps in the effective-policy comparison; this test draft was explicitly discarded without applying policy. This closes the previous post-locale / rate-display browser-check gap.
