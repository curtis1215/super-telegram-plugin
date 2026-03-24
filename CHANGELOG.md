# Changelog

所有重要變更都會記錄在此檔案中。格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/)，版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

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
