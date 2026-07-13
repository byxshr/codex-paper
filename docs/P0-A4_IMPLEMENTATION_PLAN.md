# P0-A4：下载器与 PDF Parser 隔离/限额实施记录

- 分支：`codex/audit-optimizations-2026-07-10`
- 开始日期：2026-07-13
- 开发状态：`Review 完成`
- 交付状态：`未推送`

## 目标与边界

- URL 默认只接受 HTTPS；初始请求和每次 redirect 都重新执行地址策略。
- DNS 结果必须全部是公开地址；连接固定到已验证 IP，同时保留原始 Host/TLS SNI，并校验实际 peer address。
- 下载使用私有随机 staging、独占 `0600` 文件、流式字节预算和 `%PDF-` magic；成功或失败后统一清理。
- parser 在独立受限进程组运行，限制 wall/CPU/内存、文件/输出、文件描述符和页数；超限时强制终止整组进程。
- 加密、异常、malformed 和超限 PDF 受控失败并写入私有、有配额和保留期的 quarantine。
- 不改变生成代码 Docker sandbox；不在本轮解决深层版面质量、事务发布或跨平台容器 parser。

## 固定策略

- 下载/本地输入：最大 128 MiB；redirect 最多 5 次；每个响应使用 30 秒总 wall-clock 预算，不由持续数据流重置。
- PDF：必须以 `%PDF-` 开头；页数范围 1–2000。
- parser：wall 60 秒、CPU 45 秒、地址空间 1 GiB、输出文件 64 MiB、stdout/stderr 各 1 MiB、open files 64。
- quarantine：`~/codex-papers/.quarantine/`，目录 `0700`、文件 `0600`，最多 32 项/512 MiB，默认保留 7 天；过期或超配额按最旧优先清理。

## 实施步骤

1. 新增机器可读 PDF ingestion policy 和共享 preflight/quarantine 模块。
2. 重写 downloader：HTTPS、SSRF 地址分类、redirect 复验、DNS pin/peer 校验、流式上限和随机 staging。
3. 将 `prepare-paper.js` 改为直接使用 staging API，并在 `finally` 清理；合法无 `.pdf` URL/本地文件可被接受。
4. 新增 parser launcher/worker；父进程负责 wall/output gate，worker 内执行 PyMuPDF/pdf-parse 并实施加密、页数和输出契约。
5. 增加 deterministic security tests、真实 parser integration、Repository Guard、根 `pdf-security-test` 与 CI gate。
6. 更新 study skill、README、CHANGELOG、安全文档和审计台账；刷新 cachebuster、官方验证并重装 active plugin。

## 验收

- loopback、RFC1918、link-local、ULA、IPv4-mapped IPv6、metadata/reserved 地址及其 redirect 均被拒绝。
- DNS rebinding、peer mismatch、超长/无限流、错误 Content-Length、伪 PDF、symlink 输入均 fail closed。
- 加密、malformed、超大、超页数、parser timeout/超输出在预算内失败，不遗留 staging 或孤儿 parser。
- 异常输入只进入私有、有界 quarantine；不记录 URL 凭据或暴露绝对来源路径。
- 现有 parser、reasoning、package、Viewer security、sandbox、build 和 smoke 回归保持通过。

## 回滚

回滚 P0-A4 代码后必须保留 HTTPS-only 与 `%PDF-` 最小拒绝策略；不得恢复共享可预测下载目录、无限流或无 wall-time 的 parser。quarantine 是本地诊断数据，回滚代码不会自动删除。

## 实施结果

- downloader 已改为 HTTPS-only、逐跳 DNS/地址复验、DNS pin + Host/SNI 保留、peer address 校验和 128 MiB 双重流预算。
- 本地与远程输入统一进入 `mkdtemp` 私有 staging，使用随机 `0600`、`O_EXCL`、`O_NOFOLLOW` 文件；`prepare-paper.js` 在 `finally` 清理。
- production parser 已迁移到 supervisor → POSIX launcher → worker 进程组；普通进程直接调用 worker 内部入口会拒绝。
- parser 实施 60 秒 wall、45 秒 CPU、1 GiB RSS watchdog、512 MiB Node heap、64 MiB result、1 MiB stdout/stderr、64 open files 和 2000 页限制。
- 加密、超页数和 malformed synthetic PDF 均在临时 library 中受控失败并进入私有 quarantine；真实用户论文库未被测试读写。
- 独立 Code Review 无阻塞项；采纳 F1/F2，补齐 IPv4-compatible IPv6 拒绝及同步写盘异常的流终止、Promise 拒绝和 staging 清理。
- F3 保留为有意的 fail-closed 策略：30 秒是完整响应的总 wall-clock 预算，而非可被持续滴流重置的 idle timeout。
- 第二轮独立 Code Review 复现 PDF security 12/12、Guard tests 40/40 和 repository contract，通过首轮整改复核且无新增 findings；P0-A4 无遗留跟进项。
- active plugin 已通过官方验证并重装为 `2.0.0+codex.20260713121349`。

## 验证结果

- Repository Guard：40/40；repository/security tests：90/90，其中 PDF ingestion security 12/12；study tests：23/23。
- parser benchmark 5/5、reasoning 12/12、package 11/11。
- production build、Viewer HTTP security integration、smoke test：通过。
- W3C 公网 HTTPS 小 PDF 的真实 DNS pin、TLS/SNI、peer、流式 staging 和 `%PDF-` 验证：通过并清理。
- `/tmp` 中 downloader、parser supervisor 和 parser worker 临时目录残留扫描：为空。

## 已知非阻塞风险

- RSS 是 100ms 采样 watchdog，Node heap/CPU/文件限制为独立硬边界；parser 尚未运行在容器/cgroup 中，宿主内核和 parser 依赖仍属于可信计算基。
- quarantine 当前仅由新 ingestion 失败触发，不提供 UI、手工 purge 或审计导出；这些属于后续生命周期治理。
