# Phase 3 UI 接线 · 批次2b:team/sites/settings 页面接真实 org API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(推荐)或 executing-plans,逐任务执行。步骤用 `- [ ]`。
> 前置:批次 2a 已上线(`window.FS.api.org.*` 数据层就绪:getMe/updateProfile/getOrgSites/createOrgSite/updateOrgSite/archiveSite/unarchiveSite/getMembers/createMember/updateMemberRole/archiveMember/unarchiveMember/uploadUrl/assetUrl;读 gate `!useMocks&&orgBaseUrl`、写 gate `&&orgWrites`;getMembers 已派生 folder_name)。org 后端 live 验证过。

**Goal:** team/sites/settings 三页的读写接真实 org API,admin 聚合改用真实报告用户源,并从 `orgStatus` 渲染"账号未激活/已归档"提示——组织管理闭环在浏览器里可点(建项目/加成员/改角色/归档/改资料,刷新持久)。

**Architecture:** 核心是**形状适配器**——org 对象形状 ≠ 页面既有(fixture 时代)形状,所以在 `api/org.js` 加 `_toPageMember`/`_toPageSite` 把 org 行映射成页面 render 代码期望的字段,页面 Provider 只改「调哪个 api + 用适配器」,render 代码基本不动(低风险)。写路径 team/sites/settings 的 mock-only mutation 换成 `org.*`;身份键从 `device_id`→`cognito_sub`;admin 聚合源改 prod `/api/users` + 客户端派生 folder_name;app-shell 加全局 orgStatus banner。头像/图标 presign 留给批次 2c。

**Tech Stack:** 无构建浏览器 React 原型;验证 `node --check` + Chrome。

**Spec:** `fieldsight-pipeline/docs/superpowers/specs/2026-07-04-phase-3-completion-org-datamodel-ui.md` §5.4 + §8b。

## Global Constraints

- 分支 dev;无构建/无测试;每文件 `node --check`;改到加载的 `.js`/`.css` bump `?v=`。
- tokens-only、BEM、`React.createElement`;不引 npm。Windows autocrlf 单行 anchor;绝不 `git add -A`。
- **门控铁律**:org 读 `!useMocks&&orgBaseUrl`、org 写 `&&orgWrites`(在 `api/org.js` 内已实现,页面直接调 `org.*` 即可)。
- **live 门控用 `FS.can(caller,'user:manage')`(role-based,session-bridge 有桥接 role)**,不要用 `caller.isAdmin`(bridge 不设,live 恒 false)。
- 头像/站点图标的 **presign 上传 = 批次 2c**;本批这些 picker 暂保持现状(data-URI/localStorage)或占位,不接 org uploadUrl。

## 5 个已知难点(设计决策,贯穿全批)

1. **身份键**:team 页 mutation 键 `device_id`(报告身份);org 写键 `cognito_sub`。→ org member 适配器把 `cognito_sub` 映射成页面用的 id;role change/archive 改用 `cognito_sub`。
2. **形状不一致**:org member `{cognito_sub,email,first_name,last_name,global_role,avatar_s3_key,archived_at,memberships[],folder_name}` vs 页面读 `{device_id,name,role,primary_site,sites,avatarUrl,folder_name}`;org site `{id,name,location,client,industry,icon_s3_key,archived_at}` vs 页面读 `{site_id,name,location,region,client,icon,user_count}`。→ 适配器补齐。
3. **`/api/users` 无 folder_name**:3 处 admin 聚合读 `u.folder_name`;prod `/api/users` 只回 `device_id/name/role/sites`。→ 聚合处客户端派生 `folder_name = name.replace(/ /g,'_')`(与 org.js `folderName` 同规则)。
4. **orgStatus 不在 AuthMock**:session-bridge 只映射 role/email/name/site,不传 orgStatus。→ banner 直接读 `((FS.session&&FS.session.user)||{}).orgStatus`,mock 模式 `FS.session.user===null` 要 null-guard。
5. **isAdmin 未桥接**:见 Global Constraints——一律 `FS.can(caller,'user:manage')`。

---

### Task 1: api/org.js 形状适配器 + getMembers/getOrgSites 输出页面形状

**Files:** Modify `scripts/api/org.js`;Modify `app-shell-preview.html`(bump org.js `?v=`)。

**Interfaces:**
- Produces:`org.getMembers()` 返回的每个 member 额外带页面字段;`org.getOrgSites()` 每个 site 带页面字段;新增导出 `org._toPageMember(m)`、`org._toPageSite(s)`(供页面/测试复用)。契约:
  - `_toPageMember(m)` → `{ ...m, device_id: m.cognito_sub, name: [first,last].join(' ')||m.email, role: m.global_role, folder_name: <已派生>, sites: (m.memberships||[]).map(x=>x.site_id), primary_site: (m.memberships[0]||{}).site_id||'', avatarUrl: m.avatar_s3_key||null, archived: !!m.archived_at }`
  - `_toPageSite(s)` → `{ ...s, site_id: s.id, region: s.region||'', icon: s.icon_s3_key||null, user_count: s.user_count||0, archived: !!s.archived_at }`

- [ ] Step 1:在 org.js `folderName` 之后加两个纯映射函数 `_toPageMember`、`_toPageSite`(见契约,纯函数无副作用)。
- [ ] Step 2:`getMembers` 的返回,对每个 member 除了现有 `folder_name` 再套 `_toPageMember`(即返回 `{members: raw.members.map(_toPageMember)}`);mock 分支同样(mock users 已有 device_id/name/folder_name,`_toPageMember` 幂等补齐缺的)。
- [ ] Step 3:`getOrgSites` 返回 `{sites: raw.sites.map(_toPageSite)}`;mock 分支同样。
- [ ] Step 4:导出 `_toPageMember`/`_toPageSite`;bump org.js `?v=`;`node --check scripts/api/org.js`。
- [ ] Step 5:提交 `feat(ui-2b): org.js page-shape adapters (member/site) on getMembers/getOrgSites`。

---

### Task 2: /settings 资料读写接 org

**Files:** Modify `scripts/pages/settings.js`;bump `?v=`。

**Interfaces:** Consumes `org.getMe`、`org.updateProfile`。
- 现状(recon):`deriveProfile`(settings.js:73)同步读 localStorage+AuthMock;`saveProfile`(:116)写 localStorage+AuthMock。
- Produces:live 时资料从 `org.getMe()` 拉(firstName/lastName/email);保存名字走 `org.updateProfile({first_name,last_name})`;format/timezone 偏好仍 localStorage(非 org 数据);email 只读。头像 picker **保持现状**(presign=2c)。

- [ ] Step 1:`deriveProfile` 改造——live(`!useMocks&&orgBaseUrl`)时从 `org.getMe()` 异步取,填 firstName=me.first_name、lastName=me.last_name、email=me.email;偏好仍 localStorage。因 getMe 异步,Provider 加 loading + effect(仿其他页 Provider 模式);mock 时保持原同步逻辑。
- [ ] Step 2:`saveProfile` 改造——live 且 orgWrites 时先 `org.updateProfile({first_name:p.firstName,last_name:p.lastName})`(email 只读不发),成功后仍写 localStorage 偏好 + AuthMock(名字)+ toast;失败 toast error。mock 保持原样。
- [ ] Step 3:`node --check`;bump `?v=`;提交 `feat(ui-2b): settings profile reads/saves via org /me`。

---

### Task 3: /sites 列表+建项目+归档接 org

**Files:** Modify `scripts/pages/sites.js`;bump `?v=`。

**Interfaces:** Consumes `org.getOrgSites`(带 `_toPageSite` 形状)、`org.createOrgSite`、`org.archiveSite`/`unarchiveSite`。
- 现状(recon):Provider `Promise.all([sites.getSites(), reports.getReportsHistory(50)])`(sites.js:101);建项目 `sites.createSite(form)`(:194);站点对象读 `site_id/name/location/region/client/icon/user_count`(适配器已补)。

- [ ] Step 1:Provider 的 `getSites()` 改 `org.getOrgSites()`(live);报告 history 仍走原 API。站点用适配器形状,render 不动。
- [ ] Step 2:`createSite(form)` 改 `org.createOrgSite({name,location,client,industry})`(org 不吃 region/project_value/planned_completion——这些非 org schema 字段,live 时不传,mock 保留);成功后 `onCreated` 用适配器包一下返回的 site。图标 picker **保持现状**(presign=2c),create 时不传 icon_s3_key。
- [ ] Step 3:加归档入口——右详情加"Archive project"按钮(admin/gm via `FS.can`),调 `org.archiveSite(site_id)`;列表默认不含已归档(org getOrgSites 默认过滤);可选"查看已归档"开关(`org.getOrgSites({includeArchived:true})`)。
- [ ] Step 4:`node --check`;bump `?v=`;提交 `feat(ui-2b): sites list/create/archive via org API`。

---

### Task 4: /team 成员读+加成员+改角色+归档接 org

**Files:** Modify `scripts/pages/team.js`;bump `?v=`。

**Interfaces:** Consumes `org.getMembers`(带 `_toPageMember`)、`org.createMember`、`org.updateMemberRole`、`org.archiveMember`。
- 现状(recon):Provider `sites.getUsers()`(team.js:179);加成员 `sites.createUser(form)`(:321);改角色 `updateUserRole(deviceId,role)`(:266,键 device_id);无归档 UI(ReassignModal 是 mock-only)。

- [ ] Step 1:Provider `getUsers()` 改 `org.getMembers()`(live);成员用适配器形状(device_id=cognito_sub,folder_name 已派生,sites 来自 memberships)。scope 过滤、grouping 复用(读的字段适配器都补了)。
- [ ] Step 2:加成员 `createUser(form)` 改 `org.createMember({email, first_name, last_name, global_role, memberships})`——把表单 name 拆 first/last、role→global_role、primary_site→memberships:[{site_id, role}]。头像 picker 去掉(§8b:不能替别人设头像)或仅本地预览不持久。成功后 `addUser` 用适配器包返回的 user。
- [ ] Step 3:改角色 `changeRole(deviceId,role)` 键改 `cognito_sub`——TeamRightDetail 的 select `onChange` 传 `u.cognito_sub`(适配器里 device_id===cognito_sub,兼容);`org.updateMemberRole(cognito_sub, role)`。
- [ ] Step 4:加归档入口——右详情加"Archive member"(admin/gm via `FS.can`,禁自归档),`org.archiveMember(cognito_sub)`;可选"查看已归档"(`org.getMembers({includeArchived:true})`+`unarchiveMember`)。ReassignModal 保持 mock(改工地归属留待设备管理批,见 memory)。
- [ ] Step 5:`node --check`;bump `?v=`;提交 `feat(ui-2b): team members list/create/role/archive via org API`。

---

### Task 5: orgStatus 全局 banner(app-shell)

**Files:** Modify `scripts/app-shell.js`;bump `?v=`;可选 `styles/app-shell.css` 加样式(复用 `.fs-offline-banner`)。

**Interfaces:** Consumes `FS.session.user.orgStatus`(login-screen 已设:active/archived/unprovisioned)。
- 现状(recon):offline banner 在 app-shell.js:835 作为 AppShell return 的顶层 sibling;AppShell 在 AuthMock.onChange(:636)重渲染。

- [ ] Step 1:在 offline banner sibling 旁加 orgStatus banner——读 `var os=((window.FS&&window.FS.session&&window.FS.session.user)||{}).orgStatus;`;`os==='unprovisioned'`→"账号未激活,请联系管理员"(read-only 提示);`os==='archived'`→"账号已归档,只读"。`active`/mock(null)→不显示。复用 `.fs-offline-banner` fixed 样式(或新 class)。
- [ ] Step 2(稳妥):AppShell 加订阅 `FS.session.onChange`(session.js:128)触发重渲染,确保登录后 banner 及时出现(bridge 的 updateProfile 已触发一次,双保险)。
- [ ] Step 3:`node --check`;bump `?v=`;提交 `feat(ui-2b): global orgStatus banner (unprovisioned/archived)`。

---

### Task 6: admin 聚合源改 prod /api/users + 客户端派生 folder_name

**Files:** Modify `scripts/api/compliance-aggregator.js`、`scripts/api/tasks-aggregator.js`、`scripts/pages/evidence.js`;bump `?v=`。

**Interfaces:** Consumes prod `FS.api.sites.getUsers()`(=`GET /api/users`,报告身份,回 device_id/name/role/sites,**无 folder_name**)。
- 现状(recon):3 处读 `fixtures.sites.users` 的 `u.folder_name`(D.1/D.2/D.3)。

- [ ] Step 1:加一个共享助手(可放 `api/sites.js` 或各处内联)`deriveFolder(u){ return u.folder_name || (u.name? u.name.replace(/ /g,'_') : ''); }`。
- [ ] Step 2:三处 admin fan-out 的用户源:live 时改 `await FS.api.sites.getUsers()` 取 `.users`,map `deriveFolder` 得 folders;mock/失败回退现有 `fixtures.sites.users`。(注意:这些是异步了,原来 fixtures 是同步——各处已在 async 上下文,await 即可。)
- [ ] Step 3:`node --check` 三文件;bump `?v=`;提交 `feat(ui-2b): admin fan-out uses real /api/users (report identity) + derived folder_name`。

---

### Task 7: 全量 check + PR + 部署 + Chrome 全流程验证

- [ ] Step 1:`for f in scripts/api/org.js scripts/pages/{settings,sites,team,evidence}.js scripts/api/{compliance-aggregator,tasks-aggregator}.js scripts/app-shell.js; do node --check "$f"; done` 全 ok;脚本加载顺序核对。
- [ ] Step 2:推分支 + PR 到 dev。
- [ ] Step 3:合并(用户)→ Amplify 重建 → Chrome(admin=benl.tech 登录,注意硬刷新绕缓存):
  - /team 显示真实 org 成员(4 个),加成员(发真实邀请邮件!谨慎——可用测试邮箱)、改角色持久、归档/恢复;
  - /sites 显示 org 站点,建项目持久、归档;
  - /settings 显示 /me 真实资料,改名字持久;
  - admin 聚合页(safety/tasks/evidence)仍显示报告数据(fan-out 用真实报告用户);
  - orgStatus banner:用未 provision 的账号登录应见提示(可选);
  - 端到端 dual-pool authorizer 再确认。
- [ ] Step 4:记账;批次 2c(presign 上传 + 归档 UI 完善)另起。

---

## 自审

- Spec §5.4 覆盖:team/sites/settings 读写(T2/T3/T4)、fan-out prod /api/users(T6)、folder_name 派生(T1/T6)、orgStatus banner(T5)。§8b:归档 UI(T3/T4 含 archive 入口 + includeArchived)、加成员不代设头像(T4)、banner(T5)。
- 5 难点各有对策:身份键(T1/T4)、形状(T1 适配器)、/api/users 无 folder_name(T6 派生)、orgStatus 读 session(T5)、isAdmin→FS.can(全批)。
- presign 上传显式留 2c;ReassignModal 显式留设备管理批。
- 无测试→每任务 node --check + T7 Chrome。
