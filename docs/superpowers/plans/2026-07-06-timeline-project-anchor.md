# 批次 A:项目锚定 Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development,逐任务执行,步骤 `- [ ]`。
> 用户拍板的设计:Timeline 顶部显著**项目选择器**(多项目者先选、单项目者自动锚定、记住上次);锚定后日历圆点=该项目有报告的日期;`(项目,日期)` 无 user 时=**聚合日视图**(该项目当天所有人的报告按人分节),点人名收敛单人深读;跨项目整体情况归 Insights(不在本批)。

**Goal:** Timeline 从 `(日期×单人)` 变为 `(项目,日期[,人])` 锚定:先选项目 → 聚合日视图 → 可收敛单人。

**Architecture:** 无 Provider(侦察证实 Right 面板完全从 `sel.user/user_name` 派生媒体,不需要共享状态);聚合状态在 Middle 内。数据面全部现成:`GET /api/sites`(site_id slug+name)、`GET /api/site-users?site=`(folder_name,含权限门)、`/api/dates?site=`(后端分支已存在)、单日 fan-out 用 `pooledAll`(compliance-aggregator 同款,单日期 × N 人)。角色行为服务端已保证:worker 聚合=只有自己、site_manager=自己+本站 worker——前端不用再做权限。

**Tech Stack:** 无构建浏览器 React;`node --check` + Chrome。

## Global Constraints

- 分支 `feature/timeline-project-anchor`;每文件 `node --check`;bump `?v=`;单行 Edit anchor;绝不 `git add -A`。
- **mock 模式必须完整工作**(mock getSites/getSiteUsers/getTimeline 都有 fixture 分支,聚合视图 mock 下同样跑通;不加 orgLive 门控——这是报告侧 API,双模一套代码)。
- 现有单人深读视图(site+date+user)**渲染代码不动**;deep-link(?topic=&flag=)只在单人视图生效(现状),聚合视图点 topic 走右栏,不需要 URL。
- 每个 navigate('/timeline?…') 必须保留 site 参数(丢了会退回选择器)。
- localStorage 键:`fs.settings.timelineSite`,存 `{ site: '<site_id>' }`(mirror range-toolbar 的 loadStored/saveStored 容错风格)。
- 聚合分节的 `onSelect` **必须携带该分节本人的 `user`(folder)+`user_name`**——右栏媒体(transcript/audio/photos)全部由 `sel.user`/`sel.user_name` 派生(timeline.js:954-959, :994-998),带错人=看错人的媒体。

---

### Task 1: dates.js + date-picker.js 支持 site 参数

**Files:** Modify `scripts/api/dates.js`、`scripts/composites/date-picker.js`;bump 两个 `?v=`。

**Interfaces:**
- Consumes:后端 `/api/dates?site=` 分支(lambda_fieldsight_api.py:313-316,已上线);`buildQuery` 丢空值(_fetch.js:51-59)。
- Produces:`FS.api.dates.getDates({months, site, user})` 三参齐;`DatePicker` 接受 `site` prop(与既有 `user` prop 并列,一同进 effect deps)。

- [ ] Step 1:`scripts/api/dates.js` getDates 的 live params 加 `site: opts.site`(紧挨 2026-07-06 加的 `user`,注释同风格:site 圆点=该项目任一人有报告的日期)。mock 分支不动(fixture 无 site 维度,现状)。
- [ ] Step 2:`scripts/composites/date-picker.js`:`var site = props.site || null;` 已存在(:267)——核实;取数 effect 的 getDates 调用(:302 附近,现为 `{months, site, user}` 里 site 已传)——**核实 site 是否已在传**(2b 前的代码就有 site prop);若已传则本任务只需确认 + 报告,不改。deps 需含 site(核实)。
- [ ] Step 3:`node --check` 两文件;若有改动 bump `?v=`;提交 `feat(timeline-anchor): dates api site param wired through`(若 Step 2 无改动,只提交 dates.js)。

---

### Task 2: timeline.js 站点基础设施(解析/选择器/导航保持)

**Files:** Modify `scripts/pages/timeline.js`;bump `?v=`。

**Interfaces:**
- Consumes:`FS.api.sites.getSites()`(live 返回 `{sites:[{site_id,name,location,client,user_count}], role, display_name}`;mock 为 fixture);localStorage `fs.settings.timelineSite`。
- Produces(后续任务依赖,名字必须一致):
  - 模块级 `function loadTimelineSite()` → `'<site_id>'|null`(try/catch JSON.parse localStorage)
  - 模块级 `function saveTimelineSite(siteId)`(存 `{site: siteId}`;null 则 removeItem)
  - `TimelineMiddleColumn` 内解析出的 `var site`(见 Step 2)与 `sitesList` state
  - `PageHeader` 新 props:`site`(site_id)、`sitesList`(数组)、`onChangeSite(siteId)`

- [ ] Step 1:模块级加 `loadTimelineSite`/`saveTimelineSite`(mirror range-toolbar loadStored/saveStored 的 try/catch 风格,键 `fs.settings.timelineSite`)。
- [ ] Step 2:`TimelineMiddleColumn` 的 (date,user) 解析块(:264-269)扩为 (site,date,user):
  ```js
  var site = params.site || loadTimelineSite() || null;
  ```
  并加一个 sites 列表 state + 一次性 effect:`FS.api.sites.getSites()` → `setSitesList(res.sites||[])`(cancelled 守卫;失败置 `[]`)。**自动锚定**:sitesList 加载后,若 `!site && sitesList.length===1` → 视为选中该站(不必写 URL,直接用);worker(caller.role==='worker')同理用其唯一可及站点(sitesList 对 worker 本就只回自己的站)。
- [ ] Step 3:`PageHeader`(:81-147)加站点选择器:props 增 `site/sitesList/onChangeSite`;在 DatePicker 上方渲染一个紧凑 `<select>`(mirror sites.js 的 fSelect/`.fs-settings__select` 样式,value=site,options=sitesList 的 {site_id,name},首项 `{v:'',l:'— Select a project —'}`)。`onChange` → `props.onChangeSite(v)`。选择器**始终可见**(单站点时也显示、只有一项,给用户确定感)。
- [ ] Step 4:`TimelineMiddleColumn` 实现 `onChangeSite(siteId)`:`saveTimelineSite(siteId||null)`;navigate `'/timeline?site='+siteId+(date?'&date='+date:'')`(**清掉 user**——换项目必须重置人);空值则 navigate `/timeline`(回选择器态)。
- [ ] Step 5:**导航保持 site**:改所有 navigate 调用点带上 `&site=`(:102-103 onChangeDate、:143 "View another user"、:211 AvailableUsersState user 按钮、:307 日期 bootstrap)。onChangeDate 的 qs 构造改为 `date + (site?'&site='+site:'') + (u?'&user='+u:'')`。
- [ ] Step 6:PageHeader 挂载处(:612 及 meeting 分支的对应处)传新 props;DatePicker(:129-140)加 `site: (user ? null : site)`——**user 优先**(选定人时圆点跟人,否则跟项目;两者都无则维持现状 union)。
- [ ] Step 7:`node --check`;bump `?v=`;提交 `feat(timeline-anchor): site resolution + header selector + nav persistence`。

---

### Task 3: 聚合日视图(site+date 无 user)

**Files:** Modify `scripts/pages/timeline.js`;bump `?v=`。

**Interfaces:**
- Consumes:Task 2 的 `site` 解析;`FS.api.sites.getSiteUsers(site)` → `{users:[{folder_name,name,role,...}]}`;`FS.api.pooledAll(thunks, 8)`(compliance-aggregator.js:228-256 同款);`getTimeline({date,user})`(报告 or `{_notFound}` or `{available_users}` 信封)。
- Produces:新组件 `AggregatedDayView`(props: `{ site, date, onSelect }`)+ Middle 的新渲染分支。

- [ ] Step 1:新组件 `AggregatedDayView`(放 AvailableUsersState 之后):内部 state `{status:'loading'}`;effect(deps `[props.site, props.date]`,cancelled 守卫):
  ```js
  var res = await window.FS.api.sites.getSiteUsers(props.site);
  var users = (res && res.users) || [];
  var thunks = users.map(function(u){ return function(){
    return window.FS.api.timeline.getTimeline({ date: props.date, user: u.folder_name })
      .then(function(r){ return { user: u, report: r }; });
  };});
  var results = (await window.FS.api.pooledAll(thunks, 8)).filter(Boolean);
  if (thunks.length > 0 && results.length === 0) throw new Error('Could not load reports — all requests failed. Please retry.');
  var withReports = results.filter(function(x){ return x.report && !x.report._notFound && !x.report.available_users && !x.report._accessDenied; });
  ```
  `setState({status:'ok', sections: withReports})`;catch → `{status:'error'}`(渲染 ErrorBanner + retry 计数)。
- [ ] Step 2:渲染:`sections.length===0` → 复用 `NoReportState`(message `'No reports for this project on ' + formatDateLabel(date)`)。否则每个 section:
  - 人名分节头(`fs-timeline-page__section-head` 新 class,或简单 `<h3>`+`.fs-timeline-page__empty-title` 复用):`section.report.user_name` + 右侧小按钮 `'View only ' + first-name` → navigate `'/timeline?site='+site+'&date='+date+'&user='+section.user.folder_name`;
  - 该人的 `ReportKpis({report})` + `ExecutiveSummaryCard({bullets: report.executive_summary})` + topic 列表——**照抄** :620-663 的 TopicCard map,但 `onSelect` payload 的 `user` 用 `section.user.folder_name`、`user_name` 用 `section.report.user_name`(Global Constraints 红线);`selected`/`highlight`/deep-link 相关 prop 在聚合视图传 false/null(deep-link 只在单人视图)。`actionState` 传 `{}`(聚合视图不接 actions 勾选——单人视图才有;注释注明)。
  - **不渲染 AskChat**(单报告作用域,聚合下歧义;注释注明留给 Phase 4)。
- [ ] Step 3:Middle 渲染分支重排(:445-508 区域):在 available_users 分支**之前**加两个新分支:
  1. `!site && sitesList 已加载 && sitesList.length > 1 && !user` → **SitePickerState**(新小组件,mirror AvailableUsersState 卡片:标题 'Pick a project'、sitesList 按钮列表 → `onChangeSite(site_id)`);sitesList 还在加载则维持 loading。
  2. `site && !user` → `AggregatedDayView({site, date, onSelect: props.onSelect})`(date 未定时先走既有 bootstrap)。
  既有 available_users/no-report 分支保留(`site` 为空且单站点解析不出时的后备)。**注意**:主 fetch effect(:314-370)在 `site && !user` 时**跳过**单人 getTimeline(聚合组件自己取数)——effect 开头加 `if (site && !user) { setState({status:'ok', report:null, aggregated:true, actions:{}, meeting:null}); return; }` 之类的短路,渲染分支以 `site && !user` 判定优先于 report 判定。实现者自行选择最小重构,但**单人路径行为必须逐字节不变**。
- [ ] Step 4:单人视图(site+date+user)的 "View another user ↺" 按钮(:143 附近)改为:site 存在时文案 `'← All people on this site'`,onClick navigate `'/timeline?site='+site+'&date='+date`(清 user);site 不存在时保持原行为。
- [ ] Step 5:`node --check`;bump `?v=`;提交 `feat(timeline-anchor): aggregated day view (per-person sections) + site picker state`。

---

### Task 4: 日期 bootstrap site 感知 + 收尾一致性

**Files:** Modify `scripts/pages/timeline.js`;bump `?v=`。

- [ ] Step 1:日期 bootstrap(:290-312):有 `site` 时改用 `FS.api.dates.getDates({months:24, site: site})` 取最新有报告日期(替代现 getTimeline 探测/getDates 无参),navigate 带 site。无 site 保持原逻辑。
- [ ] Step 2:worker 强制自身逻辑(:267-269)保持;确认 worker 进入时:site 自动锚定其站点 + user 强制自己 → 直接单人视图(现状体验不变)。
- [ ] Step 3:全文 grep `'/timeline?'` 确认所有 navigate 均已带 site(含 Task 2 Step 5 清单外的遗漏:search-palette 的 doAsk 导航、sites.js 的 openTimeline、team.js 的 navReports——**这三处在别的文件**:sites.js/team.js 的跳转带上 `&site=`(sites.js 有 site_id 在手;team.js 用成员 primary_site,若为 org UUID 而非报告 slug 则**不带**——注释注明身份系差异,留 device-mgmt 批);search-palette 只带 date+user 维持(Ask 移交毕竟单人)。实现者逐处判断并在报告列出。
- [ ] Step 4:`node --check` 所有改动文件;bump `?v=`;提交 `feat(timeline-anchor): site-aware date bootstrap + cross-page nav consistency`。

---

### Task 5: 全量检查 + Fable 终审 + PR + 部署验证

- [ ] Step 1:`node --check` 全部改动文件;busters 核对。
- [ ] Step 2:整分支 diff → **Fable 5** 终审(重点:①聚合 onSelect 的 user/user_name 红线;②单人路径逐字节不变;③site 参数在所有导航闭环不丢;④mock 模式聚合视图可用;⑤fan-out 信封处理/全失败 throw;⑥worker/site_manager 角色路径)。
- [ ] Step 3:修 Critical/Important → 复审 → PR(base dev)。
- [ ] Step 4:合并部署后 Chrome 验证(以当时登录角色):选择器渲染、选项目 → 聚合日视图多人分节、点人收敛、日历圆点跟项目、mock 不回归。

---

## 自审

- 设计四态覆盖:无站(>1 站)=SitePicker;站+日=聚合;站+日+人=单人(不动);worker=自动锚定+强制自己。
- 数据面零后端改动(sites/site-users/dates?site=/timeline 全现成);权限服务端已管(site_manager 只见自己+worker,worker 只见自己——聚合视图天然按角色缩放)。
- 红线三条写进 Global Constraints:onSelect 带对人、单人路径不变、导航不丢 site。
- 接口名一致性:loadTimelineSite/saveTimelineSite/onChangeSite/AggregatedDayView/SitePickerState 贯穿 T2-T4。
- 已知取舍(记录):聚合视图无 actions 勾选、无 AskChat、无 deep-link——都归单人视图;org 站点 UUID ≠ 报告站点 slug 的身份系差异不在本批解决。
