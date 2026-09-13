# Changelog（Keep a Changelog zh-CN / SemVer）

## [Unreleased]
### Added
- DingTalk Stream 传输骨架：官方 SDK 2.1.5（exact pin）+ 自有指数退避监督（首次超时响亮失败、运行期永续重连）、显式 ack、防御性消息归一（issue #1）。
- OpenAPI 回复通道：single-flight token 管理（凭据指纹隔离的内存+磁盘缓存、到期前刷新）+ p2p/群 markdown 回复 client（issue #1）。
- CLI：setup（凭据+冒烟）/ run / start / stop / status（pid 复用防护）；`.bot/` 工作区布局（issue #1）。
- SPEC.md 行为契约（D1 波次）与 CI 门禁（typecheck/test/build/check:dist）（issue #1）。
