import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { lookupMultiSource } from './providers.js';
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;if(!TOKEN)throw new Error('Missing TELEGRAM_BOT_TOKEN');
const VERSION='2.2.1-csgt-dedup',PORT=Number(process.env.PORT||3000),EXTERNAL_URL=process.env.RENDER_EXTERNAL_URL||process.env.WEBHOOK_BASE_URL||'',WEBHOOK_PATH='/telegram';
const bot=new Telegraf(TOKEN),subscriptions=new Map(),activeLookups=new Map(),seenUpdates=new Map();
const normalizePlate=x=>x.toUpperCase().replace(/[^A-Z0-9]/g,''),isLikelyPlate=x=>/^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/.test(x);
function formatViolation(v,i){return [`⚠️ Vi phạm ${i+1}`,`🚘 Biển kiểm soát: ${v.licensePlate||'—'}`,`🎨 Màu biển: ${v.plateColor||'—'}`,`🚗 Loại phương tiện: ${v.vehicleType||'—'}`,`🕒 Thời gian: ${v.violationTime||'—'}`,`📍 Địa điểm: ${v.violationLocation||'—'}`,`📝 Hành vi: ${v.violationBehavior||'—'}`,`📌 Trạng thái: ${v.status||'—'}`,`👮 Đơn vị phát hiện: ${v.detectionUnit||'—'}`].join('\n')}
function resultText(p,r,d=false){const v=r.violations||[],pre=d?'⏰ TRA CỨU PHẠT NGUỘI HẰNG NGÀY\n\n':'';if(!v.length)return `${pre}✅ Không tìm thấy vi phạm cho ${p}.\n🔗 Nguồn: ${r.source}`;return `${pre}🚘 Biển số: ${p}\n📊 Số vi phạm: ${v.length}\n🔗 Nguồn: ${r.source}\n\n`+v.map(formatViolation).join('\n\n')}
async function handleLookup(ctx,raw,type='1'){
 const p=normalizePlate(raw);if(!isLikelyPlate(p))return ctx.reply('Biển số chưa đúng định dạng. Ví dụ: 43A40281');
 const key=`${ctx.chat.id}:${p}:${type}`;
 if(activeLookups.has(key)) return; // silently ignore duplicate delivery/repeated lookup while current job runs
 const job=(async()=>{const w=await ctx.reply(`🔎 [${VERSION}] Đang tra cứu ${p} trực tiếp CSGT...`);try{const r=await lookupMultiSource(p,type);await ctx.telegram.editMessageText(ctx.chat.id,w.message_id,undefined,resultText(p,r))}catch(e){await ctx.telegram.editMessageText(ctx.chat.id,w.message_id,undefined,`❌ [${VERSION}] Chưa lấy được kết quả ${p}.\n\n${String(e.message||e).slice(0,1000)}`)}})();
 activeLookups.set(key,job);try{await job}finally{activeLookups.delete(key)}
}
// Telegram may redeliver the same webhook update if an earlier request is still running. Mark update IDs immediately.
bot.use(async(ctx,next)=>{const id=ctx.update?.update_id;if(id!=null){const now=Date.now();for(const[k,t]of seenUpdates)if(now-t>3600000)seenUpdates.delete(k);if(seenUpdates.has(id))return;seenUpdates.set(id,now)}return next()});
bot.start(ctx=>ctx.reply(`🚦 Tra cứu phạt nguội Việt Nam\n⚙️ ${VERSION}\nNguồn: CSGT Bộ Công An.`));
bot.command('tracuu',ctx=>handleLookup(ctx,ctx.message.text.replace(/^\/tracuu(?:@\w+)?\s*/i,''),'1'));bot.command('xemay',ctx=>handleLookup(ctx,ctx.message.text.replace(/^\/xemay(?:@\w+)?\s*/i,''),'2'));
bot.command('theodoi',async ctx=>{const p=normalizePlate(ctx.message.text.replace(/^\/theodoi(?:@\w+)?\s*/i,''));if(!isLikelyPlate(p))return ctx.reply('Dùng: /theodoi 43A40281');const id=String(ctx.chat.id),l=subscriptions.get(id)||[];if(!l.some(x=>x.plate===p))l.push({plate:p,vehicleType:'1'});subscriptions.set(id,l);await ctx.reply(`✅ Theo dõi ${p} lúc 07:00 hằng ngày.`)});
bot.command('danhsach',ctx=>{const l=subscriptions.get(String(ctx.chat.id))||[];return ctx.reply(l.length?`📋 ${l.map(x=>x.plate).join('\n')}`:'Bạn chưa theo dõi biển số nào.')});
bot.command('huy',ctx=>{const p=normalizePlate(ctx.message.text.replace(/^\/huy(?:@\w+)?\s*/i,'')),id=String(ctx.chat.id),l=subscriptions.get(id)||[];subscriptions.set(id,l.filter(x=>x.plate!==p));return ctx.reply(`🛑 Đã hủy theo dõi ${p}.`)});
bot.on('text',ctx=>{const t=ctx.message.text.trim();if(!t.startsWith('/'))return handleLookup(ctx,t,'1')});
cron.schedule('0 7 * * *',async()=>{for(const[id,l]of subscriptions)for(const x of l)try{const r=await lookupMultiSource(x.plate,x.vehicleType);await bot.telegram.sendMessage(id,resultText(x.plate,r,true))}catch(e){console.error('daily lookup:',e.message)}},{timezone:'Asia/Ho_Chi_Minh'});
bot.catch((e,c)=>console.error('Telegram error',c.update?.update_id,e.message));
const app=express();app.get('/',(_q,s)=>s.json({ok:true,service:'tracuuphatnguoi_vn_bot',version:VERSION,source:'CSGT Bộ Công An',mode:EXTERNAL_URL?'webhook':'polling'}));app.get('/health',(_q,s)=>s.json({ok:true,version:VERSION}));app.use(bot.webhookCallback(WEBHOOK_PATH));
const server=app.listen(PORT,async()=>{try{if(EXTERNAL_URL){const u=`${EXTERNAL_URL.replace(/\/$/,'')}${WEBHOOK_PATH}`;await bot.telegram.setWebhook(u,{drop_pending_updates:true});console.log('webhook',u)}else await bot.launch({dropPendingUpdates:true})}catch(e){console.error(e.message)}});
process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());