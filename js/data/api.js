import { createSupabaseBackend } from './supabase.js';
import { createLocalBackend } from './local.js';

const cfg = window.ARCHITECT_CONFIG || {};
export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
export const api = configured ? createSupabaseBackend(cfg) : createLocalBackend();

// Turns backend errors into sentences a person can act on.
export function friendlyError(e) {
  const code = e?.code || '';
  const msg = String(e?.message || e || '');
  if (code === 'confirm_required') {
    return 'Supabase is waiting for an email confirmation that can’t arrive. In Supabase → Authentication → Sign In / Providers → Email, turn off “Confirm email”, delete this user under Authentication → Users, then create the account again.';
  }
  if (code === 'user_already_exists' || /already registered|already exists/i.test(msg)) return 'That username is taken.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Wrong username or password.';
  if (code === 'email_address_invalid' || code === 'email_address_not_authorized' || /email address .* invalid/i.test(msg)) {
    return 'Supabase tried to send a confirmation email. Turn off “Confirm email” in Supabase → Authentication → Sign In / Providers → Email, then try again.';
  }
  if (code === 'email_not_confirmed') return 'This account is waiting for email confirmation. Turn off “Confirm email” in Supabase, then confirm the user under Authentication → Users.';
  if (code === 'signup_disabled' || /signups not allowed/i.test(msg)) return 'New accounts are turned off for this project.';
  if (code === 'weak_password' || /password should be/i.test(msg)) return msg;
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return 'Too many attempts. Wait a minute and try again.';
  if (code === 'PGRST202' || code === '42883' || /Could not find the function|blueprint_members|public\.profiles/i.test(msg)) return 'Sharing isn’t set up yet. Run supabase/collab.sql in the Supabase SQL editor.';
  if (code === '42P01' || /relation .* does not exist|Could not find the table/i.test(msg)) return 'Database tables are missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (/Bucket not found/i.test(msg)) return 'Storage bucket is missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (/row-level security|violates row-level/i.test(msg)) return 'Supabase blocked this write. Re-run supabase/schema.sql to restore the access policies.';
  if (/maximum allowed size|Payload too large|exceeded the maximum/i.test(msg)) return 'That file is larger than your Supabase upload limit.';
  return msg || 'Something went wrong.';
}
