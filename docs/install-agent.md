# 给 agent 的安装说明

你是在用户的机器上替用户安装 Calli 的 coding agent（Claude Code、Codex 等）。Calli 是一个 hub：在这台机器上跑 agent，用户用手机或电脑浏览器操作。按下面的步骤做，每步看输出再走下一步。

## 1. 先看清楚再动手

```bash
uname -s; node -v; git --version
curl -fsSL https://raw.githubusercontent.com/maxliux5/calli/main/install.sh | bash -s -- --dry-run
```

- 需要 Node.js 22 或更高。没有或版本低时，告诉用户需要升级，问用户用哪种方式（系统包管理器、nvm 等），得到同意再装，不要自己改系统。
- `--dry-run` 只列出会做的事。把要点告诉用户：代码装到 `~/.local/share/calli`，设置在 `~/.config/calli/.env`，线程数据在 `~/.local/state/calli`，在 Linux 上装成 systemd 用户服务 `calli`。
- 输出里说已有 `calli` 服务在别的目录运行时，说明用户已经装过（多半是开发用的克隆）。停下来问用户，不要另装一份。

## 2. 安装

```bash
curl -fsSL https://raw.githubusercontent.com/maxliux5/calli/main/install.sh | bash
```

- 重复运行就是更新，`.env`、token 和线程数据都保留。
- `npm install` 失败并提示缺编译工具时，把脚本给出的那条安装命令告诉用户，需要 sudo 的由用户决定是否执行。
- 没有 systemd（macOS、容器）时脚本不装服务，最后打印手动启动的命令。替用户启动前先问用户：要一直开着，就得放进 tmux、screen 或 launchd。

## 3. 确认在运行

```bash
curl -sf http://127.0.0.1:8787/api/health
```

返回 `{"ok":true,...}` 就是好了。端口或地址改过的，以 `~/.config/calli/.env` 里的 `CALLI_HOST`、`CALLI_PORT` 为准。不通时看 `journalctl --user -u calli -n 50`。

## 4. 告诉用户

- 地址和 token：脚本结尾打印的 `Calli is running:` 和 `Token:` 两行。token 等于登录密码，只在这次对话里告诉用户，不要写进文件、提交或别的地方。
- 打开地址，点「连接 hub」粘贴 token。
- 默认只在本机 `127.0.0.1` 监听。要从手机访问，看 README 的「远程访问」一节，由用户决定怎么开放（例如 VPN），不要替用户改监听地址。
- Calli 只调用这台机器上已经装好并登录的 agent CLI，没装的在界面里显示为不可用。登录要用户本人完成，你不要替用户登录或读取用户的凭据。
- agent 默认在用户的家目录里工作，要换目录就改 `.env` 的 `CALLI_WORKDIRS` 再重启服务：`systemctl --user restart calli`。

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/maxliux5/calli/main/install.sh | bash -s -- --uninstall
```

只删服务和代码，设置和线程数据保留。用户明确要求时，才删除 `~/.config/calli` 和 `~/.local/state/calli`。
