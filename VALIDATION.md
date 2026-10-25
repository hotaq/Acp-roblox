# Validation and deployment handoff

Checked on 2026-10-25 with Node 22.22.3 and the installed official MCP SDK 1.32.1.

- Current `npm test`: 13 tests passed, 0 failed, 0 skipped.
- Tested real official SDK MCP client/server exchanges in memory, including competing claims, handoffs, release, and key revocation, through the actual API handler.
- Tested a real child-process stdio connector initialization and discovery of all seven current tools.
- Checked server/client/connector JavaScript syntax.
- Supabase adapter tests check request filters, private credential headers, and sanitized network failures. They do not exercise a live database.

The first run encountered sandbox network/listening restrictions. On the follow-up, approved execution allowed a fresh npm install and normal local HTTP serving. The temporary dependency symlink was removed without changing its shared target. The project now has a real local node_modules directory and package-lock.json. Installed versions are MCP SDK 1.32.1 and the requested official @supabase/server 1.9.2. The package's core module imports successfully, and all six tests passed again after installation. The official supabase-server skill was installed into the user's Codex skills folder; it is available on the next turn.

Native Safari/Arc inspection timed out. Desktop/mobile visual QA and a normally served browser interaction flow remain unverified. `output/preview.html` and `output/preview-mobile.html` are generated, read-only offline previews using the same UI code and explicit sample data; they intercept requests locally and cannot save real work. The source archive includes a standalone `preview.html` for review.

The user supplied an existing Supabase project's application credentials. Required server settings were saved to a private .env (mode 600), and a workspace owner access key was generated locally. No credential is printed in this report or included in the source archive. No paid service, external hosting deployment, schema execution, or change to Codex/Claude MCP configuration was performed. The existing game/model folders were not changed.

The initial connection returned HTTP 404 / PGRST205 for the three missing tables. After the user successfully applied supabase/schema.sql, all three tables returned 200 with the server key, and the authenticated local board endpoint returned 200. The configured app is serving on http://localhost:4317.

Live acceptance check passed at 2026-10-25T06:27:44Z against the real database. Two actual child-process stdio MCP connectors discovered all six tools and competed for one task; exactly one won. The losing agent could not change the task, could read the winner's handoff, then claimed the task after release and completed it. A fresh independent HTTP server instance using a new store loaded the completed task from Supabase. Both temporary agent keys were revoked, and both connectors' next reads were denied. The single completed task GAME-1, titled “[Setup check] Two-agent coordination”, remains visible as clearly labeled setup evidence. The test did not change or playtest game files. Secret-free machine-readable results are in output/live-validation.json.

The supplied publishable key was denied access (HTTP 401) to board_tasks, board_activity, and board_keys. GET /.env on the local website returned 404. Supabase credentials and the workspace owner key remain private and are excluded from the source archive.

Sign in to the local website using OWNER_KEY from the local .env, then issue individual real teammate/agent keys under Connections. The schema is now applied; no additional database connection string is required for normal board operations. A public HTTPS deployment is still needed for the friend's computer. Browser visual QA, hosted deployment, and Docker image build remain unverified.

## Private image attachments

Added one PNG/JPEG/WebP image per update, up to 5 MB, with previews, a larger image dialog, and original download. No SQL migration was needed: internal image references are stored in existing update text. The private partyboard-images bucket is created by the server through the installed @supabase/server admin-client primitive. HTTP image reads require the normal workspace key. The MCP post_update tool accepts an optional local image_path, and the new view_image tool returns image content.

Additional checks cover binary round trips, invalid/oversized uploads, denied anonymous/revoked keys, strict internal references, cleanup after a failed update, restricted bucket creation, refusal to use a public bucket, and MCP attachment/view traffic. The Dockerfile now installs locked runtime dependencies because the server uses @supabase/server for Storage.

Live image acceptance check passed at 2026-10-25T06:40:41Z. A temporary agent uploaded the existing goblin/docs/turnaround_front.png render to GAME-1 through actual stdio MCP. Both MCP view_image and the authenticated website route returned all 684372 original bytes with SHA-256 3e379bf9ae3ac9e256d38dec10e69bf590587335c4359ee0471ca9a8fda51ac8. A fresh Storage client downloaded matching bytes. Bucket metadata confirmed public=false, anonymous API reads and public Storage URLs were denied, and revocation blocked the temporary key's next image request. The image remains attached for the user to review. Secret-free evidence is in output/live-images-validation.json.

Browser discovery currently reports no connected browser surface; the new image UI has not received a visual browser check. No game assets were modified. Offline preview artifacts use synthetic sample data and do not embed the private goblin render.

## Vercel preparation

The Vercel entry reuses the same authenticated HTTP handler without opening a socket. Tests cover missing-environment failure, static files, private route protection, blocked environment-file reads, rejected origins, and the maximum encoded image payload. Image uploads now use a 3 MB limit to fit Vercel's 4.5 MB request/response cap. Node is pinned to 22.x, runtime public files are included explicitly, and Git/Vercel ignore rules exclude local environment files, project credentials, generated output, and archives.

The existing GitHub target was empty before initialization. Source is prepared for hotaq/Acp-roblox with the app at repository root. Vercel deployment results and credential-exclusion checks are recorded locally under ignored output files; production verification is separate from the earlier localhost checks above.
