# dingtalkbot D4 决策记录（decisions.md）

- Issue: #4 "Attachments: downloadCode media download, voice/video archive-only"
- 日期：2026-09-13（r1）· 评审：codex-eval `kind=options` round 1 verdict `needs-attention`（12 项：5 认可、7 认可+收紧，另指出 5 个遗漏决策点）→ round 2 verdict `needs-attention`（5 项遗漏点裁决：D13 附条件采纳、D14/D16/D17 收紧采纳、D15 驳回原案改 (b) 修订版；D2/D8 复核认可）→ 全部裁决闭环，frontier 清空。
- 上游规格：issue 正文（内嵌 SRS 节，AC1–AC5 / S5–S7）+ repo `SPEC.md`（活契约，D1/D2/D3 节）。issue 已定事项（p2p 图/文件下载、语音视频归档+不可解析、下载失败聊天内报错、oversize/corrupt 降级不静默、30 天 prune、群 picture/richText 照常、群不投递 audio/video/file 属平台约束、chunked upload/转写 v2+ 出范围）不再重议。

## 平台事实（官方文档核实，2026-09-13）

- 下载 API：`POST /v1.0/robot/messageFiles/download`，header `x-acs-dingtalk-access-token`，body `{downloadCode, robotCode}`（均必填，**无需 unionId**——回调也不含 unionId），响应 `{downloadUrl}`；downloadCode 可能"有误或已过期"；月配额标准版 1 万次；文档提醒下载物可能带 `.file` 扩展名需自行命名。
- 回调载荷：`msgtype` = `text` / `picture` / `file` / `audio` / `video` / `richText`（注意：语音是 **audio** 不是 voice）。`picture: content.{pictureDownloadCode, downloadCode}`；`video: content.{duration, videoType, downloadCode}`；`audio: content.{downloadCode, recognition}`（recognition=平台 ASR 文本）；`file: content.{spaceId, fileName, downloadCode, fileId}`；`richText: content.richText[]` 混排 `{text}` 与 `{type:'picture', pictureDownloadCode, downloadCode}`。群 @ 仅投递 text/picture/richText。
- 统一用 `downloadCode`（picture 载荷中的 `pictureDownloadCode` 不使用，记入 SPEC 注记）。

## 媒体消息处理总顺序（多项决策的共同前设）

```
transport → dispatch（msgId 去重占位 → p2p 鉴权 → 群白名单 → 命令解析，全部不变）
→ agent-session 入口分流：text → 既有路径
                         picture/file/audio/video/richText → 忙线预检 → 媒体下载（30s 总 deadline）
                                                          → 失败：错误回复 + return（D8）
                                                          → 成功：prompt = context + 文本? + 附件注记 → 既有 会话/TTL/队列/回合 链
```

## D1: 模块结构

**选定 (a)+可注入**：新增 `src/openapi/media.ts`（`MediaClient`：downloadCode→downloadUrl 交换，镜像 CardClient 模式——token header、withDeadline、fetchFn/apiBase 可注入）与 `src/media/attachments.ts`（`AttachmentService`：载荷解析/下载落盘/注记生成/prune；结果窄契约、fetch/clock 可注入）。`src/transport/types.ts` 不动（raw 防御透传即既有契约）；richText 解析属业务逻辑归 media 模块。
Codex 条件（采纳）：OpenAPI 交换与任意 URL 下载语义分离（media.ts 只管 API，CDN GET 在 attachments.ts）；服务结果契约收窄。
不选 (b)（transport 层重复 typed 契约）；不选 (c)（agent-session 变解析+IO 巨块）。

## D2: 下载时机

**选定 (a)+准入顺序**：**到达时**（入队前）下载——downloadCode 短时效（文档明示可过期），排队在长回合后开跑大概率过期；feishubot 同款；prompt 引用稳定本地路径。
Codex 条件（采纳）：下载必须在 dispatch 准入（去重/鉴权/群白名单/命令）之后；agent-session 内先做**忙线预检**（`queue.queuedDepthOf >= queueMaxPerChat` 与 enqueue 同谓词）——满则直接忙线回复不烧配额；TOCTOU 竞态由 enqueue 返回 false 兜底（走既有忙线路径，已归档文件无害留待 prune）。
不选 (b)（长回合排队后过期，错误路径成常态）。

## D3: audio.recognition 平台 ASR 文本

**选定 (a)**：v1 严格按 issue——归档 + "内容不可解析"注记，**忽略 recognition**。spec Q9 明示 transcription v2+；携带 recognition 属行为扩展且 ASR 准确性未经验证。
Codex 认可（round 1 0.91 置信）。v2 低垂果实记录：非空 recognition 可附带（标注"平台 ASR，可能有误"），零 API 成本。

## D4: 大小上限

**选定 (a)+流式计数**：config 键 `media_max_bytes` 默认 **20 MiB**（文档化默认值，非平台推导——精确上限属 ops 输入缺口，见 FLAGGED）。流式字节计数，超限即中止并**删除半成品**；prompt 注记"附件过大未归档，内容不可用"+ warn 日志（措辞如实，不谎报"已归档"）。
Codex 条件（采纳）：超限尝试的已流字节数计入聚合预算（D13）；仅作 documented default。
不选 (b)（磁盘/时长无界）；不选 (c)（20→50MiB 加剧时限与磁盘压力）。

## D5: 时限

**选定 (a) 修订=单一 deadline**：整个媒体操作（交换+逐跳重定向+下载+落盘）共用**一个 30s deadline**（`media_deadline_ms` 常量，非 config），单次尝试 ≤30s，为 transport 级重试预算（50s）留 ≥20s。两个独立计时器可能叠出 40s+ 挤压错误回复与重试——codex round 1 修正。
不选 (b)（20MiB 下载 10s 必假失败）；不选 (c)（30s 下载+10s 交换=40s，重试预算不足）。

## D6: 文件命名

**选定 (a) 修订=full UUID**：`<randomUUID()>-<清洗后显示名>.<ext>`。file 用 `fileName` 清洗（去路径分隔/控制字符/反引号/前导点、限长 80）；picture/audio/video 扩展名由响应 content-type 白名单映射（小写：png/jpg/jpeg/webp/gif/bmp/amr/mp3/mp4，未知 `.bin`）。发布用 `link(temp, final)` 独占语义 + 碰撞重试（full UUID 下近零概率，机制兜底）。
Codex 修正（采纳）：uuid8 碰撞风险不可忽略 → full UUID；link+unlink 代替 rename-over（no-overwrite 发布）。
不选 (b)（owner 巡检不可读）；不选 (c)（路径穿越/碰撞）。

## D7: prune

**选定 (a)+生命周期收紧**：启动时**异步**执行 + 24h 定时器（single-flight 防重叠，`unref()`，暴露 `stop()` 供关停）；`lstat` 仅识别 `YYYY-MM-DD` 形状日期目录（不递归任意路径、不跟随 symlink）；文件 mtime < now-30d 删除；删除已空日期目录；逐文件容错、失败聚合计数 warn；删除计数 info；`now` 可注入测试。30 天硬编码常量（issue 明示 feishubot parity）。
不选 (b)（空闲时不可预测）；不选 (c)（长驻进程失效）。

## D8: AC4 错误语义

**选定 (a)+分类清理**：交换/下载失败 → 删半成品 → 回错误 markdown（`附件下载失败：<原因>，请重发`）→ **正常 return**（ack，占位保留——错误已终态送达用户）；错误回复自身发送失败 → 上抛 release 交 transport 有界重试（≤3 次，重试重走下载，对过期码无害）。失败分类（ expired / HTTP 4xx / 429 / 5xx / 网络）记入 warn；429/配额类错误同样终态（不额外重交换）。
Codex 复核（round 2 认可）：不做终态失败缓存——每失败消息最多 3 次 exchange，10k/月配额下可接受，换实现简单；监控 429 频次（D17），配额压力成真再议。
不选 (b)（一律上抛 → 用户最多收 3 条重复错误=重试风暴）。

## D9: richText 处理

**选定 (a)+确定性收紧**：按序遍历 `content.richText[]`：`{text}` 元素按序以空格拼接为消息文本（空文本元素跳过）；`{type:'picture'}` 元素（`downloadCode`）下载为附件+注记；**未识别元素类型**跳过并注记"含不支持元素"。p2p/群一致。多附件受 D13 聚合预算约束；全部附件共享 30s deadline。
不选 (b)（静默丢图，违反"照常处理"）。

## D10: agent-session 集成

**选定 (a)+顺序收紧**：入口分流——`text` → 既有路径不变；五种媒体 msgtype → media service 产类型化结果 `{text?, notes[]}` 组 prompt；**媒体无文本时 prompt = context + 注记**（不因空文本丢弃）；载荷解析失败/未知 msgtype → 沿用 warn 丢弃（日志含 msgtype/msgId）；下载失败 → 错误回复后 return 不入队；忙线/TTL/队列/回合全复用既有链。dispatch 层零改动（媒体消息 textContent=null 天然落 agent 路径）。
不选 (b)（dispatch 重复鉴权/错误/队列关注点）。

## D11: config 键

**选定 (a)**：仅新增 `media_max_bytes`（默认 20 MiB，走既有 POSITIVE_KEYS 正数校验）；保留期 30d 与 `uploads/YYYY-MM-DD/` 目录结构硬编码常量。
不选 (b)（uploads_retention_days 属 scope creep）；不选 (c)（容量调节被迫改码）。

## D12: 文档

**选定 (a)+时机收紧**：SPEC "Attachments（D4 契约）" 节 + `.bot/` 布局 `uploads/` 行更新 + CHANGELOG + `docs/issues/4/live-smoke.md` runbook **随实现同 PR 落地**；仅 `CI-verified` 标注在门禁全绿后回填（D3 G8 同款）。SPEC 内容覆盖：错误路径、配额、prune、保留期、群不投递约束、prompt 路径规则。runbook 红线：不贴 signed URL/downloadCode/用户文件内容。
不选 (b)。

## D13: 附件聚合预算（round 2 新增）

**选定 (a)+计费收紧**：每消息附件数上限 **5**、聚合字节上限 = `media_max_bytes`（与单文件同值，默认 20 MiB）——**含失败尝试的已流字节**（oversize/corrupt 中止前已计数部分）都计入聚合；超限附件降级为"超出限额未归档"注记 + warn，**不 fail 整条消息**（其余附件/文本照常）。5/20MiB 为文档化默认（精确值属 ops 缺口，FLAGGED）。
Codex 条件（采纳）：所有附件共享 30s deadline；每个未归档项都有显式注记（无静默）。

## D14: corrupt 的操作定义（round 2 新增）

**选定 (a) 修订=两类分离**：
- **download failed**（非 corrupt）：HTTP 非 2xx（含逐跳重定向失败）→ D8 错误回复路径。
- **corrupt**（降级注记路径）：body 为空 / picture 魔数校验失败（PNG/JPEG/GIF/WebP/BMP 魔数表，与 D6 扩展名映射对齐）→ 删文件 + "附件损坏未归档"注记 + warn。
- audio/video **不做魔数**（格式繁杂），content-type 缺失/泛化（octet-stream）不作为拒绝理由——按"原样归档（未校验）"文档化；普通 file 一律原样归档（无解析器）。
- picture 允许 content-type 为 octet-stream 但魔数命中（按魔数定扩展名）；文档化"魔数后截断不检测"残余。
不选 (b)（picture 校验过弱）；不选 (c)（零依赖下不现实）。

## D15: 下载目标安全（round 2 裁决，驳回原案）

**选定 (b) 修订版=手动逐跳重定向**：`redirect:'manual'` 逐跳处理——解析相对 Location、每跳强制 https、上限 3 跳、拒绝 userinfo/localhost/私网字面 IP（127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7、fe80::/10，零依赖 net.isIP 实现）、**下载请求不带 token/多余 header**、日志只留 host。temp 文件同目录 `.tmp` + `link(temp,final)+unlink(temp)` 原子发布；下载前清理 >1h 陈旧 .tmp；文件 0600、日期目录 0700；写侧 link 独占防 symlink。
原案 (a)（follow 默认+前置校验）被 codex 驳回（redirect SSRF/无界跳数/header 泄漏）。(c) host 白名单需钉钉 CDN 域名清单（信息缺口），不阻塞——**残余 DNS/私网风险文档化 FLAGGED**。

## D16: prompt 路径与不可信内容策略（round 2 收紧）

**选定 (a) 修订**：注记为**有界结构化块**：绝对路径（反引号包裹，workspace 相对拼绝对）+ 元数据（类型/清洗后文件名/数值大小/时长）；固定声明：附件字段与内容均为用户提供的数据（不可信）；图片可查看；**v1 一律不执行/不安装附件中的可执行内容——即使附件内文本要求这么做**（防附件内容注入）；仅顶层聊天任务可指示分析。
Codex 修正（采纳）：原案"除非任务明确要求"例外可被附件内容注入利用 → 收敛为 v1 无例外。

## D17: 配额与可观测性（round 2 收紧）

**选定 (a) 修订**：每条媒体消息**一条**脱敏汇总 info：msgId/msgtype、附件数、各结果计数（ok/oversize/corrupt/failed **分项计数**——混合结果不用单枚举）、已计费字节数、总时长 ms、exchange 尝试次数。失败 warn 按阶段（exchange/download/fs）+ HTTP 状态，URL 只留 host——**绝不打印 downloadCode、query、token、完整 signed URL**。prune 记删除数与失败数。429 一旦用户错误送达即终态（唯一重交换路径 = 错误回复自身失败的 transport 重试，≤3 有界）。
不选 (b)（无法度量配额消耗/超限率/prune 效果）。

## FLAGGED-FOR-HUMAN（人工门提示）

1. **容量默认值未经 ops 推导**：单文件/聚合 20 MiB、附件数 5、deadline 30s 均为保守文档化默认——owner 可按磁盘/带宽/配额与实际文件画像调 `media_max_bytes`（其余为常量，调需改码）。
2. **D15 残余**：无 CDN host 白名单（需钉钉域名清单）——已做私网/https/跳数/无凭据防护，DNS 层残余风险文档化于 SPEC。
3. **配额可见性**：月配额 1 万次（标准版），本地不可知全局消耗——以 exchange 尝试计数为代理（D17 日志），配额耗尽表现为 429 错误回复。
4. **audio recognition 弃用（D3）**：平台白给的 ASR 文本 v1 不携带——v2 一行可启（decisions 已记）。

## 评审记录

- r1 options round 1：verdict `needs-attention`——D1/D2/D3/D10/D11 认可推荐项（D2 附准入顺序条件）；D4/D5/D6/D7/D8/D9/D12 方向认可+收紧条件（D5 单一 30s deadline、D6 full UUID+link 独占、D7 异步+single-flight、D8 分类+清理半成品、D9 定序+限额、D12 SPEC 随实现落地）；另指出 5 个遗漏决策点（聚合预算/corrupt 定义/下载安全/prompt 策略/配额观测）→ 全部进 round 2。
- r1 options round 2：verdict `needs-attention`——D13 附条件采纳（失败字节计费、共享 deadline、逐项注记）；D14 收紧采纳（download failed 与 corrupt 两类分离、audio/video 不做魔数、octet-stream+魔数命中放行）；**D15 驳回原案 (a)** → 手动逐跳重定向修订版采纳；D16 收紧采纳（v1 无执行例外，防附件注入）；D17 收紧采纳（分项结果计数、exchange 尝试计数）；D2 忙线预检复核认可（TOCTOU 由 enqueue false 兜底）；D8 无终态缓存复核认可（≤3 次 exchange 有界，监控 429）。frontier 清空。
- 附注：round 2 报告首项 "No implementation diff supplied" 为 options 阶段固有（尚无代码），非缺陷。

### plan 评审引发的决策修订（r1 plan round 1 全部采纳）

- **AC4 错误原因脱敏（修订 D8 实现面）**：交换/下载失败的原因文本只保留安全形式——HTTP 状态码映射（`下载服务返回 HTTP <code>`）与 host，**绝不携带响应体/原始错误串**（可能含平台回显标识或完整 URL）；聊天错误文案与 warn 日志同源脱敏。
- **仅未知元素 richText 不再静默（修订 D9）**：纯 unknown 元素的 richText 返回有效结果 + 显式"不支持元素"注记（无附件则不出不可信 trailer）——"每个未处理项都有显式注记"语义贯彻到 richText。
- **IPv6 SSRF 收紧（修订 D15）**：私网判定增拒嵌入 IPv4（`::ffff:10.0.0.1`/NAT64）、unspecified `::`、`64:ff9b` 前缀；公网 v6 放行。
- **发布名扩展分离（修订 D6 实现面）**：file 显示名先 `stripExt` 再拼接——防 "报表.zip" 发布成 "报表.zip.zip"；`stripExt` 导出纯函数。
- **prompt 零变化公式（修订 D10 实现面）**：`prompt = \`${contextPrefix}\n${text ?? ''}\``，注记仅 `\n\n` 追加在后——text 消息与 D4 前字节等价（G9 由既有精确断言用例兜底）。
- **30s 与 50s 预算关系（D5 补注）**：媒体 deadline 计入 transport handlerBudgetMs（50s）总预算——错误回复失败触发的重试中第二次尝试被总预算截断，天然有界；run.ts 装配处留注记。
- **测试补面**：空 body corrupt、聚合耗尽后零交换、deadline 打断（deadlineMs 注入）、陈旧 .tmp 清理、发布防碰撞（uuid 注入）、AC4 错误回复失败上抛、群 @ 发图集成、mediaFactory 装配参数断言 + prune 启动清理实证、SPEC 配置节补键。
- **plan round 1 评审**：verdict `needs-attention`（12 项：2 项必假测试、G9 文本 prompt 回归、Task 6 占位实现、高危分支未测、IPv6 绕过、脱敏缺口、AC4 上抛未测、群/语音覆盖虚标、装配绕过、richText 静默、文档校验弱、配置文档缺）→ 全部采纳修复。

### plan 评审引发的决策修订（r1 plan round 2：7 采纳 + 1 部分采纳）

- **MediaClient 不读不记错误体（修订 D8/G7 实现面）**：HTTP 错误只抛 `HTTP <status>`——响应体可能含平台回显标识；安全文案映射由服务层完成（`下载服务返回 HTTP <code>`）。
- **分段式 prompt 公式（修订 G9 实现面）**：无注记 = 原 `\n` 单行模板字节等价；有注记时 text 有无两段式（`context\n\ntext\n\nnotes` / `context\n\nnotes`）——修掉 round 1 稿"三个换行"缺陷。
- **enqueue job 体全量入计划**：不再留"原样保留"注记式占位——完整回调逐字入 plan，唯一类型适配（`text ?? ''`）显式标注。
- **failed 分项计数（修订 D17 实现面）**：终态失败路径计数 `failed=N` 进汇总日志（D17 分项契约补全）。
- **扩展名映射=决定集（修订 D6）**：wav/m4a/aac/mov 越界映射删除——仅 png/jpg/gif/webp/bmp/amr/mp3/mp4，未知 `.bin`（格式契约不悄悄扩张）。
- **URL 解析收口**：`new URL` 抛错（如 999.1.1.1 的 WHATWG IPv4 解析失败）统一映射"非法下载目标 URL"（fail-closed）。
- **群 richText 集成用例**：群集成测试改用 richText（文本+图混排）载荷——群 picture 已由单元 parse/AC1 覆盖，集成层覆盖群 richText 组装。
- **signal 贯通部分采纳（finding 6，记录分歧）**：codex 要求 parent AbortSignal 贯通 dispatch→agent→media 与 50s 预算联动——跨层接口扩张（MessageHandler 契约变更）超 issue 范围；采纳米底语义：每次尝试 30s deadline 自限 + transport 50s 预算 racing 放弃后被弃尝试最迟 30s 自终止、落盘文件由 prune 兜底——残余（放弃后 ≤30s 的孤儿下载）文档化于 run.ts 注记。
- **plan round 2 评审**：verdict `needs-attention`（8 项）→ 7 采纳 + 1 部分采纳（上条）。

### plan 评审引发的决策修订（r1 plan round 3——评审预算终轮后落地）

- **重定向测试修正**：G5 用例的 exchange fake 须返回首跳 URL（原稿走不到跳转分支）；补"下载 HTTP 500"终态用例与"畸形/私网 Location 不泄露 URL"断言。
- **symlink 老化用 lutimesSync**：utimesSync 跟随符号链接会改目标 mtime——链接自身以 lutimesSync 老化（不跟随语义的确定性覆盖）。
- **交换超时分类（G1 收紧）**：共享 deadline 打断挂起交换 → `stage=deadline` 超时终态（非"网络错误"）；补挂起交换用例。
- **Location 解析收口（G7 收紧）**：`new URL(loc, base)` 的 TypeError（含原始 URL）统一映射"非法下载目标 URL"，绝不外泄。
- **failed 进契约文本**：G7 与 SPEC D4 可观测性行补 `failed` 分项（实现/测试已含，契约文本对齐）。
- **群 richText 集成用例真验文本**：fake 媒体按序提取 richText 文本段，断言 prompt 同时含两段用户文本与附件注记。
- **数字应答门控=仅 text 消息**：richText 提取的数字文本是媒体配文不当应答（注记不被丢弃）；补回归用例。
- **文件名字节预算**：清洗限长由 80 码元改 200 字节预算（255 NAME_MAX − uuid/扩展余量），code point 迭代截断不切代理对；补 CJK 超长用例。
- **孤儿尝试重复面驳回（finding 7，记录分歧）**：codex 称 50s racing 放弃后的孤儿尝试可产生重复回合/回复——经核实不成立：transport 重试在 msgId 去重占位未释放时被 dispatch 直接判重复丢弃，重复面既有机制已封；孤儿回合输出送达与文本消息语义一致（非 D4 回归）。signal 贯通仍不采纳（跨层扩张），run.ts 注记补去重兜底说明。
- **plan round 3 评审**：verdict `needs-attention`（9 项）→ 8 采纳 + 1 驳回（上条）。评审预算（3 轮）已尽，修订如上落地，未跑第 4 轮 codex；残余把关移交执行轮 code-review 与 Human-Review 人工门（D1–D3 同收口姿势）。

### 执行轮实现偏差（TDD 实测修正，2026-09-13）

- **v6 私网判定**：plan 稿 `includes('.')` 误伤普通域名、WHATWG URL 将 `::ffff:10.0.0.1` 归一为 `::ffff:a00:1`——实现改为冒号门控 + 归一化前缀拒（`::ffff:`/`64:ff9b`/ULA/link-local）；`new URL` 解析失败（如 999.1.1.1）统一"非法下载目标 URL"。
- **utimes/lutimes 数字参数按秒**：ms 数值会变未来时间戳——测试一律 Date 对象；symlink 老化用 `lutimesSync`（不跟随）。
- **Bun rmSync 对目录恒 EFAULT**：prune 空目录删除改 `rmdirSync`。
- **run 装配随 Task 6 提交落地**：`AgentHandlerDeps.media` 必填后逐提交门禁绿的必要并入（Task 7 提交仅含集成测试）。
- **dateDir 不 re-chmod**：原"已存在也 chmod 0700"会覆盖 owner 既有目录权限——改仅创建时设权（code-review r2 发现）。
- 沙箱环境 `DEBUG=1` 令既有 logger 用例失败（预先存在的环境依赖）——本地门禁 `env -u DEBUG`，非代码问题。

### 执行轮 code-review（2026-09-13，r1 Building）

- **r1（6 项）**：5 修复——写盘循环 deadline 兜底 + 落盘尺寸校验（截断即损坏，防"半图骗过魔数"）；发布仅 EEXIST 重试 + 链接撤回防孤儿副本；sanitize 增 Unicode 行分隔符（U+0085/2028/2029）清洗；MediaClient 网络异常源头脱敏（doFetch 就地泛化，外层仅自有安全文案）；清理失败（半成品/陈旧 tmp/prune 循环）全部 warn 可观测。1 驳回（F6"可执行禁令仅 prompt 级"）——即 decisions D16 既定设计且已 FLAGGED-FOR-HUMAN，执行层技术沙箱属 v2 范围（codex 自评置信 0.74）。
- **r2（6 项，全部采纳）**：write-all 短写推进循环；流结束后 deadline 复查（不发布过期回合产物）；token 获取与 abort 竞速；日期目录 symlink 拦截（lstat，防 mkdirSync recursive 跟随逃逸——既有目录 mode 校验残余接受：uploads 属 owner 控制面，非攻击者可达）；sanitize 增 bidi/零宽（U+200B-200F/202A-202E/2060-2069/FEFF）+ 注记文件名 JSON 引号定界；未消费响应体 cancel（连接归还）。
- **终判**：needs-attention → **addressed**（r1+r2 共 12 项：11 修复 + 1 驳回记录分歧）。评审预算（2 轮）用尽；残余把关移交 PR-Review 状态的 codex PR 评审与 Human-Review 人工门。门禁：typecheck + 225 tests + build + check:dist 全绿（`env -u DEBUG`）。
