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

### Azure TTS / STT（可选）

启用语音功能(发语音转文字 + `/tts` 朗读)需要在 `.env` 追加：

```env
AZURE_SPEECH_KEY=你的Azure语音Key
AZURE_SPEECH_REGION=eastus
AZURE_TTS_VOICE=zh-CN-XiaoxiaoNeural
AZURE_TTS_MAX_CHARS=1000
AZURE_STT_LANGUAGE=zh-CN
```

TTS 与 STT **共用同一个 Speech 资源**,免费层每月各有 50 万字符 / 5 小时音频。

`AZURE_STT_LANGUAGE` 常用值:`zh-CN`(普通话) `en-US`(美式英语) `ja-JP`(日语) `zh-HK`(粤语)。

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

## 代码结构

```
src/
  bot.js       # 入口：长轮询主循环
  handlers.js  # 消息路由与指令处理
  chat.js      # AI 对话 / 流式回复 / 会话记忆
  image.js     # 图片生成
  speech.js    # Azure TTS / STT
  telegram.js  # Telegram API 封装
  config.js    # 环境变量与配置
  http.js      # fetchJson
  util.js      # 文本切分、解析、错误格式化
  fun.js       # 运势 / 选择 / 掷骰
```

## 指令

- `/start` 或 `/help`: 查看帮助
- 发送语音消息: 自动转文字并由 AI 回复(Azure STT)
- `/image <提示>`: 生成图片
- `/fortune`: 生成每日固定的今日运势
- `/choose 火锅 | 烧烤 | 炒菜`: 随机选择一个选项
- `/roll 2d6`: 掷骰子，支持 `d20`、`3d10` 等格式
- `/tts <文字>`: Azure 朗读为语音气泡
- `/reset`: 清空当前聊天记忆
- `/model`: 查看当前模型
- `/stream on|off`: 开关流式输出
