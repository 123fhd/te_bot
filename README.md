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

### Azure TTS（可选）

启用 `/tts` 语音合成需要在 `.env` 追加：

```env
AZURE_SPEECH_KEY=你的Azure语音Key
AZURE_SPEECH_REGION=eastus
AZURE_TTS_VOICE=zh-CN-XiaoxiaoNeural
AZURE_TTS_MAX_CHARS=1000
```

常用 voice：

- `zh-CN-XiaoxiaoNeural`（女声，温柔，默认）
- `zh-CN-YunxiNeural`（男声，阳光）
- `zh-CN-YunyangNeural`（男声，新闻播报）
- `zh-CN-XiaoyiNeural`（女声，活泼少女）
- `zh-HK-HiuMaanNeural`（粤语，女声）
- `zh-TW-HsiaoChenNeural`（台湾国语，女声）

完整列表见 <https://speech.microsoft.com/portal/voicegallery>

## 运行

```bash
npm start
```

## 指令

- `/start` 或 `/help`: 查看帮助
- `/image <提示>`: 生成图片
- `/tts <文字>`: Azure 朗读为语音气泡
- `/reset`: 清空当前聊天记忆
- `/model`: 查看当前模型
- `/stream on|off`: 开关流式输出
