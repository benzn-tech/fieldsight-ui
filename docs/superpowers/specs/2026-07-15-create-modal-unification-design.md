# Create-Modal Unification — Safety "Raise Observation" + Quality "Log Item" (v1, UI-only)

Date: 2026-07-15
Status: approved (user), pending implementation
Repo: fieldsight-ui (no-build browser React — see CLAUDE.md conventions)

## 1. Problem + decisions

The Safety and Quality create modals differ too much (different field sets,
hand-rolled form shells) and leak Chinese browser chrome: Quality's Deadline
is a native `<input type="date">` (OS calendar renders in the browser's
Chinese locale) and Safety's Photos is a native `<input type="file">`
("Choose File / No file chosen" rendered by the browser in Chinese). The
app's own strings are all English — a repo-wide CJK grep found only
developer comments.

Decisions locked with the user (2026-07-15):

- **"CFT" = the Safety-side create modal** (Raise Observation).
- **v1 is UI-only.** No pipeline-repo changes, no migrations, no photo
  upload endpoint. New fields are sent in the payload; the backend ignores
  unknown fields today, so Phase 2 persistence needs zero frontend change.
- **Strict field parity.** Both kinds show exactly Title / Description /
  Assignee / Date / Priority / Photos. Domain-specific fields are removed:
  Safety's Recommended action + Location, Quality's Category + Follow-up
  required + Location. (Quality's extras were never sent to the backend;
  Safety's `recommended_action` column simply stays empty going forward.)
- **Single component**, not two aligned copies: both modals already call
  the SAME endpoint (`FS.api.org.createObservation` → `POST /observations`)
  distinguished only by the `kind` field, so the merge is natural.

## 2. Components + files

| Action | File | Notes |
|---|---|---|
| NEW | `scripts/composites/create-observation-modal.js` | `CreateObservationModal({ kind, siteId, onSuccess, onCancel })` → `window.FieldSight.CreateObservationModal`. `kind: 'safety'` → title "Raise Observation"; `kind: 'quality'` → title "Log Item". Everything else identical. |
| NEW | `scripts/composites/date-field.js` | `DateField` — form-level English date control (see §4). NOT the existing `DatePicker` (that is the Timeline heat-map navigator: fetches `/api/dates`, density dots — wrong semantics for a form). |
| DELETE | `scripts/composites/safety-create-modal.js` | Dead `presignedPut` block dies with it. |
| DELETE | `scripts/composites/quality-create-modal.js` | |
| EDIT | `scripts/pages/safety.js` (~:517) | Mount `CreateObservationModal` with `kind: 'safety'`; other props unchanged (`siteId`, `onSuccess`, `onCancel`). |
| EDIT | `scripts/pages/quality.js` (~:480) | Same with `kind: 'quality'`. |
| EDIT | `components-preview.html` | Replace the two ModalTrigger entries (~:1285-1286) with the unified component (one trigger per kind), fix the destructure list (~:145), swap script tags, bump `?v=N`. |
| EDIT | `app-shell-preview.html` | Swap script tags (two old files → two new files), bump `?v=N` on every changed file. |
| EDIT | `styles/composites.css` | Merge `.fs-safety-create-modal` + `.fs-quality-create-modal` blocks into `.fs-create-observation-modal`; add `.fs-date-field` styles. |

The photo picker is INLINE in the modal (hidden native file input driven by
a visible English button — §5), not a separate composite: single consumer
today, YAGNI.

## 3. Field set (identical for both kinds)

| Field | Control | Validation / default | Payload key |
|---|---|---|---|
| Title | `FieldSight.Input` | required | `title` (ignored by backend today) |
| Description | `FieldSight.Textarea` | required | `observation` (backend-required, persisted) |
| Assignee | `FieldSight.Select`, options from `FS.api.org.getMembers()` | optional, default "Unassigned" (empty value). Fetch on open; on failure keep only Unassigned, `console.error`, non-blocking (mirrors existing getSites failure handling) | `assignee` = member `sub` (fallback `folder_name`), label = display name (ignored today) |
| Date | `DateField` | optional, empty default | `due_date` = 'YYYY-MM-DD' (ignored today) |
| Priority | `FieldSight.Select` Low / Medium / High | default Medium; values `low`/`medium`/`high` | `priority` (ignored today) + `risk_level` (see §6) |
| Photos | English custom button + hidden `<input type="file" multiple accept="image/*">` | optional, max 5, count display "N photo(s) selected"; v1 selection-only, nothing uploaded (no presign endpoint exists) | not sent |

All form fields use the shared L4 primitives (`scripts/components/input.js`
Input/Textarea/Select — label/required/hint/error shell). No hand-rolled
label rows (that is today's asymmetry bug).

**Project anchoring is preserved unchanged** from the current modals:
`siteId` from page context when anchored; otherwise an in-modal required
Project select fed by getSites; admin path falls back to
`fixtures.sites.sites[0].site_id` (known trap — CLAUDE.md "Admin permission
flow"). The Project select is plumbing, not part of the six-field parity
set.

## 4. DateField (new composite)

- Props: `{ value /* 'YYYY-MM-DD'|'' */, onChange(iso), label, required, hint, error, disabled }` — same shell contract as the L4 primitives so it drops into the form column.
- Closed state: a 48px-target button styled like an input, showing `15 Jul 2026` (English, formatted from the ISO string) or an English placeholder ("Select date"); a clear (×) affordance when set and not required.
- Open state: lightweight month-grid popover — English Mon–Sun header, month title ("July 2026"), prev/next month chevrons. Click a day → `onChange(iso)` + close.
- Close on outside click and Escape. Position below the field; flip above when clipped by the modal edge.
- Date math is pure UTC arithmetic (BUG-19): never `new Date('YYYY-MM-DD')` for display math; borrow the DAY_NAMES/MONTH_NAMES + UTC approach from `date-picker.js` internals (copy the pattern; do NOT import that component or its MonthGrid — it is internal and heat-map-coupled).
- No data fetching. No density glyphs.
- Reduced motion: any open/close transition gets the `prefers-reduced-motion` override.
- A11y: button has `aria-haspopup="dialog"` + `aria-expanded`; grid cells are buttons with full-date `aria-label`s.

## 5. Photos control (inline)

- Visible: secondary Button "Choose photos" + count text "N photo(s) selected" (existing English string) + per-file remove.
- Hidden native input (`display:none` / visually-hidden) triggered by the button — the browser-locale "Choose File / No file chosen" chrome never renders.
- Max 5 enforced on selection (excess trimmed + inline hint), images only.
- v1 does NOT upload: no presign call (the old dead `FS.api.media.presignedPut` block is deleted, not carried over). Small hint under the control: "Photos are kept with this draft only — upload coming soon." (English, honest about v1.)

## 6. Submit payload + error handling

One call for both kinds:

```js
FS.api.org.createObservation({
  kind,                        // 'safety' | 'quality'
  site_slug: siteValue,
  observation: description,    // persisted
  risk_level: priority,        // safety: persisted (today's behavior);
                               // quality: SEND ONLY IF backend accepts it — see check below
  title, assignee, due_date, priority,  // forward-compatible; ignored today
})
```

- **Implementation check (pipeline repo, read-only):** inspect the
  `POST /observations` handler (`lambda_org_api.py`) — if `risk_level` is
  accepted for `kind='quality'` rows (thin pass-through, no kind-conditional
  validation), send it for both kinds so priority actually persists for
  free; if it's rejected/validated per-kind, quality omits `risk_level` and
  only sends `priority`.
- Keep the envelope-style error handling exactly as today (Fable batch-B
  F3): 401/403/404 resolve as envelopes, not rejections — check
  `obsRes && obsRes.error` before treating it as success; on failure show
  `ErrorBanner`, stay open, status back to 'idle'.
- Submit CTA disabled while `status === 'submitting'`.
- Required-field gate: Title + Description non-empty (trimmed), plus
  Project when the in-modal select is shown. Inline field errors via the
  primitives' error prop; no browser-native validation bubbles.

## 7. Mock path + page contract

- `isLive = !FS.api.useMocks`; `orgAvailable = org.createObservation && isLive` — gating logic copied unchanged.
- Mock path builds a per-kind local row (same shapes the pages consume today, minus removed fields, plus the new ones: title/assignee/due_date/priority) and calls `onSuccess(row)` after the existing simulated delay. Neither page's list rendering may break: verify safety.js / quality.js row consumers reference no removed field of the CREATED row (list rows from getObservations are unaffected).
- Page changes are mechanical: component name + `kind` prop. `ctx.setShowCreate` conditional-mount pattern unchanged; `ModalOverlay` must be called with `open: true` (the exact bug fixed in Phase 1 T5 — do not regress).

## 8. Out of scope (Phase 2 backend follow-up, planned separately)

- Persisting title/assignee/due_date/priority (migration + handler fields).
- Photo upload: presign endpoint + `photo_keys` storage.
- Any change to list pages' columns to display the new fields.

## 9. Verification

- `node --check` every touched JS file.
- Grep pre-checks: no remaining references to `SafetyCreateModal` /
  `QualityCreateModal` anywhere (`scripts/`, both preview HTMLs); no
  `type="date"` in the new modal; no `presignedPut` anywhere.
- Manual browser checklist (state explicitly what was verified vs deferred
  to the user, per repo convention):
  1. `?dev=1&mocks=1` and `?mocks=0` — open both modals from "+ Raise
     Observation" (safety) and "+ Log Item" (quality); identical field
     sets, only the title differs.
  2. DateField opens English month grid; pick/clear a date; Escape +
     outside-click close; no native date control anywhere.
  3. Photos: "Choose photos" opens the OS file dialog; count updates;
     max-5 enforced; no "Choose File / No file chosen" browser chrome.
  4. With a Chinese-locale browser profile: no Chinese text anywhere in
     either modal.
  5. `?mocks=0` live submit on the dev site: new row appears in the list;
     Description lands as `observation`; safety Priority lands as
     `risk_level`.
  6. Expired-session/403 shows ErrorBanner, no false success.
  7. components-preview.html: both triggers render the unified modal.
  8. Dark mode + reduced-motion spot check on DateField popover.
