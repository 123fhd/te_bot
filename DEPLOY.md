# 部署文档

Telegram bot `@nothingfang_bot` 部署在 Azure VM,通过 GitHub Actions 自托管 runner 实现 push 即部署。

## 架构

```
[本地 PC]
   git push
      ↓
[GitHub: 123fhd/te_bot]
      ↓ (webhook 触发 workflow)
[Azure VM 上常驻的 Actions Runner]
      ↓ 在 VM 本地执行
  ┌─────────────────────────────────────┐
  │  actions/checkout 拉代码到工作区     │
  │  rsync 到 ~/te_bot/                  │
  │    --exclude .env / .git / node_*    │
  │  npm install --omit=dev              │
  │  pm2 restart te-bot                  │
  │  pm2 save                            │
  └─────────────────────────────────────┘
      ↓
[bot 跑最新代码] → Telegram 用户
```

## 关键资源

| 项 | 值 |
|---|---|
| GitHub repo | https://github.com/123fhd/te_bot |
| Azure VM IP | `23.100.107.14` |
| SSH 用户 | `fhd` |
| VM 上 bot 目录 | `/home/fhd/te_bot/` |
| pm2 进程名 | `te-bot` |
| Bot 入口文件 | `src/bot.js` |
| Runner 服务名 | `actions.runner.123fhd-te_bot.azure-vm.service` |
| OS / Node | Ubuntu 22.04 / Node.js 20 |

## 日常开发:改代码

```bash
cd C:\Users\20607\te_bot
# 改代码……
git add .
git commit -m "改了 xxx"
git push
# 20 秒后 VM 上 bot 自动跑新代码
```

去 https://github.com/123fhd/te_bot/actions 看 workflow 跑的进度和日志。

## 改 .env(特殊流程)

`.env` 含 token/密钥,**不进 git**,只在 VM 上存一份。要改:

```bash
ssh fhd@23.100.107.14
nano ~/te_bot/.env       # 改完保存
pm2 restart te-bot       # 让新配置生效
```

## pm2 常用命令(VM 上)

```bash
pm2 list                       # 看进程状态
pm2 logs te-bot                # 实时日志,Ctrl+C 退出
pm2 logs te-bot --lines 50     # 看最近 50 行
pm2 restart te-bot             # 手动重启
pm2 stop te-bot                # 停止
pm2 monit                      # 监控面板(CPU/内存)
pm2 save                       # 保存当前进程列表(已配开机自启)
```

## Runner 管理(VM 上)

```bash
# 状态
sudo systemctl status actions.runner.123fhd-te_bot.azure-vm.service

# 重启 runner
sudo systemctl restart actions.runner.123fhd-te_bot.azure-vm.service

# 看 runner 日志
sudo journalctl -u actions.runner.123fhd-te_bot.azure-vm.service -f
```

GitHub 上看 runner 状态:https://github.com/123fhd/te_bot/settings/actions/runners

## 故障排查

### Push 后 bot 没更新

1. 看 https://github.com/123fhd/te_bot/actions 上的 workflow 是否 success
2. 失败的话点进去看红色那步的日志
3. workflow success 但 bot 行为没变 → SSH 到 VM 跑 `pm2 logs te-bot --lines 20` 看是否报错

### Workflow 一直 queued / 不跑

通常是 self-hosted runner 掉线:

```bash
ssh fhd@23.100.107.14
sudo systemctl status actions.runner.123fhd-te_bot.azure-vm.service
# 如果是 inactive/failed:
sudo systemctl restart actions.runner.123fhd-te_bot.azure-vm.service
```

### Bot 启动报错 "Missing environment variable"

`.env` 文件丢了或被 rsync 干掉了(不应该,我们 --exclude 了)。检查:

```bash
ssh fhd@23.100.107.14
ls -la ~/te_bot/.env
# 如果不存在,从备份恢复或重新写入
```

### Telegram token 泄露

```bash
# 1. 在 Telegram 找 @BotFather → /revoke → 选 bot → 拿新 token
# 2. 改 VM 上 .env 里的 TELEGRAM_BOT_TOKEN
ssh fhd@23.100.107.14
nano ~/te_bot/.env
pm2 restart te-bot
```

## 从零重建(VM 挂了/换机)

如果 Azure VM 没了,要在一台新 Ubuntu 22.04 上从头部署:

```bash
# 1. 装 Node + pm2 + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm i -g pm2

# 2. 拉代码 + 写 .env
git clone https://github.com/123fhd/te_bot.git ~/te_bot
cd ~/te_bot
nano .env   # 粘 token / API key

# 3. 起 bot
npm install --omit=dev
pm2 start src/bot.js --name te-bot --time
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME

# 4. 装 Actions self-hosted runner
#    去 GitHub 仓库 Settings → Actions → Runners → New self-hosted runner
#    照页面给的命令一行行复制执行
#    config.sh 时加 --labels self-hosted,linux,azure-vm
#    最后 sudo ./svc.sh install <user> && sudo ./svc.sh start
```

部署完毕。push 一下 main 就能验证 workflow。

## 安全建议(待办)

- [ ] 把 SSH 改成密钥登录,禁用密码登录(`sudo nano /etc/ssh/sshd_config` → `PasswordAuthentication no`)
- [ ] 给 Azure NSG 加 SSH 源 IP 白名单(只允许你家 IP)
- [ ] 给 fail2ban 装上,防爆破(`sudo apt install fail2ban`)
- [ ] 定期轮换 Telegram bot token / AI API keys
