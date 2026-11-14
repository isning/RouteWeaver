# Optional local IP metadata

Control plane flags --ip-country-db=/path/country.mmdb and
--ip-asn-db=/path/asn.mmdb accept administrator-supplied local databases.
Both are optional. No production database is bundled, downloaded or updated
automatically. No IP address is sent to an external lookup service.

Only server-derived addresses in the authenticated user's current admission
leases are enriched in /api/me/insights. No arbitrary-address lookup API exists.
Metadata is not recorded in subscription fetch history. Without a database,
ipMetadata.available is false; with one, it denotes database configuration, not
availability of admission observations or complete geographical coverage.

Country and ASN are independently optional. Status values: available, not-found,
non-public, unavailable. Country is a database estimate, not device location.
The AS organization is not necessarily a consumer ISP. No person/device identity
is inferred. Responses include database kind, type and build time, not file
paths. At most 100 addresses are enriched; truncated signals omitted inputs.

Supported types: GeoIP2-Country / GeoLite2-Country and GeoIP2-ASN / GeoLite2-ASN.
Reader: maxminddb-golang/v2 v2.9.0 (ISC license). Administrators must obtain data
under its provider license and comply with update/retention/redistribution terms.
GeoLite2 is not a license-free bundled dataset. Test fixtures are synthetic, not
production data; see internal/ipmeta/testdata/README.md and LICENSE-MIT.

Each file must be regular, nonempty and <=128 MiB. Startup copies it into private
immutable memory, verifies structure/type/build date, and fails on invalid
explicit configuration. Raw database memory is at most 256 MiB total plus reader
overhead. No mmap, per-request reads or live reload. Update files and restart to
reload. Keep administrator-owned files non-world-writable. Only use trusted
publishers: structural verification is not a publisher signature.

Existing credentials, metering and subscription outputs are unchanged.
