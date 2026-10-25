import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import partyboard from '../api/index.js';
import { MAX_IMAGE_BYTES } from '../public/images.js';

test('Vercel entry serves the app without opening a listening socket and fails closed without configuration', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OWNER_KEY', 'PUBLIC_ORIGIN', 'BOARD_NAME'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  async function request(path, headers = {}) {
    const req = Readable.from([]); req.method = 'GET'; req.url = path;
    req.headers = { host: 'board.example', ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { status: 200, headers: {}, data: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) { this.status = status; this.headersSent = true; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
      end(data = '') { this.data = data.toString(); },
    };
    await partyboard(req, res); return res;
  }
  try {
    for (const name of names) delete process.env[name];
    assert.equal((await request('/api/board')).status, 503);
    Object.assign(process.env, { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test',
      OWNER_KEY: 'test-owner-key-for-serverless-entry-32', PUBLIC_ORIGIN: 'https://board.example', BOARD_NAME: 'Vercel test board' });
    const health = await request('/healthz');
    assert.equal(health.status, 200); assert.equal(JSON.parse(health.data).status, 'ok');
    const page = await request('/'); assert.equal(page.status, 200); assert.match(page.data, /partyboard/);
    const images = await request('/images.js'); assert.equal(images.status, 200); assert.match(images.data, /MAX_IMAGE_BYTES/);
    assert.equal((await request('/api/board')).status, 401);
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await request('/api/config', { origin: 'https://attacker.example' })).status, 403);
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('a maximum image plus encoded update text fits the Vercel request limit', () => {
  const body = JSON.stringify({ kind: 'progress', body: 'ก'.repeat(3900),
    task_id: '00000000-0000-0000-0000-000000000000', image_base64: Buffer.alloc(MAX_IMAGE_BYTES).toString('base64') });
  assert.ok(Buffer.byteLength(body) < 4500000, 'Encoded image requests must fit below Vercel’s 4.5 MB cap.');
});
