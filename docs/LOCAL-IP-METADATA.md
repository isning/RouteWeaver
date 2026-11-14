# Local IP metadata with automatic updates

Normal startup downloads free DB-IP Country Lite and ASN Lite databases in the
background. No account, API key or manual import is required. **Client IPs never
leave the server for a lookup.** Demo mode does not download databases.

Startup loads the verified cached pair immediately; the background job checks
on startup and every 24 hours. DB-IP releases monthly. A current-month pair is
not repeatedly downloaded. First startup stays available while downloading;
until both files validate, IP metadata is unavailable. Download failure retains
the old pair, logs an error, and retries the next day. The UI shows actual build
dates, not the last attempted update time. Missing monthly releases are retried.

## Configuration

- `--ip-db-auto-update=false`: disable automatic database downloads.
- `--ip-db-cache=/private/path`: persistent cache; defaults to `ip-databases`
  beside `--db`. Use a separate cache for each control-plane process.
- `--ip-country-db=/path/country.mmdb` and/or `--ip-asn-db=/path/asn.mmdb`:
  explicit local files take precedence and disable automatic downloads. Invalid
  files fail startup. Replace these explicit files and restart to reload.

Keep the cache persistent and administrator-owned, not writable by unrelated
users. It holds public vendor data only. Successful updates clean up older
updater-created generations, including staging directories left by a crash.

## License and provenance

DB-IP Lite is CC BY 4.0, with reduced coverage/accuracy relative to paid data.
The results page visibly links “IP Geolocation by DB-IP” and the license.
Database bytes are unchanged and are not bundled in the repository. Preserve
attribution if redistributing the databases or displaying their results.

Primary sources checked 2026-11-14:
- https://db-ip.com/db/lite.php
- https://db-ip.com/db/download/ip-to-country-lite
- https://db-ip.com/db/download/ip-to-asn-lite
- https://creativecommons.org/licenses/by/4.0/

Only fixed official HTTPS downloads are used:
`https://download.db-ip.com/free/dbip-{country|asn}-lite-YYYY-MM.mmdb.gz`.
No request can supply a URL. Redirects are refused. Limits: 90 seconds per request,
3 minutes per pair, 32 MiB compressed and 128 MiB decompressed per file. Gzip CRC,
MMDB structure/type and release-month checks must pass for both files. Files and
staging directory are synced before atomic manifest replacement, followed by
atomic in-memory publication. A response pins one immutable pair. Failure before
commit retains both cached and live data. TLS authenticates the download host;
CRC/structure validation is **not a detached publisher signature**. Trust in the
official publisher remains necessary. Peak replacement memory can contain old
and new pairs: up to 512 MiB raw data plus reader overhead at the hard limits.

## Lookup scope

Only server-derived addresses in the authenticated user's current admission
leases are enriched in `/api/me/insights`. No arbitrary-address lookup API exists.
Metadata is not stored in fetch history. Availability means a database is loaded,
not that observations or full geographical coverage exist. At most 100 addresses
are enriched; `truncated` marks omitted inputs. Responses include type/build date/
attribution, not file paths. Status: `available`, `not-found`, `non-public`,
`unavailable`. Country is an estimate, not device location; AS organization is not
necessarily a consumer ISP. No person/device identity is inferred.

Explicit databases may provide country and ASN independently. Supported types:
GeoIP2-Country / GeoLite2-Country / DBIP-Country-Lite; GeoIP2-ASN / GeoLite2-ASN /
DBIP-ASN-Lite (compat=GeoLite2-ASN). Reader: maxminddb-golang/v2 (ISC). Other
providers retain their own licensing requirements. Synthetic test fixtures:
`internal/ipmeta/testdata/README.md`, `LICENSE-MIT`. Credentials, metering and
subscription outputs are unchanged.
