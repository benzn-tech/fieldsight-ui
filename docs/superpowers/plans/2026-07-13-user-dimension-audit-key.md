# 动作审计键补用户维度(user-dimension audit key)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development,逐任务执行,步骤 `- [ ]`。
> 涉及两个仓库:UI `C:/Users/camil/Dropbox/fieldsight-ui`(dev 分支)+ 后端 `C:/Users/camil/Dropbox/fieldsight-pipeline`。后端部署命令需用户授权。

**Bug:** 动作勾选状态按 `(date, topic_id, action_index)` 存储,**没有 report-owner 维度**。`topic_id` 每份报告都从 0 重新计数 → 同一天两个不同用户的报告各有 "topic 0 / action 0",落在**同一条**审计记录上:勾 A 的项也勾了 B 的。当前潜伏(现网数据 0 冲突——每个有动作的日期恰好只有一个 owner),多用户同日出数据后必然显形,且会污染批量清理。

**Goal:** DynamoDB 审计键加 `user_folder`(= report OWNER 的文件夹,**不是** caller;caller 已有 `checked_by`),后端双形状兼容 + 一次性回填迁移 + 前端全部读写点穿线。

---

## 0. 侦察结论(2026-07-13 全部实测核实;含一处关键纠偏)

### 0.1 ⚠️ 关键纠偏:actions 流量走的是 `fieldsight-api`,不是 `fieldsight-test-api`

任务简报称 "This lambda is fieldsight-test-api"。**实测证据链与此不符**,两个 lambda 都要部署:

| 证据 | 实测值 |
|---|---|
| Amplify app `fieldsight-ui`(d2fssznicvuckr)dev 分支环境变量 | `FS_BASEURL=https://khfj3p1fkb.execute-api...` `FS_ORG_BASEURL=https://wdsgobb7b0...` |
| `actions.js` 走 `FS.api.request('/actions…')` → baseUrl | 即 khfj3p1fkb |
| API GW `khfj3p1fkb`("fieldsight-api")`/api/{proxy+}` 集成 | **lambda `fieldsight-api`**(LastModified 2026-04-21;zip 仅 2 文件,代码是 2026-03-26 版,**没有** checked_by/checked_at 响应修复) |
| `fieldsight-api` 环境变量 | `AUDIT_TABLE=fieldsight-audit`、`S3_BUCKET=fieldsight-data-509194952652` |
| `fieldsight-audit` 表 ACTIONS# 记录 | **37 条(31 条 checked)**,最新写入 2026-07-06(Ben Lin)——现网真实数据在这里 |
| `fieldsight-test-api`(org 网关 wdsgobb7b0 后面,服务 /ask /search /org) | 环境 `AUDIT_TABLE=fieldsight-test-audit`;live 代码 == repo `src/lambda_fieldsight_api.py`(今日部署,含响应修复);CodeSha256 锚 `wH67XgPTACnHnYbZmkMtg6cKmi+1QNiER52xDr9NJZ0=` |
| `fieldsight-test-audit` 表 | **空(Scanned 0)**——它的 actions 端点没有流量 |

推论:①本次改键+回填的**真目标**是 `fieldsight-api` + `fieldsight-audit`;②"刚修好"的 toggle 响应 checked_by/checked_at 只落在了 test-api 上,现网 actions 流量**并未享受到**——本次一并带给 fieldsight-api;③repo src 与 test-api 保持同源照常部署,两边 actions 函数保持一致;④`fieldsight-api` live 代码与 repo HEAD 相差 285 行(/ask、/search 实现不同),**不能整文件覆盖**,只能外科手术式替换 toggle_action/get_actions 两个函数(见 Task 3)。

### 0.2 现有数据(fieldsight-audit,已逐条扫描)

37 条现状记录(`PK=ACTIONS#{date}`,`SK=TOPIC#{tid}#ACTION#{idx}`),分布 6 个日期;SK 的 idx 有三种形态:数字(action_items)、`flag_<n>`(safety flags)、`obs_<n>`/`quality`(observations/质量,tid 可为 -1)。每个日期在 S3 `reports/{date}/` 下**恰好一个** owner 文件夹(已逐日核实):

| 日期 | 记录数(勾) | owner 文件夹 |
|---|---|---|
| 2026-02-09 | 26(24) | Jarley_Trainor |
| 2026-02-25 | 1(0) | Jarley_Trainor |
| 2026-02-26 | 4(2) | Jarley_Trainor |
| 2026-03-02 | 2(2) | Jarley_Trainor |
| 2026-03-09 | 3(2) | David_Barillaro |
| 2026-04-07 | 1(1) | Ben_Test |

→ owner 派生**零歧义**,不需要扫报告内容匹配。`AUDIT#{date}` 追加日志:后端只写不读(全代码 grep 确认),**不迁移**,新写入起加 `user_folder` 属性即可。

### 0.3 前端读写点全景(每一处 owner 都可得——crux 有解)

| 站点 | 角色 | owner 来源 |
|---|---|---|
| `scripts/api/actions.js` | API 模块(actionKey/getActions/toggleAction/mock) | 透传 opts.user_folder |
| `scripts/api/actions-bus.js` | 总线(仅文档;emit/subscribe 泛型) | payload 加 user_folder |
| `scripts/composites/action-item-row.js` :87/:105/:126 | 行级 toggle + bus 身份键 | 新 prop `userFolder`(父组件传) |
| `scripts/composites/topic-card.js` :238 | actionState 查表 + 传 prop | 新 prop `userFolder` |
| `scripts/pages/timeline.js` :864/:1172(单人视图) | bus 写表 + TopicCard | `folderName(report.user_name)`(⚠️ 自看时页面 `user` 参数为 null,必须从 report 派生) |
| `scripts/pages/timeline.js` :359/:489(AggregatedDayView) | bus 写表 + 分节 TopicCard | `section.user.folder_name`(sectionUser) |
| `scripts/pages/timeline.js` :1298/:1463(右栏 OverviewTab) | 查表 + bus 写表 | `sel.user \|\| folderName(sel.user_name)`(两个 onSelect payload :506-515/:1191-1198 都带,mediaProps :1512 已用同式) |
| `scripts/api/today-adapter.js` :346-383 | 状态查表 + task item 生成 | `ctx.idPrefix \|\| folderName(report.user_name)`;**给每个 task item 加 `folder` 字段** |
| `scripts/pages/today.js` :612(keep)/:771(bus 谓词)/:1384(Mark complete) | 查表/移除匹配/toggle | `item.folder`(adapter 新字段)/`payload.user_folder` |
| `scripts/composites/task-card.js` :79 | toggle | `task.folder` |
| `scripts/api/tasks-aggregator.js` :195/:250-287 | 查表 + getCrossDayAudit 键解析 | `folderName(r.user_name)`(:208 已算,hoist) |
| `scripts/pages/tasks.js` :454/:569 | Mark complete + ActionHistoryPanel 键 | `row.user_folder`(行已带) |
| `scripts/api/compliance-aggregator.js` :578/:619/:776 | flag/obs/quality 三处查表 | `folder`(:563/:740 已算) |
| `scripts/pages/safety.js` :459 / `quality.js` :466 | resolve toggle | `sel.user_folder`(compliance 行已带) |
| `scripts/api/user-activity-aggregator.js` :233 | 查表 | `rec.user.folder_name`(fan-out 键即 owner) |

**零改动确认**(消费聚合行、不直接碰键):search-palette、insights-aggregator、strategic-aggregator、suggestion-review(仅注释)、programme.js :1666(React list key,非审计键)。task-card/tasks 行 id 只作不透明标识(React key、removeRow、选中比对),无解析方 → 可安全加 folder 段。

---

## 1. 设计决策

### 1.1 键形:SK 前缀方案(方案 B)

**新 SK:`USER#{user_folder}#TOPIC#{topic_id}#ACTION#{action_index}`,PK 不变 `ACTIONS#{date}`。**

弃 `PK=ACTIONS#{date}#{user_folder}`(方案 A)的理由:所有读者都按"整天、跨用户"取数——compliance fanoutDates、timeline AggregatedDayView、today 双路径、getActionsRange 全是**一天一次** `getActions(date)` 调用覆盖所有用户。PK 带 user 会把一次 query 裂成 N 次(聚合页 'All' 档已 150+ 请求,再乘用户数不可接受),且前端多处调用点根本没有用户清单。方案 B:一次 query 不变、新旧 SK 同 PK 下天然共存(混读免费)、无需新表/GSI。folder 校验 `^[A-Za-z0-9_\-]{1,64}$`(不含 `#`/`|`,解析无歧义;现网 folder 形如 `Jarley_Trainor` 全部合规)。

### 1.2 API 响应:双形状,新前端只信 `actions_v2`

`get_actions` 返回:
- `actions` — **旧形状**(全部记录坍缩成裸键 `<tid>_<idx>`,新键记录也坍缩进来)。语义 == 今天(含碰撞),纯为旧前端过渡期兼容。
- `actions_v2` — 新 flat map:新键记录 → `<folder>|<tid>_<idx>`;**真·遗留**(未迁移)记录 → 保留裸键 `<tid>_<idx>`。

**防回归铁律:新前端只读 actions_v2(缺失时整体回退 actions == 今天行为)。绝不允许 composite miss 后回退查坍缩 `actions` map** —— 迁移完成后 A 用户有记录、B 用户无记录时,坍缩 map 的裸键会让 B 误命中 A 的记录,**原 bug 借尸还魂**。v2 里的裸键只可能来自真遗留记录,迁移+清扫后为零 → 跨用户误命中为零。

### 1.3 前端统一助手(所有读写点只走这两个函数)

```js
/* actions.js 内,挂 FS.api.actions */
function actionKey(user_folder, topic_id, action_index) {   // 签名变更!(原 (topic_id, action_index))
  var bare = topic_id + '_' + action_index;
  return user_folder ? (user_folder + '|' + bare) : bare;
}
function lookupAction(map, user_folder, topic_id, action_index) {
  if (!map) return undefined;
  var bare = topic_id + '_' + action_index;
  return (user_folder ? map[user_folder + '|' + bare] : undefined) || map[bare]; // 裸键=遗留回退
}
```
分隔符用 `|`(folder 含下划线,`_` 不可作分隔)。bus 身份键升级为 `${date}|${user_folder}|${topic_id}_${action_index}`;payload 加 `user_folder`。

### 1.4 迁移:选 (a) 回填,弃 (b) clean break

- (b) 会丢 **31 个勾**(不是简报估的 ~18),含 Jarley 的真实现场核销数据 → 不推荐。
- (a) 成本极低:owner 派生零歧义(§0.2 每日期单 owner),脚本 ~80 行 Node(BUG-29 本机无 python),dry-run + 幂等可重跑。兜底规则(现状用不到,防未来重跑):某日期 >1 个 owner 文件夹时,逐 folder 读 `daily_report.json`,owner = 含该 `topic_id` 且 `action_index` 在界内且 `action_text` 相符的那份;仍歧义 → 留在旧键(裸键回退继续工作)并打印人工清单。

### 1.5 混读/混版安全窗口

| 阶段 | 旧前端(Amplify 未发) | 新前端 |
|---|---|---|
| 新后端已上、未回填 | 读 `actions`(坍缩)、toggle 写旧键 —— 行为 == 今天 | 读 v2:全裸键 → lookupAction 回退命中 == 今天行为 |
| 回填后、前端未发 | 同上;**期间新 toggle 仍写旧键** | v2 = composite 为主 |
| 前端已发 | — | toggle 带 user_folder 写新键;读 composite 优先 |
| **收尾** | Amplify 上线后**再跑一遍回填**清扫窗口期旧键 | 之后 v2 无裸键 |

---

## Global Constraints

- **UI repo**:分支 `feature/user-dim-audit-key`(基于 dev);每文件 `node --check`;bump 所有被改脚本在 `app-shell-preview.html`(+`components-preview.html` 若加载)的 `?v=`;单行 Edit anchor(CRLF 混排);遵守 no-build-step。
- **pipeline repo**:新开分支(基于 develop);**绝不 `git add -A`**;只 add 点名文件。
- **防回归铁律(§1.2)**:新前端任何读点不得回退查坍缩 `actions` map;遗留回退只经 `lookupAction` 的 v2 裸键。
- **owner ≠ caller**:`user_folder` 永远是 report owner 的文件夹;`checked_by` 才是 caller。任何站点不得拿 `AuthMock.currentUser` / session 当 owner。
- timeline 单人视图 owner 必须 `folderName(report.user_name)` 派生,不得用 URL `user` 参数(自看时为 null)。
- 后端部署 = 手动 `update-function-code`(两个函数,见 Task 3),命令需用户授权;Windows CLI 陷阱全程生效:BUG-27(`fileb://$(cygpath -w …)`)、BUG-28(`MSYS_NO_PATHCONV=1`)、BUG-29(JSON 处理用 Node)、BUG-30(zip 工作目录用 Windows 可见路径,别用 Git Bash `/tmp` 喂 PowerShell)、BUG-35(`AWS_CLI_FILE_ENCODING=UTF-8 PYTHONUTF8=1`)、BUG-22(部署后核对 live 代码)。
- 部署顺序:**后端(双 lambda)→ 回填 → 前端 PR→dev→Amplify → 二次回填清扫**。后端先行且向后兼容(旧前端不感知)。
- 本机无 python(BUG-29):后端改动的语法验证靠部署后 `/api/health` + 实测 toggle/get(Task 3),代码审查从严。

---

### Task 1: 后端 toggle_action / get_actions 改造(pipeline repo,repo src 即 test-api 同源)

**Files:** Modify `src/lambda_fieldsight_api.py`(:609 toggle_action、:656 get_actions、:22-23 路由文档、版本注释)。

**Interfaces (Produces):**
- `POST /api/actions/toggle` body 新增可选 `user_folder`;合法性 `re.fullmatch(r'[A-Za-z0-9_\-]{1,64}', …)`,非法 → 400;缺失 → 写旧键(旧前端过渡)。响应加 `user_folder`。
- `GET /api/actions?date=` → `{ date, actions: {…旧形状坍缩…}, actions_v2: {…§1.2…} }`。

- [ ] Step 1:`toggle_action`:解析+校验 `user_folder`;`sk = f"USER#{user_folder}#TOPIC#{topic_id}#ACTION#{action_index}"`(缺失时保持旧式);两条 put_item(现状 + AUDIT 日志)各加 `'user_folder': user_folder or ''` 属性(AUDIT SK 不变——无读者);响应 dict 加 `'user_folder': user_folder or None`(保留 checked_by/checked_at 字段)。
- [ ] Step 2:`get_actions`:遍历 Items,`sk.split('#')`:`USER#` 开头且 ≥6 段 → `folder,tid,idx = parts[1],parts[3],parts[5]`,legacy_key=`f"{tid}_{idx}"`,v2_key=`f"{folder}|{legacy_key}"`;否则 ≥4 段 → 旧解析,v2_key=legacy_key。`actions[legacy_key]=audit` 且 `actions_v2[v2_key]=audit`。返回双字段。(idx 可为 `flag_0`/`obs_0`/`quality`、tid 可为 `-1` —— 均不含 `#`,split 安全。)
- [ ] Step 3:文件头 Routes 注释 + 版本注释更新(体现 user_folder + actions_v2)。
- [ ] Step 4:自查:grep 确认无其他函数读写 `ACTIONS#`/`AUDIT#`(现状仅这两函数);commit(pipeline 分支)`feat(api): user-dimension audit key — USER# SK + dual-shape get_actions`。

---

### Task 2: 回填脚本(pipeline repo)

**Files:** Create `scripts/backfill-audit-user-dimension.js`(Node,shell 出 aws cli,零 npm 依赖)。

**Interfaces:** `node scripts/backfill-audit-user-dimension.js --table fieldsight-audit --bucket fieldsight-data-509194952652 [--apply]`(默认 dry-run)。

- [ ] Step 1:scan `begins_with(PK,'ACTIONS#')` 且 SK `begins_with 'TOPIC#'`(只取未迁移);先把全部原始 items dump 到 `backfill-backup-<ts>.json`(回滚保险)。
- [ ] Step 2:按日期解析 owner:`aws s3api list-objects-v2 --prefix reports/{date}/ --delimiter /` → CommonPrefixes;恰 1 个 → owner;>1 → §1.4 兜底(读各 daily_report.json 匹配 topic_id/action_index/action_text);歧义 → 跳过并列入人工清单。
- [ ] Step 3:每条:put 新 item(全属性拷贝 + `user_folder`,SK=USER#…)→ 成功后 delete 旧 item。dry-run 只打印 `旧SK → 新SK (owner)` 映射表。幂等:重跑时 scan 无 TOPIC# SK → no-op。
- [ ] Step 4:dry-run 实跑一次,人工核对 37 行映射与 §0.2 表一致(4 日期→Jarley_Trainor、03-09→David_Barillaro、04-07→Ben_Test);commit `feat(ops): audit user-dimension backfill script (dry-run verified)`。

---

### Task 3: 部署双 lambda + 回填 + live 冒烟(需用户授权)

**目标函数:两个。** `fieldsight-api`(现网 actions 流量,外科手术)+ `fieldsight-test-api`(repo 同源整文件)。

- [ ] Step 1 **回滚锚**:两函数各 `aws lambda publish-version` 并记录 CodeSha256(test-api 现值 `wH67XgPTACnHnYbZmkMtg6cKmi+1QNiER52xDr9NJZ0=`;fieldsight-api 部署前抓取)。
- [ ] Step 2 **fieldsight-test-api**:下载 live zip(53 文件、~650KB)→ 换入 repo `src/lambda_fieldsight_api.py` → PowerShell `Compress-Archive` 重打包(工作目录用 Windows 路径,BUG-30)→ `aws lambda update-function-code --function-name fieldsight-test-api --zip-file "fileb://$(cygpath -w …)"` → `aws lambda wait function-updated`。
- [ ] Step 3 **fieldsight-api(外科手术)**:下载 live zip(**仅 2 文件**:lambda_fieldsight_api.py 2026-03-26 版 + transcript_utils.py)→ **只替换 `toggle_action` + `get_actions` 两个函数体**为 Task 1 的新实现(该 live 版与 repo HEAD 差 285 行,/ask /search 实现不同,且旧 CloudFront 前端可能还依赖 —— **禁止整文件覆盖**)→ 重打包 2 文件 zip → update-function-code → wait。⚠️ 顺带效应(有意):现网 toggle 响应从此带 checked_by/checked_at(此前该修复只在 test-api)。patched 文件与两 CodeSha256 记入 PR 描述(prod 变体不在 git 的漂移债记 ROADMAP 跟进项:两 lambda 归一)。
- [ ] Step 4 **验证部署**(BUG-22):重新下载两函数 live zip,grep `USER#`、`actions_v2` 存在;`GET /api/health` 200。
- [ ] Step 5 **回填**:`node scripts/backfill-audit-user-dimension.js --table fieldsight-audit --bucket fieldsight-data-509194952652 --apply`;验证:scan 遗留 `TOPIC#` SK = 0、`USER#` SK = 37;`fieldsight-test-audit` 空表无需处理。
- [ ] Step 6 **live 冒烟(双用户独立性,合成数据)**:取 idToken(登录 dev UI 从 devtools 拷,或 `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH`,池 ap-southeast-2_q88pd6XXr);对 khfj3p1fkb:
  1. `POST /api/actions/toggle {date:'2099-01-01',topic_id:0,action_index:0,checked:true,user_folder:'User_A',action_text:'synthetic A'}`
  2. 同键 `user_folder:'User_B', checked:false`
  3. `GET /api/actions?date=2099-01-01` → `actions_v2['User_A|0_0'].checked===true` 且 `actions_v2['User_B|0_0'].checked===false` **互不影响**;`actions['0_0']` 存在(旧形状仍活)。
  4. 无 user_folder 的 toggle(模拟旧前端)→ 仍 200、写旧键、v2 出现裸键。
  5. 清理:`aws dynamodb delete-item` 三条合成记录。
- [ ] Step 7 **旧前端回归**:现网 dev UI(未发新前端)勾/取消一个真实动作项 → 正常;GET 旧形状不变。

---

### Task 4: UI 核心 — actions.js + actions-bus + action-item-row

**Files:** Modify `scripts/api/actions.js`、`scripts/api/actions-bus.js`(文档)、`scripts/composites/action-item-row.js`。

**Interfaces (Produces):**
- `FS.api.actions.actionKey(user_folder, topic_id, action_index)`(**签名变更**,§1.3)+ 新 `FS.api.actions.lookupAction(map, user_folder, topic_id, action_index)`。
- `toggleAction(opts)` 接受 `opts.user_folder`:live body 带 user_folder;成功/失败两处 bus emit 均带 `user_folder`;mock 路径 `state[date][actionKey(user_folder,…)]`。
- `getActions(date)` live 路径归一化:`if (res && res.actions_v2) res.actions = res.actions_v2; return res;` —— 消费方继续读 `res.actions`,新后端拿 v2、旧后端/mock 拿旧 map(行为不劣化)。getActionsRange 机制不变(byDate 值即 v2 map)。
- bus payload 形状 + 身份键文档更新为 `${date}|${user_folder}|${topic_id}_${action_index}`。
- ActionItemRow 新 prop `userFolder`(缺失时容忍——裸键行为):myKey/theirKey 用新身份键(payload.user_folder 与自身 userFolder 都取 `|| ''`)、toggleAction 传 user_folder、成功 emit 带 user_folder。

- [ ] Step 1:actions.js 改造(actionKey 签名 + lookupAction + toggleAction + getActions 归一化 + createAction mock 键)。文件头注释更新 §4.10 新形状。
- [ ] Step 2:actions-bus.js 文档块更新(payload + 键推导)。
- [ ] Step 3:action-item-row.js(:87/:90 身份键、:105 toggle、:126 emit、props 文档)。
- [ ] Step 4:`node --check` 三文件;commit `feat(actions): user-dimension key — actionKey/lookupAction + bus/user_folder + ActionItemRow userFolder`。

---

### Task 5: timeline 三视图 + topic-card

**Files:** Modify `scripts/composites/topic-card.js`、`scripts/pages/timeline.js`。

- [ ] Step 1:topic-card.js:新 prop `userFolder`;:238-239 查表改 `FS.api.actions.lookupAction(actionState, userFolder, topic.topic_id, idx)`;ActionItemRow 传 `userFolder`;props 文档。
- [ ] Step 2:timeline.js 单人视图:TopicCard 挂载(:1172 起)加 `userFolder: report.user_name ? window.FS.api.folderName(report.user_name) : null`(**不用页面 `user` 参数**);bus 写表(:864)键改 `FS.api.actions.actionKey(payload.user_folder, payload.topic_id, payload.action_index)`。
- [ ] Step 3:AggregatedDayView:TopicCard(:489)加 `userFolder: sectionUser`;bus 写表(:359)同 Step 2 键式;顺带更新 :322-351 两段"follow-up task"注释(本 plan 即那个 follow-up)。
- [ ] Step 4:右栏:TimelineRightDetail 算 `ownerFolder = sel.user || (sel.user_name && window.FS.api.folderName(sel.user_name)) || null`,传给 OverviewTab;OverviewTab(:1298-1314)查表用 lookupAction、ActionItemRow 传 `userFolder`;bus 写表(:1463)同键式。
- [ ] Step 5:`node --check`;commit `feat(timeline): thread report-owner folder through action audit key (all 3 views)`。

---

### Task 6: today 路径 — adapter + 页面 + task-card

**Files:** Modify `scripts/api/today-adapter.js`、`scripts/pages/today.js`、`scripts/composites/task-card.js`。

- [ ] Step 1:today-adapter.js:adapt() 内算 `ownerFolder = ctx.idPrefix || (report.user_name ? window.FS.api.folderName(report.user_name) : null)`(注意 :248 的 idPrefix 局部变量带尾 `_`,取 **ctx.idPrefix 原值**);:346-347 查表改 lookupAction;每个 task 对象(:349-383)加 `folder: ownerFolder`;文档更新。
- [ ] Step 2:today.js:keep()(:612-613)改 `FS.api.actions.lookupAction(actionState, item.folder, item.topic_id, item.actionIndex)`;bus 移除谓词(:771-775)加 folder 匹配:双方都有值时须相等(`payload.user_folder && t.folder && t.folder !== payload.user_folder → 不移除`),任一缺失沿用旧宽松匹配(遗留容忍);右栏 onMarkComplete(:1384)加 `user_folder: item.folder`;:752-760 的 "Ambiguity note" 注释更新(已修复)。
- [ ] Step 3:task-card.js:toggleAction(:79)加 `user_folder: task.folder`;props 文档。
- [ ] Step 4:`node --check` 三文件;commit `feat(today): rolling items carry owner folder; check-off keyed per-user`。

---

### Task 7: tasks 路径 — aggregator + 页面

**Files:** Modify `scripts/api/tasks-aggregator.js`、`scripts/pages/tasks.js`。

- [ ] Step 1:tasks-aggregator.js:flatten(:190-217)hoist `var folder = r.user_name ? window.FS.api.folderName(r.user_name) : null;`;:195 查表改 `lookupAction(auditByDate[x.date], folder, t.topic_id, idx)`;**row id 加 folder 段**(:197 → `x.date + '_' + (folder||'') + '_' + t.topic_id + '_' + idx` —— 同族潜伏 bug:两用户同日同 tid/idx 的行 id 撞车会让 React key/removeRow 双杀;id 是不透明标识,已核实无解析方)。
- [ ] Step 2:getCrossDayAudit(:268-284):键解析先按 `indexOf('|')` 拆 folder/bare,entry 加 `user_folder`,`topic_action_key` 保留完整键(composite 或遗留裸键),topic_id/action_index 从 bare 解析。
- [ ] Step 3:tasks.js:onMarkComplete(:454)加 `user_folder: row.user_folder`;ActionHistoryPanel(:569)匹配键改:命中 `row.user_folder + '|' + bare` **或** 裸 bare(遗留记录仍显示历史)。
- [ ] Step 4:`node --check`;commit `feat(tasks): audit lookup + row ids + cross-day audit keys gain user dimension`。

---

### Task 8: compliance 路径 — aggregator + safety/quality + activity

**Files:** Modify `scripts/api/compliance-aggregator.js`、`scripts/pages/safety.js`、`scripts/pages/quality.js`、`scripts/api/user-activity-aggregator.js`。

- [ ] Step 1:compliance-aggregator.js 三处查表:`:578` → `lookupAction(checkedMap, folder, t.topic_id, 'flag_'+idx)`、`:619` → `lookupAction(checkedMap, folder, -1, 'obs_'+idx)`、`:776` → `lookupAction(checkedMap, folder, t.topic_id, 'quality')`;:224-228 注释更新("Actions are keyed by date only (not by user)" 已不成立)。
- [ ] Step 2:row id 加 folder 段(:581 flag、:622 obs、:750 qc、quality topic 行):在 date 段后插 `'_' + (folder||'')`。预检:safety.js :431-433 的 `/_flag_(\d+)$/`、`/_obs_(\d+)$/` 锚定行尾,folder 插中段不影响;grep 确认无其他 id 解析方(deep-link 用 date+topic 参数,不用行 id)。
- [ ] Step 3:safety.js toggleResolve(:459)加 `user_folder: sel.user_folder`;quality.js(:466)同。
- [ ] Step 4:user-activity-aggregator.js :233 → `lookupAction(auditForDate, rec.user.folder_name, t.topic_id, idx)`。
- [ ] Step 5:`node --check` 四文件;commit `feat(compliance): safety/quality resolve + activity audit keyed per report owner`。

---

### Task 9: 收尾 — fixtures/文档/busters/终审/PR

**Files:** Modify `scripts/mock/actions.fixture.js`(仅注释)、`BACKEND-CONTEXT.md` §4.10/§8.8、`app-shell-preview.html`(+`components-preview.html` 若加载被改文件)。

- [ ] Step 1:fixture 键**保持裸键**并加注释说明(裸键经 lookupAction 遗留回退命中——mock 模式顺带常驻验证回退路径;mock 新写入是 composite,读经 lookupAction 两者皆通)。
- [ ] Step 2:BACKEND-CONTEXT.md:§4.10 更新 body/响应(user_folder、actions_v2、双形状语义、防回归铁律);§8.8 更新键式 + 遗留回退说明。
- [ ] Step 3:bump 全部被改 JS 的 `?v=`(两 preview HTML grep 核对加载清单);全量 `node --check`。
- [ ] Step 4:反向 grep 扫漏:`grep -rn "topic_id + '_'\|topicId + '_'\|_' + idx\|_' + actionIndex" scripts/` —— 每处命中要么已改为 actionKey/lookupAction,要么在零改动清单(§0.3)有名有姓。
- [ ] Step 5:整分支 diff → **Fable 5 终审**(镜头:①防回归铁律——无任何点回退查坍缩 map;②owner≠caller——无一处拿 currentUser 当 owner;③timeline 自看 null-user 派生;④bus 身份键三段式全站一致;⑤遗留裸键回退在每个读点可达;⑥mock 完整;⑦row-id 变更无解析方破坏)。
- [ ] Step 6:修 Critical/Important → UI repo PR(base dev)。**先等 Task 3 后端上线再合**(前端读 actions_v2 依赖后端;虽有回退,顺序仍按 Global Constraints)。

---

### Task 10: 上线后验证 + 二次回填清扫

- [ ] Step 1:Amplify dev 部署完成后,Chrome 实测:
  - /timeline 2026-02-09(Jarley)→ 24 个勾**仍在**(回填成功的用户可见回归);
  - 勾/取消一个真实项 → 网络面板确认 body 带 `user_folder`,GET 后 `actions_v2` 出现 composite 键;
  - AggregatedDayView(选项目不选人、含多人报告的日期):A 分节勾 topic 0 → B 分节同号项**不动**(bus 身份键隔离;当日若无多人数据,用 Task 3 Step 6 的合成记录在 2099-01-01 复核 API 层);
  - /today rolling 列表勾掉一项 → 只消失该 folder 的条目;/tasks Mark complete + 历史抽屉;/safety /quality resolve/reopen。
- [ ] Step 2:**二次回填**:再跑 `--apply`(清扫后端上线→前端上线窗口期内旧前端写下的裸键记录);验证遗留 `TOPIC#` SK = 0。
- [ ] Step 3:记录收尾债到 ROADMAP/PLAN:①`actions` 坍缩字段下个版本可移除(旧前端绝迹后);②fieldsight-api 与 fieldsight-test-api 双 lambda 漂移归一(prod 变体入 git 或切流量);③AUDIT# 日志读端(未来做历史端点时直接用 user_folder 属性)。

---

## 自审

- **最大风险 = 双 lambda 漂移**:actions 流量在 fieldsight-api(2026-03-26 版、不在 git),整文件覆盖会连带 285 行未审 diff(/ask /search)→ 已锁死为"只换两函数"的外科手术 + publish-version 回滚锚 + 部署后 grep 核对(Task 3)。
- **次风险 = 防回归铁律被违反**(composite miss 回退坍缩 map)→ 三重防护:§1.2 设计声明、lookupAction 单一入口、Fable 镜头①。
- **漏改扫描**:§0.3 全景表(实测行号)+ Task 9 Step 4 反向 grep + 镜头④⑤。
- **owner 可得性**:全部 15 个读写点逐一给出 owner 来源,无一处不可得;唯一陷阱(timeline 自看 user=null)已入 Global Constraints。
- **迁移安全**:dry-run + 备份 dump + put-then-delete + 幂等 + 兜底歧义规则 + 二次清扫;owner 派生已用现网 S3 逐日核实。
- **旧前端窗口**:双形状响应 + 无 user_folder 写旧键 + 二次回填——窗口期行为处处 == 今天,不劣化。
