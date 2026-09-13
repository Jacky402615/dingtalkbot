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
- 网关命令：`/new`（epoch 代际重置）/ `/stop`（按聊天中止在飞回合、诚实超时文案）/ `/status`（群内脱敏为计数）/ `/help`——剥 @ 精确匹配，永不到达 agent；msgId 去重上收 dispatch（原子占位/失败释放）（issue #3）。
- 访问控制与群策略：`access.json`（admin/approved/groups）手工白名单每消息读盘、fail-closed；陌生 p2p 明确拒绝；非白名单群 @ 静默留日志（issue #3）。
- D4 附件：p2p 图片/文件下载（downloadCode→临时 URL→`.bot/uploads/YYYY-MM-DD/`，手动逐跳安全下载）且 prompt 携带本地路径与不可信声明；语音/视频归档但声明不可解析；richText 文本+图片混排处理（群 picture/richText 照常——群 audio/video/file 平台不投递）；下载失败回聊天内错误（脱敏原因）；超限/损坏降级注记不静默；uploads 30 天自动 prune（issue #4）。
- config 新键 `media_max_bytes`（默认 20 MiB，单文件=每消息聚合上限）；媒体可观测性日志（脱敏汇总 info + 结构化失败 warn）（issue #4）。

### Changed
- 破坏性变更（issue #3）：此前任何可见者均可驱动 agent；D3 起未列入 access.json 的 p2p 发送者收拒绝文本、非白名单群 @ 无响应。
- 行为变更（issue #4）：此前非文本消息一律 warn 丢弃；D4 起 picture/file/audio/video/richText 五类媒体消息进入 agent 会话（带下载/归档注记）。
