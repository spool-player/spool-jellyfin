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
| `ui/Login.qml` | Servers found on the network or typed in; password or Quick Connect |
| `ui/Picker.qml` | Choosing a playlist or collection, renaming, confirming a delete |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together.

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
