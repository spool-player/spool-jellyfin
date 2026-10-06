// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
import { logging } from './host.mjs';
const check = (value, message) => { if (!value) throw new Error('download contract: ' + message); };
const fails = (operation, code) => Promise.resolve().then(operation).then(() => {
    throw new Error('download contract: expected ' + code);
}, error => check(error.message === code, 'expected ' + code + ', got ' + error.message));

export function downloadContracts() {
    const calls = [];
    const logs = [];
    const base = 'https://media.example/jf';
    let policy = { EnableContentDownloading: true, EnableMediaPlayback: true,
        EnableVideoPlaybackTranscoding: true, EnableAudioPlaybackTranscoding: true };
    let parts = [];
    let urlMode = 'http';
    let session = 0;
    const file = id => ({ Id: id, Name: id, Protocol: 'File', VideoType: 'VideoFile', Container: 'mkv',
        RunTimeTicks: 100000000, Size: 6000000, MediaStreams: [{ Type: 'Video', Width: 1920, Height: 1080 }] });
    let sources = [file('extended'), file('theatrical')];
    const sink = logging(['trace', 'debug', 'warn'], logs);
    const host = { device: { id: 'device' }, isLogEnabled: sink.isLogEnabled, log: sink.log, http: (url, options) => {
        check(url.indexOf(base + '/') === 0, 'authenticated requests preserve account server base path');
        const path = url.slice(base.length).split('?')[0];
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({ path: path, url: url, body: body, method: options.method, headers: options.headers });
        let result;
        if (path === '/Users/u') result = { Policy: policy };
        else if (path === '/Users/u/Items/film') result = { Id: 'film', MediaType: 'Video', MediaSources: sources };
        else if (/^\/Videos\/[^/]+\/AdditionalParts$/.test(path)) result = { Items: parts };
        else if (path === '/Videos/ActiveEncodings') result = {};
        else if (path === '/Items/film/PlaybackInfo') {
            const playSession = 'download-' + ++session;
            check(body.MediaSourceId === 'theatrical' && body.EnableDirectPlay === false && body.EnableDirectStream === false
                && body.AllowVideoStreamCopy === false && body.AllowAudioStreamCopy === false && !body.AutoOpenLiveStream,
                'download negotiates exact edition with real encoding and no live sessions');
            const profile = body.DeviceProfile;
            check(profile.TranscodingProfiles[0].Protocol === 'http' && profile.TranscodingProfiles[0].VideoCodec === 'h264'
                && profile.TranscodingProfiles[0].AudioCodec === 'aac' && profile.DirectPlayProfiles.length === 0,
                'download profile negotiates progressive media, not playback HLS');
            check(body.MaxStreamingBitrate === 3000000 && profile.CodecProfiles[0].Conditions[0].Value === '720'
                && profile.CodecProfiles[0].Conditions.some(condition => condition.Property === 'Width' && condition.Value === '1280'),
                'quality ceilings include width so server bitrate presets cannot discard the requested height');
            const url = '/Videos/film/' + (urlMode === 'hls' ? 'master.m3u8' : 'stream.mp4')
                + '?MediaSourceId=theatrical&PlaySessionId=' + playSession + '&VideoCodec='
                + (urlMode === 'copy' ? 'copy' : 'h264') + '&AudioCodec=aac&ApiKey=secret-token&api_key=secret-token&Static=false';
            result = { PlaySessionId: playSession, MediaSources: [{ Id: 'theatrical', SupportsTranscoding: true,
                TranscodingUrl: urlMode === 'cross-origin' ? 'https://evil.example' + url : url }] };
        } else throw new Error('unexpected_request:' + path);
        return Promise.resolve({ status: 200, body: JSON.stringify(result) });
    } };
    const source = createSource({ server: base, userId: 'u', token: 'secret-token' }, host);
    const args = { itemId: 'film', mode: 'transcoded', variantId: 'theatrical', maxBitrate: 3000000, maxHeight: 720 };
    let first;
    return source.download({ itemId: 'film', mode: 'original' }, host).then(result => {
        check(result.pick.variants.length === 2 && session === 0, 'ambiguous editions require provider picker before encoding');
        return source.download({ itemId: 'film', mode: 'original', variantId: 'theatrical' }, host);
    }).then(result => {
        check(result.url.indexOf('static=true') >= 0 && result.url.indexOf('MediaSourceId=theatrical') >= 0
            && result.container === 'mkv' && result.size === 6000000 && !result.cleanup,
            'original plan retains exact selected file, size and container without a playback session');
        return source.download(args, host);
    }).then(result => {
        first = result;
        check(result.url.indexOf('/stream.mp4?') > 0 && result.url.indexOf('secret-token') < 0 && result.container === 'mp4'
            && result.headers.Authorization.indexOf('secret-token') >= 0 && !result.size,
            'finite encoded plan uses header credentials and no invented byte size');
        return source.download(args, host);
    }).then(second => {
        check(second.cleanup.playSessionId !== first.cleanup.playSessionId, 'simultaneous downloads own independent server sessions');
        return source.downloadRelease({ cleanup: first.cleanup }, host);
    }).then(() => {
        const last = calls[calls.length - 1];
        check(last.method === 'DELETE' && last.path === '/Videos/ActiveEncodings'
            && last.url.indexOf('PlaySessionId=download-1') >= 0 && last.url.indexOf('DeviceId=device') >= 0
            && !calls.some(call => call.path.indexOf('/Sessions/Playing') === 0),
            'cleanup targets only the generated session and never alters playback reporting');
        return fails(() => source.downloadRelease({ cleanup: { userId: 'other', deviceId: 'device', playSessionId: 'download-2' } }, host),
            'invalid_download_cleanup');
    }).then(() => fails(() => source.download(Object.assign({}, args, { variantId: 'missing' }), host), 'selected_variant_unavailable'))
        .then(() => {
            let sequence = Promise.resolve();
            for (const mode of ['hls', 'copy', 'cross-origin']) {
                sequence = sequence.then(() => { urlMode = mode; return fails(() => source.download(args, host),
                    mode === 'cross-origin' ? 'cross_origin_stream' : 'download_transcode_unavailable'); });
            }
            return sequence;
        }).then(() => {
            urlMode = 'http';
            parts = [{ Id: 'second-part' }];
            return fails(() => source.download(args, host), 'download_requires_single_file');
        }).then(() => {
            parts = [];
            sources = [Object.assign(file('theatrical'), { RequiresOpening: true })];
            return fails(() => source.download(args, host), 'download_requires_single_file');
        }).then(() => {
            sources = [file('theatrical')];
            policy.EnableContentDownloading = false;
            return fails(() => source.download(args, host), 'download_forbidden');
        }).then(() => {
            policy.EnableContentDownloading = true;
            policy.EnableVideoPlaybackTranscoding = false;
            return fails(() => source.download(args, host), 'download_transcode_forbidden');
        }).then(() => {
            check(JSON.stringify(logs).indexOf('secret-token') < 0 && !logs.some(log => log.fields && log.fields.url),
                'operation diagnostics never contain credentials or stream URLs');
        });
}
