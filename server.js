import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BoardError, memoryStore, supabaseStore } from './store.js';
import { MAX_IMAGE_BYTES, imageIdPattern, imageMarker, splitImages } from './public/images.js';

export const hashKey = key => createHash('sha256').update(key).digest('hex');
const statuses = ['todo', 'in_progress', 'blocked', 'done'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const cleanKey = ({ key_hash, ...key }) => key;
function text(value, name, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new BoardError(400, `${name} must be ${optional ? 'up to' : '1–'}${max} characters.`);
  return value.trim();
}
function choice(value, values, name) {
  if (!values.includes(value)) throw new BoardError(400, `Invalid ${name}.`);
  return value;
}
async function readBody(req, limit = 16384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BoardError(415, 'Use application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size <= limit) chunks.push(chunk); }
  if (size > limit) throw new BoardError(413, 'Request too large.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new BoardError(400, 'Invalid JSON object.'); }
}

function decodeImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new BoardError(400, 'Choose an image up to 3 MB.');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== encoded) throw new BoardError(400, 'Invalid image encoding or image larger than 3 MB.');
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.toString('ascii', 12, 16) === 'IHDR') return { data, mime: 'image/png', ext: 'png' };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, mime: 'image/jpeg', ext: 'jpg' };
  if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { data, mime: 'image/webp', ext: 'webp' };
  throw new BoardError(400, 'Use a PNG, JPEG, or WebP image. SVG and other file types are not supported.');
}

export function createApp({ store, ownerKey, name = 'Goblin game', demo = false, publicOrigin }) {
  const ownerHash = Buffer.from(hashKey(ownerKey), 'hex');
  const rates = new Map();
  const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/images.js', ['images.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const port = server.address()?.port ?? 4317;
      const localHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
      if (demo && !localHosts.includes(req.headers.host)) throw new BoardError(403, 'Demo is only available on localhost.');
      const origins = demo ? localHosts.map(host => `http://${host}`) : [publicOrigin];
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw new BoardError(403, 'Origin not allowed.');
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [file, mime] = files.get(path);
        const data = await readFile(new URL(`public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); return res.end(data);
      }
      if (req.method === 'GET' && path === '/healthz') return send(200, { status: 'ok' });
      if (req.method === 'GET' && path === '/api/config') return send(200, { name, demo });
      if (!path.startsWith('/api/')) throw new BoardError(404, 'Not found.');
      const ip = req.socket.remoteAddress, now = Date.now();
      let rate = rates.get(ip);
      if (!rate || now > rate.until) { rate = { count: 0, until: now + 60000 }; rates.set(ip, rate); }
      if (rates.size > 1000) rates.delete(rates.keys().next().value);
      if (++rate.count > 240) throw new BoardError(429, 'Too many requests. Try again in a minute.');
      const token = req.headers.authorization?.match(/^Bearer ([^\s]{1,200})$/)?.[1];
      if (!token) throw new BoardError(401, 'Enter a valid workspace access key.');
      const hash = hashKey(token);
      const actor = timingSafeEqual(Buffer.from(hash, 'hex'), ownerHash)
        ? { id: 'owner', name: 'Workspace owner', role: 'owner' }
        : await store.findKey(hash);
      if (!actor) throw new BoardError(401, 'Access key is invalid or revoked.');
      const ownerOnly = () => { if (actor.role !== 'owner') throw new BoardError(403, 'Only the workspace owner can manage keys.'); };
      if (req.method === 'GET' && path.startsWith('/api/images/')) {
        const id = path.slice('/api/images/'.length);
        if (!imageIdPattern.test(id)) throw new BoardError(400, 'Invalid image ID.');
        const image = await store.downloadImage(id);
        const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[id.split('.').pop().toLowerCase()];
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': image.data.length });
        return res.end(image.data);
      }
      if (req.method === 'GET' && path === '/api/board') {
        const board = await store.snapshot();
        return send(200, { ...board, activity: board.activity.map(update => ({ ...update, image_ids: splitImages(update.body).images })),
          actor: { id: actor.id, name: actor.name, role: actor.role }, name, demo });
      }
      if (path === '/api/keys') {
        ownerOnly();
        if (req.method === 'GET') return send(200, (await store.keys()).map(cleanKey));
        if (req.method === 'POST') {
          const input = await readBody(req), secret = `pb_${randomBytes(32).toString('base64url')}`;
          const key = await store.addKey({ id: randomUUID(), name: text(input.name, 'Name', 60),
            role: choice(input.role, ['agent', 'member'], 'role'), key_hash: hashKey(secret),
            prefix: secret.slice(0, 10), created_at: new Date().toISOString(), revoked_at: null });
          return send(201, { ...cleanKey(key), secret });
        }
      }
      const keyRoute = path.match(/^\/api\/keys\/([^/]+)$/);
      if (keyRoute && req.method === 'DELETE') {
        ownerOnly(); if (!uuid(keyRoute[1])) throw new BoardError(400, 'Invalid key ID.');
        await store.revokeKey(keyRoute[1]); return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/tasks') {
        const input = await readBody(req);
        const task = await store.createTask({ title: text(input.title, 'Title', 140),
          description: text(input.description, 'Description', 4000, true),
          priority: choice(input.priority ?? 'medium', ['low', 'medium', 'high'], 'priority') }, actor);
        return send(201, task);
      }
      const taskRoute = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskRoute && req.method === 'PATCH') {
        if (!uuid(taskRoute[1])) throw new BoardError(400, 'Invalid task ID.');
        const input = await readBody(req);
        const change = { action: choice(input.action, ['claim', 'release', 'status'], 'action') };
        if (change.action === 'status') change.status = choice(input.status, statuses, 'status');
        return send(200, await store.changeTask(taskRoute[1], change, actor));
      }
      if (req.method === 'POST' && path === '/api/updates') {
        const input = await readBody(req, Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16384);
        if (input.task_id != null && !uuid(input.task_id)) throw new BoardError(400, 'Invalid task ID.');
        const kind = choice(input.kind, ['progress', 'handoff', 'decision'], 'update kind');
        const image = input.image_base64 === undefined ? null : decodeImage(input.image_base64);
        let body = text(input.body, 'Update', 4000, !!image);
        const id = image ? `${randomUUID()}.${image.ext}` : null;
        if (image) body = text(`${body}\n\n${imageMarker(id)}`.trim(), 'Update including image reference', 4000);
        if (image) await store.uploadImage(id, image.data, image.mime);
        try {
          const update = await store.postUpdate({ task_id: input.task_id ?? null, kind, body }, actor);
          return send(201, { ...update, image_ids: splitImages(update.body).images });
        } catch (error) {
          if (image) await store.deleteImage(id).catch(() => {});
          throw error;
        }
      }
      throw new BoardError(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent) send(error.status ?? 500, { error: error.status ? error.message : 'Unexpected server error.' });
      if (!error.status) console.error('Board request failed:', error.message);
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, OWNER_KEY, PUBLIC_ORIGIN } = process.env;
  if (!demo && (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !OWNER_KEY || OWNER_KEY.length < 32 || OWNER_KEY.startsWith('replace-') || !PUBLIC_ORIGIN)) {
    console.error('Configure .env using .env.example, or use npm run demo for a localhost-only preview.');
    process.exit(1);
  }
  if (!demo && (!/^https:\/\//.test(SUPABASE_URL) || !/^https?:\/\//.test(PUBLIC_ORIGIN))) {
    console.error('SUPABASE_URL must use HTTPS and PUBLIC_ORIGIN must be a complete HTTP(S) origin.'); process.exit(1);
  }
  const store = demo ? await memoryStore({ seed: true }) : supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const server = createApp({ store, ownerKey: demo ? 'demo-owner' : OWNER_KEY, name: process.env.BOARD_NAME, demo, publicOrigin: PUBLIC_ORIGIN });
  server.on('error', error => { console.error(`Could not start Partyboard (${error.code}). Check the port and host permissions.`); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 4317), demo ? '127.0.0.1' : (process.env.HOST || '127.0.0.1'), () => {
    console.log(`Partyboard: http://localhost:${server.address().port}${demo ? ' (demo, resets on restart)' : ''}`);
  });
}
