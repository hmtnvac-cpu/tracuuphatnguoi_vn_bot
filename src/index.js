import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { lookupMultiSource } from './providers.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const VERSION = '1.8.1-webhook-fix';
const PORT = Number(process.env.PORT || 3000);
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_BASE_URL || '';
const WEBHOOK_PATH = '/telegram';

const bot = new Telegraf(TOKEN);
const subscriptions = new Map();
const normalizePlate = input => input.toUpperCase().replace(/[^A-Z0-9]/g, '');
const isLikelyPlate = plate => /^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/.test(plate);

function formatPlaces(places = []) {
  if (!places.length) return '—';
  return places.map(p => p.address ? `${p.name}\nĐịa chỉ: ${p.address}` : p.name).join('\n');
}
function formatViolation(v, i) {
  return [`⚠️ Vi phạm ${i + 1}`,`🚘 Biển kiểm soát: ${v.licensePlate || '—'}`,`🎨 Màu biển: ${v.plateColor || '—'}`,`🚗 Loại phương tiện: ${v.vehicleType || '—'}`,`🕒 Thời gian: ${v.violationTime || '—'}`,`📍 Địa điểm: ${v.violationLocation || '—'}`,`📝 Hành vi: ${v.violationBehavior || '—'}`,`📌 Trạng thái: ${v.status || '—'}`,`👮 Đơn vị phát hiện: ${v.detectionUnit || '—'}`,`🏢 Nơi giải quyết:\n${formatPlaces(v.resolutionPlaces)}`].join('\n');
}
function resultText(plate, result, daily = false) {
  const violations = result.violations || [];
  const prefix = daily ? '⏰ TRA CỨU PHẠT NGUỘI HẰNG NGÀY\n\n' : '';
  if (!violations.length) return `${prefix}✅ Không tìm thấy vi phạm cho ${plate}.\n🔗 Nguồn: ${result.source}`;
  let text = `${prefix}🚘 Biển số: ${plate}\n📊 Số vi phạm: ${violations.length}\n🔗 Nguồn: ${result.source}`;
  for (let i = 0; i < violations.length; i++) text += `\n\n${formatViolation(violations[i], i)}`;
  return text;
}
async function handleLookup(ctx, raw, vehicleType = '1') {
  const plate = normalizePlate(raw);
  if (!isLikelyPlate(plate)) return ctx.reply('Biển số chưa đúng định dạng. Ví dụ: 43A40281 hoặc 43A-402.81');
  const wait = await ctx.reply(`🔎 [${VERSION}] Đang tra cứu ${plate}...`);
  try {
    const result = await lookupMultiSource(plate, vehicleType);
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, resultText(plate, result));
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 700);
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `❌ [${VERSION}] Tra cứu thất bại cho ${plate}.\n\n${detail}`);
  }
}

bot.start(ctx => ctx.reply(`🚦 Tra cứu phạt nguội Việt Nam\n⚙️ ${VERSION}\n\nTheo dõi hằng ngày lúc 07:00:\n/theodoi 43A40281\nXem danh sách: /danhsach\nHủy: /huy 43A40281`));
bot.command('tracuu', ctx => handleLookup(ctx, ctx.message.text.replace(/^\/tracuu(?:@\w+)?\s*/i, '').trim(), '1'));
bot.command('xemay', ctx => handleLookup(ctx, ctx.message.text.replace(/^\/xemay(?:@\w+)?\s*/i, '').trim(), '2'));
bot.command('theodoi', async ctx => {
  const plate = normalizePlate(ctx.message.text.replace(/^\/theodoi(?:@\w+)?\s*/i, '').trim());
  if (!isLikelyPlate(plate)) return ctx.reply('Dùng: /theodoi 43A40281');
  const chatId = String(ctx.chat.id); const list = subscriptions.get(chatId) || [];
  if (!list.some(x => x.plate === plate)) list.push({ plate, vehicleType: '1' });
  subscriptions.set(chatId, list);
  await ctx.reply(`✅ Đã bật tra cứu tự động cho ${plate}.\n⏰ 07:00 hằng ngày (giờ Việt Nam).`);
});
bot.command('danhsach', async ctx => {
  const list = subscriptions.get(String(ctx.chat.id)) || [];
  if (!list.length) return ctx.reply('Bạn chưa theo dõi biển số nào.');
  await ctx.reply(`📋 Biển số đang theo dõi:\n${list.map(x => `• ${x.plate}`).join('\n')}\n\n⏰ 07:00 hằng ngày.`);
});
bot.command('huy', async ctx => {
  const plate = normalizePlate(ctx.message.text.replace(/^\/huy(?:@\w+)?\s*/i, '').trim());
  const chatId = String(ctx.chat.id); const list = subscriptions.get(chatId) || [];
  const next = list.filter(x => x.plate !== plate); subscriptions.set(chatId, next);
  await ctx.reply(list.length === next.length ? `Không tìm thấy ${plate} trong danh sách theo dõi.` : `🛑 Đã hủy theo dõi ${plate}.`);
});
bot.on('text', ctx => { const text = ctx.message.text.trim(); if (!text.startsWith('/')) return handleLookup(ctx, text, '1'); });

cron.schedule('0 7 * * *', async () => {
  for (const [chatId, list] of subscriptions.entries()) for (const item of list) {
    try { const result = await lookupMultiSource(item.plate, item.vehicleType); await bot.telegram.sendMessage(chatId, resultText(item.plate, result, true)); }
    catch { await bot.telegram.sendMessage(chatId, `⚠️ Tra cứu tự động ${item.plate} hôm nay thất bại.`).catch(() => {}); }
  }
}, { timezone: 'Asia/Ho_Chi_Minh' });

bot.catch((err, ctx) => console.error(`Telegram error ${ctx.update?.update_id}:`, err.message));

const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'tracuuphatnguoi_vn_bot', version: VERSION, mode: EXTERNAL_URL ? 'webhook' : 'polling' }));
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
// Important: do not mount at /telegram AND also give Telegraf /telegram; that strips the path before Telegraf sees it.
app.use(bot.webhookCallback(WEBHOOK_PATH));

const server = app.listen(PORT, async () => {
  console.log(`Health server listening on ${PORT} | ${VERSION}`);
  try {
    if (EXTERNAL_URL) {
      const webhookUrl = `${EXTERNAL_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: false });
      const info = await bot.telegram.getWebhookInfo();
      console.log('Telegram webhook active:', info.url, '| pending:', info.pending_update_count, '| error:', info.last_error_message || 'none');
    } else {
      await bot.launch({ dropPendingUpdates: false });
      console.log('Telegram polling active (local fallback)');
    }
  } catch (error) {
    console.error('Telegram startup failed:', error.message);
  }
});

async function shutdown(signal) {
  try { if (!EXTERNAL_URL) bot.stop(signal); server.close(() => process.exit(0)); }
  catch { process.exit(0); }
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
