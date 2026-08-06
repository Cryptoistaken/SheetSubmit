(function() {
var __ss = window.__ss;

var _syncConcurrency = 0;
var MAX_CONCURRENT_SYNC = 3;

__ss.registerAdapter('ig-cookie', {
    name: 'IG Auto Cookies + SkySys Push',

    // Generate TOTP code from secret
    generateTOTP: async function(secret) {
        if (!secret) return '';
        secret = secret.replace(/\s/g, '').toUpperCase();
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        var bits = '';
        for (var i = 0; i < secret.length; i++) {
            var val = alphabet.indexOf(secret[i]);
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }
        var bytes = new Uint8Array(Math.floor(bits.length / 8));
        for (var i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
        }
        var key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
        var epoch = Math.floor(Date.now() / 1000);
        var time = Math.floor(epoch / 30);
        var timeBytes = new ArrayBuffer(8);
        new DataView(timeBytes).setUint32(4, time, false);
        var hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(timeBytes)));
        var offset = hash[hash.length - 1] & 0x0f;
        var code = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
        return (code % 1000000).toString().padStart(6, '0');
    },

    // Fetch cookies via IG API (proxied through server)
    fetchCookies: async function(username, password, twofaKey) {
        var jobRes = await fetch('/api/ig/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames: [username], commonPassword: password, twofaCodes: [twofaKey] })
        });
        if (!jobRes.ok) throw new Error('Job create failed: ' + jobRes.status);
        var jobId = (await jobRes.json()).jobId;
        var startTime = Date.now();
        var MAX_WAIT_MS = 120000;
        while (true) {
            if (Date.now() - startTime > MAX_WAIT_MS) {
                throw new Error('fetchCookies timed out after ' + MAX_WAIT_MS + 'ms');
            }
            var pollRes = await fetch('/api/ig/jobs/' + jobId);
            var job = (await pollRes.json()).job;
            if (job.status === 'completed') {
                var acct = job.accounts[0];
                if (acct.status === 'done') return { username: username, password: password, cookies: acct.cookies, csrfToken: acct.csrfToken };
                throw new Error(username + ': ' + (acct.errorReason || 'failed'));
            }
            if (job.accounts[0] && job.accounts[0].status === 'failed') {
                throw new Error(username + ': ' + (job.accounts[0].errorReason || 'failed'));
            }
            await new Promise(function(r) { setTimeout(r, 2000); });
        }
    },

    // Push cookies via SkySys (proxied through server)
    pushCookies: async function(username, password, cookies) {
        var payload = username + ':' + password + '|||' + cookies + '||';
        var b64 = btoa(unescape(encodeURIComponent(payload)));
        var res = await fetch('/api/sky/push', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'accounts=' + b64 });
        if (!res.ok) {
            var errBody;
            try { errBody = await res.json(); } catch(e) { errBody = await res.text(); }
            throw { message: 'Push failed: ' + res.status, request: 'POST /e/boss | username=' + username, response: JSON.stringify(errBody) };
        }
        var data = await res.json();
        var jobId = data.job_id;
        if (!jobId) throw { message: 'No job_id in response', request: 'POST /e/boss | username=' + username, response: JSON.stringify(data) };
        var startTime = Date.now();
        var MAX_WAIT_MS = 120000;
        while (true) {
            if (Date.now() - startTime > MAX_WAIT_MS) {
                throw { message: 'pushCookies timed out after ' + MAX_WAIT_MS + 'ms', request: 'POST /e/boss | username=' + username };
            }
            var sRes = await fetch('/api/sky/status/' + jobId);
            var info = await sRes.json();
            if (info.status === 'done') return { username: username, jobId: jobId, success: info.data.success_count, failed: info.data.failed_count, elapsed: info.elapsed_seconds };
            await new Promise(function(r) { setTimeout(r, info.status === 'staging' ? 5000 : 2000); });
        }
    },

    // Full sync: fetch cookies then push
    syncRow: async function(row, password) {
        if (_syncConcurrency >= MAX_CONCURRENT_SYNC) {
            return { username: row.username, status: 'skipped', reason: 'concurrency limit' };
        }
        _syncConcurrency++;
        var result = { username: row.username, calls: [] };
        try {
            var cookieData = await this.fetchCookies(row.username, password, row.twofa);
            result.calls.push({
                type: 'fetch',
                request: 'POST /api/jobs | username=' + row.username,
                response: JSON.stringify({ cookies: cookieData.cookies ? cookieData.cookies.slice(0, 200) + '...' : '', csrfToken: cookieData.csrfToken })
            });
            result.cookies = cookieData.cookies;
        } catch(e) {
            result.calls.push({
                type: 'fetch',
                request: 'POST /api/jobs | username=' + row.username,
                response: JSON.stringify({ error: e.message || e })
            });
            result.status = 'failed';
            _syncConcurrency--;
            return result;
        }

        try {
            var pushResult = await this.pushCookies(row.username, password, result.cookies);
            var pushOk = pushResult.failed === 0 && pushResult.success > 0;
            result.calls.push({
                type: 'push',
                request: 'POST /e/boss | username=' + row.username,
                response: JSON.stringify({ jobId: pushResult.jobId, success: pushResult.success, failed: pushResult.failed, elapsed: pushResult.elapsed })
            });
            result.pushResult = pushResult;
            result.status = pushOk ? 'done' : 'failed';
            if (!pushOk) result.error = 'push: success=' + pushResult.success + ' failed=' + pushResult.failed;
        } catch(e) {
            result.calls.push({
                type: 'push',
                request: e.request || 'POST /e/boss | username=' + row.username,
                response: e.response || JSON.stringify({ error: e.message || e })
            });
            result.status = 'failed';
        }
        _syncConcurrency--;
        return result;
    }
});

})();
