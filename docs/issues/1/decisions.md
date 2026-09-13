# dingtalkbot D1 决策记录（decisions.md)

- Issue: #1 "Gateway skeleton: DingTalk Stream transport + OpenAPI reply + markdown echo"
- 日期：2026-09-13（r1）· 评审：codex-eval `kind=options`，round 1 verdict `needs-attention`（12 项决策全部认可推荐项 + 强化条件，均已采纳；信息缺口见文末 FLAGGED-FOR-HUMAN）
- 上游规格：`ops/drafts/spec/dingtalkbot-spec.md`（session `dingtalkbot`，2026-09-13 finalize）；上游已定事项（Q4 回复通道、sampleMarkdown、token 自管、topic 等）不再重议。

## 事实修正（探索核实，源码级）

- `dingtalk-stream@2.1.5`（npm tarball 解包核实 + 官方 example）：
  - 类名是 `DWClient`（构造器仅收 `clientId/clientSecret/ua?/keepAlive?/debug?`）；`registerCallbackListener(topic, cb)` 是 EventEmitter `on(topic, cb)`，**回调返回值被丢弃**；ack 必须显式 `client.socketCallBackResponse(messageId, result)`，否则服务端 60s 重推（官方 example 同款用法）。
  - 回调入参 `DWClientDownStream.data` 是 JSON **字符串**，需自行 `JSON.parse`（SDK 仅类型化 text msgtype）。
  - `connect()` **永不 reject**（getEndpoint/_connect 错误全被 catch）；内置 `autoReconnect` 为**固定 1s 无限重试且静默**——坏凭据 = 静默死循环；`reconnectInterval` 恒 1000ms，无 backoff。
  - `GATEWAY_URL` 硬编码（axios POST api.dingtalk.com），**无可注入 mock 网关的口子** → wechatbot 式 mock WS 服务器方案不可行。
  - 可用观测面：`client.config`（public typed，含 `autoReconnect`/`keepAlive`）、`client.socket`（public ws 实例）、public 布尔 `connected/registered/reconnecting`；无生命周期事件。
  - npm dist-tags：`latest` → 2.1.6-beta.1（beta），2.1.5 为最新稳定版 → **exact pin `"dingtalk-stream": "2.1.5"`**。

## D1: Transport 接缝形态

**选定 (a)**：wechatbot 式 port + adapter——`src/transport/types.ts` 定义自有 DTO、`DingtalkTransport` 接口与 `TransportEvent` 判别联合；`src/transport/dingtalk-sdk-adapter.ts` 为**唯一** import SDK 的文件，DWClient 工厂可注入供测试。
理由：AC6 要求"换 SDK 只动 adapter"；家族先例（wechatbot `src/transport/` 同构）。
Codex 条件（采纳）：对 pin 2.1.5 的行为写契约测试；DTO 独立于 SDK 类型，防止泄漏。

## D2: 连接监督（loud start + backoff reconnect）

**选定 (a)**：adapter 自建监督——构造后置 `client.config.autoReconnect = false`（public typed 配置字段，非黑魔法），自跑指数退避循环（1s 起、×2、封顶 60s，`registered` 成功后重置），每次 connect 后向新 `client.socket` 挂 close/error 监听，`start()` 在 30s deadline 内未达 `connected && registered` 则**响亮失败**（reject + error log + 非零退出）；运行中断线则按 backoff 永续重连，`stop()` 可取消（清除挂起定时器，置 userDisconnect）。
理由：SDK 固定 1s 静默重试同时违反 AC1（loud）与 AC3（backoff）。
Codex 条件（采纳）：supervisor 必须可取消（单监督循环，stop 中止 pending timer），防重复重连。

## D3: Ack 策略

**选定 (a)**：adapter 包装回调——防御性 `JSON.parse(data)`（失败 → loud log + ack SUCCESS 丢弃）→ 调 handler → **本地有界重试**（2 次、短退避）瞬时回复失败 → 无论成败最终 `socketCallBackResponse(messageId, {status: EventAck.SUCCESS, message})`，所有丢弃/错误路径 loud log。
理由：不 ack = 毒消息 60s 无限重推；回调返回值已被源码证实无效。
Codex 条件（采纳）：回复失败先本地重试再放弃，放弃时必须留错误日志（feishubot #62）。

## D4: 测试策略 —— FLAGGED-FOR-HUMAN（对 wechatbot 先例的材料级分歧）

**选定 (a)**：fake-DWClient 注入——adapter 收 client 工厂，测试用 fake 实现观测协议（按 `DWClientDownStream` 形状 emit topic、捕获 `socketCallBackResponse` 调用、可控 connect 失败/超时）；port 层逻辑纯测；真实传输证明 = `setup` 内**真凭据 smoke**（token fetch + Stream connect + subscribe）。
理由：GATEWAY_URL 硬编码使 mock 网关不可行；(b) HTTPS_PROXY 劫持高脆弱、(c) CI 放真密钥均不可取。
Codex：认可 (a)，并明确**信息缺口**——AC2 的真实往返证据依赖人供钉钉凭据，CI 不得声称等价。
**分歧标记**：wechatbot W1 用 mock WS 服务器拿到了 CI 内传输层证据；D1 拿不到，传输层保真度由 fake 协议测试 + live smoke 两段拼合。已为 human gate 标记。

## D5: OpenAPI client + Token manager

**选定 (a)**：`src/openapi/` 模块，仅用内置 `fetch`（零新依赖）：`TokenManager`（`POST https://api.dingtalk.com/v1.0/oauth2/accessToken` {appKey, appSecret} → {accessToken, expireIn}；**expireIn 单位文档歧义（ms/s）→ 归一化启发式 + smoke 实测**），内存 + `.bot/token.json` 磁盘缓存（**0600、原子写**），到期前 5 分钟余量刷新，**single-flight**（并发共享 in-flight Promise），fetch/clock 可注入；发送助手 `sendOtoMarkdown(robotCode, userIds, title, text)` / `sendGroupMarkdown(robotCode, openConversationId, title, text)`，非 2xx → 带响应体的 loud error。
理由：SDK 自带 `getAccessToken` 走旧 oapi GET（密钥进 query、无过期时间、无缓存）全面劣化；A4 要求 cache+refresh+single-flight。
Codex 条件（采纳）：磁盘缓存 0600 + 原子写；smoke 验证 expireIn 语义。

## D6: 构建/运行时目标

**选定 (a)**：wechatbot 形态——`bun build src/cli.ts --target=node --outdir=dist --external dingtalk-stream`，`#!/usr/bin/env node` shebang，`check:dist` 脚本 grep dist 中绝对路径/机器痕迹；**唯一运行时依赖 `dingtalk-stream` exact 2.1.5**。
理由：部署面只需 node（bun 仅是构建/测试工具）；feishubot #76 教训由 `--external` + check:dist 双保险。

## D7: CLI 与守护进程

**选定 (a)**：wechatbot 模式——手写 argv 解析（零依赖）；`setup` = 交互 readline 手输凭据 **+ 非交互入参支持**（`--client-id/--client-secret` 旗标，供脚本化 smoke）→ 写 `.env`（0600）→ smoke（token fetch + Stream connect）响亮成败；`run` 前台；`start` = detached spawn + `.bot/pids/dingtalkbot.pid` 记 `{pid, startedAt}` 抗 pid 复用 + 陈旧 pidfile 清理；`stop` = SIGTERM + 宽限轮询 + SIGKILL；`status` = pid 存活 + `.bot/state.json` 连接快照；退出码显式。
Codex 条件（采纳）：非交互 setup 入参、pid+startTime 双因子、陈旧状态清理、明确退出码。

## D8: 日志

**选定 (a)**：手写 JSONL（wechatbot 同款）——每次 run 写 `.bot/logs/YYYYMMDD_HHMMSS.log` + `latest.log` 符号链接（失败回退复制），行带模块标签，仅 node 内建 API；日志器自身故障可见、不遮蔽传输/handler 错误。
理由：保住"运行时依赖仅 SDK"的极简面；winston 是 feishubot 形态但非 D1 所需。

## D9: Gateway 装配与 echo 细节

**选定 (a)**：薄 `Gateway` 类 `{transport, replyer, logger, stateWriter, handler}`，handler 可插拔（D2 agent 层接缝）。echo 语义：
- p2p（conversationType '1'）→ `sendOtoMarkdown(robotCode, [senderStaffId], …)`；group（'2'）→ `sendGroupMarkdown(robotCode, conversationId, …)`——**假设 openConversationId == 入站 conversationId（钉钉机器人载荷字段），live smoke 验证；若错则群回显可见失败后修正**。
- echo 内容 = 原文 text.content **原样**（不剥 @ 前缀——剥离与群策略是后续 issue D3 的事，本 issue 明确 out of scope）；markdown title 固定短串。
- 非 text msgtype（picture/richText/audio/video/file）→ loud log + 丢弃（媒体是 D4）。
Codex 修正（采纳）：明确 @ 前缀剥离 out of scope 的表述归属（此前引用歧义）；非 text 丢弃必须留痕，不得看起来像静默。

## D10: `.bot/` 引导

**选定 (a)**：首次运行创建完整目录树——`config.json`（最小文档化默认值，D2/D3 保留键标注 inactive）、`access.json`（`{admin:[], approved:[], groups:[]}` 占位，D3 前无语义）、`sessions/ uploads/ logs/ pids/`；权限收紧（`.env` 0600、token.json 0600）；SPEC 记录完整意图布局；不伪造运行时状态。
理由：issue Proposal 明列 `.bot/` 布局含 access.json/config.json。

## D11: AC2/AC5 真实验证路径 —— FLAGGED-FOR-HUMAN

**选定 (a)**：CI 可验证部分全自动（单测/集成/构建/类型/SPEC 一致性）；真实往返步骤写成**人工 runbook**（setup 输入真凭据 → p2p 发文本 → 群 @ → 查日志与回显）；执行轮若无凭据：完成代码 + CI + 文档，AC2/AC5 的活体证据清单随 Human-Review 移交。
理由：阻塞等凭据 = 管道卡死（b 不可取）；单测冒充 AC2 证据不诚实（c 不可取）。
Codex：认可，并标记**信息缺口**——钉钉企业内部应用凭据 + 真实 p2p/群环境是 AC2/AC5 勾选前置。

## D12: 文档与发布管道

**选定 (a)**：D1 内交付——`SPEC.md`（Transport + Reply + CLI + `.bot/` 各节，**只写已验证行为**，live 项标注）、`CHANGELOG.md`（Keep-a-Changelog zh，`[Unreleased]`）、CI workflow（typecheck + test + build + check:dist）、`publish.yml` 手动 dispatch 到 `npm.pkg.github.com`（仅管道，不自动发布）。
理由：issue Proposal 明列 publish plumbing；wechatbot 同构。

## FLAGGED-FOR-HUMAN（人工门提示）

1. **D4 测试策略分歧**：mock WS 服务器（wechatbot 先例）对 dingtalk-stream 不可行（GATEWAY_URL 硬编码）→ CI 内无真实传输层证据，改为 fake-DWClient 契约测试 + live smoke 拼合。
2. **D11 活体证据缺口**：AC2（p2p/群真实回显）与 AC5（setup smoke 真/假凭据）需要 Jacky 的钉钉企业内部应用凭据（clientId/clientSecret）+ 真实发消息环境；代码/CI/文档可先行完成，活体验证走 runbook + Human-Review 清单。
3. **D9 群回复载荷假设**：openConversationId == conversationId 为待 live 验证假设；expireIn 单位（ms/s）同为 smoke 验证项。失败可见、可快速修正，不阻塞计划。

## 评审记录

- r1 options 评审：verdict `needs-attention`；12/12 决策认可推荐项，强化条件全部采纳（本地重试后 ack、可取消 supervisor、非交互 setup、0600 原子缓存、保留键 inactive、退出码显式）；summary="No-ship as acceptance-complete until live DingTalk credentials verify round-trip and payload assumptions; the coded skeleton and CI can ship with an explicit human-evidence checklist." → 与 D11(a) 处理一致，无新增决策点，frontier 清空。

### plan 评审引发的决策修订（r1 plan round 2/3 采纳）

- **D1 修订**：状态可观测性落地为 `onStateChange((state: TransportState, detail: string) => void)` 回调形态（回调携带 state+detail），不再单独建 `TransportEvent` 判别联合——结构等价、少一层包装，与 wechatbot 实装形态一致。计划与决策以本修订为准。
- **D2 强化**（round 2/3 评审采纳）：(i) `startTimeoutMs` 仅约束**首次注册**——运行期断线永续退避重连，不受 deadline 误杀；(ii) 每次 `connect()` 套 per-attempt 超时（首次与 deadline 赛跑，运行期默认 30s）防挂起 wedge；(iii) socket close/error 事件带代际守卫（旧 socket 迟到事件不误触新连接）；(iv) `stop()` 结算未决 start（`TransportStoppedError`），防悬挂。
- **D5 强化**：磁盘缓存按 clientId 指纹隔离（凭据轮换旧 token 不复活）；`invalidate()` 内存+磁盘双清；0600 经显式 `chmodSync` 收紧（覆写已有文件时 Node 不改权限位）；token 刷新落 `expireIn/TTL/expiresAt` 日志（live 验证位直接引用）。
- **plan round 2 评审**：verdict `needs-attention`（11 项：cli 入口 import 即执行、connect 无超时、同秒日志碰撞、0600 覆写、invalidate 复活、run 生命周期/pidfile、port 事件形态、dist 门槛、expireIn 日志缺失、daemon 断言缺失）→ 全部采纳修复。
- **plan round 3 评审**：verdict `needs-attention`（4 项：首次注册迟到可突破 30s 上界、stop/restart 旧 supervisor 复活、console 捕获类型不合法、早期 commit 门禁引用未建目录）→ 全部采纳修复（deadline 检查移入成功分支前置条件、supervisor 代际守卫 `generation`、`(...args: unknown[])` 捕获签名、门禁统一 `bun test` 自动发现）。3 轮修复预算用尽，按流程进入自审；codex 为增强而非门禁，人工门在 Human-Review。
