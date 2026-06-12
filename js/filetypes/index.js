(function() {
var __ss = window.__ss = window.__ss || {};

__ss.fileBehaviors = {};

__ss.registerFileBehavior = function(typeKey, behavior) {
    __ss.fileBehaviors[typeKey] = behavior;
};

__ss.getFileBehavior = function(typeKey) {
    return __ss.fileBehaviors[typeKey] || null;
};

})();
