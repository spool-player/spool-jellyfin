# Jellyfin for Spool

The Jellyfin provider for [Spool](https://github.com/spool-player/spool): sign in to a Jellyfin server,
browse and search its libraries, play with the server's own transcoding when needed, keep watched
state and resume points in sync, watch together with SyncPlay, and let other Jellyfin clients control
Spool. Spool bundles it and keeps it up to date from this repository's releases.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (provider API 0.2) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, bandwidth endpoint, item actions, SyncPlay |
| `logic/items.mjs` | Jellyfin JSON to Spool's item shape |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as group, remote-control and change events |
| `logic/discovery.mjs` | Validated manual candidates and UDP sender correction |
| `logic/wire.mjs` | Exact signed-64-bit tick request encoding |
| `logic/settings.mjs` | Optional native preferences and application-owned DisplayPreferences documents |
| `logic/remote.mjs` | Negotiated outbound session control and occurrence-aware remote queues |
| `ui/Login.qml` | Service labels and Quick Connect operations for Spool's compiled `ServerLogin` |
| `ui/Picker.qml` | Service command mappings for compiled item pickers and device controls |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together.

Generic login, server identity, item-action and device-control layouts are precompiled
into Spool, not shipped as duplicate provider screens. Use this provider with the
matching Spool build exposing `ServerLogin`, `ProviderActionPicker` and
`ProviderRemoteControls`. Playback/appearance settings live in Spool; the redundant
provider settings page has been removed.

Playback and protected trickplay sheets use the owning account's full
`Authorization: MediaBrowser …` header, including the saved device identity.
Preview URLs contain no account token. The host fetches previews on demand
through its account-scoped artwork loader, including remote-control previews;
it does not decode every sheet at playback start.


Optional features use exact version-one declarations, not the application version:
`spool.artwork-owners` preserves inherited thumbnail/backdrop owners and
`spool.speed-test` enables native throughput probes. On API 0.2 hosts without these
extensions, baseline login, browsing, playback and reporting remain available.
Inherited thumbnail/backdrop tags are omitted while own images and baseline
series/album poster fallbacks remain. Speed testing is not a legacy capability.
Compiled login and item pickers use the context's `missingHostExtensions` to show
“Update Spool to use all features of this provider.” when optional host support is missing.

The version-one `spool.suggestions`, `spool.item-actions`,
`spool.collection-editing` and `spool.playback-queue-reporting` extensions add
bounded server suggestions, permission-aware menus, occurrence-aware playlist
editing and native NowPlayingQueue reporting. Search runs dedicated Series and
mixed-type queries concurrently, prioritizes Series, deduplicates and returns a
bounded complete top-N set rather than an index continuation. Suggestions use
Jellyfin's favorite/liked-plus-random video query, never Continue Watching.

Permissions are loaded only when opening an action/editor and cached per source;
authorization failures, user-change notifications and reconnects invalidate the
account policy. Baseline actions also check policy before mutation. Playlist
editing checks the current user's granular playlist permission when supported,
falling back conservatively to explicit item edit rights, ownership or explicit
administrator policy on older servers. Playlist edits use opaque occurrence IDs;
collections permit membership removal but not reordering. Start/progress reports
reuse a source-owned queue snapshot, preserving duplicates; stop reports are
unchanged. Backend permission failures are not host-upgrade notices.

`spool.remote-targets` adds outbound control independently of inbound remote
commands and SyncPlay. Discovery asks `/Sessions?controllableByUserId=...`, checks
the session's nested media-control capabilities and excludes this installation.
Selecting a device only reads state. Unknown duration/volume and nonexistent
command acknowledgements stay absent; stream controls use native stream indices.
Queue rows preserve every occurrence, with missing metadata fetched in batches
of at most 50 unique IDs. A bounded snapshot supplies subsequent queue pages.

Remote queue edits **restart playback**, rather than pretending to mutate a
client's queue in place. A surviving current occurrence keeps its position;
removing it starts the nearest surviving successor at zero, and removing the
last entry sends Stop. Paused playback is restored only after the replacement
queue/current occurrence and position are confirmed. Uncertain mutations are
not retried blindly. General navigation, text and device-specific controls stay
in the provider picker and are offered only when the peer advertises them.
Available Jellyfin trickplay binds the playing item and media source; its tile
URL stays on the configured server origin and carries authentication only for
that origin. No local player state is changed to display remote previews.

The adapter follows Jellyfin's
[session controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/SessionController.cs).
Protocol fixtures and loopback exercises are not a claim of live-client support
for every command: the peer's advertised capabilities and server authorization
remain authoritative.

`spool.playback-preferences` exposes the signed-in user's audio/subtitle languages,
Default/Smart audio mode and Default/Smart/OnlyForced/Always/None subtitle mode.
Every write fetches current `Configuration` and `Policy`, respects
`EnableUserPreferenceAccess`, and posts only the four mapped changes merged into
the full configuration. It never writes administrator policy. Unknown or missing
enum values remain read-only; two-letter language normalization belongs to Spool.

`spool.settings-storage` uses one canonical lowercase UUID DisplayPreferences
record per document and signed-in user, partitioned by client `Spool`. Only
`CustomPrefs["spool.data.v1"]` contains application JSON; unrelated DTO fields and
CustomPrefs survive writes/deletes. Jellyfin GET and POST both send `userId` and
`client` through the configured server base path. Values, including JSON null,
are bounded to 64 KiB UTF-8 and 16 container levels; absence is distinct from null.
Malformed, too-deep or oversized existing data is never automatically overwritten
or deleted. This replacement-only store advertises `conditionalWrites:false` and
rejects any supplied revision condition before HTTP. It provides no atomic CAS
guarantee. Missing endpoints and permission failures are reported separately from
authentication failures or a missing-host update notice.

These adapters follow Jellyfin's
[DisplayPreferences controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/DisplayPreferencesController.cs).
Their stateful protocol fixtures cover preservation, per-account/document
isolation, complete enum round-trips, policy denial, null/absence, conditional
rejection and document size/depth/corruption boundaries.

The `spool.speed-test` extension lets Spool measure each account's route using Jellyfin's authenticated
`/Playback/BitrateTest?size={bytes}&_={nonce}` endpoint. The provider preserves the server's reverse-proxy
base path and sends the account token in the authorization header, not the URL. Spool's native host
performs the streaming benchmark and chooses the bitrate and number of parallel requests.

Playback uses the session's quality override first. Otherwise, “No limit on the local network” takes
precedence when Jellyfin's `/System/Endpoint` reports `IsLocal` or `IsInNetwork`; its ceiling is 1 Gbit/s.
Next come the manual settings preference, Spool's measured bitrate, and the existing 120 Mbit/s fallback.
Local classification is requested only when the unlimited preference can apply; if it fails, playback
keeps the manual, measured, or fallback ceiling rather than assuming the route is local.

Height limits remain in force on local routes. A remux uses the server's
negotiated URL, never an unbounded static-file fallback; forced transcoding
disables video stream copy and fails if no transcoded stream is available.
Codec restrictions never advertise an unsupported fallback output codec.

Playback, resume updates, and SyncPlay send decimal tick integers without rounding
through JavaScript numbers; invalid or overflowing values fail before HTTP.
Subtitle Off remains `-1`, and playlist rows preserve their occurrence identity as
`entryId` separately from the media ID.

Manual DNS addresses without a scheme try HTTPS first, then HTTP on the supplied
port (or 8096), then the default HTTP port. Private addresses and localhost try
HTTP on the supplied port (or 8096) first. Explicit schemes, ports, and base paths
are preserved; explicit HTTPS never falls back to HTTP. Each candidate goes through
Spool's origin approval before probing. UDP discovery corrects advertised literal
IP addresses to the packet sender while preserving DNS names, schemes, ports, and
base paths.

On hosts negotiating `spool.lan-probe` version 1, login also offers **Search local
network**. This starts only after the viewer requests it and approves Spool's
local-network consent prompt. The host probes unauthenticated
`/System/Info/Public` on port 8096 in bounded pages of at most 32 targets.
Login validates public information, deduplicates server IDs across pages and UDP
replies, and shows progress with Cancel/Back support. Closing login cancels the
search. Discovery itself never grants a server origin: selecting a result still
uses normal origin approval before sign-in. Older hosts keep UDP/manual discovery
and hide this control; no subnet search starts at app launch or in the background.

Quick Connect is offered only when `/QuickConnect/Enabled` returns true.
Unavailable discovery leaves password login usable and offers an availability retry.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
cmake -S sdk -B build/sdk && cmake --build build/sdk
build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/spool-provider.py build .          # dist/spool.jellyfin-<version>.tar.zst
```

`tests/contract.mjs` runs the provider against a scripted server in Qt's JS engine, the one Spool uses.
To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.jellyfin=/path/to/spool-jellyfin`.

## Releasing

Bump `version` in `manifest.json`, then push a `v<version>` tag. The workflow runs the contract,
builds the package, attaches it with `spool-provider.json` to a GitHub release and asks the Spool
provider store to pick it up. Spool installs updates from there according to each viewer's update
setting.

MPL-2.0; see LICENSE and NOTICE.

## Service icon

The unmodified Jellyfin icon is by the Jellyfin Project, licensed CC BY-SA 4.0. See assets/JELLYFIN-LICENSE.txt and https://jellyfin.org/docs/general/contributing/branding/. The icon identifies the connected service; this is an independent Spool integration, not an official Jellyfin client. See [asset attribution](assets/BRANDING.md).
