# 拾迹 TraceHub

<p align="center"><img src="assets/icon.png" alt="拾迹 TraceHub" width="96"></p>

仓库：[https://github.com/gatesenman/tracehub](https://github.com/gatesenman/tracehub)

本机桌面应用（Electron）。把多款浏览器的**浏览历史**汇到一处，并在关机前把**真实已打开的页签**保存成可整理、可分批恢复的快照。

当前版本 **1.2.2**（加固测试版，待实机验收；1.2.0 / 1.2.1 源码目录与旧产物另行保留，不要把旧的 1.2.1 安装包当本版使用）。统一名称是「拾迹 TraceHub」（不再使用 Browser History Hub 作为对外名称）。

## 下载（Windows，1.2.2）

发行页：[GitHub Releases v1.2.2](https://github.com/gatesenman/tracehub/releases/tag/v1.2.2)

| 包 | 用途 | SHA256 | 下载 |
|---|---|---|---|
| `TraceHub-1.2.2-setup.exe` | NSIS 安装包（83,733,975 字节） | `f070d9098cbc5b3ac76d1824a7aef537d65b787edb55902a91710eb78bbc411d` | [下载 Setup](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-setup.exe) |
| `TraceHub-1.2.2-portable.exe` | 便携版（73,366,031 字节） | `0a2b34a04a351dcc504533836c4d4640b8179d4190271e5f97feee3cd80b7ed4` | [下载便携版](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-portable.exe) |
| `TraceHub-1.2.2-extension.zip` | Chrome / Edge 扩展 | `009ee66cdc921182a71532ebd9af34a0b9fc1a0b2b8a5d7549a9775cedd2a7af` | [下载扩展](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-extension.zip) |

安装包未代码签名。Windows 产物**尚未在真机运行验收**，不能称为已完成 Windows 烟测。不要再分发 1.2.1 安装包。试用步骤见 [docs/Windows试用检查单.md](docs/Windows试用检查单.md)，验收范围见 [docs/验收记录.md](docs/验收记录.md) 与 [docs/1.2.2-release.md](docs/1.2.2-release.md)。

产品主界面的清晰截图目前缺失，待补；仓库仅有应用图标 `assets/icon.png`，本次不使用生成或虚构界面图。


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

1. 启动应用，在「设置 → 页签快照桥接」复制配对令牌。
2. 在 Chrome 或 Edge 打开扩展页，启用开发者模式，加载本仓库中的 `extension` 目录。
3. 在扩展选项中粘贴令牌。点扩展图标，预览并「保存页签快照到本机」。
4. 回到应用的「页签快照」查看、改分组、分批恢复。若要关闭这些页签，必须在应用里勾选风险说明并确认。

没有安装扩展时，可以把扩展或应用导出的 JSON 导入应用，仍可整理和分批用系统默认浏览器打开网址（无法还原窗口布局和固定状态）。

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


---

## English

# TraceHub

**1.2.2** is a hardened test build awaiting real-machine acceptance. Do not use older 1.2.1 installers. The public name is TraceHub (拾迹); “Browser History Hub” is no longer used.

A local-first Electron app that unifies browsing history from multiple browsers and, before shutdown, can save *currently open tabs* as snapshots you can organize and restore in batches.

### Download (Windows)

Release: [v1.2.2](https://github.com/gatesenman/tracehub/releases/tag/v1.2.2)

- Setup: [TraceHub-1.2.2-setup.exe](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-setup.exe) — SHA256 `f070d9098cbc5b3ac76d1824a7aef537d65b787edb55902a91710eb78bbc411d`
- Portable: [TraceHub-1.2.2-portable.exe](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-portable.exe) — SHA256 `0a2b34a04a351dcc504533836c4d4640b8179d4190271e5f97feee3cd80b7ed4`
- Browser extension: [TraceHub-1.2.2-extension.zip](https://github.com/gatesenman/tracehub/releases/download/v1.2.2/TraceHub-1.2.2-extension.zip)

Builds are unsigned. Windows packages have **not** been run on a real Windows machine according to the project’s own acceptance notes, so they are not claimed as Windows smoke-tested. Clear product UI screenshots are not in the repo yet and are left as a follow-up; only the app icon is present, and no generated UI images are used.

### Features and limits

- History sync for Chrome / Edge / Brave / Vivaldi / Opera (Windows) / Firefox profiles, after you opt in during onboarding.
- Tab snapshots via a Chrome / Edge extension; Firefox open tabs cannot be captured automatically in this release (JSON import is supported).
- Optional AI features; API keys stay in local `config.json` and never enter the renderer.
- Auto screenshot and auto content fetch are off by default.
- Tab restore reopens URLs only — it cannot restore logins, unsaved forms, or exact window state. The app does not take over OS shutdown.

### Run from source

Node.js 18+ (20 recommended):

```bash
npm ci
npm run rebuild   # rebuild better-sqlite3 for Electron 31
npm start
```

Windows packages: `npm run pack:win`. Cross-packing on Linux can check file format only; it does not replace a Windows smoke test. Tests: `npm test`, `npm run check`. See the Chinese sections above and `docs/验收记录.md`.
