# P0-A3：生成代码执行策略与 Docker Sandbox 实施记录

- 分支：`codex/audit-optimizations-2026-07-10`
- 开始日期：2026-07-13
- 开发状态：`Review 中`
- 交付状态：`未推送`

## 决策

- 学习包 validator 永久保持静态，不接受任何生成代码执行参数。
- 只支持通过一致性测试的 Docker backend；不支持裸机、`sandbox-exec`、bubblewrap、Podman 或 shell fallback。
- 代码执行必须先展示完整计划，再由用户对该计划进行一次性明确授权。
- 当前开发机没有 Docker，预期状态为 `unavailable`；本地不安装容器引擎，真实隔离测试由后续 CI 运行。
- Viewer 不增加代码执行接口，继续保持 P0-A2 的静态主动内容边界。

## 实施内容

- 独立 sandbox policy、digest 固定的 Dockerfile 和可信资源统计 entrypoint。
- capability/conformance gate、代码树 no-follow 扫描、固定解释器 argv、容器强制清理。
- 5 分钟、256-bit、代码哈希/镜像/策略绑定的单次授权。
- `.codex-paper/execution-reports/` 中的 no-follow、原子、权限受限审计报告。
- 根命令、Repository Guard、CI conformance、synthetic fixture 和文档接入。

## 验收标准

- 默认 paper-study 和 package validation 不执行生成代码。
- 无 Docker、错误镜像或缺少当前 conformance stamp 时不能签发授权或执行。
- 支持平台上的容器无网络、只读源、空宿主凭据环境、非 root、资源受限且无残留。
- 授权过期、重放、跨论文或代码变化均失败。
- 报告记录哈希、固定 argv、边界、资源、输出截断和退出原因，但不记录授权或宿主凭据。

## 回滚

回滚 P0-A3 源码与文档后，重新安装上一 cachebuster。回滚不得恢复 validator 裸机执行；如需临时停用本功能，应保留静态 validator 并让 sandbox capability 始终 fail closed。已有执行报告属于本地审计记录，不应随代码回滚删除。

## 实施结果

- package validator 已移除所有进程执行能力；旧执行参数以 exit `2` 明确拒绝。
- Docker-only runner 已实现 digest-pinned image、capability/conformance stamp、固定 argv、隔离参数、资源统计、输出/超时终止和容器强制清理。
- 授权采用 5 分钟单次 token，并绑定重新扫描的完整代码树、镜像和策略；执行前额外创建并复核只读快照，缩小授权后的 TOCTOU 窗口。
- token 只证明计划完整性、时效性和单次消费，不认证人类身份；human-in-the-loop 由 skill 流程强制在展示计划后暂停并等待新的用户明确回复。
- 新建授权时清理过期 token；容器 wrapper 的资源统计经宿主严格校验并标记为非权威数据，不用于安全 gate。
- 执行报告使用 no-follow 预留文件和原子发布，Viewer 不新增任何执行 API。
- active plugin 已重装为 `2.0.0+codex.20260713091303`，路径为 `plugins/codex-paper/`。

## 验证结果

- Repository Contract：通过，当前 tracked baseline 156 个文件。
- Repository Guard：36/36；repository/security tests：72/72，其中 P0-A3 sandbox tests 15/15；study tests 23/23。
- parser 5/5、reasoning 12/12、package 11/11。
- production build、Viewer HTTP security integration、smoke test：通过。
- 本机实际 `sandbox-status`：`unavailable`，原因 `docker CLI is not installed`，exit `3`；plan 不签发 token，run fail closed。
- 官方 plugin validator、Repository Contract、marketplace reinstall 和 active-path/version 检查：通过。
- 两轮独立 Code Review 已通过且无遗留代码 finding；Round 2 结论为 merge-ready pending real-Docker CI。
- 真实 Docker conformance 未在本机运行，按已确认方案由后续 push/PR CI 强制执行；在 CI 通过前不得将 P0-A3 标为 `Review 完成`。

## 已知非阻塞项

- Web dependency audit 仍报告既有 34 项依赖告警，属于 P1-3 依赖治理范围，本轮未运行自动修复。
- Docker daemon、宿主内核与官方 base-image distribution 属于可信计算基。
