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
  const response = await axios.post(API_URL, { bienso: plate }, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    timeout: 30000
  });
  return response.data;
}

function asText(value) {
  if (Array.isArray(value)) return value.join('\n');
  if (value === undefined || value === null || String(value).trim() === '') return '—';
  return String(value);
}

function formatViolation(item, index) {
  const get = (...keys) => {
    for (const key of keys) {
      if (item?.[key] !== undefined && item?.[key] !== null && String(item[key]).trim()) return asText(item[key]);
    }
    return '—';
  };

  return [
    `⚠️ Vi phạm ${index + 1}`,
    `🚘 Biển kiểm soát: ${get('Biển kiểm soát', 'bienso')}`,
    `🚗 Loại phương tiện: ${get('Loại phương tiện', 'loaiphuongtien')}`,
    `🕒 Thời gian: ${get('Thời gian vi phạm', 'thoigian', 'violation_time')}`,
    `📍 Địa điểm: ${get('Địa điểm vi phạm', 'diadiem', 'location')}`,
    `📝 Hành vi: ${get('Hành vi vi phạm', 'hanhvi', 'behavior')}`,
    `📌 Trạng thái: ${get('Trạng thái', 'trangthai', 'status')}`,
    `👮 Đơn vị phát hiện: ${get('Đơn vị phát hiện vi phạm', 'donvi', 'detecting_unit')}`,
    `🏢 Nơi giải quyết:\n${get('Nơi giải quyết vụ việc', 'noigiaiquyet', 'resolution_point')}`
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
    await bot.sendMessage(chatId, 'Biển số chưa đúng định dạng. Ví dụ: 43A40281 hoặc 43A-402.81');
    return;
  }

  const wait = await bot.sendMessage(chatId, `🔎 Đang tra cứu ${plate}...`);

  try {
    const payload = await lookupPlate(plate);
    console.log('Lookup response:', JSON.stringify(payload));

    if (payload?.status === 2 || payload?.data === null) {
      await bot.editMessageText(`✅ Không tìm thấy thông tin phạt nguội cho ${plate}.`, {
        chat_id: chatId,
        message_id: wait.message_id
      });
      return;
    }

    const violations = extractViolations(payload);
    if (!violations.length) {
      throw new Error(`Unexpected API response: ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const info = payload?.data_info;
    const header = [
      `🚘 Biển số: ${plate}`,
      `📊 Tổng vi phạm: ${info?.total ?? violations.length}`,
      `🔴 Chưa xử phạt: ${info?.chuaxuphat ?? '—'}`,
      `🟢 Đã xử phạt: ${info?.daxuphat ?? '—'}`
    ].join('\n');

    const chunks = violations.map(formatViolation);
    let text = header;
    for (const chunk of chunks) {
      const candidate = `${text}\n\n${chunk}`;
      if (candidate.length > 3900) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: wait.message_id });
        text = chunk;
      } else {
        text = candidate;
      }
    }

    if (text === header) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: wait.message_id });
    } else if (text.startsWith(header)) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: wait.message_id });
    } else {
      await bot.sendMessage(chatId, text);
    }
  } catch (error) {
    const detail = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 600) : error.message;
    console.error('Lookup failed:', detail);
    await bot.editMessageText(`❌ Chưa tra cứu được ${plate}. Tôi đã ghi nhận lỗi nguồn dữ liệu để kiểm tra.`, {
      chat_id: chatId,
      message_id: wait.message_id
    });
  }
}

bot.onText(/^\/start(?:\s|$)/, async msg => {
  await bot.sendMessage(msg.chat.id,
    '🚦 Tra cứu phạt nguội Việt Nam\n\nGửi trực tiếp biển số, ví dụ:\n43A40281\n43A-402.81\n\nHoặc dùng: /tracuu 43A40281'
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
