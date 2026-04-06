// api/admin/delete-user.js
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  // Only admins can delete users
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Prevent self-deletion
  if (userId === user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const { error } = await sb.auth.admin.deleteUser(userId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ message: 'User deleted' });
}
