import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@supabase/server/core';
import { MAX_IMAGE_BYTES } from './public/images.js';

export class BoardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// `data` preloads a board snapshot ({ tasks, activity, keys }), e.g. to preview the UI with real board content.
export async function memoryStore({ seed = false, data = {} } = {}) {
  const { tasks = [], activity = [], keys = [], notes = [], links = [] } = structuredClone(data), images = new Map();
  const note = (id, actor, edit) => {
    const found = notes.find(n => n.id === id);
    if (!found) throw new BoardError(404, 'Note not found.');
    if (edit && actor.role !== 'owner' && found.author_id !== actor.id) throw new BoardError(409, 'Only the note’s author or workspace owner can edit or delete it.');
    return found;
  };
  let code = Math.max(0, ...tasks.map(t => t.code));
  const record = (task, kind, body, actor) => activity.unshift({
    id: randomUUID(), task_id: task?.id ?? null, task_code: task?.code ?? null,
    kind, body, actor: actor.name, created_at: new Date().toISOString(),
  });
  const store = {
    async uploadImage(id, data, mime) { images.set(id, { data: Buffer.from(data), mime }); },
    async downloadImage(id) {
      const image = images.get(id);
      if (!image) throw new BoardError(404, 'Image not found.');
      return { data: Buffer.from(image.data), mime: image.mime };
    },
    async deleteImage(id) { images.delete(id); },
    async snapshot() { return structuredClone({ tasks, activity: activity.slice(0, 100), notes, links }); },
    async addNote(input, actor) {
      const now = new Date().toISOString();
      notes.push({ id: randomUUID(), ...input, author_id: actor.id, author_name: actor.name, created_at: now, updated_at: now });
      return structuredClone(notes.at(-1));
    },
    async changeNote(id, patch, actor, edit) {
      const found = note(id, actor, edit);
      if (patch.body === '' && !found.image_id) throw new BoardError(400, 'Write an idea or attach an image.');
      return structuredClone(Object.assign(found, patch, { updated_at: new Date().toISOString() }));
    },
    async deleteNote(id, actor) {
      const found = note(id, actor, true);
      notes.splice(notes.indexOf(found), 1);
      links.splice(0, links.length, ...links.filter(l => l.from_id !== id && l.to_id !== id)); // like ON DELETE CASCADE
      return structuredClone(found);
    },
    async addLink(input, actor) {
      links.push({ id: randomUUID(), ...input, created_by_id: actor.id, created_by: actor.name, created_at: new Date().toISOString() });
      return structuredClone(links.at(-1));
    },
    async deleteLink(id, actor) {
      const i = links.findIndex(l => l.id === id);
      if (i < 0) throw new BoardError(404, 'Link not found.');
      if (actor.role !== 'owner' && links[i].created_by_id !== actor.id) throw new BoardError(409, 'Only whoever made the link or the workspace owner can remove it.');
      links.splice(i, 1);
    },
    async findKey(hash) { return structuredClone(keys.find(k => k.key_hash === hash && !k.revoked_at)); },
    async keys() { return structuredClone(keys); },
    async addKey(key) { keys.push(key); return key; },
    async revokeKey(id) {
      const key = keys.find(k => k.id === id);
      if (!key) throw new BoardError(404, 'Key not found.');
      key.revoked_at = new Date().toISOString();
    },
    async createTask(input, actor) {
      const task = { id: randomUUID(), code: ++code, ...input, status: 'todo',
        assignee_id: null, assignee_name: null, updated_by: actor.name,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      tasks.unshift(task); record(task, 'created', `Created “${task.title}”`, actor);
      return structuredClone(task);
    },
    async changeTask(id, change, actor) {
      const task = tasks.find(t => t.id === id);
      if (!task) throw new BoardError(404, 'Task not found.');
      if (change.action === 'claim') {
        if (task.assignee_id || task.status === 'done') throw new BoardError(409, 'This task is already claimed or complete.');
        Object.assign(task, { assignee_id: actor.id, assignee_name: actor.name, status: 'in_progress' });
      } else if (change.action === 'assign') {
        if (task.status === 'done' || (actor.role !== 'owner' && task.assignee_id && task.assignee_id !== actor.id)) throw new BoardError(409, 'Only the task owner or workspace owner can reassign this task.');
        Object.assign(task, { assignee_id: change.assignee.id, assignee_name: change.assignee.name, status: 'in_progress' });
      } else {
        if (actor.role !== 'owner' && task.assignee_id !== actor.id) throw new BoardError(409, 'Only the task owner or workspace owner can change this task.');
        if (change.action === 'release') Object.assign(task, { assignee_id: null, assignee_name: null, status: 'todo' });
        else task.status = change.status;
      }
      task.updated_by = actor.name; task.updated_at = new Date().toISOString();
      const claimed = change.action === 'claim' || (change.action === 'assign' && task.assignee_name === actor.name);
      record(task, 'status', claimed ? `${actor.name} claimed this task` : change.action === 'assign' ? `${actor.name} assigned this to ${task.assignee_name}` : change.action === 'release' ? 'Released this task to the backlog' : `Moved to ${task.status.replaceAll('_', ' ')}`, actor);
      return structuredClone(task);
    },
    async postUpdate(input, actor) {
      const task = input.task_id ? tasks.find(t => t.id === input.task_id) : null;
      if (input.task_id && !task) throw new BoardError(404, 'Task not found.');
      record(task, input.kind, input.body, actor);
      return structuredClone(activity[0]);
    },
  };
  if (seed) {
    const actor = { id: 'demo-codex', name: 'Codex · demo', role: 'agent' };
    for (const [title, description, priority] of [
      ['Define the first playable loop', 'Agree on one arena, one enemy, and a clear win condition. What should a player do in the first 60 seconds?', 'high'],
      ['Bring the goblin into Studio', 'Check scale, rig, materials, and animations. Attach a Studio screenshot before calling this done.', 'high'],
      ['Build a small test arena', 'A simple spawn point and combat space. Keep the first map small enough to test quickly.', 'medium'],
      ['Prototype the goblin attack', 'Decide the telegraph, attack range, cooldown, and damage. Coordinate with the animation task.', 'medium'],
      ['Choose an animation workflow', 'Need a decision on which rig and animation export to use before implementation.', 'low'],
    ]) await store.createTask({ title, description, priority }, { name: 'You · demo' });
    await store.changeTask(tasks[3].id, { action: 'claim' }, actor);
    await store.postUpdate({ kind: 'handoff', task_id: tasks[3].id, body: 'Example handoff: model import needs a scale check. Next agent: verify the rig in Studio and attach evidence. This is sample data, not a real completed check.' }, actor);
    await store.changeTask(tasks[0].id, { action: 'claim' }, { id: 'demo-claude', name: 'Claude · demo' });
    await store.changeTask(tasks[0].id, { action: 'status', status: 'blocked' }, { id: 'demo-claude', name: 'Claude · demo' });
  }
  return store;
}

export function supabaseStore(url, secret, fetcher = fetch) {
  const admin = createAdminClient({ env: { url, secretKeys: { default: secret } },
    supabaseOptions: { global: { fetch: (input, options) => fetcher(input, { ...options, signal: AbortSignal.timeout(45000) }) } } });
  const bucketName = 'partyboard-images';
  let bucketReady;
  async function checkStorage(result) {
    if (result.error) throw new BoardError(503, 'Image storage is unavailable. Try again shortly.');
    return result.data;
  }
  async function ensureBucket() {
    if (!bucketReady) bucketReady = (async () => {
      let result = await admin.storage.getBucket(bucketName);
      if (result.error && ['404', '400'].includes(String(result.error.status))) {
        const created = await admin.storage.createBucket(bucketName, { public: false, fileSizeLimit: MAX_IMAGE_BYTES,
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] });
        if (created.error && !['409', '400'].includes(String(created.error.status))) await checkStorage(created);
        result = await admin.storage.getBucket(bucketName);
      }
      const bucket = await checkStorage(result);
      if (bucket.public) throw new BoardError(503, 'The image bucket must be private.');
    })().catch(error => { bucketReady = undefined; throw error; });
    return bucketReady;
  }
  async function rest(path, method = 'GET', body) {
    let response;
    try {
      response = await fetcher(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
        method, headers: { apikey: secret, ...(secret.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secret}` }),
          'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new BoardError(503, 'Database unavailable. Try again shortly.'); }
    if (!response.ok) throw new BoardError(503, 'Database request failed. Check the server configuration and migration.');
    return response.status === 204 ? null : response.json();
  }
  const noteQuery = (id, actor, edit) => `board_notes?id=eq.${id}${edit && actor.role !== 'owner' ? `&author_id=eq.${actor.id}` : ''}`;
  return {
    async uploadImage(id, data, mime) {
      await ensureBucket();
      await checkStorage(await admin.storage.from(bucketName).upload(id, data, { contentType: mime, upsert: false }));
    },
    async downloadImage(id) {
      const blob = await checkStorage(await admin.storage.from(bucketName).download(id));
      return { data: Buffer.from(await blob.arrayBuffer()), mime: blob.type };
    },
    async deleteImage(id) { await checkStorage(await admin.storage.from(bucketName).remove([id])); },
    async snapshot() {
      // shortcut: latest 1000 tasks and 100 events, add pagination when the board outgrows one screen.
      const [tasks, activity, notes, links] = await Promise.all([rest('board_tasks?order=updated_at.desc&limit=1000'), rest('board_activity?order=created_at.desc&limit=100'), rest('board_notes?order=created_at.asc&limit=500').catch(() => []) /* board stays usable before the notes migrations run */,
        rest('board_note_links?order=created_at.asc&limit=1000').catch(() => [])]);
      return { tasks, activity, notes, links };
    },
    async findKey(hash) { return (await rest(`board_keys?key_hash=eq.${hash}&revoked_at=is.null&limit=1`))[0]; },
    keys: () => rest('board_keys?order=created_at.desc'),
    async addKey(key) { return (await rest('board_keys', 'POST', key))[0]; },
    async revokeKey(id) {
      const rows = await rest(`board_keys?id=eq.${id}`, 'PATCH', { revoked_at: new Date().toISOString() });
      if (!rows.length) throw new BoardError(404, 'Key not found.');
    },
    async createTask(input, actor) { return (await rest('board_tasks', 'POST', { ...input, updated_by: actor.name }))[0]; },
    async changeTask(id, change, actor) {
      let query = `board_tasks?id=eq.${id}`, patch = { updated_by: actor.name };
      if (change.action === 'claim') {
        query += '&assignee_id=is.null&status=neq.done';
        Object.assign(patch, { assignee_id: actor.id, assignee_name: actor.name, status: 'in_progress' });
      } else if (change.action === 'assign') {
        query += '&status=neq.done';
        if (actor.role !== 'owner') query += `&or=(assignee_id.is.null,assignee_id.eq.${actor.id})`;
        Object.assign(patch, { assignee_id: change.assignee.id, assignee_name: change.assignee.name, status: 'in_progress' });
      } else {
        if (actor.role !== 'owner') query += `&assignee_id=eq.${actor.id}`;
        if (change.action === 'release') Object.assign(patch, { assignee_id: null, assignee_name: null, status: 'todo' });
        else patch.status = change.status;
      }
      // Postgres applies the ownership condition and the write in one atomic update.
      const rows = await rest(query, 'PATCH', patch);
      if (!rows.length) throw new BoardError(409, 'Task unavailable. It may be claimed, complete, or owned by someone else.');
      return rows[0];
    },
    async addNote(input, actor) { return (await rest('board_notes', 'POST', { ...input, author_id: actor.id, author_name: actor.name }))[0]; },
    // Moving is open to everyone; editing text/colour or deleting is filtered to the author unless the actor is the owner.
    async changeNote(id, patch, actor, edit) {
      const rows = await rest(noteQuery(id, actor, edit), 'PATCH', { ...patch, updated_at: new Date().toISOString() });
      if (!rows.length) throw new BoardError(409, 'Note unavailable. It may be deleted or written by someone else.');
      return rows[0];
    },
    async deleteNote(id, actor) {
      const rows = await rest(noteQuery(id, actor, true), 'DELETE');
      if (!rows.length) throw new BoardError(409, 'Note unavailable. It may be deleted or written by someone else.');
      return rows[0];
    },
    async addLink(input, actor) { return (await rest('board_note_links', 'POST', { ...input, created_by_id: actor.id, created_by: actor.name }))[0]; },
    async deleteLink(id, actor) {
      const rows = await rest(`board_note_links?id=eq.${id}${actor.role === 'owner' ? '' : `&created_by_id=eq.${actor.id}`}`, 'DELETE');
      if (!rows.length) throw new BoardError(409, 'Link unavailable. It may be removed or made by someone else.');
    },
    async postUpdate(input, actor) {
      if (input.task_id) {
        const tasks = await rest(`board_tasks?id=eq.${input.task_id}&select=id,code`);
        if (!tasks.length) throw new BoardError(404, 'Task not found.');
        input = { ...input, task_code: tasks[0].code };
      }
      return (await rest('board_activity', 'POST', { ...input, actor: actor.name }))[0];
    },
  };
}
