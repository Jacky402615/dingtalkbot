# D4 附件 live-smoke runbook（issue #4）

owner 真机执行；完成一项勾一项。**记录红线：本文件与任何反馈记录中不得出现 signed URL、downloadCode、token、用户文件内容**（日志已脱敏，截图同样注意）。

前置：access.json 白名单含执行者 staffId；`.bot/config.json` 可选 `media_max_bytes`（默认 20 MiB）；`dingtalkbot run`（或 start）已启动。

## AC1/AC2：p2p 图片与文件

1. p2p 发一张图片给机器人 → 机器人答复应能描述图片内容（说明 prompt 携带路径且 claude 读了图）。
2. 验证 `.bot/uploads/<今日 YYYY-MM-DD>/` 出现 `<uuid>-picture.png`（0600、目录 0700）。
3. p2p 发一个文件（先用普通英文名，再用中文名如 `报表 v2.zip`）→ 答复应能引用文件名；落盘名 `<uuid>-报表 v2.zip`（无路径穿越、无 `.zip.zip`）。
4. `.bot/logs/latest.log`：找到媒体汇总行（`msgId=… msgtype=picture … ok=1 … bytes=… exchange=1`）；确认无 downloadCode/URL 出现（G7）。

## AC3：p2p 语音与视频

5. p2p 发一段语音 → 落盘 `<uuid>-voice.<ext>`；答复应声明"无法读取语音内容"类表述（不转写）。
6. p2p 发一段视频 → 落盘归档；答复同样声明不可解析。
7. 语音消息若平台回调带 `recognition` 字段：确认 agent 答复**不使用**该识别文本（D3 决策：v1 不携带）。

## AC4：下载失败路径

8. 等效验证：在 `.bot/config.json` 临时把 `media_max_bytes` 设为 1024 → 发一张图 → 应回"附件过大"注记路径（agent 仍答复，说明附件不可用）→ 恢复配置。
9. 真实过期场景不可人为构造（重发旧消息不可行）——观察点：任一次真实交换失败时，聊天内出现"附件下载失败：<原因>。请重新发送该附件。"恰一条（非静默、非重复刷屏）。

## 群消息（平台投递面）

10. 白名单群 @ 机器人发图 → 群内答复应引用图片（群 picture 照常下载）。
11. 白名单群 @ 机器人发图文混排（引用回复带图）→ 答复应同时体现文本与图片。
12. （负向，信息性）群内 audio/video/file 平台不投递——无需验证机器人行为，SPEC 已记录约束。

## AC5：prune

13. 手工种旧文件：`mkdir -p .bot/uploads/<31天前日期> && touch -d '40 days ago' .bot/uploads/<日期>/x.png` → 重启网关（或等 24h 定时）→ 文件与空目录消失；今日文件不受影响。
14. 重启后日志出现（如有删除）`uploads prune：删除 N 个文件、M 个日期目录`。

## 日志脱敏抽查（G7）

15. 抽查 latest.log 的媒体相关行：只有 host 级 URL 信息（如有）、状态码、计数；grep 不到 downloadCode 原文与 `x-acs` token。

## 结果记录

- 执行日期 / 环境：
- 通过项：
- 异常项（含现象与日志行摘录——脱敏）：
