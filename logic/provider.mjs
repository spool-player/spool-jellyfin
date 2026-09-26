// SPDX-License-Identifier: MPL-2.0
// Jellyfin for Spool: one source per signed-in user.

import { collectionTypes, detailFields, fields, item, page, segments, stream, time, trickplay } from './items.mjs';
import { deviceProfile, maxBitrate } from './profile.mjs';
import { connect } from './events.mjs';

const remoteCommands = ['MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'PageUp', 'PageDown', 'PreviousLetter',
    'NextLetter', 'Select', 'Back', 'SendKey', 'SendString', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute',
    'ToggleMute', 'SetVolume', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleOsd', 'ToggleOsdMenu',
    'ToggleContextMenu', 'ToggleStats', 'ToggleFullscreen', 'GoHome', 'GoToSettings', 'GoToSearch',
    'DisplayContent', 'DisplayMessage', 'SetRepeatMode', 'SetShuffleQueue', 'SetPlaybackOrder',
    'SetMaxStreamingBitrate', 'Play'];

// sdk BrowseFilters keys this server takes as they are (its query names are
// case-insensitive); lists of names are joined with |, the rest with commas.
const browseFilters = ['filters', 'genres', 'officialRatings', 'tags', 'years', 'studioIds', 'seriesStatus',
    'videoTypes', 'includeItemTypes', 'isHd', 'is4K', 'is3D', 'hasSubtitles', 'hasTrailer', 'hasSpecialFeature',
    'hasThemeSong', 'hasThemeVideo', 'isMissing', 'isUnaired'];
const pipeLists = ['genres', 'officialRatings', 'tags', 'studioIds'];

function quoted(value) {
    return String(value || '').replace(/["\\\r\n]/g, '');
}

function query(values) {
    return Object.keys(values).filter(key => values[key] !== undefined && values[key] !== null && values[key] !== '')
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key]))).join('&');
}

function segment(value) {
    if (typeof value !== 'string' || !value)
        throw new Error('missing_id');
    return encodeURIComponent(value);
}

function start(args) {
    const cursor = args.cursor ? String(args.cursor) : '0';
    if (!/^\d+$/.test(cursor))
        throw new Error('invalid_cursor');
    return Number(cursor);
}

export function normalizeServer(input) {
    let text = String(input || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(text))
        text = 'http://' + text;
    // A bare host gets Jellyfin's default port.
    if (/^http:\/\/[^/:]+$/i.test(text))
        text += ':8096';
    return text;
}

export function createSource(configuration, sourceHost) {
    const server = configuration.server ? normalizeServer(configuration.server) : '';
    const device = sourceHost.device || {};
    let token = configuration.token || '';
    let userId = configuration.userId || '';

    function authorization(overrideToken) {
        const value = overrideToken === undefined ? token : overrideToken;
        return 'MediaBrowser Client="Spool", Device="' + quoted(device.name || 'Spool') + '", DeviceId="'
            + quoted(device.id || 'spool') + '", Version="' + quoted(device.version || '0') + '"'
            + (value ? ', Token="' + quoted(value) + '"' : '');
    }

    // `base` lets sign-in talk to a server before the account exists.
    function request(host, method, path, parameters, body, base) {
        const suffix = query(parameters || {});
        return host.http((base || server) + path + (suffix ? '?' + suffix : ''), {
            method: method,
            headers: { Authorization: authorization(base ? '' : undefined), 'Content-Type': 'application/json',
                Accept: 'application/json' },
            body: body === undefined ? '' : JSON.stringify(body)
        }).then(response => {
            if (response.status < 200 || response.status >= 300)
                throw new Error('http_' + response.status);
            return response.body ? JSON.parse(response.body) : {};
        });
    }

    const userPath = path => '/Users/' + segment(userId) + path;

    function list(host, path, args, parameters) {
        const first = start(args);
        const limit = Math.min(Math.max(args.limit || 72, 1), 100);
        const values = Object.assign({ UserId: userId, Fields: fields, EnableImageTypes: 'Primary,Backdrop,Logo,Thumb',
            ImageTypeLimit: 1, EnableUserData: true }, parameters || {}, { StartIndex: first, Limit: limit });
        return request(host, 'GET', path, values).then(result => page(result, first, limit));
    }

    function signIn(host, base, path, body) {
        return request(host, 'POST', path, {}, body, base).then(result => {
            if (!result.AccessToken || !result.User || !result.User.Id)
                throw new Error('invalid_credentials');
            return request(host, 'GET', '/System/Info/Public', {}, undefined, base).then(info => ({
                account: result.User.Id + '@' + (result.ServerId || info.Id || base),
                group: result.ServerId || info.Id || base,
                label: result.User.Name || '',
                detail: info.ServerName || base.replace(/^https?:\/\//, ''),
                configuration: { server: base, userId: result.User.Id, token: result.AccessToken,
                    userName: result.User.Name || '', serverId: result.ServerId || info.Id || '',
                    serverName: info.ServerName || '' }
            }));
        });
    }

    // Live updates, group playback and remote commands arrive here.
    let disconnect = null;
    if (server && token && sourceHost.socket) {
        const socketUrl = server.replace(/^http/i, 'ws') + '/socket?' + query({ api_key: token, deviceId: device.id });
        disconnect = connect(sourceHost, socketUrl, { Authorization: authorization() });
        // Tell the server what this client can be asked to do.
        sourceHost.http(server + '/Sessions/Capabilities/Full', {
            method: 'POST',
            headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: remoteCommands,
                SupportsMediaControl: true, SupportsPersistentIdentifier: true })
        }).then(() => {}, () => {});
    }

    function groupAction(host, path, body) {
        return request(host, 'POST', '/SyncPlay/' + path, {}, body || {}).then(() => ({}));
    }

    return {
        describe: () => ({
            artwork: server + '/Items/{itemId}/Images/{type}?tag={tag}&maxWidth={width}&quality={quality}&format={format}',
            trickplay: server + '/Videos/{itemId}/Trickplay/{width}/{index}.jpg?MediaSourceId={variantId}'
        }),

        // Sign-in. These run before the account exists, against `server`
        // given in the arguments, once the screen has allowed that origin.
        discover: (args, host) => host.discover({ port: 7359, message: 'who is JellyfinServer?', timeout: 1500 })
            .then(replies => {
                const servers = {};
                for (const reply of replies) {
                    try {
                        const info = JSON.parse(reply.text);
                        if (info.Id && info.Address)
                            servers[info.Id] = { id: info.Id, name: info.Name || info.Address, address: info.Address };
                    } catch (error) {}
                }
                return { servers: Object.values(servers) };
            }),
        probe: (args, host) => {
            const base = normalizeServer(args.server);
            return request(host, 'GET', '/System/Info/Public', {}, undefined, base).then(info => {
                if (!info.Id)
                    throw new Error('not_jellyfin');
                return request(host, 'GET', '/Users/Public', {}, undefined, base).then(users => ({
                    server: base, id: info.Id, name: info.ServerName || '', version: info.Version || '',
                    users: (Array.isArray(users) ? users : []).map(u => ({ id: u.Id, name: u.Name,
                        image: u.PrimaryImageTag ? base + '/Users/' + u.Id + '/Images/Primary?tag=' + u.PrimaryImageTag + '&maxWidth=160' : '',
                        hasPassword: u.HasPassword !== false }))
                }), () => ({ server: base, id: info.Id, name: info.ServerName || '', users: [] }));
            });
        },
        authenticate: (args, host) => signIn(host, normalizeServer(args.server), '/Users/AuthenticateByName',
            { Username: args.username, Pw: args.password || '' }),
        quickConnectStart: (args, host) => {
            const base = normalizeServer(args.server);
            return request(host, 'POST', '/QuickConnect/Initiate', {}, undefined, base)
                .then(result => ({ code: result.Code, secret: result.Secret }));
        },
        quickConnectPoll: (args, host) => {
            const base = normalizeServer(args.server);
            return request(host, 'GET', '/QuickConnect/Connect', { Secret: args.secret }, undefined, base).then(result => {
                if (!result.Authenticated)
                    return { authenticated: false };
                return signIn(host, base, '/Users/AuthenticateWithQuickConnect', { Secret: args.secret })
                    .then(account => ({ authenticated: true, account: account }));
            });
        },

        libraries: (args, host) => request(host, 'GET', userPath('/Views')).then(result => ({
            items: (result.Items || []).map(row => ({ id: row.Id, title: row.Name || '',
                collectionType: row.CollectionType || '', posterTag: (row.ImageTags || {}).Primary || '' }))
        })),
        browse: (args, host) => {
            const filters = args.filters || {};
            const parameters = { ParentId: args.parentId, Recursive: args.recursive !== false,
                IncludeItemTypes: collectionTypes[args.collectionType], SortBy: args.sortBy || 'SortName',
                SortOrder: args.sortOrder || 'Ascending', Genres: args.genre, Studios: args.studio };
            for (const key of browseFilters) {
                const value = filters[key];
                if (value !== undefined && value !== null && value !== false)
                    parameters[key] = Array.isArray(value) ? value.join(pipeLists.indexOf(key) >= 0 ? '|' : ',') : value;
            }
            if (filters.specialEpisode)
                parameters.ParentIndexNumber = 0;
            if (filters.alphabet === '#')
                parameters.NameLessThan = 'A';
            else if (filters.alphabet)
                parameters.NameStartsWith = filters.alphabet;
            return list(host, '/Items', args, parameters);
        },
        items: (args, host) => list(host, '/Items', args, { Ids: (args.ids || []).join(',') }),
        search: (args, host) => list(host, '/Items', args, { SearchTerm: args.query, Recursive: true,
            IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,Audio,MusicAlbum,MusicArtist,Book,AudioBook,BoxSet,Playlist' }),
        details: (args, host) => request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: detailFields })
            .then(raw => ({ item: item(raw) })),
        seasons: (args, host) => list(host, '/Shows/' + segment(args.seriesId) + '/Seasons', args),
        episodes: (args, host) => list(host, '/Shows/' + segment(args.seriesId) + '/Episodes', args,
            { SeasonId: args.seasonId, Fields: fields + ',MediaSources' }),
        resume: (args, host) => list(host, userPath('/Items/Resume'), args, { MediaTypes: 'Video' }),
        nextUp: (args, host) => list(host, '/Shows/NextUp', args),
        latest: (args, host) => {
            const limit = Math.min(Math.max(args.limit || 24, 1), 100);
            return request(host, 'GET', userPath('/Items/Latest'), { ParentId: args.parentId, Limit: limit,
                Fields: fields, EnableUserData: true }).then(rows => page(rows, 0, limit + 1));
        },
        similar: (args, host) => list(host, '/Items/' + segment(args.itemId) + '/Similar', args),
        personItems: (args, host) => list(host, '/Items', args, { PersonIds: args.personId, Recursive: true,
            SortBy: 'PremiereDate,ProductionYear,SortName', SortOrder: 'Descending' }),
        filterOptions: (args, host) => request(host, 'GET', '/Items/Filters', { UserId: userId, ParentId: args.parentId,
            IncludeItemTypes: collectionTypes[args.collectionType] }).then(result => ({
            genres: result.Genres || [], years: result.Years || [], officialRatings: result.OfficialRatings || [],
            tags: result.Tags || []
        })),
        speedTest: (args, host) => host.speedTest({
            url: server + '/Playback/BitrateTest?size={bytes}&_={nonce}',
            headers: { Authorization: authorization() }
        }),

        resolve: (args, host) => {
            // Only the server knows whether this connection is on its local network.
            // An unavailable classification must not turn an unknown route into an unlimited one.
            const localNetwork = args.unlimitedLocalNetwork && !args.maxBitrate
                ? request(host, 'GET', '/System/Endpoint').then(
                    endpoint => endpoint.IsLocal === true || endpoint.IsInNetwork === true, () => false)
                : Promise.resolve(false);
            const playbackInfo = localNetwork.then(local => request(host, 'POST',
                '/Items/' + segment(args.itemId) + '/PlaybackInfo', { UserId: userId }, {
                    UserId: userId, MediaSourceId: args.variantId, StartTimeTicks: Number(args.positionTicks) || 0,
                    MaxStreamingBitrate: maxBitrate(args, local), DeviceProfile: deviceProfile(args, local),
                    AudioStreamIndex: args.audioStreamIndex, SubtitleStreamIndex: args.subtitleStreamIndex,
                    EnableDirectPlay: !args.forceTranscode, EnableDirectStream: !args.forceTranscode,
                    EnableTranscoding: true, AutoOpenLiveStream: true, AllowVideoStreamCopy: true, AllowAudioStreamCopy: true
                }));
            // Trickplay and skip markers come from other endpoints; ask at once.
            const details = request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'Trickplay' })
                .then(raw => raw, () => null);
            const markers = request(host, 'GET', '/MediaSegments/' + segment(args.itemId)).then(segments, () => []);
            return Promise.all([playbackInfo, details, markers]).then(([info, raw, skip]) => {
                if (info.ErrorCode)
                    throw new Error('playback_unavailable');
                const sources = info.MediaSources || [];
                const source = args.variantId ? sources.find(s => s.Id === args.variantId) : sources[0];
                // Never swap in a different edition than the one asked for.
                if (!source)
                    throw new Error('selected_variant_unavailable');
                let url;
                let playMethod;
                const direct = !args.forceTranscode && (source.SupportsDirectPlay || (source.SupportsDirectStream && args.preferRemux));
                if (direct || (!source.TranscodingUrl && source.SupportsDirectStream)) {
                    url = server + '/Videos/' + segment(args.itemId) + '/stream?' + query({ static: true,
                        MediaSourceId: source.Id, DeviceId: device.id, PlaySessionId: info.PlaySessionId });
                    playMethod = source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream';
                } else if (source.TranscodingUrl) {
                    // A credential for this server never goes to another host.
                    if (/^https?:\/\//i.test(source.TranscodingUrl) && source.TranscodingUrl.indexOf(server + '/') !== 0)
                        throw new Error('cross_origin_stream');
                    url = /^https?:\/\//i.test(source.TranscodingUrl) ? source.TranscodingUrl
                                                                      : server + '/' + source.TranscodingUrl.replace(/^\/+/, '');
                    playMethod = 'Transcode';
                } else {
                    throw new Error('selected_variant_unplayable');
                }
                return { url: url, headers: { 'X-Emby-Token': token }, variantId: source.Id,
                    playSessionId: info.PlaySessionId || '', playMethod: playMethod,
                    container: (source.Container || '').split(',')[0], streams: (source.MediaStreams || []).map(stream),
                    segments: skip, trickplay: trickplay(raw, source.Id) };
            });
        },
        segments: (args, host) => request(host, 'GET', '/MediaSegments/' + segment(args.itemId))
            .then(result => ({ segments: segments(result) })),
        report: (args, host) => {
            const endpoint = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress',
                stop: '/Sessions/Playing/Stopped' }[args.event];
            if (!endpoint)
                throw new Error('invalid_report');
            const index = value => (Number.isInteger(value) && value >= 0 ? value : undefined);
            return request(host, 'POST', endpoint, {}, {
                ItemId: args.itemId, MediaSourceId: args.variantId, PlaySessionId: args.playSessionId,
                PositionTicks: Number(args.positionTicks) || 0, IsPaused: Boolean(args.paused),
                IsMuted: Boolean(args.muted), VolumeLevel: args.volume, PlaybackRate: args.rate || 1,
                PlayMethod: args.playMethod, AudioStreamIndex: index(args.audioStreamIndex),
                SubtitleStreamIndex: index(args.subtitleStreamIndex), CanSeek: true, Failed: Boolean(args.failed)
            }).then(() => ({}));
        },

        favorite: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/FavoriteItems/' + segment(args.itemId))).then(() => ({})),
        played: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/PlayedItems/' + segment(args.itemId))).then(() => ({})),
        progress: (args, host) => request(host, 'POST', userPath('/Items/' + segment(args.itemId) + '/UserData'), {},
            { PlaybackPositionTicks: Number(args.positionTicks) || 0 }).then(() => ({})),

        // Item menu actions from manifest.json; `pick` shows ui/Picker.qml.
        runItemAction: (args, host) => {
            const id = segment(args.itemId);
            switch (args.action) {
            case 'playlist':
            case 'collection':
                if (!args.targetId && !args.newName)
                    return { pick: { kind: args.action, itemId: args.itemId } };
                if (args.newName) {
                    return args.action === 'playlist'
                        ? request(host, 'POST', '/Playlists', {}, { Name: args.newName, Ids: [args.itemId], UserId: userId })
                            .then(() => ({ message: 'Added to ' + args.newName }))
                        : request(host, 'POST', '/Collections', { Name: args.newName, Ids: args.itemId })
                            .then(() => ({ message: 'Added to ' + args.newName }));
                }
                return request(host, 'POST', (args.action === 'playlist' ? '/Playlists/' : '/Collections/')
                    + segment(args.targetId) + '/Items', { Ids: args.itemId, UserId: userId })
                    .then(() => ({ message: 'Added to ' + (args.targetName || args.action) }));
            case 'rename':
                if (!args.newName)
                    return { pick: { kind: 'rename', itemId: args.itemId } };
                return request(host, 'GET', userPath('/Items/' + id)).then(raw => {
                    raw.Name = args.newName;
                    return request(host, 'POST', '/Items/' + id, {}, raw);
                }).then(() => ({ changed: true, itemId: args.itemId, message: 'Renamed' }));
            case 'delete':
                if (!args.confirmed)
                    return { pick: { kind: 'confirm', itemId: args.itemId } };
                return request(host, 'DELETE', '/Items/' + id).then(() => ({ changed: true, message: 'Deleted' }));
            default:
                throw new Error('unsupported_action');
            }
        },
        // Where an item could be added, for the picker.
        targets: (args, host) => request(host, 'GET', '/Items', { UserId: userId, Recursive: true,
            IncludeItemTypes: args.kind === 'playlist' ? 'Playlist' : 'BoxSet', SortBy: 'SortName', Limit: 500 })
            .then(result => ({ items: (result.Items || []).map(row => ({ id: row.Id, title: row.Name || '' })) })),

        groups: (args, host) => request(host, 'GET', '/SyncPlay/List').then(groups => ({
            items: (Array.isArray(groups) ? groups : []).map(g => ({ id: g.GroupId, name: g.GroupName || '',
                participants: g.Participants || [] }))
        })),
        groupCreate: (args, host) => groupAction(host, 'New', { GroupName: args.name }),
        groupJoin: (args, host) => groupAction(host, 'Join', { GroupId: args.groupId }),
        groupLeave: (args, host) => groupAction(host, 'Leave'),
        groupSend: (args, host) => {
            const entry = args.entryId || '00000000-0000-0000-0000-000000000000';
            switch (args.action) {
            case 'pause': return groupAction(host, 'Pause');
            case 'unpause': return groupAction(host, 'Unpause');
            case 'seek': return groupAction(host, 'Seek', { PositionTicks: Number(args.positionTicks) || 0 });
            case 'next': return groupAction(host, 'NextItem', { PlaylistItemId: entry });
            case 'previous': return groupAction(host, 'PreviousItem', { PlaylistItemId: entry });
            case 'play': return groupAction(host, 'SetPlaylistItem', { PlaylistItemId: entry });
            case 'setQueue': return groupAction(host, 'SetNewQueue', { PlayingQueue: args.itemIds,
                PlayingItemPosition: args.index, StartPositionTicks: Number(args.positionTicks) || 0 });
            case 'queue': return groupAction(host, 'Queue', { ItemIds: args.itemIds, Mode: args.next ? 'QueueNext' : 'Queue' });
            case 'move': return groupAction(host, 'MovePlaylistItem', { PlaylistItemId: entry, NewIndex: Math.max(0, args.index) });
            case 'remove': return groupAction(host, 'RemoveFromPlaylist', { PlaylistItemIds: args.entryIds,
                ClearPlaylist: false, ClearPlayingItem: false });
            case 'buffering': return groupAction(host, args.buffering ? 'Buffering' : 'Ready', {
                When: new Date(args.at).toISOString(), PositionTicks: Number(args.positionTicks) || 0,
                IsPlaying: Boolean(args.playing), PlaylistItemId: entry });
            case 'ping': return groupAction(host, 'Ping', { Ping: Math.round(args.ms) });
            default: throw new Error('invalid_group_action');
            }
        },
        clock: (args, host) => request(host, 'GET', '/GetUtcTime').then(result => ({
            received: time(result.RequestReceptionTime), sent: time(result.ResponseTransmissionTime)
        })),

        signOut: (args, host) => {
            if (disconnect)
                disconnect();
            return request(host, 'POST', '/Sessions/Logout').then(() => ({}), () => ({}));
        }
    };
}
