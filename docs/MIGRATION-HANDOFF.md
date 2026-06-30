# FieldSight — Session Handoff & Migration Summary

> Written 2026-06-30 to package this work for a fresh conversation (context limit reached).
> Covers the `fieldsight-ui` prototype, its AWS deployment, everything changed this session, and what's left.

---

## 0. TL;DR
- **`fieldsight-ui`** (this repo) is the in-browser React **prototype**. It is now **deployed to AWS Amplify** as a **dev** environment and auto-deploys on push to the **`dev`** branch.
- **Dev URL:** https://dev.d2fssznicvuckr.amplifyapp.com  (mock mode — fake data, no backend)
- Work this session: **FieldSightAI yellow rebrand**, a batch of **UI bug fixes**, and **3 feature phases** — A (account settings), B (admin create project / add member / assign role), C (project & member images).
- Everything is **mock / session-scoped** (created data resets on reload). No real backend is wired yet.

---

## 1. Deploy model (current)
- **Push to `dev` → Amplify auto-builds + deploys** to the dev URL (GitHub webhook → Amplify).
- **`amplify.yml`** (repo root) is the build spec: copies `scripts/`, `styles/`, `*.html` into `dist/` and sets `app-shell-preview.html` as `index.html`.
- **Cache-busters:** when a loaded file changes, bump its `?v=N` in `app-shell-preview.html` (otherwise browsers serve stale CSS/JS). This is done on every commit here.
- **main → prod:** NOT set up. When ready, connect the `main` branch in the Amplify console as a prod environment (and eventually retire the old frontend — see §6).

### AWS resources (account `509194952652`, region `ap-southeast-2`)
| Resource | Value / note |
|---|---|
| Amplify app id | **`d2fssznicvuckr`** (console: `https://ap-southeast-2.console.aws.amazon.com/amplify/apps/d2fssznicvuckr`) |
| Amplify dev branch URL | **https://dev.d2fssznicvuckr.amplifyapp.com** (auto-build on) |
| Amplify service role | `fieldsight-amplify-service` (AdministratorAccess-Amplify) |
| Local deploy IAM user | `fieldsight-deployer` (IAM **user**, AdministratorAccess, **static access key** in `~/.aws` profile `fieldsight-deployer`) — used for the *earlier* manual S3 deploys; mostly unneeded now. **Security TODO:** disable/rotate or move to OIDC. |
| Frontend buckets | `fieldsight-web-509194952652` (prod, old app), `fieldsight-web-test-509194952652` (test, old app) |
| Data buckets | `fieldsight-data-509194952652`, `fieldsight-data-test-509194952652` |
| Old test CloudFront | `E34AAK2PCGPWVZ` → `d3qwnuldpg1tmp.cloudfront.net` (the pre-Amplify S3 host). **Left in place** (likely the `fieldsight-pipeline` test frontend infra — not ours to delete). |

> Retired this session: the interim **S3+CloudFront+GitHub Actions** UI deploy — the `deploy-ui.yml` workflow, OIDC role `fieldsight-ui-deploy-github`, and GitHub secret `UI_DEPLOY_ROLE_ARN` were **deleted** when we moved to Amplify; `deploy-test.sh` removed.

### Local AWS access note
The user signs in with `aws login` (root session, **expires periodically** → re-run `! aws login`). A web/cloud Claude session has **no AWS creds** — only the local machine or GitHub/Amplify can deploy.

---

## 2. Branches
- **`dev`** — Amplify source; **all this session's work is here**. Push here to deploy.
- `main` — default branch; carries the ADR + dev-deployment docs; reserved for future prod.
- `claude/sprint11` — old sprint working branch (superseded; its tree == main's app code).

---

## 3. What changed this session (in `fieldsight-ui`)

**Rebrand → FieldSightAI yellow**
- `--color-accent-*` ramp orange `#FF6B35` → brand yellow `#FFD966` (in `styles/tokens.css` + `scripts/tokens.js` + `scripts/fs-globals.js` — **keep these 3 in lockstep**).
- Sidebar navy → neutral-900 `#111827`; focus ring → amber `#FF8F00` (yellow ring invisible on white); ~20 alpha `rgba(255,107,53,…)` → `rgba(255,217,102,…)`.
- **All text on yellow uses fixed `--color-neutral-900`** (NOT `--text-primary`, which flips light in dark mode → light-on-yellow). Applies to primary buttons, accent badges, ask-chat, safety/quality buttons, etc.
- Wordmark in sidebar: `Field` + yellow `Sight` + `AI`; "F" mark with dark glyph. Semantic colours (safety=red, quality=blue, blocked=magenta vs overdue=red, status/category/chart/tag) **preserved**.

**UI bug fixes**
- Library **Test render**: right panel fills width (reset `.right-detail` centering in `app-shell.js`), preview default-expanded, **Full preview** modal fixed (`open=true` + `size:'lg'` + `.fs-modal__body` `flex:1;min-height:0` so it scrolls to bottom), body max-height 70vh.
- **Safety/Quality picked-date** persists across tab switches (localStorage `fs.settings.safetyView` / `fs.settings.qualityView`).
- Settings **tab-switch crash** fixed (tabs are now real components via `React.createElement`, not inline calls — avoids "rendered more hooks" error).
- `middle-column`/`right-detail` background swap; sidebar selection = solid yellow + dark text.

**Phase A — Account settings** (`scripts/pages/settings.js`, rewritten tabbed)
- Tabs: **Preferences** (theme/density/landing, original) · **Profile** (avatar + change picture, first/last name, email read-only, time & date format, timezone) · **Security** (password change modal + 2FA toggle — **mock**) · **Notifications** (frequency + 13 event checkboxes + my-involvement).
- Persists to `localStorage` (`fs.settings.profile`, `fs.settings.notifications`, `fs.settings.security`). `scripts/auth-mock.js` extended with `firstName/lastName/email/avatarUrl`, `updateProfile()`, and a startup loader so profile survives reload.
- User-menu "Profile" item → replaced with a "Settings" link.

**Phase B — Admin** (`scripts/api/sites.js`, `pages/sites.js`, `pages/team.js`)
- `scripts/api/sites.js`: mock `createSite` / `createUser` / `updateUserRole` (mutate in-memory fixtures; POST/PATCH when `useMocks=false`).
- `/sites` **"+ New project"** modal; `/team` **"+ Add member"** modal + editable **"Position"** select (assign role). Gated to admin / `user:manage` (use `?dev=1` → set role **Admin** to see them).

**Phase C — Images**
- **Project icon**: small square thumbnail on `SiteCard` (`composites/site-card.js`); upload in New Project modal; **change/remove** in the site detail panel (under the name) via provider `setSiteIcon`.
- **Member picture**: upload in Add Member modal; shown in `/team` list + detail.
- **Sidebar avatar** (`left-nav.js`) now renders `avatarUrl` → **syncs with Settings → Profile picture**.

**Buttons**: New project / Add member / Upload template / Add task (all `.fs-btn--primary`) = yellow + black; Safety "Raise Observation" + Quality "Log Item" unified to `#FFD966` + black + 13px.

---

## 4. Key files (fieldsight-ui)
- Theme tokens (lockstep): `styles/tokens.css`, `scripts/tokens.js`, `scripts/fs-globals.js`
- CSS: `styles/components.css`, `styles/composites.css`, `styles/app-shell.css`
- Pages: `scripts/pages/settings.js` (rewritten), `sites.js`, `team.js`, `safety.js`, `quality.js`, `library.js`
- Shell/nav: `scripts/app-shell.js`, `scripts/left-nav.js`
- Data/auth: `scripts/auth-mock.js`, `scripts/api/sites.js`, `scripts/mock/sites.fixture.js`
- Composites: `scripts/composites/site-card.js`, `scripts/composites/modal-overlay.js`, `scripts/components/avatar.js` (image via `src`, `shape:'square'`)
- Infra/docs: `amplify.yml`, `.gitignore`, `docs/dev-deployment.md`, this file

---

## 5. Conventions / gotchas (must-read before editing)
- **No build step.** In-browser React (Babel CDN). Modules are IIFEs attaching to `window.FieldSight` (components/pages) or `window.FS` (services). Pages register `window.FieldSight.PAGES['/route'] = { Middle, Right, Provider, layout }`.
- **Token lockstep:** edit `tokens.css` AND `tokens.js` AND `fs-globals.js` together. In components prefer CSS vars (`var(--…)`) over baked JS hex (`t.surface.x` is light-mode hex).
- **Yellow background → fixed dark text** (`--color-neutral-900`), never `--text-primary` (theme-flips).
- **Hooks:** render tab/sub-views via `React.createElement(Comp, props)`, never `Comp(ctx)` inline (hook-order crash).
- **Mock data:** `window.FieldSight.fixtures.*`; access via `window.FS.api.*` with `useMocks`. Mock create/update **mutates fixtures in memory → resets on reload**. `getSites`/`getUsers` return **copies** (`.slice()`) so optimistic adds don't duplicate.
- **Cache-busters:** bump `?v=N` in `app-shell-preview.html` for every changed loaded file.
- **Syntax check** before commit: `node --check scripts/path/file.js`. Real browser run-testing wasn't available this session (catches React runtime errors syntax-check can't).
- More traps in `fieldsight-ui/CLAUDE.md`.

---

## 6. Outstanding / TODO (priority order)
1. **Logo image** — drop the real PNG at `fieldsight-ui/assets/logo.png`; wire into `left-nav.js` (`logoMarkStyle` / the "F" mark) + login screen. Currently a yellow "F" box + "FieldSightAI" wordmark (no image file was ever provided — inline pastes aren't readable as files).
2. **Persistence** — created projects/members + uploaded images are **session-scoped**. Add `localStorage` persistence (merge stored items with fixtures on load) for a sticky demo.
3. **Phase 2 — real backend** — wire dev UI to a real API + Cognito (currently mock). Needs a **dev backend**: API Gateway + Cognito are **NOT in IaC** yet (see ADR). The UI already supports `?baseUrl=…&mocks=0` + `window.FS_COGNITO_CONFIG`.
4. **main → prod** — connect `main` in Amplify; cut over from the old `fieldsight-pipeline/frontend/` (`fieldsight_v5.jsx`) once parity is reached. **There are two frontends**: this prototype is the future one.
5. **Address autocomplete** (New project → location) — free options: **Photon** (Komoot/OSM, no key, typeahead) or **Nominatim** (OSM, rate-limited); **LINZ / NZ Post** for NZ-grade accuracy. Debounced fetch on the input. Not implemented.
6. **Dark-mode contrast polish** — a few "accent-as-text on white" spots (e.g. mobile bottom-nav active) are pale; run `?axe=1` (axe-core gate) to enumerate.
7. **Security** — `fieldsight-deployer` admin static key: disable/rotate or replace with OIDC.

---

## 7. Backend repo (`fieldsight-pipeline`) — NOT touched this session
- The transcription→AI pipeline (RealPTT → VAD → AWS Transcribe → Claude report gen). **Backend multi-env CI/CD already exists** (`.github/workflows/deploy.yml`: `develop`→test stack, `main`→prod, OIDC, `sam deploy`; `samconfig.toml` test/prod).
- Strategy decisions are in **`fieldsight-pipeline/docs/adr/0001-platform-architecture.md`** (the 5 questions: CI/CD multi-env, multi-industry prompts via `config/industries/{x}.json` overlay by site, stay-on-SAM IaC, data layer S3/DynamoDB/RDS + global Ask agent via Bedrock KB/pgvector RAG, transcription Transcribe-vs-WhisperX crossover ~500–1000 audio-h/mo). Read this first for backend/architecture work.

---

## 8. How to test on dev
- Open https://dev.d2fssznicvuckr.amplifyapp.com (Ctrl+Shift+R to bust cache).
- **Admin features:** append `?dev=1` → dev panel (bottom-right) → set role **Admin** → `/sites` shows "+ New project", `/team` shows "+ Add member" + editable Position.
- `?mocks=0&baseUrl=…` would point at a live backend (none wired yet).
