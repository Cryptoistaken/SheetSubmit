var Redis = require('ioredis');

var BACKUP_INTERVAL_MS = (parseInt(process.env.BACKUP_INTERVAL, 10) || 5) * 60 * 1000;
var _backupRedis = null;
var _lastKeyCount = -1;

function getBackupRedis() {
    if (!_backupRedis && process.env.REDIS_BACKUP_URL) {
        var url = process.env.REDIS_BACKUP_URL;
        var opts = {
            maxRetriesPerRequest: 2,
            retryStrategy: function(times) { return Math.min(times * 300, 3000); },
            lazyConnect: true,
        };
        if (url.startsWith('rediss://') || url.includes('upstash.io')) {
            opts.tls = {};
        }
        _backupRedis = new Redis(url, opts);
        _backupRedis.on('error', function(err) {
            console.error('[Backup] Backup Redis error: ' + err.message);
        });
    }
    return _backupRedis;
}

async function copyKeys(source, dest) {
    var count = 0, errors = 0;
    var cursor = '0';
    do {
        var result = await source.scan(cursor, 'MATCH', 'ss:*', 'COUNT', '500');
        cursor = result[0];
        for (var key of result[1]) {
            try {
                var type = await source.type(key);
                var ttl = await source.ttl(key);
                if (type === 'string') {
                    var val = await source.get(key);
                    if (val !== null) {
                        if (ttl > 0) await dest.set(key, val, 'PX', ttl * 1000);
                        else await dest.set(key, val);
                        count++;
                    }
                } else if (type === 'list') {
                    var items = await source.lrange(key, 0, -1);
                    if (items.length > 0) {
                        await dest.del(key);
                        await dest.rpush(key, items);
                        if (ttl > 0) await dest.pexpire(key, ttl * 1000);
                        count++;
                    }
                } else if (type === 'set') {
                    var members = await source.smembers(key);
                    if (members.length > 0) {
                        await dest.del(key);
                        await dest.sadd(key, members);
                        if (ttl > 0) await dest.pexpire(key, ttl * 1000);
                        count++;
                    }
                } else if (type === 'hash') {
                    var obj = await source.hgetall(key);
                    var keys = Object.keys(obj);
                    if (keys.length > 0) {
                        await dest.del(key);
                        var bulk = [];
                        for (var hk of keys) { bulk.push(hk, obj[hk]); }
                        await dest.hset(key, bulk);
                        if (ttl > 0) await dest.pexpire(key, ttl * 1000);
                        count++;
                    }
                } else {
                    var data = await source.dump(key);
                    if (data) {
                        await dest.restore(key, ttl > 0 ? ttl * 1000 : 0, data, 'REPLACE');
                        count++;
                    }
                }
            } catch (e) {
                errors++;
                if (errors <= 3) console.error('[Backup] copy failed for ' + key + ': ' + e.message);
            }
        }
    } while (cursor !== '0');
    if (errors > 0) console.error('[Backup] ' + errors + ' key(s) failed to copy');
    return count;
}

async function createBackup(source) {
    try {
        var dest = getBackupRedis();
        if (!dest) return -1;
        if (dest.status !== 'ready') {
            try { await dest.connect(); } catch(e) {
                console.error('[Backup] connect failed: ' + e.message);
                return -1;
            }
        }

        var keyCount = await source.dbsize();
        if (keyCount === _lastKeyCount) return 0;

        var count = await copyKeys(source, dest);
        console.log('[Backup] Synced ' + count + ' ss:* keys' + (keyCount === _lastKeyCount ? '' : ' (' + _lastKeyCount + '→' + keyCount + ' total)'));
        _lastKeyCount = keyCount;
        return count;
    } catch (e) {
        console.error('[Backup] createBackup error: ' + e.message);
        return -1;
    }
}

async function restoreFromBackup(dest) {
    try {
        var dbsize = await dest.dbsize();
        if (dbsize > 3) {
            console.log('[Backup] Main Redis has ' + dbsize + ' keys, skipping restore');
            return false;
        }

        var source = getBackupRedis();
        if (!source) return false;
        if (source.status !== 'ready') {
            try { await source.connect(); } catch(e) {
                console.error('[Backup] restore connect failed: ' + e.message);
                return false;
            }
        }

        var backupCount = await source.dbsize();
        if (backupCount === 0) return false;

        var count = await copyKeys(source, dest);
        console.log('[Backup] Restored ' + count + ' keys from backup Redis');
        return count > 0;
    } catch (e) {
        console.error('[Backup] restoreFromBackup error: ' + e.message);
        return false;
    }
}

function startBackupLoop(source) {
    if (!process.env.REDIS_BACKUP_URL) return;
    setTimeout(async function() {
        await createBackup(source);
        setInterval(function() { createBackup(source); }, BACKUP_INTERVAL_MS);
        console.log('[Backup] Scheduled every ' + (BACKUP_INTERVAL_MS / 60000) + ' min');
    }, 10000);
}

module.exports = { createBackup, restoreFromBackup, startBackupLoop };
