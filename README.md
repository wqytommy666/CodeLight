# CodeLight

把 `JTX-RGB / Colorful Lights` 拾音灯变成 AI 编程 Agent 的实体状态灯。BLE 控制器使用 macOS 原生 CoreBluetooth；常驻后台后不需要打开手机 App，也不需要网络。

## 已绑定的本机设备

`device.id` 保存了这台 Mac 为 `JTX-RGB` 分配的 CoreBluetooth peripheral UUID。这里的“绑定”是保存设备标识并按需直连；该灯不要求在 macOS 蓝牙设置中做传统配对。

## BLE 探测

```bash
./run.sh probe
./run.sh scan 15
```

探测成功会输出 `CONNECTED`、服务/特征列表以及 `PROBE_OK`。

## 手动灯光控制

```bash
./light.sh green
./light.sh yellow
./light.sh blue
./light.sh red
./light.sh test
./light.sh blink red 3 0.4
./light.sh off
```

`test` 会按红、黄、蓝、绿依次显示，并最终停在绿色。`blink` 在闪烁结束后保持熄灭。

## AI 编程工具状态灯

### 状态约定

| 灯色 | 场景 | 何时熄灭 |
|---|---|---|
| 绿 | 当前任务/回合完成 | 爆闪后常亮 60 秒；新的完成事件会立即重新爆闪并刷新计时 |
| 黄 | 等待工具授权、系统权限或有副作用操作确认 | 授权后工具开始运行，或提交新消息时 |
| 蓝 | AI 正在询问普通问题、要求补充内容或选择方案 | 提交回答时 |
| 红 | 明确的工具失败、模型/API、网络、认证或限流故障 | 后续活动恢复、重试成功或提交新消息时 |
| 灭 | 正常处理中或没有待处理状态 | — |

每次进入有色状态都会先 **快速爆闪 3 次**，然后稳定常亮。处理完事件会立即取消尚未完成的闪烁序列并熄灭。多任务同时存在时按 `红 > 黄 > 蓝 > 绿` 聚合显示。

### 安装

```bash
./install.sh
```

回归测试：

```bash
python3 -m unittest discover -s tests -v
cd desktop-app && npm run check
```

安装内容：

- `~/.agent-status-light/bin/agent-light-daemon-*`：由 CodeLight 应用持有的 BLE 子进程，避免每个事件重新连接的延迟，并让系统把蓝牙权限明确归属给 CodeLight。
- `~/.agent-status-light/bin/agent-light-hook`：毫秒级本地 hook 客户端。
- `~/.agent-status-light/bin/agent-light-watch`：补足 Codex 在模型/API 请求直接失败时不会发出 Stop hook 的情况，0.5 秒轮询本地 rollout 增量。
- `~/Library/LaunchAgents/com.local.agent-status-light-watch.plist`：让上述 Codex 故障监听器登录后常驻。
- 已有的 Ping Island / Coffee hook relay：复用其 Claude 与 Codex 生命周期入口，不重复建立另一套监控器；修改前自动生成 `*.before-agent-light` 备份。
- Claude `PostToolUseFailure` hook：补充明确失败事件。

Claude 桌面版的本地 Agent/Cowork 会启动内置 Claude Code，并使用同一份 `~/.claude/settings.json`，因此也会进入这套状态灯逻辑。普通聊天页如果没有启动本地 Agent，则不会产生工具授权等本地生命周期事件。

这里复用了本机已有的 [Ping Island](https://github.com/erha19/ping-island) 对 Claude/Codex hook 事件的接入方式和 session 状态划分；BLE 协议部分针对这台 JTX-RGB 单独完成。

### 管理命令

```bash
AGENT_LIGHT="$HOME/.agent-status-light/bin/agent-light-hook"

$AGENT_LIGHT status
$AGENT_LIGHT demo yellow       # 爆闪后常亮
$AGENT_LIGHT off               # 立即清空全部状态并熄灭
$AGENT_LIGHT charger-silence on
$AGENT_LIGHT charger-silence off
$AGENT_LIGHT charge hide       # 默认：隐藏充电/电量动画
$AGENT_LIGHT charge show 10    # 临时恢复默认动画 10 秒，然后自动隐藏
```

该型号在充电时会由固件绘制四格动画。后台控制器利用 App 未开放的零亮度值隐藏它，并约每 0.6 秒低频重申一次；不会再用高频开关灯与固件争抢，因此不会人为制造闪烁。这个选项显示为 `charger_silence=on`。

底层固件改造的调查和备份/回刷路径见 [FIRMWARE.md](./FIRMWARE.md)。

日志：

```bash
tail -f ~/.agent-status-light/logs/daemon.log
tail -f ~/.agent-status-light/events.jsonl
```

协议调查见 [PROTOCOL.md](./PROTOCOL.md)。

## 桌面控制台

macOS / Windows 的图形化控制台位于 [`desktop-app`](./desktop-app)。它提供系统通知、通知点击跳转、任意数量跑马灯的独立路由、可配置持续时间、完整事件记录、Provider 管理、四种状态手动测试和充电动画隐藏。首页最多同时展示 8 个设备卡片，更多设备进入完整管理页；Agent 顶栏可自由置顶，未置顶项通过数量入口统一管理。
