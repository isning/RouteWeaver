# Online connection details

The authenticated `/api/me/insights` admission section retains `onlineIps` and
`activeStreams`, and adds `connections`: rows grouped by canonical client IP and
its authenticated admission binding's output ID. Only unexpired leases belonging
to the current account contribute. There is no caller-selected account or range.
Shared account credentials omit `outputId`; they are not attributed to whichever
subscription was recently fetched. Independent credentials can be copied, so this
is not a device identity or proof of which client application is running.

`lastConfirmedAt` is the latest successful control-plane admission or renewal in
the group. It is recorded in the same encrypted lease transaction after access
and budget checks succeed. Rejected renewal, connection release and reading the
page do not advance it. This is **not** the time of the last payload byte. Existing
leases without this field remain unknown until a successful renewal; expiry is
never used to reconstruct a timestamp. A future timestamp is not displayed.

The overview resolves output names from the account's existing outputs response.
Missing names are shown as unavailable, not replaced by another subscription.
A shared credential is explicitly unassociated. Rows disappear when their lease
expires; disconnect visibility has the existing short-lease delay.

This adds no separate IP history, new external lookup, destination logging or
extra persistence write. The existing encrypted lease/hot-window records carry
the additive timestamp; older records and encrypted backups remain readable.
The authenticated hot projection and bounded cold fallback use the same grouping
logic and retain their existing row, byte and request-time bounds. Derived values
never alter billing, quotas or admission decisions.
