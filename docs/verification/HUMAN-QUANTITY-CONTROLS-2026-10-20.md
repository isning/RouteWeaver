# Human-unit quota and rate editing

Personal quota exceptions now display GiB; per-entry rate controls display Mbps, including service-plan rate limits. Reuses Ant Design InputNumber through one small presentation adapter. Form values and HTTP payloads remain bytes / bytes per second. GiB means 2^30 bytes and Mbps means 125,000 bytes per second. Counters, quota inheritance and cycle behavior are unchanged.

Rendering does not emit a change. Deliberate edits convert once without rounding; existing integer-byte validation remains authoritative. Zero stays an explicit unlimited override, disabled overrides still inherit, and clearing is null/invalid rather than silently unlimited. Inputs that cannot represent integral bytes show an explicit conversion error rather than an unexplained integer error in the display unit.

Red: four display/conversion tests failed against an unscaled InputNumber. Green: calendar, quantity and access-policy suites passed 42/42. Coverage includes 0.5 GiB and 100 Mbps payload conversion; untouched 1-byte and MAX_SAFE_INTEGER values in both display units; fractional-byte rejection; zero/clear distinction; and actual personal-policy preview payload with inherited limits and cycle preserved. Typecheck/diff checks passed. Full integration and actual-browser checks remain pending; no independent final review is claimed.
