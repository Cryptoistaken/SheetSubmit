(function() {
var __ss = window.__ss = window.__ss || {};

__ss.FILE_TYPES = {
    ig_cookie: {
        label: 'IG Cookie',
        badge: 'IG Cookie',
        badgeClass: 't-ig',
        icon: 'IG',
        desc: 'username, password & cookies',
        columns: [
            { key: 'username', label: 'username', width: 140 },
            { key: 'password', label: 'password', width: 140 },
            { key: 'cookies', label: 'cookies', width: 200 },
        ]
    }
};

__ss.FILE_TYPE_KEYS = Object.keys(__ss.FILE_TYPES);

__ss.getTypeDef = function(typeKey) {
    return __ss.FILE_TYPES[typeKey] || __ss.FILE_TYPES['ig_cookie'];
};

})();
