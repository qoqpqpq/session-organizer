# session-organizer

dsh 会话整理插件（常驻 web profile bundle，重启后仍可用）。

## 功能

- **扫描**：聚类同主题会话（主键=项目名"你是 X 项目"，次键=标题前缀，兜底=内容 token 重叠；项目名不同禁止兜底并组）；识别长期未用（>30 天不活跃且非 live）与无实质内容（无消息 / 无助手回复 / 无用户输入且无标题，排除已聚类会话）。
- **归档 / 清理**：批量归档指定会话（`workspaceRegistry.archiveSession`）。
- **合并**：把若干源会话合成为一份干净文本级转录会话（每源 turn bracket），可同时归档源会话。合并目标默认为**新建会话**；也可在面板里选择**合并到已有会话**（把转录追加为新的 turn，续接目标会话的 seq 与 turn 编号）。合并 id 采用**防碰撞编号**（枚举 persisted + live id，跳过已占用的 `session-<n>`）。
- **查看**：peek 会话标题 + 首条用户消息。
- **合并目标**：`GET/POST /session-organizer/api/targets` 返回可合并的持久化（非 live）会话列表，供面板下拉选择。

## 形态

- **宿主半身** `lib/index.js`：注册围栏 JSON API `POST /session-organizer/api/<method>`（`webServer.register({kind:'prefix',path:'/session-organizer/api',handler})`，fence=`isTrustedApiRequest(req, webRuntime.trustedHosts)`）+ 全局模型工具 `session_organizer`（`tools.register(defineTool(...))`）。触达宿主平面服务：`sessionQuery`、`workspaceRegistry`、`sessions`、`tools`、`webServer`、`webRuntime`。
- **客户端半身** `lib/client.js`：通过共享 `slots` 服务注入侧栏底部"会话整理"入口（`sidebar.footer.action`）与浮层面板（`shell.overlay`）；面板用 `fetch` 调宿主 API。**必须导出 `inject: ['slots']`**：boot 并行激活所有 bundle 条目，若不声明该依赖，fiber 会在 `dsh-client-runtime` 提供 `slots` 服务之前运行 `apply`，按钮永不注册（`dsh-client-ui-sidebar` / `ui-cordis` 均声明 `inject: ['slots']`）。

## 挂载

- `dsh.bundle.patch` → `cordis.patch.yml`（`- insert: {id: session-organizer, name: 'session-organizer'}`）。
- `dsh.client` → `{platform:'web', immediately:true, inject:[]}`，客户端经 `/plugins/session-organizer/client.js?rev=...` 服务并注入 `window.__DSH_BOOT__`。
- 在 web profile `package.json` 的 `dsh.profile.bundles` 加入 `session-organizer`，`dependencies` 加入 `file:` 依赖，重启 `deepseek-harness.service` 生效。

## 验证

- 宿主激活（mock ctx）：路由 + 工具注册 OK。
- HTTP 端到端（mock 服务 + 真实 node http）：scan 聚类 / peek / archive / merge / 跨站 403 围栏 全通过。
- 客户端激活（mock slots）：两个 slot 注入 + 有效注册 OK。
- 生产重启后（`deepseek-harness.service`）：`/plugins/session-organizer/client.js` HTTP 200、boot manifest 含 `session-organizer`、API 存活、scan 返回真实分组（GPX 15 / blog 13 / dsh plugin 6）、merge 生产路径成功。
- 修复"按钮不显示"（根因=模块导出 `inject: []`，boot 并行激活早于 `slots` 服务）：改为 `inject: ['slots']`，HMR watcher 检测到 bundle 变更后重新计算 rev（`b5885487a9e0` → `351c2ff3b0b2`），经 SSE `/plugins/events` 广播 `rebuilt`，浏览器热替换重新执行 `apply`（无需页面刷新）。
- 修复"session source headers conflict for session-1"（scan 500）：根因=两个不同 merge 结果复用同一 id `session-1`（id 生成器复用已释放编号），live 与 persisted 头部 `parentSession` 不同 → `sessionQuery.listSessions()` 的 `assertSessionHeadersCompatible` 抛错。处理=移除冷 persisted 磁盘日志（备份至 `/tmp/session-1-persisted-backup/`）+ 从 `workspace.json` 的 `archivedSessionIds` 移除 + 重启 harness 清掉 live 内存态。验证：scan 200（GPX 15 / blog 12 / dsh plugin 6，与基线一致）。
- 修复"session source headers conflict"复现（merge 500 + 内容找不到）：根因二=**SessionStore 编号计数器每进程重置为 0**，`sessions.create(undefined,...)` 重新铸出 `session-1`/`session-2` 与磁盘上已有日志冲突；live 会话创建后 flush 抛错（被吞）→ 残留 live 副本 → `listSessions()` 的 `assertSessionHeadersCompatible` 报 SESSION_QUERY_SOURCE_CONFLICT。修复=新增 `mintMergeSessionId()`：直接枚举 `sessionPersistence.list()` + `sessions.list()` 跳过已占用编号，再用显式 id `sessions.create(id,...)`。验证：merge 生产路径铸出 `session-3`（跳过已有 1/2）、scan 不再抛错。
- 修复合并转录 `turn: 0` 畸变（strict `readFrom` 报 "malformed pre-react-loop turn/end"）：真实 dsh 会话 turn 从 1 起，旧代码用 `turn: 0`，持久化迁移判定 `< 1` 为畸变，导致合并会话 strict 读取失败（peek/lenient 路径不受影响）。修复=每源一个 turn，turn 从 1 递增。验证：`readFrom` 对合并会话返回 `{meta,events}`，turns 1..n。
- 新增**合并到已有会话**：`mergeSessions(sessionIds, archiveSource, targetId)` 在给定 targetId 时，读取目标 `readFrom` 取当前 seq/turn 游标，把转录作为新 turn `sessionPersistence.append` 追加（校验 target 非源、非 live）。目标必须为 strict 可读的持久化会话（旧 `turn:0` 合并产物不能作目标，会明确报错）。客户端新增"合并目标会话"下拉（`/session-organizer/api/targets` 填充，默认"（新建合并会话）"）。验证：把 `session-2` 并入真实 blog 会话 → peek 37888 事件、strict readFrom 通过、末条 user 消息为 `【合并 session-2】`、turn 续接 22。
