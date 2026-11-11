# Prepared compact-tab native sampler

Twelve synthetic cases exercise the actual ScrollableTabsList and CollectionPreview
compositions at 320/390/1440 in light/dark, using production CSS and UIProviders.
System-theme emulation drives the real theme provider. No production page, API,
server or separate framework was added; the existing test Vite server serves it.

Each case checks normal 32px rail/25px trigger dimensions, then computed-font and
line-height doubling. This is controlled text enlargement, not native browser
zoom. The existing Range text containment audit is unchanged. Actual Tab/Home/
End/ArrowRight navigation verifies selection, target-box reachability and computed
focus styling. CollectionPreview retains its real ScrollArea and truncation.
Original viewport screenshots show first/last keyboard targets at both text sizes;
a failure capture preserves the failed state without recovery or repositioning.
No scripted focus/scroll or disabled motion is used. API/feed requests are blocked
and recorded only as generic categories; all labels are synthetic. Automatic
screenshots, traces and video remain off.

Strict specification/helper TypeScript, sample TypeScript, whitespace checks and
12-case discovery passed. Independent source review accepted the native files.
No browser execution or actual new screenshots have occurred yet. These isolated
composition checks do not replace real product journeys or prove focus-ring
contrast, native zoom, disabled-tab behavior, sticky-header behavior, draft/history
retention or platform-settings line variant. Existing full product-model 200% and
normal-size visual checks remain authoritative and unchanged.
