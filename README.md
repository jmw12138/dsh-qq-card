# dsh-qq-card · 答题浮卡

DeepSeek Harness 插件。任何会话在等待 `ask_user_question` 回答时，浏览器右下角弹出带选项的浮动卡片——点一下就答，不用切回那个会话。

> 起因：官方提问界面只在那个会话里出现，开多个会话时很容易错过；鲸鱼挂件（dsh-whale-widget）的「等待交互提示」只有文字气泡、不能作答，而且是单槽位（别的会话一开一关就把挂起抹掉）。

## 功能

- **多会话并存**：每个会话各占一条挂起，互不覆盖
- **点选即答**：单选项点即提交；多选题勾完提交
- **自定义答案**：每题带输入框，回车提交
- **在会话里答**：把这题交还官方界面
- **跳过**：提交空 `selected`（= 用户跳过）
- **10 分钟兜底**：没人答就自动交还官方界面，模型不会干等
- **提示音**：来新题响一声（浏览器要求页面先有一次点击才能出声）
- **深色浮层**：右下角常驻，按会话标题区分

## 安装

这是用 `dsh-boot-suite`/`dsh-drawai` 同一套 bundle 约定的普通插件包（`dsh.bundle.patch` + `dsh.profile.bundles`）。

```bash
# 1) 把它放到 profile 的 node_modules（桌面端只能手工装，CLI 会报
#    profile "desktop" is managed exclusively by the Electron application）
cp -r dsh-qq-card "C:/Users/PC/.dsh/profiles/desktop/node_modules/"

# 2) profile package.json：dependencies 加 "dsh-qq-card": "0.1.0"，
#    dsh.profile.bundles 里追加 "dsh-qq-card"

# 3) 完全退出桌面端再打开（注入表是宿主启动时收集一次，F5 重载不了）
```

宿主侧挂载成功的证据（`~/.dsh/qq-card-diag.log`）：

```
apply: 路由已注册（pending=0）
index-inject: 已推入 card.js 行
[client] card.js 已加载
agent 挂上抢答器 session=session-xxxx
```

## 实现要点（踩过的坑）

- **抢答走宿主侧**：每个 agent 上 `agent.ctx.on('user-questions/request', handler, { prepend: true })`，不调 `next()` 就是自己接管这道题，答案用 `{ answers: [{ id, selected: [...], custom? }] }` resolve。
- **桌面端注入只有一条可靠通道**：`webserver/index-inject` 推**内联 script 行**，由它自己 `createElement('script')` 加载 `/qq-card/card.js` 并吞掉 `onerror`。`tapIndex` 在 Electron 里不生效；`script-src` 行加载失败会 reject `__DSH_BOOT_READY__`（应用起不来）。
- **注入表在宿主启动时收集一次**，插件中途装上永远进不了表 → 必须整进程重启。另留 `exports["./client"]` 作为客户端模块加载器的备用通道。
- **安全闸**：卡片每 1.2 秒轮询 `/qq-card/pending.json`；若 20 秒没人轮询（页面没卡片），宿主直接把题交还官方界面，避免抢了题却没人看。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/qq-card/card.js` | 卡片脚本本体 |
| GET | `/qq-card/pending.json` | 当前挂起的题（每 1.2s 轮询） |
| POST | `/qq-card/answer` | `{ key, answers }` → resolve 挂起 |
| POST | `/qq-card/delegate` | 交还官方界面 |
| POST | `/qq-card/diag` | 写诊断日志 |

## 已知限制

- 只接提问（`user-questions/request`），**授权确认（`approval/request`）没接**。
- 卡片只在浏览器窗口里，不发系统通知；DSH 不在前台时只能靠声音。
- 宿主没提供 `description` 时，选项不显示副标题。

## 许可

MIT
