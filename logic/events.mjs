// SPDX-License-Identifier: MPL-2.0
// Jellyfin's websocket, translated into Spool's `group`, `remote` and
// `changed` events. The connection lives as long as the account and comes
// back by itself after a drop.

import { time, ticks } from './items.mjs';
import { tickInteger, wireJson } from './wire.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(value, key);
const id = value => typeof value === 'string' && value.length > 0;
const date = value => value === undefined || value === null || (typeof value === 'string'
    && Number.isFinite(Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))));

function integer(value, minimum, maximum) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value)))
        return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function position(value, optional = false) {
    if (optional && (value === undefined || value === null))
        return '0';
    const decimal = ticks(value);
    if (decimal === undefined)
        return undefined;
    try { return wireJson(tickInteger(decimal)); } catch (error) { return undefined; }
}

const groupErrors = {
    GroupDoesNotExist: 'group_missing', LibraryAccessDenied: 'access_denied',
    CreateGroupDenied: 'create_denied', JoinGroupDenied: 'join_denied', SyncPlayIsDisabled: 'disabled'
};

const playstate = {
    Stop: 'stop', Pause: 'pause', Unpause: 'unpause', PlayPause: 'playPause', NextTrack: 'next',
    PreviousTrack: 'previous', Rewind: 'rewind', FastForward: 'fastForward'
};

const general = {
    VolumeUp: ['volumeStep', { delta: 5 }], VolumeDown: ['volumeStep', { delta: -5 }],
    Mute: ['mute', { value: true }], Unmute: ['mute', { value: false }], ToggleMute: ['toggleMute', {}],
    ToggleStats: ['stats', {}], ToggleOsd: ['navigate', { to: 'toggle-osd' }],
    ToggleOsdMenu: ['navigate', { to: 'context-menu' }], ToggleContextMenu: ['navigate', { to: 'context-menu' }],
    ToggleFullscreen: ['navigate', { to: 'fullscreen' }], GoHome: ['navigate', { to: 'home' }],
    GoToSettings: ['navigate', { to: 'settings' }], GoToSearch: ['navigate', { to: 'search' }],
    Play: ['unpause', {}], Unpause: ['unpause', {}], Pause: ['pause', {}], Stop: ['stop', {}], PlayNext: ['next', {}]
};

const keys = {
    MoveUp: 'up', MoveDown: 'down', MoveLeft: 'left', MoveRight: 'right', PageUp: 'pageUp', PageDown: 'pageDown',
    PreviousLetter: 'pageUp', NextLetter: 'pageDown', Select: 'select', Back: 'back', Home: 'home', End: 'end',
    Space: 'space'
};

function remoteGeneral(name, args) {
    if (owns(general, name))
        return Object.assign({ command: general[name][0] }, general[name][1]);
    if (owns(keys, name))
        return { command: 'key', name: keys[name] };
    switch (name) {
    case 'SendKey': return owns(keys, args.Key) ? { command: 'key', name: keys[args.Key] } : null;
    case 'SendString': return typeof args.String === 'string' ? { command: 'text', value: args.String } : null;
    case 'SetVolume': {
        const value = integer(args.Volume, 0, 100);
        return value === undefined ? null : { command: 'volume', value: value };
    }
    case 'SetAudioStreamIndex':
    case 'SetSubtitleStreamIndex': {
        const subtitle = name === 'SetSubtitleStreamIndex';
        const index = integer(args.Index, subtitle ? -1 : 0, 2147483647);
        return index === undefined ? null : { command: subtitle ? 'subtitleTrack' : 'audioTrack', index: index };
    }
    case 'SetRepeatMode': return ['RepeatNone', 'RepeatAll', 'RepeatOne'].indexOf(args.RepeatMode) >= 0
        ? { command: 'repeat', mode: args.RepeatMode } : null;
    case 'SetShuffleQueue': return ['Shuffle', 'Sorted'].indexOf(args.ShuffleMode) >= 0
        ? { command: 'shuffle', value: args.ShuffleMode === 'Shuffle' } : null;
    case 'SetPlaybackOrder': return ['Shuffle', 'Default'].indexOf(args.PlaybackOrder) >= 0
        ? { command: 'shuffle', value: args.PlaybackOrder === 'Shuffle' } : null;
    case 'SetMaxStreamingBitrate': {
        const bitrate = integer(args.Bitrate, 0, Number.MAX_SAFE_INTEGER);
        const height = args.Height === undefined ? 0 : integer(args.Height, 0, Number.MAX_SAFE_INTEGER);
        return bitrate === undefined || height === undefined ? null : { command: 'quality', bitrate: bitrate, height: height };
    }
    case 'DisplayContent': return id(args.ItemId) ? { command: 'show', itemId: args.ItemId,
        itemType: typeof args.ItemType === 'string' ? args.ItemType : '', title: typeof args.ItemName === 'string' ? args.ItemName : '' } : null;
    case 'DisplayMessage': return typeof args.Text === 'string' ? { command: 'message', text: args.Text } : null;
    default: return null;
    }
}

function groupInfo(info) {
    return { groupId: info.GroupId || '', name: info.GroupName || '', state: info.State || '', reason: info.Reason || '',
        participants: info.Participants || [], at: time(info.LastUpdatedAt) };
}

export function translate(message, emit) {
    if (!object(message) || typeof message.MessageType !== 'string')
        return;
    const data = message.Data;
    if (message.MessageType !== 'LibraryChanged' && !object(data))
        return;
    switch (message.MessageType) {
    case 'SyncPlayCommand': {
        const decimal = position(data.PositionTicks, true);
        if (['Pause', 'Unpause', 'Seek', 'Stop'].indexOf(data.Command) < 0 || decimal === undefined
            || !date(data.When) || !date(data.EmittedAt))
            break;
        emit('group', { type: 'command', command: data.Command.toLowerCase(), at: time(data.When),
            emittedAt: time(data.EmittedAt), positionTicks: decimal,
            entryId: data.PlaylistItemId || '' });
        break;
    }
    case 'SyncPlayGroupUpdate': {
        const update = data.Data;
        switch (data.Type) {
        case 'GroupJoined':
        case 'GroupUpdate':
            if (object(update) && date(update.LastUpdatedAt))
                emit('group', Object.assign({ type: data.Type === 'GroupJoined' ? 'joined' : 'update' }, groupInfo(update)));
            break;
        case 'StateUpdate':
            if (object(update) && ['Idle', 'Waiting', 'Paused', 'Playing'].indexOf(update.State) >= 0)
                emit('group', { type: 'state', state: update.State, reason: update.Reason || '' });
            break;
        case 'PlayQueue': {
            if (!object(update) || !date(update.LastUpdate) || !Array.isArray(update.Playlist)
                || update.Playlist.some(entry => !object(entry) || !id(entry.ItemId) || !id(entry.PlaylistItemId)))
                break;
            const decimal = position(update.StartPositionTicks, true);
            if (decimal === undefined)
                break;
            emit('group', { type: 'queue', index: update.PlayingItemIndex, at: time(update.LastUpdate),
                positionTicks: decimal, reason: update.Reason || '',
                items: (update.Playlist || []).map(e => ({ itemId: e.ItemId, entryId: e.PlaylistItemId })) });
            break;
        }
        case 'UserJoined':
        case 'UserLeft':
            // The server reports names, not a list; the controller keeps the list.
            if (typeof update === 'string')
                emit('group', { type: data.Type === 'UserJoined' ? 'participantJoined' : 'participantLeft', name: update });
            break;
        case 'GroupLeft':
        case 'NotInGroup':
            emit('group', { type: 'left' });
            break;
        default:
            if (owns(groupErrors, data.Type))
                emit('group', { type: 'error', code: groupErrors[data.Type] });
        }
        break;
    }
    case 'Play': {
        const modes = { PlayNow: 'now', PlayNext: 'next', PlayLast: 'last', PlayShuffle: 'shuffle' };
        const mode = data.PlayCommand === undefined || data.PlayCommand === null ? 'PlayNow' : data.PlayCommand;
        const index = data.StartIndex === undefined || data.StartIndex === null ? 0 : data.StartIndex;
        const decimal = position(data.StartPositionTicks, true);
        if (!Array.isArray(data.ItemIds) || !data.ItemIds.length || !data.ItemIds.every(id)
            || !Number.isInteger(index) || index < 0 || index >= data.ItemIds.length
            || !owns(modes, mode) || decimal === undefined)
            break;
        emit('remote', { command: 'play', itemIds: data.ItemIds, index: index, positionTicks: decimal, mode: modes[mode] });
        break;
    }
    case 'Playstate':
        if (data.Command === 'Seek') {
            const decimal = position(data.SeekPositionTicks);
            if (decimal !== undefined)
                emit('remote', { command: 'seek', positionTicks: decimal });
        } else if (owns(playstate, data.Command))
            emit('remote', { command: playstate[data.Command] });
        break;
    case 'GeneralCommand': {
        if (typeof data.Name !== 'string' || (data.Arguments !== undefined && data.Arguments !== null && !object(data.Arguments)))
            break;
        const command = remoteGeneral(data.Name, data.Arguments || {});
        if (command)
            emit('remote', command);
        break;
    }
    case 'LibraryChanged':
        emit('changed', {});
        break;
    }
}

// Opens the socket, keeps it alive and reopens it after a drop, backing off
// up to a minute. Returns a function that closes it for good.
export function connect(host, url, headers, invalidatePolicy, outboundEnabled = false) {
    let socket = null;
    let stopped = false;
    let failures = 0;
    let keepAlive = 30;
    // Only the newest keep-alive loop runs: the server may ask again, and a
    // reconnect starts over.
    let pings = 0;
    let retries = 0;
    function retry() {
        if (stopped)
            return;
        const generation = ++retries;
        failures += 1;
        host.delay(Math.min(60, 2 ** Math.min(failures, 6)) * 1000).then(() => {
            if (!stopped && generation === retries)
                open();
        }, () => {});
    }
    function dropped(connection, close) {
        if (socket !== connection)
            return;
        socket = null;
        pings += 1;
        if (close) {
            try { connection.close(); } catch (error) {}
        }
        retry();
    }
    function send(connection, value) {
        if (stopped || socket !== connection)
            return false;
        try {
            connection.send(JSON.stringify(value));
            return true;
        } catch (error) {
            dropped(connection, true);
            return false;
        }
    }
    function ping(connection, generation) {
        host.delay(keepAlive * 1000).then(() => {
            if (!stopped && socket === connection && generation === pings
                && send(connection, { MessageType: 'KeepAlive' }))
                ping(connection, generation);
        }, () => {});
    }
    function open() {
        if (stopped || socket)
            return;
        retries += 1;
        let connection;
        try {
            connection = host.socket(url, { headers: headers });
        } catch (error) {
            retry();
            return;
        }
        socket = connection;
        const current = () => !stopped && socket === connection;
        connection.onopen = () => {
            if (!current())
                return;
            if (invalidatePolicy)
                invalidatePolicy();
            failures = 0;
            host.emit('group', { type: 'connected' });
        };
        connection.onmessage = text => {
            if (!current())
                return;
            let message;
            try {
                message = JSON.parse(text);
            } catch (error) {
                return;
            }
            if (!object(message) || typeof message.MessageType !== 'string')
                return;
            if (invalidatePolicy && ['UserUpdated', 'UserDeleted', 'UserConfigurationUpdated',
                'UserPolicyUpdated'].indexOf(message.MessageType) >= 0)
                invalidatePolicy();
            if (outboundEnabled && message.MessageType === 'Sessions' && Array.isArray(message.Data)) {
                for (const session of message.Data.slice(0, 128)) {
                    if (object(session) && id(session.Id) && session.DeviceId !== (host.device || {}).id)
                        host.emit('remoteChanged', { targetId: session.Id });
                }
            }
            if (message.MessageType === 'ForceKeepAlive') {
                const seconds = integer(message.Data, 1, Number.MAX_SAFE_INTEGER);
                if (seconds === undefined)
                    return;
                keepAlive = Math.max(5, Math.min(60, seconds / 2));
                if (send(connection, { MessageType: 'KeepAlive' }))
                    ping(connection, ++pings);
            } else {
                translate(message, host.emit);
            }
        };
        connection.onclose = () => dropped(connection, false);
    }
    open();
    return () => {
        if (stopped)
            return;
        stopped = true;
        retries += 1;
        pings += 1;
        const connection = socket;
        socket = null;
        if (connection) {
            try { connection.close(); } catch (error) {}
        }
    };
}
