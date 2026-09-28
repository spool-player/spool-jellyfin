// SPDX-License-Identifier: MPL-2.0

function ipv4(host) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part =>
        /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function ipv6(host) {
    if (!/^\[[0-9a-f:]+\]$/i.test(host))
        return false;
    const text = host.slice(1, -1);
    const halves = text.split('::');
    const groups = text.split(':').filter(Boolean);
    return halves.length <= 2 && halves.every(half => half === '' || half.split(':').every(Boolean))
        && groups.every(part => /^[0-9a-f]{1,4}$/i.test(part))
        && (halves.length === 2 ? groups.length < 8 : groups.length === 8);
}

function parse(input) {
    const text = String(input || '').trim().replace(/\/+$/, '');
    const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    const parts = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/:?#@\s\\]+)(:\d+)?(\/[^?#\\\s]*)?$/i.exec(
        explicit ? text : 'https://' + text);
    if (!parts)
        throw new Error('invalid_server');
    const host = parts[2];
    const literal = ipv4(host) || ipv6(host);
    const dns = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(host)
        && host.replace(/\.$/, '').split('.').every(label => label.length <= 63
            && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
    if ((!literal && (!dns || /^[\d.]+$/.test(host)))
        || (parts[3] && (Number(parts[3].slice(1)) < 1 || Number(parts[3].slice(1)) > 65535)))
        throw new Error('invalid_server');
    return { scheme: parts[1].toLowerCase(), host: host, port: parts[3] || '', path: parts[4] || '',
        explicit: explicit, literal: literal };
}

function local(host) {
    const name = host.toLowerCase().replace(/\.$/, '');
    if (name === 'localhost' || name.endsWith('.localhost') || name === '[::1]'
        || /^\[(fc|fd|fe[89ab])/i.test(name))
        return true;
    if (!ipv4(host))
        return false;
    const parts = host.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
}

export function serverCandidates(input) {
    const address = parse(input);
    const url = (scheme, port) => scheme + '://' + address.host + port + address.path;
    if (address.explicit)
        return [url(address.scheme, address.port)];
    const https = url('https', address.port);
    const http = url('http', address.port || ':8096');
    const fallback = url('http', address.port);
    const candidates = local(address.host) ? [http, https, fallback] : [https, http, fallback];
    return candidates.filter((entry, index) => candidates.indexOf(entry) === index);
}

export function normalizeServer(input) {
    return serverCandidates(input)[0];
}

export function discoveryAddress(input, sender) {
    const address = parse(input);
    // A configured DNS name can deliberately point through a reverse proxy.
    // Only literal announcements are corrected to the UDP packet's sender.
    if (address.literal && sender) {
        const host = sender.indexOf(':') >= 0 && sender[0] !== '[' ? '[' + sender + ']' : sender;
        if (ipv4(host) || ipv6(host))
            address.host = host;
    }
    return address.scheme + '://' + address.host + address.port + address.path;
}
