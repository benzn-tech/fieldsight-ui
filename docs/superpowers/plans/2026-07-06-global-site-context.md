# 批次 A2:全局项目上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development,逐任务执行,步骤 `- [ ]`。
> 用户拍板:一次选择项目 → 数据页全部跟随(Timeline/Safety/Quality/Tasks/Evidence/Activity);战略页(Insights/Portfolio/Regional/Executive)+ Today + Team/Sites + Ask 豁免。

**Goal:** 项目选择器上移 app-shell 顶栏,`FS.siteContext` 全局共享,五个数据页的聚合按项目过滤。

**Architecture:** ①新模块 `FS.siteContext`(Set 订阅者 + localStorage `fs.settings.activeSite`,mirror actions-bus/AuthMock 模式);②选择器渲染在 MiddleColumn 56px header(title 与 utility 簇之间,仅 SCOPED_ROUTES 显示);③**承重约束(侦察 D2)**:Insights/strategic/search-palette 与数据页共用 `getSafetyRange/getQualityRange/getActionsResolvedRange` —— site 过滤必须是**显式 opts.site 参数**,聚合器内部绝不读全局 context;④Timeline 迁移到全局 context(URL `?site=` 保留深链优先级,页内选择器移除)。

**Tech Stack:** 无构建浏览器 React;`node --check` + Chrome。

## Global Constraints

- 分支 `feature/global-site-context`;每文件 `node --check`;bump `?v=`;单行 anchor;绝不 `git add -A`。
- **聚合器铁律**:site 过滤 = `opts.site` 显式参数;聚合器函数体内**禁止**读 `FS.siteContext`(否则 Insights/Portfolio/Regional/Executive/search-palette 被静默限定,违反豁免设计)。
- worker 强制自己的规则在所有聚合器不变(site 参数对 worker 无效)。
- mock 模式完整可用(getSiteUsers 有 mock 分支按 `u.sites` 过滤 fixtures)。
- SCOPED_ROUTES = `['/timeline','/safety','/quality','/tasks','/evidence','/activity']`(模块级常量,app-shell 内)。
- 上下文键 `fs.settings.activeSite` 存 `{site}`;首次读取时若为空则**一次性收养**旧键 `fs.settings.timelineSite` 的值(迁移),之后 timeline 键不再读写。

---

### Task 1: FS.siteContext 模块 + app-shell 顶栏选择器

**Files:** Create `scripts/site-context.js`;Modify `scripts/app-shell.js`、`app-shell-preview.html`(加载新脚本,在 theme.js 之后、router.js 之前即可;bump app-shell.js `?v=`)。

**Interfaces (Produces):**
- `window.FS.siteContext = { get(), set(siteId|null), onChange(cb)→unsub }`。`set` 持久化(null→removeItem)+ emit(新值)。`get` 惰性读 localStorage(含一次性收养 `fs.settings.timelineSite`)。订阅不立即回调(mirror actionsBus;挂载时用 get() 取当前值)。
- MiddleColumn 顶栏在 SCOPED_ROUTES 上渲染紧凑 `<select className:'fs-settings__select', style:{maxWidth:'220px'}}`(插在 title 列 :365 关闭后、`.middle-column__utility` :368 之前,吃 row 的 gap:12px)。

- [ ] Step 1:写 `scripts/site-context.js`(IIFE;Set listeners;`emit(site)` try/catch console.error mirror actions-bus.js:32-51;localStorage 读写 try/catch;一次性收养逻辑:activeSite 键缺失且 timelineSite 键存在 → 采纳其值并写入 activeSite)。
- [ ] Step 2:`app-shell-preview.html` 加 `<script src="scripts/site-context.js?v=1"></script>`(density.js 之后、router.js 之前)。
- [ ] Step 3:app-shell.js MiddleColumn(:300 起):加 `sitesList` state + 一次性 `getSites()` effect(cancelled 守卫、失败 []);加 `activeSite` state(init `FS.siteContext.get()`)+ `useEffect(() => FS.siteContext.onChange(setActiveSite), [])`;模块级 `SCOPED_ROUTES`(Set 或数组)。
- [ ] Step 4:header 渲染:`SCOPED_ROUTES.indexOf(route) !== -1 && sitesList.length > 0` 时插入 select(首项 `— All projects —` 值 '';options=sitesList;value=activeSite 且**失效校验**:activeSite 不在 sitesList → 视为 '' 并 `FS.siteContext.set(null)`)。onChange:`FS.siteContext.set(v||null)`;**特例**:`route === '/timeline'` 时再 navigate `'/timeline' + (v ? '?site='+encodeURIComponent(v) + (Router.getCurrentRoute().params.date ? '&date='+params.date : '') : '')`(丢 user——换项目重置人;timeline 的 URL ?site= 优先级高于 context,不重写 URL 会读到旧值)。注释说明这个特例的原因。
- [ ] Step 5:`node --check` 两 JS;bump;提交 `feat(a2): FS.siteContext + app-shell header project selector`。

---

### Task 2: Timeline 迁移到全局 context

**Files:** Modify `scripts/pages/timeline.js`;bump `?v=`。

**Interfaces (Consumes):** `FS.siteContext.get()/onChange/set`。
**现状锚点(侦察 B)**:TIMELINE_SITE_KEY 助手 :55-67;site 解析 :581-604(params.site || loadTimelineSite() || 单站自动 + 失效守卫);onChangeSite :609-615;PageHeader siteSelect :126-141(渲染于 :159);9 处 PageHeader 挂载传 site/sitesList/onChangeSite;SitePickerState :887-897;分节头显示名(AggregatedDayView 内,当前显示下划线 folder 格式)。

- [ ] Step 1:site 解析改为 `params.site || (window.FS.siteContext && window.FS.siteContext.get()) || (单站自动)`;失效守卫的清除动作改 `FS.siteContext.set(null)`(不再碰 timelineSite 键);删除 loadTimelineSite/saveTimelineSite 助手与 TIMELINE_SITE_KEY(收养逻辑在 siteContext 里)。
- [ ] Step 2:TimelineMiddleColumn 订阅 context:`useEffect(() => FS.siteContext.onChange(function(){ setParams(Object.assign({}, window.FS.Router.getCurrentRoute().params||{})); }), [])`——context 变化触发重渲染重解析(顶栏特例已重写 URL,此订阅兜底非 /timeline 入口的变化)。
- [ ] Step 3:删除 PageHeader 的 siteSelect 渲染与 site/sitesList/onChangeSite props(9 处挂载同步清理;**保留** PageHeader 的 `site` prop——onChangeDate 构造 qs 还要它,只删 sitesList/onChangeSite);`onChangeSite` 函数改为:`FS.siteContext.set(siteId||null)` + 原 navigate(SitePickerState 仍用它)。
- [ ] Step 4:分节头显示名修复:AggregatedDayView 人名行改 `unfolder(section.report.user_name || section.user.name || '')`(unfolder 已存在,下划线→空格)。
- [ ] Step 5:`node --check`;bump;提交 `feat(a2): timeline consumes global site context; header selector removed; section display-name fix`。

---

### Task 3: 聚合器 opts.site 参数(铁律:显式传参)

**Files:** Modify `scripts/api/compliance-aggregator.js`、`scripts/api/tasks-aggregator.js`、`scripts/api/user-activity-aggregator.js`;bump 各 `?v=`。

**Interfaces (Produces):** 三个出口新增可选 `opts.site`:
- `getSafetyRange({from,to,user?,site?})` / `getQualityRange(同)` —— `fanoutDates(from,to,user,site)`:`!user && site && caller 非 worker` 时 folders 来源改 `await FS.api.sites.getSiteUsers(site)` → `.users.map(deriveFolder)`(替代 adminUserFolders;catch 回退 adminUserFolders);`user` 显式给定时 site 忽略(单人优先)。
- `getActionsResolvedRange({from,to,user?,site?})`:同款(inline folders 构建处)。
- `getUserActivityRange({from,to,site?})`:`resolveVisibleUsers(site?)`——site 给定且 caller 非 worker 时:`getSiteUsers(site)` 的 users(异步化:该函数现同步读 fixtures,需 async 化并在调用处 await;mock 分支 getSiteUsers 按 u.sites 过滤 fixtures,行为等价)。
- **函数体内禁止读 FS.siteContext**(注释写明原因:Insights/strategic/search-palette 共用这些出口且必须全局视角)。

- [ ] Step 1:compliance-aggregator:`fanoutDates` 加第 4 参 site;admin 分支 folders 来源按上述改;两个出口透传 opts.site;函数头注释加铁律说明。
- [ ] Step 2:tasks-aggregator:同款(folders 构建 :92-105 处)。
- [ ] Step 3:user-activity-aggregator:resolveVisibleUsers async 化 + site 参数;getUserActivityRange 透传。
- [ ] Step 4:`node --check` 三文件;确认 insights-aggregator/strategic-aggregator/search-palette 的调用**零改动**(不传 site → 行为不变);bump;提交 `feat(a2): aggregators accept explicit opts.site (strategic callers untouched)`。

---

### Task 4: 五个数据页接 context

**Files:** Modify `scripts/pages/safety.js`、`quality.js`、`tasks.js`、`evidence.js`、`activity.js`;bump 各 `?v=`。

**Interfaces (Consumes):** T1 的 `FS.siteContext`、T3 的 opts.site。
**现状锚点(侦察 C)**:safety.js:118 / quality.js:122 `get*Range({from,to})`;tasks.js:149-152 fetchOpts;evidence.js:174-182 foldersPromise(自建 fan-out);activity.js:104-106。

- [ ] Step 1:每页 Provider:`activeSite` state(init `FS.siteContext.get()`)+ `useEffect(() => FS.siteContext.onChange(setActiveSite), [])`;fetch effect deps 加 `activeSite`。
- [ ] Step 2:safety/quality/tasks/activity:调用加 `site: activeSite || undefined`。
- [ ] Step 3:evidence:foldersPromise 改——`activeSite` 时 `getSiteUsers(activeSite)`(map deriveFolder,catch 回退现有 getUsers 路径),否则现状。
- [ ] Step 4:`node --check` 五文件;bump;提交 `feat(a2): scoped pages pass active site to aggregators`。

---

### Task 5: 全量检查 + Fable 终审 + PR + 验证

- [ ] Step 1:`node --check` 全部;busters 核对;确认 insights/strategic/search-palette 文件零 diff。
- [ ] Step 2:整分支 diff → **Fable 5** 终审(镜头:①聚合器铁律——grep 确认聚合器体内无 siteContext 读取;②豁免页零行为变化;③timeline URL ?site= 与 context 的优先级/同步(顶栏特例);④worker 路径不变;⑤mock 完整;⑥订阅泄漏/effect deps)。
- [ ] Step 3:修 Critical/Important → PR(base dev)。
- [ ] Step 4:合并部署后 Chrome 验证:顶栏选择器在 6 个数据页显示且同步;换项目 → Safety/Tasks 数据收敛到该项目;Insights/Portfolio 仍全局;Timeline 深链 ?site= 仍工作。

---

## 自审

- 铁律(D2)三重防护:Architecture 声明 + 聚合器注释 + Fable 镜头①。
- 豁免清单落实:Insights/strategic/search-palette 不传 site(T3 Step 4 验证零改动);Today 天然 caller-scoped(侦察 D1,零改动);Team/Sites 不在 SCOPED_ROUTES。
- Timeline 双源(URL vs context)一致性:URL 优先(深链),顶栏特例重写 URL,context 订阅兜底——三处闭环。
- 接口名一致:`FS.siteContext.get/set/onChange`、`opts.site`、`SCOPED_ROUTES` 贯穿。
- 遗留清理:timelineSite 键收养后废弃(T1),timeline 助手删除(T2)。
