// SPDX-License-Identifier: MPL-2.0
export function logging(levels = [], entries = []) {
    return {
        isLogEnabled: level => levels.indexOf(level) >= 0,
        log: (level, message, fields) => {
            if (levels.indexOf(level) >= 0)
                entries.push({ level: level, message: typeof message === 'function' ? message() : message, fields: fields });
        }
    };
}
