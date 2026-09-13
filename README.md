# dingtalkbot

DingTalk（钉钉）聊天网关：官方 Stream 模式长连接收信 + OpenAPI REST 回信，为 claude agent 会话提供第三个指挥面（feishubot 同族）。

## 安装

```sh
npm install --registry=https://npm.pkg.github.com @jacky402615/dingtalkbot
```

## 快速开始

```sh
dingtalkbot setup -r <workspace>   # 录入 DINGTALK_CLIENT_ID/SECRET + 凭据冒烟
dingtalkbot start  -r <workspace>  # 后台启动网关
dingtalkbot status -r <workspace>  # 查看连接状态
dingtalkbot stop   -r <workspace>  # 停止网关
```

| 命令 | 说明 |
|---|---|
| `setup` | 交互/旗标录入凭据并冒烟（token + Stream 连接） |
| `run` | 前台运行 |
| `start` / `stop` | 后台守护启动 / 停止（pidfile + 宽限关停） |
| `status` | pid 存活 + 连接快照 |

行为契约见 [SPEC.md](./SPEC.md)。

## 会话与回复配置（D2）

回复以钉钉 **AI 卡**流式呈现（打字机）；需先在钉钉卡片平台创建含 AI markdown 组件（变量名默认 `content`）的模板，将模板 ID 填入 `<workspace>/.bot/config.json`：

```json
{
  "ai_card_template_id": "<模板 ID>",
  "session_idle_ttl_minutes": 60,
  "model": "glm-5.3-flash"
}
```

未配置模板时自动降级纯 markdown 回复（日志 warn）。消息驱动工作区目录下的 claude 会话（p2p 按人、群按群各一会话，空闲 60 分钟内续接）；完整配置键见 SPEC.md「配置（D2 契约）」。

## 访问控制与命令（D3）

`<workspace>/.bot/access.json` 是白名单（手工编辑、每消息读盘即生效）：

```json
{
  "admin": ["<staffId>"],
  "approved": ["<同事 staffId>"],
  "groups": ["<群的 openConversationId>"]
}
```

- **默认空表 = 全员拒绝**（含 admin）：未列入 `admin`/`approved` 的 p2p 发送者收到拒绝文本，非白名单群的 @ 静默忽略（仅日志）。`senderStaffId` 从日志 `收到消息 … sender=` 获取，`openConversationId` 从群消息日志 `chat=` 获取。
- 文件损坏/形状非法时 fail-closed 全拒（日志响亮限频 warn），修好即恢复。
- 网关命令（p2p 与群 @ 通用，剥 @ 后精确匹配）：`/new` 重置会话、`/stop` 中止当前回合、`/status` 连接与会话状态（群内脱敏为计数）、`/help`。
- agent 以 `bypassPermissions` 运行：暴露面 = 白名单全体成员，名单与群成员治理是 owner 责任。
