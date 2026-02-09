import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { runWorkflow } from "./workflow.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const bot = new TelegramBot(token, { polling: true });

async function withTyping<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const send = async () => {
    try {
      await bot.sendChatAction(chatId, "typing");
    } catch {
      // Ignore typing errors to avoid blocking replies
    }
  };
  await send();
  const interval = setInterval(send, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  try {
    const result: any = await withTyping(chatId, () => runWorkflow({ input_as_text: text }));
    const reply =
      (typeof result?.output_text === "string" && result.output_text) ||
      (typeof result?.safe_text === "string" && result.safe_text) ||
      (typeof result === "string" && result) ||
      "";

    if (reply) {
      await bot.sendMessage(chatId, reply);
    } else {
      await bot.sendMessage(chatId, "Извините, не удалось сформировать ответ.");
    }
  } catch (err) {
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте еще раз.");
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err);
});

console.log("Telegram bot is running (polling)...");
