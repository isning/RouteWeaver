# Backup action hierarchy

CI28 screenshots at 390 and 1280 showed the creation and capacity actions stacked in separate blocks despite ample shared width. The export section now presents its primary creation action and secondary capacity check in one wrapping action group. Capacity data and warnings remain below it; capacity ownership, query behavior, result fields, and restore/upload consequences are unchanged.

The existing public BackupSettings DOM test failed before implementation because the named action group was absent. Related DOM coverage includes opening the creation dialog without a request, capacity pending/result/failure/retry, primary action availability and retained focus, and all existing export/restore outcome tests. Browser coverage checks action alignment when there is room, wrapping on narrow widths, and keyboard order in the existing viewport matrix. Actual new pixels require CI; no local browser was launched.

The nine capacity values were not restyled based on source-only speculation. Existing warning and unknown-space wording remains intact.
