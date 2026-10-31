# RouteWeaver

RouteWeaver manages administrator-operated connectivity and lets invited users compose authorized connectivity with their own external subscriptions. These are proposed canonical product terms for review, not a claim that every underlying product decision is approved.

## Language

**VPS Node**:
A server under the administrator's operational control, with its own availability and provider traffic allowance.
_Avoid_: Proxy, endpoint, core

**Core Instance**:
One independently managed proxy-core service running on a VPS Node.
_Avoid_: Node, engine family

**Endpoint**:
A named connection interface with a defined protocol and connection identity; a managed Endpoint belongs to a Core Instance.
_Avoid_: Server, VPS, route

**Link**:
An administrator-defined, directed forwarding relationship between managed connection interfaces or an explicitly approved upstream.
_Avoid_: Subscription selection, visual line

**Published Route**:
A versioned administrator-offered path with a defined entry, ordered forwarding behavior and intended exit.
_Avoid_: Node, subscription, user rule

**Service Offering**:
A named package of Published Routes and service limits that an administrator can grant to users without implying a purchase.
_Avoid_: Paid plan, subscription URL

**Entitlement**:
A user's time-bounded or revocable permission to use a Service Offering under specified limits.
_Avoid_: Subscription, payment

**Subscription Source**:
A user's external provider feed from which connection options are imported.
_Avoid_: Service Offering, Generated Subscription

**Normalized Endpoint Snapshot**:
An immutable, provenance-preserving view of connection options successfully imported from one Subscription Source at a particular time.
_Avoid_: Live source, managed VPS

**User Profile**:
A user's saved selection of authorized connectivity, routing preferences and naming choices.
_Avoid_: Server configuration, account

**Generated Subscription**:
A client-targeted configuration derived from a User Profile and specific versions of its permitted inputs.
_Avoid_: Entitlement, upstream subscription

**Deployment**:
An attempt to make a particular revision of administrator intent active on specified Core Instances, with separately observed results.
_Avoid_: Render, publish, download

**Usage Ledger**:
An attributable history of traffic measurements and adjustments within a defined accounting scope and cycle.
_Avoid_: Current counter, invoice

**Client Renderer**:
A translator from a User Profile's effective intent into a supported client configuration format.
_Avoid_: Server core, runtime adapter

**Runtime Capability**:
A declared, version-specific behavior that an installed Core Instance can validate, apply or observe.
_Avoid_: Universal support, renderer success

**Server Deployment Intent**:
The administrator's desired server-side forwarding and policy behavior for a specified deployment revision.
_Avoid_: User Profile, native configuration

**Client Profile Intent**:
A user's desired client-side connectivity selection, routing and DNS behavior within their current rights.
_Avoid_: Shared topology, server route

**Rule Set Reference**:
A version-aware reference to a separately maintained collection of routing predicates with a defined format, origin and permitted use.
_Avoid_: Inline rule list, unversioned URL
