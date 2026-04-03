// api/admin/set-role.js
// Updates a user's role in the profiles table — admin only
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify caller is authenticated
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  // Verify caller is an admin
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only' });
  }

  const { userId, role } = req.body;
  if (!userId || !['admin', 'reviewer'].includes(role)) {
    return res.status(400).json({ error: 'Valid userId and role required' });
  }

  const { error } = await sb.from('profiles').update({ role }).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ message: 'Role updated' });
}
