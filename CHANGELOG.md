# Changelog（Keep a Changelog zh-CN / SemVer）

## [Unreleased]
### Added
- DingTalk Stream 传输骨架：官方 SDK 2.1.5（exact pin）+ 自有指数退避监督（首次超时响亮失败、运行期永续重连）、显式 ack、防御性消息归一（issue #1）。
- OpenAPI 回复通道：single-flight token 管理（凭据指纹隔离的内存+磁盘缓存、到期前刷新）+ p2p/群 markdown 回复 client（issue #1）。
- CLI：setup（凭据+冒烟）/ run / start / stop / status（pid 复用防护）；`.bot/` 工作区布局（issue #1）。
- SPEC.md 行为契约（D1 波次）与 CI 门禁（typecheck/test/build/check:dist）（issue #1）。
- Agent 会话层：claude CLI 无头回合（stream-json 解析、消息域文本累计、AskUserQuestion 拦截）、per-chat 会话存储（idle-TTL resume、原子写、幽灵会话作废）、per-chat 有界串行队列（关停丢弃语义）、进程组看门狗（issue #2）。
- AI 卡流式回复：createAndDeliver + streamingUpdate OpenAPI client（IM_GROUP/IM_ROBOT 路由）、时间+字节双阈值节流（配额保护）、回合级卡桥（isError 收终与"恰好一条 markdown 全文"回退链）（issue #2）。
- AskUserQuestion 文本降级：卡内编号列表渲染 + 纯数字应答解析（多选/多题按位映射，多题+多选降级文字回复）；群消息剥前导 @ 提及（issue #2）。
