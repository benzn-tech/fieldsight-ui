# The profile shows one half of the user's authority

**Status:** backend fix is in review (pipeline PR #530). UI change not started.
**Reported:** 2026-08-17, from prod — a user promoted to site_manager still shows as
"worker" in their profile and across the UI.

---

## 1. It is not a failed promotion

Authority in this system has **two independent dimensions**:

| | stored in | who reads it |
|---|---|---|
| `global_role` | `users.global_role` — one value per person | `GET /api/org/me`, so the profile and the whole UI |
| per-site role | `memberships.role` — one row per site | the backend's read paths |

The backend's `visible_user_scope` treats the per-site role as a **floor over** the global
role. Its own docstring names this exact case: *"a global 'worker' with a pm membership →
SITE"*.

So someone made **site_manager on a site** genuinely gains that authority — the data they
can reach really does widen — while `/me` returned `global_role: "worker"` and never
mentioned the memberships. The UI rendered "worker" correctly, from the only thing it was
given.

`GET /members` has carried both dimensions all along (`org.js:306-308` documents the
`global_role` + `site_role` pair). That is why the admin Team page and the person's own
profile can disagree about the same person.

## 2. What the backend now returns

`GET /api/org/me` gains two fields (pipeline PR #530):

```
site_roles       { "<site_id>": "site_manager", ... }   the caller's non-archived memberships
effective_scope  "ALL" | "SITE" | "SELF+WORKERS" | "SELF" | null
```

`effective_scope` is **what the read paths actually apply** — global role and membership
floor already combined. `global_role` is unchanged and still returned.

**`effective_scope` is `null` when the backend's `GRADED_ROLES` is off.** In that mode the
membership floor is not applied to reads either, so a value there would be a claim the
backend does not honour. Treat `null` as "fall back to `global_role`", not as "no access".
Prod runs `GRADED_ROLES=true`.

## 3. The one line to change, and why it is not enough

`scripts/composites/login-screen.js:160`

```js
role: me.global_role,
```

That is the single point where the signed-in person's role enters the app. It flows
`FS.session.user.role` → `session-bridge.js` → `AuthMock.currentUser.role`, which a dozen
modules read directly (timeline, actions, sites…).

Changing it to a computed effective role fixes the display everywhere at once. But decide
the following two things first, because a wrong answer is worse than the current bug.

### 3.1 A person can hold different roles on different sites

`site_roles` is a map, not a value. Someone can be `site_manager` on Halswell and `worker`
on UCPK2, and both are true. Picking one and showing it as *the* role will be wrong on the
other site.

Options, in the order I would consider them:

* **Show the highest authority they hold anywhere** in the global profile/avatar, and the
  **site-specific** role on any site-scoped page (the site context already exists —
  `site-context.js`). Accurate in both places.
* Show `global_role` in the profile and the effective role only where it matters. Honest,
  but leaves the original complaint standing.
* Show a single computed role everywhere. Simplest, and wrong for multi-site people.

### 3.2 Gate on `effective_scope`, not on a role string

`roles.js` maps **role name → capability**. `effective_scope` is a different vocabulary
(`ALL` / `SITE` / `SELF+WORKERS` / `SELF`) and it is the one the backend enforces. Where
the UI decides *what data to request or show*, comparing against `effective_scope` matches
what the server will actually return; comparing against a role name reproduces the same
class of drift this bug is.

Rough correspondence, for orientation only — do not hard-code it as a role mapping:

| `effective_scope` | means |
|---|---|
| `ALL` | no per-author filter (admin / gm / platform_admin) |
| `SITE` | every author on an in-scope site (pm, regional_manager) |
| `SELF+WORKERS` | own plus worker-role members on the caller's sites (site_manager) |
| `SELF` | own only (worker) |

Where the UI decides *what the person is called*, that is a labelling question and
`roles.js` is still the right vocabulary.

## 4. Do not "fix" this by promoting the global role

The tempting shortcut is to set `users.global_role = 'site_manager'` for the affected user
and move on. It is **not equivalent**: `global_role` is global, so it grants SELF+WORKERS
on **every** site that person belongs to — wider than the per-site promotion someone
deliberately made. It would also hide the bug for exactly one user while leaving it for
everyone else.

## 5. Verification

The account that prompted this is `Ben_UCPK2` on prod.

1. As an admin, open the Team page and find that person. Note **both** `global_role` and
   the per-site role — `GET /members` returns both, so this tells you which dimension the
   promotion was made in.
2. Sign in as them (or use the dev role switcher against a real `/me` — `?dev=1`, and check
   `FS_TIMELINE_SOURCE=aurora` / a non-empty `orgBaseUrl`, or you are looking at fixtures).
3. `GET /api/org/me` should now carry `site_roles` and `effective_scope`.
4. The profile shows the promoted role, and the data the person can reach is unchanged —
   this is a display fix, not a permissions change. **If reachable data changes, something
   is wrong**: the backend's authority was already correct, and the UI must not start
   requesting more than it did.

## 6. Out of scope

* Changing anyone's actual permissions. The backend's grading is correct as it stands.
* The admin flow for promoting someone. `PATCH /members/{sub}/role` sets `global_role`;
  per-site promotion is a membership edit. Whether the admin UI makes that distinction
  clear is a separate question worth asking, but it is not this fix.
