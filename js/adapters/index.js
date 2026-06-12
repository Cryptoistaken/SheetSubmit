(function() {
var __ss = window.__ss = window.__ss || {};

__ss.adapters = {};

__ss.registerAdapter = function(name, adapter) {
    __ss.adapters[name] = adapter;
};

__ss.getAdapter = function(name) {
    return __ss.adapters[name] || null;
};

})();
