\set ON_ERROR_STOP 0
-- 1. pairing as user 1
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.anytype_pair_start() as pair \gset
\echo pair :pair
reset role;
select (:'pair'::jsonb)->>'code' as code \gset
set role anon; set request.jwt.claim.sub = '';
select public.anytype_pair_finish(:'code', 'Test PC') as fin \gset
\echo finished :fin
-- reuse must fail
select public.anytype_pair_finish(:'code', 'Again');
reset role;
select (:'fin'::jsonb)->>'token' as tok \gset
set role anon;
select public.anytype_poll(:'tok');
select public.anytype_destinations(:'tok');
-- 2. mapping: variables rejected; other user's column rejected
select public.anytype_save_mapping(:'tok', '{"dest_kind":"variables","dest_id":"x","source_kind":"section","source_space_id":"s","source_id":"p","section_block_id":"h"}');
select public.anytype_save_mapping(:'tok', '{"dest_kind":"path","dest_id":"bbbbbbbb-0000-0000-0000-000000000001","source_kind":"section","source_space_id":"s","source_id":"p","section_block_id":"h"}');
select public.anytype_save_mapping(:'tok', '{"name":"GM","dest_kind":"path","dest_id":"aaaaaaaa-0000-0000-0000-000000000001","dest_name":"Morning","source_kind":"section","source_space_id":"u57ueu","source_id":"pageGM","section_block_id":"h1","allow_fields":["title"]}') as m \gset
reset role;
select (:'m'::jsonb)->>'id' as mid, (:'m'::jsonb)->>'version' as ver \gset
\echo mapping :mid v:ver
set role anon;
-- resave same scope: version stays 1
select (public.anytype_save_mapping(:'tok', jsonb_build_object('id', :'mid', 'name','GM2','dest_kind','path','dest_id','aaaaaaaa-0000-0000-0000-000000000001','source_kind','section','source_space_id','u57ueu','source_id','pageGM','section_block_id','h1','allow_fields', '["title"]'::jsonb)))->>'version' as v_same;
-- 3. publish with extra fields (body not allowed) + duplicate + missing title
select public.anytype_publish(:'tok', :'mid', 1, '[
 {"source_object_id":"pageGM","source_block_id":"b1","fields":{"title":"Walk","body":"SECRET"},"sort":1},
 {"source_object_id":"pageGM","source_block_id":"b2","fields":{"title":"Read"},"sort":2},
 {"source_object_id":"pageGM","source_block_id":"b2","fields":{"title":"Read dup"},"sort":3},
 {"source_object_id":"pageGM","source_block_id":"b3","fields":{"title":"  "},"sort":4}
]'::jsonb, true);
-- rerun same: no new/changed
select public.anytype_publish(:'tok', :'mid', 1, '[
 {"source_object_id":"pageGM","source_block_id":"b1","fields":{"title":"Walk"},"sort":1},
 {"source_object_id":"pageGM","source_block_id":"b2","fields":{"title":"Read"},"sort":2}]'::jsonb, true);
-- edit one, drop one (complete) → 1 changed, 1 archived
select public.anytype_publish(:'tok', :'mid', 1, '[
 {"source_object_id":"pageGM","source_block_id":"b1","fields":{"title":"Walk 30 min"},"sort":1}]'::jsonb, true);
-- stale version
select public.anytype_publish(:'tok', :'mid', 7, '[]'::jsonb, true);
select public.anytype_report(:'tok', :'mid', 1, 'missing_section', E'heading gone\n');
reset role;
select key, fields, archived from public.anytype_items order by sort;
select status, message, item_count, last_success_at is not null as ok from public.anytype_runs;
-- 4. app as user 1: sees items, can check, cannot write items or mapping scope
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select count(*) as mine from public.anytype_items;
select key as k1 from public.anytype_items where not archived limit 1 \gset
select public.anytype_set_check(:'k1', '2026-11-23', true);
select public.anytype_set_check(:'k1', '2026-11-23', false);
select item_key = :'k1' as same, done from public.anytype_checks;
update public.anytype_items set fields = '{"title":"hack"}';
update public.anytype_mappings set dest_id = 'x';
update public.anytype_mappings set paused = true returning paused;
-- paused → publish rejected
set role anon;
select public.anytype_publish(:'tok', :'mid', 1, '[]'::jsonb, true);
-- 5. user 2 sees nothing
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as other_items from public.anytype_items;
select count(*) as other_maps from public.anytype_mappings;
select count(*) as other_checks from public.anytype_checks;
-- 6. revoke → connector dead
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.anytype_connectors set revoked_at = now();
set role anon;
select public.anytype_poll(:'tok');
-- anon can't read tables
select count(*) from public.anytype_items;
