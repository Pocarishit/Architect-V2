-- Optional: trims the custom-code rollback history in architect_prefs to the last 3 releases.
-- Paste into Supabase > SQL Editor > New query > Run. Ask Maveri first (it removes his older rollbacks).
update architect_prefs
set data = jsonb_set(data, '{releases}', (
  select coalesce(jsonb_agg(r order by (r->>'v')::int), '[]'::jsonb)
  from (select r from jsonb_array_elements(data->'releases') r
        order by (r->>'v')::int desc limit 3) s))
where data ? 'releases';
