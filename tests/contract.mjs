// SPDX-License-Identifier: MPL-2.0
// The provider against a scripted Jellyfin, in Qt's own JS engine
// (sdk/provider-contract-runner). Covers what Spool relies on: paging,
// per-account state, exact editions, stream safety, sign-in results, item
// actions, group commands and websocket translation.

import { createSource, normalizeServer } from '../logic/provider.mjs';
import { translate, connect } from '../logic/events.mjs';
import { deviceProfile } from '../logic/profile.mjs';
import { item } from '../logic/items.mjs';
import { catalogueContracts } from './catalogue.mjs';
import { settingsContracts } from './settings.mjs';
import { remoteContracts } from './remote.mjs';

let step = 'start';
function check(value, message) {
    if (!value)
        throw new Error('contract: ' + step + ': ' + message);
}
function respond(value, status) {
    return Promise.resolve({ status: status || 200, body: value === undefined ? '' : JSON.stringify(value) });
}
// Operations may throw at once or reject later; Spool treats both alike.
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => check(false, 'expected ' + code), error => check(error.message === code,
        'expected ' + code + ', got ' + error.message));
}

const device = { id: 'device-1', name: 'Living "Room"', app: 'Spool', version: '1.0', platform: 'test', locale: 'en' };
const never = () => new Promise(() => {});

// A server keyed by "METHOD path", recording every request.
function server(routes) {
    const calls = [];
    const speedTests = [];
    return {
        calls: calls,
        speedTests: speedTests,
        host: {
            device: device, delay: never,
            speedTest: options => {
                speedTests.push(options);
                return Promise.resolve({ bitrate: 36000000, parallelRequests: 2 });
            },
            http: (url, options) => {
                const method = (options && options.method) || 'GET';
                const path = url.replace(/^https?:\/\/[^/]+(\/jf)?/, '').split('?')[0];
                calls.push({ method: method, url: url, path: path, options: options,
                    body: options && options.body ? JSON.parse(options.body) : undefined });
                const route = routes[method + ' ' + path];
                if (route === undefined)
                    return respond({}, 404);
                return typeof route === 'function' ? route(calls[calls.length - 1]) : respond(route);
            }
        }
    };
}

function account(user, token, extensions) {
    const host = { device: device };
    if (extensions !== undefined)
        host.extensions = extensions;
    return createSource({ server: 'https://media.example/jf', userId: user, token: token }, host);
}

function extensionCompatibility() {
    step = 'optional extensions and legacy artwork';
    const declared = { 'spool.artwork-owners': 1, 'spool.speed-test': 1,
        'spool.suggestions': 1, 'spool.item-actions': 1, 'spool.collection-editing': 1,
        'spool.playback-queue-reporting': 1, 'spool.playback-preferences': 1, 'spool.settings-storage': 1,
        'spool.remote-targets': 1 };
    const legacy = account('ua', 'token');
    const current = account('ua', 'token', declared);
    const wrong = account('ua', 'token', { 'spool.artwork-owners': 2, 'spool.speed-test': '1', 'future.feature': 1 });
    check(Object.keys(legacy.describe().extensions).length === 0
        && Object.keys(declared).every(id => legacy.extensionStatus().missingHost.indexOf(id) >= 0),
        'absent host extensions require an update regardless of device version');
    check(Object.keys(wrong.extensionStatus().enabled).length === 0, 'only exact supported wire majors enable features');
    check(current.describe().extensions['spool.artwork-owners'] === 1
        && current.extensionStatus().enabled['spool.speed-test'] === 1
        && current.extensionStatus().missingHost.length === 0, 'supported declarations become account offers');
    const raw = { Id: 'episode', Type: 'Episode', SeriesId: 'series', SeriesPrimaryImageTag: 'series-poster',
        AlbumId: 'album', AlbumPrimaryImageTag: 'album-poster', ImageTags: { Primary: 'own-poster' },
        ParentThumbItemId: 'season', ParentThumbImageTag: 'parent-thumb',
        ParentBackdropItemId: 'series', ParentBackdropImageTags: ['parent-backdrop'] };
    const fixture = server({ 'GET /Items': { Items: [raw], TotalRecordCount: 1 },
        'GET /Users/ua/Items/episode': raw });
    return fails(() => legacy.speedTest({}, fixture.host), 'unsupported_extension')
        .then(() => fails(() => wrong.speedTest({}, fixture.host), 'unsupported_extension')).then(() => {
            check(fixture.calls.length === 0 && fixture.speedTests.length === 0,
                'unsupported speed tests fail before HTTP or native probes');
            return Promise.all([legacy.browse({ limit: 5 }, fixture.host), current.browse({ limit: 5 }, fixture.host),
                legacy.details({ itemId: 'episode' }, fixture.host), current.details({ itemId: 'episode' }, fixture.host)]);
        }).then(results => {
            for (const row of [results[0].items[0], results[2].item]) {
                check(!row.thumbTag && !row.backdropTag && !row.thumbItemId && !row.backdropItemId,
                    'legacy pages and details never attach inherited images to the child');
                check(row.posterTag === 'own-poster' && row.seriesPosterTag === 'series-poster'
                    && row.albumPosterTag === 'album-poster', 'own images and baseline poster fallbacks remain');
            }
            for (const row of [results[1].items[0], results[3].item])
                check(row.thumbItemId === 'season' && row.thumbTag === 'parent-thumb'
                    && row.backdropItemId === 'series' && row.backdropTag === 'parent-backdrop',
                    'each source applies its own negotiated artwork options');
        });
}

// Baseline repairs are exercised through provider operations, including the raw
// request body: JSON.parse would itself round the very integers under test.
function baselineRepairs() {
    step = 'playlist occurrences';
    const source = account('ua', 'token-a');
    const playlist = server({ 'GET /Items': { TotalRecordCount: 2, Items: [
        { Id: 'film', PlaylistItemId: 'entry/first', Name: 'Film' },
        { Id: 'film', PlaylistItemId: 0, Name: 'Film' }
    ] } });
    return source.browse({ parentId: 'playlist', limit: 10 }, playlist.host).then(result => {
        check(result.items[0].id === 'film' && result.items[1].id === 'film'
            && result.items[0].entryId === 'entry/first' && result.items[1].entryId === '0',
            'duplicate media rows retain distinct opaque occurrence IDs, including numeric zero');
        step = 'exact wire ticks';
        const wire = server({
            'POST /Items/film/PlaybackInfo': { MediaSources: [{ Id: 'v', SupportsDirectPlay: true }] },
            'POST /Sessions/Playing': {}, 'POST /Sessions/Playing/Progress': {}, 'POST /Sessions/Playing/Stopped': {},
            'POST /Users/ua/Items/film/UserData': {},
            'POST /SyncPlay/Seek': {}, 'POST /SyncPlay/SetNewQueue': {},
            'POST /SyncPlay/Buffering': {}, 'POST /SyncPlay/Ready': {}
        });
        const ordinary = '9007199254740993 "quoted" \\ escaped\nline';
        const operations = [
            { path: '/Items/film/PlaybackInfo', field: 'StartTimeTicks',
                call: ticks => source.resolve({ itemId: 'film', positionTicks: ticks, unlimitedLocalNetwork: true }, wire.host) },
            ...['start', 'progress', 'stop'].map(event => ({
                path: { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' }[event],
                field: 'PositionTicks', call: ticks => source.report({ event: event, itemId: 'film',
                    positionTicks: ticks, subtitleStreamIndex: -1, audioStreamIndex: -1, playSessionId: ordinary }, wire.host)
            })),
            { path: '/Users/ua/Items/film/UserData', field: 'PlaybackPositionTicks',
                call: ticks => source.progress({ itemId: 'film', positionTicks: ticks }, wire.host) },
            { path: '/SyncPlay/Seek', field: 'PositionTicks',
                call: ticks => source.groupSend({ action: 'seek', positionTicks: ticks }, wire.host) },
            { path: '/SyncPlay/SetNewQueue', field: 'StartPositionTicks',
                call: ticks => source.groupSend({ action: 'setQueue', positionTicks: ticks,
                    itemIds: ['film', 'film'], index: 1 }, wire.host) },
            ...[true, false].map(buffering => ({
                path: '/SyncPlay/' + (buffering ? 'Buffering' : 'Ready'), field: 'PositionTicks',
                call: ticks => source.groupSend({ action: 'buffering', buffering: buffering,
                    positionTicks: ticks, at: 0, entryId: 'entry' }, wire.host)
            }))
        ];
        let sequence = Promise.resolve();
        for (const operation of operations) {
            for (const ticks of ['0', '-1', '9007199254740993', '9223372036854775807', '-9223372036854775808']) {
                sequence = sequence.then(() => operation.call(ticks)).then(() => {
                    const call = wire.calls.filter(entry => entry.path === operation.path).pop();
                    check(call.options.body.indexOf('"' + operation.field + '":' + ticks) >= 0,
                        operation.path + ' emits the exact signed integer number token');
                    if (operation.path.indexOf('/Sessions/Playing') === 0)
                        check(call.body.SubtitleStreamIndex === -1 && call.body.AudioStreamIndex === undefined
                            && call.body.PlaySessionId === ordinary, 'subtitle off and ordinary escaped strings survive');
                });
            }
            for (const ticks of ['', '01', '1.5', '1e3', ' 1', '+1', '9223372036854775808',
                '-9223372036854775809', '1,"injected":true', 9007199254740992, null, {}]) {
                sequence = sequence.then(() => {
                    const before = wire.calls.length;
                    return fails(() => operation.call(ticks), 'invalid_position').then(() =>
                        check(wire.calls.length === before, 'invalid ticks fail before any HTTP, including resolve side requests'));
                });
            }
        }
        return sequence;
    }).then(() => {
        step = 'manual discovery candidates';
        const login = createSource({}, { device: device });
        const candidates = input => login.serverCandidates({ server: input }).servers;
        const equal = (input, expected) => check(JSON.stringify(candidates(input)) === JSON.stringify(expected),
            'candidate order and supplied address components for ' + input);
        equal('media.example/base', ['https://media.example/base', 'http://media.example:8096/base', 'http://media.example/base']);
        equal('media.example:9000/base/', ['https://media.example:9000/base', 'http://media.example:9000/base']);
        equal('192.168.1.8/base', ['http://192.168.1.8:8096/base', 'https://192.168.1.8/base', 'http://192.168.1.8/base']);
        equal('localhost:9000', ['http://localhost:9000', 'https://localhost:9000']);
        equal('[::1]/jf', ['http://[::1]:8096/jf', 'https://[::1]/jf', 'http://[::1]/jf']);
        equal('https://192.168.1.8:9000/base/', ['https://192.168.1.8:9000/base']);
        equal('http://media.example/base', ['http://media.example/base']);
        let invalid = Promise.resolve();
        for (const input of ['', 'ftp://media.example', 'https://user:pass@media.example', 'media.example?q=1',
            'media.example#fragment', 'media.example:0', 'media.example:65536', 'media.example\\evil',
            'bad host', 'http://999.1.1.1', 'http://[:::1]', 'https://%65vil.example']) {
            invalid = invalid.then(() => fails(() => login.serverCandidates({ server: input }), 'invalid_server'));
        }
        return invalid.then(() => login.discover({}, {
            discover: () => Promise.resolve([
                { address: '192.168.1.8', text: JSON.stringify({ Id: 'literal', Address: 'https://10.0.0.9:9443/jf' }) },
                { address: '192.168.1.8', text: JSON.stringify({ Id: 'dns', Address: 'https://media.example:9443/jf' }) },
                { address: 'fd00::8', text: JSON.stringify({ Id: 'ipv6', Address: 'http://[fd00::9]:8096/base' }) },
                { address: '192.168.1.8', text: JSON.stringify({ Id: 'bad', Address: 'http://user@host' }) }
            ])
        })).then(result => {
            check(result.servers.length === 3, 'invalid announcement addresses are ignored');
            check(result.servers.find(entry => entry.id === 'literal').address === 'https://192.168.1.8:9443/jf',
                'UDP sender replaces a literal host without losing TLS, port or base path');
            check(result.servers.find(entry => entry.id === 'dns').address === 'https://media.example:9443/jf',
                'UDP sender does not override a DNS reverse proxy');
            check(result.servers.find(entry => entry.id === 'ipv6').address === 'http://[fd00::8]:8096/base',
                'IPv6 sender is correctly bracketed');
        });
    }).then(() => {
        step = 'Quick Connect availability';
        const login = createSource({}, { device: device });
        let sequence = Promise.resolve();
        for (const availability of [true, false, 'true', undefined, 'failure']) {
            const routes = {
                'GET /System/Info/Public': { Id: 'server-id', ServerName: 'Home' },
                'GET /Users/Public': [{ Id: 'u1', Name: 'Ann' }],
                'POST /Users/AuthenticateByName': { AccessToken: 'new-token', ServerId: 'server-id', User: { Id: 'u1' } }
            };
            if (availability !== undefined)
                routes['GET /QuickConnect/Enabled'] = availability === 'failure' ? () => respond({}, 503) : availability;
            const setup = server(routes);
            sequence = sequence.then(() => login.probe({ server: 'https://media.example/jf' }, setup.host)).then(info => {
                check(info.quickConnectEnabled === (availability === true), 'only affirmative availability enables code login');
                check(info.quickConnectAvailable === (typeof availability === 'boolean'),
                    'failed, malformed or unsupported availability is retryable');
                check(info.users[0].id === 'u1', 'availability failures do not hide password users');
                return login.authenticate({ server: info.server, username: 'Ann', password: 'right' }, setup.host);
            }).then(account => check(account.configuration.token === 'new-token', 'password sign-in remains usable'));
        }
        return sequence;
    });
}

export function run() {
    step = 'inherited artwork owners';
    const inherited = { Id: 'episode', Type: 'Episode', SeriesId: 'series',
        ParentBackdropItemId: 'series', ParentBackdropImageTags: ['series-backdrop'],
        ParentThumbItemId: 'season', ParentThumbImageTag: 'season-thumb' };
    const inheritedImages = item(inherited, { artworkOwners: true });
    check(inheritedImages.backdropItemId === 'series' && inheritedImages.backdropTag === 'series-backdrop'
        && inheritedImages.thumbItemId === 'season' && inheritedImages.thumbTag === 'season-thumb',
        'inherited thumbnail and backdrop keep their distinct owners');
    const ownImages = item(Object.assign({}, inherited, { ImageTags: { Thumb: 'own-thumb' },
        BackdropImageTags: ['own-backdrop'] }), { artworkOwners: true });
    check(!ownImages.thumbItemId && !ownImages.backdropItemId && ownImages.thumbTag === 'own-thumb'
        && ownImages.backdropTag === 'own-backdrop', 'own images never inherit a parent owner');
    const ownerless = item({ Id: 'episode', ParentThumbImageTag: 'unknown',
        ParentBackdropImageTags: ['unknown'] }, { artworkOwners: true });
    check(!ownerless.thumbTag && !ownerless.backdropTag, 'unknown parent ownership cannot create a child image URL');
    step = 'server address';
    check(normalizeServer('https://jf.example/base/') === 'https://jf.example/base', 'trailing slashes go');
    check(normalizeServer('http://jf.local:9000') === 'http://jf.local:9000', 'an explicit port stays');
    step = 'quality profile';
    const restricted = deviceProfile({ maxBitrate: 500000, maxHeight: 720,
        preferredMaxHeight: 2160, restrictVideoCodecs: true, videoCodecs: ['mpeg2video'] }, false);
    check(restricted.MaxStreamingBitrate === 500000 && restricted.MaxStaticBitrate === 500000,
        'an explicit low bitrate ceiling is not raised');
    check(restricted.TranscodingProfiles.length === 0,
        'an output codec outside the device allowlist is never invented');
    check(restricted.CodecProfiles[0].Conditions[0].Value === '720'
        && restricted.CodecProfiles[0].Conditions[0].IsRequired,
        'the player height override remains mandatory');

    const a = account('ua', 'token-a');
    const b = account('ub', 'token-b');

    const film = { Id: 'film', Name: 'Film', Type: 'Movie', ProductionYear: 2020, RunTimeTicks: 72000000000,
        ProviderIds: { Imdb: 'tt1' }, UserData: { IsFavorite: true, PlaybackPositionTicks: 500 },
        ParentIndexNumber: 0, MediaSources: [
            { Id: 'extended', Name: 'Extended', Path: '/srv/private/Film (Extended).mkv', Size: 9007199254740993,
                Container: 'mkv', MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: 2160 }] },
            { Id: 'theatrical', Name: 'Theatrical', Path: 'D:\\media\\Film.mp4', Container: 'mp4' }] };
    const jf = server({
        'GET /Items': () => respond({ TotalRecordCount: 3, Items: [film] }),
        'GET /Users/ua': { Policy: { EnableContentDeletion: true } },
        'GET /Users/ua/Items/list-1': { Id: 'list-1', Type: 'Playlist', CanEditItems: true },
        'GET /Playlists/list-1/Users/ua': { CanEdit: true },
        'GET /Users/ua/Items/Latest': [film, { Id: 'show', Name: 'Show', Type: 'Series' }],
        'GET /Users/ua/Items/film': film,
        'GET /Users/ua/Views': { Items: [{ Id: 'movies', Name: 'Movies', CollectionType: 'movies',
            ImageTags: { Primary: 'p' } }] },
        'POST /Items/film/PlaybackInfo': call => respond({ PlaySessionId: 'session', MediaSources: [
            { Id: 'theatrical', SupportsDirectPlay: true, Container: 'mp4' },
            { Id: 'extended', SupportsDirectPlay: call.body.MediaSourceId !== 'extended',
                SupportsDirectStream: false, Container: 'mkv',
                TranscodingUrl: call.body.EnableDirectPlay ? '/videos/film/master.m3u8?x=1'
                                                         : 'https://elsewhere.example/steal.m3u8' }] }),
        'GET /MediaSegments/film': { Items: [{ Type: 'Intro', StartTicks: 0, EndTicks: 100 }, { Type: 'Unknown' }] },
        'POST /Playlists': {},
        'POST /Playlists/list-1/Items': {},
        'DELETE /Items/film': {},
        'POST /SyncPlay/Seek': {},
        'GET /GetUtcTime': { RequestReceptionTime: '2026-01-01T00:00:00.0000000Z',
            ResponseTransmissionTime: '2026-01-01T00:00:00.0010000Z' },
        'POST /Sessions/Playing': {}
    });

    step = 'browse';
    return extensionCompatibility().then(baselineRepairs).then(catalogueContracts)
        .then(() => settingsContracts()).then(() => remoteContracts()).then(() => {
        step = 'browse';
        return Promise.all([a.browse({ limit: 1 }, jf.host), b.browse({ limit: 1 }, jf.host)]);
    })
        .then(pages => {
            const page = pages[0];
            check(page.total === 3 && !page.exhausted && page.cursor === '1', 'paging from TotalRecordCount');
            const item = page.items[0];
            check(item.externalIds.Imdb === 'tt1' && item.resumeTicks === '500' && item.favorite, 'user data');
            check(item.season === 0, 'season zero (specials) is kept');
            const auth = jf.calls.map(c => c.options.headers.Authorization);
            check(auth[0].indexOf('Token="token-a"') >= 0 && auth[1].indexOf('Token="token-b"') >= 0,
                'each account sends its own token');
            check(auth[0].indexOf('Device="Living Room"') >= 0, 'header values cannot break out of quotes');
            return a.browse({ limit: 1, cursor: page.cursor }, jf.host);
        }).then(() => {
            check(jf.calls[jf.calls.length - 1].url.indexOf('StartIndex=1') > 0, 'the cursor is the next offset');
            return fails(() => a.browse({ cursor: '../1' }, jf.host), 'invalid_cursor');
        }).then(() => {
            step = 'speed test endpoint';
            const nested = createSource({ server: 'https://media.example/proxy/jellyfin///',
                userId: 'ua', token: 'token-a' }, { device: device, extensions: { 'spool.speed-test': 1 } });
            return Promise.all([account('ua', 'token-a', { 'spool.speed-test': 1 }).speedTest({}, jf.host),
                account('ub', 'token-b', { 'spool.speed-test': 1 }).speedTest({}, jf.host), nested.speedTest({}, jf.host)]);
        }).then(() => {
            const first = jf.speedTests[0];
            check(first.url.replace('{bytes}', '524288').replace('{nonce}', 'warmup-1')
                === 'https://media.example/jf/Playback/BitrateTest?size=524288&_=warmup-1',
                'the byte count and cache nonce reach the authenticated benchmark endpoint');
            check(jf.speedTests[2].url
                === 'https://media.example/proxy/jellyfin/Playback/BitrateTest?size={bytes}&_={nonce}',
                'a nested reverse-proxy base path survives normalization');
            check(first.headers.Authorization === jf.calls[0].options.headers.Authorization
                && jf.speedTests[1].headers.Authorization === jf.calls[1].options.headers.Authorization,
                'benchmarks use the same sanitized, per-account authorization as API requests');
            check(jf.speedTests.every(call => call.url.indexOf('token-') < 0),
                'benchmark URLs contain no account token');
        }).then(() => {
            step = 'lists';
            return a.latest({ limit: 5 }, jf.host);
        }).then(page => {
            check(page.items.length === 2 && page.exhausted, 'latest is a plain array');
            return a.libraries({}, jf.host);
        }).then(result => {
            check(result.items[0].collectionType === 'movies' && result.items[0].posterTag === 'p', 'libraries');
            step = 'details';
            return a.details({ itemId: 'film' }, jf.host);
        }).then(result => {
            const variants = result.item.variants;
            check(variants[0].filename === 'Film (Extended).mkv' && variants[1].filename === 'Film.mp4',
                'only file names leave the server');
            check(JSON.stringify(result).indexOf('private') < 0, 'no server paths');
            check(variants[0].sizeBytes === undefined, 'unsafe sizes are dropped, not rounded');
            check(result.item.runtimeTicks === '72000000000', 'ticks are decimal strings');
            return fails(() => a.details({ itemId: '' }, jf.host), 'missing_id');
        }).then(() => {
            step = 'resolve';
            return a.resolve({ itemId: 'film', variantId: 'theatrical', positionTicks: '0', maxBitrate: 0,
                videoCodecs: ['h264'], restrictVideoCodecs: true }, jf.host);
        }).then(result => {
            check(result.variantId === 'theatrical' && result.playMethod === 'DirectPlay', 'direct play');
            check(result.url.indexOf('https://media.example/jf/Videos/film/stream?') === 0
                && result.url.indexOf('MediaSourceId=theatrical') > 0 && result.url.indexOf('DeviceId=device-1') > 0,
                'stream URL');
            check(result.headers.Authorization.indexOf('Token="token-a"') >= 0
                && result.headers.Authorization.indexOf('DeviceId="device-1"') >= 0, 'stream credentials include device identity');
            check(result.segments.length === 1 && result.segments[0].type === 'Intro', 'known segments only');
            const info = jf.calls.filter(c => c.path === '/Items/film/PlaybackInfo').pop().body;
            check(info.MediaSourceId === 'theatrical' && info.DeviceProfile, 'the edition and profile are sent');
            return a.resolve({ itemId: 'film', variantId: 'extended', positionTicks: '0' }, jf.host);
        }).then(result => {
            check(result.playMethod === 'Transcode'
                && result.url === 'https://media.example/jf/videos/film/master.m3u8?x=1', 'relative transcode');
            return fails(() => a.resolve({ itemId: 'film', variantId: 'extended', positionTicks: '0', forceTranscode: true },
                jf.host), 'cross_origin_stream');
        }).then(() => fails(() => a.resolve({ itemId: 'film', variantId: 'missing', positionTicks: '0' }, jf.host),
            'selected_variant_unavailable'))
        .then(() => {
            step = 'bandwidth precedence';
            const cases = [
                { name: 'automatic uses the measured ceiling', context: { measuredBitrate: 36000000 }, expected: 36000000 },
                { name: 'manual preference beats measurement',
                    context: { preferredMaxBitrate: 20000000, measuredBitrate: 36000000 }, expected: 20000000 },
                { name: 'session override beats manual and measured ceilings',
                    context: { maxBitrate: 8000000, preferredMaxBitrate: 20000000, measuredBitrate: 36000000 },
                    expected: 8000000 },
                { name: 'local unlimited beats manual and measured ceilings',
                    context: { unlimitedLocalNetwork: true, preferredMaxBitrate: 20000000, measuredBitrate: 36000000 },
                    endpoint: { IsLocal: true }, expected: 1000000000 },
                { name: 'server network classification also permits unlimited',
                    context: { unlimitedLocalNetwork: true, measuredBitrate: 36000000 },
                    endpoint: { IsLocal: false, IsInNetwork: true }, expected: 1000000000 },
                { name: 'session override still beats local unlimited',
                    context: { maxBitrate: 8000000, unlimitedLocalNetwork: true, preferredMaxBitrate: 20000000,
                        measuredBitrate: 36000000 }, endpoint: { IsLocal: true }, expected: 8000000 },
                { name: 'remote routes are not made unlimited',
                    context: { unlimitedLocalNetwork: true, measuredBitrate: 36000000 },
                    endpoint: { IsLocal: false, IsInNetwork: false }, expected: 36000000 },
                { name: 'failed classification keeps the measured ceiling',
                    context: { unlimitedLocalNetwork: true, measuredBitrate: 36000000 }, expected: 36000000 },
                { name: 'unmeasured automatic retains the fallback', context: {}, expected: 120000000 }
            ];
            return cases.reduce((pending, example) => pending.then(() => {
                step = 'bandwidth: ' + example.name;
                const playback = server({
                    'GET /System/Endpoint': example.endpoint,
                    'POST /Items/film/PlaybackInfo': call => {
                        const body = call.body;
                        check(body.MaxStreamingBitrate === example.expected
                            && body.DeviceProfile.MaxStreamingBitrate === example.expected
                            && body.DeviceProfile.MaxStaticBitrate === example.expected,
                            'playback negotiation and device profile agree on the effective ceiling');
                        return respond({ MediaSources: [{ Id: 'theatrical', SupportsDirectPlay: true }] });
                    }
                });
                return a.resolve(Object.assign({ itemId: 'film' }, example.context), playback.host);
            }), Promise.resolve());
        })
        .then(() => {
            step = 'quality cannot fall back to the original stream';
            const playback = server({
                'POST /Items/film/PlaybackInfo': { MediaSources: [
                    { Id: 'theatrical', SupportsDirectStream: true }
                ] }
            });
            return fails(() => a.resolve({ itemId: 'film', forceTranscode: true, maxBitrate: 1000000 },
                playback.host), 'selected_variant_unplayable');
        }).then(() => {
            step = 'remux uses the negotiated stream, not the static original';
            const playback = server({
                'POST /Items/film/PlaybackInfo': { MediaSources: [
                    { Id: 'theatrical', SupportsDirectStream: true,
                        DirectStreamUrl: '/videos/film/stream.mkv?VideoCodec=copy&AudioCodec=aac',
                        TranscodingUrl: '/videos/film/master.m3u8' }
                ] }
            });
            return a.resolve({ itemId: 'film', preferRemux: true }, playback.host);
        }).then(result => {
            check(result.playMethod === 'DirectStream'
                && result.url === 'https://media.example/jf/videos/film/stream.mkv?VideoCodec=copy&AudioCodec=aac',
                'server-selected remux preserves its codec negotiation');
        })
        .then(() => {
            step = 'report';
            return a.report({ event: 'start', itemId: 'film', variantId: 'theatrical', playSessionId: 'session',
                playMethod: 'DirectPlay', positionTicks: '10', rate: 1, audioStreamIndex: -1,
                subtitleStreamIndex: 2 }, jf.host);
        }).then(() => {
            const body = jf.calls[jf.calls.length - 1].body;
            check(body.PositionTicks === 10 && body.AudioStreamIndex === undefined && body.SubtitleStreamIndex === 2,
                'report body');
            return fails(() => a.report({ event: 'bogus' }, jf.host), 'invalid_report');
        }).then(() => {
            step = 'item actions';
            return a.runItemAction({ action: 'playlist', itemId: 'film', itemType: 'Movie' }, jf.host);
        }).then(result => {
            check(result.pick && result.pick.kind === 'playlist', 'adding asks where first');
            return a.runItemAction({ action: 'playlist', itemId: 'film', newName: 'Weekend' }, jf.host);
        }).then(result => {
            check(jf.calls[jf.calls.length - 1].body.Ids[0] === 'film', 'with the item in it');
            return a.runItemAction({ action: 'playlist', itemId: 'film', targetId: 'list-1', targetName: 'Mine' },
                jf.host);
        }).then(result => {
            return a.runItemAction({ action: 'delete', itemId: 'film' }, jf.host);
        }).then(result => {
            check(result.pick && result.pick.kind === 'confirm', 'deleting asks first');
            check(!jf.calls.some(c => c.method === 'DELETE'), 'and deletes nothing until confirmed');
            return a.runItemAction({ action: 'delete', itemId: 'film', confirmed: true }, jf.host);
        }).then(result => {
            check(result.changed, 'a confirmed delete reports a change');
            return fails(() => a.runItemAction({ action: 'explode', itemId: 'film' }, jf.host), 'unsupported_action');
        }).then(() => {
            step = 'group';
            return a.groupSend({ action: 'seek', positionTicks: '9007199254740993' }, jf.host);
        }).then(() => {
            check(jf.calls[jf.calls.length - 1].path === '/SyncPlay/Seek', 'seek goes to SyncPlay');
            return fails(() => a.groupSend({ action: 'teleport' }, jf.host), 'invalid_group_action');
        }).then(() => a.clock({}, jf.host)).then(clock => {
            check(clock.received === Date.UTC(2026, 0, 1) && clock.sent === clock.received + 1, 'server clock');
        }).then(() => {
            step = 'browse filters';
            return a.browse({ parentId: 'movies', collectionType: 'movies', limit: 10, sortBy: 'DateCreated',
                filters: { filters: ['IsUnplayed'], genres: ['Drama', 'Sci-Fi'], years: ['2020', '2021'], isHd: true,
                    is3D: false, alphabet: '#' } }, jf.host);
        }).then(() => {
            const url = jf.calls[jf.calls.length - 1].url;
            check(url.indexOf('filters=IsUnplayed') > 0 && url.indexOf('genres=Drama%7CSci-Fi') > 0
                && url.indexOf('years=2020%2C2021') > 0 && url.indexOf('isHd=true') > 0, 'filters reach the server');
            check(url.indexOf('is3D') < 0 && url.indexOf('NameLessThan=A') > 0 && url.indexOf('SortBy=DateCreated') > 0,
                'unset filters stay off, # is before A');
            step = 'errors';
            return fails(() => a.libraries({}, { device: device, http: () => respond({}, 401) }), 'http_401');
        }).then(() => {
            step = 'sign in';
            const login = createSource({}, { device: device });
            const setup = server({
                'GET /System/Info/Public': { Id: 'server-id', ServerName: 'Home', Version: '10.10.0' },
                'GET /Users/Public': [{ Id: 'u1', Name: 'Ann', HasPassword: false, PrimaryImageTag: 't' }],
                'POST /Users/AuthenticateByName': call => call.body.Pw === 'right'
                    ? respond({ AccessToken: 'new-token', ServerId: 'server-id', User: { Id: 'u1', Name: 'Ann' } })
                    : respond({}, 401)
            });
            return login.probe({ server: 'http://jf.local:8096' }, setup.host).then(info => {
                check(info.server === 'http://jf.local:8096' && info.name === 'Home', 'probe finds the server');
                check(info.users[0].hasPassword === false && info.users[0].image.indexOf('/Users/u1/Images') > 0,
                    'public users');
                check(setup.calls[0].options.headers.Authorization.indexOf('Token=') < 0, 'no token before sign-in');
                return fails(() => login.authenticate({ server: 'http://jf.local:8096', username: 'Ann', password: 'wrong' },
                    setup.host), 'http_401');
            }).then(() => login.authenticate({ server: 'http://jf.local:8096', username: 'Ann', password: 'right' }, setup.host))
                .then(result => {
                    check(result.account === 'u1@server-id' && result.group === 'server-id', 'account identity');
                    check(result.label === 'Ann' && result.detail === 'Home', 'account label');
                    check(result.configuration.token === 'new-token'
                        && result.configuration.server === 'http://jf.local:8096', 'configuration');
                });
        }).then(() => {
            step = 'events';
            const events = [];
            const emit = (type, payload) => events.push([type, payload]);
            translate({ MessageType: 'SyncPlayCommand', Data: { Command: 'Pause', When: '2026-01-01T00:00:00.1234567Z',
                PositionTicks: 50, PlaylistItemId: 'e1' } }, emit);
            translate({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'UserJoined', Data: 'Ben' } }, emit);
            translate({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupDoesNotExist', Data: '' } }, emit);
            translate({ MessageType: 'Playstate', Data: { Command: 'Seek', SeekPositionTicks: 7 } }, emit);
            translate({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '40' } } }, emit);
            translate({ MessageType: 'GeneralCommand', Data: { Name: 'Unknown' } }, emit);
            translate({ MessageType: 'LibraryChanged', Data: {} }, emit);
            check(events.length === 6, 'unknown commands are dropped');
            check(events[0][1].command === 'pause' && events[0][1].at === Date.UTC(2026, 0, 1, 0, 0, 0, 123)
                && events[0][1].positionTicks === '50', 'group command');
            check(events[1][1].type === 'participantJoined' && events[1][1].name === 'Ben', 'participants');
            check(events[2][1].code === 'group_missing', 'group errors');
            check(events[3][1].command === 'seek' && events[3][1].positionTicks === '7', 'remote seek');
            check(events[4][1].command === 'volume' && events[4][1].value === 40, 'remote volume');
            check(events[5][0] === 'changed', 'library changes');

            // The socket: opened with the account's credentials, kept alive once.
            const sockets = [];
            const sent = [];
            let wake = [];
            const host = { emit: emit, delay: () => new Promise(resolve => wake.push(resolve)),
                socket: (url, options) => {
                    const socket = { url: url, options: options, send: text => sent.push(JSON.parse(text)),
                        close: () => {} };
                    sockets.push(socket);
                    return socket;
                } };
            const stop = connect(host, 'wss://media.example/jf/socket?api_key=t', { Authorization: 'x' });
            const socket = sockets[0];
            socket.onopen();
            socket.onmessage(JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 60 }));
            socket.onmessage(JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 60 }));
            socket.onmessage('not json');
            const waiting = wake;
            wake = [];
            waiting.forEach(resolve => resolve());
            return Promise.resolve().then(() => null).then(() => {
                check(sent.filter(m => m.MessageType === 'KeepAlive').length === 3, 'one keep-alive loop at a time');
                socket.onclose();
                check(wake.length === 2, 'a dropped socket waits before reconnecting');
                stop();
            });
        });
}
