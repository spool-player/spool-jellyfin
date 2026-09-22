# Jellyfin for Spool

The Jellyfin provider for [Spool](https://github.com/spool-player/spool): sign in to a Jellyfin server,
browse and search its libraries, play with the server's own transcoding when needed, keep watched
state and resume points in sync, watch together with SyncPlay, and let other Jellyfin clients control
Spool. Spool bundles it and keeps it up to date from this repository's releases.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (provider API 0.2) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, item actions, SyncPlay |
| `logic/items.mjs` | Jellyfin JSON to Spool's item shape |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as group, remote-control and change events |
| `ui/Login.qml` | Servers found on the network or typed in; password or Quick Connect |
| `ui/Picker.qml` | Choosing a playlist or collection, renaming, confirming a delete |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together.

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
