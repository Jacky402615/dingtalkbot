# D1 live smoke runbook（需 Jacky 参与执行）

前置：钉钉开发者后台已建企业内部应用 + 机器人能力（Stream 模式）并发布；拿到 ClientId/ClientSecret。

1. 凭据冒烟（AC5 真凭据 PASS 分支）：
   `node dist/cli.js setup -r <workspace> --client-id <id> --client-secret <secret>`
   预期：写 .env；输出 `token 获取成功`、`Stream 连接+订阅成功`、`smoke: PASS`。
2. 假凭据响亮失败（AC5 FAIL 分支）：
   `node dist/cli.js setup -r <tmp-ws> --client-id x --client-secret y`
   预期：`smoke: FAIL`，退出码非 0（`echo $?` ≠ 0）。
3. 网关起停与状态（AC1/AC5）：
   `node dist/cli.js start -r <workspace>` → `status` 显示运行中 + connected → `stop`。
4. p2p 回显（AC2）：在钉钉私聊机器人发文本 `hello`；预期数秒内收到 markdown 回显 `hello`；`.bot/logs/latest.log` 含 `p2p 回显完成`。
5. 群 @ 回显（AC2）：把机器人拉入测试群，@机器人 发文本；预期群内 markdown 回显；日志含 `群回显完成`。
6. 断线重连（AC3）：断网 30s 再恢复；预期日志出现 `reconnecting` 后恢复 `connected`，期间进程不退出。
7. 证据回填：本文件末尾追加执行记录（日期/步骤/结果日志摘录）；SPEC.md 的三个 `live-verified` 待回填项据此勾选。

## 已知假设验证位
- [ ] 群发 openConversationId == 入站 conversationId（若群回显失败：核对 groupMessages/send 响应 `InvalidConversationId`，修正 openConversationId 来源）
- [ ] expireIn 单位：看步骤 1 日志中 `[token] token 已刷新 expireIn=<原始值> → TTL=<归一化值>ms expiresAt=<epoch ms>`——TTL≈7,200,000ms 即毫秒语义/归一化正确；TTL≈7,200ms 或 expiresAt 异常则修正 normalizeExpiry
- [ ] 显式 ack 抑制 60s 重推（连发 3 条消息，日志无同 messageId 重复 `收到消息`）

## 执行记录
（待人工执行后回填——2026-09-13 执行轮：CI 可验证部分已全部完成（57 测试 + typecheck + build + check:dist 绿），本环境无钉钉真凭据，活体验证移交 Human-Review。）
