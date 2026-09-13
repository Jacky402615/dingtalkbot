# D2 live smoke runbook（需 Jacky 参与执行）

前置：
1. 钉钉卡片平台创建含 AI markdown 组件（变量名 `content`）的卡片模板并导入应用 → 取模板 ID 填 `.bot/config.json` 的 `ai_card_template_id`（变量名非 `content` 时同步设 `card_content_key`）。
2. 确认应用可见范围/机器人所在会话受控（bypassPermissions 暴露窗口——FLAGGED-FOR-HUMAN 1）。

验证步骤：

1. **AC1（p2p 卡片往返）**：`dingtalkbot start -r <workspace>` 后，p2p 发「用一句话介绍你自己」→ 预期打字机流式 + 卡终态 finished；`latest.log` 含 `卡片收终 bytes=… flushes=… suppressed=…`。
2. **AC2（TTL resume / 超时新起）**：60 分钟内追问「我上一句问了什么」→ 上下文保留（resume）；等 TTL 过后再问 → 无上下文新会话，`.bot/sessions/` 对应文件 sessionId 变化。
3. **AC3（串行）**：agent 回答期间连发第二条消息 → 第二条等第一条卡收终后才开始（无交错流）。
4. **AC5（问题桥）**：发「问我一个选择题」→ 卡内编号列表 → 回复 `2`（或 `1,3`）→ agent 按选择继续。
5. **AC6（节流观察）**：长回复期间 `latest.log` 的 `卡片流式 bytes=… delta=… intervalMs=… suppressed=…` 行——刷新频率 ≈ 每 1.5s/64B 一次；据此校准 `card_stream_min_interval_ms/min_bytes`（FLAGGED-FOR-HUMAN 2）。
6. **AC4（破坏性，可选）**：临时改错模板 ID 重启 → 回复降级为**恰好一条** markdown 全文 + error 日志；恢复后正常。
7. **关停核查**：`dingtalkbot stop -r <workspace>` 后 `pgrep -f 'claude -p'` 为空（无残留子进程）。

## 证据回填位

- [ ] AC1 卡片 finished 截图 + `卡片收终` 日志摘录（____-__-__）
- [ ] AC2 resume/新会话日志与 sessions 文件对比（____-__-__）
- [ ] AC5 编号列表 + 数字应答往返（____-__-__）
- [ ] AC6 节流日志摘录与配额余量结论（____-__-__）
- [ ] 应用可见范围确认（FLAGGED 1）（____-__-__）
