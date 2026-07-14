# Phase 3 UI 收尾 · 批次2c:presign 上传 + 资产展示解析 + 归档恢复 UI + live 角色 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development,逐任务执行,步骤 `- [ ]`。
> 前置:批次 2b + admin 热修已上线。org 后端 presign 全就绪:`POST /upload-url {kind:'avatar'|'site_icon', content_type}` → `{url,key}`(pending 前缀、15min、site_icon 需 admin/gm、类型限 image/jpeg|png|webp);`GET /asset-url?key=` → `{url}`(pending 不可读);`PATCH /me {avatar_s3_key:pendingKey}` / `POST /sites {icon_s3_key}` / `PATCH /sites/{id} {icon_s3_key}` 提交时搬迁 pending→永久 key,过期 pending → 400 "upload expired…"。**部署环境 orgWrites=true——写真落库。**

**Goal:** 头像/站点图标上传真跑通(presign PUT→提交搬迁→展示解析),org S3 key 在所有展示点解析成可显示 URL,归档可恢复/可查看,live 模式角色下拉只给 org 5 角色,聚合全失败时报错而非静默空。

**Architecture:** ①org.js 新增 `uploadImage(kind,file)`(裸 fetch PUT presigned URL——**绝不能走 rawRequest**:它会 JSON.stringify Blob、强设 Content-Type application/json、注入 Authorization,三者都破坏 S3 签名)与 `resolveAssetUrl(key)`(带 12min 缓存的 key→URL 解析,data:/https? 透传);②展示解析放在各页 Provider(取数后对 `org-assets/` 开头的 key 异步解析、patch 进 state),Avatar/site-card 组件不动(它们收 src、onError 回退首字母);③归档恢复=中栏 header 加 "Archived" 开关(live+user:manage)→ `includeArchived:true` 重取 → 行加 Archived 徽章 → 右详情 Unarchive;④live roleOptions 只给 org 5 角色。

**Tech Stack:** 无构建浏览器 React;`node --check` + Chrome。

## Global Constraints

- 分支 `feature/ui-2c-uploads-archive`(off dev);无测试 → 每文件 `node --check`;改动的加载文件 bump `?v=`;单行 Edit anchor(autocrlf);绝不 `git add -A`。
- 门控:org 读 `!useMocks&&orgBaseUrl`、写 `&&orgWrites`(org.js 内);页面级 `orgLive()` 判走向,**mock 路径行为保持逐字节不变**(4 个 picker 的 data-URI 预览是 mock 的持久化方式,live 只把"持久化"换成 presign,预览仍用 data-URI 即时显示)。
- 权限用 `FS.can(caller,'user:manage')`;上传类型客户端先验 `{'image/jpeg','image/png','image/webp'}`。
- presigned PUT 必须:`fetch(url, {method:'PUT', headers:{'Content-Type': file.type}, body: file})`——无 Authorization、无 JSON 化、无额外 header。
- 展示解析约定:只对 `^org-assets/` 开头的字符串解析;`data:`/`https?:` 透传;解析失败 → null(Avatar onError 已优雅回退首字母,不 crash)。

---

### Task 1: org.js `uploadImage` + `resolveAssetUrl`

**Files:** Modify `scripts/api/org.js`;bump `?v=` in `app-shell-preview.html`。

**Interfaces (Produces):**
- `window.FS.api.org.uploadImage(kind, file)` → Promise<string|null>:校验 `file.type ∈ {image/jpeg,image/png,image/webp}`(否则 `throw new Error('Unsupported image type — use JPEG, PNG or WebP')`);调既有 `uploadUrl(kind, file.type)`;`!res || !res.url`(mock/写关)→ 返回 `null`(调用方回退本地预览);否则 `fetch(res.url, {method:'PUT', headers:{'Content-Type': file.type}, body: file})`,`!resp.ok` → throw;成功返回 `res.key`(pending key)。
- `window.FS.api.org.resolveAssetUrl(key)` → Promise<string|null>:`!key` → null;`/^(data:|https?:)/` → 原样返回;非 `^org-assets/` → null;模块级缓存 `{key:{url,expiresAt}}` 命中(`expiresAt>Date.now()`)→ 缓存 url;否则调既有 `assetUrl(key)`,`res.url` → 存缓存(`Date.now()+12*60*1000`,presign 15min 留 3min 余量)并返回,失败/无 url → null(catch 吞掉,返回 null)。

- [ ] Step 1:在 org.js `assetUrl` 之后加两函数(签名/行为如上,含注释说明为何不用 rawRequest)。
- [ ] Step 2:导出到 `window.FS.api.org`(uploadImage、resolveAssetUrl)。
- [ ] Step 3:`node --check scripts/api/org.js`;bump org.js `?v=`。
- [ ] Step 4:提交 `feat(ui-2c): org.uploadImage (presigned PUT) + resolveAssetUrl (cached key→URL)`。

---

### Task 2: /settings 头像 live 上传 + 展示解析

**Files:** Modify `scripts/pages/settings.js`;bump `?v=`。

**Interfaces (Consumes):** T1 的 `uploadImage('avatar', file)`、`resolveAssetUrl`;既有 `org.getMe`(返回 `avatar_s3_key`)、`org.updateProfile`(PATCH /me 收 `avatar_s3_key`,返回更新后的行)。
**现状锚点:** picker `onPick` 在 ProfileTab(settings.js:269-275,FileReader→`ctx.patchProfile({avatarUrl:dataUri})`);`saveProfile` live 现只发 `{first_name,last_name}`(:137-154);mount hydrate effect(:116-125)只 patch 名字/email;`orgLive()` 在 Provider 内 :110。

- [ ] Step 1:`onPick` live 分支:仍先 FileReader 出 data-URI 即时预览(`patchProfile({avatarUrl:dataUri})` 不变),**追加**调 `window.FS.api.org.uploadImage('avatar', f)`:成功 key → `ctx.patchProfile({_pendingAvatarKey: key})`;返回 null(写关)→ 不设 key(保持现状);throw(类型不符/PUT 失败)→ `toast('Could not upload image — use JPEG, PNG or WebP','error')` 且不设 key。mock 分支:完全不变(只有 data-URI)。
- [ ] Step 2:`saveProfile` live 分支:body 组装改为 `var body={first_name:p.firstName,last_name:p.lastName}; if(p._pendingAvatarKey) body.avatar_s3_key=p._pendingAvatarKey;`,`org.updateProfile(body)` 成功回调里:若发了 avatar → 用返回行的 `res.avatar_s3_key` 调 `resolveAssetUrl` 得展示 URL,`commitLocal` 前把 `p.avatarUrl` 替换为该 URL 且清掉 `_pendingAvatarKey`(注意 `commitLocal` 写 localStorage/AuthMock 用的是替换后的对象);失败(含 400 过期)→ 现有 error toast 上补充信息 `'Could not save profile — image upload may have expired, re-upload it'`(仅当发了 avatar key)。
- [ ] Step 3:mount hydrate effect:getMe 成功后若 `me.avatar_s3_key` 且用户尚未本地改过头像(`!profile._pendingAvatarKey`)→ `resolveAssetUrl(me.avatar_s3_key)` → 非 null 则 `patchProfile({avatarUrl:url})`(cancelled 守卫沿用)。
- [ ] Step 4:`node --check`;bump `?v=`;提交 `feat(ui-2c): settings avatar presign upload + resolve display`。

---

### Task 3: /sites 图标 live 上传(建项目 + 换图)+ 展示解析

**Files:** Modify `scripts/pages/sites.js`;bump `?v=`。**先核实**:pipeline `patch_org_site`(fieldsight-pipeline/src/lambda_org_api.py)是否支持 `icon_s3_key:null` 显式清除(仿 patch_me 的 `"avatar_s3_key" in body && None`)——**若不支持,live 模式隐藏 Remove 按钮**并在报告注明(后端 backlog)。

**Interfaces (Consumes):** T1 `uploadImage('site_icon', file)`、`resolveAssetUrl`;既有 `createOrgSite(body)`(收 `icon_s3_key` pending key)、`updateOrgSite(id,{icon_s3_key})`(org.js:107)。
**现状锚点:** NewProjectModal `onPickIcon`(sites.js:204,data-URI→`set('icon',…)`);submit live 不发 icon(:205-222,顺手删掉恒 undefined 的 `industry: form.industry`);右详情 `onPickIcon`(:410)→ mock-only `ctx.setSiteIcon`(:164-172);展示 site-card.js:55 与 sites.js:448 都是 `src: site.icon`;Provider 取数 effect :110。

- [ ] Step 1:NewProjectModal `onPickIcon` live:data-URI 预览不变,追加 `uploadImage('site_icon', f)` → 成功 `set('_iconKey', key)`;null → 不设;throw → toast error。submit live:`createOrgSite({name, location, client, icon_s3_key: form._iconKey || undefined})`(JSON 序列化自动丢 undefined;删 industry)。成功后 `_toPageSite` 包装不变——返回行带最终 icon key,**再对返回 site 调 `resolveAssetUrl(site.icon)` 把展示 URL patch 进 `onCreated` 传的对象**(async:先 onCreated 原样,再解析后用 ctx.setSiteIcon 更新亦可,选实现最简者)。
- [ ] Step 2:右详情 `onPickIcon` live 分支:`uploadImage('site_icon', f)` → 成功 → `org.updateOrgSite(sel.site_id, {icon_s3_key: key})` → 成功 → `resolveAssetUrl(返回行.icon_s3_key)` → `ctx.setSiteIcon(sel.site_id, url)`(本地 state 更新即展示;live 下跳过 fixture 变异无妨,setSiteIcon 现逻辑兼容)+ 现有 toast;任一步失败 → toast error、不动 state。mock 分支不变。Remove 按钮:live 按 Step 0 核实结果处理(支持 → `updateOrgSite({icon_s3_key:null})`;不支持 → live 隐藏)。
- [ ] Step 3:Provider 展示解析:取数(`org.getOrgSites()`)成功 setState 后,加一个 effect(或在 then 里)对 `sites` 中 `/^org-assets\//.test(site.icon)` 的项并行 `resolveAssetUrl`,逐个把解析出的 url patch 进对应 site 的 `icon`(复用 setState 模式;cancelled 守卫)。site-card/右详情零改动。
- [ ] Step 4:`node --check`;bump `?v=`;提交 `feat(ui-2c): site icon presign upload (create+swap) + resolve display`。

---

### Task 4: /team 头像解析 + 站点名解析 + live 角色下拉

**Files:** Modify `scripts/pages/team.js`;bump `?v=`。

**Interfaces (Consumes):** T1 `resolveAssetUrl`;既有 `org.getOrgSites({includeArchived:true})`(拿 id→name 映射,含归档的名字也要能解析)。
**现状锚点:** `roleOptions()`(team.js:354-357,读 FS.ROLES 全 10 角色),消费点=右详情 select :792-795 与 AddMemberModal :435;`toOrgRole`(:166-184);`siteDisplayName`(:136-140,仅查 fixtures → live 显示裸 UUID),消费点 :544(分组头)/:503/:719-720/:284;Provider 取数 effect :212;头像展示 :562/:771(`src: u.avatarUrl`)。

- [ ] Step 1:live 角色下拉:`roleOptions()` 改为 `if (orgLive()) return [{v:'admin',l:'Admin'},{v:'gm',l:'General Manager'},{v:'pm',l:'Project Manager'},{v:'site_manager',l:'Site Manager'},{v:'worker',l:'Worker'}];` 原 10 角色留 mock。live 下 `u.role` 本就是 org slug(_toPageMember 的 global_role)→ select value 自然匹配;`toOrgRole` 保留(对 org slug 是恒等,防御)。注意 team.js 顶部已有模块级 `orgLive()`。
- [ ] Step 2:站点名解析:模块级 `var _orgSiteNames = {};`,`siteDisplayName(siteId)` 改为先查 `_orgSiteNames[siteId]`,再查 fixtures,最后回退 `siteId`。TeamProvider 取数 effect 里,live 时**并行**(不阻塞成员渲染)`org.getOrgSites({includeArchived:true}).then(res => { (res.sites||[]).forEach(s => _orgSiteNames[s.site_id]=s.name); setState(s=>Object.assign({},s)) /* 触发重渲染刷新组头 */ })`(catch 吞;cancelled 守卫)。
- [ ] Step 3:头像解析:Provider 成员加载成功后,对 `/^org-assets\//.test(u.avatarUrl)` 的成员并行 `resolveAssetUrl` → 逐个 patch 进 state(仿 T3 Step 3 模式)。
- [ ] Step 4:`node --check`;bump `?v=`;提交 `feat(ui-2c): team avatar/site-name resolution + live org role options`。

---

### Task 5: 归档恢复 UI(sites + team)

**Files:** Modify `scripts/pages/sites.js`、`scripts/pages/team.js`;bump 两个 `?v=`(T3/T4 已 bump 过则再 +1)。

**Interfaces (Consumes):** 既有 `getOrgSites({includeArchived})`/`getMembers({includeArchived})`(org.js:84/:128 已支持)、`unarchiveSite(id)`/`unarchiveMember(sub)`(org.js:120/:156)。
**现状锚点:** sites 中栏 header(sites.js:310-320,`+ New project` 旁)、Provider effect deps :152(retryCount);team 中栏 header(team.js:509-521,`+ Add member` 旁)、Provider retryRef;归档按钮 sites.js:452 / team.js:832;`_toPageSite/_toPageMember` 已带 `archived` 布尔。

- [ ] Step 1(sites):Provider 加 `showArchived` state(默认 false),effect 依赖加它,live 取数改 `org.getOrgSites({includeArchived: showArchived})`;ctx 暴露 `showArchived`/`setShowArchived`。中栏 header `+ New project` 旁加 toggle 按钮(仅 `orgLive() && FS.can(caller,'user:manage')` 渲染):文案 `showArchived ? 'Hide archived' : 'Show archived'`,class `fs-btn fs-btn--secondary fs-btn--sm`。
- [ ] Step 2(sites):site-card 渲染处对 `site.archived` 加 `Badge`(既有 Badge 组件,文案 'Archived',tone 中性);右详情:`site.archived` 时把 Archive 按钮换成 Unarchive(`org.unarchiveSite(sel.site_id)` → 成功 bump retry 计数重取 + toast 'Project restored';失败 toast error)。归档成功路径改为:toast 后 bump retry(重取,showArchived=false 时自然消失)——替代原 removeSite 手工 patch(保留 removeSite 不删,改调用)。
- [ ] Step 3(team):同款:Provider `showArchived` + effect deps + `getMembers({includeArchived: showArchived})` + header toggle(同门控);成员行 `u.archived` → Badge 'Archived';右详情 `u.archived` 时 Archive 按钮换 Unarchive(`org.unarchiveMember(u.device_id)` → bump retry + toast 'Member restored')。归档成功也改 bump retry。
- [ ] Step 4:`node --check` 两文件;bump `?v=`;提交 `feat(ui-2c): show-archived toggle + unarchive (sites & team)`。

---

### Task 6: 聚合"全失败"报错(替代静默空)

**Files:** Modify `scripts/api/compliance-aggregator.js`、`scripts/api/tasks-aggregator.js`、`scripts/api/user-activity-aggregator.js`、`scripts/pages/evidence.js`;bump 各 `?v=`。

**现状锚点:** 4 处 pooledAll 调用(compliance admin 路径、tasks folders 分支、user-activity reports 腿、evidence photos)——`filter(Boolean)` 后若**输入非空而结果全空**,说明全部请求失败,现渲染成空页面。

- [ ] Step 1:每处在 filter(Boolean) 后加:`if (<thunks数组>.length > 0 && <结果>.length === 0) throw new Error('Could not load data — all requests failed. Please retry.');`(注意各处 thunks 数组需先存变量再传 pooledAll,以便比长度;evidence 在 .then 链内 throw 会落到既有 .catch → ErrorBanner;两个 aggregator throw 会被页面 Provider 的 .catch 接住 → ErrorBanner;user-activity 同)。
- [ ] Step 2:`node --check` 4 文件;bump `?v=`;提交 `fix(ui-2c): surface all-failed aggregation as error instead of silent empty`。

---

### Task 7: 全量检查 + Fable 终审 + PR

- [ ] Step 1:`node --check` 本批全部改动文件;核对 app-shell-preview.html busters 与加载顺序。
- [ ] Step 2:生成整分支 diff,派 **Fable 5** 终审(重点:presigned PUT 无 auth/无 JSON 化;resolveAssetUrl 缓存过期边界;mock 路径零变化;showArchived 重取的 effect 依赖闭环;全失败 throw 不误伤合法空结果[输入 0 thunks 不 throw];pending key 过期 400 的用户提示)。
- [ ] Step 3:修 Critical/Important → 复审 → 推分支开 PR(base dev)。
- [ ] Step 4:合并部署后(用户测试为主):我做只读 Chrome smoke(不触写:确认展示解析不报错、toggle/按钮渲染、角色下拉 5 项)。**不实测上传/归档写**(orgWrites=true 真落库,留给用户)。

---

## 自审

- 覆盖:上传(T1-T3)、展示解析(T2-T4)、归档恢复(T5)、live 角色(T4)、全失败报错(T6)——含 2b 遗留 minors(UUID 组头 T4、静默空 T6);"归档后详情残留"由 T5 的 bump-retry 重取根治(列表重载,选中项消失时右栏自然空)。
- 接口一致性:`uploadImage(kind,file)`/`resolveAssetUrl(key)` 名称在 T2/T3/T4 一致;`_pendingAvatarKey`/`_iconKey` 前缀下划线约定为"未持久化临时态"。
- 无占位符;presigned PUT 的三个"不许"写进 Global Constraints;Remove-icon 的后端不确定性显式交给 T3 实现者核实并降级。
- mock 行为零变化贯穿每任务。
