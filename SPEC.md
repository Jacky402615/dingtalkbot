# dingtalkbot SPEC

行为契约（v1 按波次追加：D1 传输+回复；D2 会话；D3 命令/访问；D4 附件）。
标注规则：`CI-verified` = 测试覆盖；`live-verified` = 真实钉钉环境验证（见 docs/issues/1/live-smoke.md）。

## Transport（D1 契约）

- 接收：官方 `dingtalk-stream@2.1.5`（exact pin）Stream 模式；订阅 `/v1.0/im/bot/messages/get`（TOPIC_ROBOT）；凭据 `.bot/.env` 的 `DINGTALK_CLIENT_ID/SECRET`（加载时权限漂移 → 读取前收紧 0600，收紧失败响亮拒绝）。
- SDK 隔离：SDK 仅在 `src/transport/dingtalk-sdk-adapter.ts` 出现；port 定义于 `src/transport/types.ts`。替换 SDK 只改 adapter（CI-verified）。
- 连接监督：SDK autoReconnect 关闭，自有监督循环——**首次**连接 30s 内未 `connected+registered` 则启动失败（disconnect + 非零退出 + error 日志）；运行中断线按指数退避（1s 起 ×2 封顶 60s，成功重置）**永续**重连；socket close 事件立即触发重连，watchdog 轮询为双保险（CI-verified：fake-DWClient 契约测试）。
- 消息处理：回调 data 防御 JSON.parse；归一为 `InboundRobotMessage`（仅 text 提取原始 content，不 trim；其余 msgtype 透传 handler 决策）；处理完**显式 ack**——`socketCallBackResponse(messageId, {status:'SUCCESS', message})`（SDK 内部再包为 `{response:…}` 下发；回调返回值 SDK 不消费）；handler 失败本地重试 3 次后尽弃仍 ack（防服务端 60s 重推）；解析失败/尽弃/丢弃全部留 error/warn 日志（CI-verified）。

## Reply（D1 契约）

- 通道：OpenAPI REST + 自管 token；`sessionWebhook` 不使用（spec Q4）。
- token：`POST /v1.0/oauth2/accessToken`；内存+`.bot/token.json`（0600 原子写，按 clientId+clientSecret 凭据指纹隔离——任一凭据轮换旧缓存即失效；缓存权限非 0600 或不可解析均告警忽略）双缓存；到期前 5 分钟刷新；并发 single-flight（CI-verified）。expireIn 单位歧义由归一化处理并在 smoke 实测（live-verified 待回填）。
- 请求时限：token 与回复请求各 10s deadline（覆盖 fetch + body 读取）；handler 全部尝试（token+回复+重试延迟）另受 50s 总预算约束，压在钉钉 60s 重推窗口内（CI-verified）。
- p2p 回复：`POST /v1.0/robot/oToMessages/batchSend`，`userIds=[senderStaffId]`；群回复：`POST /v1.0/robot/groupMessages/send`，`openConversationId=入站 conversationId`（live-verified 待回填）；msgKey `sampleMarkdown`，msgParam `{title,text}`（CI-verified：载荷形状）。
- echo 行为（D1，已被 D2 取代）：D2 起 echo handler 移除，消息进入 agent 会话层（见 Session/Agent 与 AI 卡回复两节）；非文本/空文本丢弃并留 warn 日志的规则保留。

## Session / Agent（D2 契约）

- 会话键控：p2p 按 `senderStaffId`、群按 `conversationId` 每 chat 一个会话；存储 `.bot/sessions/<sha256(chatKey) 前 16 hex>.json`（0600 原子写，损坏当作不存在开新会话）（CI-verified）。
- idle-TTL resume：TTL 判定与 lastActiveAt 更新都在**消息到达时**（排队等待不计入）；默认 60 分钟（`session_idle_ttl_minutes`）；TTL 内 `--resume <sessionId>` 续会话，超 TTL 新 uuid（CI-verified）。持久化与盘面合并（lastActiveAt 取 max，旧在飞回合不倒拨 TTL）；网关重启后跨实例恢复会话（CI-verified）。
- 回合执行：`claude -p <prompt> [--session-id|--resume] --output-format stream-json --verbose --include-partial-messages --model <cfg> --permission-mode <cfg>`，cwd=网关工作区根、env 全量继承（加载该目录身份/hooks——feishubot 同模型）；prompt 前缀 `[Context: sender=…, staffId=…, chat=… (p2p|group)]`（CI-verified：旗标/载荷）。
- 流解析：assistant 消息按 `message.id` 分域（id 缺失防御回退：每个 assistant 事件即新域）；delta 累计与 message 级权威全文分离（权威替换不提交）；首个 `AskUserQuestion` tool_use 前的文本照常流出、其后抑制（headless 下该工具恒被 CLI 自动拒绝——2026-09-13 实测，问题经回合边界协议回传）；回调异步串行化、settle 前排空（CI-verified）。
- 进程监督：子进程 detached 进程组；回合看门狗 `agent_turn_timeout_ms`（默认 600s）超时组 SIGTERM→5s→SIGKILL；`killAll` 同升级且置 closed 拒新回合；关停序 `queue.close → runner.killAll → gateway.stop`（排队未开始回合丢弃，关停后不再 spawn）（CI-verified）。
- 消息入口：msgId LRU 去重（500）；群消息剥一次前导 `@token`（窄正则 `^@[^\s@]+\s+`，其余 @ 不动——群策略主体在 D3）；非文本/空文本/未知会话类型 warn 丢弃；队列满（`queue_max_per_chat` 默认 10）拒绝并回一条忙线 markdown（CI-verified）。
- 会话失效：首回合失败（`!ok && !resume`）作废会话记录（防幽灵 sessionId 被 --resume 连环失败）；回合失败时 pendingQuestion 回退盘面真值（CI-verified）。

## AI 卡回复（D2 契约）

- 开卡：回合开始 `POST /v1.0/card/instances/createAndDeliver`——`cardTemplateId`（config `ai_card_template_id`，owner 在钉钉卡片平台创建；空 → 启动 warn + 纯 markdown 模式）、`outTrackId`=uuid、`cardData.cardParamMap[<card_content_key>]`（默认 `content`）、`callbackType:'STREAM'`、投放路由 群 `dtv1.card//IM_GROUP.<conversationId>`+`imGroupOpenDeliverModel{robotCode}` / p2p `dtv1.card//IM_ROBOT.<senderStaffId>`+`imRobotOpenDeliverModel{spaceType:'IM_ROBOT'}`（CI-verified：载荷形状；live-verified 待回填）。
- 流式更新：`PUT /v1.0/card/streaming`——`{outTrackId, guid(每次唯一), key, content:全量累计, isFull:true, isFinalize, isError}`；`isFinalize` 收终自动转 finished 态（live-verified 待回填）。**双阈值节流**：距上次刷新 ≥ `card_stream_min_interval_ms`（默认 1500）且新增字节（UTF-8）≥ `card_stream_min_bytes`（默认 64）才刷；finalize 恒全量兜底；每次 flush 落 info 日志 `bytes/delta/intervalMs/suppressed`（AC6 可观察，配额保护；默认值 live 校准项）（CI-verified）。
- 回退链（AC4）：任何卡失败（创建/流式/收终）⇒ **恰好一条** markdown 全文（title `dingtalkbot`，p2p batchSend / 群 groupMessages/send）；流式失败后尽力一次 isError 收终（半成品卡可见终止态）；claude 失败且卡已 dead ⇒ markdown 含错误与部分文本；回退自身失败 error 日志（通道穷尽）（CI-verified）。
- 内容上限：卡片/流式内容累计 30000 字符截断（一次性 warn）。
- AskUserQuestion 降级（AC5）：卡内渲染编号选项列表（单题/多题分组）；纯数字回复解析为结构化应答（`[AskUserQuestion 应答] <question>: 已选 "<label>"`）经 resume 回传；单题多选支持 `1,3`；多题按位逗号映射；多题+多选组合降级提示文字回复；越界/个数不符回 help 文本不进模型；pending 即时落盘（回合仍在飞时可应答），应答成功且目标匹配才清除（CI-verified）。

## Commands / Access（D3 契约）

- 处理顺序：msgId 去重（同步占位/失败释放）→ p2p 鉴权 → 群白名单 → 命令解析 → agent 委派；access 加载/解析异常 fail-closed 映射为正常回复（不上抛），其余处理失败（含回复发送失败）照旧上抛由 transport 有界重试（≤3 次/50s 预算，占位已释放可重入）（CI-verified）。
- 命令：`/new`（reset 会话——epoch 代际防在飞/排队回合复活旧 id；在飞回合不杀）、`/stop`（仅杀该 chat 在飞回合，TERM→5s→KILL；不清排队，确认文案披露队列深度；防御性超时诚实文案；无在飞回提示）、`/status`（p2p：连接+uptime+会话哈希明细+admin/approved 名单；群：仅概览与计数——明细/名单不向全群广播）、`/help`。剥 @ 后 trim、大小写不敏感、精确匹配、无参数；未知 `/xxx` 透传 agent 当普通消息（CI-verified）。
- 访问：`.bot/access.json` `{admin,approved,groups}`（手工编辑，每消息读盘，ENOENT 单次重试容忍原子替换，解析失败响亮限频 warn 后 fail-closed 全拒含 admin——修文件即恢复）；p2p 按 `senderStaffId` ∈ admin∪approved 放行，admin v1 仅信息性；陌生 p2p 收固定泛化拒绝文本（不泄露命令面/配置面），不 spawn 会话（CI-verified）。
- 群策略：仅 `openConversationId` ∈ groups 白名单的群内 @ 被处理（任意成员——群授权=owner 拉群；群成员治理是 owner 责任，此为明示信任边界）；非白名单群 @ 零回复 + 一条 warn 日志（CI-verified）。
- live 验证清单：真实群里 @ 触发四命令；管理员外同事 p2p 收到拒绝；把群加入/移出 groups 的即时生效；/new 长回合中重置；/stop 长回合中止与卡终止态。

## 配置（D2 契约）

- `.bot/config.json` 键（非法值 warn + 默认）：`session_idle_ttl_minutes`(60) · `ai_card_template_id`("") · `card_content_key`("content") · `model`("glm-5.3-flash") · `agent_permission_mode`("bypassPermissions"|"acceptEdits") · `agent_turn_timeout_ms`(600000) · `claude_bin`("claude") · `card_stream_min_interval_ms`(1500) · `card_stream_min_bytes`(64) · `queue_max_per_chat`(10)（CI-verified）。
- bypassPermissions 启动响亮 warn：agent 无头全权限，暴露面 = access.json 白名单（admin/approved/群白名单）全体成员——名单与群成员治理是 owner 责任（D3 起；残余风险 FLAGGED-FOR-HUMAN，见 docs/issues/2/decisions.md 与 docs/issues/3/decisions.md）。

## CLI（D1 契约）

- `dingtalkbot setup [-r <ws>] [--client-id --client-secret]`：旗标空串/交互空输入 → 响亮失败；写 `.env`(0600) → 冒烟（token + Stream 连接）→ PASS / FAIL（FAIL 非零退出）。
- `run`：前台；启动失败非零退出；SIGINT/SIGTERM 优雅关停（断开、清 pidfile）。
- `start`：detached 后台 + `.bot/pids/dingtalkbot.pid`（{pid, startedAt} 抗 pid 复用）；重复启动/缺 .env 拒绝退出 1；陈旧 pidfile 自动清理。
- `stop`：先 pid+startedAt 双因子校验（pid 复用绝不发信号）→ SIGTERM → 15s 宽限 → SIGKILL → 清 pidfile。
- `status`：pid 存活性 + `.bot/state.json` 连接快照（transport 状态 + 更新时间）。

## `.bot/` 布局

`.env`（0600）· `config.json`（D1 空默认，键留 D2/D3）· `access.json`（D3 生效：`{admin,approved,groups}` 白名单，手工编辑、每消息读盘、fail-closed）· `token.json`（0600 token 缓存，含凭据指纹；invalidate 删除失败会响亮抛错，绝不静默让失效凭据复活）· `state.json`（连接快照）· `sessions/ uploads/`（D2/D4 占位）· `logs/`（JSONL 每 run 一文件 `YYYYMMDD_HHMMSS.log` + latest.log 链接）· `pids/dingtalkbot.pid`。

## 已知平台假设（live 验证清单）

1. 群发 openConversationId == 入站 conversationId。
2. `/v1.0/oauth2/accessToken` 的 `expireIn` 单位（ms/s）。
3. 显式 ack（`{status:'SUCCESS'}` 结果体，SDK 包装为 `{response:…}`）足以抑制 60s 重推——观察 smoke 后日志无同 messageId 重复 `收到消息`。
