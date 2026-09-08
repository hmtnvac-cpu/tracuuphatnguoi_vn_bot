import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { lookupCSGT } from './csgt.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const VERSION = '1.2.1-browser';
const PORT = Number(process.env.PORT || 3000);
const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'tracuuphatnguoi_vn_bot', source: 'CSGT-browser', version: VERSION }));
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
app.listen(PORT, () => console.log(`Health server listening on ${PORT} | ${VERSION}`));

const bot = new Telegraf(TOKEN);

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

async function handleLookup(ctx, raw, vehicleType = '1') {
  const plate = normalizePlate(raw);
  if (!isLikelyPlate(plate)) {
    await ctx.reply('Biển số chưa đúng định dạng. Ví dụ: 43A40281 hoặc 43A-402.81');
    return;
  }

  const wait = await ctx.reply(`🔎 [${VERSION}] Đang tra cứu ${plate} bằng trình duyệt CSGT...`);

  try {
    const result = await lookupCSGT(plate, vehicleType);
    const violations = result.violations || [];

    if (!violations.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `✅ [${VERSION}] CSGT hiện không trả về vi phạm cho ${plate}.`);
      return;
    }

    const header = `🚘 Biển số: ${plate}\n📊 Số vi phạm: ${violations.length}\n🔗 Nguồn: Cục CSGT\n⚙️ Bot: ${VERSION}`;
    const parts = violations.map(formatViolation);
    let current = header;
    let edited = false;

    for (const part of parts) {
      if (`${current}\n\n${part}`.length > 3900) {
        if (!edited) {
          await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, current);
          edited = true;
        } else {
          await ctx.reply(current);
        }
        current = part;
      } else {
        current += `\n\n${part}`;
      }
    }

    if (!edited) await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, current);
    else await ctx.reply(current);
  } catch (error) {
    const detail = String(error?.message || error || 'unknown error').slice(0, 500);
    console.error(`[${VERSION}] CSGT browser lookup failed:`, error?.stack || detail);
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined,
      `❌ [${VERSION}] Tra cứu thất bại cho ${plate}.\n\nLỗi thực tế: ${detail}`
    );
  }
}

bot.start(async ctx => {
  await ctx.reply(`🚦 Tra cứu phạt nguội Việt Nam\n⚙️ Phiên bản: ${VERSION}\n\nNguồn chính: Cục CSGT qua trình duyệt tự động.\n\nGửi trực tiếp biển số ô tô, ví dụ:\n43A40281\n43A-402.81\n\nLệnh:\n/tracuu 43A40281\n/xemay 43F112345`);
});

bot.command('tracuu', async ctx => {
  const raw = ctx.message.text.replace(/^\/tracuu(?:@\w+)?\s*/i, '').trim();
  await handleLookup(ctx, raw, '1');
});

bot.command('xemay', async ctx => {
  const raw = ctx.message.text.replace(/^\/xemay(?:@\w+)?\s*/i, '').trim();
  await handleLookup(ctx, raw, '2');
});

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  await handleLookup(ctx, text, '1');
});

bot.catch((err, ctx) => {
  console.error(`Telegram error for update ${ctx.update.update_id}:`, err.message);
});

await bot.launch({ dropPendingUpdates: false });
console.log(`Telegram bot started | ${VERSION}`);

process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.once('SIGINT', () => bot.stop('SIGINT'));
