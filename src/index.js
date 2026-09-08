import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { lookupCSGT } from './csgt.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'tracuuphatnguoi_vn_bot', source: 'CSGT' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 1000,
    params: { timeout: 20 }
  }
});

const normalizePlate = input => input.toUpperCase().replace(/[^A-Z0-9]/g, '');
const isLikelyPlate = plate => /^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/.test(plate);

function formatPlaces(places = []) {
  if (!places.length) return '—';
  return places.map(p => p.address ? `${p.name}\nĐịa chỉ: ${p.address}` : p.name).join('\n');
}

function formatViolation(v, i) {
  return [
    `⚠️ Vi phạm ${i + 1}`,
    `🚘 Biển kiểm soát: ${v.licensePlate || '—'}`,
    `🎨 Màu biển: ${v.plateColor || '—'}`,
    `🚗 Loại phương tiện: ${v.vehicleType || '—'}`,
    `🕒 Thời gian: ${v.violationTime || '—'}`,
    `📍 Địa điểm: ${v.violationLocation || '—'}`,
    `📝 Hành vi: ${v.violationBehavior || '—'}`,
    `📌 Trạng thái: ${v.status || '—'}`,
    `👮 Đơn vị phát hiện: ${v.detectionUnit || '—'}`,
    `🏢 Nơi giải quyết:\n${formatPlaces(v.resolutionPlaces)}`
  ].join('\n');
}

async function handleLookup(chatId, raw, vehicleType = '1') {
  const plate = normalizePlate(raw);
  if (!isLikelyPlate(plate)) {
    await bot.sendMessage(chatId, 'Biển số chưa đúng định dạng. Ví dụ: 43A40281 hoặc 43A-402.81');
    return;
  }

  const wait = await bot.sendMessage(chatId, `🔎 Đang tra cứu ${plate} trực tiếp từ CSGT...`);

  try {
    const result = await lookupCSGT(plate, vehicleType);
    const violations = result.violations || [];

    if (!violations.length) {
      await bot.editMessageText(`✅ CSGT hiện không trả về vi phạm cho ${plate}.`, {
        chat_id: chatId,
        message_id: wait.message_id
      });
      return;
    }

    const header = `🚘 Biển số: ${plate}\n📊 Số vi phạm: ${violations.length}\n🔗 Nguồn: Cục CSGT`;
    const chunks = violations.map(formatViolation);
    let current = header;
    let first = true;

    for (const chunk of chunks) {
      if (`${current}\n\n${chunk}`.length > 3900) {
        if (first) {
          await bot.editMessageText(current, { chat_id: chatId, message_id: wait.message_id });
          first = false;
        } else {
          await bot.sendMessage(chatId, current);
        }
        current = chunk;
      } else {
        current += `\n\n${chunk}`;
      }
    }

    if (first) {
      await bot.editMessageText(current, { chat_id: chatId, message_id: wait.message_id });
    } else {
      await bot.sendMessage(chatId, current);
    }
  } catch (error) {
    console.error('Direct CSGT lookup failed:', error.message);
    await bot.editMessageText(`❌ CSGT chưa trả được kết quả cho ${plate}. Bot đã thử lại CAPTCHA nhiều lần.`, {
      chat_id: chatId,
      message_id: wait.message_id
    });
  }
}

bot.onText(/^\/start(?:\s|$)/, async msg => {
  await bot.sendMessage(msg.chat.id,
    '🚦 Tra cứu phạt nguội Việt Nam\n\nNguồn chính: Cục CSGT.\n\nGửi trực tiếp biển số ô tô, ví dụ:\n43A40281\n43A-402.81\n\nLệnh:\n/tracuu 43A40281\n/xemay 43F112345'
  );
});

bot.onText(/^\/tracuu\s+(.+)/i, async (msg, match) => handleLookup(msg.chat.id, match[1], '1'));
bot.onText(/^\/xemay\s+(.+)/i, async (msg, match) => handleLookup(msg.chat.id, match[1], '2'));

bot.on('message', async msg => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  await handleLookup(msg.chat.id, text, '1');
});

bot.on('polling_error', err => {
  if (err.response?.statusCode === 409 || String(err.message).includes('409')) {
    console.warn('Telegram 409 during deploy overlap; waiting for old instance to stop.');
    return;
  }
  console.error('Telegram polling error:', err.message);
});

process.once('SIGTERM', () => bot.stopPolling({ cancel: true }).finally(() => process.exit(0)));
process.once('SIGINT', () => bot.stopPolling({ cancel: true }).finally(() => process.exit(0)));

console.log('Telegram bot started with direct CSGT lookup');
