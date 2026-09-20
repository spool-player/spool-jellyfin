# Spool Jellyfin provider

Experimental portable Jellyfin client for Spool's draft API **0.1**. JavaScript API logic runs on Spool's worker QJSEngine and uses its source-bound asynchronous HTTP service. Each source factory owns its account state; there is no global current server/token.

**Integration status:** this repository does not yet replace the native Jellyfin client in Spool. It is not a parity-complete production provider or an installable app update. The first source release is deliberately marked alpha. No Stremio implementation is included.

Implemented protocol operations cover authentication/QuickConnect, libraries, bounded browse/search, details and episodic navigation, resume/next-up/latest/similar/person lists, variants, exact-media-source playback requests, artwork descriptors, user state, reports, segments, account configuration, management and remote/SyncPlay REST commands. The synthetic contract tests cover pagination, per-source token state, authentication isolation, descriptor provenance and exact variant selection; they do not independently validate every endpoint against a real Jellyfin server.

Still required before native cutover: discovery integration, persisted-account migration, source-bound hosted QML, full filter/management parity, device-profile policy adaptation, audio/remux/subtitle/live-stream details, trickplay, WebSocket remote/SyncPlay lifecycle, federation, host manager/install/recovery, and differential/live-server coverage. These are missing features, not implicit capabilities supplied by the repository name.

## Development

`createSource({server, userId, token, deviceId, deviceName, clientVersion})` returns Promise-based operations. Login can start without a user or token. The host authorises the configured server origin independently of this configuration. `resolve` requires an exact `variantId`; it fails rather than switching to another edition returned by the server. Filename metadata is a basename; the host must keep filename display off by default.

The pinned small SDK snapshot under `sdk/` comes from Spool, not a nested application checkout. `sdk.lock.json` records each tooling file's SHA-256. Build its real Qt JS contract runner and test both engine modes:

```
cmake -S sdk -B build/sdk
cmake --build build/sdk
build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/provider-package.py build . --output build/spool-jellyfin.zip
```

Release CI validates the pinned tooling, runs these contracts, and packages one source ZIP for every OS/CPU. Tag releases attach GitHub build-provenance attestations and are prereleases while the version is experimental. Provenance is not a complete signed update catalogue; Spool must not activate packages merely because this workflow published them.

MPL-2.0; see LICENSE and NOTICE for attribution.
