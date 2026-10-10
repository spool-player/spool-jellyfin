// SPDX-License-Identifier: MPL-2.0
// Downloads deliberately negotiate HTTP progressive output, never playback HLS.
import { deviceProfile } from './profile.mjs';

function fileSizeLabel(value) {
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
        return '';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        ++unit;
    }
    return size.toFixed(unit > 0 && size < 10 ? 1 : 0) + ' ' + units[unit];
}

function editionChoice(source, index) {
    const video = (source.MediaStreams || []).find(stream => stream.Type === 'Video') || {};
    // Same-named editions can share a resolution. Show enough of the actual
    // file to distinguish them, without exposing its directory on the server.
    const filename = source.Protocol === 'File' ? String(source.Path || '').split(/[\\/]/).pop() : '';
    const label = source.Name || filename || 'Edition ' + (index + 1);
    const size = fileSizeLabel(source.Size);
    const detail = [
        video.Height > 0 ? video.Height + (video.IsInterlaced ? 'i' : 'p') : '',
        String(video.Codec || '').toUpperCase(),
        video.VideoRange === 'HDR' ? 'HDR' : '',
        String(source.Container || '').toUpperCase(),
        size ? 'Original size: ' + size : '',
        filename !== label ? filename : ''
    ].filter(Boolean).join(' · ');
    return { id: source.Id, label: label, detail: detail };
}

export function createDownloads(options) {
    const { request, userPath, userId, device, server, authorization, query, segment } = options;
    const headers = () => ({ Authorization: authorization() });
    const mediaIdentity = value => /^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
        ? value.replace(/-/g, '').toLowerCase() : value;

    function progressiveUrl(value, itemId, sourceId, sessionId) {
        if (typeof value !== 'string' || /[\\#\r\n]/.test(value))
            throw new Error('download_transcode_unavailable');
        let relative = value;
        if (/^https?:\/\//i.test(value)) {
            if (value.indexOf(server + '/') !== 0)
                throw new Error('cross_origin_stream');
            relative = value.slice(server.length + 1);
        }
        const match = /^\/?Videos\/([^/?]+)\/stream\.mp4\?(.+)$/i.exec(relative);
        if (!match || mediaIdentity(decodeURIComponent(match[1])) !== mediaIdentity(itemId))
            throw new Error('download_transcode_unavailable');
        const parameters = Object.create(null);
        for (const pair of match[2].split('&')) {
            const split = pair.indexOf('=');
            const key = decodeURIComponent(split < 0 ? pair : pair.slice(0, split)).toLowerCase();
            if (Object.prototype.hasOwnProperty.call(parameters, key))
                throw new Error('download_transcode_unavailable');
            if (['api_key', 'apikey', 'access_token', 'token'].indexOf(key) < 0)
                parameters[key] = decodeURIComponent(split < 0 ? '' : pair.slice(split + 1));
        }
        if (parameters.mediasourceid !== sourceId || parameters.playsessionid !== sessionId
            || parameters.videocodec !== 'h264' || parameters.audiocodec !== 'aac'
            || parameters.static === 'true' || parameters.starttimeticks && parameters.starttimeticks !== '0')
            throw new Error('download_transcode_unavailable');
        Object.assign(parameters, { static: false, deviceid: device.id || 'spool', playsessionid: sessionId,
            allowvideostreamcopy: false, allowaudiostreamcopy: false, enableautostreamcopy: false });
        return server + '/Videos/' + segment(itemId) + '/stream.mp4?' + query(parameters);
    }

    function release(cleanup, host) {
        if (!cleanup || cleanup.userId !== userId || cleanup.deviceId !== (device.id || 'spool')
            || typeof cleanup.playSessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(cleanup.playSessionId))
            throw new Error('invalid_download_cleanup');
        return request(host, 'DELETE', '/Videos/ActiveEncodings', {
            DeviceId: cleanup.deviceId, PlaySessionId: cleanup.playSessionId
        }).then(() => {
            host.log('debug', 'Jellyfin download encoding released');
            return {};
        });
    }

    function download(args, host) {
        if (args.mode !== 'original' && args.mode !== 'transcoded')
            throw new Error('invalid_download_mode');
        for (const key of ['maxBitrate', 'maxHeight']) {
            if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] <= 0))
                throw new Error('invalid_download_quality');
        }
        if (host.isLogEnabled('trace'))
            host.log('trace', 'Jellyfin download negotiation', { mode: args.mode,
                selectedVariant: Boolean(args.variantId), maxBitrate: args.maxBitrate || 0, maxHeight: args.maxHeight || 0 });
        return Promise.all([
            request(host, 'GET', userPath('')),
            request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'MediaSources' })
        ]).then(([user, raw]) => {
            const policy = user.Policy || {};
            if (policy.EnableContentDownloading !== true)
                throw new Error('download_forbidden');
            if (raw.MediaType !== 'Video' || raw.IsFolder || raw.IsVirtualItem || raw.LocationType === 'Virtual')
                throw new Error('download_unavailable');
            if (args.mode === 'transcoded' && (policy.EnableMediaPlayback === false
                || policy.EnableVideoPlaybackTranscoding !== true || policy.EnableAudioPlaybackTranscoding !== true))
                throw new Error('download_transcode_forbidden');
            const sources = raw.MediaSources || [];
            if (!args.variantId && sources.length > 1)
                return { pick: { kind: 'downloadVariant', itemId: args.itemId, mode: args.mode,
                    variants: sources.map(editionChoice) } };
            const source = args.variantId ? sources.find(row => row.Id === args.variantId) : sources[0];
            if (!source || typeof source.Id !== 'string' || !source.Id)
                throw new Error('selected_variant_unavailable');
            const container = String(source.Container || '').toLowerCase();
            if (source.Protocol !== 'File' || source.IsRemote || source.RequiresOpening || source.RequiresClosing
                || source.LiveStreamId || source.IsInfiniteStream || source.VideoType !== 'VideoFile'
                || !/^[a-z0-9]{1,12}$/.test(container) || !(source.RunTimeTicks > 0) || raw.PartCount > 1)
                throw new Error('download_requires_single_file');
            return request(host, 'GET', '/Videos/' + segment(source.Id) + '/AdditionalParts', { UserId: userId })
                .then(parts => {
                    if (!Array.isArray(parts.Items) || parts.Items.length)
                        throw new Error('download_requires_single_file');
                    if (args.mode === 'original') {
                        host.log('debug', 'Jellyfin original download ready', { container: container });
                        return { url: server + '/Videos/' + segment(args.itemId) + '/stream?' + query({
                            static: true, MediaSourceId: source.Id }), container: container, headers: headers(),
                            size: Number.isSafeInteger(source.Size) && source.Size > 0 ? source.Size : undefined };
                    }
                    const context = { maxBitrate: args.maxBitrate || 8000000, maxHeight: args.maxHeight || 0 };
                    const profile = deviceProfile(context, false);
                    if (context.maxHeight) {
                        const video = (source.MediaStreams || []).find(row => row.Type === 'Video');
                        if (!video || !(video.Width > 0) || !(video.Height > 0))
                            throw new Error('download_quality_unavailable');
                        // Jellyfin's ResolutionNormalizer drops a height-only ceiling when
                        // choosing a bitrate preset. Pair it with the source-aspect width.
                        const width = Math.max(2, Math.floor(video.Width * Math.min(context.maxHeight / video.Height, 1) / 2) * 2);
                        profile.CodecProfiles[0].Conditions.push({
                            Condition: 'LessThanEqual', Property: 'Width', Value: String(width), IsRequired: true
                        });
                    }
                    profile.Name = 'Spool download';
                    profile.DirectPlayProfiles = [];
                    profile.TranscodingProfiles = [{ Type: 'Video', Container: 'mp4', Protocol: 'http', Context: 'Streaming',
                        VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2' }];
                    profile.SubtitleProfiles = [];
                    return request(host, 'POST', '/Items/' + segment(args.itemId) + '/PlaybackInfo', {}, {
                        UserId: userId, MediaSourceId: source.Id, StartTimeTicks: 0, MaxStreamingBitrate: context.maxBitrate,
                        DeviceProfile: profile, EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true,
                        AllowVideoStreamCopy: false, AllowAudioStreamCopy: false, AutoOpenLiveStream: false,
                        SubtitleStreamIndex: -1
                    }).then(info => {
                        const cleanup = { userId: userId, deviceId: device.id || 'spool', playSessionId: info.PlaySessionId };
                        const negotiated = (info.MediaSources || []).find(row => row.Id === source.Id);
                        if (info.ErrorCode || !negotiated || !negotiated.SupportsTranscoding || !info.PlaySessionId)
                            throw new Error('download_transcode_unavailable');
                        let url;
                        try {
                            url = progressiveUrl(negotiated.TranscodingUrl, args.itemId, source.Id, info.PlaySessionId);
                        } catch (error) {
                            return release(cleanup, host).then(() => { throw error; }, () => { throw error; });
                        }
                        host.log('debug', 'Jellyfin progressive download ready', { protocol: 'http', container: 'mp4' });
                        return { url: url, container: 'mp4', headers: headers(), cleanup: cleanup };
                    });
                });
        });
    }

    return { download: download, downloadRelease: (args, host) => release(args.cleanup, host) };
}
