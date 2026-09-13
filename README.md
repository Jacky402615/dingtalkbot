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
