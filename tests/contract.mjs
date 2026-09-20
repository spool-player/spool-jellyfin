import {createSource} from '../logic/provider.mjs';
function check(value) { if (!value) throw new Error('contract assertion'); }
function response(value) { return Promise.resolve({status: 200, body: JSON.stringify(value)}); }
function reject(task) { return task.then(function() { throw new Error('expected rejection'); }, function() {}); }
export function run() {
    const a = createSource({server: 'http://fixture.invalid/jellyfin', userId: 'a', token: 'token-a', deviceId: 'device-a'});
    const b = createSource({server: 'http://fixture.invalid/jellyfin', userId: 'b', token: 'token-b', deviceId: 'device-b'});
    let calls = [];
    const host = {http: function(url, options) {
        calls.push({url: url, options: options});
        if (url.indexOf('/PlaybackInfo') >= 0) {
            const body = JSON.parse(options.body);
            check(body.MediaSourceId === 'exact-edition');
            return response({PlaySessionId: 'session', MediaSources: [
                {Id: 'other-edition', SupportsDirectPlay: true},
                {Id: 'exact-edition', SupportsDirectPlay: true, MediaStreams: [{Index: 0, Type: 'Video', Codec: 'hevc'}]}
            ]});
        }
        if (url.indexOf('/AuthenticateByName') >= 0)
            return response({AccessToken: 'new-a', User: {Id: 'new-user-a', Name: 'A'}});
        if (url.indexOf('/Users/') >= 0 && url.indexOf('/Items/movie') >= 0)
            return response({Id: 'movie', Name: 'Example', Type: 'Movie', MediaSources: [{Id: 'exact-edition', Name: 'Extended', Size: 1234, Path: '/private/folder/movie.mkv', MediaStreams: []}]});
        return response({TotalRecordCount: 3, Items: [{Id: 'same-id', Name: 'Example', Type: 'Movie', ProductionYear: 2020, ProviderIds: {Imdb: 'tt123'}, UserData: {IsFavorite: true, PlaybackPositionTicks: 500}}]});
    }};
    return Promise.all([a.search({query: 'Example', limit: 1}, host), b.search({query: 'Example', limit: 1}, host)]).then(function(pages) {
        check(pages[0].cursor === '1' && !pages[0].exhausted && pages[0].total === 3);
        check(pages[0].items[0].externalIds.Imdb === 'tt123');
        check(pages[0].items[0].resumeTicks === '500');
        check(calls[0].options.headers.Authorization.indexOf('token-a') >= 0);
        check(calls[1].options.headers.Authorization.indexOf('token-b') >= 0);
        check(calls[0].url.indexOf('Limit=1') >= 0);
        return a.search({query: 'Example', limit: 1, cursor: pages[0].cursor}, host);
    }).then(function() {
        check(calls[calls.length - 1].url.indexOf('StartIndex=1') >= 0);
        return a.variants({itemId: 'movie'}, host);
    }).then(function(result) {
        check(result.variants[0].filename === 'movie.mkv');
        check(result.variants[0].sizeBytes === '1234');
        check(JSON.stringify(result).indexOf('/private/') < 0);
        return a.resolve({itemId: 'movie', variantId: 'exact-edition'}, host);
    }).then(function(result) {
        check(result.variantId === 'exact-edition');
        check(result.video.url.indexOf('MediaSourceId=exact-edition') >= 0);
        check(result.video.headers['X-Emby-Token'] === 'token-a');
        return reject(a.resolve({itemId: 'movie', variantId: 'missing'}, {http: function() {return response({MediaSources: [{Id: 'other', SupportsDirectPlay: true}]});}}));
    }).then(function() {
        return a.authenticate({username: 'A', password: 'fixture'}, host);
    }).then(function() {
        calls = [];
        return Promise.all([a.search({query: 'A'}, host), b.search({query: 'B'}, host)]);
    }).then(function() {
        check(calls[0].options.headers.Authorization.indexOf('new-a') >= 0);
        check(calls[1].options.headers.Authorization.indexOf('token-b') >= 0);
        return reject(a.search({query: 'x'}, {http: function() {return Promise.resolve({status: 401, body: '{}'});}}));
    });
}
