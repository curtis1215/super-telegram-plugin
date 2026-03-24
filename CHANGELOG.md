# Changelog

所有重要變更都會記錄在此檔案中。格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/)，版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [1.5.3] - 2026-03-24

### 錯誤修復

- 修正 socket open callback 中 `this.socket` 尚未賦值導致 `onConnect` 中的 `send()` 全部失敗的問題

## [1.5.2] - 2026-03-24

### 錯誤修復

- 持久化 session name 至 `session-name` 檔案，新 proxy 啟動時自動讀取並向 daemon 註冊，解決 session 關閉後 Telegram 訊息無法送達的問題

## [1.5.1] - 2026-03-24

### 錯誤修復

- 移除 `launchctl kickstart -k` 的 `-k` 旗標，避免多 session 同時啟動時反覆殺掉運行中的 daemon 導致已連線 proxy 斷線

## [1.5.0] - 2026-03-24

### 新功能

- 新增 `access` MCP tool — 9 個 action 涵蓋配對審批、白名單管理、DM 策略、群組權限、送達設定
- 新增 `configure` MCP tool — 查看狀態、設定/清除 bot token，未配置時也可使用
- 所有 access 和 configure 操作完全程式化，不再依賴 LLM 操作檔案系統

## [1.4.0] - 2026-03-24

### 新功能

- 新增 `connect_session` 和 `disconnect_session` MCP tools，session 註冊改為程式化處理
- LLM 呼叫 tool 即可完成連線，不再需要透過檔案系統 signal 操作

## [1.3.1] - 2026-03-24

### 新功能

- 新增 `commands/` 目錄，讓 `/super-telegram:*` 指令出現在 Claude Code autocomplete 下拉選單

## [1.3.0] - 2026-03-24

### 新功能

- 重新命名 plugin 為 `super-telegram`，skill 前綴變更為 `/super-telegram:*`
- 將 `node_modules/` 納入版控，安裝時不再需要另行執行 `bun install`
- 安裝來源改為 GitHub URL，支援 `claude plugin marketplace add https://github.com/...` 直接安裝

## [1.2.2] - 2026-03-24

### 錯誤修復

- 修正 skill frontmatter 格式：`user_invocable` 改為 `user-invocable`（連字號），讓 Claude Code 能正確識別可呼叫的 skill

## [1.2.1] - 2026-03-24

### 錯誤修復

- 修正 `.mcp.json` 格式：加上 `mcpServers` 外層包裝，讓 Claude Code 能正確辨識並啟動 MCP server
- 修正啟動指令，加上 `--shell=bun` 參數，與官方 plugin 格式一致

## [1.2.0] - 2026-03-24

### 新功能

- 新增 `.mcp.json`，讓 Claude Code 能自動啟動 MCP proxy server 並註冊 skills

### 錯誤修復

- 修正 `.mcp.json` 為 plugin-scoped 格式（移除 `mcpServers` 外層包裝）
- 修正 README 安裝指令為正確的 marketplace 兩步驟流程

## [1.1.0] - 2026-03-24

### 新功能

- 新增 `.claude-plugin/marketplace.json`，支援透過 `claude plugin marketplace add` 安裝流程

## [1.0.0] - 2026-03-24

### 新功能

- 集中式 daemon + 輕量 proxy 架構，取代原有的單進程 polling 模式
- Daemon 持有唯一的 grammY polling 連線，根除 409 Conflict 問題
- 多 session 支援：session 註冊表、心跳偵測、active session 路由
- Unix domain socket 通訊協議（JSON line-delimited）
- Telegram bot 指令：`/list`、`/switch`、`/status`、`/disconnect`
- `/telegram:connect` skill 用於註冊 session 名稱
- 環境變數 `TELEGRAM_SESSION_NAME` 支援啟動時自動註冊
- Daemon 自動啟動（macOS launchd / Linux systemd）
- 訊息緩衝機制：active session 斷線重連時保留最多 50 則訊息
- 狀態持久化（`router-state.json`）：daemon 重啟後自動恢復路由目標
- 日誌輪替（10MB 上限，最多保留 3 個歷史檔案）

### 相容性

- 完全相容現有 `~/.claude/channels/telegram/` 目錄結構
- 沿用 `.env`、`access.json` 設定檔，零配置遷移
- MCP tools 介面不變：`reply`、`react`、`edit_message`、`download_attachment`
- Channel notification 格式不變（`<channel source="telegram" ...>`）
