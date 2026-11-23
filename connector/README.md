# Architect ⇄ Anytype connector

Runs on the Windows PC where Anytype Desktop runs. It reads only the Anytype sources you map, through Anytype's
loopback API (`http://127.0.0.1:31009`), and publishes the allowed fields to your Architect account over HTTPS.
Your phone just signs in to Architect — no IP address, port, Anytype key or shared Wi-Fi.

```
Anytype Desktop ──127.0.0.1──▶ connector (this PC) ──HTTPS──▶ Architect (Supabase) ◀── desktop + phone
```

- **One-way.** Anytype owns the wording; Architect owns checkmarks and daily goals. Nothing is written to Anytype.
- **Private.** Destinations are your own Path Set-Points. Chats, raw pages and whole spaces are never imported.
- **Secrets stay put.** The Anytype key and the connector's Architect token live in Windows DPAPI (current user).
  `config.json` holds only non-secret settings. Logs show counts and statuses — no content, no keys.

## Setup (once)

Needs **Node 18+** and Anytype Desktop running. Run `supabase/anytype.sql` in the Supabase SQL editor first.

1. Architect → **Settings → Integrations → Connect a PC**. Copy the command it shows and run it in this folder:
   ```
   node architect-anytype.mjs pair ABCD-EFGH --project https://….supabase.co --key sb_publishable_…
   ```
2. Connect Anytype (approve the 4-digit code in Anytype, or paste a key from Anytype → Settings → API keys):
   ```
   node architect-anytype.mjs connect-anytype
   ```
3. Open the mapping editor — pick the Set-Point, the page and its heading, check the preview, **Turn on sync**:
   ```
   node architect-anytype.mjs ui
   ```
   Tip: give each Set-Point page a heading called **Path items** and put the bullets under it. Bullets stop at the
   next heading of the same or higher level.
4. Keep it running at sign-in (hidden, no Claude Code or browser tab needed):
   ```
   powershell -ExecutionPolicy Bypass -File install-windows.ps1
   ```
   The editor then stays at <http://127.0.0.1:31019> (this PC only).

Turn on **Anytype imports** in Architect → Settings → Integrations (off by default).

## When things go wrong

| What you see in Architect | What it means |
|---|---|
| Waiting for desktop | The PC is asleep/off or the connector isn't running. The last import stays usable. |
| Anytype isn't running on the PC | Open Anytype. Imports resume within a few minutes (or press Sync now). |
| The section heading is missing | The heading was renamed/deleted. Pick it again in the editor. Old items stay. |
| Access to Anytype was revoked | Run `connect-anytype` again. |
| Partial read | Anytype returned an incomplete list; nothing was changed. It retries with backoff. |

Errors never delete anything: items are archived only after a complete, validated read.

## Commands

```
pair <CODE> --project <url> --key <publishable key> [--name "My PC"]
connect-anytype [--key <anytype api key>]
ui                 mapping editor + sync (opens http://127.0.0.1:31019)
run [--ui]         background sync (what the scheduled task runs)
sync               one sync now, then exit
status             pairing, Anytype access, mappings
inspect [--space <id>] [--collection <id>] [--object <id> [--ids]]   read-only smoke test, no content
forget             delete the saved token, key and config from this PC
```

`inspect --object <page id> --ids` prints each block's id, type and indent (never its text). Run it before and
after editing a page to confirm block ids survive edits — mappings key on ids, never on text or position.

## Remove

```
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
node architect-anytype.mjs forget
```
Then Architect → Settings → Integrations → **Disconnect** (and optionally remove the imported items).

## Tests

`test/` holds the gates from the runbook (§06): a mock Anytype with v2 response shapes, the real
`supabase/anytype.sql` in a local Postgres (`test/stub.sql` stands in for Supabase's auth schema), and
`test/e2e.mjs` (pairing, preview, first import, repeat without duplicates, edits keep ids and checkmarks,
missing heading / Anytype closed / partial read keep the last import, archive after a complete read,
collection with chats excluded and typed dates, revocation, redacted logs, local-UI host/origin/session guards).
`test/sql-gates.sql` covers cross-account isolation, stale versions, field allowlists and column grants.
