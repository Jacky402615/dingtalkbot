# dingtalkbot D3 决策记录（decisions.md）

- Issue: #3 "Commands, access control, group policy"
- 日期：2026-09-13（r1）· 评审：codex-eval `kind=options` round 1 verdict `needs-attention`（13 项：12 项认可推荐项+收紧条件采纳；D8 排队语义分歧以 issue 正文原文裁决，不设人工门）
- 上游规格：issue 正文（内嵌 SRS 节，AC1–AC4 / S3 / S8–S12）+ repo `SPEC.md`（活契约，D1/D2 节）。issue 已定事项（四命令清单、access.json 手工编辑 v1、群=openConversationId 白名单、陌生 p2p 明确拒绝、非白名单群静默+日志）不再重议。

## 消息处理总顺序（多项决策的共同前设）

```
msgId 去重（同步占位） → p2p: 鉴权（admin∪approved 放行，其余拒绝）
                      → group: 白名单校验（非白名单静默+日志）
                      → 命令解析（剥 @、trim、大小写不敏感精确匹配）
                      → 委派 agent-session handler（既有链路不变）
```

## D1: 分发架构

**选定 (a)+拆分**：新增 `src/access.ts`（access.json 加载/判定）与 `src/handlers/commands.ts`（命令解析/执行），`run.ts` 装配一个外层 dispatch handler 包住 agent-session handler。
Codex 条件（采纳）：dispatch 内一切 IO/解析异常映射为 fail-closed 正常回复（p2p 拒绝文本）或仅日志（群）——**绝不向 transport 抛出**（否则触发 3 次重试风暴）。
不选 (b)（agent-session 职责混杂）；不选 (c)（transport 层重复实现 p2p/群语义）。

## D2: 校验顺序

**选定 (a)**：p2p 先鉴权——陌生人**连 `/help` 都收不到**，只有固定拒绝文本；群先白名单；群内不查发送者身份（见 D3）；然后命令解析；最后委派 agent。
拒绝文案（采纳 codex 收紧）：固定泛化语句（"当前未授权使用本机器人，请联系管理员"级别），不含命令名、不含 access.json 字样——不泄露命令面与配置面。

## D3: 群内发送者身份

**选定 (a)**：白名单群内任何成员的 @ 都处理（群授权 = owner 把 bot 拉进群；issue 只规定 openConversationId 白名单）。
Codex 条件（采纳）：SPEC D3 节明确信任边界——白名单群内任意成员（含离职未清者）均可驱动 bypassPermissions agent，群成员治理是 owner 责任。

## D4: access.json 读取与容错

**选定 (a)**：每条消息读盘（手工编辑即时生效；消息量低）+ 解析失败 fail-closed（全部按陌生处理，含 admin——单 owner 手改 typo 自锁可接受，修文件即恢复，写入运维注记）。
Codex 收紧（采纳）：
- warn 按错误指纹限频（同一签名只响一次，签名变化重置）——防重推/刷屏；
- 读文件遇 ENOENT 单次立即重试——容忍手工编辑器的原子替换（rename swap）瞬间。

不选 fail-open（安全控制不可失效放行）；不选 mtime 缓存（低消息量零收益、时基边界）；不选启动读一次（手工编辑需重启）。

## D5: admin vs approved v1 权能

**选定 (a)**：四命令权能完全相同；admin/approved 区分 v1 仅信息性（/status 展示用；管理命令族 out of scope）。
Codex 条件（采纳）：SPEC 与 /status 输出注明 admin v1 为占位语义，防假权限预期。

## D6: /status 输出与群内脱敏

**选定 (a)+codex 收紧版**：
- **p2p**：transport 状态 + 进程 uptime/启动时间 + 会话清单（`SessionStore.list()`：chatKey 哈希、lastActiveAt、pending 标记）+ admin/approved 完整名单 + 群白名单计数。
- **群 @**：仅健康概览与**计数**（transport 状态、会话数、ACL 计数）——会话明细与他人名单不向全群广播（chatKey 哈希在 staffId 字典下可被还原，属隐私泄露；codex 指出原案"同上"错误，采纳收紧）。
残余（记录，v2 可收紧）：p2p 的 /status 向 approved 用户展示**他人**会话明细与 admin/approved 名单——issue 将 /status 定义为 ops 状态命令且明列 "admin/approved lists"，信任层级一致；若 owner 认为 approved 互不可见，v2 再分层。
不选 (b)（群内全量广播）；不选 (c)（违反 AC1 四命令 p2p/群一致可用）。

## D7: /new 在飞回合竞态（codex 修正实现方案）

**选定 (a) 改用代际计数**：用户最常在回合跑飞时发 /new。`SessionStore` 增：
- `reset(chatKey)`：delete 留痕 + 内存 `epochs: Map<chatKey, number>` 自增；
- `SessionRecord` 增 `epoch` 字段（随文件持久化，跨重启无害——重启后 epoch 从 0 起，旧记录 epoch 更大只会被判"非陈旧"，方向正确）；
- `beginTurn`/`load` 在取记录时盖上当前 epoch；
- `persist(record)`：`record.epoch < epochs.get(chatKey)` → **跳过**（在飞回合结束时的 persist 不复活 reset 前的旧 sessionId）；
- reset 后 `load`=null → 排队中的消息出队开跑时走既有对账路径（fresh===null → 全新会话）——该路径 D2 已正确，无需改。
在飞回合**不杀**（杀是 /stop 职责），其卡片照常收终。
否决时间戳墓碑（codex：墙钟 vs 单调时基混用，NTP 回跳误杀新会话）；否决裸 delete（在飞 persist 复活旧 id）；否决 reset 入队（命令不得被队列阻塞，队满时 /stop、/new 会失效）。

## D8: /stop 语义

**选定 (a)**：`TurnRequest` 增 `chatKey`；runner 维护 per-chat ActiveChild 索引，新增 `abortChat(chatKey, reason)`（TERM → killDelay → KILL，同 killAll 纪律；run 以 forcedError 结算）。job 的既有 `!ok` 路径走 `bridge.fail` → 卡 isError 收终——"clean card/stream close" 由既有机制承担。**只杀在飞、不清排队**。
裁决记录（对 codex 分歧）：codex 认为排队语义需 owner 确认——issue 正文原文 "/stop (abort in-flight turn, clean card/stream close)" 已定义范围，非信息缺口；为缓解直觉冲突，确认文案披露队列状态（"仍有 N 条排队消息"）。
Codex 条件（采纳）：abortChat 幂等（重复 /stop → "当前无在飞回合"）；settle 后摘索引防泄漏；首回合被中止沿用既有 `!ok && !resume → delete` 规则（下条消息自然全新会话）。
不选 (b)（清队列=已 ack 消息静默丢失，超 issue 范围）；不选 (c)（全局 killAll 伤及无辜 chat）。

## D9: 命令语法与未知 /xxx

**选定 (a)+大小写不敏感**：剥 @ 后 trim，对四命令**大小写不敏感**精确匹配（v1 无参数）；未知 "/xxx" 不拦、透传 agent 当普通消息。
Codex 条件（采纳）：SPEC 注明未知斜杠会到达 agent（claude `-p` 将 prompt 作字面文本交模型，平行命令面不存在于 CLI 层，但心智模型需文档化）；(b) 会拦截 "/proc/meminfo 是什么" 类正常提问，功能回退，否决。

## D10: 去重集成（codex 修正为原子占位）

**选定 (a)+占位语义**：抽 `MsgIdDedupe` 类：`reserve(msgId): boolean`（**同步** check+add，在任何 await 之前完成——单线程事件循环内无重推竞态窗口）与 `release(msgId)`（送达/入队失败撤销，transport 重试可重入）。
- dispatch 层持有实例并前置 reserve；陌生拒绝=拒绝文本送达成功保留占位（失败 release）；群非白名单=幂等（仅日志）保留占位。
- agent-session 注入同一实例替换内部 Set，保留"入队成功/忙线文本送达成功才保留，否则 release"的既有纪律。
不选双层独立 Set（跨层漂移）；不选只留 agent-session 内 Set（命令/拒绝路径不受去重保护）。

## D11: /status 会话枚举

**选定 (a)+聚合告警**：`SessionStore.list()`：readdir sessions 目录逐文件 parse，最小 schema 校验（chatKey/sessionId/lastActiveAt 类型），坏文件**聚合计数后一次 warn**（含跳过数），按 lastActiveAt 降序。
不选索引文件（crash/手改下漂移，第二真相源）。

## D12: 文档与遗留措辞

**选定 (a)+warn 风险不弱化**：SPEC.md 增 D3 节（Commands/Access 契约，含 D3 信任边界与 D9 透传注记）；run.ts bypassPermissions warn 措辞改为 "agent 仍以 bypassPermissions 运行，暴露面 = access.json 白名单（admin/approved/群白名单）全体"（不删除、不弱化——codex：落地后残余风险仍在）；config.ts `DEFAULT_ACCESS` 占位注释更新为 D3 生效语义；/help 内容定义（四命令一句话说明 + 数字选答提示）；CHANGELOG 增条目（未知 /xxx 透传、群非白名单静默、陌生 p2p 拒绝均为行为变化）。

## D13: /stop 确认与卡收终时序

**选定 (a)+即时反馈+有界等待**：/stop 收到后**立即**回 "正在中止当前回合…"；`abortChat` 的 settle 由 TERM→killDelay(5s)→KILL 升级定时器保证有界（defensive：await 外再加 killDelay+2s 超时兜底，超时也回最终确认并 error 日志）；settle 后回最终确认（含队列深度披露）。卡 isError 收终在 job 内紧随 run settle 异步发生，可能晚于确认文本——接受（用户看得到卡终止态）。
不选 queue.waitIdle（后续入队可无限拖延确认，与 D8-a 叠加不可控）。

## FLAGGED-FOR-HUMAN（人工门提示）

1. **D6 残余**：p2p /status 向 approved 用户展示他人会话明细与 admin/approved 名单（issue 原文如此定义信任层级）；v2 若需分层再议。
2. **D3 信任边界**：白名单群内任意成员可驱动 bypassPermissions agent——群成员治理（移除离职者）是 owner 责任，SPEC 已注明。
3. **D4 自锁**：access.json 手改 typo → fail-closed 全员拒绝（含 admin），修文件即恢复——运维注记写入 SPEC。

## 评审记录

- r1 options 评审：verdict `needs-attention`，13 项全部裁决——D1/D2/D3/D5/D9/D11/D12 认可推荐项+收紧条件采纳；D4 采纳+限频与 ENOENT 重试；D6 采纳 codex 收紧（群内会话明细降级为计数）；D7 采纳 codex 修正（时间戳墓碑→代际计数）；D8 按 issue 正文原文裁决排队语义（分歧记录，不设人工门）+幂等/索引清理条件采纳；D10 采纳 codex 修正（原子占位）；D13 采纳+即时反馈与超时兜底。summary="主干方向均可走，但开工前必须修 D6 群内会话泄露、D7 墓碑时基/排队 sessionId 绑定、D10 去重原子占位，并向 owner 确认 D8 排队语义" → 四项均已在本记录裁决闭环（D8 由 issue 原文闭环）。frontier 清空。

### plan 评审引发的决策修订（r1 plan round 1 采纳）

- **/status 会话明细哈希化（修订 D6 实现面）**：`SessionStore.list()` 增 `chatKeyHash`（文件名 16hex），渲染只出 `[p2p|group] <hash>`——原始 staffId/openConversationId 不回显（codex：比"哈希"决策更严重的泄露）。
- **装配切换单提交化（修订 D1 实现面）**：run.ts 接 dispatch 与 agent-session 内部去重上收必须在**同一提交**完成——中间 HEAD 若"去重已删、dispatch 未接"会丢生产去重（过渡期并存则语义一致：上游先滤、内部 Set 永不触发）。
- **装配/lastState 测试真实化**：run.test.ts 装配用例写真实断言（/help 回复、陌生拒绝、白名单消息仍达 runner）；gateway.test.ts 补 `lastState` 更新用例（/status 数据源非恒 null）。
- **AC1 端到端**：dispatch.test.ts 增"dispatch × 真实 executor"用例（四命令双端真实回复、runner/agent 零触达），防 dispatch 与 commands 组装错位。
- **access readFile 可注入**：`createAccessLoader(file, logger?, readFile?)`——ENOENT 重试分支以注入 fake 确定性覆盖（真实 fs 的 rename-swap 时序不可测）；补"损坏后 admin 也拒"实证（tierOf unknown）。
- **/stop 超时诚实文案（修订 D13）**：防御性 race 超时后不谎报"已中止"——error 日志 + "未在预期时间内确认完成"文案；测试覆盖悬挂分支。
- **/new 对账竞态集成用例（修订 D7 验证面）**：真实 store+queue+挂起 fake runner——A 在飞、B 排队跨 reset：A/B 的 persist 均被墓碑拦截、B 对账后新 sessionId、C 全新会话。
- **驳回一项（记录）**：codex 称 `TurnQueue.depthOf` 缺生产实现——经核实为误报（`src/agent/turn-queue.ts:17` 既有），计划改为显式引用该既有 API。
- **CI-verified 后置回填（修订 D12）**：SPEC D3 节先落**不带** CI-verified 的文案，Task 9 门禁全绿后再回填——文档不得预claim验证。
- **plan round 1 评审**：verdict `needs-attention`（9 项：depthOf 误报、/status 哈希、Task6/7 中间回归、装配测试占位、AC1 e2e、ENOENT 重试未测、/stop 超时谎报、/new 对账未测、CI-verified 提前）→ 8 项采纳，1 项驳回（depthOf，已核实既有）。

### plan 评审引发的决策修订（r1 plan round 2 采纳）

- **abortChat 返回实际中止数（修订 D8）**：`Promise<number>`——快照期 `isSettled()` 过滤 + `abort()` 返回 boolean（是否实际发起强制中止）；/stop 据此三态回复：已中止（N>0）/ 已自然结束（0）/ 超时未确认（防御上界）——"正在中止"发送窗口内自然完成的回合不再被误报为已中止。
- **AC1 e2e 索引断言修正**：回复序为每命令先 p2p 后群（md[6]=p2p /help、md[4]=p2p /status、md[3]=group /stop）——原稿断言错位，照写必假失败。
- **G3 用例升格**：/new 对账竞态集成用例从 Task 7 注记升格为显式 Step（代码/Files/commit 齐备）。
- **agent-session 去重测试迁移入 Task 7**：删除内部 Set 依赖用例（等价覆盖在 dispatch G5），保留其余全部。
- **G1 口径收窄（修订 D1 措辞）**：按 D1 原决议口径——access 加载/解析异常 fail-closed 不上抛；命令本地逻辑经既有实现异常安全，残余本地异常与发送失败同路径上抛由 adapter 有界重试消化（reset/abort 幂等，重试无副作用）。
- **plan round 2 评审**：verdict `needs-attention`（5 项：e2e 索引错、G3 dangling、测试迁移缺失、G1 范围、/stop 自然完成误报）→ 全部采纳。

### plan 评审引发的决策修订（r1 plan round 3 采纳——评审预算终轮后落地）

- **load() 重盖章（修订 D7，真 bug 修复）**：`load()` 返回 `{...rec, epoch: 当前内存代}`——否则重启后内存代归零、磁盘记录可能携带更大的旧代（重启前 reset 过 N 次），后续 /new(→1) 对 epoch=5 的记录恒判不陈旧 → 旧 sessionId 跨重启复活。重盖章后取值点统一为"取用时的代"，陈旧比较恢复正确；补"种子高 epoch → 新 Store → reset → 陈旧 persist 拦截"回归用例。
- **G3 用例归属修正**：/new 对账竞态集成用例移入 Task 2（其依赖的 epoch/对账字面量均在该 task 落地，原放 Task 7 的 FAIL 预期与依赖序矛盾）；Task 7 改为迁移+装配+lastState。
- **Gateway.lastState 验证**：gateway.test.ts 补 snapshot→lastState 更新用例（否则 lastState 恒 null 现有测试仍全绿，/status 违 D6 而不可见）。
- **SPEC G1 口径对齐**：D3 节措辞改为"access 异常 fail-closed 不上抛；其余失败上抛由 transport 有界重试"——与实现/decisions 一致，CI-verified 回填不虚假声明。
- **abort 计数竞态收紧**：`ActiveChild.abort` 返回 boolean（settled 竞态窗口内不计）；abortChat 只累加实际发起数；runner 测试补"自然完成的 chat 返回 0"。
- **plan round 3 评审**：verdict `needs-attention`（5 项）→ 评审预算（3 轮）已尽，5 项全部在计划内修复（本节即修订记录），未再跑第 4 轮 codex；残余把关移交执行轮 code-review 与 Human-Review 人工门（D1/D2 同收口姿势）。
