# Architect — Agent API

One token, one account, the same shape as the Anytype connector: a hashed token passed as an
argument to a `security definer` RPC. No service key is needed and no password is ever used.

Everything below is scoped to the token's own `user_id`. Tables are never taken from input except
the read-only allowlist.

## Endpoint

```
POST https://zponpcmqwabtfhgcqjpw.supabase.co/rest/v1/rpc/architect_agent_call
apikey: sb_publishable_-i8zqVpYeHwlYgvo3Vx0Vg_dQ1NVwRn
Content-Type: application/json

{ "p_token": "<token>", "p_action": "vars.get", "p_args": {} }
```

The result is plain JSON in the PostgREST `json` column.

## Minting a token (signed in, from the app console)

```js
const s = JSON.parse(localStorage['architect.sb.session']);
const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
await fetch('https://zponpcmqwabtfhgcqjpw.supabase.co/rest/v1/rpc/architect_agent_mint', {
  method: 'POST',
  headers: { apikey: 'sb_publishable_-i8zqVpYeHwlYgvo3Vx0Vg_dQ1NVwRn', Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_name: 'Clyde', p_token: token, p_scopes: ['vars', 'path', 'boards', 'read'] })
}).then(r => r.json());
console.log(token);  // the only time the raw token is visible; only its sha256 is stored
```

`architect_agent_list()` returns what exists, `architect_agent_revoke(id)` kills one instantly.

## Actions

| action | args | returns |
| --- | --- | --- |
| `me` | — | `{user_id, name, scopes}` |
| `vars.get` | — | `{data, updated_at}` or `null` |
| `vars.put` | `{data, if_rev?}` | `{rev, updated_at}` |
| `vars.patch` | `{data, if_rev?}` | `{rev, updated_at}` (top-level keys merged) |
| `path.get` | — | `{columns, tasks}` |
| `path.column.add` | `{title, position?}` | the column row |
| `path.column.update` | `{id, title?, position?}` | the column row |
| `path.column.delete` | `{id}` | `{deleted}` (tasks cascade) |
| `path.task.add` | `{column_id, title, note?, done?, position?}` | the task row |
| `path.task.update` | `{id, title?, note?, done?, position?, column_id?}` | the task row |
| `path.task.delete` | `{id}` | `{deleted}` |
| `board.list` | — | `[{id, name, folder_id, pinned, updated_at}]` |
| `board.get` | `{id}` | the whole blueprint row incl. `data` |
| `board.put` | `{id?, name?, folder_id?, data?, preview?, pinned?}` | the row |
| `board.append` | `{id, elements: [...]}` | `{id, elements}` |
| `read` | `{table, where?, limit?}` | rows, read-only |

`read` allowlist: `architect_variables`, `path_columns`, `path_tasks`, `blueprints`,
`archive_folders`, `streak_days`, `architect_prefs`.

## Examples

```bash
# who am I
curl -s https://zponpcmqwabtfhgcqjpw.supabase.co/rest/v1/rpc/architect_agent_call \
  -H 'apikey: sb_publishable_-i8zqVpYeHwlYgvo3Vx0Vg_dQ1NVwRn' -H 'Content-Type: application/json' \
  -d '{"p_token":"TOKEN","p_action":"me"}'

# read the Variables row
curl -s ... -d '{"p_token":"TOKEN","p_action":"vars.get"}'

# write it back, refusing if someone saved in the meantime
curl -s ... -d '{"p_token":"TOKEN","p_action":"vars.put","p_args":{"data":{...},"if_rev":1764270000000}}'

# add a task to a Path column
curl -s ... -d '{"p_token":"TOKEN","p_action":"path.task.add","p_args":{"column_id":"<uuid>","title":"Audit Luc"}}'
```

## Safety

- Tokens are stored as sha256 only; a leaked database row cannot be replayed.
- Revoking is immediate (`architect_agent_revoke`), and `last_seen_at` shows use.
- `vars.put` accepts `if_rev` and raises `rev_conflict` (HTTP 409-ish, code 40001) instead of
  clobbering a newer copy — the same protection the client patch adds on the app side.
- `revoke all on function ... from public` keeps the internals (`architect_agent__who`) unreachable;
  only the call surface is granted to `anon`.
