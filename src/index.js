import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { lookupMultiSource } from './providers.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const VERSION = '1.4.0-multisource';
const PORT = Number(process.env.PORT || 3000);
const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'tracuuphatnguoi_vn_bot', source: 'multi-source', version: VERSION }));
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
  return [`⚠️ Vi phạm ${i + 1}`,`🚘 Biển kiểm soát: ${v.licensePlate || '—'}`,`🎨 Màu biển: ${v.plateColor || '—'}`,`🚗 Loại phương tiện: ${v.vehicleType || '—'}`,`🕒 Thời gian: ${v.violationTime || '—'}`,`📍 Địa điểm: ${v.violationLocation || '—'}`,`📝 Hành vi: ${v.violationBehavior || '—'}`,`📌 Trạng thái: ${v.status || '—'}`,`👮 Đơn vị phát hiện: ${v.detectionUnit || '—'}`,`🏢 Nơi giải quyết:\n${formatPlaces(v.resolutionPlaces)}`].join('\n');
}

async function handleLookup(ctx, raw, vehicleType = '1') {
  const plate = normalizePlate(raw);
  if (!isLikelyPlate(plate)) return ctx.reply('Biển số chưa đúng định dạng. Ví dụ: 43A40281 hoặc 43A-402.81');
  const wait = await ctx.reply(`🔎 [${VERSION}] Đang tra cứu ${plate} qua nhiều nguồn...`);
  try {
    const result = await lookupMultiSource(plate, vehicleType);
    const violations = result.violations || [];
    if (!violations.length) {
      const extra = result.message ? `\n${result.message}` : '';
      return ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `✅ Không tìm thấy vi phạm cho ${plate}.\n🔗 Nguồn phản hồi: ${result.source}\n⚙️ ${VERSION}${extra}`);
    }
    const header = `🚘 Biển số: ${plate}\n📊 Số vi phạm: ${violations.length}\n🔗 Nguồn phản hồi: ${result.source}\n⚙️ ${VERSION}`;
    let text = header;
    for (let i = 0; i < violations.length; i++) {
      const block = formatViolation(violations[i], i);
      if (`${text}\n\n${block}`.length > 3900) { await ctx.reply(text); text = block; }
      else text += `\n\n${block}`;
    }
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, text);
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 700);
    console.error(`[${VERSION}] all providers failed:`, detail);
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `❌ [${VERSION}] Tất cả nguồn đều thất bại cho ${plate}.\n\n${detail}`);
  }
}

bot.start(ctx => ctx.reply(`🚦 Tra cứu phạt nguội Việt Nam\n⚙️ ${VERSION}\n\nBot tự chuyển qua nhiều nguồn khi một nguồn lỗi.\nGửi biển số: 43A40281\nHoặc /tracuu 43A40281`));
bot.command('tracuu', ctx => handleLookup(ctx, ctx.message.text.replace(/^\/tracuu(?:@\w+)?\s*/i, '').trim(), '1'));
bot.command('xemay', ctx => handleLookup(ctx, ctx.message.text.replace(/^\/xemay(?:@\w+)?\s*/i, '').trim(), '2'));
bot.on('text', ctx => { const text = ctx.message.text.trim(); if (!text.startsWith('/')) return handleLookup(ctx, text, '1'); });
bot.catch((err, ctx) => console.error(`Telegram error ${ctx.update.update_id}:`, err.message));
await bot.launch({ dropPendingUpdates: false });
console.log(`Telegram bot started | ${VERSION}`);
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.once('SIGINT', () => bot.stop('SIGINT'));
