(function () {
    var canonicalHostname = 'xckevin.com';
    var currentUrl = new URL(window.location.href);

    if (currentUrl.hostname === canonicalHostname && currentUrl.protocol === 'https:') {
        return;
    }

    currentUrl.protocol = 'https:';
    currentUrl.hostname = canonicalHostname;
    currentUrl.port = '';
    window.location.replace(currentUrl.toString());
})();
