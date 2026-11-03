# Empty list surfaces and source search feedback

Baseline: 161760d. Actual CI28 account-security 390 and filtered-source toolbar 1280 screenshots were inspected before changes. Empty session/account lists retained a bordered `ul`; filtered sources displayed only the inventory total.

The security page now mounts list surfaces only for non-empty records. Its empty messages, refresh action, revoke-others form separator, and populated list actions are retained. Source search reports matched and total counts while a query exists, and the inventory total after clearing; result feedback uses a polite atomic announcement. Filtering, source identity, ordering, and fetching are unchanged.

Tests exercise actual pages through GET responses, search/clear keyboard actions, and refreshing empty sessions to a populated list. Baseline: 3 new expectations failed, 19 existing expectations passed. Candidate: 22/22 focused tests; source-controls and source-action-menu together bring the selected total to 29/29. Application types, browser-spec types and production build pass. Production formatting was kept local; final two-file test rerun passes after formatting cleanup.

Existing browser scenarios now verify matched counts and clearing at 390/1280 and absence of empty semantic lists in account-security regions across the existing viewport matrix. Their geometry, focus and subsequent task assertions remain. Browser execution and revised pixels require CI; no local browser or deployment was performed.
