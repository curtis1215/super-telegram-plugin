#!/usr/bin/env bun

import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const PLUGIN_DIR = resolve(import.meta.dir, '..')
const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
const BUN_PATH = process.execPath

const command = process.argv[2]

if (!command || !['install', 'uninstall', 'status'].includes(command)) {
  console.log('Usage: bun run scripts/setup-daemon.ts [install|uninstall|status]')
  process.exit(1)
}

const platform = process.platform

if (platform === 'darwin') {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents')
  const plistPath = join(plistDir, 'com.claude.telegram-router.plist')

  if (command === 'install') {
    mkdirSync(plistDir, { recursive: true })
    mkdirSync(STATE_DIR, { recursive: true })

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.telegram-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>run</string>
    <string>daemon/router.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PLUGIN_DIR}</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${join(STATE_DIR, 'router.log')}</string>
</dict>
</plist>`

    writeFileSync(plistPath, plist)
    console.log(`Installed: ${plistPath}`)

    const result = Bun.spawnSync(['launchctl', 'load', plistPath])
    if (result.exitCode === 0) {
      console.log('Daemon loaded and started.')
    } else {
      console.log('Daemon installed but failed to load. Try: launchctl load ' + plistPath)
    }
  } else if (command === 'uninstall') {
    if (existsSync(plistPath)) {
      Bun.spawnSync(['launchctl', 'unload', plistPath])
      unlinkSync(plistPath)
      console.log('Daemon uninstalled.')
    } else {
      console.log('Daemon not installed.')
    }
  } else if (command === 'status') {
    const result = Bun.spawnSync(['launchctl', 'list', 'com.claude.telegram-router'])
    if (result.exitCode === 0) {
      console.log('Daemon is running.')
      console.log(result.stdout.toString())
    } else {
      console.log('Daemon is not running.')
    }
    const pidFile = join(STATE_DIR, 'router.pid')
    if (existsSync(pidFile)) {
      console.log(`PID file: ${readFileSync(pidFile, 'utf8').trim()}`)
    }
  }
} else if (platform === 'linux') {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user')
  const servicePath = join(serviceDir, 'telegram-router.service')

  if (command === 'install') {
    mkdirSync(serviceDir, { recursive: true })
    mkdirSync(STATE_DIR, { recursive: true })

    const service = `[Unit]
Description=Telegram Router Daemon for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${BUN_PATH} run daemon/router.ts
WorkingDirectory=${PLUGIN_DIR}
Restart=always
RestartSec=5
StandardError=append:${join(STATE_DIR, 'router.log')}

[Install]
WantedBy=default.target`

    writeFileSync(servicePath, service)
    console.log(`Installed: ${servicePath}`)

    Bun.spawnSync(['systemctl', '--user', 'daemon-reload'])
    const result = Bun.spawnSync(['systemctl', '--user', 'enable', '--now', 'telegram-router'])
    if (result.exitCode === 0) {
      console.log('Daemon enabled and started.')
    } else {
      console.log('Daemon installed but failed to start. Try: systemctl --user start telegram-router')
    }
  } else if (command === 'uninstall') {
    if (existsSync(servicePath)) {
      Bun.spawnSync(['systemctl', '--user', 'disable', '--now', 'telegram-router'])
      unlinkSync(servicePath)
      Bun.spawnSync(['systemctl', '--user', 'daemon-reload'])
      console.log('Daemon uninstalled.')
    } else {
      console.log('Daemon not installed.')
    }
  } else if (command === 'status') {
    const result = Bun.spawnSync(['systemctl', '--user', 'status', 'telegram-router'])
    console.log(result.stdout.toString())
    const pidFile = join(STATE_DIR, 'router.pid')
    if (existsSync(pidFile)) {
      console.log(`PID file: ${readFileSync(pidFile, 'utf8').trim()}`)
    }
  }
} else {
  console.log(`Unsupported platform: ${platform}. Only macOS (launchd) and Linux (systemd) are supported.`)
  process.exit(1)
}
