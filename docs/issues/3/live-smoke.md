# D3 live-smoke runbook（Commands / Access / Group policy）

真实钉钉环境验证步骤（owner 手动执行；CI 覆盖见 `tests/unit/{dispatch,gateway-commands,access,dedupe,session-store,claude-runner}.test.ts` + `tests/integration/run.test.ts`）。前置：D1/D2 live-smoke 已通过（连接、token、AI 卡模板）。

## 0. access.json 配置样例

`.bot/access.json`（0600，bootstrap 自动创建空表后手工编辑）：

```json
{
  "admin": ["<owner 的 senderStaffId>"],
  "approved": ["<同事 A 的 senderStaffId>"],
  "groups": ["<测试群的 openConversationId>"]
}
```

- senderStaffId 取自日志 `收到消息 … sender=` 字段；openConversationId 取自群消息日志的 `chat=` 字段。
- 每消息读盘：改完即生效，无需重启。

## 1. 四命令双端矩阵（AC1，S8–S11）

| 用例 | 操作 | 预期 |
|---|---|---|
| p2p /help | 私聊发 `/help` | 一条帮助文案（四命令 + 编号选答提示） |
| p2p /status | 私聊发 `/status` | 连接状态 + uptime + 会话哈希明细 + admin/approved 名单 |
| p2p /new | 私聊发 `/new` | "会话已重置"；下一条消息全新会话（无上文记忆） |
| p2p /stop | 私聊在回合生成中发 `/stop` | 先"正在中止当前回合…"，随后"已中止当前回合"，卡转错误终止态 |
| 群 @ /help 等 | 白名单群发 `@机器人 /help`（四命令同） | 与 p2p 同文案（/status 为计数版，无名单/明细） |
| 大小写/空格 | 发 ` /HELP ` | 命中 /help |
| 带参不命中 | 发 `/stop now` | 透传 agent 当普通消息（模型回复） |

全程确认：`latest.log` 无对应回合的 claude spawn 日志（命令不进 agent）。

## 2. 访问控制（AC2，S12）

- 未列入名单的同事 p2p 发任意消息（含 `/help`）：收到"抱歉，你未授权使用本机器人（不在使用名单内）。"，且无回合启动、无会话文件。
- 名单外发送者无法从拒绝文案获知任何命令名或配置信息。

## 3. 群策略（AC3/S3 + AC4/S3）

- 白名单群内任意成员 `@机器人 你好` → 正常进 agent 回合（群会话）。
- 把该群从 `groups` 移除后再 @ → 无任何回复，`latest.log` 出现 `非白名单群 conversationId=… @ 已忽略`。
- 把群加回 → 立即恢复（无需重启）。

## 4. access.json 容错（G2）

- 手改坏 JSON（如删一个引号）→ admin 发消息也收拒绝文本；日志一条 `access.json 读取/解析失败（fail-closed 全拒）`（同签名限频，不刷屏）；修好文件即恢复。

## 5. /new 在飞竞态（G3）

- 私聊让机器人跑一个长任务（如"写一段 3000 字的说明"），生成中发 `/new` → 收"会话已重置…当前在飞回合不受影响，将继续收尾"；当前回复完整送达；之后的追问无前文记忆。

## 6. /stop 长回合中止（G4）

- 长回合中 `/stop` → 卡转终止态（或 markdown 回退）；队列中若有先前排队的消息，终报披露"队列中仍有 N 条排队消息"。
- 无回合时 `/stop` → "当前无在飞回合。"

## 回填

完成后把结论回填本文件（逐项 ✓/✗ + 日志摘录），并在 SPEC.md D3 节把对应 live 清单项标注 `live-verified`。
