(function() {
    var THEME_KEY = 'ss_theme';

    function getTheme() {
        return localStorage.getItem(THEME_KEY) || 'light';
    }

    function setTheme(theme) {
        localStorage.setItem(THEME_KEY, theme);
        document.documentElement.setAttribute('data-theme', theme);
        var logo = document.querySelector('.topbar-logo');
        var favicon = document.querySelector('link[rel="icon"]');
        var loginLogo = document.getElementById('loginLogo');
        if (logo) {
            logo.src = theme === 'dark' ? 'public/dark_logo.svg' : 'public/white_logo.svg';
        }
        if (favicon) {
            favicon.href = theme === 'dark' ? 'public/dark_favicon.svg' : 'public/white_favicon.svg';
        }
        if (loginLogo) {
            loginLogo.src = theme === 'dark' ? 'public/white_logo.svg' : 'public/dark_logo.svg';
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
