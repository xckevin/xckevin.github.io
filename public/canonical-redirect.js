(function () {
    var canonicalHostname = 'xckevin.com';
    var currentUrl = new URL(window.location.href);
    var localHostnames = ['localhost', '127.0.0.1', '::1'];

    if (localHostnames.indexOf(currentUrl.hostname) !== -1) {
        return;
    }

    if (currentUrl.hostname === canonicalHostname && currentUrl.protocol === 'https:') {
        return;
    }

    currentUrl.protocol = 'https:';
    currentUrl.hostname = canonicalHostname;
    currentUrl.port = '';
    window.location.replace(currentUrl.toString());
})();
