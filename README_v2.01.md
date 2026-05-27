# Mobile Codex Remote v2.01 阶段说明归档

这个文件保存 v2.01 阶段的项目说明和设计笔记。当前主 README 已改成面向使用者的安装、启动、导入和 Tailscale 使用指南。

## 当时的目标

我们希望把 Codex 从“只能在当前电脑/IDE 里操作”扩展成一个可以从手机控制的多平台系统：

- 手机能看到不同 host 上的 Codex 会话。
- 手机能继续控制已经在电脑或 HPC 上运行的 Codex。
- host 断开浏览器后，Codex 仍能通过 host-agent 保持运行。
- 本地电脑和 HPC 都可以接入同一个 relay。
- 不把 SSH 密码、OTP、API key 或本地敏感配置提交到 GitHub。

## v2.01 阶段实现过的核心能力

- `apps/relay`：提供网页、API、SSE、host 注册、connector 管理和会话状态中转。
- `apps/host-agent`：运行在本地电脑或 HPC 上，发现 `~/.codex` 历史并启动 managed Codex app-server session。
- `apps/mobile-web`：手机优先的网页 UI。
- 多 host 切换：本地、HPC、远程 Linux 可以并列显示。
- HPC connector：支持 gateway/jump host、SSH key、密码、keyboard-interactive、OTP/MFA、tmux bootstrap。
- 会话搜索和收藏夹：支持关键词、路径、标题类信息和跨 host 收藏。
- Codex 控制：模型、推理强度、summary、approval policy、reviewer、sandbox、plan、review、interrupt、steer、compact。
- 文件传输：从浏览器上传到选中 host，并把远端回复里的文件/图片路径转换为可打开或保存的卡片。
- 手机 UI：导航栏折叠、会话详情合并、收藏夹下拉、状态弹窗。

## 当时记录的限制

- relay 仍然是轻量本地工具，不是多用户权限系统。
- 大部分 runtime 状态保存在内存里，relay 重启后需要 host-agent 重新上报。
- imported history 需要 Resume 或 Fork 才能变成 live session。
- 远端 host-agent 必须和本地 relay 版本匹配，否则图片输入、模型列表、文件下载等新功能可能不可用。
- 不同 HPC 的 MFA 策略差异很大，connector 仍需要按具体集群调整。

## 安全结论

v2.01 阶段已经明确：不要把 relay 直接暴露到公网。安全分享方式是发 GitHub 仓库链接，让朋友自己 clone、自己配置 host、SSH、OTP 和 API key。远程访问建议使用 Tailscale、WireGuard 或校园 VPN。
