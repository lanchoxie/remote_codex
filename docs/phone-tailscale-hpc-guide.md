# 手机、Tailscale 与 HPC 快速使用指南

这份说明面向“手机控制本地电脑和 HPC 上 Codex”的日常使用。公开仓库里不写死私人内网 IP、用户名、密码、SSH key 或 OTP；这些信息只应该保存在你本机的 connector 配置和本机浏览器里。

## 推荐架构

```text
手机浏览器
  -> Tailscale 私有网络
  -> 电脑上的 relay:8797
  -> 本地 host-agent / HPC host-agent
```

手机不直接 SSH 到 HPC。HPC 上的 host-agent 会主动连回 relay，relay 再把网页输入、文件上传、审批、状态事件转发给对应 host。

## 电脑端准备

1. 安装 Node.js 22 或更新版本。
2. 安装并登录 Codex，确认本机有 `~/.codex`。
3. 克隆并进入项目：

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
git checkout v2.1.0
```

4. 启动 relay 和本地 agent：

```bash
npm run dev
```

5. 浏览器打开启动日志里显示的地址，常见是：

```text
http://127.0.0.1:8797
```

首次打开会要求创建网页登录账号。这个账号只保护你的 relay 网页入口，不会上传到 GitHub。

## Tailscale 手机访问

1. 电脑和手机都安装 Tailscale。
2. 两台设备登录同一个 tailnet。
3. 在电脑 Tailscale 客户端里查看本机 `100.x.y.z` 地址。
4. 手机上打开 Tailscale，并访问：

```text
http://100.x.y.z:8797
```

5. 输入 relay 网页账号密码，即可看到本地和已连接的 HPC host。

安全建议：

- 不要在路由器上做公网端口转发。
- 不要把 `8797` 裸露到公网。
- Tailscale 账号建议开启 MFA。
- 给朋友体验时，优先发 GitHub 仓库或 release/tag，不要发你的 live relay 地址、登录密码、recovery token、SSH key、HPC 密码或 OTP。

## 导入 / 启动 HPC

网页里点 `设置 -> Host 与连接器 -> Manage HPC`，新建一个 connector。

常用字段：

- `Label`：显示名，例如 `hkl`、`dm`、`Campus HPC`。
- `Relay URL`：HPC 能访问到的 relay 地址。Tailscale 场景通常填 `http://电脑的Tailscale IP:8797`。
- `Target host`：HPC 登录节点或最终目标节点。
- `Target port`：SSH 端口。
- `Login username`：HPC 用户名。
- `CODEX_HOME`：通常是 `~/.codex`。
- `Workspace roots`：常用工作目录，每行一个；建议至少写 `~`，需要时再加项目目录。
- `Remote agent directory`：远端项目目录，例如 `~/mobile-codex-remote`。
- `tmux session name`：例如 `codex-remote`。

如果不需要 gateway：

- `Gateway` 选择 disabled。
- 只填 target host / port / username / target auth。

如果需要 gateway / jump host：

- 开启 Gateway。
- 填 gateway host、port、username。
- 根据集群要求选择 SSH key、password、keyboard-interactive、OTP/MFA 等。

操作顺序：

1. `Save Connector` 保存配置。
2. `Run Test` 测试 SSH 路径。
3. 如果提示密码或 OTP，按弹窗输入当前有效内容。
4. `Start Agent` 把 host-agent 上传/启动到远端 tmux。
5. 成功后左侧 host 下拉里会出现这个 HPC host。
6. 切换到该 host 后，可以浏览目录、导入历史、resume、fork 或在目录中新建会话。

## 我们自己的 HPC 应该怎么填

把私人连接信息填进网页的 connector 表单，不要写进 README 或提交到 GitHub。

建议在本机用两个 connector 分别保存：

- 一个给需要 gateway 的 HPC，例如 label 写 `hkl`。
- 一个给可直连登录节点的 HPC，例如 label 写 `dm`。

字段填写原则：

- `Label` 用你熟悉的短名。
- `Relay URL` 用电脑的 Tailscale 地址，手机和 HPC 都能连到它。
- `CODEX_HOME` 填 `~/.codex`。
- `Workspace roots` 填 `~`，再加常用项目根目录。
- 密码和 OTP 只在本机弹窗里输入；如果选择保存密码，它只会进入本机 ignored 的 `tmp/connector-secrets.json`。
- Google Authenticator 六位码过期后，下一次 `Run Test` / `Start Agent` / reconnect 会重新弹窗让你输入新验证码。

如果 `Run Test` 通过但 `Start Agent` 失败，优先看错误属于哪一步：

- `prepare_directory` 失败：远端目录不可写或 SSH 认证过期。
- `upload_bundle` 失败：SSH/SCP 断开、OTP 过期、权限不足，或 Windows OpenSSH ControlMaster socket 异常。
- `probe_node_runtime` 失败：远端没有 Node，connector 会尝试上传本地 runtime；如果仍失败，建议在远端 conda/uv 环境里安装 Node。
- Codex 启动失败：检查远端 `~/.codex`、Codex CLI 是否可用，以及 SQLite state 是否损坏。

## 远端安装 Codex/Node 的常见方式

如果远端没有 Node.js：

```bash
conda create -n my_node_env -c conda-forge nodejs=20
conda activate my_node_env
```

安装 Codex：

```bash
npm install -g @openai/codex
```

个人服务器或树莓派也可以用 fnm：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
fnm use 20
npm install -g @openai/codex
```

## 常见恢复操作

- 网页 UI 更新后：刷新浏览器。
- host-agent 功能更新后：在 `Manage HPC` 点 `Restart Agent`。
- relay 重启后：刷新网页，必要时重启本地/HPC host-agent。
- session 卡住：在会话详情里用 `Interrupt` 或顶部 `Stop Session`。
- API key 改了：结束当前 live session，再 resume/fork，让新 Codex 进程吃到新环境。
