# Design

## Source of truth
- Status: Active MVP; Vercel deployment configured.
- Last refreshed: 2026-10-25.
- Primary product surfaces: shared task board, activity, task handoffs, access keys.
- Evidence reviewed: shared game workspace for two people and Codex + Claude Code; Supabase schema and live coordination verified. User requested screenshots/model images attached to task updates.

## Brand
- Personality: friendly game studio workbench, named Partyboard provisionally.
- Trust signals: explicit demo banner, named actors, timestamps, visible key revocation.
- Avoid: fake live presence, invented metrics, complex enterprise navigation.

## Product goals
- Coordinate work between people and agents; make ownership and handoffs visible.
- Prevent two agents from claiming the same task; allow independent key revocation.
- Non-goals: running remote code, autonomous scheduling, billing/licenses, hosting 3D model files.
- Success: one agent claims work and posts an update that the other agent and people can read.

## Personas and jobs
- Two game developers: create tasks, see blockers, review progress, manage access.
- Codex and Claude Code: read context, claim work, report evidence, leave handoffs.
- One workspace per deployment/database in the MVP; multiple projects need a later tenancy design.

## Information architecture
- Board, Activity, Connections navigation.
- Main board: project summary, status columns, clickable tasks.
- Task dialog: description, status, owner, progress/handoff thread, one optional image per update, click-to-enlarge image dialog with download.
- Connections: issue individual agent/member keys and revoke them; owner only.

## Design principles
- Show the next useful action and the person/agent responsible.
- Record reports as reports; activity is not proof that game code works.
- Tradeoff: explicit status controls instead of drag-and-drop so keyboard and mobile work equally.

## Visual language
- Color: warm off-white canvas, white cards, ink text, orange accent, blue/green status hints.
- Typography: platform sans-serif; monospace for task identifiers and connection config.
- Spacing/layout: 8px rhythm, persistent left navigation on desktop, compact top navigation on mobile.
- Shape: 12–20px corners, fine gray borders, subtle card shadows.
- Motion: subtle transitions only; respect reduced motion.
- Imagery: CSS initials/agent icons and private PNG/JPEG/WebP update attachments up to 3 MB; no external fonts or third-party image URLs.

## Components
- No existing web components to reuse.
- Native forms/buttons/dialogs, task cards, status pills, activity rows, image previews/viewer, notices.
- States are defined in public/style.css; client owns presentation, server owns permissions.

## Accessibility
- Target: WCAG 2.2 AA patterns; no formal certification claimed.
- Visible focus, semantic headings/labels, native dialog focus trap, Escape close.
- Status uses labels and color; text errors use a live region.
- Reduced motion supported; no hover-only controls.

## Responsive behavior
- Desktop: 220px sidebar and four-column board.
- Tablet: two-column board; mobile: single-column board and horizontal navigation.
- Touch: native buttons with practical hit areas.

## Interaction states
- Loading: readable status and disabled submit during requests.
- Empty: explain how to create the first task or progress update.
- Error/offline: show failure and retain current data/forms; never invent a successful save.
- Success: refresh server data; show new keys only once in the current dialog.
- Disabled: unauthorized task changes and owner-only connections.

## Content voice
- Plain English, short actions, no technical credentials in the normal task flow.
- Use “access key” for authentication; “license” would imply billing/entitlement not implemented here.
- Blockers and handoffs should name what is needed and link evidence when available.

## Implementation constraints
- Node 22+, plain HTML/CSS/JS, official MCP SDK for a local stdio connector.
- Supabase Postgres accessed only by the server. RLS enabled with no browser/anonymous table policies.
- Browser credentials remain in sessionStorage; logout clears them. Never expose the database secret.
- Images use the private partyboard-images Storage bucket, created on first upload. Every image read passes through authenticated server routes; no credentials in image URLs. The browser fetches blobs and clears object URLs on sign-out. Attachment references use strict internal image markers in existing update text, avoiding a database migration.
- Use the installed @supabase/server admin-client primitive only behind the board's existing project-key authentication. Accept one PNG/JPEG/WebP image per upload, validate bytes and a 3 MB limit, and clean up a new upload if saving its update fails.
- Demo is loopback-only, in-memory, explicitly labeled; restart discards demo data.
- Board polls every 15 seconds; background agents must be running and invoke tools to read changes.
- Validate permissions, atomic claims, input, and actual MCP traffic. Inspect desktop/mobile rendering.

## Open questions
- Final product/project name. Hosting provider: Vercel, configured for the serverless entry point.
- Whether future work needs multiple projects, email sign-in, notifications, or expiring task leases.
