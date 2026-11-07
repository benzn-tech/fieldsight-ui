# Settings as a window over the page

**Status:** design, 2026-11-07. Frontend only.
**Requested by:** the owner: Settings should open as a pop-up like Claude's, so looking at a setting does
not cost the page you were on. "Preferences" becomes "Appearance", matching Claude.

## What changes

Pressing Settings opens a centred window over the current page. Closing it returns to the same page, same
scroll position, same selected topic. Left: section list. Right: the section.

Sections:

| Section | Holds | Note |
|---|---|---|
| Appearance | Theme, display density | Was Preferences |
| Profile | Picture, name, read-only identity, time and date format, time zone, **default landing page** | Landing moves here: it is not appearance, and it sits with the other personal defaults. It keeps saving at once, as today |
| Security | Password, Sign in to a recorder | As shipped in PR 463 |
| Notifications | As today | |
| Glossary | As today, same role gate | |

No new settings. No change to what any setting does or where it is stored.

## Behaviour

- **Open:** the Settings nav item and the account menu's Settings both call `window.FS.settings.open(tab?)`.
  Neither changes the route, and the nav item never shows as the active page.
- **Close:** X, Esc, or the backdrop.
- **Unsaved Profile edits survive closing.** Backdrop is a stray-click risk, and Profile and Notifications have
  explicit Save buttons. The provider stays mounted after first open, so reopening shows the edits in progress.
  Reload discards them, as today. The provider is not mounted before first open, so `getMe` is not called at boot.
- **Password and QR replace the Security list in place** inside the window, with a Back control. Not nested
  modals: two `ModalOverlay`s both listen for Esc on `window`, and `stopPropagation` there does not stop the
  other listener, so Esc would close both.
- **Old links:** `#/settings` still works. The route stays registered; its page opens the window and replaces the
  hash with the person's landing page, using `replaceState` semantics so Back does not loop. Nothing else in the
  app links to it today apart from the two nav entries changed here.
- **Small screens:** the section list becomes a horizontal strip on top. Desktop is the target; this keeps it usable.
- **Focus and keyboard:** from `ModalOverlay`: focus moves in, is trapped, returns to the trigger on close.

## How it is built

- `scripts/pages/settings.js`:
  - Tab key `preferences` becomes `appearance`; `PreferencesTab` becomes `AppearanceTab`, without the landing section.
  - `SettingsWindow`: `ModalOverlay` size `lg`, title "Settings", holding the two-column layout and the existing tab bodies.
  - `SettingsHost`: mounted once by `AppShell`. Holds `open`, `tab`, and a latch for first open. Registers
    `window.FS.settings = { open, close }` in an effect and removes it on unmount.
  - `/settings` page entry: a `Middle` that calls `open()` on mount and redirects. `layout: 'full-width'` stays.
- `scripts/app-shell.js`: mount `SettingsHost` once, null-guarded like its other optional composites.
- `scripts/left-nav.js`: both entries call `window.FS.settings.open()`; if absent they fall back to the route.
- `styles/composites.css`: `.fs-settings-window` two-column layout with existing tokens. Body scrolls, header fixed.
  Width from `.fs-modal--lg`; height `min(640px, 100vh - 64px)`, stable across sections so the window does not jump.

## Corrections from review (these win over anything above)

- `/settings` is removed from the landing choices, and a stored `/settings` reads as no choice. It would redirect to itself.
- `Router.replace` is added: `navigate` pushes history, and `replaceState` fires no `hashchange`, so it must notify.
- `SettingsHost` handles the old route by watching `route`. The page cannot call it: on a cold load the page's
  effect can run before the host's registration. The page entry renders nothing and has no Provider.
- Single-key shortcuts and Cmd+K/B do nothing while the window is open.
- `open()` applies `canSeeNav('settings')`, which the route guard used to do, and closes onboarding.
- State stays in the Provider but the overlay unmounts, since a closed `.fs-modal` keeps its buttons in the tab order.
- Landing renders below Profile's Save/Reset with "Saved automatically". "Reset onboarding" goes with it.
- `#/settings?tab=` is not supported. Focus returns to the page, not the account menu item, which has gone.

## Non-goals

Moving settings to the server. New settings. Two-factor. Redesigning the sections' contents.

## Failure that would make this wrong even if it works

- Closing Settings loses the page, selection or scroll position.
- Esc closes more than the top layer.
- Opening Settings re-mounts the page underneath.
- An edit in progress vanishes on a stray click outside.

## Testing

Source-scan pins plus pure rule tests: `appearance` replaces `preferences`; no route change on open; no nested
`ModalOverlay` in `SecurityTab`; landing is rendered by Profile and not by Appearance. Real browser, mounted in
the page: open, switch sections, Esc, reopen with edits retained, Security sub-view Esc behaviour, `#/settings`
redirect leaves no Back loop.
