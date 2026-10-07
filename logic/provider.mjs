// SPDX-License-Identifier: MPL-2.0
// Jellyfin for Spool: one source per signed-in user.

import { collectionTypes, detailFields, fields, item as mapItem, page as mapPage, segments, stream, time, trickplay } from './items.mjs';
import { canCopySource, deviceProfile, maxBitrate } from './profile.mjs';
import { connect } from './events.mjs';
import { discoveryAddress, normalizeServer, serverCandidates } from './discovery.mjs';
import { tickInteger, wireJson } from './wire.mjs';
import { createCatalogue } from './catalogue.mjs';
import { createSettings } from './settings.mjs';
import { createRemote } from './remote.mjs';
import { createDownloads } from './downloads.mjs';

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

export { normalizeServer };

export function createSource(configuration, sourceHost) {
    const server = configuration.server ? normalizeServer(configuration.server) : '';
    const device = sourceHost.device || {};
    let token = configuration.token || '';
    let userId = configuration.userId || '';

    const declared = ["search", "userState", "reporting", "segments", "streamQuality", "trickplay", "discovery", "groupPlayback", "remoteControl", "downloads", "downloadTranscode", "artworkOwners", "speedTest", "suggestions", "itemActions", "collectionEditing", "playbackQueueReporting", "playbackPreferences", "settingsStorage", "remoteTargets"];
    const capabilities = {};
    for (const id of declared) {
        if (sourceHost.capabilities && sourceHost.capabilities[id] === true)
            capabilities[id] = true;
    }
    Object.freeze(capabilities);
    const features = Object.freeze({ artworkOwners: capabilities['artworkOwners'] === true });
    const item = raw => mapItem(raw, features);
    const page = (result, first, limit) => mapPage(result, first, limit, features);
    const userPath = path => '/Users/' + segment(userId) + path;

    const catalogue = createCatalogue({ request, list, userPath, segment, capabilities, userId });
    const settings = createSettings({ request, userPath, capabilities, userId });
    const downloads = createDownloads({ request, userPath, userId, device, server, authorization, query, segment });
    const remote = createRemote({ request, item, userPath, userId, device, capabilities, server, trickplay,
        authorization, emit: sourceHost.emit });

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
            body: body === undefined ? '' : wireJson(body)
        }).then(response => {
            if (response.status < 200 || response.status >= 300) {
                if (response.status === 401 || response.status === 403)
                    catalogue.invalidate();
                host.log('warn', 'Jellyfin request rejected', { status: response.status, method: method });
                throw new Error('http_' + response.status);
            }
            return response.body ? JSON.parse(response.body) : {};
        });
    }

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
            return request(host, 'GET', '/System/Info/Public', {}, undefined, base).then(info => {
                const serverId = result.ServerId || info.Id || base;
                const saved = configuration.setupAccount;
                if (configuration.setupContext && configuration.setupContext.purpose === 'reconnect'
                    && (!saved || saved.userId !== result.User.Id || (saved.serverId || saved.server) !== serverId))
                    throw new Error('account_mismatch');
                return {
                    account: result.User.Id + '@' + serverId,
                    group: serverId,
                    label: result.User.Name || '',
                    detail: info.ServerName || base.replace(/^https?:\/\//, ''),
                    configuration: { server: base, userId: result.User.Id, token: result.AccessToken,
                        userName: result.User.Name || '', serverId: serverId,
                        serverName: info.ServerName || '' }
                };
            });
        });
    }

    // Live updates, group playback and remote commands arrive here.
    let disconnect = null;
    if (server && token && sourceHost.socket) {
        const socketUrl = server.replace(/^http/i, 'ws') + '/socket?' + query({ api_key: token, deviceId: device.id });
        disconnect = connect(sourceHost, socketUrl, { Authorization: authorization() }, catalogue.invalidate,
            capabilities['remoteTargets'] === true);
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
        remoteTargets: remote.remoteTargets,
        remoteConnect: remote.remoteConnect,
        remoteState: remote.remoteState,
        remoteQueue: remote.remoteQueue,
        remoteCommand: remote.remoteCommand,
        remoteControls: remote.remoteControls,
        remoteControl: remote.remoteControl,
        describe: () => ({
            capabilities: capabilities,
            artwork: server + '/Items/{itemId}/Images/{type}?tag={tag}&maxWidth={width}&quality={quality}&format={format}'
        }),

        // Sign-in. These run before the account exists, against `server`
        // given in the arguments, once the screen has allowed that origin.
        setupContext: () => ({
            server: configuration.setupAccount && configuration.setupAccount.server
                ? normalizeServer(configuration.setupAccount.server) : ''
        }),
        discover: (args, host) => host.discover({ port: 7359, message: 'who is JellyfinServer?', timeout: 1500 })
            .then(replies => {
                const servers = {};
                for (const reply of replies) {
                    try {
                        const info = JSON.parse(reply.text);
                        if (info.Id && info.Address)
                            servers[info.Id] = { id: info.Id, name: info.Name || info.Address,
                                address: discoveryAddress(info.Address, reply.address) };
                    } catch (error) {}
                }
                return { servers: Object.values(servers) };
            }),
        serverCandidates: args => ({ servers: serverCandidates(args.server) }),
        probe: (args, host) => {
            const base = normalizeServer(args.server);
            return request(host, 'GET', '/System/Info/Public', {}, undefined, base).then(info => {
                if (!info.Id)
                    throw new Error('not_jellyfin');
                const users = request(host, 'GET', '/Users/Public', {}, undefined, base)
                    .then(rows => (Array.isArray(rows) ? rows : []).map(u => ({ id: u.Id, name: u.Name,
                        image: u.PrimaryImageTag ? base + '/Users/' + u.Id + '/Images/Primary?tag=' + u.PrimaryImageTag + '&maxWidth=160' : '',
                        hasPassword: u.HasPassword !== false })), () => []);
                const quickConnect = request(host, 'GET', '/QuickConnect/Enabled', {}, undefined, base)
                    .then(enabled => ({ quickConnectEnabled: enabled === true, quickConnectAvailable: typeof enabled === 'boolean' }),
                        () => ({ quickConnectEnabled: false, quickConnectAvailable: false }));
                return Promise.all([users, quickConnect]).then(([publicUsers, availability]) => Object.assign({
                    server: base, id: info.Id, name: info.ServerName || '', version: info.Version || '',
                    users: publicUsers
                }, availability));
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
        search: catalogue.search,
        suggestions: catalogue.suggestions,
        itemActions: catalogue.itemActions,
        collectionInfo: catalogue.collectionInfo,
        collectionEntries: catalogue.collectionEntries,
        collectionRemove: catalogue.collectionRemove,
        collectionMove: catalogue.collectionMove,
        preferencesRead: settings.preferencesRead,
        preferencesWrite: settings.preferencesWrite,
        dataInfo: settings.dataInfo,
        dataRead: settings.dataRead,
        dataWrite: settings.dataWrite,
        dataDelete: settings.dataDelete,
        details: (args, host) => request(host, 'GET', userPath('/Items/' + segment(args.itemId)),
            { Fields: args.videoPreviews ? detailFields : detailFields.replace(',Trickplay', '') })
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
        speedTest: (args, host) => {
            if (capabilities['speedTest'] !== true)
                throw new Error('unsupported_capability');
            return host.speedTest({
                url: server + '/Playback/BitrateTest?size={bytes}&_={nonce}',
                headers: { Authorization: authorization() }
            });
        },
        download: downloads.download,
        downloadRelease: downloads.downloadRelease,

        resolve: (args, host) => {
            const position = tickInteger(args.positionTicks);
            // Only the server knows whether this connection is on its local network.
            // An unavailable classification must not turn an unknown route into an unlimited one.
            const localNetwork = args.unlimitedLocalNetwork && !args.maxBitrate
                ? request(host, 'GET', '/System/Endpoint').then(
                    endpoint => endpoint.IsLocal === true || endpoint.IsInNetwork === true, () => false)
                : Promise.resolve(false);
            const playbackInfo = localNetwork.then(local => request(host, 'POST',
                '/Items/' + segment(args.itemId) + '/PlaybackInfo', { UserId: userId }, {
                    UserId: userId, MediaSourceId: args.variantId, StartTimeTicks: position,
                    MaxStreamingBitrate: maxBitrate(args, local), DeviceProfile: deviceProfile(args, local),
                    AudioStreamIndex: args.audioStreamIndex, SubtitleStreamIndex: args.subtitleStreamIndex,
                    EnableDirectPlay: !args.forceTranscode, EnableDirectStream: !args.forceTranscode,
                    EnableTranscoding: true, AutoOpenLiveStream: true,
                    AllowVideoStreamCopy: !args.forceTranscode, AllowAudioStreamCopy: true
                }));
            // Skip markers are useful without previews; sprite metadata is not.
            const details = args.videoPreviews
                ? request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'Trickplay' })
                    .then(raw => raw, () => null)
                : Promise.resolve(null);
            const markers = request(host, 'GET', '/MediaSegments/' + segment(args.itemId)).then(segments, () => []);
            return Promise.all([playbackInfo, details, markers, localNetwork]).then(([info, raw, skip, local]) => {
                if (info.ErrorCode)
                    throw new Error('playback_unavailable');
                const sources = info.MediaSources || [];
                const source = args.variantId ? sources.find(s => s.Id === args.variantId) : sources[0];
                // Never swap in a different edition than the one asked for.
                if (!source)
                    throw new Error('selected_variant_unavailable');
                let url;
                let playMethod;
                const copy = !args.forceTranscode && canCopySource(source, args, local);
                const remux = copy && source.SupportsDirectStream
                    && (args.preferRemux || !source.TranscodingUrl) && source.DirectStreamUrl;
                const negotiated = remux || source.TranscodingUrl;
                if (copy && source.SupportsDirectPlay) {
                    url = server + '/Videos/' + segment(args.itemId) + '/stream?' + query({ static: true,
                        MediaSourceId: source.Id, DeviceId: device.id, PlaySessionId: info.PlaySessionId });
                    playMethod = 'DirectPlay';
                } else if (negotiated) {
                    const videoCopy = /[?&]VideoCodec=copy(?:&|$)/i.test(negotiated);
                    if (!copy && videoCopy)
                        throw new Error('selected_variant_unplayable');
                    // A credential for this server never goes to another host.
                    if (/^https?:\/\//i.test(negotiated) && negotiated.indexOf(server + '/') !== 0)
                        throw new Error('cross_origin_stream');
                    url = /^https?:\/\//i.test(negotiated) ? negotiated
                                                         : server + '/' + negotiated.replace(/^\/+/, '');
                    playMethod = remux || videoCopy ? 'DirectStream' : 'Transcode';
                } else {
                    throw new Error('selected_variant_unplayable');
                }
                const preview = args.videoPreviews
                    ? trickplay(raw, source.Id, server, { Authorization: authorization() }) : undefined;
                if (host.isLogEnabled('trace'))
                    host.log('trace', 'Jellyfin playback preview availability',
                        { enabled: args.videoPreviews === true, available: Boolean(preview), playMethod: playMethod });
                return { url: url, headers: { Authorization: authorization() }, variantId: source.Id,
                    playSessionId: info.PlaySessionId || '', playMethod: playMethod,
                    container: (source.Container || '').split(',')[0], streams: (source.MediaStreams || []).map(stream),
                    segments: skip, trickplay: preview };
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
            return request(host, 'POST', endpoint, {}, Object.assign({
                ItemId: args.itemId, MediaSourceId: args.variantId, PlaySessionId: args.playSessionId,
                PositionTicks: tickInteger(args.positionTicks), IsPaused: Boolean(args.paused),
                IsMuted: Boolean(args.muted), VolumeLevel: args.volume, PlaybackRate: args.rate || 1,
                PlayMethod: args.playMethod, AudioStreamIndex: index(args.audioStreamIndex),
                SubtitleStreamIndex: args.subtitleStreamIndex === -1 ? -1 : index(args.subtitleStreamIndex),
                CanSeek: true, Failed: Boolean(args.failed)
            }, catalogue.queueFields(args))).then(() => ({}));
        },

        favorite: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/FavoriteItems/' + segment(args.itemId))).then(() => ({})),
        played: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/PlayedItems/' + segment(args.itemId))).then(() => ({})),
        progress: (args, host) => request(host, 'POST', userPath('/Items/' + segment(args.itemId) + '/UserData'), {},
            { PlaybackPositionTicks: tickInteger(args.positionTicks) }).then(() => ({})),

        // Item menu actions from manifest.json; `pick` shows ui/Picker.qml.
        runItemAction: (args, host) => catalogue.authorizeAction(args, host).then(() => {
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
        }),
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
            case 'seek': return groupAction(host, 'Seek', { PositionTicks: tickInteger(args.positionTicks) });
            case 'next': return groupAction(host, 'NextItem', { PlaylistItemId: entry });
            case 'previous': return groupAction(host, 'PreviousItem', { PlaylistItemId: entry });
            case 'play': return groupAction(host, 'SetPlaylistItem', { PlaylistItemId: entry });
            case 'setQueue': return groupAction(host, 'SetNewQueue', { PlayingQueue: args.itemIds,
                PlayingItemPosition: args.index, StartPositionTicks: tickInteger(args.positionTicks) });
            case 'queue': return groupAction(host, 'Queue', { ItemIds: args.itemIds, Mode: args.next ? 'QueueNext' : 'Queue' });
            case 'move': return groupAction(host, 'MovePlaylistItem', { PlaylistItemId: entry, NewIndex: Math.max(0, args.index) });
            case 'remove': return groupAction(host, 'RemoveFromPlaylist', { PlaylistItemIds: args.entryIds,
                ClearPlaylist: false, ClearPlayingItem: false });
            case 'buffering': return groupAction(host, args.buffering ? 'Buffering' : 'Ready', {
                When: new Date(args.at).toISOString(), PositionTicks: tickInteger(args.positionTicks),
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
