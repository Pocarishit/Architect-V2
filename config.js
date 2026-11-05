// Architect configuration.
// Paste your Supabase project URL and key below (Supabase dashboard → Project Settings → API Keys / "Connect").
// The publishable (or legacy "anon") key is meant for the browser — Row Level Security keeps your data private.
// Leave both empty to run in Local mode: everything is stored in this browser only.

window.ARCHITECT_CONFIG = {
  supabaseUrl: 'https://rqgnoxnbegavuepahiii.supabase.co',            // e.g. 'https://abcdefghijklmnop.supabase.co'
  supabaseKey: 'sb_publishable_teK7C1EEzvIoHQEXcmLl8g_Xbyhfqir',            // 'sb_publishable_…' or the legacy anon key 'eyJ…'

  // Usernames are stored in Supabase Auth as  <username>@<authDomain>.
  // No email is ever sent, as long as "Confirm email" is turned off (see README).
  authDomain: 'architect.local',

  // Storage bucket for images and videos you drop onto boards (created by supabase/schema.sql).
  mediaBucket: 'architect-media'
};
