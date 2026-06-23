# Mobile Codex Remote 中文使用指南

中文产品首页：[README.md](README.md)
English guide: [README.en.md](README.en.md)

Mobile Codex Remote 是一个用浏览器控制 Codex 会话的轻量控制台。它可以同时管理本地电脑、远程 Linux 主机和 HPC 集群上的 Codex 会话，让你在桌面浏览器或手机上新建、恢复、派生、打断、引导、审查、导入导出和监控长时间运行的 Codex 工作。

英文 README: [README.en.md](README.en.md)
本次更新报告: [docs/update-report-2026-06-05.md](docs/update-report-2026-06-05.md)
v2.01 阶段说明归档: [README_v2.01.md](README_v2.01.md)

## 功能概览

- 多 host 控制：本地电脑、远程 Linux、HPC 登录节点都可以接入同一个 relay。
- 会话发现：从每台 host 的 Codex home 读取历史，通常是 `~/.codex`。
- Managed Codex app-server 会话：支持新建、恢复、派生、停止、打断、steer、compact、plan 和 review。
- 会话搜索：支持关键字、路径、标题类信息和消息内容搜索。
- 会话排序：支持按创建时间、最近更新时间、消息数量排序。
- 实时尾随 Codex rollout JSONL：用于历史 transcript、runtime 状态、token usage、diagnostics、requests 和 transcript 更新。
- Composer 附件：支持本地文件、图片、host 图片路径、prompt card、skills、导入的历史会话。
- 会话导出：支持 Markdown、JSON、Zip bundle，并可筛选日期范围、thinking/activity、图片、文件、扩展名和具体文件。
- 会话导入：支持从当前会话导入，也支持多选其他会话；每个会话都可以单独选择是否包含 thinking、图片和文件。
- 文件传输：支持浏览器到 host 的文件上传、大文件分片上传、内联图片/文本缓存、远端文件卡片。
- 模型和 skills 列表：增加超时和自动重试冷却，避免后台请求失败时刷屏。
- Plan mode / request user input：当模型要求用户选择选项或输入自定义文字时，UI 会弹出表单。
- API profiles：支持为不同 host 配置 OpenAI 兼容 API key 和 base URL。
- Managed session 使用隔离的 Codex home，降低和本机交互式 Codex CLI 共用状态导致冲突的风险。
- 移动端友好：抽屉导航、transcript 控制、图片预览、状态窗口、alerts、紧凑 runtime chips。
- HPC connector：支持 SSH key、密码、keyboard-interactive、OTP/MFA、gateway/jump host、tmux bootstrap 和 detached fallback。

## 架构

```text
手机/浏览器 -> relay 网页/API 服务 -> host-agent -> Codex app-server
                                     -> 本地文件 / HPC 工作目录
```

- `apps/relay`：提供 Web UI、API、SSE、轻量状态、命令中转、文件缓存和会话导出。
- `apps/host-agent`：运行在被控制的电脑或 HPC 上，负责启动和管理 Codex app-server 等 runtime。
- `apps/mobile-web`：桌面和手机共用的浏览器 UI。
- `shared`：协议、connector、会话发现、transcript 和存储工具。

relay 建议运行在可信私有网络里。手机远程访问推荐使用 Tailscale、校园 VPN 或其他私有网络，不建议直接暴露到公网。

## 环境要求

- 推荐 Node.js 22 或更新版本。
- Git。
- 每台要控制的 host 上安装 Codex CLI。
- 如果要从本机 bootstrap 远程/HPC host，本机需要 OpenSSH。
- Windows 一键启动需要 PowerShell。

## 安装

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
```

当前项目主要使用 Node.js 内置模块，通常不需要安装依赖。如果之后加入依赖，再执行：

```bash
npm install
```

## 快速启动

### Windows 一键启动

双击：

```text
start-windows.bat
```

这个 bat 会调用 `scripts/start-windows.ps1`。默认行为：

- 使用端口 `8797`，除非设置了 `PORT` 或传入 `-Port`；
- 打开一个 PowerShell 窗口运行 relay；
- 打开另一个 PowerShell 窗口运行本地 host-agent；
- 日志写入 `tmp/windows-start/`；
- 自动打开 `http://127.0.0.1:8797`。

示例：

```powershell
.\start-windows.bat
.\start-windows.bat -Port 8787
.\start-windows.bat -Port 8797 -HostId my-pc -HostLabel "My PC" -NoBrowser
.\scripts\start-windows.ps1 -DryRun
```

使用期间请保持 relay 和 host-agent 两个窗口打开。

### Windows 桌面端使用方法

Windows 端和手机端共用同一个网页 UI，只是桌面浏览器更适合同时看导航栏、transcript、文件卡片和设置面板。启动后先在左侧 `当前 HOST` 选择本机 Windows host，例如 `ILLUIN Windows`，再进入对应会话。

<p align="center">
  <img src="docs/assets/readme/windows-desktop-session.png" alt="Windows 桌面端会话、文件预览和控制栏" width="48%" />
  <img src="docs/assets/readme/windows-host-manager.png" alt="Windows 端 host 管理和本地重启控制" width="30%" />
</p>
<p align="center">
  <img src="docs/assets/readme/windows-api-profiles.png" alt="Windows 端 API profile 和 host 映射设置" width="32%" />
  <img src="docs/assets/readme/windows-export-options.png" alt="Windows 端会话导出选项" width="32%" />
  <img src="docs/assets/readme/windows-history-attachments.png" alt="Windows 端历史导入导出附件" width="32%" />
</p>

常用能力：

- 文件在线可视化、下载和打开：Codex 输出文件路径或生成文件后，消息里会出现文件卡片。图片、SVG 等可预览文件可以点 `Preview`，本机文件可以点 `Open` 调用系统默认程序，任何文件都可以点 `Save` 下载到浏览器。已经被 relay 缓存的图片和文本会保留在 transcript/export 里；未缓存的大文件仍建议让 Codex 直接读取 host 上的路径。
- 自动扫描所有对话并导入：host-agent 会扫描对应 host 的 Codex home，Windows 通常是 `%USERPROFILE%\.codex\sessions`，Linux/HPC 通常是 `~/.codex/sessions`。扫描到的历史会话会按 host 出现在左侧列表里，可以搜索、排序、收藏到 collection，并用 `Resume From History` 恢复成 live managed session。
- API 切换：进入 `Settings -> API profiles` 新建或编辑 OpenAI 兼容 profile，填写 Base URL 和 API Key，然后在 `Host API 映射` 中给 Windows、Linux 或 HPC 指定 profile。点击 `Ping` 可以验证该 host 能否使用当前配置。API profile 变更只会影响新建或重启后的 managed Codex app-server session，已经运行中的 session 会继续使用启动时的 API 环境。
- 对话历史导入导出：会话右上角 `Export` 可以导出 Markdown、JSON 或 Zip bundle。导出面板支持日期范围、具体日期多选、`Select all dates`、thinking/activity、图片、文件、扩展名和具体文件筛选。Composer 里的 `Current` 会把当前会话导出后附加到输入栏，`Others` 可以多选其他会话并为每个会话单独选择是否包含 thinking、图片和文件。
- 跨平台导入导出：Windows、远程 Linux 和 HPC 都接入同一个 relay 后，历史会话、导出包和附件可以跨 host 使用。比如可以把 HPC 会话导出成 `.history.md` 和 `.history.zip`，再放进 Windows 会话继续分析。Zip 会包含已缓存的图片和文件，Markdown 会保留原始 host 路径，方便回到对应机器继续打开或读取。

### npm 脚本启动

同时启动 relay 和一个本地 host-agent：

```bash
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:8787
```

常用脚本：

```bash
npm run dev
npm run relay
npm run agent
npm run test:managed
```

- `npm run dev`：启动 relay 和一个本地 host-agent。
- `npm run relay`：只启动 relay。
- `npm run agent`：只启动当前机器的 host-agent。
- `npm run test:managed`：运行 managed session 和文件传输 smoke test。

自定义端口：

```bash
PORT=8797 npm run relay
```

Windows PowerShell：

```powershell
$env:PORT = "8797"
npm run relay
```

## 网页基本用法

常见操作：

- `New In Directory`：在选中 host 的指定目录新建 Codex 会话。
- `Resume From History`：把历史会话恢复成 live managed session。
- `Fork New Branch`：从当前会话派生新的 live 分支。
- `Stop Session`：停止当前 live 进程，但保留历史。
- `Interrupt`：打断当前 Codex turn。
- `Steer`：在支持时给当前 turn 增加引导。
- `Plan`：切换持续 plan-only 发送模式，直到退出 plan mode。
- `Review`：让 Codex 审查当前工作区改动。
- `Compact Context`：调用 Codex app-server 原生 compact 流程。
- `Export`：导出当前会话历史。
- Composer 里的 `Current` / `Others`：把当前会话或其他会话的导出结果附加到输入栏。

输入框快捷键：

- `Enter`：发送消息。
- `Shift+Enter`：在输入框内换行。
- 输入 `/`：打开命令菜单。
- 点击 `+`、拖拽文件或粘贴图片：添加附件。

## 历史导出和导入

导出支持：

- Markdown、JSON、Zip bundle。
- 日期范围筛选。
- 可选 thinking/activity。
- 可选图片和非图片文件。
- 文件扩展名筛选。
- 具体文件选择。

导入支持：

- `Current`：把当前选中会话导出后附加到 composer。
- `Others`：多选其他会话，并为每个会话单独选择 thinking、图片、文件。

每个导入的会话都会生成一个 Markdown 历史附件。如果包含图片或文件，会额外附加一个 Zip bundle。较小的 Markdown 会作为文本附件内联；较大的历史文件会作为普通文件上传。

## 文件传输

- 浏览器文件可以上传到选中 host。
- 大文件使用分片上传。
- 内联图片和文本文件会被 relay 缓存，因此能在 transcript/export 里显示为文件卡片。
- 远端生成或接收的文件可以在消息卡片里打开或保存。
- 超大数据集建议留在 host 文件系统里，让 Codex 按路径读取，不建议通过浏览器上传。

## 手机访问

如果手机和 relay 电脑在同一个局域网，使用电脑的局域网 IP 访问：

```text
http://192.168.1.20:8787
```

把 IP 和端口换成你的实际地址。

## Tailscale 访问

Tailscale 下载地址：

```text
https://tailscale.com/download
```

推荐流程：

1. 在 relay 电脑和手机上安装 Tailscale。
2. 两台设备登录同一个 tailnet。
3. 在 relay 电脑上启动 relay 和 host-agent。
4. 查看 relay 电脑的 Tailscale IP，通常是 `100.x.y.z`。
5. 手机打开：

```text
http://100.x.y.z:8787
```

如果 relay 使用其他端口，把 `8787` 换成对应端口。

## 添加远程主机或 HPC

打开：

```text
Settings -> Hosts and connectors -> Manage HPC
```

新建 connector，常用字段：

- `Label`：显示名，例如 `dm`、`hkl`、`lab-gpu`。
- `Relay URL`：远端 host-agent 能访问到的 relay 地址。
- `Target host`：远程服务器或 HPC 登录节点。
- `Target port`：SSH 端口。
- `Login username`：SSH 用户名。
- `CODEX_HOME`：通常是 `~/.codex`。
- `Workspace roots`：可浏览的工作目录，一行一个。
- `Remote agent directory`：例如 `~/mobile-codex-remote`。
- `tmux session name`：例如 `codex-remote`；如果没有 `tmux`，`Start Agent` 会退回 detached 进程和 pid 文件。

保存后可以使用：

- `Run Test`：测试 SSH 登录。
- `Start Agent`：部署并启动远端 host-agent。
- `Restart Agent`：项目更新后重启远端 host-agent。
- `Check Status`：检查远端 tmux 或 detached agent 状态。

如果集群需要 OTP/MFA，页面会在 SSH 需要时提示输入新的验证码或密码。

## 远端安装 Codex CLI

HPC/conda 环境推荐：

```bash
conda create -n codex-node -c conda-forge nodejs=20 -y
conda activate codex-node
npm install -g @openai/codex
codex --help
```

个人 Linux 服务器也可以使用 `fnm`：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
fnm use 20
npm install -g @openai/codex
codex --help
```

安装完成后，回到网页里重启远端 host-agent。

## API Profiles

打开：

```text
Settings -> API profiles
```

可以添加多个 OpenAI 兼容 API profile，例如 OpenAI 官方 key、反代 base URL 或实验室代理。不同 host 可以绑定不同 profile。变更会在新建或重启 managed Codex app-server session 时生效；已经运行中的 session 会继续使用启动时的 API 环境。

Managed session 会使用隔离的 Codex home，避免 API profile 和 app-server 状态覆盖 host 默认的交互式 Codex 配置。

## 开发检查

```bash
node --check apps/relay/server.js
node --check apps/host-agent/agent.js
node --check apps/host-agent/codex-app-server-runner.js
node --check apps/mobile-web/public/app.js
npm run test:managed
```

## 常见问题

- 如果 model 或 skill 列表超时，重启选中的 managed session 和 host-agent，然后手动刷新。
- 如果 API key 或 base URL 变更后没生效，重启对应 managed session。
- 如果 Windows 启动窗口闪退，运行 `.\scripts\start-windows.ps1 -DryRun` 或查看 `tmp/windows-start/*.log`。
- 如果远端 connector 仍在运行旧代码，relay 拉取更新后使用 `Restart Agent`。
- 如果浏览器上传文件太大，把文件留在 host 上，把路径发给 Codex。

## 当前限制

- relay 的 runtime 状态比较轻量，host-agent 重连后会重新上报 live 状态。
- 历史会话需要 Resume 或 Fork 后才会变成可交互 live session。
- Stop、Interrupt、queued prompt 等主动控制需要 managed Codex app-server session。
- 不同 HPC 的 SSH/MFA 策略差异很大，connector 可能需要按集群调整。
- 浏览器传输适合工作文件，不适合替代 host 侧的大数据集。
