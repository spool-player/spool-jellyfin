// SPDX-License-Identifier: MPL-2.0
// Jellyfin's websocket, translated into Spool's `group`, `remote` and
// `changed` events. The connection lives as long as the account and comes
// back by itself after a drop.

import { time, ticks } from './items.mjs';

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
    if (general[name])
        return Object.assign({ command: general[name][0] }, general[name][1]);
    if (keys[name])
        return { command: 'key', name: keys[name] };
    switch (name) {
    case 'SendKey': return keys[args.Key] ? { command: 'key', name: keys[args.Key] } : null;
    case 'SendString': return { command: 'text', value: String(args.String || '') };
    case 'SetVolume': return { command: 'volume', value: Number(args.Volume) || 0 };
    case 'SetAudioStreamIndex': return { command: 'audioTrack', index: Number(args.Index) };
    case 'SetSubtitleStreamIndex': return { command: 'subtitleTrack', index: Number(args.Index) };
    case 'SetRepeatMode': return { command: 'repeat', mode: String(args.RepeatMode || 'RepeatNone') };
    case 'SetShuffleQueue': return { command: 'shuffle', value: args.ShuffleMode === 'Shuffle' };
    case 'SetPlaybackOrder': return { command: 'shuffle', value: args.PlaybackOrder === 'Shuffle' };
    case 'SetMaxStreamingBitrate': return { command: 'quality', bitrate: Number(args.Bitrate) || 0, height: Number(args.Height) || 0 };
    case 'DisplayContent': return { command: 'show', itemId: String(args.ItemId || ''), itemType: args.ItemType || '', title: args.ItemName || '' };
    case 'DisplayMessage': return { command: 'message', text: String(args.Text || '') };
    default: return null;
    }
}

function groupInfo(info) {
    return { groupId: info.GroupId || '', name: info.GroupName || '', state: info.State || '', reason: info.Reason || '',
        participants: info.Participants || [], at: time(info.LastUpdatedAt) };
}

export function translate(message, emit) {
    const data = message.Data;
    switch (message.MessageType) {
    case 'SyncPlayCommand':
        emit('group', { type: 'command', command: String(data.Command || '').toLowerCase(), at: time(data.When),
            emittedAt: time(data.EmittedAt), positionTicks: ticks(data.PositionTicks) || '0',
            entryId: data.PlaylistItemId || '' });
        break;
    case 'SyncPlayGroupUpdate': {
        const update = data.Data;
        switch (data.Type) {
        case 'GroupJoined':
        case 'GroupUpdate':
            emit('group', Object.assign({ type: data.Type === 'GroupJoined' ? 'joined' : 'update' }, groupInfo(update)));
            break;
        case 'StateUpdate':
            emit('group', { type: 'state', state: update.State, reason: update.Reason || '' });
            break;
        case 'PlayQueue':
            emit('group', { type: 'queue', index: update.PlayingItemIndex, at: time(update.LastUpdate),
                positionTicks: ticks(update.StartPositionTicks) || '0', reason: update.Reason || '',
                items: (update.Playlist || []).map(e => ({ itemId: e.ItemId, entryId: e.PlaylistItemId })) });
            break;
        case 'UserJoined':
        case 'UserLeft':
            // The server reports names, not a list; the controller keeps the list.
            emit('group', { type: data.Type === 'UserJoined' ? 'participantJoined' : 'participantLeft', name: String(update) });
            break;
        case 'GroupLeft':
        case 'NotInGroup':
            emit('group', { type: 'left' });
            break;
        default:
            if (groupErrors[data.Type])
                emit('group', { type: 'error', code: groupErrors[data.Type] });
        }
        break;
    }
    case 'Play':
        emit('remote', { command: 'play', itemIds: data.ItemIds || [], index: data.StartIndex || 0,
            positionTicks: ticks(data.StartPositionTicks) || '0',
            mode: { PlayNext: 'next', PlayLast: 'last', PlayShuffle: 'shuffle' }[data.PlayCommand] || 'now' });
        break;
    case 'Playstate':
        if (data.Command === 'Seek')
            emit('remote', { command: 'seek', positionTicks: ticks(data.SeekPositionTicks) || '0' });
        else if (playstate[data.Command])
            emit('remote', { command: playstate[data.Command] });
        break;
    case 'GeneralCommand': {
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
export function connect(host, url, headers) {
    let socket = null;
    let stopped = false;
    let failures = 0;
    let keepAlive = 30;
    // Only the newest keep-alive loop runs: the server may ask again, and a
    // reconnect starts over.
    let pings = 0;
    const send = value => socket && socket.send(JSON.stringify(value));
    function ping(generation) {
        host.delay(keepAlive * 1000).then(() => {
            if (!stopped && socket && generation === pings) {
                send({ MessageType: 'KeepAlive' });
                ping(generation);
            }
        });
    }
    function open() {
        if (stopped)
            return;
        try {
            socket = host.socket(url, { headers: headers });
        } catch (error) {
            return;
        }
        socket.onopen = () => {
            failures = 0;
            host.emit('group', { type: 'connected' });
        };
        socket.onmessage = text => {
            let message;
            try {
                message = JSON.parse(text);
            } catch (error) {
                return;
            }
            if (message.MessageType === 'ForceKeepAlive') {
                keepAlive = Math.max(5, Math.min(60, (Number(message.Data) || 60) / 2));
                send({ MessageType: 'KeepAlive' });
                ping(++pings);
            } else {
                translate(message, host.emit);
            }
        };
        socket.onclose = () => {
            socket = null;
            pings += 1;
            if (stopped)
                return;
            failures += 1;
            host.delay(Math.min(60, 2 ** Math.min(failures, 6)) * 1000).then(open);
        };
    }
    open();
    return () => {
        stopped = true;
        if (socket)
            socket.close();
    };
}
