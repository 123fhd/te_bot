# Telegram 公益站 API 机器人

这是一个 Node.js Telegram Bot，使用 Telegram 长轮询接收消息，并调用 OpenAI 兼容格式的公益站 API 回复。

## 配置

复制 `.env.example` 为 `.env`，然后填写：

```env
TELEGRAM_BOT_TOKEN=你的电报机器人Token
AI_API_BASE_URL=https://公益站地址/v1
AI_API_KEY=公益站Key
AI_MODEL=模型名
```

## 运行

```bash
npm start
```

## 指令

- `/start` 或 `/help`: 查看帮助
- `/reset`: 清空当前聊天记忆
- `/model`: 查看当前模型
