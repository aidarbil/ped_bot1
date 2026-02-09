# Pedrabotnik Telegram Bot

## Setup

1) Install deps:

```
npm install
```

2) Create `.env` (use `.env.example`):

```
OPENAI_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

3) Run locally:

```
npm run dev
```

## Notes

- `CONTRACT_INFO_JSON` is optional and can provide a quick in-memory map for contract status.
- The bot uses polling by default.
