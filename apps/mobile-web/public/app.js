const state = {
  hosts: [],
  dismissedHosts: [],
  sessions: [],
  stats: null,
  auth: {
    ready: false,
    required: false,
    authenticated: true,
    hasAccount: false,
    setupRequired: false,
    username: '',
    tokenHint: '',
    tokenFile: '',
    accountFile: '',
    accountOpen: false,
    error: '',
    accountError: '',
  },
  selectedHostId: null,
  selectedConversationKey: null,
  selectedSessionId: null,
  eventSource: null,
  eventSourceKey: null,
  transcripts: new Map(),
  alerts: new Map(),
  runtime: new Map(),
  diagnostics: new Map(),
  requests: new Map(),
  receivedFiles: new Map(),
  receivedFilesLoadingKeys: new Set(),
  streamStatus: new Map(),
  thinkingPanels: new Map(),
  alertWindowOpen: false,
  statusWindowOpen: false,
  sessionDetailsOpen: false,
  connectorManagerOpen: false,
  connectors: [],
  connectorEditorId: null,
  connectorActionResults: new Map(),
  connectorActionBusy: null,
  sessionCollections: [],
  selectedCollectionId: 'default',
  collectionManagerOpen: false,
  mobileMenus: {
    hostSwitcher: false,
    collection: false,
    searchMode: false,
    collectionMoveKey: null,
  },
  sessionSearchQuery: '',
  sessionSearchMode: 'keyword',
  overviewCollapsed: false,
  newSessionCollapsed: true,
  navigatorCollapsed: true,
  settingsOpen: false,
  ui: {
    locale: 'zh-CN',
    apiProfiles: [],
    selectedApiProfileId: 'default',
    defaultApiProfileId: 'default',
    hostApiProfiles: {},
  },
  hostSwitchBusyId: null,
  codexControls: {
    modelOptionsBySession: new Map(),
    modelOptionsLoadingKeys: new Set(),
    sessionOptionsByKey: new Map(),
    persistedSessionOptionKeys: new Set(),
    attachments: [],
    modelsLoading: false,
    steerQueue: [],
    queueAutoSendScheduled: false,
    activeDraftsBySession: new Map(),
    steerNotice: null,
  },
  slashMenu: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  directoryPicker: {
    open: false,
    hostId: null,
    currentPath: '',
    parentPath: null,
    roots: [],
    directories: [],
    loading: false,
    error: null,
  },
};

const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMPOSER_TEXT_FILES = 4;
const MAX_COMPOSER_TEXT_FILE_BYTES = 768 * 1024;
const MAX_COMPOSER_UPLOAD_FILES = 8;
const MAX_COMPOSER_UPLOAD_FILE_BYTES = 16 * 1024 * 1024;
const MAX_COMPOSER_UPLOAD_TOTAL_BYTES = 24 * 1024 * 1024;
const NAVIGATOR_COLLAPSED_STORAGE_KEY = 'mobile-codex-remote.navigator-collapsed.v2';
const UI_SETTINGS_STORAGE_KEY = 'mobile-codex-remote.ui-settings.v1';
const COMPOSER_SESSION_OPTIONS_STORAGE_KEY = 'mobile-codex-remote.session-options.v1';
const DEFAULT_COMPOSER_OPTIONS = {
  model: '',
  effort: 'xhigh',
  summary: '',
  mode: 'default',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'auto_review',
  sandboxMode: 'workspaceWrite',
  personality: '',
};
const DEFAULT_UI_SETTINGS = {
  locale: 'zh-CN',
  selectedApiProfileId: 'default',
  defaultApiProfileId: 'default',
  hostApiProfiles: {},
  apiProfiles: [{
    profileId: 'default',
    label: 'OpenAI',
    provider: 'OpenAI',
    baseUrl: '',
    apiKey: '',
    rememberApiKey: false,
  }],
};
const UI_TEXT = {
  en: {
    'common.close': 'Close',
    'common.save': 'Save settings',
    'nav.open': 'Open nav',
    'nav.close': 'Collapse nav',
    'nav.languageToggle': '中文',
    'nav.settings': 'Settings',
    'settings.eyebrow': 'Remote Settings',
    'settings.title': 'Language, API, and Session',
    'settings.subtitle': 'These preferences are stored in this browser only.',
    'settings.languageTitle': 'Interface language',
    'settings.languageCopy': 'Switch the browser UI between Chinese and English.',
    'settings.hostsTitle': 'Hosts and connectors',
    'settings.hostsCopy': 'Manage connected hosts, import a host id, or open HPC connector profiles.',
    'settings.sessionDefaultsTitle': 'Session defaults',
    'settings.sessionDefaultsCopy': 'These controls are remembered per selected session. Switching sessions restores that session\'s model, effort, reviewer, sandbox, and personality choices.',
    'settings.apiTitle': 'API profiles',
    'settings.apiCopy': 'Create multiple API profiles and choose which host uses which key. Changes apply to newly started Codex app-server sessions.',
    'settings.profileSelect': 'Editing profile',
    'settings.addProfile': 'New profile',
    'settings.deleteProfile': 'Delete profile',
    'settings.profileName': 'Profile name',
    'settings.apiProvider': 'Provider label',
    'settings.api-base-url': 'Base URL',
    'settings.api-key': 'API key',
    'settings.defaultProfile': 'Default API profile',
    'settings.hostMappingTitle': 'Host API mapping',
    'settings.hostMappingCopy': 'A host can use the default profile or a dedicated profile.',
    'settings.rememberKey': 'Remember API key in this browser',
    'settings.apiWarning': 'Do not use this on an untrusted relay or shared browser. The key is sent through your relay when starting a session.',
    'settings.clearKey': 'Clear API key',
    'settings.clearKeyConfirm': 'Clear the API key for "{profile}"? This removes it from this browser only. Already running sessions keep their current environment.',
    'settings.deleteProfileConfirm': 'Delete API profile "{profile}"? This cannot be undone.',
    'settings.deleteProfileConfirmWithHosts': 'Delete API profile "{profile}"? It is assigned to: {hosts}. Those hosts will fall back to the default profile. This cannot be undone.',
    'settings.accountTitle': 'Account security',
    'settings.accountCopy': 'Change the relay web login or lock this browser session.',
    'top.status': 'Status',
    'top.account': 'Account',
    'top.lock': 'Lock',
    'top.import': 'Import Host',
    'top.alerts': 'Alerts',
    'session.endConfirm': 'End this live Codex session? The history stays available and can be resumed later.',
    'session.endAlreadyClosed': 'This conversation is already history only.',
  },
  'zh-CN': {
    'common.close': '关闭',
    'common.save': '保存设置',
    'nav.open': '打开导航',
    'nav.close': '收起导航',
    'nav.languageToggle': 'EN',
    'nav.settings': '设置',
    'settings.eyebrow': '远程设置',
    'settings.title': '语言、API 和会话',
    'settings.subtitle': '这些偏好只保存在当前浏览器。',
    'settings.languageTitle': '界面语言',
    'settings.languageCopy': '在中文和英文界面之间切换。',
    'settings.hostsTitle': 'Host 与连接器',
    'settings.hostsCopy': '管理已连接的 host、导入 host id，或打开 HPC 连接器配置。',
    'settings.sessionDefaultsTitle': '会话默认参数',
    'settings.sessionDefaultsCopy': '这些控件按当前选中的 session 单独记忆。切换 session 时，会恢复那个 session 自己的模型、推理强度、审查者、沙盒和个性选择。',
    'settings.apiTitle': 'API 配置',
    'settings.apiCopy': 'Base URL 和 API Key 会作用于新启动的 Codex app-server 会话。已经 live 的会话需要重启才会生效。',
    'settings.apiProvider': '提供方标签',
    'settings.api-base-url': 'Base URL',
    'settings.api-key': 'API Key',
    'settings.profileSelect': '正在编辑',
    'settings.addProfile': '新建配置',
    'settings.deleteProfile': '删除配置',
    'settings.profileName': '配置名称',
    'settings.defaultProfile': '默认 API 配置',
    'settings.hostMappingTitle': 'Host API 映射',
    'settings.hostMappingCopy': '每个 host 可以使用默认配置，也可以指定专用配置。',
    'settings.rememberKey': '在当前浏览器记住 API Key',
    'settings.apiWarning': '不要在不可信 relay 或共享浏览器上使用。启动会话时，这个 key 会经过你的 relay 发送到对应 host。',
    'settings.clearKey': '清除 API Key',
    'settings.clearKeyConfirm': '确定清除“{profile}”的 API Key 吗？这只会从当前浏览器移除。已经运行中的 session 会继续使用当前环境。',
    'settings.deleteProfileConfirm': '确定删除 API 配置“{profile}”吗？这个操作不能撤销。',
    'settings.deleteProfileConfirmWithHosts': '确定删除 API 配置“{profile}”吗？它正在被这些 host 使用：{hosts}。这些 host 会回退到默认配置。这个操作不能撤销。',
    'settings.accountTitle': '账号安全',
    'settings.accountCopy': '修改 relay 网页登录账号，或锁定当前浏览器会话。',
    'top.status': '状态',
    'top.account': '账号',
    'top.lock': '锁定',
    'top.import': '导入 Host',
    'top.alerts': '提醒',
    'session.endConfirm': '结束当前 live Codex 会话？历史仍然保留，之后可以继续 Resume。',
    'session.endAlreadyClosed': '这个对话已经是历史状态。',
  },
};
const ZH_STATIC_TEXT = {
  'Relay Locked': 'Relay 已锁定',
  'Sign in': '登录',
  'This protects your Codex hosts when the relay is reachable from a phone, Tailscale, or another network.': '当 relay 可以从手机、Tailscale 或其他网络访问时，这会保护你的 Codex hosts。',
  'Username': '用户名',
  'Password': '密码',
  'Confirm password': '确认密码',
  'Use recovery token instead': '改用恢复 token',
  'Relay recovery token': 'Relay 恢复 token',
  'Unlock Remote Codex': '解锁 Remote Codex',
  'Relay Account': 'Relay 账号',
  'Change login': '修改登录',
  'Update the browser login account. Host-agents still use the separate machine token.': '更新浏览器登录账号。Host-agent 仍然使用单独的机器 token。',
  'Current password': '当前密码',
  'New password': '新密码',
  'Confirm new password': '确认新密码',
  'Forgot current password? Use recovery token': '忘记当前密码？使用恢复 token',
  'Update Password': '更新密码',
  'Cancel': '取消',
  'Mobile Codex Remote': 'Mobile Codex Remote',
  'Navigator': '导航',
  'Overview': '总览',
  'Hosts': 'Host 列表',
  'Hide': '隐藏',
  'Show': '显示',
  'Import host id, e.g. hpc-login-01': '导入 host id，例如 hpc-login-01',
  'Import Host': '导入 Host',
  'HPC Connectors': 'HPC 连接器',
  'No HPC connector profiles saved yet.': '还没有保存 HPC 连接器配置。',
  'Manage HPC': '管理 HPC',
  'Selected Host': '已选 Host',
  'No host selected': '未选择 Host',
  'Hide New': '隐藏新建',
  'Show New': '显示新建',
  'Active host': '当前 Host',
  'Switch active host': '切换当前 Host',
  'Path on selected host, e.g. /home/me/project or D:\\work\\repo': '所选 host 上的路径，例如 /home/me/project 或 D:\\work\\repo',
  'Browse': '浏览',
  'Optional conversation title': '可选对话标题',
  'New In Directory': '在目录中新建',
  'Use Selected Path': '使用所选路径',
  'New collection name': '新收藏夹名称',
  'Add': '添加',
  'Keyword': '关键词',
  'Path': '路径',
  'Title': '标题',
  'Search mode': '搜索模式',
  'Search conversations...': '搜索对话...',
  'Search': '搜索',
  'Clear': '清除',
  'Conversation': '对话',
  'Status': '状态',
  'End Session': '结束会话',
  'Account': '账号',
  'Lock': '锁定',
  'Alerts': '提醒',
  'Join Running Session': '加入运行会话',
  'Resume From History': '从历史恢复',
  'Fork New Branch': '派生新分支',
  'Session': '会话',
  'Runtime': '运行时',
  'No session selected': '未选择会话',
  'No session': '无会话',
  'Details': '详情',
  'Session Detail': '会话详情',
  'Path, runner, runtime, latest messages, and variants.': '路径、运行器、运行时、最新消息和变体。',
  'Full Status': '完整状态',
  'Close': '关闭',
  'Runner': '运行器',
  'Latest User Message': '最新用户消息',
  'Latest Agent Message': '最新 Codex 消息',
  'Session Variants': '会话变体',
  'Runner Notes': '运行器备注',
  'No warning.': '无警告。',
  'Live Runtime': '实时运行时',
  'Advanced live controls.': '高级实时控制。',
  'Steer Current Turn': '引导当前轮次',
  'Guide the active turn without starting a new one...': '不新开轮次，直接引导当前轮次...',
  'Steer Turn': '引导',
  'Shell Command': 'Shell 命令',
  'Run a host shell command through thread/shellCommand': '通过 thread/shellCommand 在 host 上运行 shell 命令',
  'Run Command': '运行命令',
  'Supported model': '支持的模型',
  'Model: auto/default': '模型：自动/默认',
  'Models': '模型',
  'Reasoning effort': '推理强度',
  'Effort: default': '推理：默认',
  'Effort: model default': '推理：模型默认',
  'Reasoning summary': '推理摘要',
  'Summary: default': '摘要：默认',
  'Auto summary': '自动摘要',
  'Concise': '简洁',
  'Detailed': '详细',
  'No summary': '无摘要',
  'Send mode': '发送模式',
  'Default mode': '默认模式',
  'Plan only': '仅计划',
  'Approval policy': '审批策略',
  'Approval: on request': '审批：按需',
  'On failure': '失败时',
  'Untrusted': '不信任',
  'Never': '永不',
  'Approval reviewer': '审批审查者',
  'Auto review': '自动审查',
  'Reviewer: user': '用户审查',
  'Sandbox mode': '沙盒模式',
  'Workspace write': '工作区可写',
  'Read only': '只读',
  'Danger full access': '危险：完全访问',
  'Personality': '个性',
  'Personality: default': '个性：默认',
  'Friendly': '友好',
  'Pragmatic': '务实',
  'None': '无',
  'Attach Files': '添加文件',
  'Image path on selected host, e.g. ~/shot.png': '所选 host 上的图片路径，例如 ~/shot.png',
  'Clear Files': '清除文件',
  'Active turn updated': '当前轮次已更新',
  'Your message was added to the current Codex turn.': '你的消息已加入当前 Codex 轮次。',
  'Interrupt & Send': '打断并发送',
  'Plan': '计划',
  'Review': '审查',
  'Interrupt': '打断',
  'Send': '发送',
  'Session Alerts': '会话提醒',
  'Minimize': '最小化',
  'No important warnings or errors for this session.': '这个会话没有重要警告或错误。',
  'Codex Status': 'Codex 状态',
  'Status details will appear here.': '状态详情会显示在这里。',
  'Interrupt Turn': '打断当前轮次',
  'End Live Session': '结束 Live 会话',
  'Session Ended': '会话已结束',
  'Ending Session...': '正在结束会话...',
  'Compact Context': '压缩上下文',
  'Refresh': '刷新',
  'Run Shell Command': '运行 Shell 命令',
  'This path is intentionally powerful. `thread/shellCommand` runs unsandboxed on the selected host.': '这个入口刻意很强力：`thread/shellCommand` 会在所选 host 上以非沙盒方式运行。',
  'Open': '打开',
  'Save': '保存',
  'Copy': '复制',
  'No live session attached': '未连接实时会话',
  'Select or start a managed session to see live status, timers, and commands.': '选择或启动 managed session 后查看实时状态、计时和命令。',
  'Select a conversation to inspect path, status, runtime, messages, and variants.': '选择一个对话以查看路径、状态、运行时、消息和变体。',
  'Select a conversation to inspect it.': '选择一个对话以查看详情。',
  'A managed session can continue work from this workspace.': 'Managed session 可以从这个工作区继续。',
  'API profiles': 'API 配置组',
  'Create multiple API profiles and choose which host uses which key. Changes apply to newly started Codex app-server sessions.': '可以创建多个 API 配置，并指定每个 host 使用哪个 key。改动会作用于新启动的 Codex app-server 会话。',
  'Editing profile': '正在编辑',
  'New profile': '新建配置',
  'Delete profile': '删除配置',
  'Profile name': '配置名称',
  'OpenAI main, HPC proxy, lab key...': 'OpenAI 主账号、HPC 代理、实验室 key...',
  'Default API profile': '默认 API 配置',
  'Host API mapping': 'Host API 映射',
  'A host can use the default profile or a dedicated profile.': '每个 host 可以使用默认配置，也可以指定专用配置。',
  'Use default': '使用默认',
  'No hosts are connected yet. Start or import a host to assign API profiles.': '还没有连接 host。先启动或导入 host 后再分配 API 配置。',
  'Thinking': '思考',
  'Token Usage': 'Token 使用',
  'Rate Limits': '速率限制',
  'Requests': '请求',
  'Received Files': '已接收文件',
  'Warnings & Errors': '警告和错误',
  'Event Timeline': '事件时间线',
  'No reasoning summary yet.': '还没有推理摘要。',
  'No token usage reported yet.': '还没有 token 使用报告。',
  'No rate limit snapshot yet.': '还没有速率限制快照。',
  'Codex Needs You': 'Codex 需要你',
  'Approval required': '需要批准',
  'Directory Picker': '目录选择器',
  'Choose a host to browse its directories.': '选择一个 host 来浏览目录。',
  '(no path selected)': '（未选择路径）',
  'Up': '上一级',
  'Use This Directory': '使用此目录',
  'Roots': '根目录',
  'Recent': '最近',
  'Folders': '文件夹',
  'HPC Connector Manager': 'HPC 连接器管理',
  'Saved connector profiles': '已保存连接器配置',
  'Save the route, gateway, and bootstrap recipe. Do not store passwords, OTP codes, or captcha answers.': '保存路由、网关和启动方案。不要保存密码、OTP 或验证码答案。',
  'Best default: run a host agent on the HPC login node, let it dial the relay outward, and use tmux or a user service to keep it alive.': '推荐默认方案：在 HPC 登录节点运行 host-agent，让它主动连回 relay，并用 tmux 或用户服务保活。',
  'Saved Connectors': '已保存连接器',
  'Profiles': '配置',
  'New Connector': '新建连接器',
  'Connector Editor': '连接器编辑器',
  'New connector': '新连接器',
  'Create a saved HPC recipe.': '创建一套保存的 HPC 方案。',
  'Generated Bootstrap': '生成的启动命令',
  'Save a connector to generate its tmux command.': '保存连接器后生成 tmux 命令。',
  'Copy Login': '复制登录',
  'Copy Test': '复制测试',
  'Copy Bootstrap': '复制启动',
  'Run Test': '运行测试',
  'Check Status': '检查状态',
  'Start Agent': '启动 Agent',
  'Restart Agent': '重启 Agent',
  'SSH Login': 'SSH 登录',
  'SSH Smoke Test': 'SSH 连通测试',
  'tmux Bootstrap': 'tmux 启动',
  '(no login command yet)': '（还没有登录命令）',
  '(no smoke test yet)': '（还没有测试命令）',
  '(no command yet)': '（还没有命令）',
  'Basics': '基础',
  'Gateway': '网关',
  'Target Auth': '目标认证',
  'Bootstrap': '启动',
  'Notes': '备注',
  'Label, e.g. Campus HPC': '标签，例如 Campus HPC',
  'Outbound Agent': '出站 Agent',
  'SSH Jump': 'SSH 跳板',
  'Gateway Sidecar': '网关侧 Agent',
  'Reverse Tunnel': '反向隧道',
  'Manual Only': '仅手动',
  'Optional host id, e.g. hpc-login-01': '可选 host id，例如 hpc-login-01',
  'Relay URL, e.g. https://relay.example.com': 'Relay URL，例如 https://relay.example.com',
  'Target host, e.g. login.cluster.edu': '目标 host，例如 login.cluster.edu',
  'Login username': '登录用户名',
  'CODEX_HOME, e.g. ~/.codex': 'CODEX_HOME，例如 ~/.codex',
  'Workspace roots, one per line': '工作区根目录，每行一个',
  'Gateway Disabled': '禁用网关',
  'Gateway Enabled': '启用网关',
  'Gateway host': '网关 host',
  'Gateway username': '网关用户名',
  'ProxyJump / jump rule': 'ProxyJump / 跳转规则',
  'Gateway SSH Key': '网关 SSH Key',
  'Gateway SSH Agent': '网关 SSH Agent',
  'Gateway Password': '网关密码',
  'Gateway Keyboard-Interactive': '网关键盘交互',
  'Gateway OTP / MFA': '网关 OTP / MFA',
  'Gateway Browser SSO': '网关浏览器 SSO',
  'Gateway Captcha': '网关验证码',
  'Gateway password, saved locally only': '网关密码，仅本地保存',
  'Gateway OTP source, authenticator, or notes': '网关 OTP 来源、验证器或备注',
  'SSH Key': 'SSH Key',
  'SSH Agent': 'SSH Agent',
  'Password': '密码',
  'Keyboard-Interactive': '键盘交互',
  'OTP / MFA': 'OTP / MFA',
  'Browser SSO': '浏览器 SSO',
  'Manual Captcha': '手动验证码',
  'SSH key path, if any': 'SSH key 路径（如有）',
  'Target password, saved locally only': '目标密码，仅本地保存',
  'Agent Forwarding On': '开启 Agent 转发',
  'Agent Forwarding Off': '关闭 Agent 转发',
  'Do Not Remember Device': '不记住设备',
  'Remember Device': '记住设备',
  'OTP source, authenticator, or notes': 'OTP 来源、验证器或备注',
  'Manual + tmux': '手动 + tmux',
  'Manual + systemd': '手动 + systemd',
  'SSH Exec': 'SSH 执行',
  'Gateway Launcher': '网关启动器',
  'Remote agent directory': '远端 agent 目录',
  'tmux session name': 'tmux 会话名',
  'systemd service name': 'systemd 服务名',
  'Optional custom launch command': '可选自定义启动命令',
  'Notes, warnings, or campus-specific steps': '备注、警告或学校/集群特殊步骤',
  'Save Connector': '保存连接器',
  'Delete Connector': '删除连接器',
};
const EN_STATIC_TEXT = Object.fromEntries(Object.entries(ZH_STATIC_TEXT).map(([english, chinese]) => [chinese, english]));
const TEXT_FILE_EXTENSIONS = new Set([
  'bat',
  'cmd',
  'css',
  'csv',
  'html',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'markdown',
  'ps1',
  'py',
  'sh',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
const IMAGE_FILE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const DOWNLOADABLE_FILE_EXTENSIONS = new Set([
  ...IMAGE_FILE_EXTENSIONS,
  'c',
  'cpp',
  'cs',
  'css',
  'csv',
  'doc',
  'docx',
  'go',
  'ipynb',
  'java',
  'js',
  'jsx',
  'h',
  'hpp',
  'mjs',
  'ps1',
  'py',
  'r',
  'rs',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'gz',
  'h5',
  'hdf5',
  'html',
  'json',
  'jsonl',
  'log',
  'md',
  'mov',
  'mp4',
  'npy',
  'npz',
  'parquet',
  'pdf',
  'pkl',
  'tar',
  'tgz',
  'txt',
  'webm',
  'xlsx',
  'xml',
  'xz',
  'yaml',
  'yml',
  'zip',
]);

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function readLocalStorageJson(key, fallback) {
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeLocalStorageJson(key, value) {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Local storage may be unavailable in private or restricted browsers.
  }
}

function makeApiProfileId() {
  return `api-${makeClientId()}`;
}

function normalizeApiProfile(input = {}, index = 0) {
  const fallback = DEFAULT_UI_SETTINGS.apiProfiles[0];
  const profileId = String(input.profileId || input.id || (index === 0 ? fallback.profileId : makeApiProfileId())).trim() || makeApiProfileId();
  const label = String(input.label || input.name || input.provider || (index === 0 ? fallback.label : `API Profile ${index + 1}`)).trim();
  return {
    profileId,
    label: label || `API Profile ${index + 1}`,
    provider: String(input.provider || fallback.provider).trim() || fallback.provider,
    baseUrl: String(input.baseUrl || '').trim(),
    apiKey: String(input.apiKey || ''),
    rememberApiKey: input.rememberApiKey === true,
  };
}

function normalizeApiProfiles(input = {}) {
  const rawProfiles = Array.isArray(input.apiProfiles) && input.apiProfiles.length
    ? input.apiProfiles
    : input.apiSettings
      ? [{
        profileId: 'default',
        label: input.apiSettings.provider || input.apiSettings.label || 'OpenAI',
        ...input.apiSettings,
      }]
      : DEFAULT_UI_SETTINGS.apiProfiles;
  const seen = new Set();
  const profiles = [];
  rawProfiles.forEach((profile, index) => {
    const normalized = normalizeApiProfile(profile, index);
    if (seen.has(normalized.profileId)) {
      normalized.profileId = makeApiProfileId();
    }
    seen.add(normalized.profileId);
    profiles.push(normalized);
  });
  return profiles.length ? profiles : DEFAULT_UI_SETTINGS.apiProfiles.map(normalizeApiProfile);
}

function normalizeHostApiProfiles(value = {}, profiles = []) {
  const profileIds = new Set(profiles.map((profile) => profile.profileId));
  const next = {};
  if (!value || typeof value !== 'object') {
    return next;
  }
  for (const [hostId, profileId] of Object.entries(value)) {
    if (profileIds.has(profileId)) {
      next[hostId] = profileId;
    }
  }
  return next;
}

function normalizeUiSettings(input = {}) {
  const locale = input.locale === 'en' ? 'en' : 'zh-CN';
  const apiProfiles = normalizeApiProfiles(input);
  const profileIds = new Set(apiProfiles.map((profile) => profile.profileId));
  const fallbackProfileId = apiProfiles[0]?.profileId || 'default';
  const defaultApiProfileId = profileIds.has(input.defaultApiProfileId) ? input.defaultApiProfileId : fallbackProfileId;
  const selectedApiProfileId = profileIds.has(input.selectedApiProfileId) ? input.selectedApiProfileId : defaultApiProfileId;
  return {
    locale,
    apiProfiles,
    selectedApiProfileId,
    defaultApiProfileId,
    hostApiProfiles: normalizeHostApiProfiles(input.hostApiProfiles, apiProfiles),
  };
}

function initializePersistentUiState() {
  state.navigatorCollapsed = readLocalStorageJson(NAVIGATOR_COLLAPSED_STORAGE_KEY, true) !== false;
  const storedUi = normalizeUiSettings(readLocalStorageJson(UI_SETTINGS_STORAGE_KEY, DEFAULT_UI_SETTINGS));
  state.ui.locale = storedUi.locale;
  state.ui.apiProfiles = storedUi.apiProfiles;
  state.ui.selectedApiProfileId = storedUi.selectedApiProfileId;
  state.ui.defaultApiProfileId = storedUi.defaultApiProfileId;
  state.ui.hostApiProfiles = storedUi.hostApiProfiles;
  const storedOptions = readLocalStorageJson(COMPOSER_SESSION_OPTIONS_STORAGE_KEY, {});
  if (storedOptions && typeof storedOptions === 'object') {
    for (const [key, value] of Object.entries(storedOptions)) {
      state.codexControls.sessionOptionsByKey.set(key, normalizeComposerOptionValues(value));
      state.codexControls.persistedSessionOptionKeys.add(key);
    }
  }
}

function persistUiSettings() {
  const normalized = normalizeUiSettings(state.ui);
  const apiProfiles = normalized.apiProfiles.map((profile) => ({
    ...profile,
    apiKey: profile.rememberApiKey ? profile.apiKey : '',
  }));
  writeLocalStorageJson(UI_SETTINGS_STORAGE_KEY, {
    locale: normalized.locale,
    apiProfiles,
    selectedApiProfileId: normalized.selectedApiProfileId,
    defaultApiProfileId: normalized.defaultApiProfileId,
    hostApiProfiles: normalized.hostApiProfiles,
  });
}

function currentLocale() {
  return state.ui.locale === 'en' ? 'en' : 'zh-CN';
}

function t(key) {
  return UI_TEXT[currentLocale()]?.[key] || UI_TEXT.en[key] || key;
}

function formatUiText(key, values = {}) {
  return t(key).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}

function translateStaticText(value) {
  const text = String(value || '');
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const dictionary = currentLocale() === 'zh-CN' ? ZH_STATIC_TEXT : EN_STATIC_TEXT;
  const translated = dictionary[trimmed];
  return translated ? text.replace(trimmed, translated) : text;
}

function shouldSkipLocalizationNode(node) {
  const parent = node?.parentElement || node;
  if (!parent || !(parent instanceof Element)) {
    return false;
  }
  return Boolean(parent.closest('#session-log, .markdown-body, pre, code, script, style'));
}

function applyStaticLocalization(root = document.body) {
  if (!root) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || shouldSkipLocalizationNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  for (const node of textNodes) {
    node.nodeValue = translateStaticText(node.nodeValue);
  }

  for (const element of root.querySelectorAll('[placeholder], [aria-label], [title]')) {
    if (shouldSkipLocalizationNode(element)) {
      continue;
    }
    for (const attribute of ['placeholder', 'aria-label', 'title']) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(attribute, translateStaticText(element.getAttribute(attribute)));
      }
    }
  }
}

function getApiProfiles() {
  const normalized = normalizeUiSettings(state.ui);
  state.ui.apiProfiles = normalized.apiProfiles;
  state.ui.selectedApiProfileId = normalized.selectedApiProfileId;
  state.ui.defaultApiProfileId = normalized.defaultApiProfileId;
  state.ui.hostApiProfiles = normalized.hostApiProfiles;
  return state.ui.apiProfiles;
}

function getApiProfile(profileId) {
  return getApiProfiles().find((profile) => profile.profileId === profileId) || getApiProfiles()[0] || null;
}

function getSelectedApiProfile() {
  return getApiProfile(state.ui.selectedApiProfileId);
}

function getApiProfileForHost(hostId) {
  const hostProfileId = hostId ? state.ui.hostApiProfiles?.[hostId] : '';
  return getApiProfile(hostProfileId || state.ui.defaultApiProfileId);
}

function getApiRequestConfig(hostId = state.selectedHostId) {
  const api = getApiProfileForHost(hostId);
  if (!api) {
    return null;
  }
  const config = {
    provider: api.provider,
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    profileId: api.profileId,
    label: api.label,
  };
  return config.baseUrl || config.apiKey ? config : null;
}

function getSessionApiProfileSummary(session) {
  if (!session) {
    return {
      label: 'API: none',
      title: 'No API profile recorded for this session.',
      source: 'none',
    };
  }

  const recorded = session.apiProfile || session.runtime?.apiProfile || null;
  if (recorded?.label || recorded?.profileId || recorded?.provider || recorded?.baseUrl) {
    const label = recorded.label || recorded.profileId || recorded.provider || 'API profile';
    const details = [
      recorded.provider ? `Provider: ${recorded.provider}` : '',
      recorded.baseUrl ? `Base URL: ${recorded.baseUrl}` : '',
      recorded.profileId ? `Profile ID: ${recorded.profileId}` : '',
    ].filter(Boolean).join('\n');
    return {
      label: `API: ${label}`,
      title: details || 'API profile recorded when this session started.',
      source: 'recorded',
    };
  }

  const mapped = getApiProfileForHost(session.hostId);
  if (mapped) {
    return {
      label: `API: ${mapped.label || mapped.provider || 'Default'}`,
      title: 'No profile was recorded on this session yet; showing the current host/default mapping.',
      source: 'mapped',
    };
  }

  return {
    label: 'API: default',
    title: 'No API profile is configured; Codex will use the host environment.',
    source: 'default',
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    error.url = url;
    if (response.status === 401 && body?.authRequired && !options.skipAuthHandling) {
      requireRelayLogin(error.message);
    }
    throw error;
  }
  return body;
}

function authAllowsRequests() {
  return !state.auth.required || state.auth.authenticated;
}

function renderAuthGate() {
  const gate = el('auth-gate');
  if (!gate) {
    return;
  }
  const locked = state.auth.required && !state.auth.authenticated;
  gate.classList.toggle('hidden', !locked);
  gate.setAttribute('aria-hidden', locked ? 'false' : 'true');

  const title = el('auth-title');
  if (title) {
    title.textContent = state.auth.setupRequired ? 'Set admin account' : 'Sign in';
  }

  const subtitle = el('auth-subtitle');
  if (subtitle) {
    subtitle.textContent = state.auth.setupRequired
      ? 'Create the browser login. The password is stored as a local scrypt hash, not plaintext.'
      : 'Use your relay account. The recovery token is still available for emergency access.';
  }

  const usernameInput = el('auth-username-input');
  if (usernameInput && document.activeElement !== usernameInput && !usernameInput.value) {
    usernameInput.value = state.auth.username || 'admin';
  }

  el('auth-password-confirm-input')?.classList.toggle('hidden', !state.auth.setupRequired);
  el('auth-recovery-details')?.classList.toggle('hidden', state.auth.setupRequired);

  const hint = el('auth-token-hint');
  if (hint) {
    if (!state.auth.required) {
      hint.textContent = 'Relay auth is disabled.';
    } else if (state.auth.setupRequired) {
      hint.textContent = `Account file: ${state.auth.accountFile || 'tmp/relay-auth-account.json'}. Recovery token: ${state.auth.tokenHint || '(new token)'}.`;
    } else {
      hint.textContent = `Signed account: ${state.auth.username || 'admin'}. Recovery token file: ${state.auth.tokenFile || 'tmp/relay-auth-token.txt'}.`;
    }
  }

  const error = el('auth-error');
  if (error) {
    error.textContent = state.auth.error || '';
  }

  const accountButton = el('account-button');
  if (accountButton) {
    accountButton.hidden = !state.auth.required || !state.auth.authenticated || !state.auth.hasAccount;
  }

  const logoutButton = el('logout-button');
  if (logoutButton) {
    logoutButton.hidden = !state.auth.required || !state.auth.authenticated;
  }

  const accountSection = el('account-settings-section');
  if (accountSection) {
    accountSection.classList.toggle('hidden', !state.auth.required);
  }

  renderAccountDialog();
}

function renderAccountDialog() {
  const dialog = el('account-dialog');
  if (!dialog) {
    return;
  }
  const open = state.auth.accountOpen;
  dialog.classList.toggle('hidden', !open);
  dialog.setAttribute('aria-hidden', open ? 'false' : 'true');
  const usernameInput = el('account-username-input');
  if (usernameInput && open && document.activeElement !== usernameInput && !usernameInput.value) {
    usernameInput.value = state.auth.username || 'admin';
  }
  const error = el('account-error');
  if (error) {
    error.textContent = state.auth.accountError || '';
  }
}

function requireRelayLogin(message = '') {
  state.auth.required = true;
  state.auth.authenticated = false;
  state.auth.error = message || 'Relay login is required.';
  closeStream();
  renderAuthGate();
}

function applyAuthConfig(config = {}) {
  state.auth.ready = true;
  state.auth.required = Boolean(config.authRequired);
  state.auth.authenticated = !state.auth.required || Boolean(config.authenticated);
  state.auth.hasAccount = Boolean(config.hasAccount);
  state.auth.setupRequired = Boolean(config.setupRequired);
  state.auth.username = config.username || state.auth.username || '';
  state.auth.tokenHint = config.tokenHint || '';
  state.auth.tokenFile = config.tokenFile || 'tmp/relay-auth-token.txt';
  state.auth.accountFile = config.accountFile || 'tmp/relay-auth-account.json';
}

async function refreshAuthState() {
  const config = await fetchJson('/api/auth/config', { skipAuthHandling: true });
  applyAuthConfig(config);
  if (state.auth.authenticated) {
    state.auth.error = '';
  }
  renderAuthGate();
  return state.auth.authenticated;
}

async function setupRelayAccount(username, password, confirmPassword) {
  const response = await fetchJson('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password, confirmPassword }),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.error = '';
  renderAuthGate();
  await refresh();
}

async function loginRelay(credentials) {
  const response = await fetchJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.error = '';
  renderAuthGate();
  await refresh();
}

async function changeRelayPassword(payload) {
  const response = await fetchJson('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(payload),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.accountOpen = false;
  state.auth.accountError = '';
  renderAuthGate();
}

async function logoutRelay() {
  await fetchJson('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({}),
    skipAuthHandling: true,
  }).catch(() => null);
  state.auth.required = true;
  state.auth.authenticated = false;
  state.auth.accountOpen = false;
  state.auth.error = 'Logged out.';
  closeStream();
  renderAuthGate();
}

function makeSessionKey(hostId, sessionId) {
  return `${hostId}::${sessionId}`;
}

function getSessionKey(session) {
  return session ? makeSessionKey(session.hostId, session.sessionId) : null;
}

function parseSessionTime(session) {
  const value = Date.parse(session?.lastUpdatedAt || session?.updatedAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function compareSessions(a, b) {
  if (a.live !== b.live) {
    return a.live ? -1 : 1;
  }
  const delta = parseSessionTime(b) - parseSessionTime(a);
  if (delta !== 0) {
    return delta;
  }
  return String(a.title || a.sessionId).localeCompare(String(b.title || b.sessionId));
}

function truncatePreview(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function basename(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function formatElapsedSince(value, now = Date.now()) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return formatDuration(now - timestamp);
}

function prettyStatusLabel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const map = {
    idle: 'Idle',
    active: 'Thinking',
    thinking: 'Thinking',
    planning: 'Planning',
    reviewing: 'Reviewing',
    reconnecting: 'Reconnecting',
    retrying: 'Retrying',
    interrupted: 'Interrupted',
    error: 'Error',
    closed: 'Closed',
    booting: 'Booting',
    'waiting-approval': 'Waiting Approval',
    'waiting-user-input': 'Waiting Input',
    'running-shell-command': 'Running Shell Command',
    compacting: 'Compacting',
    'quota-exhausted': 'Quota Exhausted',
  };

  if (map[text]) {
    return map[text];
  }

  return text
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function connectorKindLabel(value) {
  return {
    outbound_agent: 'Outbound Agent',
    ssh_jump: 'SSH Jump',
    gateway_agent: 'Gateway Sidecar',
    reverse_tunnel: 'Reverse Tunnel',
    manual_only: 'Manual Only',
  }[value] || 'Connector';
}

function authMethodLabel(value) {
  return {
    ssh_key: 'SSH Key',
    ssh_agent: 'SSH Agent',
    password: 'Password',
    keyboard_interactive: 'Keyboard-Interactive',
    otp: 'OTP / MFA',
    browser_sso: 'Browser SSO',
    manual_captcha: 'Manual Captcha',
  }[value] || 'Auth';
}

function bootstrapModeLabel(value) {
  return {
    manual_tmux: 'Manual + tmux',
    manual_systemd: 'Manual + systemd',
    ssh_exec: 'SSH Exec',
    gateway_launcher: 'Gateway Launcher',
    manual_only: 'Manual Only',
  }[value] || 'Bootstrap';
}

function describeRuntimeStatus(runtime, stream, session) {
  const connection = stream?.connection || runtime?.connection || (session?.live ? 'connecting' : 'history only');
  const phase = prettyStatusLabel(runtime?.phase || session?.state || 'unknown');
  const turn = runtime?.currentTurnStatus ? prettyStatusLabel(runtime.currentTurnStatus) : (runtime?.activeTurnId ? 'Active' : 'Idle');
  const busy = runtime?.busy ? 'Busy' : 'Idle';
  return {
    connection,
    phase,
    turn,
    busy,
  };
}

function getRuntimeElapsedAnchor(runtime) {
  return runtime?.busy && runtime?.busyStartedAt
    ? runtime.busyStartedAt
    : runtime?.phaseStartedAt || runtime?.updatedAt || null;
}

function getStreamElapsedAnchor(stream) {
  return stream?.connectionChangedAt || stream?.lastPingAt || null;
}

function limitText(value, max = 220) {
  const text = String(value || '');
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function summarizeData(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  if (typeof value === 'string') {
    return limitText(value, 220);
  }
  try {
    return limitText(JSON.stringify(value), 320);
  } catch (_) {
    return limitText(String(value), 220);
  }
}

function formatThinkingValue(value, depth = 0) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatThinkingValue(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object') {
    if (typeof value.step === 'string' && value.step.trim()) {
      const status = typeof value.status === 'string' && value.status.trim()
        ? `[${value.status.trim()}] `
        : '';
      const extra = typeof value.summary === 'string' && value.summary.trim() && value.summary.trim() !== value.step.trim()
        ? ` - ${value.summary.trim()}`
        : '';
      return `${status}${value.step.trim()}${extra}`.trim();
    }

    for (const key of ['text', 'content', 'summary', 'description', 'title', 'label']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }

    if (depth > 1) {
      return summarizeData(value);
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const normalized = formatThinkingValue(item, depth + 1);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return String(value).trim();
}

function normalizeThinkingMessage(entry) {
  if (!entry) {
    return '';
  }

  const candidates = [
    entry.message,
    entry.detail,
    entry.data?.text,
    entry.data?.content,
    entry.data?.summary,
    entry.data?.plan,
    entry.data?.delta,
    entry.data?.rawPlan,
  ];

  for (const candidate of candidates) {
    const text = formatThinkingValue(candidate);
    if (text) {
      return text;
    }
  }

  return '';
}

function getLatestFormalAgentMessage(session) {
  if (!session) {
    return 'No recent agent reply captured.';
  }

  const transcript = getTranscriptForSession(session)
    .filter((entry) => entry && (entry.speaker === 'agent' || entry.speaker === 'assistant') && entry.text);
  const latest = transcript[transcript.length - 1];
  const fallback = String(session.latestAgentMessage || '').trim();
  if (fallback && fallback !== '[object Object]' && !/^\s*[\[{]/.test(fallback)) {
    return latest?.text || fallback;
  }
  return latest?.text || 'No recent agent reply captured.';
}

function buildThinkingEntriesForSession(session) {
  if (!session) {
    return [];
  }

  const transcript = getTranscriptForSession(session)
    .filter((entry) => entry && (entry.speaker === 'user' || entry.speaker === 'agent' || entry.speaker === 'assistant'));
  const diagnostics = getDiagnosticsForSession(session)
    .filter((entry) => entry && (
      entry.kind === 'reasoning'
      || entry.kind === 'plan'
      || isFileChangeDiagnostic(entry)
    ));
  const requestDiagnostics = getRequestsForSession(session)
    .filter((request) => request && isFileChangeDiagnostic(request))
    .map((request) => ({
      timestamp: request.createdAt || request.updatedAt || new Date().toISOString(),
      severity: request.status === 'pending' ? 'warning' : 'info',
      source: 'codex',
      kind: 'file-change',
      method: request.method || 'item/fileChange/requestApproval',
      message: request.summary || request.message || 'File change approval requested',
      data: request.payload || null,
      turnId: request.payload?.turnId || null,
    }));
  const thinkingDiagnostics = [...diagnostics, ...requestDiagnostics];

  const transcriptTimes = transcript.map((entry) => Date.parse(entry.timestamp || '')).map((value) => (Number.isFinite(value) ? value : null));
  const segments = [];

  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (entry.speaker !== 'user') {
      continue;
    }

    const startTime = transcriptTimes[index];
    if (!Number.isFinite(startTime)) {
      continue;
    }

    let replyTime = Infinity;
    for (let nextIndex = index + 1; nextIndex < transcript.length; nextIndex += 1) {
      const nextEntry = transcript[nextIndex];
      if (nextEntry.speaker === 'agent' || nextEntry.speaker === 'assistant') {
        const nextTime = transcriptTimes[nextIndex];
        if (Number.isFinite(nextTime)) {
          replyTime = nextTime;
        }
        break;
      }
      if (nextEntry.speaker === 'user') {
        const nextTime = transcriptTimes[nextIndex];
        if (Number.isFinite(nextTime)) {
          replyTime = nextTime;
        }
        break;
      }
    }

    const windowEntries = thinkingDiagnostics
      .filter((diag) => {
        const diagTime = Date.parse(diag.timestamp || '');
        return Number.isFinite(diagTime) && diagTime >= startTime && diagTime <= replyTime;
      })
      .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));

    const merged = [];
    for (const diag of windowEntries) {
      const text = normalizeThinkingMessage(diag);
      const fileChanges = normalizeFileChanges(diag);
      if (!text && !fileChanges.length) {
        continue;
      }
      const normalizedKind = isFileChangeDiagnostic(diag) ? 'file-change' : (diag.kind || 'thinking');
      const previous = merged[merged.length - 1];
      if (previous && previous.kind === normalizedKind && previous.text === text && !fileChanges.length) {
        continue;
      }
      merged.push({
        kind: normalizedKind,
        method: diag.method || null,
        text: text || 'File changes updated',
        timestamp: diag.timestamp || null,
        fileChanges,
      });
    }

    if (merged.length) {
      segments.push({
        userTimestamp: entry.timestamp || null,
        userText: entry.text || '',
        entries: merged,
      });
    }
  }

  return segments;
}

function isFileChangeDiagnostic(entry) {
  const method = String(entry?.method || '').toLowerCase();
  const kind = String(entry?.kind || '').toLowerCase();
  const message = String(entry?.message || '').toLowerCase();
  return kind === 'file-change'
    || kind === 'filechange'
    || method.includes('filechange')
    || method.includes('file_change')
    || method.includes('patch')
    || method.includes('diff')
    || /\b(file|files)\b.*\b(change|changed|edit|edited|patch|diff)\b/.test(message);
}

function countDiffLines(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pathFromDiffHeader(diffText) {
  const text = String(diffText || '');
  const gitMatch = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (gitMatch) {
    return gitMatch[2] || gitMatch[1];
  }
  const plusMatch = text.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  if (plusMatch && plusMatch[1] !== '/dev/null') {
    return plusMatch[1];
  }
  const minusMatch = text.match(/^---\s+(?:a\/)?(.+)$/m);
  if (minusMatch && minusMatch[1] !== '/dev/null') {
    return minusMatch[1];
  }
  return '';
}

function splitUnifiedDiff(diffText) {
  const text = String(diffText || '').trim();
  if (!text) {
    return [];
  }
  const chunks = text.split(/\n(?=diff --git\s+)/);
  return chunks.filter(Boolean).map((chunk) => {
    const counts = countDiffLines(chunk);
    return {
      path: pathFromDiffHeader(chunk) || 'workspace change',
      additions: counts.additions,
      deletions: counts.deletions,
      diff: chunk,
    };
  });
}

function normalizeFileChangeRecord(raw, fallbackPath = '') {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const diff = String(raw.diff || raw.patch || raw.unifiedDiff || raw.unified_diff || raw.content || raw.text || '').trim();
  const counts = countDiffLines(diff);
  const pathValue = String(
    raw.path
      || raw.filePath
      || raw.file_path
      || raw.absolutePath
      || raw.relativePath
      || raw.filename
      || raw.name
      || fallbackPath
      || pathFromDiffHeader(diff)
      || ''
  ).trim();
  const additions = toCount(raw.additions ?? raw.added ?? raw.insertions ?? raw.linesAdded ?? raw.addedLines) ?? counts.additions;
  const deletions = toCount(raw.deletions ?? raw.deleted ?? raw.removed ?? raw.linesDeleted ?? raw.deletedLines) ?? counts.deletions;
  if (!pathValue && !diff && !additions && !deletions) {
    return null;
  }
  return {
    path: pathValue || 'workspace change',
    additions,
    deletions,
    diff,
  };
}

function normalizeFileChanges(entry) {
  const roots = [
    entry?.data,
    entry?.payload,
    entry?.data?.payload,
    entry?.data?.changes,
    entry?.data?.files,
    entry?.data?.fileChanges,
    entry?.data?.edits,
    entry?.data?.patches,
  ].filter(Boolean);
  const records = [];
  const seen = new Set();

  function addRecord(record) {
    if (!record) {
      return;
    }
    const key = `${record.path}|${record.additions}|${record.deletions}|${record.diff.slice(0, 80)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    records.push(record);
  }

  function visit(value, fallbackPath = '', depth = 0) {
    if (!value || depth > 5) {
      return;
    }
    if (typeof value === 'string') {
      if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(value)) {
        for (const record of splitUnifiedDiff(value)) {
          addRecord(record);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, fallbackPath, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') {
      return;
    }

    const nextFallback = String(value.path || value.filePath || value.file_path || value.filename || value.name || fallbackPath || '');
    addRecord(normalizeFileChangeRecord(value, nextFallback));
    for (const key of ['changes', 'files', 'fileChanges', 'file_changes', 'edits', 'patches', 'diffs', 'items']) {
      if (value[key]) {
        visit(value[key], nextFallback, depth + 1);
      }
    }
    for (const key of ['diff', 'patch', 'unifiedDiff', 'unified_diff']) {
      if (typeof value[key] === 'string') {
        visit(value[key], nextFallback, depth + 1);
      }
    }
  }

  for (const root of roots) {
    visit(root);
  }
  return records.slice(0, 12);
}

function shortId(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function normalizeTranscriptFiles(rawFiles) {
  const files = [];
  const seen = new Set();
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }
    const pathValue = String(rawFile.path || rawFile.remotePath || '').trim();
    const name = String(rawFile.name || basename(pathValue) || 'file').trim();
    if (!pathValue && !name) {
      continue;
    }
    const key = `${pathValue}|${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const mime = String(rawFile.mime || rawFile.type || '').trim();
    files.push({
      fileId: String(rawFile.fileId || rawFile.id || key),
      name,
      path: pathValue,
      size: Number(rawFile.size || 0) || 0,
      mime,
      isImage: Boolean(rawFile.isImage) || /^image\//i.test(mime) || IMAGE_FILE_EXTENSIONS.has(fileExtension(name || pathValue)),
    });
  }
  return files;
}

function dedupeTranscript(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    const files = normalizeTranscriptFiles(entry?.files || entry?.attachments || []);
    if (!entry || (!entry.text && !files.length)) {
      continue;
    }

    const normalized = {
      speaker: entry.speaker || 'system',
      text: String(entry.text || ''),
      timestamp: entry.timestamp || null,
      stream: entry.stream || null,
      files,
    };
    const key = `${normalized.speaker}|${normalized.timestamp || ''}|${normalized.text}|${files.map((file) => file.path || file.name).join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-200);
}

function getRunnerSummary(session) {
  if (!session) {
    return {
      label: 'Unknown',
      warning: null,
    };
  }

  if (session.source !== 'managed') {
    return {
      label: 'Imported History',
      warning: 'This session is imported from .codex history only. It does not have a live process until you resume or fork it.',
    };
  }

  const runtimeCommand = String(session.runtime?.command || '');
  const runtimeArgs = Array.isArray(session.runtime?.args) ? session.runtime.args : [];
  const runtimeKind = String(session.runtime?.kind || '');
  const joined = [runtimeCommand, ...runtimeArgs].join(' ').toLowerCase();

  if (joined.includes('demo-session.js') || runtimeCommand.toLowerCase().includes('demo')) {
    return {
      label: 'Demo Runner',
      warning: 'This managed session is still using the local demo runner. Transport works, but agent text and action buttons are simulated rather than coming from a real Codex model.',
    };
  }

  if (runtimeKind === 'codex_app_server' || (joined.includes('codex') && joined.includes('app-server'))) {
    const strategy = session.runtime?.resumeStrategy;
    const warning = strategy === 'transcript_fallback'
      ? 'This live session had to fall back to history transcript bootstrapping because the original native Codex thread was not available.'
      : null;
    return {
      label: 'Codex App Server',
      warning,
    };
  }

  if (joined.includes('codex') && joined.includes('remote-control')) {
    return {
      label: 'Codex Remote Control',
      warning: 'This session is backed by Codex remote-control. Structured runtime events should be available, but this integration may still be incomplete.',
    };
  }

  return {
    label: runtimeCommand ? basename(runtimeCommand) : 'Managed Runner',
    warning: runtimeCommand
      ? `This session is managed by ${basename(runtimeCommand)}. Structured Codex events depend on the runner integration.`
      : 'This managed session does not expose a runtime command yet.',
  };
}

function getHost(hostId) {
  return state.hosts.find((host) => host.hostId === hostId) || null;
}

async function verifyHostAvailable(hostId) {
  const host = getHost(hostId);
  if (!host) {
    throw new Error(`Host ${hostId || '(unknown)'} is not registered.`);
  }
  if (!host.online) {
    throw new Error(`Host ${host.label || host.hostId} is offline. Start its agent or restart the HPC connector first.`);
  }

  const result = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/probe`, {
    method: 'POST',
  });
  if (!result?.ok) {
    throw new Error(result?.error || `Host ${host.label || host.hostId} did not answer the health check.`);
  }
  return result;
}

function getSessionsForHost(hostId) {
  return state.sessions.filter((session) => session.hostId === hostId);
}

function getRecentDirectories(hostId, limit = 8) {
  const seen = new Set();
  const recent = [];

  for (const session of getSessionsForHost(hostId).sort(compareSessions)) {
    const cwd = String(session.cwd || '').trim();
    if (!cwd || seen.has(cwd)) {
      continue;
    }

    seen.add(cwd);
    recent.push({
      path: cwd,
      title: session.title || pathLeaf(cwd) || cwd,
      live: Boolean(session.live),
      updatedAt: session.lastUpdatedAt || session.updatedAt || null,
    });

    if (recent.length >= limit) {
      break;
    }
  }

  return recent;
}

function getConversationGroups(hostId) {
  const groups = new Map();

  for (const session of getSessionsForHost(hostId)) {
    const conversationKey = session.conversationKey || session.originSessionId || session.sessionId;
    const group = groups.get(conversationKey) || {
      hostId,
      conversationKey,
      sessions: [],
    };

    group.sessions.push({
      ...session,
      conversationKey,
    });
    groups.set(conversationKey, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      group.sessions.sort(compareSessions);
      group.totalCount = group.sessions.length;
      group.liveCount = group.sessions.filter((session) => session.live).length;
      group.preferredSession = group.sessions.find((session) => session.live) || group.sessions[0] || null;
      group.cwd = group.preferredSession?.cwd || group.sessions.find((session) => session.cwd)?.cwd || null;
      group.title = group.preferredSession?.title || group.sessions[0]?.title || group.conversationKey;
      group.lastUpdatedAt = group.sessions[0]?.lastUpdatedAt || null;
      group.latestUserMessage = firstNonEmpty(group.sessions.map((session) => session.latestUserMessage));
      group.latestAgentMessage = firstNonEmpty(group.sessions.map((session) => session.latestAgentMessage));
      group.apiProfile = group.preferredSession?.apiProfile || group.sessions.find((session) => session.apiProfile)?.apiProfile || null;
      return group;
    })
    .sort((a, b) => {
      const delta = parseSessionTime({ lastUpdatedAt: b.lastUpdatedAt }) - parseSessionTime({ lastUpdatedAt: a.lastUpdatedAt });
      if (delta !== 0) {
        return delta;
      }
      return String(a.title || a.conversationKey).localeCompare(String(b.title || b.conversationKey));
    });
}

function getAllConversationGroups() {
  return state.hosts.flatMap((host) => getConversationGroups(host.hostId));
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
}

function getConversationSearchText(group) {
  const titleValues = [
    group.title,
    ...(group.sessions || []).map((session) => session.title),
  ];
  const pathValues = [
    group.cwd,
    ...(group.sessions || []).map((session) => session.cwd),
  ];
  if (state.sessionSearchMode === 'title') {
    return titleValues.filter(Boolean).join(' ').toLowerCase();
  }
  if (state.sessionSearchMode === 'path') {
    return pathValues.filter(Boolean).join(' ').toLowerCase();
  }

  return [
    ...titleValues,
    ...pathValues,
    group.conversationKey,
    group.latestUserMessage,
    group.latestAgentMessage,
    ...(group.sessions || []).flatMap((session) => [
      session.sessionId,
      session.nativeThreadId,
      session.bridgeSessionId,
      session.latestUserMessage,
      session.latestAgentMessage,
      ...(Array.isArray(session.transcriptPreview) ? session.transcriptPreview.map((entry) => entry.text) : []),
      ...(state.transcripts.get(makeSessionKey(session.hostId, session.sessionId)) || []).map((entry) => entry.text),
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function filterConversationGroups(groups) {
  const query = String(state.sessionSearchQuery || '').trim().toLowerCase();
  if (!query) {
    return groups;
  }

  const terms = query.split(/\s+/).filter(Boolean);
  return groups.filter((group) => {
    const haystack = getConversationSearchText(group);
    return terms.every((term) => haystack.includes(term));
    });
}

function getSelectedCollection() {
  return state.sessionCollections.find((collection) => collection.collectionId === state.selectedCollectionId)
    || state.sessionCollections[0]
    || { collectionId: 'default', name: 'Default', system: true, items: [] };
}

const SESSION_SEARCH_MODE_LABELS = {
  keyword: 'Keyword',
  path: 'Path',
  title: 'Title',
};

function getSessionSearchModeLabel(mode) {
  return SESSION_SEARCH_MODE_LABELS[mode] || SESSION_SEARCH_MODE_LABELS.keyword;
}

function closeMobileSelectMenus() {
  state.mobileMenus.hostSwitcher = false;
  state.mobileMenus.collection = false;
  state.mobileMenus.searchMode = false;
  state.mobileMenus.collectionMoveKey = null;
}

function hasOpenMobileSelectMenu() {
  return Boolean(
    state.mobileMenus.hostSwitcher
    || state.mobileMenus.collection
    || state.mobileMenus.searchMode
    || state.mobileMenus.collectionMoveKey
  );
}

function toggleMobileSelectMenu(name, value = true) {
  const wasOpen = name === 'collectionMoveKey'
    ? state.mobileMenus.collectionMoveKey === value
    : Boolean(state.mobileMenus[name]);
  closeMobileSelectMenus();

  if (!wasOpen) {
    if (name === 'collectionMoveKey') {
      state.mobileMenus.collectionMoveKey = value;
    } else {
      state.mobileMenus[name] = true;
    }
  }

  renderAll();
}

function renderMobileSelectMenu({
  button,
  menu,
  label,
  options,
  selectedValue,
  open,
  disabled = false,
  onSelect,
}) {
  if (!button || !menu) {
    return;
  }

  button.textContent = label || 'Select';
  button.disabled = Boolean(disabled);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  menu.classList.toggle('hidden', !open);
  menu.innerHTML = '';

  const optionList = Array.isArray(options) ? options : [];
  if (!optionList.length) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'mobile-select-option';
    empty.disabled = true;
    empty.textContent = 'No options available';
    menu.appendChild(empty);
    return;
  }

  for (const option of optionList) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `mobile-select-option ${option.value === selectedValue ? 'active' : ''}`.trim();
    item.disabled = Boolean(option.disabled);
    item.textContent = option.label || option.value || 'Option';
    item.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) {
        return;
      }
      closeMobileSelectMenus();
      renderAll();
      try {
        await onSelect?.(option.value, option);
      } catch (error) {
        reportError(error);
      }
    };
    menu.appendChild(item);
  }
}

function getConversationGroupsForCollection(collection = getSelectedCollection()) {
  if (!collection || collection.collectionId === 'default') {
    return state.selectedHostId ? getConversationGroups(state.selectedHostId) : [];
  }

  const allGroups = getAllConversationGroups();
  const groupMap = new Map(allGroups.map((group) => [`${group.hostId}::${group.conversationKey}`, group]));
  return (collection.items || [])
    .map((item) => {
      const key = `${item.hostId}::${item.conversationKey}`;
      const group = groupMap.get(key) || findCollectionConversationGroup(allGroups, item);
      if (group) {
        return {
          ...group,
          collectionItem: item,
        };
      }

      return {
        hostId: item.hostId,
        hostLabel: item.hostLabel,
        conversationKey: item.conversationKey,
        sessions: [],
        totalCount: item.sessionId ? 1 : 0,
        liveCount: 0,
        preferredSession: null,
        cwd: item.cwd || null,
        title: item.title || item.conversationKey,
        lastUpdatedAt: item.updatedAt || item.addedAt || null,
        latestUserMessage: null,
        latestAgentMessage: null,
        collectionOnly: true,
        collectionItem: item,
      };
    })
    .sort((a, b) => {
      const delta = parseSessionTime({ lastUpdatedAt: b.lastUpdatedAt }) - parseSessionTime({ lastUpdatedAt: a.lastUpdatedAt });
      if (delta !== 0) {
        return delta;
      }
      return String(a.title || a.conversationKey).localeCompare(String(b.title || b.conversationKey));
    });
}

function findCollectionConversationGroup(groups, item) {
  if (!item || !item.hostId) {
    return null;
  }

  const candidates = groups.filter((group) => group.hostId === item.hostId);
  const identities = [
    item.conversationKey,
    item.sessionId,
  ].filter(Boolean).map(String);

  if (identities.length) {
    const exact = candidates.find((group) => {
      const values = getConversationIdentityValues(group);
      return identities.some((identity) => values.has(identity));
    });
    if (exact) {
      return exact;
    }
  }

  const itemPath = normalizeConversationPath(item.cwd);
  if (!itemPath) {
    return null;
  }

  const itemTitle = normalizeConversationTitle(item.title);
  return candidates.find((group) => {
    if (normalizeConversationPath(group.cwd) !== itemPath) {
      return false;
    }
    if (!itemTitle) {
      return true;
    }
    const groupTitles = [
      group.title,
      ...(group.sessions || []).map((session) => session.title),
    ].map(normalizeConversationTitle).filter(Boolean);
    return groupTitles.includes(itemTitle);
  }) || candidates.find((group) => normalizeConversationPath(group.cwd) === itemPath) || null;
}

function getConversationIdentityValues(group) {
  const values = new Set();
  const add = (value) => {
    if (value) {
      values.add(String(value));
    }
  };

  add(group.conversationKey);
  for (const session of group.sessions || []) {
    add(session.sessionId);
    add(session.conversationKey);
    add(session.originSessionId);
    add(session.sourceSessionId);
    add(session.bridgeSessionId);
    add(session.nativeThreadId);
  }
  return values;
}

function normalizeConversationPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function normalizeConversationTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function getHostSnapshotForCollection(hostId) {
  const host = getHost(hostId) || {};
  const connector = state.connectors.find((item) => item.hostId === hostId) || null;
  return {
    hostLabel: host.label || hostId,
    hostPlatform: host.platform || '',
    targetHost: connector?.targetHost || '',
    targetPort: connector?.targetPort || null,
    connectorId: connector?.connectorId || '',
    connectorLabel: connector?.label || '',
    relayUrl: connector?.relayUrl || '',
  };
}

function buildCollectionItemFromConversation(group) {
  const session = group.preferredSession || group.sessions?.[0] || null;
  return {
    hostId: group.hostId,
    conversationKey: group.conversationKey,
    sessionId: session?.sessionId || group.collectionItem?.sessionId || '',
    title: group.title || session?.title || group.conversationKey,
    cwd: group.cwd || session?.cwd || '',
    ...getHostSnapshotForCollection(group.hostId),
  };
}

async function refreshSessionCollections() {
  const response = await fetchJson('/api/session-collections');
  state.sessionCollections = response.collections || [];
  if (!state.sessionCollections.some((collection) => collection.collectionId === state.selectedCollectionId)) {
    state.selectedCollectionId = state.sessionCollections[0]?.collectionId || 'default';
  }
}

async function createSessionCollection(name) {
  const response = await fetchJson('/api/session-collections', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await refreshSessionCollections();
  state.selectedCollectionId = response.collection?.collectionId || state.selectedCollectionId;
  renderAll();
}

async function renameSessionCollection(collectionId, name) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  const response = await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  await refreshSessionCollections();
  state.selectedCollectionId = response.collection?.collectionId || state.selectedCollectionId;
  renderAll();
}

async function deleteSessionCollection(collectionId) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}`, {
    method: 'DELETE',
  });
  if (state.selectedCollectionId === collectionId) {
    state.selectedCollectionId = 'default';
  }
  await refreshSessionCollections();
  renderAll();
}

async function addConversationToCollection(collectionId, group) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}/items`, {
    method: 'POST',
    body: JSON.stringify({ item: buildCollectionItemFromConversation(group) }),
  });
  await refreshSessionCollections();
  renderAll();
}

async function removeConversationFromCollection(collectionId, group) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}/items/remove`, {
    method: 'POST',
    body: JSON.stringify({ item: buildCollectionItemFromConversation(group) }),
  });
  await refreshSessionCollections();
  renderAll();
}

function getLiveSessionForConversation(conversation) {
  return conversation?.sessions.find((session) => session.live) || null;
}

function getSelectedConversation() {
  if (!state.selectedHostId || !state.selectedConversationKey) {
    return null;
  }

  return getConversationGroups(state.selectedHostId)
    .find((group) => group.conversationKey === state.selectedConversationKey) || null;
}

function getSelectedSession() {
  const conversation = getSelectedConversation();
  if (!conversation) {
    return null;
  }

  return conversation.sessions.find((session) => session.sessionId === state.selectedSessionId)
    || conversation.preferredSession
    || null;
}

function ensureSelections() {
  if (!state.selectedHostId || !getHost(state.selectedHostId)) {
    const fallbackHost = state.hosts.find((host) => host.online) || state.hosts[0] || null;
    state.selectedHostId = fallbackHost?.hostId || null;
  }

  if (!state.selectedHostId) {
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
    return;
  }

  const groups = getConversationGroups(state.selectedHostId);
  if (!groups.length) {
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
    return;
  }

  let conversation = groups.find((group) => group.conversationKey === state.selectedConversationKey) || null;
  if (!conversation) {
    conversation = groups[0];
    state.selectedConversationKey = conversation.conversationKey;
  }

  const session = conversation.sessions.find((item) => item.sessionId === state.selectedSessionId) || conversation.preferredSession;
  state.selectedSessionId = session?.sessionId || null;
}

function mergeSession(session) {
  if (!session || !session.hostId || !session.sessionId) {
    return null;
  }

  const key = makeSessionKey(session.hostId, session.sessionId);
  const index = state.sessions.findIndex((item) => makeSessionKey(item.hostId, item.sessionId) === key);
  if (index === -1) {
    state.sessions.push(session);
    return session;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...session,
  };
  return state.sessions[index];
}

function setTranscriptForSession(hostId, sessionId, transcript) {
  const key = makeSessionKey(hostId, sessionId);
  state.transcripts.set(key, dedupeTranscript(transcript));
}

function appendTranscriptEntry(hostId, sessionId, entry) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.transcripts.get(key) || [];
  state.transcripts.set(key, dedupeTranscript([...existing, entry]));
}

function dedupeAlerts(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    if (!entry || !entry.message) {
      continue;
    }

    const normalized = {
      timestamp: entry.timestamp || null,
      severity: entry.severity || 'warning',
      source: entry.source || 'runtime',
      message: String(entry.message || ''),
      sessionId: entry.sessionId || null,
      hostId: entry.hostId || null,
    };
    const key = `${normalized.severity}|${normalized.timestamp || ''}|${normalized.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-100);
}

function setAlertsForSession(hostId, sessionId, alerts) {
  const key = makeSessionKey(hostId, sessionId);
  state.alerts.set(key, dedupeAlerts(alerts));
}

function appendAlertForSession(hostId, sessionId, alert) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.alerts.get(key) || [];
  state.alerts.set(key, dedupeAlerts([...existing, alert]));
}

function shouldDisplayAlert(entry) {
  const message = String(entry?.message || '');
  return !(
    /codex_app_server: failed to initialize sqlite state db/i.test(message)
    || /Codex could not find bubblewrap on PATH/i.test(message)
    || /sandbox prerequisites/i.test(message)
    || /concepts\/sandboxing#prerequisites/i.test(message)
  );
}

function isStaleStartupFailureAlert(entry, session) {
  if (!session?.live) {
    return false;
  }

  const message = String(entry?.message || '');
  if (!/runner: no pipe-in provided|codex app-server exited early|failed to spawn managed session|failed:spawn-error|exited:1:null/i.test(message)) {
    return false;
  }

  const runtime = getRuntimeForSession(session) || session.runtime || null;
  const recoveredAt = Date.parse(runtime?.updatedAt || session.lastUpdatedAt || '');
  const alertAt = Date.parse(entry?.timestamp || '');
  return !Number.isFinite(recoveredAt) || !Number.isFinite(alertAt) || alertAt < recoveredAt;
}

function getAlertsForSession(session) {
  const key = getSessionKey(session);
  return key
    ? (state.alerts.get(key) || [])
      .filter(shouldDisplayAlert)
      .filter((entry) => !isStaleStartupFailureAlert(entry, session))
    : [];
}

function getTranscriptForSession(session) {
  const key = getSessionKey(session);
  return key ? state.transcripts.get(key) || [] : [];
}

function isTranscriptPinnedToBottom(log) {
  if (!log) {
    return true;
  }
  const distanceFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
  return distanceFromBottom < 96;
}

function restoreTranscriptScroll(log, options = {}) {
  if (!log) {
    return;
  }
  if (options.forceScroll || options.shouldStickToBottom) {
    log.scrollTop = log.scrollHeight;
    return;
  }
  const bottomOffset = Number.isFinite(options.bottomOffset) ? options.bottomOffset : 0;
  log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - bottomOffset);
}

function setRuntimeForSession(hostId, sessionId, runtime) {
  const key = makeSessionKey(hostId, sessionId);
  if (!runtime || typeof runtime !== 'object') {
    state.runtime.delete(key);
    return;
  }

  const previous = state.runtime.get(key) || {};
  const updatedAt = runtime.updatedAt || new Date().toISOString();
  const next = {
    ...previous,
    ...runtime,
    updatedAt,
  };

  if (Object.prototype.hasOwnProperty.call(runtime, 'phase')) {
    next.phaseStartedAt = runtime.phase !== previous.phase
      ? updatedAt
      : previous.phaseStartedAt || updatedAt;
  } else {
    next.phaseStartedAt = previous.phaseStartedAt || (next.phase ? updatedAt : null);
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'busy')) {
    next.busyStartedAt = runtime.busy
      ? (previous.busy ? previous.busyStartedAt || updatedAt : updatedAt)
      : null;
  } else {
    next.busyStartedAt = previous.busyStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'activeTurnId')) {
    next.turnStartedAt = runtime.activeTurnId
      ? (runtime.activeTurnId !== previous.activeTurnId ? updatedAt : previous.turnStartedAt || updatedAt)
      : null;
  } else {
    next.turnStartedAt = previous.turnStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'connection')) {
    next.runtimeConnectionStartedAt = runtime.connection !== previous.connection
      ? updatedAt
      : previous.runtimeConnectionStartedAt || updatedAt;
  } else {
    next.runtimeConnectionStartedAt = previous.runtimeConnectionStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'reasoningSummary') && runtime.reasoningSummary) {
    next.reasoningUpdatedAt = updatedAt;
  } else {
    next.reasoningUpdatedAt = previous.reasoningUpdatedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'planSummary') && runtime.planSummary) {
    next.planUpdatedAt = updatedAt;
  } else {
    next.planUpdatedAt = previous.planUpdatedAt || null;
  }

  state.runtime.set(key, next);
}

function patchRuntimeForSession(hostId, sessionId, patch) {
  setRuntimeForSession(hostId, sessionId, patch);
}

function getRuntimeForSession(session) {
  const key = getSessionKey(session);
  return key ? state.runtime.get(key) || null : null;
}

function dedupeDiagnostics(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    if (!entry) {
      continue;
    }

    const normalized = {
      timestamp: entry.timestamp || null,
      severity: entry.severity || 'info',
      source: entry.source || 'codex',
      kind: entry.kind || 'event',
      method: entry.method || null,
      message: String(entry.message || ''),
      detail: entry.detail || null,
      data: entry.data || null,
      turnId: entry.turnId || entry.data?.turnId || null,
    };
    const key = `${normalized.timestamp || ''}|${normalized.kind}|${normalized.method || ''}|${normalized.message}|${normalized.detail || ''}|${normalized.turnId || ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-200);
}

function setDiagnosticsForSession(hostId, sessionId, diagnostics) {
  const key = makeSessionKey(hostId, sessionId);
  state.diagnostics.set(key, dedupeDiagnostics(diagnostics));
}

function appendDiagnosticForSession(hostId, sessionId, entry) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.diagnostics.get(key) || [];
  state.diagnostics.set(key, dedupeDiagnostics([...existing, entry]));
}

function getDiagnosticsForSession(session) {
  const key = getSessionKey(session);
  return key ? state.diagnostics.get(key) || [] : [];
}

function setRequestsForSession(hostId, sessionId, requests) {
  const key = makeSessionKey(hostId, sessionId);
  const normalized = Array.isArray(requests) ? requests.slice(-40) : [];
  state.requests.set(key, normalized);
}

function upsertRequestForSession(hostId, sessionId, request) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.requests.get(key) || [];
  const requestId = String(request.requestId || '');
  const index = existing.findIndex((item) => String(item.requestId || '') === requestId);
  const next = {
    ...request,
    requestId,
  };
  if (index === -1) {
    existing.push(next);
  } else {
    existing[index] = {
      ...existing[index],
      ...next,
    };
  }
  state.requests.set(key, existing.slice(-40));
}

function resolveRequestForSession(hostId, sessionId, request) {
  upsertRequestForSession(hostId, sessionId, request);
}

function getRequestsForSession(session) {
  const key = getSessionKey(session);
  return key ? state.requests.get(key) || [] : [];
}

function setReceivedFilesForSession(hostId, sessionId, files) {
  const key = makeSessionKey(hostId, sessionId);
  state.receivedFiles.set(key, Array.isArray(files) ? files : []);
}

function getReceivedFilesForSession(session) {
  const key = getSessionKey(session);
  return key ? state.receivedFiles.get(key) || [] : [];
}

function isReceivedFilesLoading(session) {
  const key = getSessionKey(session);
  return key ? state.receivedFilesLoadingKeys.has(key) : false;
}

function setStreamStatusForSession(hostId, sessionId, patch) {
  const key = makeSessionKey(hostId, sessionId);
  const previous = state.streamStatus.get(key) || {};
  const changedAt = patch?.changedAt || new Date().toISOString();
  const next = {
    ...previous,
    ...patch,
  };

  if (Object.prototype.hasOwnProperty.call(patch || {}, 'connection')) {
    next.connectionChangedAt = patch.connection !== previous.connection
      ? changedAt
      : previous.connectionChangedAt || changedAt;
  }

  if (patch?.lastPingAt) {
    next.lastEventAt = patch.lastPingAt;
  }

  state.streamStatus.set(key, next);
}

function getStreamStatusForSession(session) {
  const key = getSessionKey(session);
  return key ? state.streamStatus.get(key) || null : null;
}

function getConnector(connectorId) {
  return state.connectors.find((connector) => connector.connectorId === connectorId) || null;
}

function normalizeMatchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getConnectorForHost(hostId) {
  const host = getHost(hostId);
  return state.connectors.find((connector) => connector.hostId === hostId || connector.runtime?.attachedHostId === hostId)
    || state.connectors.find((connector) => {
      if (!host) {
        return false;
      }
      return normalizeMatchText(connector.label) === normalizeMatchText(host.label);
    })
    || null;
}

function syncModalBodyState() {
  const open = Boolean(
    state.connectorManagerOpen
    || state.directoryPicker.open
    || state.statusWindowOpen
    || state.sessionDetailsOpen
    || state.settingsOpen
  );
  document.body.classList.toggle('modal-open', open);
}

function buildConnectorDraft() {
  return {
    connectorId: '',
    label: '',
    kind: 'outbound_agent',
    hostId: '',
    relayUrl: window.location.origin,
    targetHost: '',
    targetPort: 22,
    username: '',
    codexHome: '~/.codex',
    workspaceRoots: [],
    notes: '',
    gateway: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      proxyJump: '',
      authMethod: 'ssh_key',
      otpSource: '',
    },
    auth: {
      method: 'ssh_key',
      keyPath: '',
      agentForwarding: true,
      rememberDevice: false,
      otpSource: '',
    },
    bootstrap: {
      mode: 'manual_tmux',
      remoteDirectory: '~/mobile-codex-remote',
      tmuxSession: 'codex-remote',
      serviceName: 'codex-remote',
      launchCommand: '',
    },
    plan: {
      summary: 'Create a saved HPC connector profile for gateway, bootstrap, and MFA policy.',
      warnings: [],
      recommendations: [],
      bootstrapCommand: '',
    },
    runtime: {
      phase: 'saved',
      phaseLabel: 'Draft',
      interactiveAuth: false,
      attachedHostOnline: false,
    },
    secretStatus: {
      hasGatewayPassword: false,
      hasTargetPassword: false,
    },
  };
}

function renderOverview() {
  const overviewStats = el('overview-stats');
  overviewStats.innerHTML = '';

  const summary = state.stats?.summary || {
    totalHosts: 0,
    onlineHosts: 0,
    totalSessions: 0,
    liveSessions: 0,
  };

  const cards = [
    ['Hosts', summary.totalHosts],
    ['Online', summary.onlineHosts],
    ['Sessions', summary.totalSessions],
    ['Live', summary.liveSessions],
  ];

  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'mini-stat';
    card.innerHTML = `
      <div class="muted">${label}</div>
      <div class="value">${value}</div>
    `;
    overviewStats.appendChild(card);
  }

  const connectorSummary = el('connector-summary');
  if (connectorSummary) {
    const gatewayCount = state.connectors.filter((connector) => connector.runtime?.usesGateway).length;
    const interactiveCount = state.connectors.filter((connector) => connector.runtime?.interactiveAuth).length;
    const attachedCount = state.connectors.filter((connector) => connector.runtime?.attachedHostOnline).length;
    connectorSummary.textContent = state.connectors.length
      ? `${state.connectors.length} saved | ${gatewayCount} via gateway | ${interactiveCount} with MFA/manual auth | ${attachedCount} attached`
      : 'No HPC connector profiles saved yet.';
  }

  const dismissed = el('dismissed-hosts');
  dismissed.innerHTML = '';
  if (state.dismissedHosts.length > 0) {
    const box = document.createElement('div');
    box.className = 'dismissed-list';
    box.textContent = `Removed hosts: ${state.dismissedHosts.join(', ')}`;
    dismissed.appendChild(box);
  }
}

function setConnectorManagerOpen(open) {
  state.connectorManagerOpen = Boolean(open);
  renderConnectorManager();
}

function openConnectorManager(connectorId = null) {
  state.connectorEditorId = connectorId || state.connectorEditorId || state.connectors[0]?.connectorId || null;
  setConnectorManagerOpen(true);
}

function closeConnectorManager() {
  state.connectorManagerOpen = false;
  renderConnectorManager();
}

function populateConnectorForm(connector) {
  const draft = connector || buildConnectorDraft();
  el('connector-id').value = draft.connectorId || '';
  el('connector-label').value = draft.label || '';
  el('connector-kind').value = draft.kind || 'outbound_agent';
  el('connector-host-id').value = draft.hostId || '';
  el('connector-relay-url').value = draft.relayUrl || '';
  el('connector-target-host').value = draft.targetHost || '';
  el('connector-target-port').value = String(draft.targetPort || 22);
  el('connector-username').value = draft.username || '';
  el('connector-codex-home').value = draft.codexHome || '~/.codex';
  el('connector-workspace-roots').value = Array.isArray(draft.workspaceRoots) ? draft.workspaceRoots.join('\n') : '';
  el('connector-notes').value = draft.notes || '';
  el('connector-gateway-enabled').value = draft.gateway?.enabled ? 'true' : 'false';
  el('connector-gateway-host').value = draft.gateway?.host || '';
  el('connector-gateway-port').value = String(draft.gateway?.port || 22);
  el('connector-gateway-username').value = draft.gateway?.username || '';
  el('connector-proxy-jump').value = draft.gateway?.proxyJump || '';
  el('connector-gateway-auth-method').value = draft.gateway?.authMethod || 'ssh_key';
  el('connector-gateway-password').value = '';
  el('connector-gateway-password').placeholder = draft.secretStatus?.hasGatewayPassword
    ? 'Gateway password saved locally; leave blank to keep it'
    : 'Gateway password, saved locally only';
  el('connector-gateway-otp-source').value = draft.gateway?.otpSource || '';
  el('connector-auth-method').value = draft.auth?.method || 'ssh_key';
  el('connector-auth-key-path').value = draft.auth?.keyPath || '';
  el('connector-auth-password').value = '';
  el('connector-auth-password').placeholder = draft.secretStatus?.hasTargetPassword
    ? 'Target password saved locally; leave blank to keep it'
    : 'Target password, saved locally only';
  el('connector-auth-agent-forwarding').value = draft.auth?.agentForwarding ? 'true' : 'false';
  el('connector-auth-remember-device').value = draft.auth?.rememberDevice ? 'true' : 'false';
  el('connector-auth-otp-source').value = draft.auth?.otpSource || '';
  el('connector-bootstrap-mode').value = draft.bootstrap?.mode || 'manual_tmux';
  el('connector-bootstrap-remote-directory').value = draft.bootstrap?.remoteDirectory || '~/mobile-codex-remote';
  el('connector-bootstrap-tmux-session').value = draft.bootstrap?.tmuxSession || 'codex-remote';
  el('connector-bootstrap-service-name').value = draft.bootstrap?.serviceName || 'codex-remote';
  el('connector-bootstrap-launch-command').value = draft.bootstrap?.launchCommand || '';
  el('connector-editor-title').textContent = connector ? connector.label || connector.connectorId : 'New connector';
  el('connector-editor-subtitle').textContent = connector
    ? 'Edit the saved HPC connection recipe. Secrets stay out of the relay.'
    : 'Create a saved HPC connection recipe. Secrets stay out of the relay.';
  const deleteButton = el('delete-connector-button');
  deleteButton.classList.toggle('hidden', !connector?.connectorId);
}

function readConnectorForm() {
  return {
    connectorId: el('connector-id').value.trim(),
    label: el('connector-label').value.trim(),
    kind: el('connector-kind').value,
    hostId: el('connector-host-id').value.trim(),
    relayUrl: el('connector-relay-url').value.trim(),
    targetHost: el('connector-target-host').value.trim(),
    targetPort: Number(el('connector-target-port').value || '22'),
    username: el('connector-username').value.trim(),
    codexHome: el('connector-codex-home').value.trim(),
    workspaceRoots: el('connector-workspace-roots').value.trim().split(/\n+/).map((item) => item.trim()).filter(Boolean),
    notes: el('connector-notes').value.trim(),
    gateway: {
      enabled: el('connector-gateway-enabled').value === 'true',
      host: el('connector-gateway-host').value.trim(),
      port: Number(el('connector-gateway-port').value || '22'),
      username: el('connector-gateway-username').value.trim(),
      proxyJump: el('connector-proxy-jump').value.trim(),
      authMethod: el('connector-gateway-auth-method').value,
      otpSource: el('connector-gateway-otp-source').value.trim(),
    },
    auth: {
      method: el('connector-auth-method').value,
      keyPath: el('connector-auth-key-path').value.trim(),
      agentForwarding: el('connector-auth-agent-forwarding').value === 'true',
      rememberDevice: el('connector-auth-remember-device').value === 'true',
      otpSource: el('connector-auth-otp-source').value.trim(),
    },
    secrets: {
      gatewayPassword: el('connector-gateway-password').value,
      targetPassword: el('connector-auth-password').value,
    },
    bootstrap: {
      mode: el('connector-bootstrap-mode').value,
      remoteDirectory: el('connector-bootstrap-remote-directory').value.trim(),
      tmuxSession: el('connector-bootstrap-tmux-session').value.trim(),
      serviceName: el('connector-bootstrap-service-name').value.trim(),
      launchCommand: el('connector-bootstrap-launch-command').value.trim(),
    },
  };
}

function renderConnectorRunbookList(container, entries, emptyText) {
  container.innerHTML = '';
  const items = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'connector-runbook-item';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const entry of items) {
    const item = document.createElement('div');
    item.className = 'connector-runbook-item';
    item.textContent = entry;
    container.appendChild(item);
  }
}

function renderConnectorRunbook(connector) {
  const command = connector?.plan?.bootstrapCommand || '';
  const smokeCommand = connector?.plan?.sshSmokeTestCommand || '';
  const loginCommand = connector?.plan?.sshLoginCommand || '';
  const summary = connector?.plan?.summary || 'Save a connector to generate its tmux command.';
  const copyButton = el('copy-connector-command-button');
  const copyLoginButton = el('copy-connector-login-button');
  const copySmokeButton = el('copy-connector-smoke-button');
  const runSmokeButton = el('run-connector-smoke-button');
  const runStatusButton = el('run-connector-status-button');
  const runBootstrapButton = el('run-connector-bootstrap-button');
  const runRestartButton = el('run-connector-restart-button');
  const actionResult = el('connector-action-result');
  const actionKey = connector?.connectorId || '';
  const busyAction = state.connectorActionBusy?.connectorId === actionKey
    ? state.connectorActionBusy.action
    : null;
  const actionBusy = Boolean(busyAction);
  const result = actionKey ? state.connectorActionResults.get(actionKey) : null;
  el('connector-runbook-summary').textContent = summary;
  el('connector-login-command').textContent = loginCommand || '(no login command yet)';
  el('connector-smoke-command').textContent = smokeCommand || '(no smoke test yet)';
  el('connector-bootstrap-command').textContent = command || '(no command yet)';
  copyButton.disabled = !command;
  copyLoginButton.disabled = !loginCommand;
  copySmokeButton.disabled = !smokeCommand;
  runSmokeButton.disabled = !connector || actionBusy;
  runStatusButton.disabled = !connector || actionBusy;
  runBootstrapButton.disabled = !connector || actionBusy;
  runRestartButton.disabled = !connector || actionBusy;
  runSmokeButton.textContent = busyAction === 'smoke_test' ? 'Running...' : 'Run Test';
  runStatusButton.textContent = busyAction === 'status' ? 'Checking...' : 'Check Status';
  runBootstrapButton.textContent = busyAction === 'bootstrap' ? 'Starting...' : 'Start Agent';
  runRestartButton.textContent = busyAction === 'restart' ? 'Restarting...' : 'Restart Agent';
  renderConnectorActionResult(actionResult, result, actionBusy);
  renderConnectorRunbookList(el('connector-plan-steps'), connector?.plan?.steps || [], 'No bootstrap steps yet.');
  renderConnectorRunbookList(el('connector-plan-warnings'), connector?.plan?.warnings || [], 'No MFA or auth warnings.');
}

function connectorCodexInstallGuidance(result) {
  if (!result) {
    return [];
  }
  const statusText = [
    result.status,
    result.deploy?.status,
    result.message,
    result.deploy?.message,
  ].filter(Boolean).join(' ');
  if (!/codex_runtime_missing|no .*codex cli|codex cli .*not found|CODEX_REMOTE_CHECK_CODEX=missing/i.test(statusText)) {
    return [];
  }

  return [
    'Remote Codex CLI install guide:',
    'Option A, shared HPC/conda:',
    'conda create -n codex-node -c conda-forge nodejs=20 -y',
    'conda activate codex-node',
    'npm install -g @openai/codex',
    'codex --help',
    '',
    'Option B, personal Linux server:',
    'curl -fsSL https://fnm.vercel.app/install | bash',
    'source ~/.bashrc',
    'fnm install 20',
    'fnm use 20',
    'npm install -g @openai/codex',
    'codex --help',
    '',
    'After installation, run Start Agent again. The remote scanner checks PATH, ~/.codex, common conda/nvm locations, and the uploaded runtime.',
  ];
}

function renderConnectorActionResult(container, result, busy) {
  if (!result && !busy) {
    container.className = 'connector-action-result hidden';
    container.textContent = '';
    return;
  }

  container.className = `connector-action-result ${result?.ok ? 'success' : result ? 'failure' : ''}`.trim();
  const lines = [];
  if (busy) {
    lines.push('Running remote connector action...');
  }
  if (result) {
    lines.push(`${prettyStatusLabel(result.status || result.action || 'Result')}: ${result.message || ''}`.trim());
    if (result.expectedHostId) {
      lines.push(`Expected host: ${result.expectedHostId}`);
    }
    if (result.multiplexFallback) {
      lines.push(`SSH multiplex fallback: ${result.multiplexFallback.reason || 'ControlMaster failed; retried without multiplexing.'}`);
      if (result.multiplexFallback.controlPath) {
        lines.push(`ControlPath: ${result.multiplexFallback.controlPath}`);
      }
    }
    if (typeof result.exitCode !== 'undefined' && result.exitCode !== null) {
      lines.push(`Exit code: ${result.exitCode}`);
    }
    if (result.deploy) {
      lines.push(`deploy: ${prettyStatusLabel(result.deploy.status || 'deploy')} - ${result.deploy.message || ''}`.trim());
      for (const step of result.deploy.steps || []) {
        const stepLines = [`${step.name || 'step'} exit ${step.exitCode}`];
        if (step.stdout) {
          stepLines.push(`stdout:\n${step.stdout}`);
        }
        if (step.stderr) {
          stepLines.push(`stderr:\n${step.stderr}`);
        }
        lines.push(stepLines.join('\n'));
      }
    }
    if (result.stdout) {
      lines.push(`stdout:\n${result.stdout}`);
    }
    if (result.stderr) {
      lines.push(`stderr:\n${result.stderr}`);
    }
    if (result.command && result.status === 'manual_required') {
      lines.push(`manual login:\n${result.command}`);
    }
    if (result.bootstrapCommand && result.status === 'manual_required') {
      lines.push(`manual bootstrap:\n${result.bootstrapCommand}`);
    }
    const installGuidance = connectorCodexInstallGuidance(result);
    if (installGuidance.length) {
      lines.push(installGuidance.join('\n'));
    }
  }

  container.innerHTML = `<pre>${escapeHtml(lines.join('\n\n'))}</pre>`;
}

function renderConnectorManager() {
  const list = el('connector-list');
  const editor = el('connector-editor');
  const overlay = el('connector-manager-overlay');
  const hostMap = new Map(state.hosts.map((host) => [host.hostId, host]));
  list.innerHTML = '';

  if (!state.connectorManagerOpen) {
    overlay.classList.add('hidden');
    editor.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  overlay.classList.remove('hidden');
  editor.classList.remove('hidden');
  syncModalBodyState();

  if (!state.connectors.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved connectors yet. Add one for HPC, gateway, or passwordless bootstrap.';
    list.appendChild(empty);
  } else {
    for (const connector of state.connectors) {
      const host = connector.hostId ? hostMap.get(connector.hostId) || null : null;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `connector-card ${connector.connectorId === state.connectorEditorId ? 'active' : ''}`;
      const secretSummary = [
        connector.secretStatus?.hasGatewayPassword ? 'gateway password saved' : '',
        connector.secretStatus?.hasTargetPassword ? 'target password saved' : '',
      ].filter(Boolean).join(' | ') || 'no saved password';
      item.innerHTML = `
        <div class="connector-card-top">
          <div>
            <div class="title">${connector.label}</div>
            <div class="sub">${connectorKindLabel(connector.kind)} | ${connector.authLabel} | ${connector.runtime?.phaseLabel || 'Saved'}</div>
          </div>
          <div class="connector-badge">${connector.runtime?.attachedHostOnline ? 'Live' : 'Saved'}</div>
        </div>
        <div class="connector-meta">${connector.hostId || connector.targetHost || '(unbound target)'}</div>
        <div class="connector-meta">${connector.gatewaySummary} | Gateway ${connector.gatewayAuthLabel || 'Auth'} | Target ${connector.authLabel}</div>
        <div class="connector-meta">${secretSummary}</div>
        <div class="connector-plan">${connector.plan?.summary || 'Saved connector recipe.'}</div>
        <div class="connector-plan">${host ? `Attached host: ${host.label} | ${host.online ? 'online' : 'offline'}` : 'No attached host yet.'}</div>
      `;
      item.onclick = () => {
        state.connectorEditorId = connector.connectorId;
        populateConnectorForm(connector);
        renderConnectorManager();
      };
      list.appendChild(item);
    }
  }

  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  populateConnectorForm(connector || buildConnectorDraft());
  renderConnectorRunbook(connector);
}

function createActionButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-button ${className}`;
  button.textContent = label;
  return button;
}

function renderHostNav() {
  const hostList = el('host-overview-list');
  hostList.innerHTML = '';

  for (const host of state.hosts) {
    const item = document.createElement('div');
    item.className = `host-card ${host.hostId === state.selectedHostId ? 'active' : ''}`;

    const top = document.createElement('div');
    top.className = 'host-card-top';
    top.innerHTML = `
      <div>
        <div class="title">${host.label}</div>
        <div class="sub">${host.platform} | ${host.online ? 'online' : 'offline'} | ${host.sessionCount || 0} dialogs</div>
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'host-actions';

    const switchButton = createActionButton('Switch', 'secondary-button');
    switchButton.disabled = state.hostSwitchBusyId === host.hostId;
    switchButton.textContent = state.hostSwitchBusyId === host.hostId ? 'Checking...' : 'Switch';
    switchButton.onclick = async (event) => {
      event.stopPropagation();
      try {
        await setSelectedHost(host.hostId);
      } catch (error) {
        reportError(error);
      }
    };

    const importButton = createActionButton('Import', 'secondary-button');
    importButton.onclick = async (event) => {
      event.stopPropagation();
      await importHost(host.hostId);
    };

    const deleteButton = createActionButton('Delete', 'danger-button');
    deleteButton.onclick = async (event) => {
      event.stopPropagation();
      await deleteHost(host.hostId);
    };

    actions.append(switchButton, importButton, deleteButton);
    item.append(top, actions);
    item.onclick = () => {
      setSelectedHost(host.hostId).catch(reportError);
    };
    hostList.appendChild(item);
  }
}

function renderHostSwitcher() {
  const switcher = el('host-switcher');
  const button = el('host-switcher-button');
  const menu = el('host-switcher-menu');
  const selectedHostId = state.selectedHostId || '';
  switcher.innerHTML = '';

  if (!state.hosts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No hosts available';
    switcher.appendChild(option);
    switcher.disabled = true;
    renderMobileSelectMenu({
      button,
      menu,
      label: 'No hosts available',
      options: [],
      selectedValue: '',
      open: false,
      disabled: true,
    });
    return;
  }

  const mobileOptions = [];
  for (const host of state.hosts) {
    const option = document.createElement('option');
    option.value = host.hostId;
    option.textContent = `${host.label} (${host.online ? 'online' : 'offline'})`;
    switcher.appendChild(option);
    mobileOptions.push({
      value: host.hostId,
      label: option.textContent,
      disabled: Boolean(state.hostSwitchBusyId),
    });
  }

  switcher.disabled = Boolean(state.hostSwitchBusyId);
  switcher.value = selectedHostId;
  const selectedHost = getHost(selectedHostId) || state.hosts[0];
  const buttonLabel = state.hostSwitchBusyId
    ? 'Checking host...'
    : selectedHost
      ? `${selectedHost.label} (${selectedHost.online ? 'online' : 'offline'})`
      : 'Select host';
  renderMobileSelectMenu({
    button,
    menu,
    label: buttonLabel,
    options: mobileOptions,
    selectedValue: selectedHostId,
    open: state.mobileMenus.hostSwitcher,
    disabled: Boolean(state.hostSwitchBusyId),
    onSelect: async (hostId) => {
      if (hostId) {
        await setSelectedHost(hostId);
      }
    },
  });
}

function getVariantLabels(sessions) {
  const labels = new Map();
  const counters = {
    live: 0,
    resumeLive: 0,
    forkLive: 0,
    managed: 0,
    resumed: 0,
    fork: 0,
    starting: 0,
  };

  function nextLabel(key, single, multiPrefix) {
    counters[key] += 1;
    return counters[key] === 1 ? single : `${multiPrefix} ${counters[key]}`;
  }

  let liveIndex = 0;

  for (const session of sessions) {
    if (session.source !== 'managed') {
      labels.set(session.sessionId, 'History');
      continue;
    }

    if (session.state === 'starting') {
      labels.set(session.sessionId, nextLabel('starting', 'Starting', 'Starting'));
      continue;
    }

    if (session.launchMode === 'resume') {
      labels.set(
        session.sessionId,
        session.live
          ? nextLabel('resumeLive', 'Resumed Live', 'Resumed Live')
          : nextLabel('resumed', 'Resumed', 'Resumed')
      );
      continue;
    }

    if (session.launchMode === 'fork') {
      labels.set(
        session.sessionId,
        session.live
          ? nextLabel('forkLive', 'Fork Live', 'Fork Live')
          : nextLabel('fork', 'Fork', 'Fork')
      );
      continue;
    }

    if (session.live) {
      liveIndex += 1;
      labels.set(session.sessionId, liveIndex === 1 ? 'Live' : `Live ${liveIndex}`);
      continue;
    }

    labels.set(session.sessionId, nextLabel('managed', 'Managed', 'Managed'));
  }

  return labels;
}

function renderVariantButtons(container, conversation, selectedSessionId) {
  container.innerHTML = '';

  if (!conversation || !conversation.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No variants are available for this conversation yet.';
    container.appendChild(empty);
    return;
  }

  const labels = getVariantLabels(conversation.sessions);
  for (const session of conversation.sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `variant-chip ${session.live ? 'live' : 'history'} ${session.sessionId === selectedSessionId ? 'active' : ''}`.trim();
    button.textContent = labels.get(session.sessionId) || 'Session';
    button.title = `${session.title || session.sessionId}\n${session.sessionId}`;
    button.onclick = (event) => {
      event.stopPropagation();
      selectSession(session).catch(reportError);
    };
    container.appendChild(button);
  }
}

function renderCollectionTabs() {
  const select = el('session-collection-select');
  const button = el('session-collection-button');
  const menu = el('session-collection-menu');
  const popover = el('collection-manager-popover');
  const list = el('collection-manager-list');
  if (!select) {
    return;
  }

  select.innerHTML = '';
  const mobileOptions = [];
  for (const collection of state.sessionCollections) {
    const option = document.createElement('option');
    option.value = collection.collectionId;
    option.textContent = `${collection.name || 'Collection'} (${collection.itemCount || 0})`;
    select.appendChild(option);
    mobileOptions.push({
      value: collection.collectionId,
      label: option.textContent,
    });
  }
  select.value = state.selectedCollectionId;
  const selectedCollection = getSelectedCollection();
  renderMobileSelectMenu({
    button,
    menu,
    label: selectedCollection
      ? `${selectedCollection.name || 'Collection'} (${selectedCollection.itemCount || 0})`
      : 'Default',
    options: mobileOptions,
    selectedValue: state.selectedCollectionId,
    open: state.mobileMenus.collection,
    onSelect: async (collectionId) => {
      state.selectedCollectionId = collectionId || 'default';
      renderAll();
    },
  });

  if (popover) {
    popover.classList.toggle('hidden', !state.collectionManagerOpen);
  }
  if (!list) {
    return;
  }
  list.innerHTML = '';
  for (const collection of state.sessionCollections) {
    const row = document.createElement('div');
    row.className = 'collection-manager-row';
    const isDefault = collection.collectionId === 'default';
    row.innerHTML = `
      <div class="collection-manager-copy">
        <strong>${escapeHtml(collection.name || 'Collection')}</strong>
        <span>${escapeHtml(isDefault ? 'Default collection keeps every session.' : `${collection.itemCount || 0} saved conversation${collection.itemCount === 1 ? '' : 's'}.`)}</span>
      </div>
    `;
    const actions = document.createElement('div');
    actions.className = 'collection-manager-actions';
    if (!isDefault) {
      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'secondary-button';
      renameButton.textContent = 'Rename';
      renameButton.onclick = async () => {
        const currentName = collection.name || 'Collection';
        const nextName = window.prompt(`Rename collection "${currentName}" to:`, currentName);
        const trimmed = String(nextName || '').trim();
        if (!trimmed || trimmed === currentName) {
          return;
        }
        if (!window.confirm(`Rename "${currentName}" to "${trimmed}"?`)) {
          return;
        }
        try {
          await renameSessionCollection(collection.collectionId, trimmed);
        } catch (error) {
          reportError(error);
        }
      };
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'danger-button';
      deleteButton.textContent = 'Delete';
      deleteButton.onclick = async () => {
        if (!window.confirm(`Delete collection "${collection.name || 'Collection'}"? Sessions will stay in Default.`)) {
          return;
        }
        try {
          await deleteSessionCollection(collection.collectionId);
        } catch (error) {
          reportError(error);
        }
      };
      actions.append(renameButton, deleteButton);
    } else {
      const badge = document.createElement('span');
      badge.className = 'collection-manager-badge';
      badge.textContent = 'System';
      actions.appendChild(badge);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderConversationNav() {
  const list = el('session-list');
  list.innerHTML = '';

  const host = getHost(state.selectedHostId);
  el('selected-host-title').textContent = host ? host.label : 'No host selected';
  el('selected-host-meta').textContent = host ? `${host.platform} | ${host.online ? 'online' : 'offline'}` : '';
  renderHostSwitcher();
  renderCollectionTabs();

  const collection = getSelectedCollection();
  const groups = getConversationGroupsForCollection(collection);
  const visibleGroups = filterConversationGroups(groups);
  const searchInput = el('session-search-input');
  const searchMode = el('session-search-mode');
  const searchModeButton = el('session-search-mode-button');
  const searchModeMenu = el('session-search-mode-menu');
  const searchSummary = el('session-search-summary');
  const clearSearchButton = el('clear-session-search-button');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = state.sessionSearchQuery;
  }
  if (searchMode) {
    searchMode.value = state.sessionSearchMode;
  }
  renderMobileSelectMenu({
    button: searchModeButton,
    menu: searchModeMenu,
    label: getSessionSearchModeLabel(state.sessionSearchMode),
    options: Object.entries(SESSION_SEARCH_MODE_LABELS).map(([value, label]) => ({ value, label })),
    selectedValue: state.sessionSearchMode,
    open: state.mobileMenus.searchMode,
    onSelect: async (mode) => {
      setSessionSearchMode(mode);
    },
  });
  if (searchSummary) {
    const query = state.sessionSearchQuery.trim();
    const scope = collection.collectionId === 'default'
      ? `Default on ${host?.label || 'selected host'}`
      : collection.name;
    searchSummary.textContent = query
      ? `${visibleGroups.length} of ${groups.length} in ${scope} match "${query}"`
      : groups.length
        ? `${groups.length} conversations in ${scope}`
        : '';
  }
  if (clearSearchButton) {
    clearSearchButton.classList.toggle('hidden', !state.sessionSearchQuery.trim());
  }

  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = collection.collectionId === 'default'
      ? 'Import a host or start a managed session to see conversations here.'
      : 'This collection is empty. Save a conversation into it from Default.';
    list.appendChild(empty);
    return;
  }
  if (!visibleGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No conversations match this search.';
    list.appendChild(empty);
    return;
  }

  for (const group of visibleGroups) {
    const apiSummary = getSessionApiProfileSummary(group.preferredSession || group.sessions?.[0] || {
      hostId: group.hostId,
      apiProfile: group.apiProfile,
    });
    const preview = group.latestUserMessage
      ? `You: ${truncatePreview(group.latestUserMessage)}`
      : group.latestAgentMessage
        ? `Codex: ${truncatePreview(group.latestAgentMessage)}`
        : 'No prompt preview available';

    const item = document.createElement('div');
    item.className = `conversation-card ${group.conversationKey === state.selectedConversationKey ? 'active' : ''}`;
    item.innerHTML = `
      <div class="conversation-card-top">
        <div>
          <div class="title">${escapeHtml(group.title || group.conversationKey)}</div>
          <div class="sub">${escapeHtml(group.hostLabel || getHost(group.hostId)?.label || group.hostId)} | ${group.liveCount > 0 ? `${group.liveCount} live` : 'history only'} | ${group.totalCount} variants</div>
        </div>
        <div class="conversation-stats">
          <div class="count">${group.totalCount}</div>
          <div class="label">sessions</div>
        </div>
      </div>
      <div class="path">${escapeHtml(group.cwd || '(unknown path)')}</div>
      <div class="conversation-tag-row">
        <span class="api-profile-chip ${apiSummary.source === 'recorded' ? 'recorded' : 'fallback'}" title="${escapeHtml(apiSummary.title)}">${escapeHtml(apiSummary.label)}</span>
      </div>
      <div class="conversation-summary">
        <span>${escapeHtml(formatTime(group.lastUpdatedAt) || 'No recent activity')}</span>
        <span>${group.liveCount > 0 ? 'Joinable live session' : 'History can be resumed'}</span>
      </div>
      <div class="preview">${escapeHtml(preview)}</div>
    `;

    const variantRow = document.createElement('div');
    variantRow.className = 'variant-row';
    renderVariantButtons(variantRow, group, state.selectedSessionId);
    item.appendChild(variantRow);

    const actions = document.createElement('div');
    actions.className = 'conversation-card-actions';
    const moveKey = `${group.hostId}::${group.conversationKey}`;
    const moveAnchor = document.createElement('div');
    moveAnchor.className = 'mobile-select-anchor collection-move-anchor';
    const collectionSelect = document.createElement('select');
    collectionSelect.className = 'collection-move-select native-select-control mobile-replaced-select';
    collectionSelect.innerHTML = '<option value="">Save to collection...</option>';
    const collectionTargets = state.sessionCollections.filter((entry) => entry.collectionId !== 'default');
    for (const target of collectionTargets) {
      const option = document.createElement('option');
      option.value = target.collectionId;
      option.textContent = target.name;
      collectionSelect.appendChild(option);
    }
    collectionSelect.disabled = group.collectionOnly || state.sessionCollections.length <= 1;
    collectionSelect.onclick = (event) => event.stopPropagation();
    collectionSelect.onchange = async (event) => {
      event.stopPropagation();
      const targetCollectionId = event.target.value;
      event.target.value = '';
      if (!targetCollectionId) {
        return;
      }
      try {
        await addConversationToCollection(targetCollectionId, group);
      } catch (error) {
        reportError(error);
      }
    };
    const moveButton = document.createElement('button');
    moveButton.type = 'button';
    moveButton.className = 'secondary-button mobile-select-button collection-move-button';
    moveButton.textContent = 'Save to collection...';
    moveButton.disabled = collectionSelect.disabled;
    moveButton.setAttribute('aria-expanded', state.mobileMenus.collectionMoveKey === moveKey ? 'true' : 'false');
    moveButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!moveButton.disabled) {
        toggleMobileSelectMenu('collectionMoveKey', moveKey);
      }
    };
    const moveMenu = document.createElement('div');
    moveMenu.className = `mobile-select-menu collection-move-menu ${state.mobileMenus.collectionMoveKey === moveKey ? '' : 'hidden'}`.trim();
    moveMenu.setAttribute('role', 'menu');
    renderMobileSelectMenu({
      button: moveButton,
      menu: moveMenu,
      label: 'Save to collection...',
      options: collectionTargets.map((target) => ({
        value: target.collectionId,
        label: target.name || 'Collection',
      })),
      selectedValue: '',
      open: state.mobileMenus.collectionMoveKey === moveKey,
      disabled: collectionSelect.disabled,
      onSelect: async (targetCollectionId) => {
        if (targetCollectionId) {
          await addConversationToCollection(targetCollectionId, group);
        }
      },
    });
    moveAnchor.append(collectionSelect, moveButton, moveMenu);
    actions.appendChild(moveAnchor);
    if (collection.collectionId !== 'default') {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'secondary-button collection-remove-button';
      removeButton.textContent = 'Remove';
      removeButton.onclick = async (event) => {
        event.stopPropagation();
        try {
          await removeConversationFromCollection(collection.collectionId, group);
        } catch (error) {
          reportError(error);
        }
      };
      actions.appendChild(removeButton);
    }
    item.appendChild(actions);

    item.onclick = () => {
      if (!group.collectionOnly) {
        selectConversation(group).catch(reportError);
      }
    };
    list.appendChild(item);
  }
}

function modelCacheKey(session) {
  return getSessionKey(session) || 'none';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function fileExtension(name) {
  const text = String(name || '').trim().toLowerCase();
  const index = text.lastIndexOf('.');
  return index === -1 ? '' : text.slice(index + 1);
}

function isTextLikeFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('text/')) {
    return true;
  }
  if (type === 'application/json' || type === 'application/x-ndjson' || type === 'application/xml') {
    return true;
  }
  return TEXT_FILE_EXTENSIONS.has(fileExtension(file?.name));
}

function isImageFileRef(file) {
  const mime = String(file?.mime || file?.type || '').toLowerCase();
  return mime.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(fileExtension(file?.name || file?.path));
}

function formatHostCapabilityName(host) {
  return host?.label || host?.hostId || 'selected host';
}

function isDownloadablePath(value) {
  const text = String(value || '').trim();
  if (!text || /^(https?:|data:|mailto:)/i.test(text)) {
    return false;
  }
  return DOWNLOADABLE_FILE_EXTENSIONS.has(fileExtension(text));
}

function isBareDownloadableFilename(value) {
  const text = String(value || '').trim();
  return Boolean(text)
    && !/[\\/]/.test(text)
    && !/^[A-Za-z]:/.test(text)
    && !text.startsWith('~')
    && isDownloadablePath(text);
}

function stripPathPunctuation(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[)\].,;:!?]+$/g, '');
}

function decodePathCandidate(value) {
  const cleaned = stripPathPunctuation(value);
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function extractFileRefsFromText(text) {
  const source = String(text || '');
  const refs = [];
  const addRef = (candidate, label = '') => {
    const pathValue = decodePathCandidate(candidate);
    if (!isDownloadablePath(pathValue)) {
      return;
    }
    if (refs.some((entry) => entry.path === pathValue)) {
      return;
    }
    refs.push({
      name: label || basename(pathValue) || pathValue,
      path: pathValue,
      mime: '',
      size: 0,
      isImage: IMAGE_FILE_EXTENSIONS.has(fileExtension(pathValue)),
    });
  };

  const markdownLinkPattern = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let match = null;
  while ((match = markdownLinkPattern.exec(source))) {
    addRef(match[2], match[1]);
  }

  const explicitPattern = /remote-codex-file:([^\s"'<>`]+)/g;
  while ((match = explicitPattern.exec(source))) {
    addRef(match[1]);
  }

  const extensionPattern = Array.from(DOWNLOADABLE_FILE_EXTENSIONS).join('|');
  const unixPattern = new RegExp(`(?:~|\\/)[^\\s"'<>\\|` + '`' + `]+?\\.(${extensionPattern})(?=[\\s\\)\\]\\},.;:!?]|$)`, 'gi');
  while ((match = unixPattern.exec(source))) {
    addRef(match[0]);
  }

  const windowsPattern = new RegExp(`[A-Za-z]:\\\\[^\\n"'<>\\|` + '`' + `]+?\\.(${extensionPattern})(?=[\\s\\)\\]\\},.;:!?]|$)`, 'gi');
  while ((match = windowsPattern.exec(source))) {
    addRef(match[0]);
  }

  const relativePattern = new RegExp(
    `(?:^|[\\s\\(\\[\\{])((?:\\.{1,2}[\\\\/])?(?:[A-Za-z0-9_.@+~-]+[\\\\/])*[A-Za-z0-9_.@+~-]+\\.(${extensionPattern}))(?=[\\s\\)\\]\\},.;:!?]|$)`,
    'gi'
  );
  while ((match = relativePattern.exec(source))) {
    const pathValue = decodePathCandidate(match[1]);
    // Markdown labels like [plot.png] are often just display names for an
    // absolute path listed nearby. Treating bare names as paths makes the
    // browser auto-preview missing files and spam repeated download errors.
    if (!isBareDownloadableFilename(pathValue)) {
      addRef(pathValue);
    }
  }

  return refs;
}

function getTranscriptFileRefs(entry) {
  const explicit = normalizeTranscriptFiles(entry?.files || entry?.attachments || []);
  const extracted = extractFileRefsFromText(entry?.text || '');
  const seen = new Set();
  const merged = [];
  for (const file of [...explicit, ...extracted]) {
    const key = file.path || file.name;
    if (!key || seen.has(key) || isBareDownloadableFilename(file.path || '')) {
      continue;
    }
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

function buildHostFileUrl(session, file, inline = false) {
  const params = new URLSearchParams({
    path: file.path || '',
    sessionId: session?.sessionId || '',
  });
  if (session?.cwd) {
    params.set('cwd', session.cwd);
  }
  if (inline) {
    params.set('inline', '1');
  }
  return `/api/hosts/${encodeURIComponent(session.hostId)}/files/download?${params.toString()}`;
}

function buildReceivedFileUrl(file, inline = false) {
  const params = new URLSearchParams();
  if (inline) {
    params.set('inline', '1');
  }
  return `/api/received-files/${encodeURIComponent(file.fileId)}${params.toString() ? `?${params.toString()}` : ''}`;
}

const FALLBACK_REASONING_EFFORTS = [
  { value: 'minimal', label: 'Minimal / 最小' },
  { value: 'low', label: 'Low / 低' },
  { value: 'medium', label: 'Medium / 中' },
  { value: 'high', label: 'High / 高' },
  { value: 'xhigh', label: 'XHigh / 超高' },
];

const REASONING_EFFORT_LABELS = {
  none: 'None / 关闭',
  minimal: 'Minimal / 最小',
  low: 'Low / 低',
  medium: 'Medium / 中',
  high: 'High / 高',
  xhigh: 'XHigh / 超高',
};

function normalizeModelOption(model) {
  const modelId = String(model?.model || model?.id || '').trim();
  if (!modelId) {
    return null;
  }
  return {
    ...model,
    id: String(model?.id || modelId).trim(),
    model: modelId,
    displayName: String(model?.displayName || modelId).trim(),
    description: String(model?.description || '').trim(),
    inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.map(String) : [],
    supportedReasoningEfforts: Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : [],
    defaultReasoningEffort: String(model?.defaultReasoningEffort || '').trim(),
    hidden: Boolean(model?.hidden),
    isDefault: Boolean(model?.isDefault),
    supportsPersonality: model?.supportsPersonality === true,
  };
}

function getModelOptions(session) {
  const seen = new Set();
  const models = [];
  for (const rawModel of state.codexControls.modelOptionsBySession.get(modelCacheKey(session)) || []) {
    const model = normalizeModelOption(rawModel);
    if (!model || seen.has(model.model)) {
      continue;
    }
    seen.add(model.model);
    models.push(model);
  }
  return models;
}

function findModelOption(session, modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return getModelOptions(session).find((model) => model.isDefault) || null;
  }
  return getModelOptions(session).find((model) => model.model === normalized || model.id === normalized) || null;
}

function inferModelCategory(model) {
  const id = String(model?.model || model?.id || '').toLowerCase();
  if (model?.isDefault) {
    return 'Recommended / 默认推荐';
  }
  if (model?.hidden) {
    return 'Hidden / System';
  }
  if (/mini|nano|small|lite/.test(id)) {
    return 'Small / Fast';
  }
  if (/codex|code/.test(id)) {
    return 'Codex / Coding';
  }
  if (/^gpt[-_.]?\d/.test(id)) {
    return 'GPT / General';
  }
  return 'Other';
}

function modelSelectLabel(model) {
  const badges = [];
  if (model.isDefault) {
    badges.push('default');
  }
  if (model.inputModalities.includes('image')) {
    badges.push('img');
  }
  if (model.defaultReasoningEffort) {
    badges.push(model.defaultReasoningEffort);
  }
  return `${model.displayName || model.model}${badges.length ? ` | ${badges.join(' | ')}` : ''}`;
}

function syncModelSelectFromInput(session) {
  const select = el('codex-model-select');
  const input = el('codex-model-input');
  if (!select || !input) {
    return;
  }
  const value = input.value.trim();
  const matched = value ? findModelOption(session, value) : null;
  select.value = matched ? matched.model : '';
}

function renderComposerModelOptions(session) {
  const datalist = el('codex-model-options');
  const select = el('codex-model-select');
  if (!datalist || !select) {
    return;
  }

  datalist.innerHTML = '';
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  const models = getModelOptions(session);
  const defaultModel = models.find((model) => model.isDefault) || null;
  defaultOption.textContent = defaultModel
    ? `Auto: ${defaultModel.displayName || defaultModel.model}`
    : 'Model: auto/default';
  select.appendChild(defaultOption);

  const grouped = new Map();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.model;
    const effort = model.defaultReasoningEffort ? ` | effort ${model.defaultReasoningEffort}` : '';
    option.label = `${model.displayName || model.model}${model.isDefault ? ' | default' : ''}${effort}${model.description ? ` | ${model.description}` : ''}`;
    datalist.appendChild(option);

    const category = inferModelCategory(model);
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category).push(model);
  }

  for (const [category, categoryModels] of grouped.entries()) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const model of categoryModels) {
      const option = document.createElement('option');
      option.value = model.model;
      option.textContent = modelSelectLabel(model);
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  syncModelSelectFromInput(session);
}

function supportedEffortValues(model) {
  return (model?.supportedReasoningEfforts || [])
    .map((effort) => String(effort?.reasoningEffort || effort || '').trim())
    .filter(Boolean);
}

function renderReasoningEffortOptions(session) {
  const select = el('codex-effort-select');
  if (!select) {
    return;
  }

  const current = select.value;
  const selectedModel = findModelOption(session, el('codex-model-input')?.value.trim());
  const supported = selectedModel ? supportedEffortValues(selectedModel) : [];
  const options = supported.length
    ? supported.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] || value }))
    : FALLBACK_REASONING_EFFORTS;

  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = selectedModel?.defaultReasoningEffort
    ? `Effort: model default (${selectedModel.defaultReasoningEffort})`
    : 'Effort: default';
  select.appendChild(defaultOption);

  for (const optionSpec of options) {
    const option = document.createElement('option');
    option.value = optionSpec.value;
    option.textContent = optionSpec.label;
    select.appendChild(option);
  }

  select.value = options.some((optionSpec) => optionSpec.value === current) ? current : '';
}

function normalizeComposerOptionValues(options = {}) {
  return {
    ...DEFAULT_COMPOSER_OPTIONS,
    model: String(options.model || '').trim(),
    effort: String(options.effort || '').trim() || DEFAULT_COMPOSER_OPTIONS.effort,
    summary: String(options.summary || '').trim(),
    mode: String(options.mode || '').trim() || DEFAULT_COMPOSER_OPTIONS.mode,
    approvalPolicy: typeof options.approvalPolicy === 'object'
      ? options.approvalPolicy
      : String(options.approvalPolicy || '').trim() || DEFAULT_COMPOSER_OPTIONS.approvalPolicy,
    approvalsReviewer: String(options.approvalsReviewer || '').trim() || DEFAULT_COMPOSER_OPTIONS.approvalsReviewer,
    sandboxMode: String(options.sandboxMode || '').trim() || DEFAULT_COMPOSER_OPTIONS.sandboxMode,
    personality: String(options.personality || '').trim(),
  };
}

function inferComposerOptionsFromText(text) {
  const source = String(text || '');
  const inferred = {};
  const modelMatch = source.match(/\bmodel\s*[:=]\s*([A-Za-z0-9._/-]+)/i);
  if (modelMatch) {
    inferred.model = modelMatch[1];
  }
  const effortMatch = source.match(/\b(?:effort|reasoning(?: effort)?)\s*[:=]\s*(minimal|low|medium|high|xhigh)\b/i);
  if (effortMatch) {
    inferred.effort = effortMatch[1].toLowerCase();
  }
  const reviewerMatch = source.match(/\b(?:reviewer|approvalsReviewer|approvals reviewer)\s*[:=]\s*(auto[_-]?review|user)\b/i);
  if (reviewerMatch) {
    inferred.approvalsReviewer = reviewerMatch[1].replace('-', '_').toLowerCase();
  }
  return inferred;
}

function inferComposerOptionsFromSession(session) {
  if (!session) {
    return { ...DEFAULT_COMPOSER_OPTIONS };
  }
  const runtime = getRuntimeForSession(session) || session.runtime || {};
  const diagnostics = getDiagnosticsForSession(session);
  const latestTurnControl = [...diagnostics].reverse().find((entry) => (
    entry?.kind === 'control'
    && entry?.method === 'turn/start'
    && entry?.data
  ));
  const textInferred = inferComposerOptionsFromText([
    session.latestUserMessage,
    session.latestAgentMessage,
    ...(Array.isArray(session.transcriptPreview) ? session.transcriptPreview.map((entry) => entry.text) : []),
  ].filter(Boolean).join('\n'));
  return normalizeComposerOptionValues({
    ...textInferred,
    ...(session.codexOptions || {}),
    ...(latestTurnControl?.data || {}),
    model: runtime.model || latestTurnControl?.data?.model || session.codexOptions?.model || textInferred.model || '',
    effort: runtime.effort || latestTurnControl?.data?.effort || session.codexOptions?.effort || textInferred.effort || '',
    summary: runtime.summary || latestTurnControl?.data?.summary || session.codexOptions?.summary || '',
    approvalPolicy: runtime.approvalPolicy || latestTurnControl?.data?.approvalPolicy || session.codexOptions?.approvalPolicy || '',
    approvalsReviewer: runtime.approvalsReviewer || latestTurnControl?.data?.approvalsReviewer || session.codexOptions?.approvalsReviewer || textInferred.approvalsReviewer || '',
    sandboxMode: runtime.sandboxMode || session.codexOptions?.sandboxMode || '',
    personality: runtime.personality || session.codexOptions?.personality || '',
  });
}

function getComposerOptionsForSession(session) {
  const key = getSessionKey(session);
  if (!key) {
    return { ...DEFAULT_COMPOSER_OPTIONS };
  }
  if (!state.codexControls.sessionOptionsByKey.has(key)) {
    state.codexControls.sessionOptionsByKey.set(key, inferComposerOptionsFromSession(session));
  }
  return state.codexControls.sessionOptionsByKey.get(key);
}

function refreshInferredComposerOptionsForSession(session) {
  const key = getSessionKey(session);
  if (!key || state.codexControls.persistedSessionOptionKeys.has(key)) {
    return;
  }
  state.codexControls.sessionOptionsByKey.set(key, inferComposerOptionsFromSession(session));
}

function persistComposerSessionOptions() {
  const serialized = {};
  for (const [key, value] of state.codexControls.sessionOptionsByKey.entries()) {
    if (!state.codexControls.persistedSessionOptionKeys.has(key)) {
      continue;
    }
    serialized[key] = normalizeComposerOptionValues(value);
  }
  writeLocalStorageJson(COMPOSER_SESSION_OPTIONS_STORAGE_KEY, serialized);
}

function setSelectIfAvailable(id, value) {
  const node = el(id);
  if (!node) {
    return;
  }
  const stringValue = String(value || '');
  const hasValue = Array.from(node.options || []).some((option) => option.value === stringValue);
  node.value = hasValue ? stringValue : '';
}

function applyComposerOptionsToControls(session) {
  const options = getComposerOptionsForSession(session);
  const modelInput = el('codex-model-input');
  if (modelInput) {
    modelInput.value = options.model || '';
  }
  setSelectIfAvailable('codex-effort-select', options.effort);
  setSelectIfAvailable('codex-summary-select', options.summary);
  setSelectIfAvailable('codex-mode-select', options.mode);
  setSelectIfAvailable('codex-approval-policy-select', options.approvalPolicy);
  setSelectIfAvailable('codex-reviewer-select', options.approvalsReviewer);
  setSelectIfAvailable('codex-sandbox-mode-select', options.sandboxMode);
  setSelectIfAvailable('codex-personality-select', options.personality);
  syncModelSelectFromInput(session);
}

function saveComposerOptionsFromControls(session = getSelectedSession()) {
  const key = getSessionKey(session);
  if (!key) {
    return;
  }
  const next = normalizeComposerOptionValues({
    model: el('codex-model-input')?.value.trim() || '',
    effort: el('codex-effort-select')?.value || '',
    summary: el('codex-summary-select')?.value || '',
    mode: el('codex-mode-select')?.value || 'default',
    approvalPolicy: el('codex-approval-policy-select')?.value || 'on-request',
    approvalsReviewer: el('codex-reviewer-select')?.value || '',
    sandboxMode: el('codex-sandbox-mode-select')?.value || 'workspaceWrite',
    personality: el('codex-personality-select')?.value || '',
  });
  state.codexControls.sessionOptionsByKey.set(key, next);
  state.codexControls.persistedSessionOptionKeys.add(key);
  persistComposerSessionOptions();
}

function renderAttachmentChips() {
  const container = el('codex-attachment-chips');
  if (!container) {
    return;
  }

  container.innerHTML = '';
  for (const [index, attachment] of state.codexControls.attachments.entries()) {
    const chip = document.createElement('div');
    chip.className = `attachment-chip ${attachment.type === 'uploadFile' || attachment.type === 'textFile' ? 'file' : ''}`.trim();
    const label = attachment.remotePath
      ? 'Uploaded'
      : attachment.type === 'image'
        ? 'Image'
        : 'File';
    const note = attachment.remotePath ? ` -> ${attachment.remotePath}` : '';
    chip.innerHTML = `
      <span>${escapeHtml(label)}: ${escapeHtml(attachment.name || 'attached file')}${attachment.size ? ` (${escapeHtml(formatBytes(attachment.size))})` : ''}${escapeHtml(note)}</span>
      <button class="attachment-chip-remove" type="button" data-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name || 'attachment')}">x</button>
    `;
    container.appendChild(chip);
  }

  const localPath = el('codex-local-image-path')?.value.trim();
  if (localPath) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip muted';
    chip.innerHTML = `
      <span>Host image: ${escapeHtml(localPath)}</span>
      <button class="attachment-chip-remove" type="button" data-clear-local-image="true" aria-label="Remove host image path">x</button>
    `;
    container.appendChild(chip);
  }

  container.classList.toggle('hidden', container.childElementCount === 0);
}

function renderComposerControls(session, disabled) {
  refreshInferredComposerOptionsForSession(session);
  renderComposerModelOptions(session);
  applyComposerOptionsToControls(session);
  renderReasoningEffortOptions(session);
  applyComposerOptionsToControls(session);
  renderAttachmentChips();
  requestModelOptionsForSession(session);
  renderComposerTurnNotice();

  const controlIds = [
    'codex-model-input',
    'codex-model-select',
    'codex-effort-select',
    'codex-summary-select',
    'codex-mode-select',
    'codex-approval-policy-select',
    'codex-reviewer-select',
    'codex-sandbox-mode-select',
    'codex-personality-select',
    'codex-file-picker-button',
    'codex-image-files',
    'codex-local-image-path',
    'codex-clear-attachments-button',
    'codex-plan-button',
    'codex-send-button',
  ];
  for (const id of controlIds) {
    const node = el(id);
    if (node) {
      node.disabled = disabled;
    }
  }

  const modelButton = el('codex-model-refresh-button');
  if (modelButton) {
    const loadingModels = isModelOptionsLoading(session);
    modelButton.disabled = disabled || !session?.live || loadingModels;
    modelButton.textContent = loadingModels ? 'Loading...' : 'Refresh';
  }

  const reviewButton = el('codex-review-button');
  if (reviewButton) {
    reviewButton.disabled = disabled || !session?.live;
  }

  const runtime = getRuntimeForSession(session) || session?.runtime || {};
  const activeTurn = Boolean(session?.live && runtimeIsActive(runtime));
  const interruptButton = el('codex-interrupt-button');
  if (interruptButton) {
    interruptButton.classList.toggle('hidden', !activeTurn);
    interruptButton.disabled = disabled || !activeTurn;
  }
  const sendButton = el('codex-send-button');
  if (sendButton) {
    sendButton.textContent = activeTurn ? 'Queue' : 'Send';
  }
  maybeScheduleQueuedPromptSend(session);
}

function getSelectedSteerQueue() {
  const selectedKey = getSessionKey(getSelectedSession());
  if (!selectedKey) {
    return [];
  }
  return state.codexControls.steerQueue.filter((item) => item.sessionKey === selectedKey);
}

function findSteerQueueItem(itemId) {
  return state.codexControls.steerQueue.find((item) => item.id === itemId) || null;
}

function getSteerQueueText(item) {
  return String(item?.text || item?.payload?.text || item?.payload?.displayText || '');
}

function setSteerQueueItemText(item, text) {
  if (!item) {
    return;
  }
  const nextText = String(text || '');
  item.text = nextText;
  item.updatedAt = new Date().toISOString();
  item.payload = {
    ...(item.payload || {}),
    text: nextText,
    displayText: nextText,
  };
  if (item.payload.composerDraft) {
    item.payload.composerDraft = {
      ...item.payload.composerDraft,
      text: nextText,
    };
  }
}

function addSteerQueueItem(session, payload, steerText) {
  const text = String(steerText || '').trim();
  const item = {
    id: makeClientId(),
    sessionKey: getSessionKey(session),
    hostId: session.hostId,
    sessionId: session.sessionId,
    text,
    payload: {
      ...payload,
      text,
      displayText: text,
    },
    createdAt: new Date().toISOString(),
    sentAt: null,
    status: 'queued',
    sending: false,
    forceSending: false,
    error: '',
  };
  state.codexControls.steerQueue.push(item);
  return item;
}

function removeSteerQueueItem(itemId) {
  state.codexControls.steerQueue = state.codexControls.steerQueue.filter((item) => item.id !== itemId);
}

function clearSteerQueueForSession(session) {
  const key = getSessionKey(session);
  if (!key) {
    return;
  }
  state.codexControls.steerQueue = state.codexControls.steerQueue.filter((item) => item.sessionKey !== key);
}

function summarizeQueuedPayload(payload) {
  const pieces = [];
  const uploadedCount = Array.isArray(payload?.uploadedFiles) ? payload.uploadedFiles.length : 0;
  const itemCount = Array.isArray(payload?.inputItems) ? payload.inputItems.length : 0;
  if (uploadedCount) {
    pieces.push(`${uploadedCount} file${uploadedCount === 1 ? '' : 's'}`);
  }
  if (itemCount) {
    pieces.push(`${itemCount} input item${itemCount === 1 ? '' : 's'}`);
  }
  if (payload?.mode && payload.mode !== 'default') {
    pieces.push(payload.mode);
  }
  return pieces.join(' · ');
}

function getFirstQueuedPrompt(session = getSelectedSession()) {
  const sessionKey = getSessionKey(session);
  if (!sessionKey) {
    return null;
  }
  return state.codexControls.steerQueue.find((item) => (
    item.sessionKey === sessionKey
    && item.status === 'queued'
    && !item.sending
    && !item.forceSending
  )) || null;
}

function getQueueStatusLabel(item) {
  if (item.forceSending) {
    return 'interrupting';
  }
  if (item.sending) {
    return 'sending';
  }
  if (item.status === 'guided') {
    return 'guided';
  }
  if (item.status === 'failed') {
    return 'failed';
  }
  return 'waiting';
}

function renderComposerTurnNotice() {
  const notice = el('composer-turn-notice');
  if (!notice) {
    return;
  }
  const queue = getSelectedSteerQueue();
  const steerNotice = state.codexControls.steerNotice;
  const show = Boolean(queue.length || steerNotice);
  notice.classList.toggle('hidden', !show);
  if (!show) {
    return;
  }

  const title = el('composer-turn-notice-title');
  const copy = el('composer-turn-notice-copy');
  const forceButton = el('composer-force-send-button');
  const list = el('composer-steer-queue-list');
  if (queue.length) {
    const waitingCount = queue.filter((item) => item.status === 'queued').length;
    title.textContent = `Pending queue (${queue.length})`;
    copy.textContent = waitingCount
      ? 'These prompts are waiting in order. Edit or remove them, guide one into the current turn, or interrupt and send one immediately.'
      : 'These prompts were guided into the current turn. They stay visible so you can edit, remove, or force-send a fresh turn if needed.';
    forceButton.classList.remove('hidden');
    forceButton.disabled = queue.some((item) => item.forceSending);
    forceButton.textContent = 'Interrupt & Send First';
  } else {
    title.textContent = steerNotice?.title || 'Active turn updated';
    copy.textContent = steerNotice?.message || 'Your message was added to the current Codex turn.';
    forceButton.classList.add('hidden');
    forceButton.disabled = true;
  }

  if (!list) {
    return;
  }
  list.innerHTML = '';
  list.classList.toggle('hidden', !queue.length);
  for (const [index, item] of queue.entries()) {
    const card = document.createElement('div');
    card.className = 'steer-queue-item';

    const header = document.createElement('div');
    header.className = 'steer-queue-item-header';

    const label = document.createElement('div');
    label.className = 'steer-queue-item-label';
    label.textContent = `#${index + 1} · ${getQueueStatusLabel(item)}`;
    header.appendChild(label);

    const meta = summarizeQueuedPayload(item.payload);
    if (meta) {
      const metaNode = document.createElement('div');
      metaNode.className = 'steer-queue-item-meta';
      metaNode.textContent = meta;
      header.appendChild(metaNode);
    }
    card.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'steer-queue-text';
    textarea.dataset.steerQueueText = item.id;
    textarea.rows = 3;
    textarea.value = getSteerQueueText(item);
    textarea.placeholder = 'Edit this waiting prompt before it is sent or guided...';
    card.appendChild(textarea);

    if (item.error) {
      const error = document.createElement('div');
      error.className = 'steer-queue-error';
      error.textContent = item.error;
      card.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'steer-queue-actions';

    const force = document.createElement('button');
    force.type = 'button';
    force.className = 'secondary-button';
    force.dataset.forceSteerQueueId = item.id;
    force.disabled = item.forceSending || item.sending;
    force.textContent = item.forceSending ? 'Interrupting...' : 'Interrupt & Send';
    actions.appendChild(force);

    const guide = document.createElement('button');
    guide.type = 'button';
    guide.className = 'secondary-button';
    guide.dataset.guideSteerQueueId = item.id;
    guide.disabled = item.forceSending || item.sending || item.status === 'guided' || !runtimeIsActive(getRuntimeForSession(getSelectedSession()) || getSelectedSession()?.runtime || {});
    guide.textContent = item.status === 'guided' ? 'Guided' : 'Guide';
    actions.appendChild(guide);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary-button';
    remove.dataset.removeSteerQueueId = item.id;
    remove.disabled = item.forceSending || item.sending;
    remove.textContent = 'Remove';
    actions.appendChild(remove);

    card.appendChild(actions);
    list.appendChild(card);
  }
}

function getComposerInputItems(uploadedFiles = []) {
  const inputItems = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'image')
    .map((attachment) => ({
      type: 'image',
      url: attachment.url,
      name: attachment.name || 'image',
    }));
  for (const file of uploadedFiles.filter(isImageFileRef)) {
    if (!file.path) {
      continue;
    }
    inputItems.push({
      type: 'localImage',
      path: file.path,
      name: file.name || basename(file.path),
    });
  }
  const localImagePath = el('codex-local-image-path')?.value.trim();
  if (localImagePath) {
    inputItems.push({
      type: 'localImage',
      path: localImagePath,
      name: basename(localImagePath),
    });
  }
  return inputItems;
}

function getComposerTextFileSections() {
  return state.codexControls.attachments
    .filter((attachment) => attachment.type === 'textFile')
    .map((attachment) => [
      `Attached file: ${attachment.name || 'untitled'}`,
      '```text',
      String(attachment.text || '').replace(/```/g, '` ` `'),
      '```',
    ].join('\n'));
}

function getComposerUploadedFileSections(uploadedFiles = []) {
  if (!uploadedFiles.length) {
    return [];
  }
  return [
    [
      'Files uploaded to the selected host:',
      ...uploadedFiles.map((file) => `- ${file.name || basename(file.path)}: ${file.path}${file.size ? ` (${formatBytes(file.size)})` : ''}`),
      '',
      'Use these remote host paths directly. For images, inspect the attached localImage items; for other files, open/read the paths as needed.',
    ].join('\n'),
  ];
}

function getComposerOptions() {
  return {
    model: el('codex-model-input')?.value.trim() || null,
    effort: el('codex-effort-select')?.value || null,
    summary: el('codex-summary-select')?.value || null,
    mode: el('codex-mode-select')?.value || 'default',
    approvalPolicy: el('codex-approval-policy-select')?.value || 'on-request',
    approvalsReviewer: el('codex-reviewer-select')?.value || 'auto_review',
    sandboxMode: el('codex-sandbox-mode-select')?.value || 'workspaceWrite',
    personality: el('codex-personality-select')?.value || null,
  };
}

function cloneComposerAttachment(attachment) {
  return {
    ...attachment,
  };
}

function snapshotComposerDraft(rawText) {
  return {
    text: String(rawText || ''),
    attachments: state.codexControls.attachments.map(cloneComposerAttachment),
    localImagePath: el('codex-local-image-path')?.value || '',
    createdAt: new Date().toISOString(),
  };
}

function setActiveDraftForSession(session, payload) {
  const key = getSessionKey(session);
  const draft = payload?.composerDraft;
  if (!key || !draft) {
    return;
  }
  state.codexControls.activeDraftsBySession.set(key, {
    ...draft,
    text: String(draft.text || payload.displayText || payload.text || ''),
  });
}

function clearActiveDraftForSession(session) {
  const key = getSessionKey(session);
  if (key) {
    state.codexControls.activeDraftsBySession.delete(key);
  }
}

function restoreComposerDraft(draft, options = {}) {
  if (!draft) {
    return false;
  }
  const input = el('input-text');
  if (input) {
    const draftText = String(options.textOverride ?? draft.text ?? '');
    if (options.replace || !input.value.trim()) {
      input.value = draftText;
    } else if (draftText) {
      input.value = `${input.value.trimEnd()}\n\n${draftText}`;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const nextAttachments = Array.isArray(draft.attachments)
    ? draft.attachments.map(cloneComposerAttachment)
    : [];
  if (nextAttachments.length) {
    const existingKeys = new Set(state.codexControls.attachments.map((attachment) => (
      attachment.fileId || `${attachment.type}|${attachment.name}|${attachment.size}|${attachment.remotePath || ''}`
    )));
    for (const attachment of nextAttachments) {
      const key = attachment.fileId || `${attachment.type}|${attachment.name}|${attachment.size}|${attachment.remotePath || ''}`;
      if (!existingKeys.has(key)) {
        state.codexControls.attachments.push(attachment);
        existingKeys.add(key);
      }
    }
  }

  const localImageInput = el('codex-local-image-path');
  if (localImageInput && draft.localImagePath && !localImageInput.value.trim()) {
    localImageInput.value = draft.localImagePath;
    localImageInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  renderAttachmentChips();
  return true;
}

function restoreActiveDraftForSession(session) {
  const key = getSessionKey(session);
  if (!key) {
    return false;
  }
  const draft = state.codexControls.activeDraftsBySession.get(key);
  if (!restoreComposerDraft(draft, { replace: false })) {
    return false;
  }
  state.codexControls.activeDraftsBySession.delete(key);
  return true;
}

function buildPlanPrompt(text, hasAttachments) {
  const request = text || (hasAttachments ? 'Please inspect the attached image(s) and propose a safe next-step plan.' : '');
  return [
    'Plan mode: do not modify files, do not run destructive commands, and do not make irreversible changes.',
    'Analyze the request, list the concrete steps you would take, and call out risks or decisions that need confirmation.',
    '',
    'User request:',
    request,
  ].join('\n').trim();
}

const SLASH_COMMANDS = [
  {
    id: 'plan',
    command: '/plan',
    title: 'Plan Mode',
    category: 'Codex',
    description: 'Turn on plan-only mode for the next message.',
    keywords: ['计划', 'plan mode'],
    run: async () => {
      setSelectValue('codex-mode-select', 'plan');
      focusComposerInput();
    },
  },
  {
    id: 'review',
    command: '/review',
    title: 'Code Review',
    category: 'Codex',
    description: 'Start a Codex review for current workspace changes.',
    keywords: ['代码审查', '审查'],
    run: startReviewForCurrentSession,
  },
  {
    id: 'compact',
    command: '/compact',
    title: 'Compact Context',
    category: 'Codex',
    description: 'Compact the current live Codex thread context.',
    keywords: ['压缩', '上下文'],
    run: compactCurrentThread,
  },
  {
    id: 'status',
    command: '/status',
    title: 'Status',
    category: 'Runtime',
    description: 'Open session status, requests, diagnostics, and usage.',
    keywords: ['状态', 'quota', 'diagnostics'],
    run: async () => setStatusWindowOpen(true),
  },
  {
    id: 'model-gpt-55',
    command: '/gpt-5.5',
    title: 'Model: GPT-5.5',
    category: 'Model',
    description: 'Use GPT-5.5 for the next turn.',
    keywords: ['模型', 'model', 'gpt'],
    run: async () => {
      setInputValue('codex-model-input', 'gpt-5.5');
      focusComposerInput();
    },
  },
  {
    id: 'models',
    command: '/models',
    title: 'Open Model List',
    category: 'Model',
    description: 'Load available model IDs from the selected live session.',
    keywords: ['model list', '模型列表'],
    run: async () => {
      await loadModelOptionsForSelectedSession();
      el('codex-model-select')?.focus();
    },
  },
  {
    id: 'reasoning-xhigh',
    command: '/reasoning',
    title: 'Reasoning: XHigh',
    category: 'Model',
    description: 'Set reasoning effort to xhigh for the next turn.',
    keywords: ['推理', '超高', 'think', 'ultrathink'],
    run: async () => {
      setSelectValue('codex-effort-select', 'xhigh');
      focusComposerInput();
    },
  },
  {
    id: 'personality-friendly',
    command: '/personality',
    title: 'Personality: Friendly',
    category: 'Model',
    description: 'Set Codex personality to friendly for the next turn.',
    keywords: ['个性', 'friendly'],
    run: async () => {
      setSelectValue('codex-personality-select', 'friendly');
      focusComposerInput();
    },
  },
  {
    id: 'personality-pragmatic',
    command: '/pragmatic',
    title: 'Personality: Pragmatic',
    category: 'Model',
    description: 'Set Codex personality to pragmatic for the next turn.',
    keywords: ['个性', 'pragmatic'],
    run: async () => {
      setSelectValue('codex-personality-select', 'pragmatic');
      focusComposerInput();
    },
  },
  {
    id: 'fork',
    command: '/fork',
    title: 'Fork New Branch',
    category: 'Session',
    description: 'Create a new live branch from the selected conversation.',
    keywords: ['派生', 'branch'],
    run: forkNewBranch,
  },
  {
    id: 'upload',
    command: '/upload',
    title: 'Upload File',
    category: 'Files',
    description: 'Open file picker and upload files to the selected host on send.',
    keywords: ['file', 'image', '图片', '文件'],
    run: async () => el('codex-image-files')?.click(),
  },
  {
    id: 'clear-files',
    command: '/clear-files',
    title: 'Clear Files',
    category: 'Files',
    description: 'Remove queued file and image attachments from composer.',
    keywords: ['clear attachments', '清除'],
    run: async () => {
      clearComposerFileAttachments();
      focusComposerInput();
    },
  },
  {
    id: 'shell',
    command: '/shell',
    title: 'Shell Command',
    category: 'Runtime',
    description: 'Open status panel and focus the shell-command control.',
    keywords: ['terminal', '命令', 'shell command'],
    run: async () => {
      setStatusWindowOpen(true);
      window.setTimeout(() => el('shell-command-input')?.focus(), 0);
    },
  },
  {
    id: 'mcp',
    command: '/mcp',
    title: 'MCP Status',
    category: 'Bridge',
    description: 'Ask Codex to inspect MCP status if that host supports MCP.',
    keywords: ['mcp', '服务器状态'],
    insert: 'Please show MCP server status for this Codex environment. If MCP is not available through this relay yet, explain what is missing and how to verify it on the host.',
  },
  {
    id: 'ide-context',
    command: '/ide-context',
    title: 'IDE Context',
    category: 'Bridge',
    description: 'Record that IDE context is not currently tunneled by this relay.',
    keywords: ['ide', '上下文', 'close ide context'],
    insert: 'IDE context is not currently tunneled through this mobile relay. Please rely on the selected workspace files and paths on this host instead.',
  },
  {
    id: 'feedback',
    command: '/feedback',
    title: 'Feedback',
    category: 'Meta',
    description: 'Insert a feedback note template for this remote-control app.',
    keywords: ['反馈'],
    insert: 'Feedback for Mobile Codex Remote:\n- What felt good:\n- What broke or felt confusing:\n- What should be improved next:',
  },
  {
    id: 'memory',
    command: '/memory',
    title: 'Memory',
    category: 'Meta',
    description: 'Ask Codex to draft durable project memory or next-run notes.',
    keywords: ['记忆', 'memory.md'],
    insert: 'Please generate durable project memory for future sessions: summarize stable facts, host setup notes, commands, gotchas, and next steps. If a MEMORY.md or project notes file exists, propose a safe update before editing.',
  },
  {
    id: 'skill-imagegen',
    command: '/imagegen',
    title: 'Skill: Image Gen',
    category: 'Skills',
    description: 'Ask Codex to use Image Gen when available.',
    keywords: ['skill', '图片生成', 'image gen'],
    insert: 'Use the Image Gen skill if it is available in this Codex environment. Generate or edit the requested image, then save the output file in the current workspace and reply with its full path.',
  },
  {
    id: 'skill-openai-docs',
    command: '/openai-docs',
    title: 'Skill: OpenAI Docs',
    category: 'Skills',
    description: 'Use official OpenAI docs when available.',
    keywords: ['skill', 'openai docs', '文档'],
    insert: 'Use the OpenAI Docs skill if it is available. Check official OpenAI documentation before answering, and cite the specific docs used.',
  },
  {
    id: 'skill-plugin-creator',
    command: '/plugin-creator',
    title: 'Skill: Plugin Creator',
    category: 'Skills',
    description: 'Scaffold or update a Codex plugin.',
    keywords: ['skill', 'plugin'],
    insert: 'Use the Plugin Creator skill if it is available. Scaffold or update the requested Codex plugin and list the files changed.',
  },
  {
    id: 'skill-creator',
    command: '/skill-creator',
    title: 'Skill: Skill Creator',
    category: 'Skills',
    description: 'Create or update a Codex skill.',
    keywords: ['skill', '创建 skill'],
    insert: 'Use the Skill Creator skill if it is available. Create or update the requested skill and explain how to test it.',
  },
  {
    id: 'skill-installer',
    command: '/skill-installer',
    title: 'Skill: Skill Installer',
    category: 'Skills',
    description: 'Install curated or repo-hosted Codex skills.',
    keywords: ['skill', 'install', '安装'],
    insert: 'Use the Skill Installer skill if it is available. Install the requested skill source and summarize where it was installed.',
  },
];

function setInputValue(id, value) {
  const node = el(id);
  if (!node) {
    return;
  }
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(id, value) {
  const node = el(id);
  if (!node) {
    return;
  }
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function focusComposerInput() {
  const input = el('input-text');
  if (input) {
    input.focus();
  }
}

function getSlashTokenMatch(input = el('input-text')) {
  if (!input) {
    return null;
  }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = before.match(/(^|[\s\n])\/([\w.-]*)$/);
  if (!match) {
    return null;
  }
  return {
    start: before.length - match[0].length + match[1].length,
    end: caret,
    query: match[2] || '',
  };
}

function getFilteredSlashCommands() {
  const query = String(state.slashMenu.query || '').trim().toLowerCase();
  if (!query) {
    return SLASH_COMMANDS;
  }
  const terms = query.split(/\s+/).filter(Boolean);
  return SLASH_COMMANDS.filter((command) => {
    const haystack = [
      command.command,
      command.title,
      command.category,
      command.description,
      ...(command.keywords || []),
    ].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function hideSlashMenu() {
  state.slashMenu.open = false;
  state.slashMenu.query = '';
  state.slashMenu.selectedIndex = 0;
  renderSlashMenu();
}

function updateSlashMenuFromInput() {
  const input = el('input-text');
  const match = getSlashTokenMatch(input);
  if (!match || input?.disabled || el('input-form')?.classList.contains('disabled')) {
    if (state.slashMenu.open) {
      hideSlashMenu();
    }
    return;
  }

  state.slashMenu.open = true;
  state.slashMenu.query = match.query;
  const commands = getFilteredSlashCommands();
  state.slashMenu.selectedIndex = Math.min(state.slashMenu.selectedIndex, Math.max(0, commands.length - 1));
  renderSlashMenu();
}

function replaceSlashToken(replacement = '') {
  const input = el('input-text');
  const match = getSlashTokenMatch(input);
  if (!input || !match) {
    return;
  }

  const before = input.value.slice(0, match.start);
  const after = input.value.slice(match.end);
  const spacer = replacement && before && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${spacer}${replacement}${replacement && after && !/^\s/.test(after) ? ' ' : ''}${after}`;
  const caret = (before + spacer + replacement).length;
  input.value = next;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function executeSlashCommand(command) {
  if (!command) {
    return;
  }

  if (command.insert) {
    replaceSlashToken(command.insert);
    hideSlashMenu();
    focusComposerInput();
    return;
  }

  replaceSlashToken('');
  hideSlashMenu();
  await command.run();
}

function renderSlashMenu() {
  const menu = el('slash-command-menu');
  if (!menu) {
    return;
  }
  if (!state.slashMenu.open) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
    return;
  }

  const commands = getFilteredSlashCommands();
  menu.classList.remove('hidden');
  menu.innerHTML = '';

  if (!commands.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-command-empty';
    empty.textContent = 'No slash commands match this search.';
    menu.appendChild(empty);
    return;
  }

  commands.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `slash-command-item ${index === state.slashMenu.selectedIndex ? 'active' : ''}`.trim();
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.slashMenu.selectedIndex ? 'true' : 'false');
    button.innerHTML = `
      <div class="slash-command-icon">${escapeHtml(command.command)}</div>
      <div class="slash-command-copy">
        <div class="slash-command-title-row">
          <span class="slash-command-title">${escapeHtml(command.title)}</span>
          <span class="slash-command-category">${escapeHtml(command.category)}</span>
        </div>
        <div class="slash-command-description">${escapeHtml(command.description)}</div>
      </div>
    `;
    button.onmouseenter = () => {
      state.slashMenu.selectedIndex = index;
      renderSlashMenu();
    };
    button.onmousedown = (event) => {
      event.preventDefault();
    };
    button.onclick = async () => {
      try {
        await executeSlashCommand(command);
      } catch (error) {
        reportError(error);
      }
    };
    menu.appendChild(button);
  });
}

async function uploadComposerFiles(session) {
  const uploadAttachments = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'uploadFile');
  if (!uploadAttachments.length) {
    return [];
  }
  if (!session?.hostId) {
    throw new Error('Select a host session before uploading files.');
  }

  await verifyHostAvailable(session.hostId);
  const host = getHost(session.hostId);
  if (!host?.capabilities?.fileTransfer) {
    throw new Error(`${formatHostCapabilityName(host)} has not enabled file transfer yet. Restart the relay and this host-agent, then refresh the page. For HPC hosts, use Manage HPC -> Restart Agent.`);
  }

  const reusable = [];
  const pending = [];
  for (const attachment of uploadAttachments) {
    if (
      attachment.remotePath
      && attachment.uploadHostId === session.hostId
      && attachment.uploadCwd === session.cwd
    ) {
      reusable.push({
        fileId: attachment.fileId || attachment.name,
        name: attachment.remoteName || attachment.name,
        path: attachment.remotePath,
        size: attachment.size || 0,
        mime: attachment.mime || '',
        isImage: isImageFileRef(attachment),
      });
      continue;
    }
    pending.push(attachment);
  }

  let uploaded = [];
  if (pending.length) {
    let response = null;
    try {
      response = await fetchJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/upload`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.sessionId,
          targetDirectory: session.cwd || '',
          files: pending.map((attachment) => ({
            fileId: attachment.fileId,
            name: attachment.name,
            mime: attachment.mime || 'application/octet-stream',
            size: attachment.size || 0,
            dataBase64: attachment.dataBase64,
          })),
        }),
      });
    } catch (error) {
      if (error.status === 404 && /\/files\/upload/.test(String(error.url || ''))) {
        throw new Error('The running relay does not have the file upload API yet. Restart the relay/server process, restart the selected host-agent, then refresh the browser.');
      }
      throw error;
    }
    uploaded = normalizeTranscriptFiles(response.files || []);
    for (const [index, file] of uploaded.entries()) {
      const attachment = pending[index];
      if (!attachment) {
        continue;
      }
      attachment.remotePath = file.path;
      attachment.remoteName = file.name;
      attachment.uploadHostId = session.hostId;
      attachment.uploadCwd = session.cwd;
      attachment.mime = file.mime || attachment.mime;
      attachment.size = file.size || attachment.size;
    }
    renderAttachmentChips();
  }

  return [...reusable, ...uploaded];
}

async function buildComposerPayload(rawText, overrides = {}) {
  const session = getSelectedSession();
  const composerDraft = snapshotComposerDraft(rawText);
  const uploadedFiles = await uploadComposerFiles(session);
  const inputItems = getComposerInputItems(uploadedFiles);
  const textFileSections = getComposerTextFileSections();
  const uploadedFileSections = getComposerUploadedFileSections(uploadedFiles);
  const options = {
    ...getComposerOptions(),
    ...overrides,
  };
  const userVisibleText = String(rawText || '').trim();
  let text = userVisibleText;
  const hasOriginalContent = Boolean(text || inputItems.length || textFileSections.length || uploadedFileSections.length);
  if (uploadedFileSections.length || textFileSections.length) {
    text = [
      text,
      ...uploadedFileSections,
      textFileSections.length ? 'Attached text file contents:' : '',
      ...textFileSections,
    ].filter(Boolean).join('\n\n');
  }
  if (!text && inputItems.length) {
    text = 'Please inspect the attached image(s).';
  }
  if (options.mode === 'plan' && hasOriginalContent) {
    text = buildPlanPrompt(text, inputItems.length > 0);
    options.approvalPolicy = 'never';
    options.sandboxMode = 'readOnly';
  }

  return {
    ...options,
    text,
    displayText: userVisibleText || (hasOriginalContent ? 'Please inspect the attached file(s).' : ''),
    inputItems,
    uploadedFiles,
    composerDraft,
  };
}

function clearComposerFileAttachments() {
  state.codexControls.attachments = [];
  const fileInput = el('codex-image-files');
  if (fileInput) {
    fileInput.value = '';
  }
  renderAttachmentChips();
}

function removeComposerAttachment(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.codexControls.attachments.length) {
    return;
  }
  state.codexControls.attachments.splice(index, 1);
  const fileInput = el('codex-image-files');
  if (fileInput && !state.codexControls.attachments.length) {
    fileInput.value = '';
  }
  renderAttachmentChips();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('failed to read text file'));
    reader.readAsText(file);
  });
}

function dataUrlToBase64(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  return comma === -1 ? text : text.slice(comma + 1);
}

async function addComposerImageFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
  if (!incoming.length) {
    return;
  }
  const existingImages = state.codexControls.attachments.filter((attachment) => attachment.type === 'image').length;
  const available = Math.max(0, MAX_COMPOSER_IMAGES - existingImages);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_IMAGES} images at once.`);
  }

  const selected = incoming.slice(0, available);
  for (const file of selected) {
    if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
      throw new Error(`${file.name} is too large for inline upload; limit is ${formatBytes(MAX_COMPOSER_IMAGE_BYTES)} per image.`);
    }
    const url = await readFileAsDataUrl(file);
    state.codexControls.attachments.push({
      type: 'image',
      url,
      name: file.name,
      size: file.size,
    });
  }
  renderAttachmentChips();
}

async function addComposerTextFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file && isTextLikeFile(file));
  if (!incoming.length) {
    return;
  }
  const existingTextFiles = state.codexControls.attachments.filter((attachment) => attachment.type === 'textFile').length;
  const available = Math.max(0, MAX_COMPOSER_TEXT_FILES - existingTextFiles);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_TEXT_FILES} text files at once.`);
  }

  const selected = incoming.slice(0, available);
  for (const file of selected) {
    if (file.size > MAX_COMPOSER_TEXT_FILE_BYTES) {
      throw new Error(`${file.name} is too large for inline text upload; limit is ${formatBytes(MAX_COMPOSER_TEXT_FILE_BYTES)} per file.`);
    }
    const text = await readFileAsText(file);
    state.codexControls.attachments.push({
      type: 'textFile',
      text,
      name: file.name,
      size: file.size,
    });
  }
  renderAttachmentChips();
}

async function addComposerFiles(files) {
  const allFiles = Array.from(files || []).filter(Boolean);
  if (!allFiles.length) {
    return;
  }

  const existingUploads = state.codexControls.attachments.filter((attachment) => attachment.type === 'uploadFile').length;
  const available = Math.max(0, MAX_COMPOSER_UPLOAD_FILES - existingUploads);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_UPLOAD_FILES} files at once.`);
  }
  const selected = allFiles.slice(0, available);
  const totalBytes = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'uploadFile')
    .reduce((sum, attachment) => sum + (Number(attachment.size || 0) || 0), 0)
    + selected.reduce((sum, file) => sum + (Number(file.size || 0) || 0), 0);
  if (totalBytes > MAX_COMPOSER_UPLOAD_TOTAL_BYTES) {
    throw new Error(`Attached files are too large; total limit is ${formatBytes(MAX_COMPOSER_UPLOAD_TOTAL_BYTES)}.`);
  }

  for (const file of selected) {
    if (file.size > MAX_COMPOSER_UPLOAD_FILE_BYTES) {
      throw new Error(`${file.name} is too large for remote upload; limit is ${formatBytes(MAX_COMPOSER_UPLOAD_FILE_BYTES)} per file.`);
    }
    const dataUrl = await readFileAsDataUrl(file);
    state.codexControls.attachments.push({
      type: 'uploadFile',
      fileId: makeClientId(),
      dataBase64: dataUrlToBase64(dataUrl),
      name: file.name || 'upload',
      mime: file.type || 'application/octet-stream',
      size: file.size,
    });
  }
  renderAttachmentChips();
}

function isFileDragEvent(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setComposerDragActive(active) {
  const composer = el('input-form');
  if (composer) {
    composer.classList.toggle('drag-active', Boolean(active));
  }
}

async function handleComposerDrop(event) {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setComposerDragActive(false);

  const composer = el('input-form');
  if (composer?.classList.contains('disabled')) {
    reportError(new Error('Select or start a live session before attaching files.'));
    return;
  }

  try {
    await addComposerFiles(event.dataTransfer?.files);
  } catch (error) {
    reportError(error);
  }
}

function renderSessionDetails() {
  const session = getSelectedSession();
  if (!session && state.sessionDetailsOpen) {
    state.sessionDetailsOpen = false;
  }
  const conversation = getSelectedConversation();
  const joinButton = el('join-session-button');
  const resumeButton = el('resume-session-button');
  const forkButton = el('fork-session-button');
  const alertsButton = el('toggle-alerts-button');
  const statusButton = el('toggle-status-button');
  const endSessionButton = el('end-session-button');
  const composer = el('input-form');
  const input = el('input-text');
  const runner = getRunnerSummary(session);
  const warningCard = el('session-warning-card');
  const warningText = el('session-warning');
  const alerts = getAlertsForSession(session);
  const pendingRequests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const runtime = getRuntimeForSession(session);
  const summaryTitle = el('session-detail-summary-title');
  const summaryPath = el('session-detail-summary-path');
  const summaryStatus = el('session-detail-summary-status');
  const modalTitle = el('session-detail-modal-title');
  const modalSubtitle = el('session-detail-modal-subtitle');
  const detailsButton = el('session-details-button');
  const overlay = el('session-details-overlay');
  const modal = el('session-details-modal');
  const apiSummary = getSessionApiProfileSummary(session);

  if (overlay && modal) {
    overlay.classList.toggle('hidden', !state.sessionDetailsOpen);
    modal.classList.toggle('hidden', !state.sessionDetailsOpen);
    syncModalBodyState();
  }

  el('session-title').textContent = session ? session.title || session.sessionId : 'No session selected';
  const headerMeta = el('session-meta');
  if (headerMeta) {
    if (session) {
      const metaLine = [
        session.hostId,
        `${conversation?.totalCount || 1} variants`,
        session.state || 'unknown',
        apiSummary.label,
      ].filter(Boolean).join(' | ');
      headerMeta.innerHTML = [
        escapeHtml(metaLine),
        session.cwd ? `<span class="session-meta-path">${escapeHtml(session.cwd)}</span>` : '',
      ].filter(Boolean).join('<br>');
      headerMeta.title = [metaLine, session.cwd || ''].filter(Boolean).join('\n');
    } else {
      headerMeta.textContent = '';
      headerMeta.title = '';
    }
  }
  el('session-path').textContent = session?.cwd || '(unknown path)';
  el('session-status').textContent = session
    ? `${session.live ? 'Live' : 'History only'} | ${session.state || 'unknown'}`
    : 'No session selected';
  el('session-runner').textContent = runner.label;
  el('latest-user-message').textContent = session?.latestUserMessage || 'No recent user prompt captured.';
  el('latest-agent-message').textContent = getLatestFormalAgentMessage(session);
  if (summaryTitle) {
    summaryTitle.textContent = session ? session.title || session.sessionId : 'No session selected';
  }
  if (summaryPath) {
    summaryPath.textContent = session?.cwd || 'Select a conversation to inspect path, status, messages, and variants.';
  }
  if (summaryStatus) {
    summaryStatus.textContent = session
      ? `${session.live ? 'Live' : 'History only'} | ${session.state || 'unknown'} | ${apiSummary.label}`
      : 'No session';
    summaryStatus.title = session ? apiSummary.title : '';
    summaryStatus.className = `runtime-chip ${session?.live ? 'active' : session ? 'info' : 'warning'}`;
  }
  if (modalTitle) {
    modalTitle.textContent = session ? session.title || session.sessionId : 'No session selected';
  }
  if (modalSubtitle) {
    modalSubtitle.textContent = session
      ? `${session.hostId} | ${conversation?.totalCount || 1} variants | ${apiSummary.label} | ${session.cwd || '(unknown path)'}`
      : 'Path, runner, latest messages, and variants.';
    modalSubtitle.title = session ? apiSummary.title : '';
  }
  if (detailsButton) {
    detailsButton.disabled = !session;
    detailsButton.classList.add('hidden');
  }
  if (runner.warning) {
    warningText.textContent = runner.warning;
    warningCard.classList.remove('hidden');
  } else {
    warningText.textContent = 'No warning.';
    warningCard.classList.add('hidden');
  }
  alertsButton.disabled = !session;
  alertsButton.textContent = alerts.length ? `Alerts (${alerts.length})` : 'Alerts';
  statusButton.disabled = !session;
  statusButton.textContent = pendingRequests.length
    ? `Status (${pendingRequests.length})`
    : runtime?.phase
      ? `Status: ${prettyStatusLabel(runtime.phase)}`
      : 'Status';
  if (endSessionButton) {
    endSessionButton.hidden = true;
    endSessionButton.disabled = true;
    endSessionButton.textContent = runtime?.phase === 'ending' || runtime?.connection === 'closing'
      ? 'Ending Session...'
      : 'End Session';
  }

  renderVariantButtons(el('session-variants'), conversation, state.selectedSessionId);

  const liveSession = getLiveSessionForConversation(conversation);
  const canActivateHistory = Boolean(session && !session.live && session.cwd);
  const canFork = Boolean(session && session.cwd);
  if (!session) {
    joinButton.disabled = true;
    joinButton.textContent = 'Join Running Session';
    resumeButton.disabled = true;
    resumeButton.textContent = 'Resume From History';
    resumeButton.classList.remove('danger-button');
    resumeButton.classList.add('secondary-button');
    forkButton.disabled = true;
    forkButton.textContent = 'Fork New Branch';
  } else {
    if (!liveSession) {
      joinButton.disabled = true;
      joinButton.textContent = 'No Running Session';
    } else if (session.live && liveSession.sessionId === session.sessionId) {
      joinButton.disabled = true;
      joinButton.textContent = 'Already Joined';
    } else {
      joinButton.disabled = false;
      joinButton.textContent = 'Join Running Session';
    }

    const isEnding = runtime?.phase === 'ending' || runtime?.connection === 'closing';
    resumeButton.classList.toggle('danger-button', Boolean(session.live));
    resumeButton.classList.toggle('secondary-button', !session.live);
    if (session.live) {
      resumeButton.disabled = isEnding;
      resumeButton.textContent = isEnding ? 'Stopping Session...' : 'Stop Session';
    } else {
      resumeButton.disabled = !canActivateHistory;
      if (canActivateHistory && liveSession) {
        resumeButton.textContent = 'Resume History Again';
      } else if (canActivateHistory) {
        resumeButton.textContent = 'Resume From History';
      } else {
        resumeButton.textContent = 'Cannot Resume';
      }
    }

    forkButton.disabled = !canFork;
    forkButton.textContent = session.live ? 'Fork Running Session' : 'Fork New Branch';
  }

  const composerDisabled = !session || (!session.live && !canActivateHistory);
  composer.classList.toggle('disabled', composerDisabled);
  input.disabled = composerDisabled;
  renderComposerControls(session, composerDisabled);
  if (session?.live) {
    input.placeholder = 'Send a follow-up prompt to the live managed session...';
  } else if (canActivateHistory) {
    input.placeholder = liveSession
      ? 'Type here to resume this history point into a new live branch...'
      : 'Type here to resume this history session as live...';
  } else {
    input.placeholder = 'Join or start a live session first...';
  }

  renderApprovalPopup();
  renderStatusWindow();
  renderLocaleLabels();
}

function createRuntimeChip(container, label, value, tone = 'info') {
  const chip = document.createElement('div');
  chip.className = `runtime-chip ${tone}`.trim();
  chip.innerHTML = `<strong>${label}</strong>${value}`;
  container.appendChild(chip);
}

function renderRuntimePanel() {
  const session = getSelectedSession();
  const runtime = getRuntimeForSession(session) || {};
  const stream = getStreamStatusForSession(session) || {};
  const requests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const titleEl = el('runtime-panel-title');
  const subtitleEl = el('runtime-panel-subtitle');
  const detailTitleEl = el('runtime-detail-title');
  const detailSubtitleEl = el('runtime-detail-subtitle');
  const chipRow = el('runtime-chip-row');
  const detailChipRow = el('runtime-detail-chip-row');
  const detailsButton = el('session-details-button');
  const statusButton = el('runtime-modal-open-status-button');
  const steerInput = el('inline-steer-input');
  const steerSubmit = el('inline-steer-submit-button');
  const shellInput = el('inline-shell-command-input');
  const shellSubmit = el('inline-shell-command-submit-button');

  if (chipRow) {
    chipRow.innerHTML = '';
  }
  if (detailChipRow) {
    detailChipRow.innerHTML = '';
  }

  const appendRuntimeChip = (label, value, tone = 'info') => {
    if (chipRow) {
      createRuntimeChip(chipRow, label, value, tone);
    }
    if (detailChipRow) {
      createRuntimeChip(detailChipRow, label, value, tone);
    }
  };

  if (!session) {
    titleEl.textContent = 'No live session attached';
    subtitleEl.textContent = 'Select or start a managed session to see live status, timers, and commands.';
    if (detailTitleEl) {
      detailTitleEl.textContent = titleEl.textContent;
    }
    if (detailSubtitleEl) {
      detailSubtitleEl.textContent = subtitleEl.textContent;
    }
    if (detailsButton) {
      detailsButton.disabled = true;
    }
    if (statusButton) {
      statusButton.disabled = true;
    }
    if (steerInput) {
      steerInput.disabled = true;
      steerInput.placeholder = 'No active turn to steer';
    }
    if (steerSubmit) {
      steerSubmit.disabled = true;
    }
    if (shellInput) {
      shellInput.disabled = true;
      shellInput.placeholder = 'No live Codex thread is attached';
    }
    if (shellSubmit) {
      shellSubmit.disabled = true;
    }
    appendRuntimeChip('State', 'No session selected', 'info');
    return;
  }

  const runtimeState = describeRuntimeStatus(runtime, stream, session);
  const connectionSince = formatElapsedSince(getStreamElapsedAnchor(stream) || runtime.runtimeConnectionStartedAt);
  const phaseSince = formatElapsedSince(getRuntimeElapsedAnchor(runtime));
  const pingSince = formatElapsedSince(stream.lastPingAt);
  const connectionTone = runtimeState.connection === 'connected' || runtimeState.connection === 'ready'
    ? 'active'
    : runtimeState.connection === 'reconnecting' || runtimeState.connection === 'connecting'
      ? 'warning'
      : runtimeState.connection === 'disconnected' || runtimeState.connection === 'closed'
        ? 'error'
        : 'info';
  const phaseTone = runtime.phase === 'error' || runtime.phase === 'quota-exhausted'
    ? 'error'
    : runtime.phase === 'waiting-approval' || runtime.phase === 'waiting-user-input' || runtime.phase === 'reconnecting'
      ? 'warning'
      : runtime.busy
        ? 'active'
        : 'info';

  if (session.live) {
    titleEl.textContent = `${session.title || session.sessionId} is live`;
    subtitleEl.textContent = runtime.busy
      ? `${runtimeState.phase} for ${phaseSince || '0s'} | ${prettyStatusLabel(runtimeState.connection)}${connectionSince ? ` for ${connectionSince}` : ''}`
      : `${prettyStatusLabel(runtimeState.connection)}${connectionSince ? ` for ${connectionSince}` : ''} | ${runtimeState.phase}`;
  } else {
    titleEl.textContent = `${session.title || session.sessionId} is history only`;
    subtitleEl.textContent = 'You can resume it, fork it, or open a different live variant from this workspace.';
  }
  if (detailTitleEl) {
    detailTitleEl.textContent = titleEl.textContent;
  }
  if (detailSubtitleEl) {
    detailSubtitleEl.textContent = subtitleEl.textContent;
  }

  appendRuntimeChip('Bridge', prettyStatusLabel(runtimeState.connection), connectionTone);
  appendRuntimeChip(
    'Phase',
    `${runtimeState.phase}${phaseSince ? ` | ${phaseSince}` : ''}`,
    phaseTone
  );
  appendRuntimeChip(
    'Turn',
    runtime.activeTurnId
      ? `${shortId(runtime.activeTurnId)} | ${runtimeState.turn}`
      : runtimeState.turn,
    runtime.activeTurnId ? 'active' : 'info'
  );
  appendRuntimeChip(
    'Requests',
    requests.length ? `${requests.length} pending` : 'None',
    requests.length ? 'warning' : 'info'
  );
  appendRuntimeChip(
    'Processing',
    runtime.busy
      ? `Running for ${formatElapsedSince(runtime.busyStartedAt || runtime.phaseStartedAt || runtime.updatedAt) || '0s'}`
      : `Last update ${formatElapsedSince(runtime.updatedAt) || 'just now'} ago`,
    runtime.busy ? 'active' : 'info'
  );
  if (pingSince) {
    appendRuntimeChip('Heartbeat', `${pingSince} ago`, 'info');
  }
  if (runtime.lastCodexError) {
    appendRuntimeChip('Error', limitText(runtime.lastCodexError, 96), 'error');
  } else if (runtime.rateLimits?.rateLimitReachedType) {
    appendRuntimeChip('API', prettyStatusLabel(runtime.rateLimits.rateLimitReachedType), 'warning');
  }

  if (detailsButton) {
    detailsButton.disabled = false;
  }
  if (statusButton) {
    statusButton.disabled = false;
  }
  if (steerInput) {
    steerInput.disabled = !session.live || !runtime.activeTurnId;
    steerInput.placeholder = runtime.activeTurnId
      ? 'Guide the current live turn without sending a fresh prompt'
      : 'No active turn to steer right now';
  }
  if (steerSubmit) {
    steerSubmit.disabled = !session.live || !runtime.activeTurnId;
  }
  if (shellInput) {
    shellInput.disabled = !session.live || !runtime.threadId;
    shellInput.placeholder = runtime.threadId
      ? 'Run a host shell command through thread/shellCommand'
      : 'No live Codex thread is attached';
  }
  if (shellSubmit) {
    shellSubmit.disabled = !session.live || !runtime.threadId;
  }
}

function renderThinkingPanel() {
  const panel = el('thinking-panel');
  if (panel) {
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }
}

function renderAlertsWindow() {
  const session = getSelectedSession();
  const alerts = getAlertsForSession(session);
  const windowEl = el('alerts-window');
  const listEl = el('alerts-list');
  const emptyEl = el('alerts-empty');
  const titleEl = el('alerts-title');
  const fabEl = el('alerts-fab');
  const fabCountEl = el('alerts-fab-count');

  if (!session) {
    windowEl.classList.add('hidden');
    fabEl.classList.add('hidden');
    return;
  }

  titleEl.textContent = `${session.title || session.sessionId} alerts`;
  fabCountEl.textContent = String(alerts.length);
  fabEl.classList.toggle('hidden', state.alertWindowOpen || alerts.length === 0);
  windowEl.classList.toggle('hidden', !state.alertWindowOpen);

  listEl.innerHTML = '';
  if (!alerts.length) {
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  for (const alert of [...alerts].reverse()) {
    const item = document.createElement('div');
    item.className = `alert-item ${alert.severity || 'warning'}`;
    item.innerHTML = `
      <div class="alert-top">
        <span class="alert-severity">${(alert.severity || 'warning').toUpperCase()}</span>
        <span class="alert-time">${formatTime(alert.timestamp)}</span>
      </div>
      <div class="alert-message">${alert.message || ''}</div>
      <div class="alert-source">${alert.source || 'runtime'}</div>
    `;
    listEl.appendChild(item);
  }
}

function describeThreadStatus(runtime) {
  const status = runtime?.threadStatus;
  if (!status || typeof status !== 'object') {
    return 'Unknown';
  }

  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.length ? `Active (${flags.join(', ')})` : 'Active';
  }

  return status.type || 'Unknown';
}

function formatTokenUsage(runtime) {
  const usage = runtime?.tokenUsage;
  if (!usage?.last || !usage?.total) {
    return 'No token usage reported yet.';
  }

  const lines = [
    `Last turn total: ${usage.last.totalTokens}`,
    `Input: ${usage.last.inputTokens} | Output: ${usage.last.outputTokens} | Reasoning: ${usage.last.reasoningOutputTokens}`,
    `Session total: ${usage.total.totalTokens}`,
  ];

  if (usage.modelContextWindow) {
    lines.push(`Context window: ${usage.modelContextWindow}`);
  }

  return lines.join('\n');
}

function formatRateLimits(runtime) {
  const limits = runtime?.rateLimits;
  if (!limits) {
    return 'No rate limit snapshot yet.';
  }

  const lines = [];
  if (limits.planType) {
    lines.push(`Plan: ${limits.planType}`);
  }
  if (limits.primary) {
    lines.push(`Primary: ${limits.primary.usedPercent}%${limits.primary.windowDurationMins ? ` / ${limits.primary.windowDurationMins} min` : ''}`);
  }
  if (limits.secondary) {
    lines.push(`Secondary: ${limits.secondary.usedPercent}%${limits.secondary.windowDurationMins ? ` / ${limits.secondary.windowDurationMins} min` : ''}`);
  }
  if (limits.rateLimitReachedType) {
    lines.push(`Reached: ${limits.rateLimitReachedType}`);
  }
  if (limits.credits) {
    lines.push(`Credits: ${limits.credits.unlimited ? 'unlimited' : limits.credits.balance || (limits.credits.hasCredits ? 'available' : 'empty')}`);
  }
  return lines.length ? lines.join('\n') : 'No rate limit snapshot yet.';
}

function renderStatusSummaryCard(container, label, value, note = '') {
  const card = document.createElement('div');
  card.className = 'status-summary-card';
  card.innerHTML = `
    <div class="status-summary-label">${label}</div>
    <div class="status-summary-value">${value}</div>
    ${note ? `<div class="status-summary-note">${note}</div>` : ''}
  `;
  container.appendChild(card);
}

async function respondToSessionRequest(session, request, response) {
  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/requests/${encodeURIComponent(request.requestId)}/respond`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      response,
    }),
  });
}

function buildToolAnswerResponse(questionId, answerLabel) {
  return {
    answers: {
      [questionId]: {
        answers: [answerLabel],
      },
    },
  };
}

function buildPermissionsDeclineResponse() {
  return {
    permissions: {
      fileSystem: null,
      network: {
        enabled: false,
      },
    },
    scope: 'turn',
    strictAutoReview: false,
  };
}

function appendApprovalPopupButton(actions, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className || '';
  button.textContent = label;
  button.onclick = async () => {
    const buttons = Array.from(actions.querySelectorAll('button'));
    buttons.forEach((item) => {
      item.disabled = true;
    });
    try {
      await onClick();
    } catch (error) {
      buttons.forEach((item) => {
        item.disabled = false;
      });
      reportError(error);
    }
  };
  actions.appendChild(button);
  return button;
}

function renderApprovalPopup() {
  const popup = el('approval-popup');
  if (!popup) {
    return;
  }

  const session = getSelectedSession();
  const pendingRequests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const request = pendingRequests[0] || null;
  if (!session || !request) {
    popup.classList.add('hidden');
    return;
  }

  const title = request.title || request.method || request.kind || 'Codex request';
  const message = request.message || request.summary || 'Codex needs a response before it can continue.';
  const detailText = request.summary && request.summary !== message
    ? request.summary
    : request.payload
      ? summarizeData(request.payload)
      : '';
  const actions = el('approval-popup-actions');

  el('approval-popup-title').textContent = title;
  el('approval-popup-message').textContent = message;
  const detail = el('approval-popup-detail');
  detail.textContent = detailText;
  detail.classList.toggle('hidden', !detailText);
  actions.innerHTML = '';

  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    appendApprovalPopupButton(actions, 'Approve', '', async () => {
      await respondToSessionRequest(session, request, { decision: 'accept' });
    });
    appendApprovalPopupButton(actions, 'Decline', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, { decision: 'decline' });
    });
    appendApprovalPopupButton(actions, 'Cancel Turn', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, { decision: 'cancel' });
    });
  } else if (request.method === 'item/permissions/requestApproval') {
    appendApprovalPopupButton(actions, 'Decline Permissions', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, buildPermissionsDeclineResponse());
    });
  } else if (request.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(request.payload?.questions) ? request.payload.questions : [];
    if (questions.length === 1 && Array.isArray(questions[0].options) && questions[0].options.length <= 3) {
      for (const option of questions[0].options) {
        appendApprovalPopupButton(actions, option.label, 'secondary-button', async () => {
          await respondToSessionRequest(session, request, buildToolAnswerResponse(questions[0].id, option.label));
        });
      }
    }
  }

  appendApprovalPopupButton(actions, 'Open Status', 'secondary-button', async () => {
    setStatusWindowOpen(true);
  });

  popup.classList.remove('hidden');
}

async function interruptActiveTurn(options = {}) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
    }),
  });
  if (options.restoreDraft) {
    restoreActiveDraftForSession(session);
  }
}

async function steerActiveTurn(text) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  const prompt = String(text || '').trim();
  if (!prompt) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      text: prompt,
    }),
  });
}

async function compactCurrentThread() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/compact`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
    }),
  });
}

async function endCurrentSession() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  if (!session.live) {
    throw new Error(t('session.endAlreadyClosed'));
  }
  if (!window.confirm(t('session.endConfirm'))) {
    return;
  }

  patchRuntimeForSession(session.hostId, session.sessionId, {
    phase: 'ending',
    connection: 'closing',
    busy: false,
    activeTurnId: null,
    waitingOnApproval: false,
    waitingOnUserInput: false,
  });
  renderAll();

  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({
        hostId: session.hostId,
      }),
    });
  } catch (error) {
    patchRuntimeForSession(session.hostId, session.sessionId, {
      phase: 'error',
      connection: 'ready',
      lastError: error.message,
    });
    throw error;
  }
  await delay(600);
  await refresh();
}

async function runThreadShellCommand(command) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  const shellCommand = String(command || '').trim();
  if (!shellCommand) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/shell-command`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      command: shellCommand,
    }),
  });
}

function ensureStatusPanelMounted() {
  const overlay = el('status-window-overlay');
  const modal = el('status-window');
  const slot = el('session-status-panel-slot');
  if (slot && modal && modal.parentElement !== slot) {
    slot.appendChild(modal);
  }
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

function renderStatusWindow() {
  ensureStatusPanelMounted();
  const overlay = el('status-window-overlay');
  const modal = el('status-window');
  const session = getSelectedSession();
  const visible = Boolean(state.sessionDetailsOpen && session);

  if (overlay) {
    overlay.classList.add('hidden');
  }
  if (!visible || !session) {
    modal?.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  modal.classList.remove('hidden');
  syncModalBodyState();

  const runtime = getRuntimeForSession(session) || {};
  const host = getHost(session.hostId);
  const stream = getStreamStatusForSession(session) || {};
  const alerts = getAlertsForSession(session);
  const diagnostics = getDiagnosticsForSession(session);
  const requests = getRequestsForSession(session);
  const pendingRequests = requests.filter((request) => request.status === 'pending');
  requestReceivedFilesForSession(session);

  el('status-window-title').textContent = `${session.title || session.sessionId} status`;
  const summaryGrid = el('status-summary-grid');
  summaryGrid.innerHTML = '';
  const phaseSince = formatElapsedSince(getRuntimeElapsedAnchor(runtime));
  const bridgeSince = formatElapsedSince(getStreamElapsedAnchor(stream) || runtime.runtimeConnectionStartedAt);

  renderStatusSummaryCard(summaryGrid, 'Host', host?.online ? 'Online' : 'Offline', host?.label || session.hostId);
  renderStatusSummaryCard(
    summaryGrid,
    'Bridge',
    prettyStatusLabel(stream.connection || runtime.connection || (session.live ? 'connecting' : 'history only')),
    [
      bridgeSince ? `For ${bridgeSince}` : '',
      stream.lastPingAt ? `Last ping ${formatElapsedSince(stream.lastPingAt) || '0s'} ago` : '',
    ].filter(Boolean).join(' | ')
  );
  renderStatusSummaryCard(
    summaryGrid,
    'Phase',
    prettyStatusLabel(runtime.phase || session.state || 'unknown'),
    runtime.busy
      ? `Busy for ${phaseSince || '0s'}`
      : phaseSince
        ? `Updated ${phaseSince} ago`
        : 'Idle'
  );
  renderStatusSummaryCard(summaryGrid, 'Thread', describeThreadStatus(runtime), runtime.threadId ? shortId(runtime.threadId) : '');
  renderStatusSummaryCard(
    summaryGrid,
    'Turn',
    runtime.activeTurnId ? shortId(runtime.activeTurnId) : 'none',
    runtime.activeTurnId
      ? `${prettyStatusLabel(runtime.currentTurnStatus || 'inProgress')} | ${formatElapsedSince(runtime.turnStartedAt || runtime.updatedAt) || '0s'}`
      : prettyStatusLabel(runtime.currentTurnStatus || 'idle')
  );
  renderStatusSummaryCard(summaryGrid, 'Runner', getRunnerSummary(session).label, runtime.lastCodexError || '');

  const thinkingRecordCount = buildThinkingEntriesForSession(session).reduce((total, segment) => total + (segment.entries?.length || 0), 0);
  el('status-thinking').textContent = thinkingRecordCount
    ? `${thinkingRecordCount} structured thinking record${thinkingRecordCount === 1 ? '' : 's'} are available in the conversation flow.`
    : 'Structured reasoning and plan history, when available, is shown in the conversation flow.';
  el('status-usage').textContent = formatTokenUsage(runtime);
  el('status-rate-limits').textContent = formatRateLimits(runtime);

  const interruptButton = el('interrupt-turn-button');
  const endSessionButton = el('end-session-status-button');
  const compactButton = el('compact-thread-button');
  const steerInput = el('steer-input');
  const steerSubmitButton = el('steer-submit-button');
  const shellCommandInput = el('shell-command-input');
  const shellCommandSubmitButton = el('shell-command-submit-button');
  interruptButton.disabled = !session.live || !runtime.activeTurnId;
  interruptButton.textContent = runtime.activeTurnId ? 'Interrupt Active Turn' : 'No Active Turn';
  endSessionButton.disabled = !session.live || runtime.phase === 'ending' || runtime.connection === 'closing';
  endSessionButton.textContent = session.live
    ? (endSessionButton.disabled ? 'Ending Session...' : 'End Live Session')
    : 'Session Ended';
  compactButton.disabled = !session.live || !runtime.threadId;
  compactButton.textContent = runtime.threadId ? 'Compact Context' : 'No Thread';
  steerInput.disabled = !session.live || !runtime.activeTurnId;
  steerSubmitButton.disabled = !session.live || !runtime.activeTurnId;
  steerInput.placeholder = runtime.activeTurnId
    ? 'Ask Codex to adjust the current turn without starting over'
    : 'No active turn to steer right now';
  shellCommandInput.disabled = !session.live || !runtime.threadId;
  shellCommandSubmitButton.disabled = !session.live || !runtime.threadId;
  shellCommandInput.placeholder = runtime.threadId
    ? 'Run a shell command inside the current Codex thread context'
    : 'No live Codex thread is attached';

  const requestList = el('status-requests');
  requestList.innerHTML = '';
  if (!requests.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No pending or recent Codex requests for this session.';
    requestList.appendChild(empty);
  } else {
    for (const request of [...requests].reverse()) {
      const item = document.createElement('div');
      item.className = `status-request-card ${request.status === 'pending' ? 'pending' : 'resolved'}`;

      const title = request.title || request.method || request.kind || 'Request';
      const summary = request.summary || request.message || '';
      item.innerHTML = `
        <div class="status-request-top">
          <div class="status-request-title">${title}</div>
          <div class="status-request-badge">${request.status || 'pending'}</div>
        </div>
        <div class="status-request-copy">${summary || 'No summary provided.'}</div>
        <div class="status-request-meta">${request.method || request.kind || 'request'} | ${formatTime(request.updatedAt || request.createdAt)}</div>
      `;

      if (request.payload) {
        const detail = document.createElement('div');
        detail.className = 'status-request-detail';
        detail.textContent = summarizeData(request.payload);
        item.appendChild(detail);
      }

      if (request.status === 'pending') {
        const actions = document.createElement('div');
        actions.className = 'status-request-actions';

        if (request.method === 'item/tool/requestUserInput') {
          const questions = Array.isArray(request.payload?.questions) ? request.payload.questions : [];
          if (questions.length === 1 && Array.isArray(questions[0].options) && questions[0].options.length) {
            for (const option of questions[0].options) {
              const button = document.createElement('button');
              button.type = 'button';
              button.className = 'secondary-button';
              button.textContent = option.label;
              button.onclick = async () => {
                try {
                  await respondToSessionRequest(session, request, buildToolAnswerResponse(questions[0].id, option.label));
                } catch (error) {
                  reportError(error);
                }
              };
              actions.appendChild(button);
            }
          } else {
            const note = document.createElement('div');
            note.className = 'status-request-note';
            note.textContent = 'This request needs a richer input form. The protocol payload is captured and can be wired next.';
            item.appendChild(note);
          }
        } else if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
          const options = [
            ['Accept', { decision: 'accept' }],
            ['Allow This Session', { decision: 'acceptForSession' }],
            ['Decline', { decision: 'decline' }],
            ['Cancel Turn', { decision: 'cancel' }],
          ];
          for (const [label, response] of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = label === 'Decline' || label === 'Cancel Turn' ? 'secondary-button' : '';
            button.textContent = label;
            button.onclick = async () => {
              try {
                await respondToSessionRequest(session, request, response);
              } catch (error) {
                reportError(error);
              }
            };
            actions.appendChild(button);
          }
        } else if (request.method === 'item/permissions/requestApproval') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary-button';
          button.textContent = 'Decline Permissions';
          button.onclick = async () => {
            try {
              await respondToSessionRequest(session, request, buildPermissionsDeclineResponse());
            } catch (error) {
              reportError(error);
            }
          };
          actions.appendChild(button);
        }

        if (actions.childElementCount > 0) {
          item.appendChild(actions);
        }
      }

      requestList.appendChild(item);
    }
  }

  const receivedList = el('status-received-files');
  if (receivedList) {
    receivedList.innerHTML = '';
    const receivedFiles = getReceivedFilesForSession(session);
    if (isReceivedFilesLoading(session)) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Loading received files...';
      receivedList.appendChild(empty);
    } else if (!receivedFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No files have been received into the relay cache for this session yet. Open or Save a file card to receive it.';
      receivedList.appendChild(empty);
    } else {
      for (const file of receivedFiles.slice(0, 20)) {
        const item = document.createElement('div');
        item.className = 'status-request-card resolved';
        const openUrl = buildReceivedFileUrl(file, true);
        const saveUrl = buildReceivedFileUrl(file, false);
        const expires = file.expiresAt ? `Expires ${formatTime(file.expiresAt)}` : 'No expiry reported';
        item.innerHTML = `
          <div class="status-request-top">
            <div class="status-request-title">${escapeHtml(file.name || 'received file')}</div>
            <div class="status-request-badge">${escapeHtml(formatBytes(file.size || 0))}</div>
          </div>
          <div class="status-request-copy">${escapeHtml(file.remotePath || '')}</div>
          <div class="status-request-meta">Received ${formatTime(file.receivedAt)} | ${escapeHtml(expires)}</div>
        `;
        const actions = document.createElement('div');
        actions.className = 'status-request-actions';
        const openLink = document.createElement('a');
        openLink.className = 'secondary-button';
        openLink.href = openUrl;
        openLink.target = '_blank';
        openLink.rel = 'noopener';
        openLink.textContent = 'Open';
        const saveLink = document.createElement('a');
        saveLink.className = 'secondary-button';
        saveLink.href = saveUrl;
        saveLink.download = file.name || 'download';
        saveLink.textContent = 'Save';
        actions.appendChild(openLink);
        actions.appendChild(saveLink);
        item.appendChild(actions);
        receivedList.appendChild(item);
      }
    }
  }

  const alertList = el('status-alerts');
  alertList.innerHTML = '';
  if (!alerts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No warnings or errors have been recorded for this session.';
    alertList.appendChild(empty);
  } else {
    for (const alert of [...alerts].reverse().slice(0, 16)) {
      const item = document.createElement('div');
      item.className = `status-alert-card ${alert.severity || 'warning'}`;
      item.innerHTML = `
        <div class="status-alert-top">
          <span>${(alert.severity || 'warning').toUpperCase()}</span>
          <span>${formatTime(alert.timestamp)}</span>
        </div>
        <div class="status-alert-message">${alert.message || ''}</div>
        <div class="status-alert-source">${alert.source || 'runtime'}</div>
      `;
      alertList.appendChild(item);
    }
  }

  const diagnosticsList = el('status-diagnostics');
  diagnosticsList.innerHTML = '';
  if (!diagnostics.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No structured Codex notifications have been captured for this session yet.';
    diagnosticsList.appendChild(empty);
  } else {
    for (const entry of [...diagnostics].reverse().slice(0, 48)) {
      const item = document.createElement('div');
      item.className = `status-diagnostic-card ${entry.severity || 'info'}`;
      item.innerHTML = `
        <div class="status-diagnostic-top">
          <span>${entry.kind || 'event'}</span>
          <span>${formatTime(entry.timestamp)}</span>
        </div>
        <div class="status-diagnostic-method">${entry.method || entry.source || 'codex'}</div>
        <div class="status-diagnostic-message">${entry.message || ''}</div>
        ${entry.detail ? `<div class="status-diagnostic-detail">${entry.detail}</div>` : ''}
        ${entry.data ? `<div class="status-diagnostic-data">${summarizeData(entry.data)}</div>` : ''}
      `;
      diagnosticsList.appendChild(item);
    }
  }

  el('status-window-subtitle').textContent = `${pendingRequests.length} pending request${pendingRequests.length === 1 ? '' : 's'} | ${diagnostics.length} events captured`;
}

function renderPickerEntries(container, entries, emptyText, onSelect) {
  container.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-entry';
    button.innerHTML = `
      <div class="name">${entry.title || entry.name || pathLeaf(entry.path) || entry.path}</div>
      <div class="path">${entry.path}</div>
    `;
    button.onclick = () => onSelect(entry.path);
    container.appendChild(button);
  }
}

function renderPickerChips(container, entries, activePath, onSelect) {
  container.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No root paths were reported by this host.';
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker-chip secondary-button ${entry.path === activePath ? 'active' : ''}`.trim();
    button.textContent = entry.name || entry.path;
    button.onclick = () => {
      browseDirectoryPath(entry.path).catch(reportDirectoryPickerError);
    };
    container.appendChild(button);
  }
}

function renderDirectoryPicker() {
  const overlay = el('directory-picker-overlay');
  const picker = el('directory-picker');
  const host = getHost(state.selectedHostId);
  const pickerHost = el('picker-host');
  const pickerStatus = el('picker-status');
  const pickerCurrentPath = el('picker-current-path');
  const upButton = el('picker-up-button');
  const refreshButton = el('picker-refresh-button');
  const selectButton = el('picker-select-button');

  if (!state.directoryPicker.open) {
    overlay.classList.add('hidden');
    picker.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  overlay.classList.remove('hidden');
  picker.classList.remove('hidden');
  syncModalBodyState();
  pickerHost.textContent = host ? host.label : 'No host selected';
  pickerCurrentPath.textContent = state.directoryPicker.currentPath || '(pick a root or recent directory)';

  if (!host) {
    pickerStatus.textContent = 'Choose a host first, then browse directories on that machine.';
  } else if (state.directoryPicker.loading) {
    pickerStatus.textContent = 'Loading directories from the selected host...';
  } else if (state.directoryPicker.error) {
    pickerStatus.textContent = state.directoryPicker.error;
  } else {
    pickerStatus.textContent = 'Tap a folder to enter it, then use the current directory.';
  }

  upButton.disabled = state.directoryPicker.loading || !state.directoryPicker.parentPath;
  refreshButton.disabled = state.directoryPicker.loading || !host;
  selectButton.disabled = state.directoryPicker.loading || !state.directoryPicker.currentPath;

  renderPickerChips(
    el('picker-roots'),
    state.directoryPicker.roots,
    state.directoryPicker.currentPath,
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );

  renderPickerEntries(
    el('picker-recents'),
    host ? getRecentDirectories(host.hostId) : [],
    'No recent workspace paths were discovered for this host yet.',
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );

  renderPickerEntries(
    el('picker-directories'),
    state.directoryPicker.directories,
    state.directoryPicker.loading
      ? 'Loading...'
      : 'This folder does not have any visible subdirectories.',
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );
}

function renderDiffLine(line) {
  const row = document.createElement('div');
  row.className = 'diff-line';
  if (line.startsWith('+') && !line.startsWith('+++')) {
    row.classList.add('added');
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    row.classList.add('removed');
  } else if (line.startsWith('@@')) {
    row.classList.add('hunk');
  }
  row.textContent = line || ' ';
  return row;
}

function renderFileChangeDetails(fileChanges = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'thinking-file-change-list';
  for (const change of fileChanges) {
    const details = document.createElement('details');
    details.className = 'thinking-file-change-card';
    const additions = Number(change.additions || 0);
    const deletions = Number(change.deletions || 0);
    details.innerHTML = `
      <summary class="thinking-file-change-summary">
        <span class="thinking-file-path">${escapeHtml(change.path || 'workspace change')}</span>
        <span class="diff-stat added">+${additions}</span>
        <span class="diff-stat removed">-${deletions}</span>
      </summary>
    `;
    const diff = document.createElement('div');
    diff.className = 'thinking-diff-block';
    const diffText = String(change.diff || '').trim();
    if (diffText) {
      for (const line of diffText.split(/\r?\n/).slice(0, 240)) {
        diff.appendChild(renderDiffLine(line));
      }
      if (diffText.split(/\r?\n/).length > 240) {
        const truncated = document.createElement('div');
        truncated.className = 'diff-line hunk';
        truncated.textContent = '... diff truncated in mobile view ...';
        diff.appendChild(truncated);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'thinking-text';
      empty.textContent = 'No unified diff body was provided by Codex for this file change.';
      diff.appendChild(empty);
    }
    details.appendChild(diff);
    wrapper.appendChild(details);
  }
  return wrapper;
}

function renderInlineMarkdown(parent, text) {
  const source = String(text || '');
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let match = tokenPattern.exec(source);
  while (match) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else if (match[2]) {
      const label = token.slice(1, token.indexOf(']('));
      const link = document.createElement('a');
      link.href = match[2];
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = label || match[2];
      parent.appendChild(link);
    } else {
      parent.appendChild(document.createTextNode(token));
    }
    lastIndex = tokenPattern.lastIndex;
    match = tokenPattern.exec(source);
  }
  if (lastIndex < source.length) {
    parent.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
}

function appendMarkdownParagraph(container, text) {
  const paragraph = document.createElement('p');
  renderInlineMarkdown(paragraph, text);
  container.appendChild(paragraph);
}

function appendMarkdownList(container, items, ordered = false) {
  const list = document.createElement(ordered ? 'ol' : 'ul');
  for (const itemText of items) {
    const item = document.createElement('li');
    renderInlineMarkdown(item, itemText);
    list.appendChild(item);
  }
  container.appendChild(list);
}

function appendCodeBlock(container, codeText, language = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-code-card';
  const header = document.createElement('div');
  header.className = 'markdown-code-header';
  const label = document.createElement('span');
  label.textContent = language || 'code';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'markdown-copy-code secondary-button';
  copyButton.dataset.copyText = codeText;
  copyButton.textContent = 'Copy';
  header.appendChild(label);
  header.appendChild(copyButton);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = language ? `language-${language}` : '';
  code.textContent = codeText;
  pre.appendChild(code);
  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  container.appendChild(wrapper);
}

function renderMarkdown(container, text) {
  container.innerHTML = '';
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let paragraph = [];
  let listItems = [];
  let orderedListItems = [];
  let blockquote = [];
  let codeLines = [];
  let inCode = false;
  let codeLanguage = '';

  function flushParagraph() {
    if (paragraph.length) {
      appendMarkdownParagraph(container, paragraph.join('\n'));
      paragraph = [];
    }
  }

  function flushLists() {
    if (listItems.length) {
      appendMarkdownList(container, listItems, false);
      listItems = [];
    }
    if (orderedListItems.length) {
      appendMarkdownList(container, orderedListItems, true);
      orderedListItems = [];
    }
  }

  function flushBlockquote() {
    if (!blockquote.length) {
      return;
    }
    const quote = document.createElement('blockquote');
    renderInlineMarkdown(quote, blockquote.join('\n'));
    container.appendChild(quote);
    blockquote = [];
  }

  function flushCode() {
    appendCodeBlock(container, codeLines.join('\n'), codeLanguage);
    codeLines = [];
    codeLanguage = '';
  }

  for (const line of lines) {
    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushParagraph();
        flushLists();
        flushBlockquote();
        inCode = true;
        codeLanguage = fence[1] || '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushLists();
      flushBlockquote();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushLists();
      flushBlockquote();
      const level = Math.min(4, heading[1].length + 1);
      const node = document.createElement(`h${level}`);
      renderInlineMarkdown(node, heading[2]);
      container.appendChild(node);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushBlockquote();
      if (orderedListItems.length) {
        appendMarkdownList(container, orderedListItems, true);
        orderedListItems = [];
      }
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushBlockquote();
      if (listItems.length) {
        appendMarkdownList(container, listItems, false);
        listItems = [];
      }
      orderedListItems.push(ordered[1]);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushLists();
      blockquote.push(quote[1]);
      continue;
    }

    flushLists();
    flushBlockquote();
    paragraph.push(line);
  }

  if (inCode) {
    flushCode();
  }
  flushParagraph();
  flushLists();
  flushBlockquote();
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function flashCopyButton(button, label = 'Copied') {
  if (!button) {
    return;
  }
  const previous = button.textContent;
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = previous || 'Copy';
    button.disabled = false;
  }, 1200);
}

function buildThinkingMessageElement(session, segment, runtime, stream, isLivePlaceholder = false) {
  const keyBase = getSessionKey(session) || session.sessionId || 'session';
  const stateKey = `${keyBase}::thinking::${segment?.userTimestamp || 'live'}`;
  const details = document.createElement('details');
  details.className = 'thinking-card';
  const defaultOpen = isLivePlaceholder || !segment?.entries?.length;
  if (state.thinkingPanels.has(stateKey) ? state.thinkingPanels.get(stateKey) : defaultOpen) {
    details.open = true;
  }

  details.addEventListener('toggle', () => {
    state.thinkingPanels.set(stateKey, details.open);
  });

  const entries = Array.isArray(segment?.entries) ? segment.entries : [];
  const preview = entries.length
    ? entries[entries.length - 1].text
    : `Codex is ${prettyStatusLabel(runtime.phase || 'thinking').toLowerCase()}...`;
  const meta = entries.length
    ? `${entries.length} record${entries.length === 1 ? '' : 's'}`
    : `${prettyStatusLabel(stream.connection || runtime.connection || 'connected')} | ${prettyStatusLabel(runtime.currentTurnStatus || runtime.phase || 'thinking')}`;

  details.innerHTML = `
    <summary class="thinking-summary">
      <div class="thinking-title-row">
        <div class="thinking-title">Thinking</div>
        <div class="thinking-phase">${entries.length ? `${entries.length} step${entries.length === 1 ? '' : 's'}` : 'Live'}</div>
      </div>
      <div class="thinking-preview">${limitText(preview, 180)}</div>
      <div class="thinking-note">${meta}</div>
    </summary>
  `;

  const content = document.createElement('div');
  content.className = 'thinking-content';

  if (entries.length) {
    const history = document.createElement('div');
    history.className = 'thinking-history-list';
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'thinking-history-item';
      item.innerHTML = `
        <div class="thinking-history-top">
          <span class="thinking-history-kind">${prettyStatusLabel(entry.kind || 'thinking')}</span>
          <span>${formatTime(entry.timestamp)}</span>
        </div>
        <div class="thinking-history-text">${entry.text}</div>
      `;
      if (Array.isArray(entry.fileChanges) && entry.fileChanges.length) {
        item.appendChild(renderFileChangeDetails(entry.fileChanges));
      }
      history.appendChild(item);
    }
    content.appendChild(history);
  } else {
    const liveThinking = [
      runtime.reasoningSummary ? `Reasoning:\n${runtime.reasoningSummary}` : '',
      runtime.planSummary ? `Plan:\n${runtime.planSummary}` : '',
    ].filter(Boolean).join('\n\n');
    const block = document.createElement('div');
    block.className = 'thinking-block';
    block.innerHTML = `
      <div class="thinking-label">Live Turn</div>
      <div class="thinking-text">${escapeHtml(liveThinking || 'Codex is still working on this turn. Structured reasoning, plan, or file-change records have not arrived yet.')}</div>
    `;
    content.appendChild(block);
  }

  details.appendChild(content);

  const wrapper = document.createElement('div');
  wrapper.className = 'message thinking';

  const metaEl = document.createElement('div');
  metaEl.className = 'message-meta';
  metaEl.textContent = `Codex thinking ${segment?.userTimestamp ? formatTime(segment.userTimestamp) : ''}`.trim();
  wrapper.appendChild(metaEl);
  wrapper.appendChild(details);
  return wrapper;
}

function renderFileCards(container, session, entry) {
  const files = getTranscriptFileRefs(entry);
  if (!session || !files.length) {
    return;
  }

  const list = document.createElement('div');
  list.className = 'message-file-list';
  for (const file of files.slice(0, 8)) {
    if (!file.path || isBareDownloadableFilename(file.path)) {
      continue;
    }
    const card = document.createElement('div');
    card.className = `message-file-card ${isImageFileRef(file) ? 'image' : ''}`.trim();
    const inlineUrl = buildHostFileUrl(session, file, true);
    const downloadUrl = buildHostFileUrl(session, file, false);
    const name = file.name || basename(file.path) || 'remote file';
    const meta = [
      file.mime || (isImageFileRef(file) ? 'image' : 'file'),
      file.size ? formatBytes(file.size) : '',
      'received on first open/save',
    ].filter(Boolean).join(' | ');

    if (isImageFileRef(file)) {
      const preview = document.createElement('img');
      preview.className = 'message-file-preview';
      preview.loading = 'lazy';
      preview.alt = name;
      preview.src = inlineUrl;
      card.appendChild(preview);
    }

    const body = document.createElement('div');
    body.className = 'message-file-body';
    body.innerHTML = `
      <div class="message-file-name">${escapeHtml(name)}</div>
      <div class="message-file-path">${escapeHtml(file.path)}</div>
      <div class="message-file-meta">${escapeHtml(meta || 'remote file')}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'message-file-actions';
    const openLink = document.createElement('a');
    openLink.className = 'secondary-button';
    openLink.href = inlineUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.textContent = 'Open';
    const saveLink = document.createElement('a');
    saveLink.className = 'secondary-button';
    saveLink.href = downloadUrl;
    saveLink.download = name;
    saveLink.textContent = 'Save';
    actions.appendChild(openLink);
    actions.appendChild(saveLink);
    body.appendChild(actions);
    card.appendChild(body);
    list.appendChild(card);
  }

  if (list.childElementCount) {
    container.appendChild(list);
  }
}

function renderTranscript(session = getSelectedSession(), options = {}) {
  const log = el('session-log');
  const key = getSessionKey(session) || '';
  const previousKey = log.dataset.sessionKey || '';
  const shouldStickToBottom = options.forceScroll || previousKey !== key || isTranscriptPinnedToBottom(log);
  const bottomOffset = log.scrollHeight - log.scrollTop - log.clientHeight;
  log.innerHTML = '';
  log.dataset.sessionKey = key;

  if (!session) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a conversation on the left to inspect it here.';
    log.appendChild(empty);
    restoreTranscriptScroll(log, { forceScroll: true });
    return;
  }

  const transcript = getTranscriptForSession(session);
  const visibleTranscript = transcript.filter((entry) => entry.speaker === 'user' || entry.speaker === 'agent' || entry.speaker === 'assistant');
  const thinkingSegments = buildThinkingEntriesForSession(session);
  const thinkingByUserTimestamp = new Map(thinkingSegments.map((segment) => [segment.userTimestamp || '', segment]));
  const runtime = getRuntimeForSession(session) || {};
  const stream = getStreamStatusForSession(session) || {};
  const latestUserEntry = [...visibleTranscript].reverse().find((entry) => entry.speaker === 'user') || null;
  if (!visibleTranscript.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = session.source === 'managed'
      ? 'Waiting for the managed session transcript...'
      : 'No transcript preview was captured for this imported session.';
    log.appendChild(empty);
    restoreTranscriptScroll(log, { forceScroll: options.forceScroll || previousKey !== key });
    return;
  }

  for (const entry of visibleTranscript) {
    const message = document.createElement('div');
    const speaker = entry.speaker === 'assistant' ? 'agent' : entry.speaker;
    message.className = `message ${speaker || 'agent'}`;
    message.title = entry.timestamp ? `Sent ${formatTime(entry.timestamp)}` : '';

    if (speaker !== 'system') {
      const toolbar = document.createElement('div');
      toolbar.className = 'message-toolbar';
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = `${speaker === 'user' ? 'You' : 'Codex'} ${formatTime(entry.timestamp)}`.trim();
      toolbar.appendChild(meta);
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'message-copy-button secondary-button';
      copyButton.dataset.copyText = entry.text || '';
      copyButton.textContent = 'Copy';
      toolbar.appendChild(copyButton);
      message.appendChild(toolbar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble markdown-body';
    renderMarkdown(bubble, entry.text || '');
    message.appendChild(bubble);
    renderFileCards(message, session, entry);

    log.appendChild(message);

    if (speaker === 'user') {
      const segment = thinkingByUserTimestamp.get(entry.timestamp || '') || null;
      const isLatestUser = latestUserEntry && latestUserEntry.timestamp === entry.timestamp && latestUserEntry.text === entry.text;
      const shouldShowLivePlaceholder = Boolean(
        isLatestUser
        && session.live
        && (runtime.busy || runtime.phase === 'thinking' || runtime.phase === 'planning' || runtime.phase === 'waiting-approval' || runtime.phase === 'waiting-user-input')
      );

      if (segment || shouldShowLivePlaceholder) {
        log.appendChild(buildThinkingMessageElement(session, segment, runtime, stream, shouldShowLivePlaceholder && !segment));
      }
    }
  }

  restoreTranscriptScroll(log, {
    forceScroll: options.forceScroll,
    shouldStickToBottom,
    bottomOffset,
  });
}

function renderLocaleLabels() {
  document.documentElement.lang = currentLocale();
  for (const node of document.querySelectorAll('[data-i18n-key]')) {
    node.textContent = t(node.dataset.i18nKey);
  }

  const navigatorButton = el('toggle-navigator-button');
  if (navigatorButton) {
    navigatorButton.textContent = state.navigatorCollapsed ? t('nav.open') : t('nav.close');
    navigatorButton.setAttribute('aria-expanded', state.navigatorCollapsed ? 'false' : 'true');
  }
  const languageButton = el('toggle-language-button');
  if (languageButton) {
    languageButton.textContent = t('nav.languageToggle');
    languageButton.title = currentLocale() === 'zh-CN' ? 'Switch to English' : '切换到中文';
  }
  const settingsButton = el('open-settings-button');
  if (settingsButton) {
    settingsButton.textContent = t('nav.settings');
  }

  const accountButton = el('account-button');
  if (accountButton) {
    accountButton.textContent = t('top.account');
  }
  const logoutButton = el('logout-button');
  if (logoutButton) {
    logoutButton.textContent = t('top.lock');
  }
  const importButton = el('import-selected-host-button');
  if (importButton) {
    importButton.textContent = t('top.import');
  }
  const statusButton = el('toggle-status-button');
  if (statusButton) {
    const countMatch = statusButton.textContent.match(/[（(](\d+)[）)]/);
    const phaseMatch = statusButton.textContent.match(/(?:Status|状态)[:：]\s*(.+)$/);
    statusButton.textContent = countMatch
      ? `${t('top.status')} (${countMatch[1]})`
      : phaseMatch
        ? `${t('top.status')}: ${phaseMatch[1]}`
        : t('top.status');
  }
  const alertsButton = el('toggle-alerts-button');
  if (alertsButton) {
    const countMatch = alertsButton.textContent.match(/[（(](\d+)[）)]/);
    alertsButton.textContent = countMatch ? `${t('top.alerts')} (${countMatch[1]})` : t('top.alerts');
  }
  applyStaticLocalization(document.body);
}

function appendApiProfileOptions(select, options = {}) {
  if (!select) {
    return;
  }
  const profiles = getApiProfiles();
  select.innerHTML = '';
  if (options.includeDefault) {
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Use default';
    select.appendChild(defaultOption);
  }
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.profileId;
    option.textContent = `${profile.label}${profile.baseUrl ? ` | ${profile.baseUrl}` : ''}`;
    select.appendChild(option);
  }
}

function populateApiProfileEditor(profile = getSelectedApiProfile()) {
  const current = profile || getApiProfiles()[0] || normalizeApiProfile();
  el('settings-api-profile-select').value = current.profileId;
  el('settings-api-profile-label').value = current.label || '';
  el('settings-api-provider').value = current.provider || '';
  el('settings-api-base-url').value = current.baseUrl || '';
  el('settings-api-key').value = current.apiKey || '';
  el('settings-api-key-remember').checked = current.rememberApiKey === true;
  el('settings-delete-api-profile-button').disabled = getApiProfiles().length <= 1;
}

function saveActiveApiProfileFromSettingsForm() {
  const profile = getSelectedApiProfile();
  if (!profile) {
    return null;
  }
  profile.label = el('settings-api-profile-label').value.trim() || profile.label || 'API Profile';
  profile.provider = el('settings-api-provider').value.trim() || 'OpenAI';
  profile.baseUrl = el('settings-api-base-url').value.trim();
  profile.apiKey = el('settings-api-key').value;
  profile.rememberApiKey = el('settings-api-key-remember').checked;
  return profile;
}

function renderHostApiProfileList() {
  const container = el('settings-host-api-list');
  if (!container) {
    return;
  }
  container.innerHTML = '';
  if (!state.hosts.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty';
    empty.textContent = 'No hosts are connected yet. Start or import a host to assign API profiles.';
    container.appendChild(empty);
    return;
  }

  for (const host of state.hosts) {
    const row = document.createElement('label');
    row.className = 'settings-host-api-row';
    const label = document.createElement('span');
    label.textContent = `${host.label || host.hostId} (${host.hostId})`;
    const select = document.createElement('select');
    select.dataset.hostApiProfileHost = host.hostId;
    appendApiProfileOptions(select, { includeDefault: true });
    select.value = state.ui.hostApiProfiles?.[host.hostId] || '';
    row.append(label, select);
    container.appendChild(row);
  }
}

function populateSettingsForm() {
  const settings = normalizeUiSettings(state.ui);
  state.ui.locale = settings.locale;
  state.ui.apiProfiles = settings.apiProfiles;
  state.ui.selectedApiProfileId = settings.selectedApiProfileId;
  state.ui.defaultApiProfileId = settings.defaultApiProfileId;
  state.ui.hostApiProfiles = settings.hostApiProfiles;
  el('settings-language-select').value = settings.locale;
  appendApiProfileOptions(el('settings-api-profile-select'));
  appendApiProfileOptions(el('settings-default-api-profile'));
  el('settings-default-api-profile').value = settings.defaultApiProfileId;
  populateApiProfileEditor(getSelectedApiProfile());
  renderHostApiProfileList();
  applyStaticLocalization(el('settings-dialog'));
}

function renderSettingsDialog() {
  const dialog = el('settings-dialog');
  if (!dialog) {
    return;
  }
  dialog.classList.toggle('hidden', !state.settingsOpen);
  dialog.setAttribute('aria-hidden', state.settingsOpen ? 'false' : 'true');
  syncModalBodyState();
}

function openSettingsDialog() {
  state.settingsOpen = true;
  populateSettingsForm();
  renderSettingsDialog();
  renderLocaleLabels();
}

function closeSettingsDialog() {
  state.settingsOpen = false;
  renderSettingsDialog();
}

function renderAll() {
  renderAuthGate();
  const shell = document.querySelector('.shell');
  shell?.classList.toggle('navigator-collapsed', state.navigatorCollapsed);
  const sidebar = document.querySelector('.sidebar');
  sidebar?.classList.toggle('overview-collapsed', state.overviewCollapsed);
  el('overview-body')?.classList.toggle('hidden', state.overviewCollapsed);
  el('new-session-body')?.classList.toggle('hidden', state.newSessionCollapsed);
  const overviewButton = el('toggle-overview-button');
  const newSessionButton = el('toggle-new-session-button');
  if (overviewButton) {
    overviewButton.textContent = state.overviewCollapsed ? 'Show' : 'Hide';
  }
  if (newSessionButton) {
    newSessionButton.textContent = state.newSessionCollapsed ? 'Show New' : 'Hide New';
  }
  renderOverview();
  renderHostNav();
  renderConversationNav();
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderAlertsWindow();
  renderStatusWindow();
  renderDirectoryPicker();
  renderSlashMenu();
  renderSettingsDialog();
  renderLocaleLabels();
}

function closeStream() {
  if (state.eventSource) {
    if (state.eventSourceKey) {
      state.streamStatus.set(state.eventSourceKey, {
        ...(state.streamStatus.get(state.eventSourceKey) || {}),
        connection: 'closed',
      });
    }
    state.eventSource.close();
    state.eventSource = null;
    state.eventSourceKey = null;
  }
}

function updateSelectedViews(session) {
  if (!session || session.hostId !== state.selectedHostId) {
    return;
  }

  renderConversationNav();
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderAlertsWindow();
  renderStatusWindow();
}

function subscribeSession(session) {
  const key = getSessionKey(session);
  if (!key || state.eventSourceKey === key) {
    return;
  }

  closeStream();

  const url = `/api/sessions/${encodeURIComponent(session.sessionId)}/events?hostId=${encodeURIComponent(session.hostId)}`;
  state.eventSource = new EventSource(url);
  state.eventSourceKey = key;
  setStreamStatusForSession(session.hostId, session.sessionId, {
    connection: 'connecting',
    lastPingAt: null,
  });
  renderRuntimePanel();
  renderThinkingPanel();

  state.eventSource.addEventListener('open', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('ready', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
      lastPingAt: new Date().toISOString(),
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('ping', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
      lastPingAt: new Date().toISOString(),
    });
    renderRuntimePanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('error', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: session.live ? 'reconnecting' : 'disconnected',
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.snapshot', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    if (payload.bridgeSessionId && state.selectedSessionId === payload.bridgeSessionId) {
      state.selectedSessionId = payload.sessionId;
    }
    updateSelectedViews(payload);
  });

  state.eventSource.addEventListener('session.started', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    if (payload.bridgeSessionId && state.selectedSessionId === payload.bridgeSessionId) {
      state.selectedSessionId = payload.sessionId;
    }
    renderAll();
  });

  state.eventSource.addEventListener('session.state_changed', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    renderAll();
  });

  state.eventSource.addEventListener('session.transcript', (event) => {
    const payload = JSON.parse(event.data);
    appendTranscriptEntry(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    if (payload.speaker === 'agent' || payload.speaker === 'assistant') {
      clearActiveDraftForSession({
        hostId: payload.hostId || session.hostId,
        sessionId: payload.sessionId || session.sessionId,
      });
    }
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === key) {
      renderTranscript(selected, { forceScroll: payload.speaker === 'user' });
      renderThinkingPanel();
    }
  });

  state.eventSource.addEventListener('session.alert', (event) => {
    const payload = JSON.parse(event.data);
    appendAlertForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    if ((payload.severity || 'warning') === 'error') {
      state.alertWindowOpen = true;
    }
    renderSessionDetails();
    renderAlertsWindow();
  });

  state.eventSource.addEventListener('session.runtime', (event) => {
    const payload = JSON.parse(event.data);
    patchRuntimeForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    const runtimeStopped = !runtimeIsActive(payload);
    const status = String(payload.currentTurnStatus || payload.phase || '').toLowerCase();
    if (runtimeStopped && status && status !== 'interrupted') {
      clearActiveDraftForSession({
        hostId: payload.hostId || session.hostId,
        sessionId: payload.sessionId || session.sessionId,
      });
    }
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === makeSessionKey(payload.hostId || session.hostId, payload.sessionId || session.sessionId)) {
      maybeScheduleQueuedPromptSend(selected);
      refreshInferredComposerOptionsForSession(selected);
    }
    renderSessionDetails();
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.diagnostic', (event) => {
    const payload = JSON.parse(event.data);
    appendDiagnosticForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === makeSessionKey(payload.hostId || session.hostId, payload.sessionId || session.sessionId)) {
      refreshInferredComposerOptionsForSession(selected);
      renderSessionDetails();
      renderTranscript(selected);
      renderThinkingPanel();
    }
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.request', (event) => {
    const payload = JSON.parse(event.data);
    upsertRequestForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    state.statusWindowOpen = false;
    state.sessionDetailsOpen = true;
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === makeSessionKey(payload.hostId || session.hostId, payload.sessionId || session.sessionId)) {
      renderTranscript(selected);
      renderThinkingPanel();
    }
    renderSessionDetails();
    renderApprovalPopup();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.request.resolved', (event) => {
    const payload = JSON.parse(event.data);
    resolveRequestForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === makeSessionKey(payload.hostId || session.hostId, payload.sessionId || session.sessionId)) {
      renderTranscript(selected);
      renderThinkingPanel();
    }
    renderSessionDetails();
    renderApprovalPopup();
    renderStatusWindow();
  });
}

async function showSession(session = getSelectedSession()) {
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderTranscript(session, { forceScroll: true });

  if (!session) {
    closeStream();
    return;
  }

  if (session.live || session.source === 'managed') {
    subscribeSession(session);
  } else {
    closeStream();
  }

  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/detail?hostId=${encodeURIComponent(session.hostId)}`);
    mergeSession(detail.session);
    const existing = getTranscriptForSession(session);
    setTranscriptForSession(session.hostId, session.sessionId, [...detail.transcript, ...existing]);
    setAlertsForSession(session.hostId, session.sessionId, detail.alerts || []);
    setRuntimeForSession(session.hostId, session.sessionId, detail.runtime || null);
    setDiagnosticsForSession(session.hostId, session.sessionId, detail.diagnostics || []);
    setRequestsForSession(session.hostId, session.sessionId, detail.requests || []);

    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === getSessionKey(session)) {
      renderSessionDetails();
      renderRuntimePanel();
      renderThinkingPanel();
      renderAlertsWindow();
      renderStatusWindow();
      renderTranscript(selected, { forceScroll: true });
    }
  } catch (error) {
    appendAlertForSession(session.hostId, session.sessionId, {
      severity: 'error',
      source: 'ui',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
    state.alertWindowOpen = true;

    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === getSessionKey(session)) {
      renderSessionDetails();
      renderRuntimePanel();
      renderThinkingPanel();
      renderAlertsWindow();
      renderStatusWindow();
    }
  }
}

function applySelectedHost(hostId) {
  if (state.selectedHostId === hostId) {
    return;
  }

  state.selectedHostId = hostId;
  state.selectedConversationKey = null;
  state.selectedSessionId = null;
  ensureSelections();
  renderAll();
  if (state.directoryPicker.open) {
    fetchDirectoryListing(null, hostId).catch(reportDirectoryPickerError);
  }
  showSession().catch(reportError);
}

async function refreshHostAndConnectorSnapshots() {
  const [hostsResponse, connectorsResponse] = await Promise.all([
    fetchJson('/api/hosts'),
    fetchJson('/api/connectors'),
  ]);
  state.hosts = hostsResponse.hosts || [];
  state.dismissedHosts = hostsResponse.dismissedHosts || [];
  state.connectors = connectorsResponse.connectors || [];
  renderAll();
}

async function waitForRecoveredHost(hostId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    await refreshHostAndConnectorSnapshots();
    const host = getHost(hostId);
    if (host?.online) {
      try {
        return await verifyHostAvailable(hostId);
      } catch (error) {
        lastError = error;
      }
    } else {
      lastError = new Error(`Host ${host?.label || hostId} is still offline after connector restart.`);
    }
    await delay(1500);
  }

  throw lastError || new Error(`Timed out while waiting for host ${hostId} to reconnect.`);
}

async function recoverHostForSwitch(hostId, cause) {
  const connector = getConnectorForHost(hostId);
  if (!connector) {
    return false;
  }

  const host = getHost(hostId);
  state.connectorActionResults.set(connector.connectorId, {
    ok: false,
    status: 'recovering_host',
    message: `${host?.label || hostId} is not ready: ${cause?.message || 'health check failed'}. Starting connector ${connector.label || connector.connectorId}...`,
  });
  renderConnectorManager();

  const result = await executeConnectorAction(connector, 'bootstrap', connector, {
    refreshAfter: false,
    selectEditor: false,
    reportMissing: false,
  });
  if (!result) {
    throw new Error(`Recovery for ${host?.label || hostId} was cancelled.`);
  }
  if (!result.ok) {
    throw new Error(`Host ${host?.label || hostId} is unavailable, and connector ${connector.label || connector.connectorId} could not restart it:\n${connectorActionResultSummary(result)}`);
  }

  await waitForRecoveredHost(hostId);
  await refresh();
  return true;
}

async function ensureHostAvailable(hostId) {
  try {
    return await verifyHostAvailable(hostId);
  } catch (error) {
    const recovered = await recoverHostForSwitch(hostId, error);
    if (recovered) {
      return { ok: true, mode: 'connector-recovered' };
    }
    throw error;
  }
}

async function setSelectedHost(hostId, options = {}) {
  if (state.selectedHostId === hostId) {
    return;
  }

  const verify = options.verify !== false;
  state.hostSwitchBusyId = hostId;
  renderAll();

  try {
    if (verify) {
      await ensureHostAvailable(hostId);
    }
    applySelectedHost(hostId);
  } finally {
    state.hostSwitchBusyId = null;
    renderAll();
  }
}

function setSessionSearchQuery(query) {
  state.sessionSearchQuery = String(query || '').trim();
  renderAll();
}

function setSessionSearchMode(mode) {
  state.sessionSearchMode = ['keyword', 'path', 'title'].includes(mode) ? mode : 'keyword';
  renderAll();
}

async function selectConversation(conversation) {
  if (!conversation) {
    return;
  }

  if (state.selectedHostId !== conversation.hostId) {
    await ensureHostAvailable(conversation.hostId);
  }

  state.selectedHostId = conversation.hostId;
  state.selectedConversationKey = conversation.conversationKey;
  state.selectedSessionId = conversation.preferredSession?.sessionId || null;
  renderAll();
  showSession().catch(reportError);
}

async function selectSession(session) {
  if (!session) {
    return;
  }

  if (state.selectedHostId !== session.hostId) {
    await ensureHostAvailable(session.hostId);
  }

  state.selectedHostId = session.hostId;
  state.selectedConversationKey = session.conversationKey || session.originSessionId || session.sessionId;
  state.selectedSessionId = session.sessionId;
  renderAll();
  showSession(session).catch(reportError);
}

async function refresh() {
  if (!authAllowsRequests()) {
    renderAuthGate();
    return;
  }

  const previousKey = getSessionKey(getSelectedSession());

  const [stats, hostsResponse, connectorsResponse, collectionsResponse] = await Promise.all([
    fetchJson('/api/stats'),
    fetchJson('/api/hosts'),
    fetchJson('/api/connectors'),
    fetchJson('/api/session-collections'),
  ]);

  state.stats = stats;
  state.hosts = hostsResponse.hosts || [];
  state.dismissedHosts = hostsResponse.dismissedHosts || [];
  state.connectors = connectorsResponse.connectors || [];
  state.sessionCollections = collectionsResponse.collections || [];
  if (!state.sessionCollections.some((collection) => collection.collectionId === state.selectedCollectionId)) {
    state.selectedCollectionId = state.sessionCollections[0]?.collectionId || 'default';
  }

  const sessionResponses = await Promise.all(
    state.hosts.map((host) => fetchJson(`/api/hosts/${encodeURIComponent(host.hostId)}/sessions`))
  );

  state.sessions = [];
  sessionResponses.forEach((response) => {
    (response.sessions || []).forEach((session) => state.sessions.push(session));
  });

  if (state.connectorEditorId && !getConnector(state.connectorEditorId)) {
    state.connectorEditorId = null;
  }

  ensureSelections();
  renderAll();

  if (state.directoryPicker.open && !getHost(state.selectedHostId || '')) {
    setDirectoryPickerState({
      hostId: null,
      currentPath: '',
      parentPath: null,
      roots: [],
      directories: [],
      loading: false,
      error: 'The selected host is no longer available for browsing.',
    });
  }

  const selected = getSelectedSession();
  const nextKey = getSessionKey(selected);
  if (!nextKey) {
    closeStream();
    renderTranscript(null);
    return;
  }

  const needsStream = Boolean(selected.live || selected.source === 'managed');
  const streamMismatch = needsStream ? state.eventSourceKey !== nextKey : Boolean(state.eventSourceKey);
  if (nextKey !== previousKey || !state.transcripts.has(nextKey) || streamMismatch) {
    await showSession(selected);
  } else {
    renderTranscript(selected);
  }
}

async function waitForSession(hostId, sessionId, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastSession = null;
  while (Date.now() < deadline) {
    const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/sessions`);
    const session = (response.sessions || []).find((item) => item.sessionId === sessionId || item.bridgeSessionId === sessionId) || null;
    lastSession = session || lastSession;
    if (session && predicate(session)) {
      return session;
    }
    await sleep(400);
  }

  const stateText = lastSession?.state ? ` Last state: ${lastSession.state}.` : '';
  throw new Error(`Timed out while waiting for the live session to start.${stateText}`);
}

async function waitForSessionReady(hostId, sessionId, timeoutMs = 60000) {
  return waitForSession(
    hostId,
    sessionId,
    (session) => session.live === true || String(session.state || '').startsWith('failed') || String(session.state || '').startsWith('exited'),
    timeoutMs
  );
}

async function importHost(hostId) {
  await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/import`, { method: 'POST' });
  await refresh();
}

async function importHostById(hostId) {
  const response = await fetchJson('/api/hosts/import', {
    method: 'POST',
    body: JSON.stringify({ hostId }),
  });

  await refresh();
  if (response?.host?.hostId) {
    await setSelectedHost(response.host.hostId);
  }
}

async function deleteHost(hostId) {
  await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });

  if (state.selectedHostId === hostId) {
    state.selectedHostId = null;
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
  }

  for (const key of Array.from(state.transcripts.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.transcripts.delete(key);
    }
  }

  for (const key of Array.from(state.alerts.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.alerts.delete(key);
    }
  }

  for (const key of Array.from(state.runtime.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.runtime.delete(key);
    }
  }

  for (const key of Array.from(state.diagnostics.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.diagnostics.delete(key);
    }
  }

  for (const key of Array.from(state.requests.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.requests.delete(key);
    }
  }

  for (const key of Array.from(state.streamStatus.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.streamStatus.delete(key);
    }
  }

  closeStream();
  await refresh();
}

async function saveConnectorProfile(payload = readConnectorForm()) {
  if (!payload.label) {
    reportError(new Error('Connector label is required.'));
    return null;
  }

  const connectorId = payload.connectorId;
  const response = connectorId
    ? await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    : await fetchJson('/api/connectors', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

  await refresh();
  state.connectorEditorId = response?.connector?.connectorId || connectorId || null;
  renderConnectorManager();
  return response?.connector || null;
}

async function deleteSelectedConnector() {
  const connectorId = el('connector-id').value.trim() || state.connectorEditorId;
  if (!connectorId) {
    return;
  }

  await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'DELETE',
  });

  state.connectorEditorId = null;
  await refresh();
  renderConnectorManager();
}

async function copyConnectorBootstrapCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.bootstrapCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

async function copyConnectorLoginCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.sshLoginCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

async function copyConnectorSmokeCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.sshSmokeTestCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

function connectorNeedsOneTimePrompt(method, otpSource, context = {}) {
  const normalized = String(method || '').trim();
  if (normalized === 'otp' || normalized === 'manual_captcha') {
    return true;
  }
  if (normalized === 'keyboard_interactive' && String(context.keyPath || '').trim()) {
    return true;
  }
  return Boolean(String(otpSource || '').trim())
    && (normalized === 'password' || normalized === 'keyboard_interactive');
}

function connectorOneTimePromptName(method) {
  return method === 'manual_captcha' ? 'captcha / manual challenge response' : 'OTP / MFA code';
}

function promptConnectorOneTimeCode(scope, method, otpSource, action, options = {}) {
  const promptName = connectorOneTimePromptName(method);
  const actionLabel = {
    smoke_test: 'Test',
    status: 'Status',
    bootstrap: 'Start Agent',
    restart: 'Restart Agent',
    diagnose: 'Diagnose',
    logs: 'Logs',
  }[action] || action || 'SSH';
  const sourceNote = String(otpSource || '').trim()
    ? `\nSource/notes: ${String(otpSource || '').trim()}`
    : '';
  const retryNote = options.retry
    ? `\n\nPrevious authentication failed. The code may have expired; enter a fresh one.`
    : '';
  const attemptNote = options.maxAttempts && options.attempt
    ? `\nAttempt ${options.attempt} of ${options.maxAttempts}.`
    : '';
  const value = window.prompt(
    `${scope} requires a current ${promptName} for ${actionLabel}.${sourceNote}${retryNote}${attemptNote}\n\nThis code is sent once and is not saved.`
  );
  if (value === null) {
    return null;
  }
  const code = String(value).trim();
  if (!code) {
    throw new Error(`${scope} ${promptName} is required for this connector action.`);
  }
  return code;
}

function connectorActionUsesOneTimeCode(payload) {
  const gatewayMethod = payload.gateway?.authMethod || 'ssh_key';
  const targetMethod = payload.auth?.method || 'ssh_key';
  return Boolean(
    (payload.gateway?.enabled && connectorNeedsOneTimePrompt(gatewayMethod, payload.gateway?.otpSource))
    || connectorNeedsOneTimePrompt(targetMethod, payload.auth?.otpSource, {
      keyPath: payload.auth?.keyPath || '',
    })
  );
}

function collectConnectorActionSecrets(payload, action, promptOptions = {}) {
  const secrets = { ...(payload.secrets || {}) };
  const gatewayMethod = payload.gateway?.authMethod || 'ssh_key';
  const targetMethod = payload.auth?.method || 'ssh_key';
  const passthrough = Boolean(promptOptions.interactivePassthrough);

  if (
    payload.gateway?.enabled
    && connectorNeedsOneTimePrompt(gatewayMethod, payload.gateway?.otpSource)
    && !(passthrough && gatewayMethod === 'keyboard_interactive')
  ) {
    const gatewayOtp = promptConnectorOneTimeCode('Gateway', gatewayMethod, payload.gateway?.otpSource, action, promptOptions);
    if (gatewayOtp === null) {
      return null;
    }
    secrets.gatewayOtp = gatewayOtp;
  }

  if (connectorNeedsOneTimePrompt(targetMethod, payload.auth?.otpSource, {
    keyPath: payload.auth?.keyPath || '',
  }) && !(passthrough && targetMethod === 'keyboard_interactive')) {
    const targetOtp = promptConnectorOneTimeCode('Target', targetMethod, payload.auth?.otpSource, action, promptOptions);
    if (targetOtp === null) {
      return null;
    }
    secrets.targetOtp = targetOtp;
  }

  return secrets;
}

function connectorActionFailureText(result) {
  const chunks = [
    result?.status,
    result?.message,
    result?.stdout,
    result?.stderr,
    result?.error,
    result?.deploy?.status,
    result?.deploy?.message,
  ];
  for (const step of result?.deploy?.steps || []) {
    chunks.push(step?.name, step?.stdout, step?.stderr, step?.error);
  }
  return chunks.filter(Boolean).join('\n').toLowerCase();
}

function shouldRetryConnectorOneTimeCode(payload, result) {
  if (!result || result.ok || !connectorActionUsesOneTimeCode(payload)) {
    return false;
  }
  const text = connectorActionFailureText(result);
  return /permission denied.*keyboard-interactive|keyboard-interactive.*permission denied|verification|authenticator|passcode|otp|mfa|token|connection closed/.test(text);
}

function updateConnectorFromActionResult(connectorId, result) {
  if (!result?.connector) {
    return;
  }
  const index = state.connectors.findIndex((item) => item.connectorId === connectorId);
  if (index >= 0) {
    state.connectors[index] = result.connector;
  }
}

function connectorActionResultSummary(result) {
  if (!result) {
    return 'No connector action result was returned.';
  }
  return [
    result.message,
    result.error,
    result.stderr,
    result.deploy?.message,
  ].filter(Boolean).join('\n') || result.status || 'Connector action failed.';
}

function makeConnectorAskpassContext() {
  return {
    actionId: makeClientId(),
    token: `${makeClientId()}-${makeClientId()}`,
  };
}

async function answerConnectorAskpassPrompt(connectorId, askpass, prompt, answer) {
  await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}/action-prompts/${encodeURIComponent(prompt.promptId)}`, {
    method: 'POST',
    body: JSON.stringify({
      actionId: askpass.actionId,
      token: askpass.token,
      cancel: answer === null,
      response: answer === null ? '' : String(answer),
    }),
  });
}

async function watchConnectorAskpassPrompts(connectorId, askpass, control) {
  const seen = new Set();
  while (!control.done) {
    try {
      const result = await fetchJson(
        `/api/connectors/${encodeURIComponent(connectorId)}/action-prompts?actionId=${encodeURIComponent(askpass.actionId)}&token=${encodeURIComponent(askpass.token)}`
      );
      for (const prompt of result.prompts || []) {
        if (!prompt?.promptId || seen.has(prompt.promptId)) {
          continue;
        }
        seen.add(prompt.promptId);
        const answer = window.prompt(
          `SSH is asking for input:\n\n${prompt.prompt || 'Authentication prompt'}\n\nType the exact response for this prompt. It is sent once and is not saved.`
        );
        await answerConnectorAskpassPrompt(connectorId, askpass, prompt, answer);
        if (answer === null) {
          control.cancelled = true;
          control.done = true;
          return;
        }
      }
    } catch (_) {
      // The action may not be registered yet, or it may have just finished.
    }
    await delay(500);
  }
}

async function executeConnectorAction(connector, action, payload = connector, options = {}) {
  if (!connector?.connectorId) {
    if (options.reportMissing !== false) {
      reportError(new Error('Save or select an HPC connector first.'));
    }
    return null;
  }

  state.connectorActionBusy = {
    connectorId: connector.connectorId,
    action,
  };
  renderConnectorManager();

  try {
    const usePromptPassthrough = true;
    const maxAttempts = usePromptPassthrough ? 1 : connectorActionUsesOneTimeCode(payload) ? 3 : 1;
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let actionSecrets = null;
      try {
        actionSecrets = collectConnectorActionSecrets(payload, action, {
          retry: attempt > 1,
          attempt,
          maxAttempts,
          interactivePassthrough: usePromptPassthrough,
        });
      } catch (error) {
        reportError(error);
        return lastResult;
      }
      if (!actionSecrets) {
        return lastResult;
      }

      const askpass = makeConnectorAskpassContext();
      const promptControl = { done: false };
      const promptWatcher = watchConnectorAskpassPrompts(connector.connectorId, askpass, promptControl);
      let result = null;
      try {
        result = await fetchJson(`/api/connectors/${encodeURIComponent(connector.connectorId)}/actions`, {
          method: 'POST',
          body: JSON.stringify({
            action,
            clientOrigin: window.location.origin,
            secrets: actionSecrets,
            askpass,
          }),
        });
      } finally {
        promptControl.done = true;
        promptWatcher.catch(() => {});
      }
      lastResult = result;
      state.connectorActionResults.set(connector.connectorId, result);
      updateConnectorFromActionResult(connector.connectorId, result);
      renderConnectorManager();

      const shouldRetry = !promptControl.cancelled
        && attempt < maxAttempts
        && shouldRetryConnectorOneTimeCode(payload, result);
      if (!shouldRetry) {
        if (options.refreshAfter !== false) {
          await refresh();
        }
        if (options.selectEditor !== false) {
          state.connectorEditorId = connector.connectorId;
        }
        renderConnectorManager();
        return result;
      }

      state.connectorActionResults.set(connector.connectorId, {
        ...result,
        ok: false,
        status: 'auth_retry',
        message: `${result.message || 'Authentication failed.'} Requesting a fresh OTP and retrying...`,
      });
      renderConnectorManager();
    }
    return lastResult;
  } finally {
    state.connectorActionBusy = null;
    renderConnectorManager();
  }
}

async function runConnectorAction(action) {
  const payload = readConnectorForm();
  const savedConnector = await saveConnectorProfile(payload);
  return executeConnectorAction(savedConnector?.connectorId ? savedConnector : null, action, payload, {
    refreshAfter: true,
    selectEditor: true,
  });
}

function getOriginSessionId(session) {
  return session.originSessionId || session.conversationKey || session.sessionId;
}

function pathLeaf(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

function setDirectoryPickerState(patch) {
  state.directoryPicker = {
    ...state.directoryPicker,
    ...patch,
  };
  renderDirectoryPicker();
}

function reportDirectoryPickerError(error) {
  setDirectoryPickerState({
    loading: false,
    error: error.message,
  });
}

async function fetchDirectoryListing(targetPath = null, hostId = state.selectedHostId) {
  if (!hostId) {
    setDirectoryPickerState({
      open: true,
      hostId: null,
      currentPath: '',
      parentPath: null,
      roots: [],
      directories: [],
      loading: false,
      error: 'Select a host before browsing its directories.',
    });
    return null;
  }

  setDirectoryPickerState({
    open: true,
    hostId,
    loading: true,
    error: null,
  });

  const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
  const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/directories${query}`);
  setDirectoryPickerState({
    open: true,
    hostId,
    currentPath: response.currentPath || '',
    parentPath: response.parentPath || null,
    roots: Array.isArray(response.roots) ? response.roots : [],
    directories: Array.isArray(response.directories) ? response.directories : [],
    loading: false,
    error: null,
  });
  return response;
}

async function openDirectoryPicker() {
  const seedPath = String(el('new-session-cwd').value || '').trim()
    || getSelectedSession()?.cwd
    || state.directoryPicker.currentPath
    || null;
  await fetchDirectoryListing(seedPath);
}

function closeDirectoryPicker() {
  setDirectoryPickerState({ open: false, loading: false, error: null });
}

async function browseDirectoryPath(targetPath) {
  const normalized = String(targetPath || '').trim();
  await fetchDirectoryListing(normalized || null);
}

function applyPickedDirectory() {
  if (!state.directoryPicker.currentPath) {
    return;
  }

  el('new-session-cwd').value = state.directoryPicker.currentPath;
  if (!el('new-session-label').value.trim()) {
    el('new-session-label').value = pathLeaf(state.directoryPicker.currentPath);
  }
  closeDirectoryPicker();
}

function setAlertWindowOpen(open) {
  state.alertWindowOpen = Boolean(open);
  renderAlertsWindow();
}

function toggleAlertWindow() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  setAlertWindowOpen(!state.alertWindowOpen);
}

function setStatusWindowOpen(open) {
  state.statusWindowOpen = false;
  if (open && getSelectedSession()) {
    state.sessionDetailsOpen = true;
    renderSessionDetails();
  }
  renderStatusWindow();
}

function toggleStatusWindow() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  state.sessionDetailsOpen = !state.sessionDetailsOpen;
  renderSessionDetails();
  renderStatusWindow();
}

async function joinLiveSession() {
  const conversation = getSelectedConversation();
  const liveSession = getLiveSessionForConversation(conversation);
  if (!liveSession) {
    return;
  }
  await selectSession(liveSession);
}

async function startManagedSession(options = {}) {
  const sourceSession = Object.prototype.hasOwnProperty.call(options, 'session')
    ? options.session
    : getSelectedSession();
  const conversation = getSelectedConversation();
  const launchMode = options.launchMode || (sourceSession ? 'resume' : 'fresh');
  const hostId = options.hostId || sourceSession?.hostId || state.selectedHostId;
  const cwd = String(options.cwd || sourceSession?.cwd || '').trim();
  const label = String(options.label || sourceSession?.title || pathLeaf(cwd) || cwd || '').trim();
  const host = hostId ? getHost(hostId) : null;

  if (!hostId) {
    reportError(new Error('Select a host before starting a managed session.'));
    return null;
  }
  if (host && !host.online) {
    throw new Error(`Host ${host.label || host.hostId} is offline. Start its agent first, then try again.`);
  }

  if (!cwd) {
    reportError(new Error('No workspace path is available for this conversation.'));
    return null;
  }

  await verifyHostAvailable(hostId);

  const body = {
    cwd,
    label: label || cwd,
    launchMode,
  };
  const apiConfig = getApiRequestConfig(hostId);
  if (apiConfig) {
    body.apiConfig = apiConfig;
  }

  if (options.command) {
    body.command = options.command;
  }

  if (sourceSession?.sessionId) {
    body.sourceSessionId = sourceSession.sessionId;
    body.originSessionId = getOriginSessionId(sourceSession);
    body.conversationKey = conversation?.conversationKey || getOriginSessionId(sourceSession);
    body.nativeThreadId = sourceSession.nativeThreadId || sourceSession.sessionId;
  }

  const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/sessions/start`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const startedSession = await waitForSessionReady(hostId, response.sessionId);
  if (!startedSession.live) {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(startedSession.sessionId)}/detail?hostId=${encodeURIComponent(hostId)}`).catch(() => null);
    const alertMessage = Array.isArray(detail?.alerts) ? [...detail.alerts].reverse().find((entry) => entry && entry.message)?.message : null;
    const transcript = Array.isArray(detail?.transcript) ? [...detail.transcript].reverse() : [];
    const systemMessage = transcript.find((entry) => entry.speaker === 'system' && entry.text && !String(entry.text).startsWith('State changed:'))?.text
      || transcript.find((entry) => entry.speaker === 'system' && entry.text)?.text
      || null;
    throw new Error(alertMessage || systemMessage || `Managed session failed to start: ${startedSession.state || 'unknown error'}`);
  }

  await refresh();
  const next = state.sessions.find((item) => item.hostId === hostId && item.sessionId === startedSession.sessionId) || null;
  if (next) {
    await selectSession(next);
  }
  if (next && (options.initialText || options.initialInputOptions?.inputItems?.length)) {
    await sendInputToSession(next, options.initialText || '', options.initialInputOptions || {});
  }
  return next;
}

async function resumeFromHistory(options = {}) {
  const session = options.session || getSelectedSession();
  if (!session) {
    return null;
  }

  if (session.live) {
    return session;
  }

  return startManagedSession({
    ...options,
    session,
    launchMode: 'resume',
  });
}

async function forkNewBranch(options = {}) {
  const session = options.session || getSelectedSession();
  if (!session) {
    return null;
  }

  return startManagedSession({
    ...options,
    session,
    launchMode: 'fork',
  });
}

async function createFreshSession() {
  const hostId = state.selectedHostId;
  if (!hostId) {
    reportError(new Error('Select a host before creating a new session.'));
    return null;
  }

  const cwdInput = el('new-session-cwd');
  const labelInput = el('new-session-label');
  const cwd = cwdInput.value.trim();
  const label = labelInput.value.trim();

  if (!cwd) {
    reportError(new Error('Enter a directory path on the selected host.'));
    return null;
  }

  const next = await startManagedSession({
    hostId,
    cwd,
    label,
    launchMode: 'fresh',
    session: null,
  });

  if (next) {
    labelInput.value = '';
  }

  return next;
}

function useSelectedSessionPath() {
  const session = getSelectedSession();
  if (!session?.cwd) {
    reportError(new Error('The selected session does not have a workspace path to reuse.'));
    return;
  }

  el('new-session-cwd').value = session.cwd;
  if (!el('new-session-label').value.trim() && session.title) {
    el('new-session-label').value = session.title;
  }
}

function getActiveTurnBlocker(session) {
  if (!session?.live) {
    return null;
  }

  const runtime = getRuntimeForSession(session) || session.runtime || {};
  const phase = String(runtime.phase || '').toLowerCase();
  const pendingCount = getRequestsForSession(session).filter((request) => request.status === 'pending').length;
  const activePhase = [
    'thinking',
    'planning',
    'reviewing',
    'waiting-approval',
    'waiting-user-input',
    'retrying',
    'reconnecting',
  ].includes(phase);

  if (!runtime.activeTurnId && !runtime.busy && !runtime.waitingOnApproval && !runtime.waitingOnUserInput && !activePhase) {
    return null;
  }

  if (runtime.waitingOnApproval || phase === 'waiting-approval') {
    return pendingCount
      ? `Codex is waiting for ${pendingCount} approval request. Open Status to approve, decline, or interrupt it before sending another prompt.`
      : 'Codex is waiting for approval. Open Status to approve, decline, or interrupt it before sending another prompt.';
  }

  if (runtime.waitingOnUserInput || phase === 'waiting-user-input') {
    return pendingCount
      ? `Codex is waiting for ${pendingCount} input request. Open Status to answer or interrupt it before sending another prompt.`
      : 'Codex is waiting for user input. Open Status to answer or interrupt it before sending another prompt.';
  }

  return 'Codex is still working on the previous turn. Use Status to steer or interrupt it, then send the next prompt.';
}

function runtimeIsActive(runtime = {}) {
  const phase = String(runtime.phase || '').toLowerCase();
  const activePhase = [
    'thinking',
    'planning',
    'reviewing',
    'waiting-approval',
    'waiting-user-input',
    'retrying',
    'reconnecting',
    'running-shell-command',
    'compacting',
  ].includes(phase);
  return Boolean(runtime.activeTurnId || runtime.busy || runtime.waitingOnApproval || runtime.waitingOnUserInput || activePhase);
}

function openStatusForActiveTurnBlocker() {
  state.statusWindowOpen = false;
  state.sessionDetailsOpen = true;
  renderSessionDetails();
  renderRuntimePanel();
  renderStatusWindow();
}

async function sendInputToSession(session, text, options = {}) {
  const blocker = options.skipActiveTurnBlocker ? null : getActiveTurnBlocker(session);
  if (blocker) {
    openStatusForActiveTurnBlocker();
    throw new Error(blocker);
  }

  await verifyHostAvailable(session.hostId);
  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({
        hostId: session.hostId,
        text,
        displayText: options.displayText || text,
        inputItems: Array.isArray(options.inputItems) ? options.inputItems : [],
        uploadedFiles: Array.isArray(options.uploadedFiles) ? options.uploadedFiles : [],
        mode: options.mode || null,
        model: options.model || null,
        effort: options.effort || null,
        summary: options.summary || null,
        approvalPolicy: options.approvalPolicy || null,
        approvalsReviewer: options.approvalsReviewer || null,
        sandboxMode: options.sandboxMode || null,
        serviceTier: options.serviceTier || null,
        personality: options.personality || null,
      }),
    });
  } catch (error) {
    if (/still working on the previous turn/i.test(error.message || '')) {
      openStatusForActiveTurnBlocker();
      throw new Error('Codex is still working on the previous turn. Open Status to approve, decline, steer, or interrupt the active turn before sending another prompt.');
    }
    throw error;
  }
}

async function sendInput(text, options = {}) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  if (!session.live) {
    if (!session.cwd) {
      reportError(new Error('This history session does not have a workspace path to activate.'));
      return;
    }
    await resumeFromHistory({ session, initialText: text, initialInputOptions: options });
    return;
  }

  await sendInputToSession(session, text, options);
}

async function submitComposerPayload(payload, input) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  if (session.live && runtimeIsActive(getRuntimeForSession(session) || session.runtime || {})) {
    const queuedText = String(payload.text || payload.displayText || '').trim();
    const hasInputs = Boolean(payload.inputItems?.length || payload.uploadedFiles?.length);
    if (!queuedText && !hasInputs) {
      throw new Error('Codex is already working. Add text or files to queue, or interrupt it first.');
    }
    addSteerQueueItem(session, payload, queuedText || payload.displayText || 'Please inspect the attached file(s).');
    state.codexControls.steerNotice = null;
    if (input) {
      input.value = '';
    }
    clearComposerFileAttachments();
    renderComposerTurnNotice();
    return;
  }

  const wasLive = Boolean(session.live);
  await sendInput(payload.text, payload);
  if (wasLive) {
    setActiveDraftForSession(session, payload);
  }
  state.codexControls.steerNotice = null;
  if (input) {
    input.value = '';
  }
  clearComposerFileAttachments();
  renderComposerTurnNotice();
}

async function waitForActiveTurnToClear(session, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastRuntime = getRuntimeForSession(session) || session?.runtime || {};
  while (Date.now() < deadline) {
    lastRuntime = getRuntimeForSession(session) || lastRuntime || {};
    if (!runtimeIsActive(lastRuntime)) {
      return true;
    }

    try {
      const detail = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/detail?hostId=${encodeURIComponent(session.hostId)}`);
      if (detail?.runtime) {
        setRuntimeForSession(session.hostId, session.sessionId, detail.runtime);
        lastRuntime = detail.runtime;
        if (!runtimeIsActive(lastRuntime)) {
          return true;
        }
      }
    } catch (_) {
      // SSE may update runtime faster than detail polling; keep waiting.
    }

    await delay(650);
  }
  throw new Error('Timed out waiting for the active Codex turn to stop.');
}

async function sendQueuedPrompt(itemId) {
  const item = findSteerQueueItem(itemId);
  if (!item?.payload || !item?.sessionKey) {
    removeSteerQueueItem(itemId);
    renderComposerTurnNotice();
    return;
  }

  const session = getSelectedSession();
  if (!session || getSessionKey(session) !== item.sessionKey) {
    return;
  }

  const text = getSteerQueueText(item).trim();
  const hasInputs = Boolean(item.payload?.inputItems?.length || item.payload?.uploadedFiles?.length);
  if (!text && !hasInputs) {
    item.status = 'failed';
    item.error = 'This queued prompt is empty. Edit it or remove it from the queue.';
    renderComposerTurnNotice();
    return;
  }

  if (runtimeIsActive(getRuntimeForSession(session) || session.runtime || {})) {
    return;
  }

  setSteerQueueItemText(item, text || item.payload.displayText || 'Please inspect the attached file(s).');
  item.sending = true;
  item.error = '';
  renderComposerTurnNotice();

  try {
    await sendInputToSession(session, item.payload.text, {
      ...item.payload,
      skipActiveTurnBlocker: true,
    });
    setActiveDraftForSession(session, item.payload);
    removeSteerQueueItem(item.id);
    state.codexControls.steerNotice = {
      title: 'Queued prompt sent',
      message: 'The previous turn finished, so the first waiting prompt was sent as the next Codex turn.',
    };
    window.setTimeout(() => {
      if (state.codexControls.steerNotice?.title === 'Queued prompt sent') {
        state.codexControls.steerNotice = null;
        renderComposerTurnNotice();
      }
    }, 5000);
  } catch (error) {
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.sending = false;
      latest.status = 'failed';
      latest.error = error.message || 'Failed to send this queued prompt.';
    }
    throw error;
  } finally {
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.sending = false;
    }
    renderComposerTurnNotice();
  }
}

function maybeScheduleQueuedPromptSend(session = getSelectedSession()) {
  if (!session?.live || state.codexControls.queueAutoSendScheduled) {
    return;
  }
  const runtime = getRuntimeForSession(session) || session.runtime || {};
  if (runtimeIsActive(runtime)) {
    return;
  }
  const next = getFirstQueuedPrompt(session);
  if (!next) {
    return;
  }
  state.codexControls.queueAutoSendScheduled = true;
  window.setTimeout(() => {
    state.codexControls.queueAutoSendScheduled = false;
    const current = getSelectedSession();
    if (!current || getSessionKey(current) !== next.sessionKey) {
      return;
    }
    sendQueuedPrompt(next.id).catch(reportError);
  }, 350);
}

async function guideQueuedPrompt(itemId) {
  const item = findSteerQueueItem(itemId);
  if (!item?.payload || !item?.sessionKey) {
    removeSteerQueueItem(itemId);
    renderComposerTurnNotice();
    return;
  }

  const session = getSelectedSession();
  if (!session || getSessionKey(session) !== item.sessionKey) {
    throw new Error('Select the original live session before guiding this prompt.');
  }
  if (!runtimeIsActive(getRuntimeForSession(session) || session.runtime || {})) {
    await sendQueuedPrompt(item.id);
    return;
  }

  const text = getSteerQueueText(item).trim();
  if (!text) {
    throw new Error('This queued prompt is empty. Edit it or remove it from the queue.');
  }

  setSteerQueueItemText(item, text || item.payload.displayText || 'Please inspect the attached file(s).');
  item.sending = true;
  item.error = '';
  renderComposerTurnNotice();
  try {
    await steerActiveTurn(text);
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.status = 'guided';
      latest.sentAt = new Date().toISOString();
      latest.sending = false;
    }
  } catch (error) {
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.sending = false;
      latest.status = 'failed';
      latest.error = error.message || 'Failed to guide this prompt.';
    }
    throw error;
  } finally {
    renderComposerTurnNotice();
  }
}

async function interruptAndSendQueuedPrompt(itemId) {
  const item = findSteerQueueItem(itemId);
  if (!item?.payload || !item?.sessionKey) {
    removeSteerQueueItem(itemId);
    renderComposerTurnNotice();
    return;
  }

  const session = getSelectedSession();
  if (!session || getSessionKey(session) !== item.sessionKey) {
    throw new Error('Select the original live session before forcing this prompt into a new turn.');
  }

  const text = getSteerQueueText(item).trim();
  const hasInputs = Boolean(item.payload?.inputItems?.length || item.payload?.uploadedFiles?.length);
  if (!text && !hasInputs) {
    throw new Error('This queued prompt is empty. Edit it or remove it from the queue.');
  }

  setSteerQueueItemText(item, text || item.payload.displayText || 'Please inspect the attached file(s).');
  item.forceSending = true;
  item.error = '';
  renderComposerTurnNotice();

  try {
    await interruptActiveTurn();
    await waitForActiveTurnToClear(session);
    await sendInputToSession(session, item.payload.text, {
      ...item.payload,
      skipActiveTurnBlocker: true,
    });
    setActiveDraftForSession(session, item.payload);

    removeSteerQueueItem(item.id);
    state.codexControls.steerNotice = {
      title: 'Fresh turn started',
      message: 'The previous turn was interrupted and this prompt was sent as a new Codex turn.',
    };
    window.setTimeout(() => {
      if (state.codexControls.steerNotice?.title === 'Fresh turn started') {
        state.codexControls.steerNotice = null;
        renderComposerTurnNotice();
      }
    }, 5000);
  } catch (error) {
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.forceSending = false;
      latest.status = 'failed';
      latest.error = error.message || 'Failed to interrupt and send this prompt.';
    }
    throw error;
  } finally {
    const latest = findSteerQueueItem(item.id);
    if (latest) {
      latest.forceSending = false;
    }
    renderComposerTurnNotice();
  }
}

async function interruptAndSendPendingPrompt() {
  const first = getSelectedSteerQueue()[0];
  if (!first) {
    renderComposerTurnNotice();
    return;
  }
  await interruptAndSendQueuedPrompt(first.id);
}

function isModelOptionsLoading(session) {
  return state.codexControls.modelOptionsLoadingKeys.has(modelCacheKey(session));
}

async function loadModelOptionsForSession(session, options = {}) {
  if (!session?.live) {
    throw new Error('Select a live managed session before loading models.');
  }
  const host = getHost(session.hostId);
  if (!host?.capabilities?.modelList) {
    throw new Error(`${host?.label || session.hostId} does not support model listing yet. Restart its host-agent if needed.`);
  }

  const key = modelCacheKey(session);
  if (!options.force && state.codexControls.modelOptionsBySession.has(key)) {
    return state.codexControls.modelOptionsBySession.get(key) || [];
  }
  if (state.codexControls.modelOptionsLoadingKeys.has(key)) {
    return state.codexControls.modelOptionsBySession.get(key) || [];
  }

  state.codexControls.modelOptionsLoadingKeys.add(key);
  state.codexControls.modelsLoading = state.codexControls.modelOptionsLoadingKeys.size > 0;
  renderSessionDetails();
  try {
    await verifyHostAvailable(session.hostId);
    const includeHidden = options.includeHidden === true ? '&includeHidden=true' : '';
    const response = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/models?hostId=${encodeURIComponent(session.hostId)}&limit=100${includeHidden}`);
    state.codexControls.modelOptionsBySession.set(modelCacheKey(session), Array.isArray(response.models) ? response.models : []);
    return state.codexControls.modelOptionsBySession.get(key) || [];
  } finally {
    state.codexControls.modelOptionsLoadingKeys.delete(key);
    state.codexControls.modelsLoading = state.codexControls.modelOptionsLoadingKeys.size > 0;
    renderSessionDetails();
  }
}

function requestModelOptionsForSession(session) {
  if (!session?.live) {
    return;
  }
  const host = getHost(session.hostId);
  const key = modelCacheKey(session);
  if (
    !host?.capabilities?.modelList
    || state.codexControls.modelOptionsBySession.has(key)
    || isModelOptionsLoading(session)
  ) {
    return;
  }
  loadModelOptionsForSession(session).catch((error) => {
    if (!/model listing|session is not live|no live session|not live on this host-agent/i.test(error.message || '')) {
      reportError(error);
    }
  });
}

async function loadModelOptionsForSelectedSession() {
  return loadModelOptionsForSession(getSelectedSession(), { force: true });
}

async function loadReceivedFilesForSession(session, options = {}) {
  if (!session?.sessionId || !session?.hostId) {
    return [];
  }
  const key = getSessionKey(session);
  if (!key) {
    return [];
  }
  if (!options.force && state.receivedFiles.has(key)) {
    return state.receivedFiles.get(key) || [];
  }
  if (state.receivedFilesLoadingKeys.has(key)) {
    return state.receivedFiles.get(key) || [];
  }

  state.receivedFilesLoadingKeys.add(key);
  renderStatusWindow();
  try {
    const response = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/received-files?hostId=${encodeURIComponent(session.hostId)}`);
    setReceivedFilesForSession(session.hostId, session.sessionId, response.files || []);
    return getReceivedFilesForSession(session);
  } finally {
    state.receivedFilesLoadingKeys.delete(key);
    renderStatusWindow();
  }
}

function requestReceivedFilesForSession(session) {
  if (!session?.sessionId || !session?.hostId) {
    return;
  }
  const key = getSessionKey(session);
  if (!key || state.receivedFiles.has(key) || state.receivedFilesLoadingKeys.has(key)) {
    return;
  }
  loadReceivedFilesForSession(session).catch(reportError);
}

async function startReviewForCurrentSession() {
  const session = getSelectedSession();
  if (!session?.live) {
    throw new Error('Select a live managed session before starting a review.');
  }

  await verifyHostAvailable(session.hostId);
  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/review`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      target: {
        type: 'uncommittedChanges',
      },
      delivery: 'inline',
    }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportError(error) {
  const session = getSelectedSession();
  if (session) {
    appendAlertForSession(session.hostId, session.sessionId, {
      severity: 'error',
      source: 'ui',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
    state.alertWindowOpen = true;
    renderSessionDetails();
    renderAlertsWindow();
    return;
  }

  const log = el('session-log');
  log.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = error.message;
  log.appendChild(empty);
}

async function submitHostImport() {
  const input = el('import-host-id');
  const hostId = input.value.trim();
  if (!hostId) {
    return;
  }

  input.value = '';
  try {
    await importHostById(hostId);
  } catch (error) {
    reportError(error);
  }
}

el('import-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitHostImport();
});

el('import-host-button')?.addEventListener('click', async () => {
  await submitHostImport();
});

el('import-host-id')?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  await submitHostImport();
});

el('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = el('auth-username-input').value.trim();
  const password = el('auth-password-input').value;
  const confirmPassword = el('auth-password-confirm-input').value;
  const token = el('auth-token-input').value.trim();

  try {
    if (state.auth.setupRequired) {
      if (!username || !password || !confirmPassword) {
        throw new Error('Username, password, and confirmation are required.');
      }
      await setupRelayAccount(username, password, confirmPassword);
    } else if (token && !password) {
      await loginRelay({ token });
    } else {
      if (!username || !password) {
        throw new Error('Username and password are required.');
      }
      await loginRelay({ username, password });
    }
    el('auth-password-input').value = '';
    el('auth-password-confirm-input').value = '';
    el('auth-token-input').value = '';
  } catch (error) {
    state.auth.error = error.message || 'Login failed.';
    renderAuthGate();
  }
});

el('account-button').addEventListener('click', () => {
  state.auth.accountOpen = true;
  state.auth.accountError = '';
  el('account-current-password-input').value = '';
  el('account-new-password-input').value = '';
  el('account-confirm-password-input').value = '';
  el('account-recovery-token-input').value = '';
  renderAccountDialog();
});

el('close-account-dialog-button').addEventListener('click', () => {
  state.auth.accountOpen = false;
  renderAccountDialog();
});

el('account-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    state.auth.accountOpen = false;
    renderAccountDialog();
  }
});

el('account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await changeRelayPassword({
      username: el('account-username-input').value.trim(),
      currentPassword: el('account-current-password-input').value,
      recoveryToken: el('account-recovery-token-input').value.trim(),
      newPassword: el('account-new-password-input').value,
      confirmPassword: el('account-confirm-password-input').value,
    });
    el('account-current-password-input').value = '';
    el('account-new-password-input').value = '';
    el('account-confirm-password-input').value = '';
    el('account-recovery-token-input').value = '';
  } catch (error) {
    state.auth.accountError = error.message || 'Unable to update password.';
    renderAccountDialog();
  }
});

el('logout-button').addEventListener('click', async () => {
  try {
    await logoutRelay();
  } catch (error) {
    reportError(error);
  }
});

el('toggle-language-button').addEventListener('click', () => {
  state.ui.locale = currentLocale() === 'zh-CN' ? 'en' : 'zh-CN';
  persistUiSettings();
  renderAll();
});

el('open-settings-button').addEventListener('click', () => {
  openSettingsDialog();
});

el('close-settings-button').addEventListener('click', () => {
  closeSettingsDialog();
});

el('settings-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeSettingsDialog();
  }
});

el('clear-api-key-button').addEventListener('click', () => {
  const profile = getSelectedApiProfile();
  if (!profile) {
    return;
  }
  const hasKey = Boolean(profile.apiKey || el('settings-api-key').value);
  if (hasKey && !window.confirm(formatUiText('settings.clearKeyConfirm', {
    profile: profile.label || profile.provider || profile.profileId,
  }))) {
    return;
  }
  profile.apiKey = '';
  profile.rememberApiKey = false;
  el('settings-api-key').value = '';
  el('settings-api-key-remember').checked = false;
  persistUiSettings();
});

el('settings-api-profile-select').addEventListener('change', (event) => {
  saveActiveApiProfileFromSettingsForm();
  state.ui.selectedApiProfileId = event.target.value;
  populateSettingsForm();
});

el('settings-add-api-profile-button').addEventListener('click', () => {
  saveActiveApiProfileFromSettingsForm();
  const next = normalizeApiProfile({
    profileId: makeApiProfileId(),
    label: `API Profile ${getApiProfiles().length + 1}`,
    provider: 'OpenAI',
  }, getApiProfiles().length);
  state.ui.apiProfiles.push(next);
  state.ui.selectedApiProfileId = next.profileId;
  populateSettingsForm();
});

el('settings-delete-api-profile-button').addEventListener('click', () => {
  const profiles = getApiProfiles();
  if (profiles.length <= 1) {
    return;
  }
  const deletedId = state.ui.selectedApiProfileId;
  const deletedProfile = getApiProfile(deletedId);
  const affectedHosts = Object.entries(state.ui.hostApiProfiles || {})
    .filter(([, profileId]) => profileId === deletedId)
    .map(([hostId]) => getHost(hostId)?.label || hostId);
  const confirmKey = affectedHosts.length
    ? 'settings.deleteProfileConfirmWithHosts'
    : 'settings.deleteProfileConfirm';
  const confirmed = window.confirm(formatUiText(confirmKey, {
    profile: deletedProfile?.label || deletedProfile?.provider || deletedId,
    hosts: affectedHosts.join(', '),
  }));
  if (!confirmed) {
    return;
  }
  state.ui.apiProfiles = profiles.filter((profile) => profile.profileId !== deletedId);
  if (state.ui.defaultApiProfileId === deletedId) {
    state.ui.defaultApiProfileId = state.ui.apiProfiles[0]?.profileId || 'default';
  }
  for (const [hostId, profileId] of Object.entries(state.ui.hostApiProfiles || {})) {
    if (profileId === deletedId) {
      delete state.ui.hostApiProfiles[hostId];
    }
  }
  state.ui.selectedApiProfileId = state.ui.defaultApiProfileId;
  populateSettingsForm();
});

el('settings-default-api-profile').addEventListener('change', (event) => {
  state.ui.defaultApiProfileId = event.target.value || getApiProfiles()[0]?.profileId || 'default';
});

el('settings-host-api-list').addEventListener('change', (event) => {
  const select = event.target.closest('[data-host-api-profile-host]');
  if (!select) {
    return;
  }
  const hostId = select.dataset.hostApiProfileHost;
  if (!select.value) {
    delete state.ui.hostApiProfiles[hostId];
    return;
  }
  state.ui.hostApiProfiles[hostId] = select.value;
});

el('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.ui.locale = el('settings-language-select').value === 'en' ? 'en' : 'zh-CN';
  saveActiveApiProfileFromSettingsForm();
  state.ui.defaultApiProfileId = el('settings-default-api-profile').value || getApiProfiles()[0]?.profileId || 'default';
  for (const select of el('settings-host-api-list').querySelectorAll('[data-host-api-profile-host]')) {
    const hostId = select.dataset.hostApiProfileHost;
    if (select.value) {
      state.ui.hostApiProfiles[hostId] = select.value;
    } else {
      delete state.ui.hostApiProfiles[hostId];
    }
  }
  persistUiSettings();
  closeSettingsDialog();
  renderAll();
});

el('open-connector-manager-button').addEventListener('click', () => {
  openConnectorManager();
});

el('close-connector-manager-button').addEventListener('click', () => {
  closeConnectorManager();
});

el('connector-manager-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeConnectorManager();
  }
});

el('new-connector-button').addEventListener('click', () => {
  state.connectorEditorId = null;
  renderConnectorManager();
});

el('connector-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveConnectorProfile();
  } catch (error) {
    reportError(error);
  }
});

el('delete-connector-button').addEventListener('click', async () => {
  try {
    await deleteSelectedConnector();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-command-button').addEventListener('click', async () => {
  try {
    await copyConnectorBootstrapCommand();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-login-button').addEventListener('click', async () => {
  try {
    await copyConnectorLoginCommand();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-smoke-button').addEventListener('click', async () => {
  try {
    await copyConnectorSmokeCommand();
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-smoke-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('smoke_test');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-status-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('status');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-bootstrap-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('bootstrap');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-restart-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('restart');
  } catch (error) {
    reportError(error);
  }
});

el('import-selected-host-button').addEventListener('click', async () => {
  if (!state.selectedHostId) {
    reportError(new Error('No host selected.'));
    return;
  }

  try {
    await importHost(state.selectedHostId);
  } catch (error) {
    reportError(error);
  }
});

el('join-session-button').addEventListener('click', async () => {
  try {
    await joinLiveSession();
  } catch (error) {
    reportError(error);
  }
});

el('resume-session-button').addEventListener('click', async () => {
  try {
    const session = getSelectedSession();
    if (session?.live) {
      await endCurrentSession();
    } else {
      await resumeFromHistory();
    }
  } catch (error) {
    reportError(error);
  }
});

el('fork-session-button').addEventListener('click', async () => {
  try {
    await forkNewBranch();
  } catch (error) {
    reportError(error);
  }
});

el('toggle-alerts-button').addEventListener('click', () => {
  toggleAlertWindow();
});

el('toggle-status-button').addEventListener('click', () => {
  toggleStatusWindow();
});

el('session-details-button').addEventListener('click', () => {
  if (!getSelectedSession()) {
    return;
  }
  state.sessionDetailsOpen = true;
  renderSessionDetails();
});

el('session-detail-panel').addEventListener('click', (event) => {
  if (event.target.closest('button')) {
    return;
  }
  if (!getSelectedSession()) {
    return;
  }
  state.sessionDetailsOpen = true;
  renderSessionDetails();
});

el('session-details-close-button').addEventListener('click', () => {
  state.sessionDetailsOpen = false;
  renderSessionDetails();
});

el('session-details-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    state.sessionDetailsOpen = false;
    renderSessionDetails();
  }
});

el('runtime-modal-open-status-button').addEventListener('click', () => {
  state.sessionDetailsOpen = false;
  setStatusWindowOpen(true);
  renderSessionDetails();
  renderRuntimePanel();
});

el('close-alerts-button').addEventListener('click', () => {
  setAlertWindowOpen(false);
});

el('session-log').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-text]');
  if (!button) {
    return;
  }
  try {
    await copyTextToClipboard(button.dataset.copyText || '');
    flashCopyButton(button);
  } catch (error) {
    reportError(error);
  }
});

el('alerts-fab').addEventListener('click', () => {
  setAlertWindowOpen(true);
});

el('close-status-window-button').addEventListener('click', () => {
  setStatusWindowOpen(false);
});

el('status-window-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    setStatusWindowOpen(false);
  }
});

el('refresh-status-button').addEventListener('click', async () => {
  try {
    await refresh();
    await loadReceivedFilesForSession(getSelectedSession(), { force: true });
  } catch (error) {
    reportError(error);
  }
});

el('interrupt-turn-button').addEventListener('click', async () => {
  try {
    await interruptActiveTurn({ restoreDraft: true });
  } catch (error) {
    reportError(error);
  }
});

el('end-session-button').addEventListener('click', async () => {
  try {
    await endCurrentSession();
  } catch (error) {
    reportError(error);
  }
});

el('end-session-status-button').addEventListener('click', async () => {
  try {
    await endCurrentSession();
  } catch (error) {
    reportError(error);
  }
});

el('compact-thread-button').addEventListener('click', async () => {
  try {
    await compactCurrentThread();
  } catch (error) {
    reportError(error);
  }
});

el('steer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('steer-input');
  const text = input.value.trim();
  if (!text) {
    return;
  }

  input.value = '';
  try {
    await steerActiveTurn(text);
  } catch (error) {
    reportError(error);
  }
});

el('inline-steer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('inline-steer-input');
  const text = input.value.trim();
  if (!text) {
    return;
  }

  input.value = '';
  try {
    await steerActiveTurn(text);
  } catch (error) {
    reportError(error);
  }
});

el('shell-command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('shell-command-input');
  const command = input.value.trim();
  if (!command) {
    return;
  }

  input.value = '';
  try {
    await runThreadShellCommand(command);
  } catch (error) {
    reportError(error);
  }
});

el('inline-shell-command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('inline-shell-command-input');
  const command = input.value.trim();
  if (!command) {
    return;
  }

  input.value = '';
  try {
    await runThreadShellCommand(command);
  } catch (error) {
    reportError(error);
  }
});

el('new-session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createFreshSession();
  } catch (error) {
    reportError(error);
  }
});

el('toggle-overview-button')?.addEventListener('click', () => {
  state.overviewCollapsed = !state.overviewCollapsed;
  renderAll();
});

el('toggle-new-session-button').addEventListener('click', () => {
  state.newSessionCollapsed = !state.newSessionCollapsed;
  renderAll();
});

el('toggle-navigator-button').addEventListener('click', () => {
  closeMobileSelectMenus();
  state.navigatorCollapsed = !state.navigatorCollapsed;
  writeLocalStorageJson(NAVIGATOR_COLLAPSED_STORAGE_KEY, state.navigatorCollapsed);
  renderAll();
});

el('close-sidebar-navigator-button')?.addEventListener('click', () => {
  closeMobileSelectMenus();
  state.navigatorCollapsed = true;
  writeLocalStorageJson(NAVIGATOR_COLLAPSED_STORAGE_KEY, state.navigatorCollapsed);
  renderAll();
});

el('session-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
});

el('session-search-input').addEventListener('input', (event) => {
  setSessionSearchQuery(event.target.value);
});

el('session-search-mode').addEventListener('change', (event) => {
  closeMobileSelectMenus();
  setSessionSearchMode(event.target.value);
});

el('session-search-mode-button')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleMobileSelectMenu('searchMode');
});

el('clear-session-search-button').addEventListener('click', () => {
  el('session-search-input').value = '';
  setSessionSearchQuery('');
});

el('session-collection-select')?.addEventListener('change', (event) => {
  closeMobileSelectMenus();
  state.selectedCollectionId = event.target.value || 'default';
  renderAll();
});

el('session-collection-button')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleMobileSelectMenu('collection');
});

el('collection-menu-button')?.addEventListener('click', (event) => {
  if (window.matchMedia('(max-width: 980px)').matches) {
    event.preventDefault();
    event.stopPropagation();
    toggleMobileSelectMenu('collection');
    return;
  }
  el('session-collection-select')?.focus();
});

el('collection-settings-button')?.addEventListener('click', () => {
  state.collectionManagerOpen = !state.collectionManagerOpen;
  renderAll();
});

el('close-collection-manager-button')?.addEventListener('click', () => {
  state.collectionManagerOpen = false;
  renderAll();
});

async function submitCollectionCreate() {
  const input = el('collection-name-input');
  const name = input.value.trim();
  if (!name) {
    return;
  }
  input.value = '';
  try {
    await createSessionCollection(name);
  } catch (error) {
    reportError(error);
  }
}

el('create-collection-button')?.addEventListener('click', async () => {
  await submitCollectionCreate();
});

el('collection-name-input')?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  await submitCollectionCreate();
});

el('use-selected-path-button').addEventListener('click', () => {
  useSelectedSessionPath();
});

el('host-switcher').addEventListener('change', async (event) => {
  const hostId = event.target.value;
  if (hostId) {
    try {
      closeMobileSelectMenus();
      await setSelectedHost(hostId);
    } catch (error) {
      event.target.value = state.selectedHostId || '';
      reportError(error);
    }
  }
});

el('host-switcher-button')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleMobileSelectMenu('hostSwitcher');
});

el('browse-directory-button').addEventListener('click', async () => {
  try {
    await openDirectoryPicker();
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('close-directory-picker-button').addEventListener('click', () => {
  closeDirectoryPicker();
});

el('directory-picker-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeDirectoryPicker();
  }
});

el('picker-up-button').addEventListener('click', async () => {
  if (!state.directoryPicker.parentPath) {
    return;
  }

  try {
    await browseDirectoryPath(state.directoryPicker.parentPath);
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('picker-refresh-button').addEventListener('click', async () => {
  try {
    await fetchDirectoryListing(state.directoryPicker.currentPath || null);
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('picker-select-button').addEventListener('click', () => {
  applyPickedDirectory();
});

el('codex-model-refresh-button').addEventListener('click', async () => {
  try {
    await loadModelOptionsForSelectedSession();
  } catch (error) {
    reportError(error);
  }
});

el('codex-model-select').addEventListener('change', () => {
  const select = el('codex-model-select');
  const input = el('codex-model-input');
  if (input && select) {
    input.value = select.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  saveComposerOptionsFromControls();
});

el('codex-model-input').addEventListener('input', () => {
  const session = getSelectedSession();
  syncModelSelectFromInput(session);
  renderReasoningEffortOptions(session);
  saveComposerOptionsFromControls(session);
});

[
  'codex-effort-select',
  'codex-summary-select',
  'codex-mode-select',
  'codex-approval-policy-select',
  'codex-reviewer-select',
  'codex-sandbox-mode-select',
  'codex-personality-select',
].forEach((id) => {
  el(id).addEventListener('change', () => {
    saveComposerOptionsFromControls();
    if (id === 'codex-effort-select' || id === 'codex-reviewer-select') {
      renderComposerTurnNotice();
    }
  });
});

el('codex-file-picker-button').addEventListener('click', () => {
  el('codex-image-files')?.click();
});

el('codex-image-files').addEventListener('change', async (event) => {
  try {
    await addComposerFiles(event.target.files);
  } catch (error) {
    reportError(error);
  } finally {
    event.target.value = '';
  }
});

el('codex-local-image-path').addEventListener('input', () => {
  renderAttachmentChips();
});

el('codex-attachment-chips').addEventListener('click', (event) => {
  const removeButton = event.target.closest('.attachment-chip-remove');
  if (!removeButton) {
    return;
  }
  if (removeButton.dataset.clearLocalImage) {
    const input = el('codex-local-image-path');
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  removeComposerAttachment(Number(removeButton.dataset.attachmentIndex));
});

el('codex-clear-attachments-button').addEventListener('click', () => {
  clearComposerFileAttachments();
});

el('codex-plan-button').addEventListener('click', async () => {
  const input = el('input-text');
  try {
    const payload = await buildComposerPayload(input.value, { mode: 'plan' });
    if (!payload.text && !payload.inputItems.length) {
      return;
    }
    await submitComposerPayload(payload, input);
  } catch (error) {
    reportError(error);
  }
});

el('codex-review-button').addEventListener('click', async () => {
  try {
    await startReviewForCurrentSession();
  } catch (error) {
    reportError(error);
  }
});

el('codex-interrupt-button').addEventListener('click', async () => {
  try {
    await interruptActiveTurn({ restoreDraft: true });
  } catch (error) {
    reportError(error);
  }
});

el('composer-force-send-button').addEventListener('click', async () => {
  try {
    await interruptAndSendPendingPrompt();
  } catch (error) {
    reportError(error);
  }
});

el('composer-turn-notice').addEventListener('input', (event) => {
  const textarea = event.target.closest('[data-steer-queue-text]');
  if (!textarea) {
    return;
  }
  const item = findSteerQueueItem(textarea.dataset.steerQueueText);
  setSteerQueueItemText(item, textarea.value);
});

el('composer-turn-notice').addEventListener('click', async (event) => {
  const removeButton = event.target.closest('[data-remove-steer-queue-id]');
  if (removeButton) {
    removeSteerQueueItem(removeButton.dataset.removeSteerQueueId);
    renderComposerTurnNotice();
    return;
  }

  const forceButton = event.target.closest('[data-force-steer-queue-id]');
  if (forceButton) {
    try {
      await interruptAndSendQueuedPrompt(forceButton.dataset.forceSteerQueueId);
    } catch (error) {
      reportError(error);
    }
    return;
  }

  const guideButton = event.target.closest('[data-guide-steer-queue-id]');
  if (!guideButton) {
    return;
  }
  try {
    await guideQueuedPrompt(guideButton.dataset.guideSteerQueueId);
  } catch (error) {
    reportError(error);
  }
});

el('input-text').addEventListener('keydown', (event) => {
  if (state.slashMenu.open) {
    const commands = getFilteredSlashCommands();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.slashMenu.selectedIndex = commands.length
        ? (state.slashMenu.selectedIndex + 1) % commands.length
        : 0;
      renderSlashMenu();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.slashMenu.selectedIndex = commands.length
        ? (state.slashMenu.selectedIndex - 1 + commands.length) % commands.length
        : 0;
      renderSlashMenu();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (commands.length) {
        event.preventDefault();
        executeSlashCommand(commands[state.slashMenu.selectedIndex]).catch(reportError);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSlashMenu();
      return;
    }
  }

  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el('input-form').requestSubmit();
  }
});

el('input-text').addEventListener('input', () => {
  updateSlashMenuFromInput();
});

el('input-text').addEventListener('click', () => {
  updateSlashMenuFromInput();
});

el('input-form').addEventListener('dragenter', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setComposerDragActive(true);
});

el('input-form').addEventListener('dragover', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'copy';
  setComposerDragActive(true);
});

el('input-form').addEventListener('dragleave', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  if (!event.currentTarget.contains(event.relatedTarget)) {
    setComposerDragActive(false);
  }
});

el('input-form').addEventListener('drop', handleComposerDrop);

document.addEventListener('click', (event) => {
  if (!hasOpenMobileSelectMenu()) {
    return;
  }
  if (event.target.closest('.mobile-select-anchor')) {
    return;
  }
  closeMobileSelectMenus();
  renderAll();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  if (hasOpenMobileSelectMenu()) {
    closeMobileSelectMenus();
    renderAll();
  }

  if (state.slashMenu.open) {
    hideSlashMenu();
  }

  if (state.connectorManagerOpen) {
    closeConnectorManager();
  }

  if (state.directoryPicker.open) {
    closeDirectoryPicker();
  }

  if (state.statusWindowOpen) {
    setStatusWindowOpen(false);
  }

  if (state.sessionDetailsOpen) {
    state.sessionDetailsOpen = false;
    renderSessionDetails();
  }

  if (state.settingsOpen) {
    closeSettingsDialog();
  }

  if (state.auth.accountOpen) {
    state.auth.accountOpen = false;
    renderAccountDialog();
  }
});

el('input-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('input-text');
  try {
    const payload = await buildComposerPayload(input.value);
    if (!payload.text && !payload.inputItems.length) {
      return;
    }
    await submitComposerPayload(payload, input);
  } catch (error) {
    reportError(error);
  }
});

async function boot() {
  try {
    const authenticated = await refreshAuthState();
    if (authenticated) {
      await refresh();
    }
  } catch (error) {
    reportError(error);
  }
}

initializePersistentUiState();
boot();

setInterval(() => {
  if (!authAllowsRequests()) {
    return;
  }
  renderRuntimePanel();
  renderThinkingPanel();
  renderApprovalPopup();
  renderStatusWindow();
}, 1000);

setInterval(() => {
  if (!authAllowsRequests()) {
    return;
  }
  refresh().catch(reportError);
}, 8000);
