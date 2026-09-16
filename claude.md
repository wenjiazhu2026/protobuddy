# protobuddy 项目规则

## 项目目标
原型协作评审平台（ProtoBuddy）基于 EdgeOne Makers，提供在线原型托管、协作评审和 Agent 生成修改方案的全栈解决方案。核心闭环为：owner 上传原型 → 部署到 EdgeOne Makers（兜底本地托管）→ 团队成员在预览中添加锚点批注 → Agent 生成结构化修改方案 → owner 审核 → 应用修改并自动重新部署 → 新版本预览。

## 核心原则
- **闭环完整**：所有功能必须能端到端运行，包括部署、批注、方案生成、审核、应用、重新部署。
- **兜底机制**：EdgeOne 不可达时使用本地静态托管；Makers Models 不可达时使用规则引擎生成方案；密钥未配置时同样走兜底。
- **安全优先**：owner 操作（密码验证、文件上传、部署、方案审核/应用）必须受保护；密钥绝不在前端下发。
- **性能与稳定性**：部署优先 EdgeOne Makers CLI，超时处理严格；方案生成限制大项目文件数量。
- **用户友好**：设置页配置密钥；前端展示数据源（平台存储 vs 最新部署）；方案展示一致性评分和预检结果。
- **可扩展**：支持自定义域名；支持生成器脚本（Python）自动重新生成 HTML。
## 技术栈
- **前端**：React + Vite（端口 5173），核心组件包括 PreviewFrame（iframe + 透明覆盖层实现锚点批注）、AnnotationLayer（批注面板，可收起/展开）。
- **后端**：Express（端口 3001），routes 包括 projects.js、files.js、deploy.js、annotations.js、plans.js、ownerAuth.js；services 包括 fileStorage.js、edgeone.js、makersApi.js、makersModels.js、generator.js、consistency.js、ownerAuth.js。
- **存储**：JSON 文件存储（data/projects/） + 可选 Blob 存储（EdgeOne Makers Cloud Functions）。
- **Agent**：Makers Models API（优先，deepseek-v4 等模型） + 本地规则引擎兜底（consistency.js、dry-run 预检、scorecard 评分）。
- **部署**：EdgeOne Makers CLI（npx edgeone makers deploy）或本地静态托管；支持 regenerate.js 外部执行 Python 生成器。

## 关键文件与职责
- **backend/src/db.js**：存储驱动分发（blob/local）。
- **backend/src/routes/deploy.js**：部署端点（EdgeOne + 兜底本地）、deploy-status、domains、preview-url。
- **backend/src/services/makersApi.js**：Makers API 客户端（callApi、getOrCreateProject、uploadAndDeploy、pollDeployment、getProjectUrl、describeProjectDomains）。
- **backend/src/services/edgeone.js**：EdgeOne CLI 部署 + 本地兜底。
- **backend/src/services/makersModels.js**：Makers Models 代理 + 规则引擎兜底（systemPrompt 含 GENERATOR-SCRIPT、GENERATOR DUAL-WRITE 等规则）。
- **backend/src/services/generator.js**：prepareForDeploy（检测生成器脚本、needsExternal、regenerateRequired）。
- **backend/src/services/cloudflare.js**：Cloudflare DNS API v4 客户端（verifyToken、findZoneForHostname、upsertDnsRecord、bindDomain、checkDomainDns）。
- **backend/src/services/domainBinding.js**：自定义域名绑定编排（bindProjectDomain、checkProjectDomain、describeEdgeoneState、syncDomainDnsIfStale）+ MANUAL_EDGEONE_STEPS。
- **backend/src/routes/domain.js**：域名绑定端点（/:id/domain、/domain/test、/domain/bind、/domain/verify，均为 owner 操作）。
- **frontend/src/components/PreviewFrame.jsx**：iframe 预览 + 透明覆盖层 + 锚定/滚动同步。
- **frontend/src/components/AnnotationLayer.jsx**：批注面板（收起/展开、列表）。
- **frontend/src/pages/Review.jsx**：评审页（数据源徽章、最新部署外链、批注列表）。
- **frontend/src/pages/PlanReview.jsx**：方案审核页（评分卡、预检徽章、一致性横幅、回滚按钮）。

## 自定义域名绑定（EdgeOne + Cloudflare）

绑定 `cis2.20140107.xyz` 这类自定义域名需要两件事，**只有一半可自动化**：

1. **EdgeOne 侧（无法自动化，必须控制台操作）**：项目的加速区域决定是否需要备案；添加自定义域名后 EdgeOne 才给出该域名的 CNAME 目标
   （形如 `a4285573.cis2.20140107.xyz.dns.edgeone.site.`）。Pages Open API **没有任何域名 Action**
   （`edgeone@1.6.40` 里 CLI 认知的全部 Action 中无一域名动作），且 `DescribePagesProjects` 只返回
   `CustomDomains[].Domain/.Status`，**不含 CNAME 目标**。目标值的前缀哈希由服务端按域名生成，**不可推导**，只能从控制台弹窗复制。
2. **DNS 侧（已自动化）**：把目标值写入 Cloudflare。见 `services/cloudflare.js` + `services/domainBinding.js`。

流程：控制台添加域名 → 复制 CNAME 目标 → 项目设置页填入「自定义域名 + CNAME 目标 + Cloudflare Token」→ 点「绑定 DNS」。
之后 Cloudflare 记录写入、解析校验、EdgeOne 生效状态回读全部自动完成。

- **Token 权限**：Cloudflare API Token 需含 `Zone:DNS:Edit`，限定到目标 Zone。**按项目存储**（与 `edgeone_token`/`makers_key` 一致），
  前端只回显 `***`，永不返回明文。
- **记录必须 DNS only（灰云，`proxied:false`）**：EdgeOne 需要看到真实 CNAME；开启代理会解析到 Cloudflare IP，归属校验永远不通过。
- **不要用泛解析**：Makers 不接受泛域名自定义域名（泛域名接入属于 CDN 侧「别称域名/SaaS 建站」能力），
  且一条泛解析只能指向一个目标，无法让多个项目各自获得独立子域。
- **部署期自动同步**：部署成功后会调用 `syncDomainDnsIfStale`，仅在 `(custom_domain, cname_target)` 与已记录的成功同步不一致时才写 DNS
  （变更目标后自动修复；日常重复部署零额外调用）。失败只告警，绝不让部署失败。
- **前置条件**：加速区域必须支持免备案绑定，详见下方「加速区域（新建 EdgeOne 项目必读）」。

## 开发与部署规范
- **本地开发**：cd backend && npm install && npm start；cd frontend && npm install && npm run dev；Vite 代理 /api。
- **生产模式**：cd frontend && npm run build；cd backend && npm start（单服务器）。
- **线上部署**：npx edgeone makers build --mode prod && npx edgeone makers deploy . -n protobuddy-app -t <token> -e production --json -a overseas。
- **加速区域（新建 EdgeOne 项目必读）**：项目加速区域**创建后不可更改**，且在**首次创建项目的那一次部署**上就必须选对。
  - `-a overseas` = 全球可用区（不含中国大陆）→ 绑自定义域名**无需 ICP 备案**（本项目默认）。
  - `-a global`（CLI 默认值）= 全球可用区（含中国大陆）→ 绑自定义域名**需备案**；`chinese-mainland` 同理。
  - 代码侧：`makersApi.resolveArea()` 是唯一取值来源，默认 `overseas`，可用环境变量 `EDGEONE_AREA=global` 覆盖；`edgeone.js` 的 CLI 路径必须显式带 `-a <area>`，**不可省略**（省略即落到 CLI 默认的 `global`）。
  - 已有大陆区域项目只能新建迁移，无法就地切换；`GET /api/deploy/:id/domains` 会返回 `accelerationArea` 与 `filingRequired` 供核对。
- **Git 工作流**：拉取最新代码（git pull origin main）；使用 git worktree 隔离特性分支；PR 必须通过严格代码审查（代码质量审计：不让文件 >1k 行、不让 spaghetti 增长、主动寻找 code judo 简化）。
- **数据库**：data/projects/<id>/ 目录结构；JSON 表（projects/files/annotations/plans/planChanges/deployments）。
- **密钥管理**：设置页填写 EdgeOne Token / Makers Key / Cloudflare Token；按项目存储；owner 操作必须密码验证（OWNER_PASSWORD）；密钥仅存后端，前端只回显 `***`。

## 规则引擎（Makers Models 兜底）
- systemPrompt 固定包含：批注收集、old_code 唯一匹配检查、consistency 评分（0.4 权重）、dry-run 预检、scorecard（0-100 评分）、dual-write 规则。
- 生成方案时自动执行 consistency.js 检查 + 预检；apply 时检查 old_code 唯一性；失败时返回 409 + 具体 errors。

## 待办
- [ ] 配置 EdgeOne Token / Makers Key / Cloudflare Token
- [ ] 绑定自定义域名：先在 EdgeOne 控制台添加域名并复制 CNAME 目标，再在项目设置页点「绑定 DNS」
- [ ] 优化 blob 存储清理（旧 demo 文件）
- [ ] 前端构建产物部署（包含最新 UI 改动）

此文件用于 Claude / Grok 开发会话上下文，确保一致性。建议软链接到 agents.md 以便全局引用。