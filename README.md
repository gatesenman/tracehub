# 拾迹 TraceHub

本机桌面应用（Electron）。把多款浏览器的**浏览历史**汇到一处，并在关机前把**真实已打开的页签**保存成可整理、可分批恢复的快照。

当前版本 **1.2.5**（加固测试版，待实机验收；1.2.0 / 1.2.1 源码目录与旧产物另行保留，不要把旧的 1.2.1 安装包当本版使用）。统一名称是「拾迹 TraceHub」（不再使用 Browser History Hub 作为对外名称）。

## 它能做什么

- **多浏览器历史**：自动检测 Chrome / Edge / Brave / Vivaldi / Opera（Windows）/ Firefox 的多 Profile 历史，支持 Windows / macOS / Linux 的读取路径。需你在首次引导中勾选允许同步的配置后才会导入。
- **实时同步**：文件监听 + 轮询兜底 + 窗口聚焦同步；直接解析 SQLite WAL，Firefox 未 checkpoint 的访问也能读到。
- **时间树与今日总览**：按日 → 小时 → 域名浏览；今日页含 24 小时分布、会话、稍后读、时间黑洞等。
- **搜索**：关键词、时间词（昨天 / 近 7 天 / 上周…）、`site:域名`；可选 AI 语义搜索与「问历史」。
- **收藏与稍后读**：星标只收藏；稍后读需单独添加（右键）。收藏支持文件夹、导入浏览器书签、离线正文等。
- **可选 AI**：整理、每日摘要、报告、智能合集。未配置 Key 时用本地规则。Key 只存在本机 `config.json`，不进入渲染进程。设置里可以清除密钥。
- **页签快照 / 关机前整理（1.2.2 加固测试版）**：通过 Chrome / Edge 扩展保存当前已打开页签（窗口、顺序、固定页签、分组信息）。快照成功写入本机后，才允许你确认关闭。默认不关。可本地预分类、去重、按组、分批恢复。可选 AI 补充网站用途与简介（默认只发送网址和标题）。
- **隐私**：隐私暂停、域名黑名单（需确认）、噪音净化、备份恢复。自动截图与自动抓取正文**默认关闭**，暂停期间也不会跑。
- **导出**：历史可导出 CSV / JSON（文件名以 `TraceHub-` 开头）。快照可单独导出 JSON。

## 运行

需要 Node.js 18+（推荐 20）。

```bash
npm ci          # 或 npm install
npm run rebuild # 针对 Electron 31 重建 better-sqlite3（Node 单测请再用 npm rebuild better-sqlite3 恢复）
npm start
```

### 页签快照（Chrome / Edge）

1. 在 TraceHub 的页签快照页或设置中，点击「打开扩展目录」，再点击「打开 Chrome 扩展页」或「打开 Edge 扩展页」。
2. 在浏览器扩展页打开开发者模式，选择「加载已解压的扩展程序」，选中刚才打开的目录（里面有 `manifest.json`）。应用不会替你静默安装扩展。
3. 点击「复制配对令牌」，在扩展选项页粘贴并点保存。选项页会向本机应用核对令牌：只有提示配对成功，才算连上。应用在运行不等于已经配对。配对成功后，TraceHub 也会自动提示「扩展已连接」。再到要整理的窗口，点扩展图标保存已打开的页签。
4. 回到应用的「页签快照」查看、改分组、分批恢复。若要关闭这些页签，必须在应用里勾选风险说明并确认。

没有安装扩展时，可以把扩展或应用导出的 JSON 导入应用，仍可整理和分批用系统默认浏览器打开网址（无法还原窗口布局和固定状态）。

活动页签快照、按窗口分组恢复和批量关闭仍然必须安装扩展：Chrome / Edge 的 `chrome.tabs` 等是扩展 API，官方消费级安装路径是商店或企业策略；本应用不使用远程调试、不写企业策略、也不改浏览器配置来偷装。本版也尚未上架 Chrome 网上应用店 / Edge 扩展商店（没有发布账号和审核条件）。卸载时在浏览器扩展页移除即可。

**Firefox**：浏览历史同步可用；本轮**不能**自动采集 Firefox 当前打开的页签，请使用 JSON 导入。

## 首次使用与数据位置

第一次启动会显示引导：勾选要读取历史的浏览器 / Profile，并选择是否开启自动截图、自动抓取正文（默认都关闭）。未完成引导前不会导入新的历史。

数据在应用的 userData 目录（安装版 Windows 一般为 `%APPDATA%/TraceHub/`，开发模式下可能仍带 `browser-history-hub` 目录名，取决于 Electron 的 `name` 字段）。统一库是 `hub.sqlite`，配置是 `config.json`，截图在 `thumbs/`，备份在 `backups/`。删除这些文件即可重置。若你以前用过旧名 BrowserHistoryHub，应用会尝试把旧库复制过来。

API Key 只保存在本机 `config.json`。页签快照的配对令牌也只用于本机 `127.0.0.1` 桥接。

## 关于「写回浏览器」和「恢复原状」

- 不能安全地写回各浏览器自己的历史库。
- 页签恢复是**重新打开网址**，不能恢复登录状态、未提交表单、滚动位置或页面内存。
- 不会接管操作系统的关机过程，只提供手动「关机前整理」入口。
- 不会强杀浏览器进程。扩展关闭页签时，网页自己的“未保存”提示可能不会出现，所以默认不关闭，确认时会明确告知。

## 打包

```bash
npm ci
npm run rebuild
npm run pack:win   # 产出 TraceHub-1.2.2-setup.exe 与 TraceHub-1.2.2-portable.exe
```

`package.json` 目前只配置了 Windows 目标（NSIS 安装包 + portable）。macOS / Linux 可以用 `npm start` 跑源码，**不代表已提供或验证过这些平台的安装包**。在 Linux 上交叉打包时，`afterPack` 会把官方 win32-x64 Electron 31 预编译 `better-sqlite3` 换进产物；这只能证明产物文件格式完整，**不能**代替 Windows 真机运行验证。

命令面板默认入口是 **Ctrl+K**（不是 Alt+Space）。

## 测试

```bash
npm test          # Node 单测 + 集成测试（临时库 / 本机 HTTP 桥 / IPC）。不是真实 Chrome 测试。
npm run check     # 语法检查
npm run smoke     # 可选：Xvfb/无头 Electron 启动冒烟（隔离临时 userData，不导入共享浏览历史）
```

详见 `docs/验收记录.md` 与 `docs/Windows试用检查单.md`。本版是待实机验收的加固测试版，不是「功能已全部成熟」。

## 技术栈

- Electron 31（主进程 + contextIsolation；渲染层为原生 JS）
- better-sqlite3（本机统一库）+ sql.js（只读解析被锁定的浏览器历史，含 WAL 合并）
- 可选 OpenAI 兼容 Chat Completions
- 配套 Chrome / Edge Manifest V3 扩展（官方 tabs / windows / tabGroups API）
