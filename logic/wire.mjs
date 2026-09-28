// SPDX-License-Identifier: MPL-2.0
// Only explicitly wrapped tick values bypass JSON.stringify's number conversion.
class TickInteger {
    constructor(value) {
        this.decimal = value;
    }
}

export function tickInteger(value) {
    if (value === undefined)
        value = '0';
    if (typeof value === 'number' && Number.isSafeInteger(value))
        value = String(value);
    if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value))
        throw new Error('invalid_position');
    const negative = value[0] === '-';
    const digits = negative ? value.slice(1) : value;
    const maximum = negative ? '9223372036854775808' : '9223372036854775807';
    if (digits.length > maximum.length || (digits.length === maximum.length && digits > maximum))
        throw new Error('invalid_position');
    return new TickInteger(value);
}

// Request DTOs are plain JSON objects. Preserve normal escaping and omission of
// undefined properties, without placeholder replacement that could alter strings.
export function wireJson(value) {
    if (value instanceof TickInteger)
        return value.decimal;
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        const entries = [];
        for (let index = 0; index < value.length; ++index) {
            const encoded = wireJson(value[index]);
            entries.push(encoded === undefined ? 'null' : encoded);
        }
        return '[' + entries.join(',') + ']';
    }
    const fields = [];
    for (const key of Object.keys(value)) {
        const encoded = wireJson(value[key]);
        if (encoded !== undefined)
            fields.push(JSON.stringify(key) + ':' + encoded);
    }
    return '{' + fields.join(',') + '}';
}
