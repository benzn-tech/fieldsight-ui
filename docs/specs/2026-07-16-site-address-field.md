# Spec: Site `address` field in the web admin

**Status:** ready to implement (written 2026-07-16 for a separate session to execute)
**Repo:** fieldsight-ui (pure HTML + browser-side React, Babel in-browser, no build step)
**Scope:** SMALL, localized. No new page, no architecture change. Add one optional free-text `address` field to a site — enterable at creation AND editable on existing sites.

## Why

The GrandTime mobile bodycam app burns a location watermark into evidence video/photos. As of 2026-07-15 the 4th watermark line shows the selected site's **name**. We are extending it so the 4th line shows the site's **street address when present, falling back to the name**. The address is a per-site attribute an admin enters here. The backend (`fieldsight-pipeline`) is being extended in parallel to persist/return `sites.address` (nullable text) — see "Backend contract" below; that side may already be live on the `fieldsight-test` stack by the time this is implemented (verify `GET /api/org/sites` returns an `address` key).

Existing sites (e.g. "SB1108 Ellesmere College", "UC") already exist with no address — so **editing an existing site's address is required**, not just setting it at creation.

## Backend contract (already speced/implemented separately — do not build here)

- `sites` table gains `address text` (nullable). Migration `0013_site_address.sql` in fieldsight-pipeline.
- `GET /api/org/sites` → each site object gains `"address"` (string or absent/null). Read path is generic serialization, so it appears automatically.
- `POST /api/org/sites` (create) accepts optional `address` in the body → persisted.
- `PATCH /api/org/sites/{id}` (update) accepts optional `address` in the body → persisted (COALESCE, so omitting it leaves the value unchanged).
- Both create/patch are admin/gm-gated already (address rides the same routes as `location`/`client`, no new ACL).

The web JS API wrappers are generic pass-throughs, so no change is needed to send `address`:
- `scripts/api/org.js:97-105` `createOrgSite(body)` → POST `/sites` (forwards body as-is)
- `scripts/api/org.js:107-111` `updateOrgSite(id, patch)` → PATCH `/sites/:id` (forwards patch as-is)

## Change 1 — Create form (`scripts/pages/sites.js`, `NewProjectModal`)

`NewProjectModal` is the admin-gated "+ New project" create form (`sites.js:233-306`, gated by `canCreate` at ~`sites.js:362`, button ~`sites.js:382-385`).

1. **Form state** (`sites.js:240`): add `address: ''` to the initial state object
   (currently `{ name:'', location:'', region:'south-island', client:'', project_value_nzd:'', planned_completion:'' }`).
2. **Rendered field** (`sites.js:288-299`): add one row copying the exact pattern of the existing "Location" / "Client" rows (`sites.js:295,297`):
   `fFieldRow('Address', fText(form.address, function (v) { set('address', v); }))`.
   Place it right after "Location" (Address and Location are related; Location = city, Address = street). Optional field — no required marker.
3. **Submit payload** (`sites.js:263-265`): the object passed to `createOrgSite(...)` / `createSite(form)` — ensure `address` is included. If it forwards `form` wholesale it's automatic; if it builds an explicit object, add `address: form.address`.
4. **Mock create builder** (`scripts/api/sites.js:52-68`, `createSite(input)`): this builds the mock site object explicitly field-by-field (`sites.js:53-63`). Add `address: input.address || ''` (or `|| null`) so the mock/offline path mirrors live.

## Change 2 — Edit existing site's address (`scripts/pages/sites.js`, `SitesRightDetail`)

`SitesRightDetail` (`sites.js:436-699`) is the right-hand detail panel for the selected site. Today it only supports single-purpose edits: change icon (`onPickIcon` → `updateOrgSite(sel.site_id, { icon_s3_key })` at ~`sites.js:519`) and archive/unarchive (`sites.js:539-573`). **There is no text-field editor** — name/location/etc. are set once at creation.

Add a minimal editable Address affordance in this panel:
- Show the site's current `address` (from the selected site object, which now includes it from `GET /sites`) as a small labeled row. When empty, show a muted placeholder like "No address set".
- Provide a lightweight edit: an inline text input + Save (mirror the smallest existing edit idiom in this file — e.g. the icon-change control's gating/spinner/error pattern at `sites.js:500-531`, minus the file upload). On Save, call the already-existing `updateOrgSite(sel.site_id, { address: value })` and refresh the detail (the same refresh path the icon/archive actions use).
- Gate it the same way the other edit actions are gated (admin / `user:manage` caller — reuse the existing capability check used for icon/archive in this panel; do NOT invent a new gate).
- Keep it visually minimal — one row, consistent with the panel's existing spacing/BEM classes. No modal needed; inline edit is fine and smaller.

## Out of scope / notes

- Do NOT add address to read-only site pickers/cards elsewhere (`SiteCard` `sites.js:413-427`, timeline/programme/insights pickers) unless trivially useful — not required for this feature.
- `location` (existing, = city) stays as-is; `address` is a new distinct field (street). Do not repurpose `location`.
- No new dependency, no new route, no new page.

## Acceptance

1. Admin opens "+ New project", sees an "Address" input after "Location", enters a street address, creates the site → `POST /sites` body includes `address` → reload shows it persisted.
2. Admin selects an existing site (e.g. UC), sees its current address (or "No address set"), edits + saves → `PATCH /sites/{id}` with `{address}` → panel reflects the new value after refresh.
3. Non-admin caller does not see the edit control (same gating as icon/archive).
4. Mobile side (separate repo): after an address is set here and `GET /org/sites` returns it, the GrandTime app's next site-list fetch picks it up and the watermark's 4th line shows the address instead of the name. (Cross-repo end-to-end — not verifiable from this repo alone.)

## Branch

Base off `dev` (integration branch; `main` and `dev` both exist). `feat/timeline-source-flag` is an unrelated in-flight feature — do not base on it.
