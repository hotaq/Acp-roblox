import { MAX_IMAGE_BYTES, splitImages } from './images.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const state = { view: 'board', filter: 'all', query: '', board: null, task: null, allDone: false };
const DONE_SHOWN = 3, NOTE_W = 190, NOTE_H = 140, CANVAS = [3000, 2000];
let key = sessionStorage.getItem('partyboard-key') || '', noticeTimer;
const imageCache = new Map();
let selectedPreview;
async function imageURL(id) {
  if (imageCache.has(id)) return imageCache.get(id).promise;
  const entry = {}, credential = key;
  entry.promise = (async () => {
    const response = await fetch(`/api/images/${id}`, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(16000) });
    if (!response.ok) throw new Error('Image unavailable. Check your connection or access key.');
    const blob = await response.blob();
    if (credential !== key) throw new Error('Session changed.');
    entry.url = URL.createObjectURL(blob);
    return entry.url;
  })().catch(error => { if (imageCache.get(id) === entry) imageCache.delete(id); throw error; });
  imageCache.set(id, entry);
  return entry.promise;
}
function hydrateImages() {
  document.querySelectorAll('img[data-image-id]:not([src])').forEach(async img => {
    if (img.dataset.loading) return;
    img.dataset.loading = 'true';
    const button = img.closest('button'), status = button.querySelector('.image-status');
    try {
      img.onerror = () => { img.hidden = true; status.hidden = false; status.textContent = 'Image could not be decoded.'; };
      img.src = await imageURL(img.dataset.imageId); img.hidden = false; status.hidden = true; button.disabled = false;
    } catch (error) { status.textContent = error.message; }
  });
}
function resetUpdateImage() {
  if (selectedPreview) URL.revokeObjectURL(selectedPreview);
  selectedPreview = undefined; $('#update-image').value = ''; $('#selected-image').removeAttribute('src');
  $('#image-selection').hidden = true; $('#update-body').required = true;
}
async function openImage(id) {
  try {
    const url = await imageURL(id); $('#large-image').src = url; $('#download-image').href = url;
    $('#download-image').download = `partyboard-${id}`; $('#image-viewer').showModal();
  } catch (error) { notice(error.message, true); }
}
function notice(message, error = false) {
  clearTimeout(noticeTimer); $('#notice').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, error ? 9000 : 4000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(body?.image_base64 ? 60000 : 16000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
const initials = name => (name || '?').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const avatar = name => `<span class="avatar ${/codex|claude/i.test(name) ? 'agent' : ''}">${esc(initials(name))}</span>`;
const relative = date => {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  return mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
};
function feed(items) {
  if (!items.length) return '<div class="blank">No updates yet. Share a little context for the next person or agent.</div>';
  queueMicrotask(hydrateImages);
  return items.map(item => {
    const { text, images } = splitImages(item.body);
    return `<div class="feed-row">${avatar(item.actor)}<div class="feed-content"><div><strong>${esc(item.actor)}</strong><time datetime="${esc(item.created_at)}" title="${esc(new Date(item.created_at).toLocaleString())}">${relative(item.created_at)}</time></div>${text ? `<p>${esc(text)}</p>` : ''}${images.map(id => `<button type="button" class="attachment" data-view-image="${esc(id)}" aria-label="Open image attached by ${esc(item.actor)}" disabled><img data-image-id="${esc(id)}" alt="Image shared by ${esc(item.actor)}" loading="lazy" hidden><span class="image-status">Loading image…</span></button>`).join('')}<span class="feed-kind">${esc(item.kind)}${item.task_code ? ` · GAME-${esc(item.task_code)}` : ' · project'}</span></div></div>`;
  }).join('');
}
function boardColumns() {
  const { tasks, activity, actor } = state.board;
  const filtered = tasks.filter(t => (state.filter !== 'mine' || t.assignee_id === actor.id) && (state.filter !== 'available' || (!t.assignee_id && t.status !== 'done')) && `${t.title} ${t.description} GAME-${t.code}`.toLowerCase().includes(state.query.toLowerCase()));
  return Object.entries(labels).map(([status, label]) => {
    const all = filtered.filter(t => t.status === status).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    // Done keeps growing, so it shows only the latest few unless expanded or searched.
    const clip = status === 'done' && !state.allDone && !state.query && all.length > DONE_SHOWN, items = clip ? all.slice(0, DONE_SHOWN) : all;
    return `<section class="column" aria-label="${label}"><h2 class="column-heading"><span class="dot ${status}"></span>${label} <span class="count">${all.length}</span><button class="icon-button" data-new-task aria-label="Create a task">+</button></h2>${items.map(task => {
      const comments = activity.filter(a => a.task_id === task.id && ['progress', 'handoff', 'decision'].includes(a.kind)).length;
      return `<button class="task-card" data-task="${esc(task.id)}"><span class="card-meta"><span class="task-code">GAME-${task.code}</span><span class="priority ${esc(task.priority)}">${esc(task.priority)}</span></span><strong class="card-title">${esc(task.title)}</strong><span class="card-description">${esc(task.description || 'Add context in an update when you pick this up.')}</span><span class="card-footer">${task.assignee_name ? avatar(task.assignee_name) : '<span class="avatar">−</span>'}<span class="owner-name">${esc(task.assignee_name || 'Ready to pick up')}</span><span class="comment-count" title="Updates in the latest 100 workspace events">↳ ${comments}</span></span></button>`;
    }).join('')}${status === 'done' && all.length > DONE_SHOWN && !state.query ? `<button class="text-button show-done" data-toggle-done>${clip ? `Show all ${all.length} done ↓` : 'Show only the latest ↑'}</button>` : ''}${items.length ? '' : `<div class="empty-column">${state.query || state.filter !== 'all' ? 'No matching tasks' : status === 'done' ? 'Good things take a first step.' : status === 'blocked' ? 'A clear path. Nice.' : 'Room for the next idea.'}</div>`}</section>`;
  }).join('');
}
function teamPanel() {
  const groups = new Map();
  for (const t of state.board.tasks) if (t.assignee_id && t.status !== 'done') groups.set(t.assignee_id, [...(groups.get(t.assignee_id) || []), t]);
  const rows = [...groups.values()].map(list => [{ name: list[0].assignee_name }, list]);
  return `<section class="panel team-panel"><div class="panel-heading"><h2>Who’s on what</h2><span class="tag">${rows.length} working</span></div>${rows.map(([p, list]) => `<div class="key-row">${avatar(p.name)}<div><strong>${esc(p.name)}</strong><small>${list.map(t => `<button class="text-button" data-task="${esc(t.id)}">GAME-${t.code} · ${esc(t.title)}${t.status === 'blocked' ? ' · blocked' : ''}</button>`).join('')}</small></div></div>`).join('') || '<div class="blank">Nobody is on a task yet. Claim one, or open a task and assign it.</div>'}</section>`;
}
function renderBoard() {
  const tasks = state.board.tasks, done = tasks.filter(t => t.status === 'done').length;
  $('#content').innerHTML = `<section class="stats" aria-label="Project summary">${[
    ['Total tasks', tasks.length, '▤', ''], ['In progress', tasks.filter(t => t.status === 'in_progress').length, '◷', 'blue'],
    ['Blocked', tasks.filter(t => t.status === 'blocked').length, '!', 'orange'], ['Completed', done, '✓', 'green'],
  ].map(([label, count, mark, color]) => `<div class="stat"><div><span>${label}</span><strong>${count}</strong></div><div class="stat-mark ${color}">${mark}</div></div>`).join('')}</section>
    ${teamPanel()}
    <div class="board-toolbar"><div class="tabs" role="group" aria-label="Filter tasks">${[['all', 'All tasks'], ['mine', 'Assigned to me'], ['available', 'Available']].map(([value, label]) => `<button class="tab ${state.filter === value ? 'active' : ''}" data-filter="${value}">${label}${value === 'all' ? `<span>${tasks.length}</span>` : ''}</button>`).join('')}</div><label class="search"><span class="sr-only">Search tasks</span><svg><use href="#i-search"/></svg><input id="search" placeholder="Search tasks…" value="${esc(state.query)}" type="search"></label></div>
    <div class="board" id="board-columns">${boardColumns()}</div>
    <div class="board-bottom"><section class="panel"><div class="panel-heading"><h2>Around the workspace</h2><button class="text-button" data-view="activity">View all ↗</button></div>${feed(state.board.activity.slice(0, 3))}</section><section class="panel integration-panel"><span class="eyebrow">A PLACE FOR YOUR WHOLE PARTY</span><div class="agent-logos" aria-hidden="true">✦ ✳ ↗</div><h2>Your agents.<br>On the same page.</h2><p>Connect Codex and Claude Code to pick up tasks and leave useful handoffs.</p><button data-view="connections">Set up connections <span>↗</span></button><progress value="${done}" max="${tasks.length || 1}" aria-label="Completed tasks"></progress></section></div>`;
  $('#search').addEventListener('input', event => { state.query = event.target.value; $('#board-columns').innerHTML = boardColumns(); });
}
function renderIdeas() {
  const notes = state.board.notes ?? [], old = $('#ideas-scroll'), keep = old && [old.scrollLeft, old.scrollTop];
  $('#content').innerHTML = `<div class="ideas-toolbar"><p class="fine">Double-click anywhere to stick a note. Drag notes around to group ideas. ${notes.length} note${notes.length === 1 ? '' : 's'}.</p><button class="primary" id="new-note"><svg><use href="#i-plus"/></svg>New note</button></div>
    <div class="ideas-scroll" id="ideas-scroll"><div class="ideas-canvas" id="ideas-canvas"><svg class="links" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"/></marker></defs><g id="link-lines"></g></svg>${notes.map(n => `<div class="note ${esc(n.color)}" data-note="${esc(n.id)}" tabindex="0" role="button" aria-label="Note by ${esc(n.author_name)}: ${esc(n.body || 'image')}">${n.image_id ? `<img data-note-image="${esc(n.image_id)}" alt="Image on a note by ${esc(n.author_name)}" draggable="false">` : ''}${n.body ? `<p>${esc(n.body)}</p>` : ''}<small>${esc(n.author_name)}</small></div>`).join('')}</div></div>`;
  // Positions go through the CSSOM: the CSP blocks inline style attributes.
  for (const n of notes) Object.assign(document.querySelector(`[data-note="${n.id}"]`).style, { left: `${n.x}px`, top: `${n.y}px` });
  document.querySelectorAll('[data-note-image]').forEach(img => imageURL(img.dataset.noteImage).then(url => { img.onload = drawLinks; img.src = url; }).catch(() => img.remove()));
  drawLinks();
  const scroll = $('#ideas-scroll'), canvas = $('#ideas-canvas');
  if (keep) [scroll.scrollLeft, scroll.scrollTop] = keep; // the 15 s refresh re-renders; keep the view where it was
  $('#new-note').onclick = () => openNote(null, Math.round(scroll.scrollLeft + 40), Math.round(scroll.scrollTop + 40));
  canvas.ondblclick = event => { if (event.target === canvas) openNote(null, event.offsetX - NOTE_W / 2, event.offsetY - 30); };
  canvas.onkeydown = event => { const el = event.target.closest('[data-note]'); if (el && event.key === 'Enter') openNote(el.dataset.note); };
  canvas.onpointerdown = event => {
    const el = event.target.closest('[data-note]'); if (!el || event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop };
    let moved = false;
    el.setPointerCapture(event.pointerId); state.dragging = true;
    el.onpointermove = move => {
      const x = clamp(start.left + move.clientX - start.x, CANVAS[0] - el.offsetWidth), y = clamp(start.top + move.clientY - start.y, CANVAS[1] - el.offsetHeight);
      moved ||= Math.abs(x - start.left) + Math.abs(y - start.top) > 4;
      if (moved) { el.classList.add('dragging'); el.style.left = `${x}px`; el.style.top = `${y}px`; drawLinks(); }
    };
    el.onpointerup = el.onpointercancel = async () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null; el.classList.remove('dragging'); state.dragging = false;
      if (!moved) return openNote(el.dataset.note);
      const position = { x: el.offsetLeft, y: el.offsetTop };
      Object.assign(state.board.notes.find(n => n.id === el.dataset.note), position);
      try { await api(`/api/notes/${el.dataset.note}`, 'PATCH', position); } catch (error) { notice(error.message, true); await loadBoard(); }
    };
  };
}
const clamp = (value, max) => Math.round(Math.min(Math.max(value, 0), max));
// Arrows between linked notes, drawn from border to border so the head isn't hidden under the target note.
function drawLinks() {
  const g = $('#link-lines'); if (!g) return;
  const box = id => { const el = document.querySelector(`[data-note="${id}"]`); return el && { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2, w: el.offsetWidth / 2 + 5, h: el.offsetHeight / 2 + 5 }; };
  const edge = (b, ux, uy) => { const t = Math.min(b.w / Math.abs(ux || 1e-9), b.h / Math.abs(uy || 1e-9)); return [b.x + ux * t, b.y + uy * t]; };
  g.innerHTML = (state.board.links ?? []).map(link => {
    const a = box(link.from_id), b = box(link.to_id); if (!a || !b) return '';
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    const [x1, y1] = edge(a, ux, uy), [x2, y2] = edge(b, -ux, -uy);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)"/>${link.label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 7}">${esc(link.label)}</text>` : ''}`;
  }).join('');
}
const short = note => esc(note.body ? (note.body.length > 40 ? `${note.body.slice(0, 40)}…` : note.body) : 'Image note');
function noteLinks() {
  const { notes, links = [], actor } = state.board, id = state.note.id, note = notes.find(n => n.id === id);
  $('#note-links').hidden = !note; if (!note) return;
  const mine = links.filter(l => l.from_id === id || l.to_id === id), linked = new Set(mine.flatMap(l => [l.from_id, l.to_id]));
  $('#note-link-list').innerHTML = mine.map(l => {
    const other = notes.find(n => n.id === (l.from_id === id ? l.to_id : l.from_id));
    return `<li><span>${l.from_id === id ? '→' : '←'} ${short(other)}${l.label ? ` <em>${esc(l.label)}</em>` : ''}</span>${actor.role === 'owner' || l.created_by_id === actor.id ? `<button type="button" class="icon-button" data-unlink="${esc(l.id)}" aria-label="Remove this connection">×</button>` : ''}</li>`;
  }).join('') || '<li class="fine">Not connected to anything yet.</li>';
  const options = notes.filter(n => !linked.has(n.id) && n.id !== id);
  $('#link-target').innerHTML = options.length ? `<option value="" selected disabled>Connect to…</option>${options.map(n => `<option value="${esc(n.id)}">${short(n)}</option>`).join('')}` : '<option value="">No other notes to connect</option>';
  $('#add-link').disabled = !options.length;
}
const readFile64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  reader.onerror = () => reject(new Error('Could not read the selected image.')); reader.readAsDataURL(file);
});
const okImage = file => file.size <= MAX_IMAGE_BYTES && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
function openNote(id, x, y) {
  const note = state.board.notes.find(n => n.id === id), actor = state.board.actor;
  const canEdit = !note || actor.role === 'owner' || note.author_id === actor.id;
  state.note = note ? { id } : { x: clamp(x, CANVAS[0] - NOTE_W), y: clamp(y, CANVAS[1] - NOTE_H) };
  $('#note-form').reset();
  $('#note-heading').textContent = note ? (canEdit ? 'Edit note' : 'Note') : 'New note';
  $('#note-body').value = note?.body ?? ''; $('#note-color').value = note?.color ?? 'yellow';
  $('#note-body').readOnly = $('#note-color').disabled = !canEdit;
  $('#note-meta').textContent = note ? `Stuck up by ${note.author_name} · ${relative(note.created_at)}${canEdit ? '' : ' · only the author or owner can edit it'}` : '';
  $('#save-note').hidden = !canEdit; $('#save-note').textContent = note ? 'Save note' : 'Stick it';
  $('#delete-note').hidden = !note || !canEdit;
  $('#note-image-field').hidden = !!note; $('#note-body').required = !note?.image_id;
  const preview = $('#note-image-preview'); preview.hidden = !note?.image_id; preview.removeAttribute('src');
  if (note?.image_id) imageURL(note.image_id).then(url => { preview.src = url; }).catch(() => { preview.hidden = true; });
  noteLinks();
  $('#note-dialog').showModal();
}
function renderActivity() {
  $('#content').innerHTML = `<section class="panel activity-full"><div class="activity-header"><h2>The latest from your party</h2><button class="secondary" id="project-update">Post an update</button></div>${feed(state.board.activity)}</section>`;
  $('#project-update').onclick = () => openTask(null);
}
async function renderConnections() {
  const owner = state.board.actor.role === 'owner';
  $('#content').innerHTML = `<div class="connections-grid"><section class="panel"><div class="panel-heading"><h2>Your party’s access</h2>${owner ? '<button class="primary" id="create-key-button">+ Create key</button>' : '<span class="tag">Managed by owner</span>'}</div><p class="fine">One key per person or agent. Revoking a key stops its next request immediately.</p><div id="keys-list">${owner ? '<p class="fine">Loading connections…</p>' : '<div class="blank">Ask the workspace owner for a separate agent key. Your current key can read the board and coordinate tasks.</div>'}</div></section>
    <section class="panel"><div class="panel-heading"><h2>Connect an agent</h2><span class="tag">MCP</span></div><p class="setup-step"><b>1. Install the connector.</b><br>Copy the agent-board folder to the agent’s computer and run <code>npm install</code> with Node 22+.</p><p class="setup-step"><b>2. Create an individual agent key.</b><br>Give Codex and Claude Code different names and keys.</p><p class="setup-step"><b>3. Add the local MCP server.</b><br>Use the launch command and environment below. Full Codex and Claude Code examples are in README.md.</p><pre>Command: node
Args: /absolute/path/to/agent-board/mcp.js

BOARD_URL=${esc(location.origin)}
BOARD_KEY=YOUR_AGENT_ACCESS_KEY</pre><p class="fine">Read board → claim task → work → post evidence → hand off.<br>Agents read updates when they use their tools; this connection does not wake a closed session.</p>${state.board.demo ? '<p class="fine">Demo connections work only on this computer. Use an HTTPS deployment and Supabase for your shared board.</p>' : ''}</section></div>`;
  if (!owner) return;
  $('#create-key-button').onclick = () => { $('#key-form').hidden = false; $('#key-result').hidden = true; $('#key-create').showModal(); };
  try {
    const keys = await api('/api/keys');
    if (state.view !== 'connections') return;
    $('#keys-list').innerHTML = keys.length ? keys.map(k => `<div class="key-row ${k.revoked_at ? 'revoked' : ''}">${avatar(k.name)}<div><strong>${esc(k.name)}</strong><small>${esc(k.role)} · ${esc(k.prefix)}… · ${k.revoked_at ? 'revoked' : 'active key'}</small></div>${k.revoked_at ? '<span class="tag">Revoked</span>' : `<button class="secondary" data-revoke="${esc(k.id)}">Revoke</button>`}</div>`).join('') : '<div class="blank">Your party starts here.<br>Create a key for your teammate or their agent.</div>';
  } catch (error) { if ($('#keys-list')) $('#keys-list').textContent = error.message; }
}
function render() {
  const { actor, tasks, demo } = state.board;
  document.querySelectorAll('[data-project]').forEach(el => { el.textContent = state.board.name; });
  $('#nav-count').textContent = tasks.length; $('#identity-name').textContent = actor.name;
  $('#identity-role').textContent = actor.role === 'owner' ? 'Workspace owner' : actor.role === 'agent' ? 'Agent connection' : 'Teammate';
  $('#identity-avatar').textContent = initials(actor.name); $('#demo-banner').hidden = !demo;
  $('#mode-badge').textContent = demo ? 'Demo preview' : 'Shared workspace';
  document.querySelectorAll('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.view === state.view); el.setAttribute('aria-current', el.dataset.view === state.view ? 'page' : 'false'); });
  const headings = { board: ['LET’S BUILD SOMETHING GOOD', 'Project board', 'A little structure. A lot more making things happen.'], activity: ['KEEP THE PARTY IN THE LOOP', 'Activity', 'Progress, decisions, and context for whoever comes next.'], connections: ['HUMANS + AGENTS', 'Connections', 'Give everyone a place in the party. And their own key.'], ideas: ['NO IDEA IS TOO SMALL', 'Idea board', 'Stick up ideas, move them around, and see what belongs together.'] };
  const [eyebrow, title, description] = headings[state.view];
  $('#page-eyebrow').textContent = eyebrow; $('#page-title').innerHTML = `${title}<span>.</span>`; $('#page-description').textContent = description;
  $('#new-task').hidden = state.view !== 'board';
  if (state.view === 'board') renderBoard(); else if (state.view === 'ideas') renderIdeas(); else if (state.view === 'activity') renderActivity(); else renderConnections();
  $('#sync-label').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refreshes every 15s`;
}
async function loadBoard() {
  state.board = await api('/api/board');
  if (!$('#image-viewer').open) {
    const visible = new Set([...state.board.activity.flatMap(item => splitImages(item.body).images), ...(state.board.notes ?? []).map(n => n.image_id)]);
    for (const [id, entry] of imageCache) if (!visible.has(id) && entry.url) { URL.revokeObjectURL(entry.url); imageCache.delete(id); }
  }
  $('#welcome').hidden = true; $('#app').hidden = false; render();
}
async function login(secret) {
  const previous = key; key = secret;
  try { await loadBoard(); sessionStorage.setItem('partyboard-key', key); }
  catch (error) { key = previous; throw error; }
}
function showTask() {
  const task = state.board.tasks.find(t => t.id === state.task);
  const actor = state.board.actor, canChange = task && (task.assignee_id === actor.id || actor.role === 'owner');
  const canAssign = task && task.status !== 'done' && (canChange || !task.assignee_id);
  const assignee = canAssign ? `<label class="sr-only" for="detail-assignee">Assign to</label><select id="detail-assignee"><option value="" disabled ${task.assignee_id ? '' : 'selected'}>Assign to…</option>${state.board.people.map(p => `<option value="${esc(p.id)}" ${p.id === task.assignee_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : `<span class="tag">${esc(task?.assignee_name || 'Unassigned')}</span>`;
  $('#detail-code').textContent = task ? `GAME-${task.code}` : 'PROJECT UPDATE';
  $('#detail-title').textContent = task?.title || 'Keep the party in the loop.';
  $('#detail-description').textContent = task?.description || (task ? 'No description yet.' : 'Share progress, a decision, or a handoff with your whole team.');
  $('#detail-controls').innerHTML = task ? `${assignee}${!task.assignee_id && task.status !== 'done' ? '<button class="primary" data-action="claim">Claim task</button>' : ''}<label class="sr-only" for="detail-status">Task status</label><select id="detail-status" ${canChange ? '' : 'disabled'}>${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${task.assignee_id && canChange ? '<button class="secondary" data-action="release">Release</button>' : ''}` : '';
  $('#detail-thread').innerHTML = feed(state.board.activity.filter(a => a.task_id === (task?.id ?? null)).slice(0, 30).reverse());
  const who = $('#detail-assignee');
  if (who) who.onchange = async () => { who.disabled = true; try { await changeTask({ action: 'assign', assignee_id: who.value }); } catch (error) { notice(error.message, true); showTask(); } };
  const select = $('#detail-status');
  if (select) select.onchange = async () => { select.disabled = true; try { await changeTask({ action: 'status', status: select.value }); } catch (error) { notice(error.message, true); showTask(); } };
}
function openTask(id) { state.task = id; $('#update-form').reset(); resetUpdateImage(); showTask(); $('#task-detail').showModal(); }
async function changeTask(change) {
  await api(`/api/tasks/${state.task}`, 'PATCH', change); await loadBoard(); showTask();
}
async function submit(form, work) {
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try { await work(); } catch (error) { notice(error.message, true); } finally { button.disabled = false; }
}
$('#login-form').onsubmit = event => { event.preventDefault(); submit(event.currentTarget, () => login($('#login-key').value.trim())); };
$('#demo-login').onclick = () => login('demo-owner').catch(error => notice(error.message, true));
function logout() {
  key = ''; state.board = null; sessionStorage.removeItem('partyboard-key'); $('#login-key').value = '';
  for (const entry of imageCache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  imageCache.clear(); resetUpdateImage(); $('#app').hidden = true; $('#welcome').hidden = false;
}
$('#logout').onclick = logout;
$('#mobile-logout').onclick = logout;
$('#new-task').onclick = () => $('#task-create').showModal();
$('#create-form').onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
  submit(form, async () => { await api('/api/tasks', 'POST', values); form.reset(); $('#task-create').close(); await loadBoard(); notice('Task created. Ready for someone to pick up.'); });
};
$('#update-form').onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget;
  submit(form, async () => {
    const values = { kind: form.elements.kind.value, body: form.elements.body.value, task_id: state.task };
    const file = $('#update-image').files[0];
    if (file) values.image_base64 = await readFile64(file);
    await api('/api/updates', 'POST', values); form.reset(); resetUpdateImage(); await loadBoard(); showTask(); notice('Update posted to your party.');
  });
};
$('#update-image').onchange = () => {
  const file = $('#update-image').files[0];
  if (!file) return resetUpdateImage();
  if (!okImage(file)) { resetUpdateImage(); notice('Choose a PNG, JPEG, or WebP image up to 3 MB.', true); return; }
  if (selectedPreview) URL.revokeObjectURL(selectedPreview);
  selectedPreview = URL.createObjectURL(file); $('#selected-image').src = selectedPreview; $('#image-selection').hidden = false; $('#update-body').required = false;
};
$('#remove-image').onclick = resetUpdateImage;
$('#note-form').onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget, values = { body: $('#note-body').value, color: $('#note-color').value };
  submit(form, async () => {
    const file = $('#note-image').files[0];
    if (state.note.id) await api(`/api/notes/${state.note.id}`, 'PATCH', values);
    else await api('/api/notes', 'POST', { ...values, x: state.note.x, y: state.note.y, ...(file && { image_base64: await readFile64(file) }) });
    $('#note-dialog').close(); await loadBoard();
  });
};
$('#note-image').onchange = () => {
  const file = $('#note-image').files[0], preview = $('#note-image-preview');
  if (file && !okImage(file)) { $('#note-image').value = ''; notice('Choose a PNG, JPEG, or WebP image up to 3 MB.', true); }
  const ok = $('#note-image').files[0];
  $('#note-body').required = !ok; preview.hidden = !ok;
  if (notePreview) URL.revokeObjectURL(notePreview);
  notePreview = ok && URL.createObjectURL(ok); if (ok) preview.src = notePreview;
};
let notePreview;
$('#add-link').onclick = async () => {
  if (!$('#link-target').value) return;
  $('#add-link').disabled = true;
  try { await api('/api/links', 'POST', { from_id: state.note.id, to_id: $('#link-target').value, label: $('#link-label').value }); $('#link-label').value = ''; await loadBoard(); }
  catch (error) { notice(error.message, true); }
  noteLinks();
};
$('#delete-note').onclick = async () => {
  if (!confirm('Delete this note for everyone?')) return;
  try { await api(`/api/notes/${state.note.id}`, 'DELETE'); $('#note-dialog').close(); await loadBoard(); notice('Note removed.'); }
  catch (error) { notice(error.message, true); }
};
$('#task-detail').addEventListener('close', resetUpdateImage);
$('#image-viewer').addEventListener('close', () => { $('#large-image').removeAttribute('src'); $('#download-image').removeAttribute('href'); });
$('#key-form').onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
  submit(form, async () => { const issued = await api('/api/keys', 'POST', values); $('#issued-key').value = issued.secret; form.hidden = true; $('#key-result').hidden = false; await renderConnections(); });
};
$('#copy-key').onclick = async () => { try { await navigator.clipboard.writeText($('#issued-key').value); notice('Key copied. Store it somewhere private.'); } catch { $('#issued-key').select(); notice('Select and copy the key manually.'); } };
$('#key-create').addEventListener('close', () => { $('#issued-key').value = ''; $('#key-form').reset(); $('#key-result').hidden = true; });
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close]'); if (close) return close.closest('dialog').close();
  const image = event.target.closest('[data-view-image]'); if (image) return openImage(image.dataset.viewImage);
  const view = event.target.closest('[data-view]'); if (view && state.board) { state.view = view.dataset.view; render(); return; }
  if (event.target.closest('[data-new-task]')) return $('#task-create').showModal();
  if (event.target.closest('[data-toggle-done]')) { state.allDone = !state.allDone; $('#board-columns').innerHTML = boardColumns(); return; }
  const filter = event.target.closest('[data-filter]'); if (filter) { state.filter = filter.dataset.filter; renderBoard(); return; }
  const task = event.target.closest('[data-task]'); if (task) return openTask(task.dataset.task);
  const action = event.target.closest('[data-action]');
  if (action) { action.disabled = true; try { await changeTask({ action: action.dataset.action }); } catch (error) { notice(error.message, true); showTask(); } }
  const unlink = event.target.closest('[data-unlink]');
  if (unlink) {
    unlink.disabled = true;
    try { await api(`/api/links/${unlink.dataset.unlink}`, 'DELETE'); await loadBoard(); } catch (error) { notice(error.message, true); }
    return noteLinks();
  }
  const revoke = event.target.closest('[data-revoke]');
  if (revoke && confirm('Revoke this key? Its next request will be rejected. You can issue a new key later.')) {
    revoke.disabled = true;
    try { await api(`/api/keys/${revoke.dataset.revoke}`, 'DELETE'); await renderConnections(); notice('Access key revoked.'); }
    catch (error) { revoke.disabled = false; notice(error.message, true); }
  }
});
try {
  const config = await fetch('/api/config').then(r => r.json()); document.title = `${config.name} · Partyboard`;
  $('#demo-login').hidden = !config.demo;
  if (key) await loadBoard();
} catch (error) { notice(`Could not open the workspace: ${error.message}`, true); }
setInterval(() => {
  if (key && state.board && !state.dragging && !document.hidden && !document.querySelector('dialog[open]') && document.activeElement?.id !== 'search') loadBoard().catch(() => { $('#sync-label').textContent = 'Could not refresh. Check your connection or access key.'; });
}, 15000);
