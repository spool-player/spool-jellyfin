// SPDX-License-Identifier: MPL-2.0
// Optional catalogue contracts. All IDs here are server IDs, never host-scoped IDs.
import { wireSnapshot } from './wire.mjs';

export function createCatalogue({ request, list, userPath, segment, capabilities, userId, emby = false }) {
    let policy = null;
    let policyGeneration = 0;
    let queue = null;
    function invalidate() {
        policy = null;
        ++policyGeneration;
    }
    function requireCapability(id) {
        if (capabilities[id] !== true)
            throw new Error('unsupported_capability');
    }
    function userPolicy(host) {
        if (policy)
            return Promise.resolve(policy);
        const generation = policyGeneration;
        return request(host, 'GET', userPath('')).then(user => {
            if (generation !== policyGeneration)
                throw new Error('permissions_changed');
            policy = user.Policy || {};
            return policy;
        });
    }
    const rawItem = (host, id) => request(host, 'GET', userPath('/Items/' + segment(id)));
    function collectionAllowed(p) {
        return p.EnableCollectionManagement === true || p.IsAdministrator === true;
    }
    function deleteAllowed(raw, p) {
        if (raw.CanDelete === false)
            return false;
        return raw.CanDelete === true || p.EnableContentDeletion === true;
    }
    function editablePlaylist(host, raw) {
        if (raw.CanEditItems === false)
            return Promise.resolve(false);
        const fallback = () => {
            if (typeof raw.CanEditItems === 'boolean')
                return Promise.resolve(raw.CanEditItems);
            return userPolicy(host).then(p =>
                String(raw.OwnerUserId || raw.UserId || '') === userId || p.IsAdministrator === true);
        };
        if (emby)
            return fallback();
        return request(host, 'GET', '/Playlists/' + segment(String(raw.Id)) + '/Users/' + segment(userId))
            .then(permission => typeof permission.CanEdit === 'boolean' ? permission.CanEdit : fallback(), error => {
                if (error.message === 'http_403')
                    return false;
                if (error.message === 'http_404' || error.message === 'http_405')
                    return fallback();
                throw error;
            });
    }
    function containerItem(host, id) {
        return rawItem(host, id).then(raw => {
            if (raw.Type !== 'Playlist' && raw.Type !== 'BoxSet')
                throw new Error('unsupported_collection');
            return raw;
        });
    }
    function container(host, id) {
        return containerItem(host, id).then(raw => {
            const ordered = raw.Type === 'Playlist';
            const permission = ordered ? editablePlaylist(host, raw)
                : userPolicy(host).then(p => raw.CanEditItems !== false && collectionAllowed(p));
            return permission.then(removable => ({
                ordered: ordered, removable: removable, moveMode: ordered && removable ? 'index' : 'none'
            }));
        });
    }
    const playlistTypes = ['Movie', 'Episode', 'Series', 'Season', 'Audio', 'MusicAlbum', 'MusicVideo', 'Video'];
    const ratingTypes = ['Movie', 'Series', 'Season', 'Episode', 'Audio', 'MusicAlbum', 'MusicArtist',
        'MusicVideo', 'Video', 'Book', 'AudioBook'];
    const ratingIds = ['like', 'dislike', 'clearRating'];
    function ratingActions(raw) {
        if (ratingTypes.indexOf(raw.Type) < 0)
            return [];
        const likes = (raw.UserData || {}).Likes;
        const actions = [];
        if (likes !== true)
            actions.push({ id: 'like', label: 'Like', icon: 'thumb_up' });
        if (likes !== false)
            actions.push({ id: 'dislike', label: 'Dislike', icon: 'thumb_down' });
        if (typeof likes === 'boolean')
            actions.push({ id: 'clearRating', label: 'Clear personal rating', icon: 'clear' });
        return actions;
    }
    function allowedActions(host, raw, p) {
        const actions = ratingActions(raw);
        if (playlistTypes.indexOf(raw.Type) >= 0 && p.EnablePlaylistAccess !== false)
            actions.push({ id: 'playlist', label: 'Add to playlist', icon: 'playlist_add' });
        if (['Movie', 'Series'].indexOf(raw.Type) >= 0 && collectionAllowed(p))
            actions.push({ id: 'collection', label: 'Add to collection', icon: 'library_add' });
        const permission = raw.Type === 'Playlist' ? editablePlaylist(host, raw)
            : Promise.resolve(raw.Type === 'BoxSet' && raw.CanEditItems !== false && collectionAllowed(p));
        return permission.then(editable => {
            if (editable)
                actions.push({ id: 'rename', label: 'Rename', icon: 'drive_file_rename_outline' });
            if (deleteAllowed(raw, p))
                actions.push({ id: 'delete', label: 'Delete from server', icon: 'delete' });
            return actions;
        });
    }
    function actionsFor(host, id) {
        const generation = policyGeneration;
        // Both requests belong to this operation; cancellation cannot poison a
        // request shared with another menu or mutation.
        return Promise.all([rawItem(host, id), userPolicy(host)])
            .then(([raw, p]) => allowedActions(host, raw, p)).then(actions => {
                // The faster policy request may have completed before an
                // invalidation while item/playlist metadata was still loading.
                if (generation !== policyGeneration)
                    throw new Error('permissions_changed');
                return actions;
            });
    }
    function authorizeAction(args, host) {
        const personalRating = ratingIds.indexOf(args.action) >= 0;
        if (!personalRating && ['playlist', 'collection', 'rename', 'delete'].indexOf(args.action) < 0)
            throw new Error('unsupported_action');
        // Personal ratings depend on current item/user state, not server editing rights.
        return (personalRating ? rawItem(host, args.itemId).then(raw => ratingActions(raw))
            : actionsFor(host, args.itemId)).then(actions => {
            if (!actions.some(action => action.id === args.action))
                throw new Error('permission_denied');
            if (args.targetId && (args.action === 'playlist' || args.action === 'collection')) {
                return rawItem(host, args.targetId).then(raw => {
                    if (raw.Type !== (args.action === 'playlist' ? 'Playlist' : 'BoxSet'))
                        throw new Error('unsupported_collection');
                    return args.action === 'playlist' ? editablePlaylist(host, raw)
                        : userPolicy(host).then(p => raw.CanEditItems !== false && collectionAllowed(p));
                }).then(allowed => {
                    if (!allowed)
                        throw new Error('permission_denied');
                });
            }
        });
    }
    function queueFields(args) {
        if (args.event === 'stop')
            return {};
        if (args.queue !== undefined || args.queueIndex !== undefined)
            requireCapability('playbackQueueReporting');
        let nextQueue = queue;
        if (args.queue !== undefined) {
            const snapshot = args.queue;
            if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision
                || !Array.isArray(snapshot.items) || snapshot.items.length > 10000)
                throw new Error('invalid_queue');
            if (!queue || snapshot.revision !== queue.revision) {
                const items = snapshot.items.map(row => {
                    if (!row || typeof row.itemId !== 'string' || !row.itemId
                        || (row.mediaType !== 'audio' && row.mediaType !== 'video')
                        || (row.entryId !== undefined && (typeof row.entryId !== 'string' || !row.entryId)))
                        throw new Error('invalid_queue');
                    return { Id: row.itemId, PlaylistItemId: row.entryId };
                });
                // Membership is immutable until its revision changes. Reusing
                // its encoded form avoids walking every item on each progress
                // report while preserving the complete server-facing payload.
                nextQueue = Object.freeze({ revision: snapshot.revision, items: wireSnapshot(items), length: items.length });
            }
        }
        if (args.queueIndex !== undefined && (!Number.isInteger(args.queueIndex) || args.queueIndex < 0
            || (nextQueue && args.queueIndex >= nextQueue.length)))
            throw new Error('invalid_queue');
        // Invalid queue arguments must not replace the snapshot used by later progress.
        queue = nextQueue;
        return queue ? { NowPlayingQueue: queue.items, PlaylistIndex: args.queueIndex,
            PlaylistLength: queue.length } : {};
    }
    function boundedLimit(args, maximum) {
        return Math.min(maximum, Math.max(1, Number.isInteger(args.limit) ? args.limit : maximum));
    }
    return {
        invalidate: invalidate,
        authorizeAction: authorizeAction,
        queueFields: queueFields,
        search: (args, host) => {
            const limit = boundedLimit(args, 100);
            const parameters = { SearchTerm: args.query, Recursive: true, EnableTotalRecordCount: false };
            return Promise.all([
                list(host, userPath('/Items'), { limit: limit }, Object.assign({}, parameters, { IncludeItemTypes: 'Series' })),
                list(host, userPath('/Items'), { limit: limit }, Object.assign({}, parameters, {
                    IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,Audio,MusicAlbum,MusicArtist,Book,AudioBook,BoxSet,Playlist,Season,Folder,Person,Trailer'
                }))
            ]).then(results => {
                const seen = new Set();
                const items = [];
                for (const result of results) {
                    for (const row of result.items) {
                        if (!seen.has(row.id) && items.length < limit) {
                            seen.add(row.id);
                            items.push(row);
                        }
                    }
                }
                return { items: items, cursor: null, exhausted: true };
            });
        },
        suggestions: (args, host) => {
            requireCapability('suggestions');
            const limit = boundedLimit(args, 60);
            return list(host, userPath('/Items'), { limit: limit }, {
                Recursive: true, IncludeItemTypes: 'Movie,Series', MediaTypes: 'Video',
                SortBy: 'IsFavoriteOrLiked,Random', EnableTotalRecordCount: false
            }).then(result => ({ items: result.items.slice(0, limit), cursor: null, exhausted: true }));
        },
        itemActions: (args, host) => {
            requireCapability('itemActions');
            return actionsFor(host, args.itemId).then(actions => ({ actions: actions }));
        },
        collectionInfo: (args, host) => {
            requireCapability('collectionEditing');
            return container(host, args.containerId);
        },
        collectionEntries: (args, host) => {
            requireCapability('collectionEditing');
            // Reading a page needs the container type, not its edit policy.
            // The entry endpoint still enforces this account's read access.
            return containerItem(host, args.containerId).then(raw => {
                const ordered = raw.Type === 'Playlist';
                return list(host, ordered ? '/Playlists/' + segment(args.containerId) + '/Items'
                    : userPath('/Items'), args, ordered ? {} : { ParentId: args.containerId, Recursive: false })
                    .then(result => {
                        for (const row of result.items) {
                            if (!ordered)
                                row.entryId = row.id;
                            if (typeof row.entryId !== 'string' || !row.entryId)
                                throw new Error('missing_entry_id');
                        }
                        return result;
                    });
            });
        },
        collectionRemove: (args, host) => {
            requireCapability('collectionEditing');
            segment(args.entryId);
            return container(host, args.containerId).then(info => {
                if (!info.removable)
                    throw new Error('permission_denied');
                const parameters = info.ordered ? (emby ? { EntryIds: args.entryId } : { entryIds: args.entryId })
                    : (emby ? { Ids: args.entryId } : { ids: args.entryId });
                return request(host, 'DELETE', (info.ordered ? '/Playlists/' : '/Collections/')
                    + segment(args.containerId) + '/Items', parameters).then(() => ({}));
            });
        },
        collectionMove: (args, host) => {
            requireCapability('collectionEditing');
            if (!Number.isInteger(args.index) || args.index < 0)
                throw new Error('invalid_index');
            return container(host, args.containerId).then(info => {
                if (info.moveMode !== 'index')
                    throw new Error('permission_denied');
                return request(host, 'POST', '/Playlists/' + segment(args.containerId) + '/Items/'
                    + segment(args.entryId) + '/Move/' + args.index).then(() => ({}));
            });
        }
    };
}
