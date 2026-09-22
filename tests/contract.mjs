// SPDX-License-Identifier: MPL-2.0
// The provider against a scripted Jellyfin, in Qt's own JS engine
// (sdk/provider-contract-runner). Covers what Spool relies on: paging,
// per-account state, exact editions, stream safety, sign-in results, item
// actions, group commands and websocket translation.

import { createSource, normalizeServer } from '../logic/provider.mjs';
import { translate, connect } from '../logic/events.mjs';

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
    return {
        calls: calls,
        host: {
            device: device, delay: never,
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

function account(user, token) {
    return createSource({ server: 'https://media.example/jf', userId: user, token: token }, { device: device });
}

export function run() {
    step = 'server address';
    check(normalizeServer('jf.local') === 'http://jf.local:8096', 'a bare host gets the default port');
    check(normalizeServer('https://jf.example/base/') === 'https://jf.example/base', 'trailing slashes go');
    check(normalizeServer('http://jf.local:9000') === 'http://jf.local:9000', 'an explicit port stays');

    const a = account('ua', 'token-a');
    const b = account('ub', 'token-b');
    const templates = a.describe();
    check(templates.artwork.indexOf('https://media.example/jf/Items/{itemId}/Images/{type}?tag={tag}') === 0,
        'artwork template');
    check(templates.trickplay.indexOf('{variantId}') > 0, 'trickplay template');

    const film = { Id: 'film', Name: 'Film', Type: 'Movie', ProductionYear: 2020, RunTimeTicks: 72000000000,
        ProviderIds: { Imdb: 'tt1' }, UserData: { IsFavorite: true, PlaybackPositionTicks: 500 },
        ParentIndexNumber: 0, MediaSources: [
            { Id: 'extended', Name: 'Extended', Path: '/srv/private/Film (Extended).mkv', Size: 9007199254740993,
                Container: 'mkv', MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: 2160 }] },
            { Id: 'theatrical', Name: 'Theatrical', Path: 'D:\\media\\Film.mp4', Container: 'mp4' }] };
    const jf = server({
        'GET /Items': () => respond({ TotalRecordCount: 3, Items: [film] }),
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

    step = 'search';
    return Promise.all([a.search({ query: 'Film', limit: 1 }, jf.host), b.search({ query: 'Film', limit: 1 }, jf.host)])
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
            check(jf.calls[0].url.indexOf('SearchTerm=Film') > 0 && jf.calls[0].url.indexOf('Limit=1') > 0, 'query');
            return a.search({ query: 'Film', limit: 1, cursor: page.cursor }, jf.host);
        }).then(() => {
            check(jf.calls[jf.calls.length - 1].url.indexOf('StartIndex=1') > 0, 'the cursor is the next offset');
            return fails(() => a.search({ query: 'x', cursor: '../1' }, jf.host), 'invalid_cursor');
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
            check(result.headers['X-Emby-Token'] === 'token-a', 'stream credentials');
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
            check(result.message === 'Added to Weekend', 'a new playlist');
            check(jf.calls[jf.calls.length - 1].body.Ids[0] === 'film', 'with the item in it');
            return a.runItemAction({ action: 'playlist', itemId: 'film', targetId: 'list-1', targetName: 'Mine' },
                jf.host);
        }).then(result => {
            check(result.message === 'Added to Mine', 'an existing playlist');
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
            return login.probe({ server: 'jf.local' }, setup.host).then(info => {
                check(info.server === 'http://jf.local:8096' && info.name === 'Home', 'probe finds the server');
                check(info.users[0].hasPassword === false && info.users[0].image.indexOf('/Users/u1/Images') > 0,
                    'public users');
                check(setup.calls[0].options.headers.Authorization.indexOf('Token=') < 0, 'no token before sign-in');
                return fails(() => login.authenticate({ server: 'jf.local', username: 'Ann', password: 'wrong' },
                    setup.host), 'http_401');
            }).then(() => login.authenticate({ server: 'jf.local', username: 'Ann', password: 'right' }, setup.host))
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
