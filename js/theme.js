(function() {
    var THEME_KEY = 'ss_theme';
    var _logo, _favicon, _loginLogo;

    function getTheme() {
        return localStorage.getItem(THEME_KEY) || 'light';
    }

    function setTheme(theme) {
        localStorage.setItem(THEME_KEY, theme);
        document.documentElement.setAttribute('data-theme', theme);
        _logo = _logo || document.querySelector('.topbar-logo');
        _favicon = _favicon || document.querySelector('link[rel="icon"]');
        _loginLogo = _loginLogo || document.getElementById('loginLogo');
        if (_logo) {
            _logo.src = theme === 'dark' ? 'public/logo-dark.svg' : 'public/logo-light.svg';
        }
        if (_favicon) {
            _favicon.href = theme === 'dark' ? 'public/favicon-dark.svg' : 'public/favicon-light.svg';
        }
        if (_loginLogo) {
            _loginLogo.src = theme === 'dark' ? 'public/logo-light.svg' : 'public/logo-dark.svg';
        }
    }

    function toggleTheme() {
        var current = getTheme();
        var next = current === 'dark' ? 'light' : 'dark';
        setTheme(next);
        return next;
    }

    window.__theme = { getTheme: getTheme, setTheme: setTheme, toggleTheme: toggleTheme };
    setTheme(getTheme());
})();
