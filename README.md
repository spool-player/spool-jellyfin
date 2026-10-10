# Jellyfin for Spool

The Jellyfin provider for [Spool](https://github.com/spool-player/spool): sign in to a Jellyfin server,
browse and search its libraries, play with the server's own transcoding when needed, keep watched
state and resume points in sync, watch together with SyncPlay, and let other Jellyfin clients control
Spool. Spool bundles it and keeps it up to date from this repository's releases.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (package format 3) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, bandwidth endpoint, item actions, SyncPlay |
| `logic/items.mjs` | Jellyfin JSON to Spool's item shape |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as group, remote-control and change events |
| `logic/discovery.mjs` | Validated manual candidates and UDP sender correction |
| `logic/wire.mjs` | Exact signed-64-bit tick request encoding |
| `logic/settings.mjs` | Optional native preferences and application-owned DisplayPreferences documents |
| `logic/remote.mjs` | Negotiated outbound session control and occurrence-aware remote queues |
| `logic/downloads.mjs` | Exact-edition original files, HTTP progressive encoding and session cleanup |
| `ui/Login.qml` | Service labels and Quick Connect operations for Spool's compiled `ServerLogin` |
| `ui/Picker.qml` | Download edition selection plus compiled item pickers and device controls |
| `ui/Settings.qml` | Signed-in server-user language and audio/subtitle defaults with policy-aware editing |

Several users and several servers can be signed in at once. Each account's group is its server ID,
so users of the same server form one Spool profile set: one of them watches at a time, the set has its
own startup choice (always this user, or ask at startup), and different servers are shown together.
Jellyfin has no Home/PIN activation, so switching users of a server reuses each user's saved session.
Add profile and Sign in again on an existing server open its account chooser
directly, preserving reverse-proxy base paths. The saved session is never reused
to authenticate another viewer: each account retains its own token and user policy.
Authentication completes with public account metadata; session credentials reach
the host only through the private draft configuration event.

Generic login, server identity, item-action and device-control layouts are precompiled
into Spool, not shipped as duplicate provider screens. Use this provider with the
matching Spool build exposing `ServerLogin`, `ProviderActionPicker` and
`ProviderRemoteControls`. Local playback/appearance settings remain in Spool;
this provider's settings edit the signed-in user's Jellyfin server preferences,
which also affect other Jellyfin clients. Unsupported fields and policy-denied
preferences are read-only. Reload and failed saves retain unsaved edits; only
Save changes writes the changed fields, and closing cancels pending requests.
Changes already accepted by the server are not rolled back by closing.

Playback and protected trickplay sheets use the owning account's full
`Authorization: MediaBrowser …` header, including the saved device identity.
Sidecar subtitles and tracks negotiated for external delivery carry their own
selected-edition URL and reuse those playback headers. Relative URLs preserve
the configured server base path; foreign or malformed subtitle URLs are omitted
without failing playback, and query credentials are removed from subtitle metadata.
Each playback result carries its own sheet `urlTemplate`, tile geometry and
interval, bound to the exact selected media source; a missing or invalid map
does not borrow another edition's images or fail playback. Preview URLs contain
no account token. The host fetches and caches sheets through its native,
account-scoped preview loader, including remote-control previews; it does not
decode every sheet at playback start.

The sheet URL and media-source selector follow Jellyfin's
[TrickplayController](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/TrickplayController.cs).

When `videoPreviews` is false, details omit only the `Trickplay` field, playback
does not make its preview-only item request, and remote snapshots omit both the
field and descriptor. Chapters, media sources, tracks, artwork and skip markers
remain available. Remote metadata caches distinguish the preference, so turning
previews back on can load the selected edition's sheets.

## Local downloads

`download({itemId, mode, variantId?, maxBitrate?, maxHeight?}, host)` returns a
finite authenticated media resource. Multiple editions open this provider's
edition picker; its only answer is `variantId`. An unavailable selected edition
never falls back to another file. Downloads require the current account's
`EnableContentDownloading` permission. Only finite local video files are accepted:
live sources, remote media, discs, virtual items and multipart movies are rejected
rather than silently saving an incomplete part.

Original mode uses `/Videos/{itemId}/stream?static=true&MediaSourceId=...`, retaining
the selected container and a known safe byte size. Transcoded mode separately
negotiates `/Items/{itemId}/PlaybackInfo` with an HTTP MP4/H.264/AAC device profile,
direct play/stream and video/audio stream copying disabled. Bitrate defaults to
8 Mbit/s unless explicitly selected; explicit height and bitrate ceilings are
sent to the server, which can also impose its own account/network limits.
The height constraint is paired with a source-aspect width constraint because
Jellyfin's bitrate resolution normalizer discards a height-only limit. If source
dimensions are unknown, an explicit height request fails rather than being ignored.
Both video and audio encoding permissions are required. A server that cannot
negotiate genuine progressive output reports `download_transcode_unavailable`;
an HLS/DASH playlist or copy-only result is never returned as a download.

The negotiated `/Videos/{itemId}/stream.mp4` HTTP response is the complete growing
progressive file, with unknown encoded size. Authentication stays in the account's
authorization header; generated query credentials are removed and foreign-origin
URLs rejected. Each download has its own server-issued `PlaySessionId`, unrelated
to active playback or watched-state reports. The opaque cleanup record contains
only account/device/session identities. `downloadRelease` calls
`DELETE /Videos/ActiveEncodings` with both device and session on completion,
failure or cancellation; it never stops another download or the player's session.

These choices follow Jellyfin's
[progressive VideosController](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/VideosController.cs),
[device negotiation](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Helpers/MediaInfoHelper.cs)
and [session-scoped encoding cleanup](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/HlsSegmentController.cs).

## Diagnostics

The final current format-3 host provides `log` and `isLogEnabled` directly. Trace logging
reports local/remote preview availability and download negotiation choices;
debug records download protocol outcomes and encoding release; warnings identify
HTTP status failures without including account names, tokens, URLs or raw server
payloads. Trace is opt-in through `spool.provider.trace`; expensive diagnostic
fields are constructed only when enabled.


Optional features use exact boolean declarations, not the application version:
`artworkOwners` preserves inherited thumbnail/backdrop owners and
`speedTest` enables native throughput probes. Feature availability comes
from exact host/account negotiation, not application version strings. Inherited
thumbnail/backdrop tags require owner support; own artwork and ordinary
series/album fallbacks remain available without it. Current provider builds require
the current Spool host contract, including native logging; older hosts are not supported.

The boolean `suggestions`, `itemActions`,
`collectionEditing` and `playbackQueueReporting` capabilities add
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

`remoteTargets` adds outbound control independently of inbound remote
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

`playbackPreferences` exposes the signed-in user's audio/subtitle languages,
Default/Smart audio mode and Default/Smart/OnlyForced/Always/None subtitle mode.
Every write fetches current `Configuration` and `Policy`, respects
`EnableUserPreferenceAccess`, and posts only the four mapped changes merged into
the full configuration. It never writes administrator policy. Unknown or missing
enum values remain read-only; two-letter language normalization belongs to Spool.

`settingsStorage` uses one canonical lowercase UUID DisplayPreferences
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

The `speedTest` capability lets Spool measure each account's route using Jellyfin's authenticated
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

Login asks the network for servers with Jellyfin's UDP discovery (port 7359) as soon as it
opens and repeats every few seconds while a server is being chosen, so servers on the local
network appear without a button. Discovery itself never grants a server origin: selecting a
result still uses normal origin approval before sign-in.

Quick Connect is offered only when `/QuickConnect/Enabled` returns true.
Unavailable discovery leaves password login usable and offers an availability retry.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
cmake -S sdk -B build/sdk && cmake --build build/sdk
build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 build/sdk/provider-contract-runner tests/contract.mjs
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
python3 sdk/spool-provider.py build . --output "dist/spool.jellyfin-$VERSION.szo"
python3 sdk/spool-provider.py validate "dist/spool.jellyfin-$VERSION.szo"
```

`tests/contract.mjs` runs the provider against a scripted server in Qt's JS engine, the one Spool uses.
Catalogue pagination terminates on empty backend pages even with a stale positive total;
nonempty pages advance by the raw row count before invalid IDs are filtered.
Download contracts cover ambiguous/selected editions, HTTP encoding quality,
separate cleanup sessions, HLS/copy/foreign-origin rejection, permissions and
non-finite/multipart rejection. Preview contracts cover disabled metadata and
remote cache transitions. Fixture hosts use the same logging contract as production.

For an actual transport/codec smoke against a disposable Jellyfin server with one
generated movie, use `node tools/download-smoke.mjs /private/path/account.json`
with `ffprobe` on PATH. The private JSON contains `server`, `userId` and `token`;
the tool never prints credentials or URLs. It transfers both modes, checks complete
media and original byte size, verifies H.264/AAC at the requested height, and releases
the generated encoding even when a transfer/probe fails.
To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.jellyfin=/path/to/spool-jellyfin`.

## Releasing

Prepared private profile-UX release: **0.2.13**, adding server-user preference
settings to the saved-server profile/reauthentication context without sharing
viewer sessions. This source is not a published tag; use only with the reviewed
profile-UX host. Canonical published providers remain independent.
The profile-UX SDK is pinned to Spool commit `8434fc141951b3cd8a5e59b2eedf99863018712d`.

Future packages use `.szo` (Spool Zstandard Object): unchanged format-3 zstd
USTAR bytes, selected with the pinned SDK's explicit `--output` option. Existing
published archive names, URLs and digest pins remain immutable.

Bump `version` in `manifest.json`, then push a `v<version>` tag. The workflow runs the contract,
builds the package, attaches it with `spool-provider.json` to a GitHub release and asks the Spool
provider store to pick it up. Spool installs updates from there according to each viewer's update
setting.

MPL-2.0; see LICENSE and NOTICE.

## Service icon

The unmodified Jellyfin icon is by the Jellyfin Project, licensed CC BY-SA 4.0. See assets/JELLYFIN-LICENSE.txt and https://jellyfin.org/docs/general/contributing/branding/. The icon identifies the connected service; this is an independent Spool integration, not an official Jellyfin client. See [asset attribution](assets/BRANDING.md).
