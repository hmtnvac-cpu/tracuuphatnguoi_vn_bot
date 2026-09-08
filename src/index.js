import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.PHATNGUOI_API_URL || 'https://api.checkphatnguoi.vn/phatnguoi';

const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'tracuuphatnguoi_vn_bot' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));

const bot = new TelegramBot(TOKEN, { polling: true });

const normalizePlate = (input) => input.toUpperCase().replace(/[^A-Z0-9]/g, '');

function isLikelyPlate(plate) {
  return /^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/.test(plate);
}

async function lookupPlate(plate) {
  const body = new URLSearchParams({ bienso: plate });
  const response = await axios.post(API_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
    validateStatus: status => status >= 200 && status < 500
  });

  if (response.status >= 400) {
    throw new Error(`Nguồn dữ liệu trả lỗi ${response.status}`);
  }

  return response.data;
}

function formatViolation(item, index) {
  const get = (...keys) => {
    for (const key of keys) {
      if (item?.[key] !== undefined && item?.[key] !== null && String(item[key]).trim()) return item[key];
    }
    return '—';
  };

  return [
    `⚠️ Vi phạm ${index + 1}`,
    `🕒 Thời gian: ${get('Thời gian vi phạm', 'thoigian', 'violation_time')}`,
    `📍 Địa điểm: ${get('Địa điểm vi phạm', 'diadiem', 'location')}`,
    `📝 Hành vi: ${get('Hành vi vi phạm', 'hanhvi', 'behavior')}`,
    `📌 Trạng thái: ${get('Trạng thái', 'trangthai', 'status')}`,
    `👮 Đơn vị phát hiện: ${get('Đơn vị phát hiện vi phạm', 'donvi', 'detecting_unit')}`,
    `🏢 Nơi giải quyết: ${get('Nơi giải quyết vụ việc', 'noigiaiquyet', 'resolution_point')}`
  ].join('\n');
}

function extractViolations(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload?.data?.violations)) return payload.data.violations;
  if (Array.isArray(payload?.details?.violations)) return payload.details.violations;
  return [];
}

async function handleLookup(chatId, raw) {
  const plate = normalizePlate(raw);
  if (!isLikelyPlate(plate)) {
    await bot.sendMessage(chatId, 'Biển số chưa đúng định dạng. Ví dụ: 43A12345 hoặc 43A-123.45');
    return;
  }

  const wait = await bot.sendMessage(chatId, `🔎 Đang tra cứu ${plate}...`);

  try {
    const payload = await lookupPlate(plate);
    const violations = extractViolations(payload);

    if (!violations.length) {
      await bot.editMessageText(`✅ Không tìm thấy thông tin phạt nguội cho ${plate} trên nguồn tra cứu hiện tại.`, {
        chat_id: chatId,
        message_id: wait.message_id
      });
      return;
    }

    const text = [`🚘 Biển số: ${plate}`, `📊 Số vi phạm: ${violations.length}`, '', ...violations.map(formatViolation)].join('\n\n');
    await bot.editMessageText(text.slice(0, 4096), { chat_id: chatId, message_id: wait.message_id });
  } catch (error) {
    console.error(error);
    await bot.editMessageText(`❌ Chưa tra cứu được ${plate}. Nguồn dữ liệu có thể đang lỗi hoặc giới hạn truy cập.`, {
      chat_id: chatId,
      message_id: wait.message_id
    });
  }
}

bot.onText(/^\/start(?:\s|$)/, async msg => {
  await bot.sendMessage(msg.chat.id,
    '🚦 Tra cứu phạt nguội Việt Nam\n\nGửi trực tiếp biển số, ví dụ:\n43A12345\n43A-123.45\n\nHoặc dùng: /tracuu 43A12345'
  );
});

bot.onText(/^\/tracuu\s+(.+)/i, async (msg, match) => {
  await handleLookup(msg.chat.id, match[1]);
});

bot.on('message', async msg => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  await handleLookup(msg.chat.id, text);
});

bot.on('polling_error', err => console.error('Telegram polling error:', err.message));
console.log('Telegram bot started');
