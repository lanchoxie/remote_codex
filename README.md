# Mobile Codex Remote

Mobile Codex Remote is a lightweight web control plane for Codex sessions running on local computers, remote Linux hosts, and HPC clusters. It lets you switch between hosts, resume or fork Codex conversations, upload files and images, monitor runtime status, and control long-running Codex work from a desktop browser or phone.

中文入口: [README.zh-CN.md](README.zh-CN.md)
v2.01 notes archive: [README_v2.01.md](README_v2.01.md)

## Features

- Multi-host control for local PCs, remote Linux machines, and HPC login nodes.
- Session discovery from each host's Codex home, usually `~/.codex`.
- New, resume, fork, stop, interrupt, steer, plan, and review controls.
- Conversation search by keyword, path, or title-like metadata.
- Conversation sorting by created time, recently updated time, or message count.
- File and image upload from the browser to the selected host.
- Remote file cards for opening or saving files generated on the selected host.
- Mobile-friendly drawer navigation and compact runtime status chips.
- HPC connector profiles with SSH key, password, keyboard-interactive, OTP/MFA, gateway, and tmux bootstrap support.
- Per-host API profiles for OpenAI-compatible API keys and base URLs.

## Architecture

```text
phone/browser -> relay web/API server -> host-agent -> Codex app-server
                                      -> local files / HPC workspace
```

- `apps/relay` serves the web UI, stores lightweight runtime state, and relays commands/events.
- `apps/host-agent` runs on each controlled host and owns the Codex app-server process.
- `apps/mobile-web` is the browser UI.
- `shared` contains protocol, connector, discovery, and storage helpers.

The relay is intended for trusted private networks. For phone access outside the same LAN, use a private network such as Tailscale instead of exposing the relay directly to the public internet.

## Requirements

- Node.js 22 or newer is recommended.
- Git.
- Codex CLI installed on each host you want to control.
- OpenSSH on the relay machine if you want to bootstrap remote/HPC hosts.

## Install

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
```

The project currently uses only built-in Node.js modules, so there is usually no install step. If dependencies are added later, run:

```bash
npm install
```

## Start Locally

Start the relay and one local host-agent:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:8787
```

Useful scripts:

```bash
npm run dev
npm run relay
npm run agent
npm run test:managed
```

- `npm run dev` starts relay plus a local host-agent.
- `npm run relay` starts only the relay server.
- `npm run agent` starts only the current machine's host-agent.
- `npm run test:managed` runs a managed-session and file-transfer smoke test.

To use a custom port:

```bash
PORT=8797 npm run relay
```

On Windows PowerShell:

```powershell
$env:PORT=8797
npm run relay
```

## Browser Usage

Common actions:

- `New In Directory` starts Codex in a selected host directory.
- `Resume From History` turns an imported history session into a live managed session.
- `Fork New Branch` starts a new branch from the selected conversation.
- `Stop Session` stops the current live process while preserving history.
- `Interrupt` interrupts the current Codex turn.
- `Plan` sends the next request as a planning turn.
- `Review` starts Codex review for the current workspace.

Composer shortcuts:

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- Type `/` to open the command menu.
- Use `+` or drag-and-drop to attach files.

## Phone Access

If your phone and relay machine are on the same LAN, open the relay machine's LAN IP:

```text
http://192.168.1.20:8787
```

Replace the IP and port with your actual relay address.

## Tailscale Access

Tailscale download:

```text
https://tailscale.com/download
```

Recommended flow:

1. Install Tailscale on the relay machine and phone.
2. Sign both devices into the same tailnet.
3. Start the relay and host-agent on the relay machine.
4. Find the relay machine's Tailscale IP, usually `100.x.y.z`.
5. Open this from the phone:

```text
http://100.x.y.z:8787
```

If you run the relay on another port, replace `8787` with that port.

## Add A Remote Or HPC Host

Open:

```text
Settings -> Hosts and connectors -> Manage HPC
```

Create a connector profile with:

- `Label`: display name such as `dm`, `hkl`, or `lab-gpu`.
- `Relay URL`: the relay URL reachable from the remote host.
- `Target host`: remote login node or server address.
- `Target port`: SSH port.
- `Login username`: SSH username.
- `CODEX_HOME`: usually `~/.codex`.
- `Workspace roots`: browseable root directories, one per line.
- `Remote agent directory`: for example `~/mobile-codex-remote`.
- `tmux session name`: for example `codex-remote`.

Then use:

- `Run Test` to validate SSH login.
- `Start Agent` to deploy and start the remote host-agent.
- `Restart Agent` after updating this repository.
- `Check Status` to inspect the remote tmux/agent state.

If the cluster uses OTP/MFA, the connector flow will prompt for fresh interactive values when SSH asks for them.

## Install Codex CLI On Remote Hosts

For HPC/conda environments:

```bash
conda create -n codex-node -c conda-forge nodejs=20 -y
conda activate codex-node
npm install -g @openai/codex
codex --help
```

For a personal Linux server:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
fnm use 20
npm install -g @openai/codex
codex --help
```

After installing Codex CLI, restart the remote host-agent.

## API Profiles

Open:

```text
Settings -> API profiles
```

You can create multiple OpenAI-compatible API profiles and map different hosts to different profiles. Profile changes apply to newly started, resumed, or forked Codex app-server sessions.

## Development Checks

```bash
node --check apps/relay/server.js
node --check apps/host-agent/agent.js
node --check apps/host-agent/codex-app-server-runner.js
node --check apps/mobile-web/public/app.js
npm run test:managed
```

## Current Limitations

- Runtime state is lightweight and mostly relay-local; host-agents rehydrate live state after reconnecting.
- Imported history sessions become interactive only after resume or fork.
- HPC SSH/MFA policies vary by cluster, so connector profiles may need cluster-specific tuning.
- Large datasets should stay on the host filesystem instead of being uploaded through the browser.
