import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, hashKey } from '../server.js';
import { memoryStore, supabaseStore } from '../store.js';
import { createConnector } from '../mcp.js';
import { MAX_IMAGE_BYTES, imageMarker, splitImages } from '../public/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh5sAAAAASUVORK5CYII=', 'base64');

async function fixture() {
  const store = await memoryStore();
  const app = createApp({ store, ownerKey: 'test-owner-key', demo: true });
  const handler = app.listeners('request')[0];
  async function request(path, { method = 'GET', token = 'test-owner-key', body, headers = {}, raw, chunks } = {}) {
    const req = Readable.from(chunks || [Buffer.from(raw ?? (body === undefined ? '' : JSON.stringify(body)))]);
    req.method = method; req.url = path; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: 'localhost:4317', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers };
    const res = { status: 200, headers: {}, headersSent: false, data: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) { this.status = status; this.headersSent = true; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
      end(data = '') { this.data = Buffer.isBuffer(data) ? data : data.toString(); },
    };
    await handler(req, res);
    return { status: res.status, headers: res.headers, body: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(res.data.toString()) : res.data };
  }
  async function issue(name, role = 'agent') {
    const result = await request('/api/keys', { method: 'POST', body: { name, role } });
    assert.equal(result.status, 201); return result.body;
  }
  const fetcher = async (url, options = {}) => {
    const result = await request(new URL(url).pathname, { method: options.method, token: options.headers.Authorization.slice(7), raw: options.body });
    return new Response(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': result.headers['content-type'] } });
  };
  return { store, request, issue, fetcher };
}

test('credentials are hashed, owner-only, and independently revocable', async () => {
  const { request, issue, store } = await fixture();
  const codex = await issue('Codex'), claude = await issue('Claude');
  assert.equal(codex.key_hash, undefined);
  assert.equal((await store.keys())[0].key_hash, hashKey(codex.secret));
  assert.equal((await request('/api/board', { token: '' })).status, 401);
  assert.equal((await request('/api/keys', { token: codex.secret })).status, 403);
  assert.equal((await request('/api/keys', { method: 'POST', token: codex.secret, body: { name: 'Escalate', role: 'owner' } })).status, 403);
  assert.equal((await request('/api/keys', { method: 'POST', body: { name: 'Invalid', role: 'owner' } })).status, 400);
  const board = await request('/api/board', { token: codex.secret });
  assert.equal(board.body.actor.name, 'Codex');
  assert.ok(!JSON.stringify(board.body).includes(codex.secret));
  assert.ok(!JSON.stringify((await request('/api/keys')).body).includes(codex.secret));
  await request(`/api/keys/${codex.id}`, { method: 'DELETE' });
  assert.equal((await request('/api/board', { token: codex.secret })).status, 401);
  assert.equal((await request('/api/board', { token: claude.secret })).status, 200);
});

test('simultaneous claims have one winner; non-owners cannot overwrite or release it', async () => {
  const { request, issue } = await fixture();
  const a = await issue('Codex'), b = await issue('Claude');
  const task = (await request('/api/tasks', { method: 'POST', body: { title: 'Wire the goblin rig' } })).body;
  const claims = await Promise.all([a, b].map(agent => request(`/api/tasks/${task.id}`, { method: 'PATCH', token: agent.secret, body: { action: 'claim' } })));
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 409]);
  const [winner, loser] = claims[0].status === 200 ? [a, b] : [b, a];
  for (const change of [{ action: 'release' }, { action: 'status', status: 'done' }]) {
    assert.equal((await request(`/api/tasks/${task.id}`, { method: 'PATCH', token: loser.secret, body: change })).status, 409);
  }
  assert.equal((await request(`/api/tasks/${task.id}`, { method: 'PATCH', token: winner.secret, body: { action: 'status', status: 'done' } })).status, 200);
  assert.equal((await request(`/api/tasks/${task.id}`, { method: 'PATCH', token: loser.secret, body: { action: 'claim' } })).status, 409);
  const released = await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: { action: 'release' } });
  assert.equal(released.body.assignee_id, null);
  assert.equal(released.body.status, 'todo');
});

test('trust boundaries reject invalid input, origins, demo hosts, and large bodies', async () => {
  const { request } = await fixture();
  for (const body of [{ title: '' }, { title: 'x'.repeat(141) }, { title: 'valid', priority: 'urgent' }, { title: 123 }]) {
    assert.equal((await request('/api/tasks', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/tasks', { method: 'POST', raw: '{invalid' })).status, 400);
  assert.equal((await request('/api/tasks', { method: 'POST', raw: '[]' })).status, 400);
  assert.equal((await request('/api/tasks', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/tasks', { method: 'POST', raw: 'x'.repeat(17000) })).status, 413);
  assert.equal((await request('/api/board', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/api/board', { headers: { host: 'attacker.example:4317' } })).status, 403);
  assert.equal((await request('/api/tasks/not-a-uuid', { method: 'PATCH', body: { action: 'claim' } })).status, 400);
  assert.equal((await request('/api/updates', { method: 'POST', body: { body: 'Hello', kind: 'progress', task_id: randomUUID() } })).status, 404);
  const utf8 = Buffer.from(JSON.stringify({ title: 'ทดสอบ 👾' }));
  const result = await request('/api/tasks', { method: 'POST', chunks: Array.from(utf8, byte => Buffer.from([byte])) });
  assert.equal(result.body.title, 'ทดสอบ 👾');
  const page = await request('/');
  assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
});

test('tasks can be assigned to anyone in the workspace; only the owner can take them from someone else', async () => {
  const { request, issue } = await fixture();
  const mint = await issue('Mint', 'member'), codex = await issue('Codex');
  const board = (await request('/api/board', { token: mint.secret })).body;
  assert.deepEqual(board.people.map(p => p.name), ['Workspace owner', 'Mint', 'Codex']);
  assert.ok(!JSON.stringify(board.people).includes('key_hash'));
  const task = (await request('/api/tasks', { method: 'POST', body: { title: 'Orbit Rocks' } })).body;
  const assign = (token, assignee_id) => request(`/api/tasks/${task.id}`, { method: 'PATCH', token, body: { action: 'assign', assignee_id } });
  assert.equal((await assign(mint.secret, randomUUID())).status, 400);
  const given = await assign(mint.secret, codex.id);
  assert.equal(given.body.assignee_name, 'Codex'); assert.equal(given.body.status, 'in_progress');
  assert.equal((await request('/api/board')).body.activity[0].body, 'Mint assigned this to Codex');
  assert.equal((await assign(mint.secret, mint.id)).status, 409);
  assert.equal((await assign(codex.secret, mint.id)).body.assignee_name, 'Mint');
  assert.equal((await assign('test-owner-key', 'owner')).body.assignee_id, 'owner');
  await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: { action: 'status', status: 'done' } });
  assert.equal((await assign('test-owner-key', codex.id)).status, 409);
  await request(`/api/keys/${codex.id}`, { method: 'DELETE' });
  assert.ok(!(await request('/api/board')).body.people.some(p => p.id === codex.id));
});

test('idea notes: anyone can stick and move notes; only the author or owner edits or deletes', async () => {
  const { request, issue } = await fixture();
  const mint = await issue('Mint', 'member'), codex = await issue('Codex');
  const stuck = await request('/api/notes', { method: 'POST', token: mint.secret, body: { body: 'Goblin king boss', x: 120, y: 80 } });
  assert.equal(stuck.status, 201); assert.equal(stuck.body.color, 'yellow'); assert.equal(stuck.body.author_name, 'Mint');
  const note = (token, method, body) => request(`/api/notes/${stuck.body.id}`, { method, token, body });
  assert.equal((await note(codex.secret, 'PATCH', { x: 400, y: 300 })).body.x, 400);
  assert.equal((await note(codex.secret, 'PATCH', { body: 'Hijacked' })).status, 409);
  assert.equal((await note(codex.secret, 'DELETE')).status, 409);
  assert.equal((await note(mint.secret, 'PATCH', { color: 'pink' })).body.color, 'pink');
  for (const bad of [{ x: -1 }, { y: 1.5 }, { color: 'red' }, { body: '' }, {}]) assert.equal((await note(mint.secret, 'PATCH', bad)).status, 400);
  assert.equal((await request('/api/notes', { method: 'POST', body: { body: 'x'.repeat(501) } })).status, 400);
  const [saved] = (await request('/api/board', { token: codex.secret })).body.notes;
  assert.deepEqual([saved.x, saved.y, saved.color, saved.body], [400, 300, 'pink', 'Goblin king boss']);
  assert.equal((await note('test-owner-key', 'DELETE')).status, 200);
  assert.equal((await request('/api/board')).body.notes.length, 0);
});

test('new notes never overlap or repeat; image notes and links work and clean up with their note', async () => {
  const { request, issue } = await fixture();
  const mint = await issue('Mint', 'member');
  const stick = (body, extra = {}, token = mint.secret) => request('/api/notes', { method: 'POST', token, body: { body, ...extra } });
  const placed = [];
  for (const body of ['A', 'B', 'C', 'D']) placed.push((await stick(body, { x: 100, y: 100 })).body);
  const overlaps = (a, b) => a.x < b.x + 210 && b.x < a.x + 210 && a.y < b.y + 200 && b.y < a.y + 200;
  assert.ok(placed.every((a, i) => placed.every((b, j) => i === j || !overlaps(a, b))));
  assert.equal((await stick(' a ')).status, 409);
  const pic = await stick('', { image_base64: png.toString('base64') });
  assert.equal(pic.status, 201); assert.match(pic.body.image_id, /\.png$/);
  assert.equal((await request(`/api/images/${pic.body.image_id}`)).status, 200);
  assert.equal((await stick('')).status, 400);
  const link = (from_id, to_id, label, token = mint.secret) => request('/api/links', { method: 'POST', token, body: { from_id, to_id, label } });
  const made = await link(placed[0].id, pic.body.id, 'needs');
  assert.equal(made.status, 201); assert.equal(made.body.created_by, 'Mint');
  assert.equal((await link(pic.body.id, placed[0].id)).status, 409);
  assert.equal((await link(placed[0].id, placed[0].id)).status, 400);
  assert.equal((await link(placed[0].id, randomUUID())).status, 404);
  const other = await link(placed[1].id, placed[2].id, '', 'test-owner-key');
  assert.equal((await request(`/api/links/${other.body.id}`, { method: 'DELETE', token: mint.secret })).status, 409);
  assert.equal((await request(`/api/notes/${pic.body.id}`, { method: 'DELETE', token: mint.secret })).status, 200);
  const board = (await request('/api/board')).body;
  assert.deepEqual(board.links.map(l => l.id), [other.body.id]);
  assert.equal((await request(`/api/images/${pic.body.image_id}`)).status, 404);
});

test('two official SDK MCP clients exchange task ownership, handoff, and revocation through the API', async t => {
  const { issue, request, fetcher } = await fixture();
  const codex = await issue('Codex'), claude = await issue('Claude');
  async function connect(agent) {
    const server = createConnector({ boardUrl: 'http://localhost:4317', boardKey: agent.secret, fetcher });
    const client = new Client({ name: agent.name, version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(() => Promise.all([client.close(), server.close()]));
    return client;
  }
  const a = await connect(codex), b = await connect(claude);
  assert.equal((await a.listTools()).tools.length, 10);
  const created = await a.callTool({ name: 'create_task', arguments: { title: 'Test animation import', priority: 'high' } });
  const task = JSON.parse(created.content[0].text);
  assert.equal(task.title, 'Test animation import');
  assert.ok(!(await a.callTool({ name: 'claim_task', arguments: { task_id: task.id } })).isError);
  assert.equal((await b.callTool({ name: 'claim_task', arguments: { task_id: task.id } })).isError, true);
  const body = 'Handoff: imported the model; next verify scale in Studio. No gameplay check yet.';
  await a.callTool({ name: 'post_update', arguments: { task_id: task.id, kind: 'handoff', body } });
  const rocks = JSON.parse((await a.callTool({ name: 'add_note', arguments: { body: 'Orbit Rocks', color: 'blue' } })).content[0].text);
  const totem = JSON.parse((await a.callTool({ name: 'add_note', arguments: { body: 'Lightning Totem' } })).content[0].text);
  assert.ok(!(await a.callTool({ name: 'link_notes', arguments: { from_id: rocks.id, to_id: totem.id, label: 'pairs with' } })).isError);
  const board = JSON.parse((await b.callTool({ name: 'get_board', arguments: {} })).content[0].text);
  assert.deepEqual(board.notes.map(n => [n.body, n.color]), [['Orbit Rocks', 'blue'], ['Lightning Totem', 'yellow']]);
  assert.deepEqual(board.links, [{ from: rocks.id, to: totem.id, label: 'pairs with' }]);
  assert.equal(board.tasks[0].assignee, 'Codex'); assert.equal(board.tasks[0].description, '');
  assert.equal(board.activity.length, 1); // claim/created events are left out of the digest
  assert.equal(board.activity[0].body, body);
  const thread = JSON.parse((await b.callTool({ name: 'get_board', arguments: { task_id: task.id } })).content[0].text);
  assert.equal(thread.task.id, task.id); assert.deepEqual(thread.thread.map(p => p.kind), ['created', 'status', 'handoff']); assert.equal(board.activity[0].actor, 'Codex');
  await a.callTool({ name: 'release_task', arguments: { task_id: task.id } });
  assert.ok(!(await b.callTool({ name: 'claim_task', arguments: { task_id: task.id } })).isError);
  await request(`/api/keys/${claude.id}`, { method: 'DELETE' });
  assert.equal((await b.callTool({ name: 'get_board', arguments: {} })).isError, true);
});

test('Supabase writes keep atomic claim/ownership filters and server-only credentials', async () => {
  const calls = [];
  const store = supabaseStore('https://project.supabase.co', 'sb_secret_test', async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify([{ id: 'result' }]), { status: 200 });
  });
  const id = randomUUID(), actor = { id: randomUUID(), name: 'Codex', role: 'agent' };
  await store.changeTask(id, { action: 'claim' }, actor);
  assert.ok(calls[0].url.includes('assignee_id=is.null&status=neq.done'));
  assert.equal(JSON.parse(calls[0].options.body).assignee_id, actor.id);
  await store.changeTask(id, { action: 'status', status: 'done' }, actor);
  assert.ok(calls[1].url.endsWith(`&assignee_id=eq.${actor.id}`));
  await store.changeTask(id, { action: 'assign', assignee: { id: 'owner', name: 'Workspace owner' } }, actor);
  assert.ok(calls[2].url.endsWith(`&status=neq.done&or=(assignee_id.is.null,assignee_id.eq.${actor.id})`));
  assert.equal(JSON.parse(calls[2].options.body).assignee_name, 'Workspace owner');
  await store.changeNote(id, { x: 5 }, actor, false);
  assert.ok(calls[3].url.endsWith(`board_notes?id=eq.${id}`));
  await store.deleteNote(id, actor);
  assert.ok(calls[4].url.endsWith(`&author_id=eq.${actor.id}`)); assert.equal(calls[4].options.method, 'DELETE');
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_test');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const unavailable = supabaseStore('https://project.supabase.co', 'sb_secret_test', async () => { throw new Error('private internal detail'); });
  await assert.rejects(unavailable.snapshot(), error => error.status === 503 && !error.message.includes('private'));
});

test('the installed stdio connector launches and exposes its tools to a real SDK client', async t => {
  const client = new Client({ name: 'stdio-smoke-check', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.js', import.meta.url))],
    env: { BOARD_URL: 'http://localhost:4317', BOARD_KEY: 'test-not-a-real-key' }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ['get_board', 'create_task', 'claim_task', 'set_task_status', 'assign_task', 'release_task', 'post_update', 'add_note', 'link_notes', 'view_image']);
});

test('image updates round-trip privately, reject invalid uploads, and respect key revocation', async () => {
  const { request, issue } = await fixture();
  const agent = await issue('Image reporter');
  const result = await request('/api/updates', { method: 'POST', token: agent.secret,
    body: { kind: 'progress', body: '', image_base64: png.toString('base64') } });
  assert.equal(result.status, 201);
  const [id] = result.body.image_ids;
  assert.equal(splitImages(result.body.body).images[0], id);
  const image = await request(`/api/images/${id}`, { token: agent.secret });
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png');
  assert.deepEqual(image.body, png);
  assert.equal((await request(`/api/images/${id}`, { token: '' })).status, 401);
  assert.equal((await request(`/api/images/${randomUUID()}.png`)).status, 404);
  for (const image_base64 of ['invalid!', Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'), Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')]) {
    assert.equal((await request('/api/updates', { method: 'POST', body: { kind: 'progress', body: 'Image', image_base64 } })).status, 400);
  }
  await request(`/api/keys/${agent.id}`, { method: 'DELETE' });
  assert.equal((await request(`/api/images/${id}`, { token: agent.secret })).status, 401);
  assert.equal((await request(`/api/images/${id}`)).status, 200);
});

test('a failed update removes its new image instead of leaving an unattached upload', async () => {
  const { request, store } = await fixture();
  let id;
  const upload = store.uploadImage;
  store.uploadImage = async (...args) => { id = args[0]; return upload(...args); };
  const result = await request('/api/updates', { method: 'POST', body: { task_id: randomUUID(), kind: 'progress', body: 'Image', image_base64: png.toString('base64') } });
  assert.equal(result.status, 404); assert.ok(id);
  await assert.rejects(store.downloadImage(id), error => error.status === 404);
});

test('image markers accept only internal UUID image references', () => {
  const id = `${randomUUID()}.png`;
  assert.deepEqual(splitImages(`Evidence\n${imageMarker(id)}\n${imageMarker(id)}`), { text: 'Evidence', images: [id] });
  for (const body of ['![Attached image](https://attacker.example/photo.png)', '![Attached image](/api/images/../../.env)', '<img src=x onerror=alert(1)>']) {
    assert.deepEqual(splitImages(body), { text: body, images: [] });
  }
});

test('Supabase image storage creates a private restricted bucket and refuses a public bucket', async () => {
  let created = false;
  const calls = [];
  const store = supabaseStore('https://project.supabase.co', 'sb_secret_test', async (url, options = {}) => {
    const path = new URL(url).pathname, method = options.method || 'GET';
    calls.push({ path, method, options });
    if (path.endsWith('/bucket/partyboard-images')) return new Response(JSON.stringify(created ? { id: 'partyboard-images', public: false } : { message: 'Bucket not found', statusCode: '404' }), { status: created ? 200 : 404 });
    if (path.endsWith('/bucket') && method === 'POST') { created = true; return new Response(JSON.stringify({ name: 'partyboard-images' }), { status: 200 }); }
    if (path.includes('/object/') && method === 'POST') return new Response(JSON.stringify({ Key: 'image' }), { status: 200 });
    if (path.includes('/object/') && method === 'GET') return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    throw new Error(`Unexpected storage request: ${method} ${path}`);
  });
  const id = `${randomUUID()}.png`;
  await store.uploadImage(id, png, 'image/png');
  const config = JSON.parse(calls.find(call => call.path.endsWith('/bucket')).options.body);
  assert.equal(config.public, false); assert.equal(config.file_size_limit, MAX_IMAGE_BYTES);
  assert.deepEqual(config.allowed_mime_types, ['image/png', 'image/jpeg', 'image/webp']);
  assert.deepEqual((await store.downloadImage(id)).data, png);
  const unsafe = supabaseStore('https://project.supabase.co', 'sb_secret_test', async () => new Response(JSON.stringify({ id: 'partyboard-images', public: true }), { status: 200 }));
  await assert.rejects(unsafe.uploadImage(id, png, 'image/png'), error => error.status === 503 && /private/.test(error.message));
});

test('MCP attaches a local screenshot and returns private image content', async t => {
  const { issue, fetcher } = await fixture();
  const key = await issue('Image agent'), dir = await mkdtemp(join(tmpdir(), 'partyboard-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'screenshot.png'); await writeFile(path, png);
  const server = createConnector({ boardUrl: 'http://localhost:4317', boardKey: key.secret, fetcher });
  const client = new Client({ name: 'image-check', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  const result = await client.callTool({ name: 'post_update', arguments: { kind: 'progress', image_path: path } });
  assert.ok(!result.isError, result.content[0]?.text);
  const id = JSON.parse(result.content[0].text).image_ids[0];
  const viewed = await client.callTool({ name: 'view_image', arguments: { image_id: id } });
  assert.equal(viewed.content[0].type, 'image'); assert.equal(viewed.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(viewed.content[0].data, 'base64'), png);
  assert.equal((await client.callTool({ name: 'post_update', arguments: { kind: 'progress', image_path: 'relative.png' } })).isError, true);
});
