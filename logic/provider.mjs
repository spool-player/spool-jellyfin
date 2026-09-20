// SPDX-License-Identifier: MPL-2.0
// Endpoint behaviour derived from spool's JellyfinApiFacade at e0de68c18c3740bc22421b99848fa9f7b2f0e788.
const fields = 'SortName,Overview,ProductionYear,PremiereDate,EndDate,Status,DateCreated,DateLastContentAdded,ImageTags,BackdropImageTags,UserData,RunTimeTicks,SeriesInfo,LocationType,IsVirtualItem,Genres,Tags,Studios,ProviderIds,OfficialRating,CommunityRating,CriticRating';
const types = {movies: 'Movie', tvshows: 'Series', playlists: 'Playlist', boxsets: 'BoxSet', music: 'MusicArtist,MusicAlbum,Audio', books: 'Book,AudioBook', photos: 'PhotoAlbum,Photo', musicvideos: 'MusicVideo', homevideos: 'Folder,Video,PhotoAlbum,Photo'};
function opaque(value) {
    if (typeof value !== 'string' || !value)
        throw new Error('missing_id');
    return encodeURIComponent(value);
}
function integer(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    if (!Number.isSafeInteger(value)) throw new Error('unsafe_integer');
    return String(value);
}
function item(raw) {
    const user = raw.UserData || {};
    const images = raw.ImageTags || {};
    return {
        id: String(raw.Id), title: raw.Name || '', sortName: raw.SortName || raw.Name || '',
        type: raw.Type || 'Unknown', year: raw.ProductionYear || null,
        overview: raw.Overview || '', externalIds: raw.ProviderIds || {},
        seriesId: raw.SeriesId || null, seasonId: raw.SeasonId || null,
        seriesName: raw.SeriesName || '', season: raw.ParentIndexNumber || null,
        episode: raw.IndexNumber === undefined ? null : raw.IndexNumber,
        runtimeTicks: integer(raw.RunTimeTicks), resumeTicks: integer(user.PlaybackPositionTicks),
        favorite: Boolean(user.IsFavorite), played: Boolean(user.Played),
        posterTag: images.Primary || '', backdropTag: (raw.BackdropImageTags || [])[0] || '',
        logoTag: images.Logo || '', genres: raw.Genres || [], tags: raw.Tags || [],
        studios: (raw.Studios || []).map(function(studio) { return studio.Name; }),
        officialRating: raw.OfficialRating || '', communityRating: raw.CommunityRating || null,
        people: (raw.People || []).map(function(person) {
            return {id: String(person.Id), name: person.Name || '', type: person.Type || '', role: person.Role || '', imageTag: person.PrimaryImageTag || ''};
        })
    };
}
function stream(raw) {
    return {
        index: raw.Index, type: raw.Type, codec: raw.Codec || '', language: raw.Language || '',
        title: raw.DisplayTitle || raw.Title || '', width: raw.Width || null, height: raw.Height || null,
        channels: raw.Channels || null, bitrate: raw.BitRate || null, range: raw.VideoRangeType || raw.VideoRange || '',
        external: Boolean(raw.IsExternal), forced: Boolean(raw.IsForced), default: Boolean(raw.IsDefault)
    };
}
function variant(raw) {
    return {
        id: String(raw.Id), label: raw.Name || '', container: (raw.Container || '').split(',')[0],
        sizeBytes: integer(raw.Size), bitrate: raw.Bitrate || raw.BitRate || null,
        runtimeTicks: integer(raw.RunTimeTicks), streams: (raw.MediaStreams || []).map(stream),
        filename: (raw.Path || '').split(/[\\/]/).pop(), metadataProvenance: 'reported'
    };
}
function pageLimit(args) {
    const limit = args.limit === undefined ? 72 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_limit');
    return limit;
}
function startIndex(args) {
    if (args.cursor === undefined || args.cursor === null || args.cursor === '') return 0;
    if (!/^\d+$/.test(String(args.cursor))) throw new Error('invalid_cursor');
    const value = Number(args.cursor);
    if (!Number.isSafeInteger(value)) throw new Error('invalid_cursor');
    return value;
}
function query(values) {
    return Object.keys(values).filter(function(key) { return values[key] !== undefined && values[key] !== null && values[key] !== ''; })
        .map(function(key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key])); }).join('&');
}
function quoted(value) { return String(value || '').replace(/["\\\r\n]/g, ''); }

export function createSource(configuration) {
    const server = String(configuration.server || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(server)) throw new Error('invalid_server');
    let token = configuration.token || '';
    let userId = configuration.userId || '';
    const deviceId = configuration.deviceId || 'spool';
    function authorization() {
        return 'MediaBrowser Client="Spool", Device="' + quoted(configuration.deviceName || 'Spool')
            + '", DeviceId="' + quoted(deviceId) + '", Version="' + quoted(configuration.clientVersion || '0.1.0')
            + '"' + (token ? ', Token="' + quoted(token) + '"' : '');
    }
    function request(host, method, path, parameters, body) {
        const suffix = query(parameters || {});
        return host.http(server + path + (suffix ? '?' + suffix : ''), {
            method: method,
            headers: {'Authorization': authorization(), 'Content-Type': 'application/json', 'Accept': 'application/json'},
            body: body === undefined ? '' : JSON.stringify(body)
        }).then(function(response) {
            if (response.status < 200 || response.status >= 300) throw new Error('http_' + response.status);
            return response.body ? JSON.parse(response.body) : {};
        });
    }
    function userPath(path) { return '/Users/' + opaque(userId) + path; }
    function list(host, path, args, parameters) {
        const start = startIndex(args), limit = pageLimit(args);
        const values = Object.assign({UserId: userId, Fields: fields, EnableUserData: true}, parameters || {}, {StartIndex: start, Limit: limit});
        return request(host, 'GET', path, values).then(function(result) {
            const rows = Array.isArray(result) ? result : result.Items || [];
            if (rows.length > limit) throw new Error('server_ignored_limit');
            const total = Number.isSafeInteger(result.TotalRecordCount) ? result.TotalRecordCount : null;
            const exhausted = total !== null ? start + rows.length >= total : rows.length < limit;
            return {items: rows.map(item), total: total, exhausted: exhausted, cursor: exhausted ? null : String(start + rows.length)};
        });
    }
    function authenticate(host, path, payload) {
        return request(host, 'POST', path, {}, payload).then(function(result) {
            if (!result.AccessToken || !result.User || !result.User.Id) throw new Error('invalid_authentication');
            token = result.AccessToken;
            userId = result.User.Id;
            return {userId: userId, token: token, name: result.User.Name || '', serverId: result.ServerId || ''};
        });
    }
    const api = {
        authenticate: function(args, host) { return authenticate(host, '/Users/AuthenticateByName', {Username: args.username, Pw: args.password}); },
        quickConnectEnabled: function(args, host) { return request(host, 'GET', '/QuickConnect/Enabled').then(function(enabled) { return {enabled: enabled === true}; }); },
        quickConnectInitiate: function(args, host) { return request(host, 'POST', '/QuickConnect/Initiate'); },
        quickConnectPoll: function(args, host) { return request(host, 'GET', '/QuickConnect/Connect', {Secret: args.secret}); },
        quickConnectAuthenticate: function(args, host) { return authenticate(host, '/Users/AuthenticateWithQuickConnect', {Secret: args.secret}); },
        libraries: function(args, host) {
            return request(host, 'GET', userPath('/Views')).then(function(result) {
                return {items: (result.Items || []).map(function(row) { return {id: String(row.Id), title: row.Name || '', collectionType: row.CollectionType || '', posterTag: (row.ImageTags || {}).Primary || ''}; })};
            });
        },
        browse: function(args, host) {
            const filters = args.filters || {};
            const parameters = {ParentId: args.parentId, Recursive: args.recursive !== false, IncludeItemTypes: types[args.collectionType], SortBy: args.sortBy || 'SortName', SortOrder: args.sortOrder || 'Ascending'};
            const allowed = ['Filters', 'Genres', 'OfficialRatings', 'Tags', 'Years', 'StudioIds', 'SeriesStatus', 'VideoTypes', 'IsHd', 'Is4K', 'Is3D', 'HasSubtitles', 'HasTrailer', 'IsMissing', 'IsUnaired', 'NameStartsWith', 'NameLessThan'];
            Object.keys(filters).forEach(function(key) {
                if (allowed.indexOf(key) < 0) throw new Error('unsupported_filter');
                parameters[key] = Array.isArray(filters[key]) ? filters[key].join(['Genres', 'OfficialRatings', 'Tags', 'StudioIds'].indexOf(key) >= 0 ? '|' : ',') : filters[key];
            });
            return list(host, '/Items', args, parameters);
        },
        search: function(args, host) { return list(host, '/Items', args, {SearchTerm: args.query, Recursive: true, IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,Audio,MusicAlbum,MusicArtist,Book,AudioBook'}); },
        details: function(args, host) { return request(host, 'GET', userPath('/Items/' + opaque(args.itemId)), {Fields: fields + ',People,MediaSources,ExternalUrls'}).then(function(row) { return {item: item(row)}; }); },
        seasons: function(args, host) { return list(host, '/Shows/' + opaque(args.seriesId) + '/Seasons', args); },
        episodes: function(args, host) { return list(host, '/Shows/' + opaque(args.seriesId) + '/Episodes', args, {SeasonId: args.seasonId}); },
        resume: function(args, host) { return list(host, '/Items/Resume', args, {MediaTypes: 'Video'}); },
        nextUp: function(args, host) { return list(host, '/Shows/NextUp', args); },
        latest: function(args, host) { return list(host, userPath('/Items/Latest'), args, {ParentId: args.parentId}); },
        similar: function(args, host) { return list(host, '/Items/' + opaque(args.itemId) + '/Similar', args); },
        personItems: function(args, host) { return list(host, '/Items', args, {PersonIds: args.personId, Recursive: true}); },
        filterOptions: function(args, host) { return request(host, 'GET', '/Items/Filters2', {UserId: userId, ParentId: args.parentId, IncludeItemTypes: types[args.collectionType]}); },
        variants: function(args, host) {
            return request(host, 'GET', userPath('/Items/' + opaque(args.itemId)), {Fields: 'MediaSources'}).then(function(result) {
                return {variants: (result.MediaSources || []).map(variant)};
            });
        },
        resolve: function(args, host) {
            opaque(args.variantId);
            return request(host, 'POST', '/Items/' + opaque(args.itemId) + '/PlaybackInfo', {}, {
                UserId: userId, MediaSourceId: args.variantId, StartTimeTicks: args.positionTicks || 0,
                MaxStreamingBitrate: args.maxBitrate || 120000000, DeviceProfile: args.deviceProfile,
                AudioStreamIndex: args.audioStreamIndex, SubtitleStreamIndex: args.subtitleStreamIndex,
                EnableDirectPlay: !args.forceTranscode, EnableDirectStream: !args.forceTranscode,
                EnableTranscoding: true, AutoOpenLiveStream: true
            }).then(function(result) {
                if (result.ErrorCode) throw new Error('playback_unavailable');
                const source = (result.MediaSources || []).filter(function(value) { return value.Id === args.variantId; })[0];
                if (!source) throw new Error('selected_variant_unavailable');
                let url, playMethod;
                if (!args.forceTranscode && (source.SupportsDirectPlay || source.SupportsDirectStream)) {
                    url = server + '/Videos/' + opaque(args.itemId) + '/stream?' + query({Static: true, MediaSourceId: source.Id, DeviceId: deviceId, PlaySessionId: result.PlaySessionId});
                    playMethod = source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream';
                } else if (source.TranscodingUrl) {
                    if (/^https?:\/\//.test(source.TranscodingUrl)) {
                        // Do not attach this server's credential to another host.
                        if (source.TranscodingUrl.indexOf(server + '/') !== 0) throw new Error('cross_origin_stream');
                        url = source.TranscodingUrl;
                    } else {
                        url = server + '/' + source.TranscodingUrl.replace(/^\/+/, '');
                    }
                    playMethod = 'Transcode';
                } else throw new Error('selected_variant_unplayable');
                return {itemId: args.itemId, variantId: source.Id, playSessionId: result.PlaySessionId || '', playMethod: playMethod,
                    video: {url: url, headers: {'X-Emby-Token': token}, origin: server}, streams: (source.MediaStreams || []).map(stream)};
            });
        },
        artwork: function(args) { return {url: server + '/Items/' + opaque(args.itemId) + '/Images/' + opaque(args.kind || 'Primary') + '?' + query({tag: args.tag, maxWidth: args.width}), headers: {'X-Emby-Token': token}, origin: server}; },
        favorite: function(args, host) { return request(host, args.value ? 'POST' : 'DELETE', userPath('/FavoriteItems/' + opaque(args.itemId))); },
        played: function(args, host) { return request(host, args.value ? 'POST' : 'DELETE', userPath('/PlayedItems/' + opaque(args.itemId))); },
        progress: function(args, host) { return request(host, 'POST', userPath('/Items/' + opaque(args.itemId) + '/UserData'), {}, {PlaybackPositionTicks: args.positionTicks}); },
        segments: function(args, host) { return request(host, 'GET', '/MediaSegments/' + opaque(args.itemId)).then(function(result) { return {segments: result.Items || []}; }); },
        report: function(args, host) {
            const endpoints = {start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped'};
            if (!endpoints[args.event]) throw new Error('invalid_report');
            return request(host, 'POST', endpoints[args.event], {}, {ItemId: args.itemId, MediaSourceId: args.variantId, PlaySessionId: args.playSessionId, PositionTicks: args.positionTicks || 0,
                IsPaused: Boolean(args.paused), IsMuted: Boolean(args.muted), VolumeLevel: args.volume, PlaybackRate: args.rate || 1, PlayMethod: args.playMethod,
                AudioStreamIndex: args.audioStreamIndex, SubtitleStreamIndex: args.subtitleStreamIndex, CanSeek: true});
        },
        user: function(args, host) { return request(host, 'GET', userPath('')); },
        userConfiguration: function(args, host) { return request(host, 'POST', userPath('/Configuration'), {}, args.configuration); },
        cultures: function(args, host) { return request(host, 'GET', '/Localization/Cultures').then(function(values) { return {items: values}; }); },
        sessions: function(args, host) { return request(host, 'GET', '/Sessions', {ControllableByUserId: userId}).then(function(values) { return {items: values}; }); },
        remotePlay: function(args, host) { return request(host, 'POST', '/Sessions/' + opaque(args.sessionId) + '/Playing', {ItemIds: args.itemIds.join(','), PlayCommand: args.command || 'PlayNow', StartIndex: args.index, StartPositionTicks: args.positionTicks, MediaSourceId: args.variantId}); },
        remoteState: function(args, host) { return request(host, 'POST', '/Sessions/' + opaque(args.sessionId) + '/Playing/' + opaque(args.command), {SeekPositionTicks: args.positionTicks}); },
        remoteCommand: function(args, host) { return request(host, 'POST', '/Sessions/' + opaque(args.sessionId) + '/Command', {}, {Name: args.command, Arguments: args.arguments || {}}); },
        rename: function(args, host) { return request(host, 'GET', '/Items/' + opaque(args.itemId)).then(function(raw) { raw.Name = args.name; return request(host, 'POST', '/Items/' + opaque(args.itemId), {}, raw); }); },
        deleteItem: function(args, host) { return request(host, 'DELETE', '/Items/' + opaque(args.itemId)); },
        createPlaylist: function(args, host) { return request(host, 'POST', '/Playlists', {}, {Name: args.name, Ids: args.itemIds || [], UserId: userId}); },
        playlistAdd: function(args, host) { return request(host, 'POST', '/Playlists/' + opaque(args.playlistId) + '/Items', {Ids: args.itemIds.join(','), UserId: userId}); },
        playlistRemove: function(args, host) { return request(host, 'DELETE', '/Playlists/' + opaque(args.playlistId) + '/Items', {EntryIds: args.entryIds.join(',')}); },
        playlistMove: function(args, host) { return request(host, 'POST', '/Playlists/' + opaque(args.playlistId) + '/Items/' + opaque(args.entryId) + '/Move/' + args.index); },
        createCollection: function(args, host) { return request(host, 'POST', '/Collections', {Name: args.name, Ids: (args.itemIds || []).join(',')}); },
        collectionAdd: function(args, host) { return request(host, 'POST', '/Collections/' + opaque(args.collectionId) + '/Items', {Ids: args.itemIds.join(',')}); },
        collectionRemove: function(args, host) { return request(host, 'DELETE', '/Collections/' + opaque(args.collectionId) + '/Items', {Ids: args.itemIds.join(',')}); },
        groups: function(args, host) { return request(host, 'GET', '/SyncPlay/List').then(function(values) { return {items: values}; }); },
        groupCreate: function(args, host) { return request(host, 'POST', '/SyncPlay/New', {}, {GroupName: args.name}); },
        groupJoin: function(args, host) { return request(host, 'POST', '/SyncPlay/Join', {}, {GroupId: args.groupId}); },
        groupLeave: function(args, host) { return request(host, 'POST', '/SyncPlay/Leave'); },
        groupCommand: function(args, host) {
            const commands = ['Pause', 'Unpause', 'Seek', 'Ping', 'Buffering', 'Ready', 'SetNewQueue', 'NextItem', 'PreviousItem', 'Queue', 'MovePlaylistItem', 'RemoveFromPlaylist', 'SetPlaylistItem'];
            if (commands.indexOf(args.command) < 0) throw new Error('invalid_group_command');
            return request(host, 'POST', '/SyncPlay/' + args.command, {}, args.data || {});
        },
        utcTime: function(args, host) { return request(host, 'GET', '/GetUTCTime'); },
        signOut: function() { token = ''; userId = ''; return {}; }
    };
    return api;
}
