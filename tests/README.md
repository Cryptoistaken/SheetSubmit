# SheetSubmit Test Harness

Local test environment (never touches production Redis):

| Component | Value |
|-----------|-------|
| Server | `http://127.0.0.1:3123` (running now, local Redis) |
| Main Redis | `redis://127.0.0.1:6399` (db default) |
| Backup Redis | `redis://127.0.0.1:6400` |
| Admin user id | `8447133985` |

## Shared helper: `tests/helpers.js`

```js
const h = require('./helpers');
await h.createSession(userId);      // writes ss:session:<id> into main redis, returns sessionId
await h.req('PUT', '/api/files/x/persist', { sessionId, body: {...} });  // returns { status, json }
h.mainRedis() / h.backupRedis();    // ioredis clients
```

Auth: a session is a JSON `{ userId }` stored at `ss:session:<sessionId>`.
Send `Cookie: session=<sessionId>` on every API request.

## Key naming (server prefix is `ss:`)

All server keys go through `key(k)` = `'ss:' + k`. So:
`ss:files:<userId>`, `ss:rows:<fileId>`, `ss:undo:<fileId>`, `ss:redo:<fileId>`,
`ss:sync:<fileId>`, `ss:logs:<fileId>`, `ss:hist:<fileId>`, `ss:archive:<userId>`,
`ss:session:<sessionId>`, `ss:meta:dirty`, `ss:wa:<c_user>`.

## Rules for test agents

- Only edit the files assigned to you. Report bugs in other files without editing them.
- Write tests under `tests/<scope>/` using `node:test` runner: `node --test tests/<scope>/`.
- After editing a server file, run `node --check <file>`.
- Do NOT use production credentials. Everything runs against 127.0.0.1.
- The live server on :3123 is owned by the server-API agent. If you restart it, use
  the same env override: `$env:REDIS_URL="redis://127.0.0.1:6399"; $env:PORT="3123"; $env:TG_BOT_TOKEN=""`.
