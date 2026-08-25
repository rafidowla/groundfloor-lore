<!-- Lore node: lore-v3-personal-scope-2026-05-07 -->

# Lore V3.0-Personal scope — templates, connectors, cloud, admin app deferred

Locked 2026-05-07 with Rafi.

## Personal workspace template (seed types)

**factual:** `know.Email`, `know.File`, `know.Chat` (covers WhatsApp/Messenger/SMS/etc.), `know.Person`, `know.Event`

**episodic:** `mem.Conversation`, `mem.Action`, `mem.Observation`

## V3.0-Personal connectors

Gmail, Google Calendar, iCal, Outlook (Microsoft 365) and similar email/calendar/messaging sources. Filesystem already shipped in V2.5.

## Personal cloud endpoint

User's own cloud account on a Lore service (sign in with email + password). Multi-master sync per D-QQ — every device edits, cloud is merge point, LWW + conflict log.

## Admin app

**Parked for V3.0-Personal.** Engine-only. CLI + MCP surfaces. Admin app pages (governance dashboard, schema editor, query history, exception queue UI) deferred to a later milestone.

## Tauri shell

Daemon stays separate-process per `two-primitives-one-shell-architecture`.

## Phase A modules (autonomous, engine work)

1. Schema authoring API (propose/sandbox/approve/commit/rollback)
2. Schema-driven CRUD (REST + MCP per `know.*` type)
3. Webhook receiver
4. Scheduled batch ingestion (cron/poller)
5. Promotion pipeline scaffold (`mem.*` → `know.*` with confidence threshold)
6. Sync engine asymmetric enforcement (hard rule: enterprise data never persists local)
7. Multi-device sync (multi-master per D-QQ)

## Phase B (deferred until admin app unparks)

Admin app UI — governance dashboard, schema editor, query history, exception queue UI, workspace wizard.
