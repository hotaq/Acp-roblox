import { createApp } from '../server.js';
import { supabaseStore } from '../store.js';

let handler;

export default async function partyboard(req, res) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, OWNER_KEY, PUBLIC_ORIGIN, BOARD_NAME } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !OWNER_KEY || OWNER_KEY.length < 32 || !PUBLIC_ORIGIN) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Workspace environment is not configured.' }));
  }
  handler ??= createApp({ store: supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY),
    ownerKey: OWNER_KEY, publicOrigin: PUBLIC_ORIGIN, name: BOARD_NAME }).listeners('request')[0];
  return handler(req, res);
}
