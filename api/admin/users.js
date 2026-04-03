// api/admin/users.js
// Lists all Supabase auth users — uses service role key (server-side only)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Never expose this to the browser
);

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the caller is a logged-in Supabase user
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // Fetch all users via admin API
  const { data, error } = await sb.auth.admin.listUsers();
  if (error) return res.status(500).json({ error: error.message });

  // Fetch roles from profiles table
  const { data: profiles } = await sb.from('profiles').select('id, role');
  const roleMap = Object.fromEntries((profiles || []).map(p => [p.id, p.role]));

  // Return only safe fields + role
  const users = data.users.map(u => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    email_confirmed_at: u.email_confirmed_at,
    role: roleMap[u.id] || 'reviewer',
  }));

  return res.status(200).json({ users });
}
