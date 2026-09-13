# dingtalkbot SPEC

行为契约（v1 按波次追加：D1 传输+回复；D2 会话；D3 命令/访问；D4 附件）。
标注规则：`CI-verified` = 测试覆盖；`live-verified` = 真实钉钉环境验证（见 docs/issues/1/live-smoke.md）。

## Transport（D1 契约）

- 接收：官方 `dingtalk-stream@2.1.5`（exact pin）Stream 模式；订阅 `/v1.0/im/bot/messages/get`（TOPIC_ROBOT）；凭据 `.bot/.env` 的 `DINGTALK_CLIENT_ID/SECRET`。
- SDK 隔离：SDK 仅在 `src/transport/dingtalk-sdk-adapter.ts` 出现；port 定义于 `src/transport/types.ts`。替换 SDK 只改 adapter（CI-verified）。
- 连接监督：SDK autoReconnect 关闭，自有监督循环——**首次**连接 30s 内未 `connected+registered` 则启动失败（disconnect + 非零退出 + error 日志）；运行中断线按指数退避（1s 起 ×2 封顶 60s，成功重置）**永续**重连；socket close 事件立即触发重连，watchdog 轮询为双保险（CI-verified：fake-DWClient 契约测试）。
- 消息处理：回调 data 防御 JSON.parse；归一为 `InboundRobotMessage`（仅 text 提取原始 content，不 trim；其余 msgtype 透传 handler 决策）；处理完**显式 ack**——`socketCallBackResponse(messageId, {status:'SUCCESS', message})`（SDK 内部再包为 `{response:…}` 下发；回调返回值 SDK 不消费）；handler 失败本地重试 3 次后尽弃仍 ack（防服务端 60s 重推）；解析失败/尽弃/丢弃全部留 error/warn 日志（CI-verified）。

## Reply（D1 契约）

- 通道：OpenAPI REST + 自管 token；`sessionWebhook` 不使用（spec Q4）。
- token：`POST /v1.0/oauth2/accessToken`；内存+`.bot/token.json`（0600 原子写，按 clientId 指纹隔离——凭据轮换旧缓存失效）双缓存；到期前 5 分钟刷新；并发 single-flight（CI-verified）。expireIn 单位歧义由归一化处理并在 smoke 实测（live-verified 待回填）。
- 请求时限：token 与回复请求各 10s deadline（覆盖 fetch + body 读取），叠加 handler 3 次重试后总预算约 43s，落在钉钉 60s 重推窗口内（CI-verified）。
- p2p 回复：`POST /v1.0/robot/oToMessages/batchSend`，`userIds=[senderStaffId]`；群回复：`POST /v1.0/robot/groupMessages/send`，`openConversationId=入站 conversationId`（live-verified 待回填）；msgKey `sampleMarkdown`，msgParam `{title,text}`（CI-verified：载荷形状）。
- echo 行为：文本按字节原样回显（title `dingtalkbot`）；群消息不剥 @ 前缀（群策略是 D3）；非文本/空文本丢弃并留 warn 日志。

## CLI（D1 契约）

- `dingtalkbot setup [-r <ws>] [--client-id --client-secret]`：旗标空串/交互空输入 → 响亮失败；写 `.env`(0600) → 冒烟（token + Stream 连接）→ PASS / FAIL（FAIL 非零退出）。
- `run`：前台；启动失败非零退出；SIGINT/SIGTERM 优雅关停（断开、清 pidfile）。
- `start`：detached 后台 + `.bot/pids/dingtalkbot.pid`（{pid, startedAt} 抗 pid 复用）；重复启动/缺 .env 拒绝退出 1；陈旧 pidfile 自动清理。
- `stop`：先 pid+startedAt 双因子校验（pid 复用绝不发信号）→ SIGTERM → 15s 宽限 → SIGKILL → 清 pidfile。
- `status`：pid 存活性 + `.bot/state.json` 连接快照（transport 状态 + 更新时间）。

## `.bot/` 布局

`.env`（0600）· `config.json`（D1 空默认，键留 D2/D3）· `access.json`（{admin,approved,groups} 占位，D3 前无语义）· `token.json`（0600 token 缓存，含 clientId 指纹）· `state.json`（连接快照）· `sessions/ uploads/`（D2/D4 占位）· `logs/`（JSONL 每 run 一文件 `YYYYMMDD_HHMMSS.log` + latest.log 链接）· `pids/dingtalkbot.pid`。

## 已知平台假设（live 验证清单）

1. 群发 openConversationId == 入站 conversationId。
2. `/v1.0/oauth2/accessToken` 的 `expireIn` 单位（ms/s）。
3. 显式 ack（`{status:'SUCCESS'}` 结果体，SDK 包装为 `{response:…}`）足以抑制 60s 重推——观察 smoke 后日志无同 messageId 重复 `收到消息`。
