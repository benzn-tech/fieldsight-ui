# Phase 3 UI 接线 · 批次2a:基础层(配置 + 数据层 + 登录身份) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 fieldsight-ui 加上通往真实 org 后端的双基址通道 —— env 双基址 + `FS_ORGWRITES` 开关、`_fetch` 的 `orgRequest`、完整的 `api/org.js` 数据层、登录时从 `GET /api/org/me` 拉真实身份。

**Architecture:** 新增第二个基址 `orgBaseUrl`(指 test org 网关)与 `orgWrites` 开关注入 `window.FS.api`;`_fetch.js` 的 `rawRequest` 支持 `opts.baseUrl` 覆盖,新增 `orgRequest` 复用同一套认证(裸 idToken)但走 org 网关(跨源,自动不带 X-Request-Id);新建 `api/org.js` 薄封装所有 org 端点,读 gate on `!useMocks && orgBaseUrl非空`(kill switch),写 gate on `&& orgWrites`,并在 `getMembers` 上从 name 派生 `folder_name`;登录 `hydrateUser` 改用 `org.getMe()`。批次 2b(页面)/2c(上传+归档 UI)在此基础上接线。

**Tech Stack:** 无构建步骤的浏览器内 React 原型(`React.createElement`,IIFE 挂 `window.FS`/`window.FieldSight`);**无测试框架**——验证靠 `node --check <file>` 语法检查 + 部署后 Chrome 全流程。

**Spec:** `fieldsight-pipeline/docs/superpowers/specs/2026-07-04-phase-3-completion-org-datamodel-ui.md` §5+§8b。

**后端已上线**:org 网关 `https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/prod/api`,dual-pool authorizer 收 prod 池 `q88pd6XXr` 的裸 idToken;端点 `/api/org/{me,sites,sites/{id},sites/{id}/archive|unarchive,members,members/{sub}/role,members/{sub}/archive|unarchive,upload-url,asset-url}`。

## Global Constraints

- 仓库 fieldsight-ui,分支 **dev**;**无构建/无测试/无 linter**(CLAUDE.md);JS 是 ES2017+;每个改动 `node --check`;改到被加载的 `.js` 就 bump 其 `?v=N`(app-shell-preview.html)。
- **tokens-only**、BEM、`React.createElement`——沿用现有约定;不引入 npm/build。
- Windows autocrlf:单行 Edit anchor;**绝不** `git add -A`,只 add 明确路径。
- `window.FS.api` 由 `api/index.js` 整体赋值(`window.FS.api = {...}`),之后的 `api/*` 模块**合并**(`window.FS.api.X = ...`)——`api/org.js` 必须在 `api/index.js`、`_fetch.js` **之后**加载。
- **门控铁律**(spec §5.2 + §8b):org 读 = `!useMocks && orgBaseUrl 非空`(`orgBaseUrl` 空 = kill switch,整体回 mock);org 写 = 读条件 `&& orgWrites`。**不碰** `writeMocks`(programme/safety-create 等仍用它)。
- **裸 idToken**:org 请求复用现有认证(`session.ensureFresh()` 的 idToken,无 Bearer);org 网关跨源,X-Request-Id 同源守卫自动排除(`base.charAt(0)==='/'` 为假)。
- **登录身份≠报告身份**(§5.4):本批只做身份/数据层;admin 聚合 fan-out(批次 2b)用 prod `/api/users` 不是 org members——本批不碰聚合。
- 提交:conventional(`feat(ui-2a):`),每个绿色 `node --check` 循环一提交。

---

### Task 1: env.js 双基址生成(amplify.yml + env.example.js)

**Files:**
- Modify: `amplify.yml`
- Modify: `scripts/env.example.js`

**Interfaces:**
- Produces:部署时生成的 `window.FS_ENV` 多两字段 `orgBaseUrl`(默认空串)、`orgWrites`(默认 false);`env.example.js` 模板同步(本地开发参考)。后续 Task 2 从 `FS_ENV` 读这两字段。

- [ ] **Step 1: 改 amplify.yml 的 env.js 生成**

`amplify.yml` 的 printf 那步(第 10-13 行),把:

```yaml
        - >-
          printf 'window.FS_ENV = { baseUrl: "%s", useMocks: %s, writeMocks: %s };\n'
          "${FS_BASEURL:-/api}" "${FS_USEMOCKS:-true}" "${FS_WRITEMOCKS:-true}"
          > dist/env.js
```

替换为:

```yaml
        - >-
          printf 'window.FS_ENV = { baseUrl: "%s", useMocks: %s, writeMocks: %s, orgBaseUrl: "%s", orgWrites: %s };\n'
          "${FS_BASEURL:-/api}" "${FS_USEMOCKS:-true}" "${FS_WRITEMOCKS:-true}" "${FS_ORG_BASEURL:-}" "${FS_ORGWRITES:-false}"
          > dist/env.js
```

(新增 `orgBaseUrl` 默认空串 = kill switch 关闭 = org 回 mock;`orgWrites` 默认 false。真实值由 Amplify dev 分支的环境变量 `FS_ORG_BASEURL` / `FS_ORGWRITES` 注入——见 Task 6 部署说明。)

- [ ] **Step 2: 改 env.example.js 模板**

`scripts/env.example.js` 第 9-13 行,把:

```javascript
window.FS_ENV = {
  baseUrl: 'https://khfj3p1fkb.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  useMocks: false,   // reads go to the real API
  writeMocks: true,  // backend-less writes stay mocked (Phase 3 flips this)
};
```

替换为:

```javascript
window.FS_ENV = {
  baseUrl: 'https://khfj3p1fkb.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  useMocks: false,   // reads go to the real API
  writeMocks: true,  // non-org backend-less writes stay mocked
  orgBaseUrl: 'https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/prod/api',  // org backend (empty '' = kill switch → org回mock)
  orgWrites: true,   // org-domain writes go live (batch 2)
};
```

- [ ] **Step 3: 语法/格式检查**

Run: `node --check scripts/env.example.js`
Expected: 无输出(通过)。amplify.yml 是 YAML 不用 node check;肉眼确认缩进为 2 空格、`>-` 折叠标量对齐(和原样一致)。

- [ ] **Step 4: 提交**

```bash
git add amplify.yml scripts/env.example.js
git commit -m "feat(ui-2a): env.js dual base url (FS_ORG_BASEURL) + FS_ORGWRITES"
```

---

### Task 2: api/index.js — orgBaseUrl + orgWrites 注入 FS.api

**Files:**
- Modify: `scripts/api/index.js`
- Modify: `app-shell-preview.html`(bump `api/index.js` 的 `?v=`)

**Interfaces:**
- Consumes: Task 1 的 `window.FS_ENV.orgBaseUrl` / `.orgWrites`。
- Produces: `window.FS.api.orgBaseUrl`(string,默认 `''`)、`window.FS.api.orgWrites`(bool,默认 false)。Task 3/4 消费。

- [ ] **Step 1: 加两字段**

`scripts/api/index.js` 第 83 行 `baseUrl: env.baseUrl || '/api',` 之后插入两行:

```javascript
    baseUrl: env.baseUrl || '/api',
    /* Second base URL for the org backend (test gateway). Empty '' = kill
       switch: org reads/writes fall back to mocks. See api/org.js. */
    orgBaseUrl: env.orgBaseUrl || '',
    orgWrites: env.orgWrites !== undefined ? !!env.orgWrites : false,
```

- [ ] **Step 2: bump cache-buster**

`app-shell-preview.html` 第 158 行 `<script src="scripts/api/index.js?v=3"></script>` → `?v=4`。

- [ ] **Step 3: 语法检查**

Run: `node --check scripts/api/index.js`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add scripts/api/index.js app-shell-preview.html
git commit -m "feat(ui-2a): FS.api.orgBaseUrl + orgWrites from env"
```

---

### Task 3: _fetch.js — opts.baseUrl 覆盖 + orgRequest

**Files:**
- Modify: `scripts/api/_fetch.js`
- Modify: `app-shell-preview.html`(bump `_fetch.js` 的 `?v=`)

**Interfaces:**
- Consumes: Task 2 的 `window.FS.api.orgBaseUrl`;现有 `request`/`rawRequest`/`setBaseUrl`。
- Produces: `window.FS.api.orgRequest(path, opts)` —— 与 `request` 同款(401 重试 / `_notFound` / `_accessDenied` / isJson 守卫)但走 `orgBaseUrl`。跨源自动不带 X-Request-Id。Task 4 消费。

- [ ] **Step 1: 先确认 request 转发 opts 到 rawRequest**

Read `scripts/api/_fetch.js` 第 183-220 行(`request` 函数)。确认它以 `rawRequest(path, opts)` 形式把**同一个 opts** 传给 rawRequest(重试时也是)。若它重建了 opts(丢字段),Step 3 需相应保证 `baseUrl` 透传。**这一步只读不改。**

- [ ] **Step 2: rawRequest 支持 opts.baseUrl**

第 139 行:

```javascript
    var base = (window.FS && window.FS.api && window.FS.api.baseUrl) || '/api';
```

替换为:

```javascript
    var base = opts.baseUrl || (window.FS && window.FS.api && window.FS.api.baseUrl) || '/api';
```

(X-Request-Id 守卫 `base.charAt(0) === '/'` 不变——org 的绝对 URL 天然不满足,自动不带该头。)

- [ ] **Step 3: 加 orgRequest + 导出**

第 225-229 行的 `setBaseUrl` 函数之后、导出块之前,加:

```javascript
  /* Org backend channel: same request() machinery (auth, retries, error
     envelopes) but routed at FS.api.orgBaseUrl (a cross-origin absolute URL,
     so the X-Request-Id same-origin guard omits that header automatically).
     Callers in api/org.js only invoke this when orgBaseUrl is non-empty. */
  function orgRequest(path, opts) {
    opts = Object.assign({}, opts);
    opts.baseUrl = (window.FS && window.FS.api && window.FS.api.orgBaseUrl) || '';
    return request(path, opts);
  }
```

在导出块(第 233-234 行 `window.FS.api.request = request;` / `window.FS.api.setBaseUrl = setBaseUrl;`)后加:

```javascript
  window.FS.api.orgRequest = orgRequest;
```

- [ ] **Step 4: bump cache-buster + 语法检查**

`app-shell-preview.html` 第 159 行 `_fetch.js?v=4` → `?v=5`。
Run: `node --check scripts/api/_fetch.js`
Expected: 无输出。

- [ ] **Step 5: 提交**

```bash
git add scripts/api/_fetch.js app-shell-preview.html
git commit -m "feat(ui-2a): _fetch orgRequest via opts.baseUrl override"
```

---

### Task 4: api/org.js — org 数据层(全部端点 + folder_name + 门控)

**Files:**
- Create: `scripts/api/org.js`
- Modify: `app-shell-preview.html`(加 `<script src="scripts/api/org.js?v=1">`)

**Interfaces:**
- Consumes: Task 3 的 `window.FS.api.orgRequest`;`window.FS.api.{useMocks,orgBaseUrl,orgWrites,delay}`;`window.FieldSight.fixtures.sites`(mock 数据源);`window.AuthMock.currentUser`(mock getMe)。
- Produces: `window.FS.api.org` = `{ getMe, getOrgSites, createOrgSite, updateOrgSite, archiveSite, unarchiveSite, getMembers, createMember, updateMemberRole, archiveMember, unarchiveMember, uploadUrl, assetUrl }`。批次 2b/2c 消费。契约:
  - `getMe()` → `{cognito_sub, email, global_role, first_name, last_name, site_ids, scope, archived_at}`(live)或 mock 派生;403 时返回 request 的 `{_accessDenied:true}` 信封。
  - `getOrgSites({includeArchived})` → `{sites:[...]}`。
  - `createOrgSite(body)` / `updateOrgSite(id, patch)` → site 行。
  - `archiveSite(id)` / `unarchiveSite(id)` → site 行。
  - `getMembers({includeArchived})` → `{members:[...]}`,每个 member **含派生 `folder_name`**。
  - `createMember(body)` → `{user, memberships}`。
  - `updateMemberRole(sub, role)` → user 行。
  - `archiveMember(sub)` / `unarchiveMember(sub)` → user 行。
  - `uploadUrl(kind, contentType)` → `{url, key}`(pending key)。
  - `assetUrl(key)` → `{url}`。

- [ ] **Step 1: 建 api/org.js**

新建 `scripts/api/org.js`:

```javascript
/* ==========================================================================
   api/org.js — org backend data layer (Phase 3 batch 2).
   --------------------------------------------------------------------------
   Second base URL (FS.api.orgBaseUrl) for the org API: sites/members/roles/
   profile/images live in Aurora, reached via FS.api.orgRequest. Must load
   AFTER api/index.js and _fetch.js (which define orgBaseUrl + orgRequest).

   Gating (spec §5.2 / §8b):
     org LIVE  = !useMocks && orgBaseUrl non-empty  (empty = kill switch)
     org WRITE = org LIVE && orgWrites              (does NOT touch writeMocks)
   Mocked fallbacks keep the no-backend prototype working.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  var api = window.FS.api;

  function orgLive()  { return !api.useMocks && !!api.orgBaseUrl; }
  function orgWrite() { return orgLive() && !!api.orgWrites; }
  function fx()       { return (window.FieldSight && window.FieldSight.fixtures
                                && window.FieldSight.fixtures.sites) || {}; }

  /* folder_name bridges org identity → report-data folders (report S3 paths
     use display name with spaces→underscores, e.g. "Jarley_Trainor"). */
  function folderName(m) {
    if (m.folder_name) return m.folder_name;
    return [m.first_name, m.last_name].filter(Boolean).join('_');
  }

  // -------- profile --------
  async function getMe() {
    if (orgLive()) return api.orgRequest('/me');
    await api.delay();
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    var parts = (u.name || 'Jarley Trainor').split(' ');
    return {
      cognito_sub: 'mock-sub', email: u.email || 'mock@example.com',
      global_role: u.role || 'site_manager',
      first_name: parts[0] || '', last_name: parts.slice(1).join(' '),
      site_ids: [], scope: 'MEMBERSHIPS', archived_at: null,
    };
  }

  // -------- sites --------
  async function getOrgSites(opts) {
    opts = opts || {};
    if (orgLive()) {
      return api.orgRequest('/sites', opts.includeArchived ? { params: { include_archived: '1' } } : undefined);
    }
    await api.delay();
    return { sites: (fx().sites || []).slice() };
  }

  async function createOrgSite(body) {
    if (orgWrite()) return api.orgRequest('/sites', { method: 'POST', body: body });
    await api.delay(400);
    var site = { id: 'mock-' + Date.now().toString(36), name: body.name,
                 location: body.location || '', client: body.client || '',
                 icon_s3_key: body.icon_s3_key || null, archived_at: null };
    var f = fx(); if (f.sites) f.sites.unshift(site);
    return site;
  }

  async function updateOrgSite(id, patch) {
    if (orgWrite()) return api.orgRequest('/sites/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    await api.delay();
    return Object.assign({ id: id }, patch);
  }

  async function archiveSite(id)   { return _siteArchive(id, 'archive'); }
  async function unarchiveSite(id) { return _siteArchive(id, 'unarchive'); }
  async function _siteArchive(id, action) {
    if (orgWrite()) return api.orgRequest('/sites/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    await api.delay();
    return { id: id, archived_at: action === 'archive' ? new Date().toISOString() : null };
  }

  // -------- members --------
  async function getMembers(opts) {
    opts = opts || {};
    var res;
    if (orgLive()) {
      res = await api.orgRequest('/members', opts.includeArchived ? { params: { include_archived: '1' } } : undefined);
    } else {
      await api.delay();
      res = { members: (fx().users || []).slice() };
    }
    (res.members || []).forEach(function (m) { m.folder_name = folderName(m); });
    return res;
  }

  async function createMember(body) {
    if (orgWrite()) return api.orgRequest('/members', { method: 'POST', body: body });
    await api.delay(400);
    return { user: { cognito_sub: 'mock-' + Date.now().toString(36), email: body.email,
                     global_role: body.global_role || 'worker' }, memberships: body.memberships || [] };
  }

  async function updateMemberRole(sub, role) {
    if (orgWrite()) return api.orgRequest('/members/' + encodeURIComponent(sub) + '/role', { method: 'PATCH', body: { global_role: role } });
    await api.delay();
    return { cognito_sub: sub, global_role: role };
  }

  async function archiveMember(sub)   { return _memberArchive(sub, 'archive'); }
  async function unarchiveMember(sub) { return _memberArchive(sub, 'unarchive'); }
  async function _memberArchive(sub, action) {
    if (orgWrite()) return api.orgRequest('/members/' + encodeURIComponent(sub) + '/' + action, { method: 'POST' });
    await api.delay();
    return { cognito_sub: sub, archived_at: action === 'archive' ? new Date().toISOString() : null };
  }

  // -------- assets (presign) --------
  async function uploadUrl(kind, contentType) {
    if (orgWrite()) return api.orgRequest('/upload-url', { method: 'POST', body: { kind: kind, content_type: contentType } });
    await api.delay();
    return { url: null, key: null };   // mock: caller falls back to data-URI preview
  }

  async function assetUrl(key) {
    if (orgLive()) return api.orgRequest('/asset-url', { params: { key: key } });
    await api.delay();
    return { url: null };
  }

  window.FS.api.org = {
    getMe: getMe,
    getOrgSites: getOrgSites, createOrgSite: createOrgSite, updateOrgSite: updateOrgSite,
    archiveSite: archiveSite, unarchiveSite: unarchiveSite,
    getMembers: getMembers, createMember: createMember, updateMemberRole: updateMemberRole,
    archiveMember: archiveMember, unarchiveMember: unarchiveMember,
    uploadUrl: uploadUrl, assetUrl: assetUrl,
    _folderName: folderName,   /* exported for batch-2b fan-out reuse */
  };
})();
```

- [ ] **Step 2: 加载 org.js(在 sites.js 之后)**

`app-shell-preview.html` 第 174 行 `<script src="scripts/api/sites.js?v=4"></script>` 之后加一行:

```html
  <script src="scripts/api/org.js?v=1"></script>
```

- [ ] **Step 3: 语法检查**

Run: `node --check scripts/api/org.js`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add scripts/api/org.js app-shell-preview.html
git commit -m "feat(ui-2a): api/org.js data layer (all org endpoints, folder_name, gating)"
```

---

### Task 5: 登录 hydrateUser → org.getMe()

**Files:**
- Modify: `scripts/composites/login-screen.js`
- Modify: `app-shell-preview.html`(bump login-screen.js 的 `?v=`,若有)

**Interfaces:**
- Consumes: Task 4 的 `window.FS.api.org.getMe()`;`window.FS.session.set`。
- Produces: 登录后 `FS.session.user` 带 `{sub, email, role, display_name, sites}`(真实来自 /me);403(未 provision / 已归档)不白屏,降级为只读 + 告警。

- [ ] **Step 1: 改 hydrateUser**

`scripts/composites/login-screen.js` 第 58-72 行,把:

```javascript
    /* After tokens are set, hydrate the user payload via /api/sites
       (BACKEND-CONTEXT §4.2 — returns role + display_name). */
    async function hydrateUser() {
      try {
        var res = await window.FS.api.sites.getSites();
        window.FS.session.set({
          user: {
            role:         res.role,
            display_name: res.display_name,
          },
        });
      } catch (err) {
        console.warn('[login] could not load /api/sites for user payload', err);
      }
    }
```

替换为:

```javascript
    /* After tokens are set, hydrate the real identity via GET /api/org/me
       (sub/email/role/name/site_ids). A 403 means the account isn't in the
       org DB yet or is archived — stay signed in but read-only, don't blank. */
    async function hydrateUser() {
      try {
        var me = await window.FS.api.org.getMe();
        if (me && (me._accessDenied || me._notFound)) {
          console.warn('[login] org account not provisioned or archived — read-only');
          return;
        }
        window.FS.session.set({
          user: {
            sub:          me.cognito_sub,
            email:        me.email,
            role:         me.global_role,
            display_name: [me.first_name, me.last_name].filter(Boolean).join(' '),
            sites:        me.site_ids || [],
          },
        });
      } catch (err) {
        console.warn('[login] could not load /api/org/me', err);
      }
    }
```

- [ ] **Step 2: bump cache-buster(若 login-screen.js 有 ?v=)**

`grep -n "login-screen.js" app-shell-preview.html` 找到其 `<script>` 行;若带 `?v=N` 则 +1。若没有 `?v=`(直接 `login-screen.js`),跳过——`file://` 本地无所谓,Amplify 每次全量部署。

- [ ] **Step 3: 语法检查**

Run: `node --check scripts/composites/login-screen.js`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add scripts/composites/login-screen.js app-shell-preview.html
git commit -m "feat(ui-2a): hydrate identity from GET /api/org/me (403 → read-only)"
```

---

### Task 6: 运行时覆盖钩子(?orgbaseurl / ?orgwrites)

**Files:**
- Modify: `app-shell-preview.html`

**Interfaces:**
- Consumes: Task 2 的 `window.FS.api.orgBaseUrl` / `.orgWrites`。
- Produces: URL 参数 `?orgbaseurl=` / `?orgwrites=` 可在浏览器里覆盖(仿现有 `?baseUrl`/`?mocks`/`?writemocks`),便于 Chrome 验证。必须在 session-bridge(第 321 行加载)之前。

- [ ] **Step 1: 加覆盖钩子**

`app-shell-preview.html` 第 271 行(`writemocks` 处理之后、该 `<script>` 块内)插入:

```javascript
      var ob = params.get('orgbaseurl');
      if (ob !== null && window.FS && window.FS.api) { window.FS.api.orgBaseUrl = ob; }
      var ow = params.get('orgwrites');
      if (ow !== null && window.FS && window.FS.api) { window.FS.api.orgWrites = ow !== '0'; }
```

- [ ] **Step 2: 语法检查(整页内联脚本)**

无法 `node --check` HTML;肉眼确认新块在 `(function(){...})()` 内、括号配平、在第 321 行 session-bridge 之前。用 `grep -n "orgbaseurl\|orgwrites\|session-bridge" app-shell-preview.html` 确认顺序(覆盖块行号 < 321)。

- [ ] **Step 3: 提交**

```bash
git add app-shell-preview.html
git commit -m "feat(ui-2a): ?orgbaseurl / ?orgwrites runtime overrides"
```

---

### Task 7: 全量语法检查 + PR + 部署 + Chrome 冒烟(基础层)

**Files:** 无代码;可能 `docs/superpowers/plans` 台账。

**Interfaces:** Consumes 全部;Produces 部署到 Amplify dev + 登录身份真实化的验证。

- [ ] **Step 1: 全量语法检查**

```bash
for f in scripts/api/index.js scripts/api/_fetch.js scripts/api/org.js scripts/composites/login-screen.js scripts/env.example.js; do node --check "$f" && echo "ok $f"; done
```
Expected: 每个 `ok ...`。

- [ ] **Step 2: 脚本加载顺序核对**

`grep -n "api/index.js\|api/_fetch.js\|api/sites.js\|api/org.js\|session-bridge.js\|env.js" app-shell-preview.html`
确认顺序:env.js < api/index.js < _fetch.js < sites.js < **org.js** < 运行时覆盖块 < session-bridge.js。org.js 必须在 index.js/_fetch.js 之后。

- [ ] **Step 3: 推分支 + PR 到 dev**

```bash
git push -u origin feature/ui-2a-org-foundation
gh pr create --base dev --title "UI 2a: org backend foundation (dual base url + api/org.js + /me login)" --body "…"
```
(fieldsight-ui CI = Amplify webhook;无 pytest。合并到 dev 触发 Amplify 构建。)

- [ ] **Step 4: 设置 Amplify dev 环境变量(用户操作 / 控制台)**

在 Amplify app `d2fssznicvuckr` 的 dev 分支环境变量加:
- `FS_ORG_BASEURL` = `https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/prod/api`
- `FS_ORGWRITES` = `true`

(否则生成的 env.js 里 orgBaseUrl 为空 = org 回 mock。这一步是 Amplify 控制台操作,需用户;或用 aws amplify update-branch --environment-variables 命令,权限门。)

- [ ] **Step 5: 合并 → Amplify 构建 → Chrome 冒烟(基础层)**

合并 PR → 等 Amplify dev 构建绿。Chrome(Claude-in-Chrome 或用户)打开 dev 站,**真实登录**(admin=benl.tech):
- DevTools Network:登录后应有一条到 `wdsgobb7b0.../prod/api/org/me` 的 200(裸 idToken,无 Bearer,无 X-Request-Id)。
- Console 无 "could not load /api/org/me"。
- `window.FS.session.user` 应含真实 `sub`/`email`/`role=admin`/`display_name="Ben Lin"`/`sites`(site_ids)。
- 这同时**端到端验证 dual-pool authorizer**(prod 池 idToken 过 org 网关)——此前只做过直接 invoke。
- 用 `?orgbaseurl=`/`?orgwrites=0` 可现场 A/B(orgwrites=0 时写回 mock)。

- [ ] **Step 6: 记账**

台账追加基础层完成 + Chrome 验证结果。批次 2b(页面接线)另起 writing-plans。

---

## 自审(已完成)

- Spec §5 覆盖:§5.1 双基址 env(T1)+ orgBaseUrl/orgWrites(T2)✅ · §5.2 orgRequest + api/org.js + 门控(T3/T4;读=`!useMocks&&orgBaseUrl`,写=`&&orgWrites`,不碰 writeMocks)✅ · §5.3 登录 /me(T5)✅ · §8b kill switch(orgBaseUrl 空,T1/T4)+ /me 403 降级(T5)✅。§5.4 页面/fan-out、§5.5 上传、归档 UI = 批次 2b/2c(不在本批)。
- 签名一致:`orgRequest(path, opts)` T3 定义、T4 消费;`api.org.getMe/getMembers/...` T4 定义,契约块列明,T5 用 getMe;`folderName(m)` 内部一致;门控 `orgLive/orgWrite` 全模块统一。
- 占位符扫描:PR body "…" 执行时填;无 TBD。
- 已知取舍(注释在案):org 网关跨源 → 无 X-Request-Id(设计);orgBaseUrl 空 = kill switch;mock getMe 从 AuthMock 派生(保原型可离线);uploadUrl mock 返回 null（调用方 2c 回退 data-URI 预览）。
- 无测试框架 → 每任务 `node --check` + 最终 Chrome;这是 fieldsight-ui 既定验证方式(CLAUDE.md)。
