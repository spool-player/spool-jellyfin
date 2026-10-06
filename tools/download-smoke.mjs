// SPDX-License-Identifier: MPL-2.0
// Run only against a disposable server with generated media. Never prints URLs/tokens.
import { readFile, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { createSource } from '../logic/provider.mjs';

const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'));
const host = {
    device: { id: 'smoke-device', name: 'Isolated smoke', version: '0.9.0' },
    isLogEnabled: () => false,
    log: () => {},
    http: async (url, options) => {
        const response = await fetch(url, { method: options.method, headers: options.headers,
            body: options.body || undefined, redirect: 'error' });
        return { status: response.status, body: await response.text() };
    }
};
const source = createSource(configuration, host);
const catalogue = await source.browse({ filters: { includeItemTypes: ['Movie'] }, limit: 10 }, host);
const media = catalogue.items.find(item => !item.folder && item.type === 'Movie');
if (!media)
    throw new Error('No disposable movie found');
const details = await source.details({ itemId: media.id, videoPreviews: false }, host);
const variants = details.item.variants || [];
if (variants.length !== 1)
    throw new Error('Smoke needs one generated finite file');
const directory = await mkdtemp(join(tmpdir(), 'spool-jellyfin-transfers-'));
for (const mode of ['original', 'transcoded']) {
    const plan = await source.download({ itemId: media.id, variantId: variants[0].id,
        mode: mode, maxBitrate: 1000000, maxHeight: 180 }, host);
    try {
        if (!plan.url || plan.pick)
            throw new Error('Expected finite download plan');
        const response = await fetch(plan.url, { headers: plan.headers, redirect: 'error' });
        if (response.status !== 200 || !response.body)
            throw new Error('Transfer failed: HTTP ' + response.status);
        const output = join(directory, mode + '.' + plan.container);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
        console.log(JSON.stringify({ mode: mode, container: plan.container, bytes: Number(probe.format.size),
            duration: Number(probe.format.duration), codecs: probe.streams.map(stream => stream.codec_name),
            videoHeight: (probe.streams.find(stream => stream.codec_type === 'video') || {}).height }));
        if (!(Number(probe.format.duration) > 0) || !(Number(probe.format.size) > 0))
            throw new Error('Incomplete media file');
        if (mode === 'transcoded' && (!probe.streams.some(stream => stream.codec_name === 'h264' && stream.height <= 180)
            || !probe.streams.some(stream => stream.codec_name === 'aac')))
            throw new Error('Progressive output was not actually encoded at requested quality');
        if (mode === 'original' && plan.size !== Number(probe.format.size))
            throw new Error('Original transfer did not retain selected source byte size');
    } finally {
        if (plan.cleanup)
            await source.downloadRelease({ cleanup: plan.cleanup }, host);
    }
}
console.log('Finite original/progressive transfers and session cleanup passed');
