// SPDX-License-Identifier: MPL-2.0
// Jellyfin JSON to Spool's normalized shapes (see sdk/provider.d.ts).

export const fields = 'SortName,Overview,ProductionYear,PremiereDate,EndDate,Status,DateCreated,DateLastContentAdded,'
    + 'ImageTags,BackdropImageTags,ParentBackdropImageTags,ParentThumbImageTag,SeriesPrimaryImageTag,UserData,'
    + 'RunTimeTicks,ChildCount,RecursiveItemCount,LocationType,IsVirtualItem,Genres,Tags,Studios,ProviderIds,'
    + 'OfficialRating,CommunityRating,CriticRating,AlbumPrimaryImageTag';

export const detailFields = fields + ',People,MediaSources,ExternalUrls,Trickplay';

export const collectionTypes = {
    movies: 'Movie', tvshows: 'Series', playlists: 'Playlist', boxsets: 'BoxSet',
    music: 'MusicAlbum', books: 'Book,AudioBook', photos: 'PhotoAlbum,Photo', musicvideos: 'MusicVideo',
    homevideos: 'Folder,Video,PhotoAlbum,Photo'
};

// Ticks can exceed JS's safe integers; pass them on as decimal strings.
export function ticks(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string' && /^\d+$/.test(value))
        return value;
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

// Jellyfin writes seven fractional digits, which Date.parse does not take.
export function time(value) {
    if (!value)
        return 0;
    const parsed = Date.parse(String(value).replace(/(\.\d{3})\d+/, '$1'));
    return Number.isFinite(parsed) ? parsed : 0;
}

function id(value) {
    return typeof value === 'string' && value ? value : undefined;
}

function stream(raw) {
    return {
        index: raw.Index, type: raw.Type, codec: raw.Codec || '', profile: raw.Profile || '',
        language: raw.Language || '', title: raw.DisplayTitle || raw.Title || '',
        width: raw.Width || 0, height: raw.Height || 0, frameRate: raw.RealFrameRate || raw.AverageFrameRate || 0,
        bitrate: raw.BitRate || 0, bitDepth: raw.BitDepth || 0, channels: raw.Channels || 0,
        sampleRate: raw.SampleRate || 0, range: raw.VideoRange || '', rangeType: raw.VideoRangeType || '',
        default: Boolean(raw.IsDefault), forced: Boolean(raw.IsForced), external: Boolean(raw.IsExternal),
        interlaced: Boolean(raw.IsInterlaced)
    };
}
export { stream };

// Only the file name leaves the server: full paths reveal its layout.
function variant(raw) {
    return {
        id: String(raw.Id), label: raw.Name || '', container: (raw.Container || '').split(',')[0],
        filename: (raw.Path || '').split(/[\\/]/).pop(), sizeBytes: ticks(raw.Size),
        bitrate: raw.Bitrate || 0, runtimeTicks: ticks(raw.RunTimeTicks),
        streams: (raw.MediaStreams || []).map(stream)
    };
}

export function item(raw) {
    if (!id(raw.Id))
        throw new Error('missing_id');
    const user = raw.UserData || {};
    const images = raw.ImageTags || {};
    const result = {
        id: raw.Id, title: raw.Name || '', sortName: raw.SortName || '', type: raw.Type || 'Folder',
        overview: raw.Overview || '', year: raw.ProductionYear || 0,
        runtimeTicks: ticks(raw.RunTimeTicks), resumeTicks: ticks(user.PlaybackPositionTicks),
        favorite: Boolean(user.IsFavorite), played: Boolean(user.Played), playCount: user.PlayCount || 0,
        datePlayed: user.LastPlayedDate || '', dateCreated: raw.DateCreated || '',
        dateUpdated: raw.DateLastContentAdded || '', premiereDate: raw.PremiereDate || '', endDate: raw.EndDate || '',
        status: raw.Status || '', childCount: raw.ChildCount || raw.RecursiveItemCount || 0,
        virtual: Boolean(raw.IsVirtualItem) || raw.LocationType === 'Virtual',
        seriesId: id(raw.SeriesId), seriesName: raw.SeriesName || '', seasonId: id(raw.SeasonId),
        // Season 0 holds specials; keep it rather than reading it as missing.
        season: Number.isInteger(raw.ParentIndexNumber) ? raw.ParentIndexNumber : undefined,
        episode: Number.isInteger(raw.IndexNumber) ? raw.IndexNumber : undefined,
        album: raw.Album || '', albumId: id(raw.AlbumId), albumArtist: raw.AlbumArtist || '',
        posterTag: images.Primary || '', logoTag: images.Logo || '', bannerTag: images.Banner || '',
        thumbTag: images.Thumb || raw.ParentThumbImageTag || '',
        backdropTag: (raw.BackdropImageTags || [])[0] || (raw.ParentBackdropImageTags || [])[0] || '',
        seriesPosterTag: raw.SeriesPrimaryImageTag || '', albumPosterTag: raw.AlbumPrimaryImageTag || '',
        genres: raw.Genres || [], tags: raw.Tags || [], studios: (raw.Studios || []).map(s => s.Name),
        officialRating: raw.OfficialRating || '', communityRating: raw.CommunityRating || 0,
        criticRating: raw.CriticRating || 0, externalIds: raw.ProviderIds || {}
    };
    if (raw.People)
        result.people = raw.People.filter(p => id(p.Id)).map(p => ({
            id: p.Id, name: p.Name || '', type: p.Type || '', role: p.Role || '', imageTag: p.PrimaryImageTag || ''
        }));
    if (raw.MediaSources)
        result.variants = raw.MediaSources.map(variant);
    if (raw.ExternalUrls)
        result.links = raw.ExternalUrls.map(link => ({ name: link.Name || '', url: link.Url || '' }));
    return result;
}

export function page(result, start, limit) {
    const rows = Array.isArray(result) ? result : result.Items || [];
    const total = Number.isSafeInteger(result.TotalRecordCount) ? result.TotalRecordCount : null;
    const exhausted = total !== null ? start + rows.length >= total : rows.length < limit;
    return { items: rows.filter(row => id(row.Id)).map(item), total: total,
        exhausted: exhausted, cursor: exhausted ? null : String(start + rows.length) };
}

// The widths the server made previews at, nearest to what the player draws.
export function trickplay(raw, variantId) {
    const all = raw && raw.Trickplay ? raw.Trickplay[variantId] || Object.values(raw.Trickplay)[0] : null;
    if (!all)
        return undefined;
    const widths = Object.values(all).sort((a, b) => Math.abs(a.Width - 320) - Math.abs(b.Width - 320));
    const best = widths[0];
    return best ? { width: best.Width, height: best.Height, columns: best.TileWidth, rows: best.TileHeight,
        count: best.ThumbnailCount, intervalMs: best.Interval } : undefined;
}

const segmentTypes = { Intro: 'Intro', Outro: 'Outro', Recap: 'Recap', Preview: 'Preview', Commercial: 'Commercial' };
export function segments(result) {
    return (result.Items || []).filter(s => segmentTypes[s.Type]).map(s => ({
        type: segmentTypes[s.Type], startTicks: ticks(s.StartTicks) || '0', endTicks: ticks(s.EndTicks) || '0'
    }));
}
