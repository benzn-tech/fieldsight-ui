# fieldsight-ui — dev 部署 runbook

> 配套架构决策见 `fieldsight-pipeline/docs/adr/0001-platform-architecture.md`(ADR-001)。
> 目标:把 `fieldsight-ui` 原型部署到一个 `dev` 环境做后台测试。
> **本 runbook 已规划成可执行;待把 Claude 接到本地 AWS、或在 GH 配好 secrets/资源后即可跑。**

---

## 0. 为什么 web 会话里跑不了 AWS

不是网络问题,是**没有 AWS 凭证**:Claude Code on the web 跑在**临时云容器**里,只有出站 HTTPS
(走 agent proxy),**没有配置 AWS credentials**。现有部署靠的是 **GitHub Actions runner 里的
OIDC role**(`AWS_ROLE_ARN`),那套身份只在 Actions 运行时成立,web 会话拿不到。

两条执行路径(都已为你规划):
1. **push 到 `dev` 分支** → GH Actions 用 OIDC 部署(前提:secrets/资源就位)。
2. **把 Claude 接到本地**(你本机有 `aws`/`sam` 凭证)→ 直接跑下面的命令。

---

## 1. 两阶段策略

- **Phase 1 — mock 模式(零后端依赖,立即可做):** 直接把静态文件 sync 到 dev bucket,打开
  CloudFront URL 即 mock 模式的可分享后台测试站。**不需要 dev 后端。**
- **Phase 2 — 联调真实数据:** dev 后端(API GW + Cognito,见 ADR-003)就位后,用 `env.js` 把
  `baseUrl`/Cognito 指过去 + `mocks=0`。

---

## 2. 一次性 AWS 资源(本地 / 接入后执行)

```bash
REGION=ap-southeast-2 ; ACCT=509194952652

# 1) dev 前端 bucket(静态托管,用 OAC 给 CloudFront)
aws s3 mb s3://fieldsight-ui-dev-$ACCT --region $REGION

# 2) CloudFront 分发:origin = 上面 bucket;默认根对象 index.html
#    hash 路由(#/route)无需 SPA rewrite。记录返回的 Distribution Id → GH 变量 DEV_UI_CLOUDFRONT_ID

# 3) OIDC role 信任策略追加本仓库:
#    现有 role(给 fieldsight-pipeline 用的)trust policy 的
#      token.actions.githubusercontent.com:sub 条件里加:
#        "repo:benzn-tech/fieldsight-ui:*"
#    权限追加:s3:PutObject / s3:ListBucket on fieldsight-ui-dev-*
#             cloudfront:CreateInvalidation
```

> dev **后端**(API GW + Cognito)若还没有:见 ADR-003,先补进 IaC 再联调;此前 Phase 1 用 mock 即可。
> **入口文件**:目前应用入口是 `app-shell-preview.html`。dev 站可把它设为 CloudFront 默认根对象,
> 或部署时复制一份为 `index.html`(`aws s3 cp app-shell-preview.html s3://.../index.html`)。

---

## 3. GH 配置(fieldsight-ui 仓库)

- **Secrets:** `AWS_ROLE_ARN`(同 pipeline 那个,trust 已含本仓库)。
- **Variables(注入 env.js):** `DEV_API_BASE_URL`、`DEV_COGNITO_POOL_ID`、`DEV_COGNITO_CLIENT_ID`、
  `DEV_UI_BUCKET=fieldsight-ui-dev-509194952652`、`DEV_UI_CLOUDFRONT_ID`。

---

## 4. 代码改动(届时执行)

1. 新增 `scripts/env.js`(提交一个 mock 默认版,占位):
```js
// 由 CI 按环境覆写;本地默认空 → 走 mock
window.FS_ENV = window.FS_ENV || { name: 'local' };
// window.FS_COGNITO_CONFIG = { region, poolId, clientId };  // CI 注入
// window.FS_API_BASE_URL   = 'https://api-dev.../api';        // CI 注入
```
2. 在 `app-shell-preview.html` 的 **cognito.js / api 之前**加 `<script src="scripts/env.js?v=1"></script>`;
   在既有 `?baseUrl`/`?mocks` 处理块(约 :247-260)旁,读取 `window.FS_API_BASE_URL`(若有)设
   `FS.api.baseUrl` + `useMocks=false`。
3. `scripts/auth/cognito.js` 的硬编码 DEFAULTS 注释清楚"仅本地兜底,生产由 `FS_COGNITO_CONFIG` 覆盖"
   (override seam 已存在 :44-51,逻辑不改)。

---

## 5. workflow:`.github/workflows/deploy-ui.yml`

```yaml
name: Deploy FieldSight UI
on:
  push:
    branches: [dev, main]
    paths-ignore: ['**/*.md', 'docs/**']
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: '${{ secrets.AWS_ROLE_ARN }}', aws-region: ap-southeast-2 }

      - name: Write env.js (dev)
        if: github.ref == 'refs/heads/dev'
        run: |
          cat > scripts/env.js <<EOF
          window.FS_ENV = { name: 'dev' };
          window.FS_COGNITO_CONFIG = { region:'ap-southeast-2', poolId:'${{ vars.DEV_COGNITO_POOL_ID }}', clientId:'${{ vars.DEV_COGNITO_CLIENT_ID }}' };
          window.FS_API_BASE_URL = '${{ vars.DEV_API_BASE_URL }}';
          EOF

      - name: Deploy to dev
        if: github.ref == 'refs/heads/dev'
        run: |
          aws s3 sync . s3://${{ vars.DEV_UI_BUCKET }}/ --delete \
            --exclude ".git/*" --exclude "docs/*" --exclude "*.md" --cache-control "max-age=60"
          aws cloudfront create-invalidation --distribution-id ${{ vars.DEV_UI_CLOUDFRONT_ID }} --paths "/*"
      # main → prod 同理(指向 prod bucket/分发,max-age=3600)
```

> **Phase 1(纯 mock,立刻可做)**:不写 env.js / 不设后端变量,直接 sync 静态文件到 dev bucket →
> 打开 CloudFront URL 就是 mock 模式的可分享后台测试站。

---

## 6. 分支

```bash
# 两个仓库当前都在 claude/charming-franklin-t84q38 上;按需开 dev
git checkout -b dev
git push -u origin dev      # 触发上面的 workflow(资源就位后)
```

> 分支名建议:`dev` 与后端现有 `develop` 统一成一个(倾向把后端 workflow 也改认 `dev`,全栈一致)。

---

## 7. 验收

- **Phase 1:** push `dev`(或本地 sync)后,打开 CloudFront URL → 看到 mock 模式的 fieldsight-ui
  (右下 dev 面板显示 **MOCK** 徽标)。后台测试就绪。
- **Phase 2:** 配好后端变量后,`env.js` 生效 → 徽标变 **LIVE**,数据来自 dev API。
- **不影响 prod:** 老前端 `fieldsight-pipeline/frontend/` 的 prod 部署不受影响(独立 workflow)。
