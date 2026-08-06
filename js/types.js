(function() {
var __ss = window.__ss = window.__ss || {};

__ss.FILE_TYPES = {
    ig_cookie: {
        label: 'IG Cookie',
        badge: 'IG Cookie',
        badgeClass: 't-ig',
        icon: 'IG',
        desc: 'username, password & 2fa key',
        columns: [
            { key: 'username', label: 'username', width: 140 },
            { key: 'password', label: 'password', width: 140 },
            { key: 'twofa', label: '2fa', width: 200 },
        ]
    },
    fb_cookie: {
        label: 'FB Cookie',
        badge: 'FB Cookie',
        badgeClass: 't-fb',
        icon: 'FB',
        desc: 'cookies, 2fa key & uid',
        columns: [
            { key: 'cookies', label: 'cookies', width: 340 },
            { key: 'twofakey', label: '2fa key', width: 200 },
            { key: 'uid', label: 'uid', width: 120 },
        ]
    }
};

__ss.FILE_TYPE_KEYS = Object.keys(__ss.FILE_TYPES);

__ss.getTypeDef = function(typeKey) {
    return __ss.FILE_TYPES[typeKey] || __ss.FILE_TYPES['ig_cookie'];
};

})();
