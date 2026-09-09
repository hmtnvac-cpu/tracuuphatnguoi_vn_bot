import puppeteer from 'puppeteer';

const URLS = [
  'https://csgt.bocongan.gov.vn/tra-cuu-phat-nguoi',
  'https://csgt.bocongan.gov.vn/tra-cuu-vi-pham-qua-hinh-anh'
];
let browserPromise;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function browser() {
  if (!browserPromise) browserPromise = puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']}).catch(e=>{browserPromise=null;throw e});
  return browserPromise;
}
function clean(s=''){return String(s).replace(/\s+/g,' ').trim()}
function parse(text, plate){
  if (/không (có|tìm thấy).*vi phạm|không có kết quả|không tìm thấy kết quả/i.test(text)) return {source:'CSGT Bộ Công An',violations:[]};
  const blocks=String(text).split(/(?=Biển kiểm soát\s*[:：]?)/i).filter(x=>/vi phạm|xử phạt|thời gian|địa điểm/i.test(x));
  if(!blocks.length) throw new Error('CSGT chưa hiển thị kết quả');
  const val=(b,l)=>clean(b.match(new RegExp(`${l}\\s*[:：]?\\s*([^\\n]+)`,'i'))?.[1]||'');
  return {source:'CSGT Bộ Công An',violations:blocks.map(b=>({licensePlate:val(b,'Biển kiểm soát')||plate,plateColor:val(b,'Màu biển'),vehicleType:val(b,'Loại phương tiện'),violationTime:val(b,'Thời gian vi phạm'),violationLocation:val(b,'Địa điểm vi phạm'),violationBehavior:val(b,'Hành vi vi phạm'),status:val(b,'Trạng thái'),detectionUnit:val(b,'Đơn vị phát hiện vi phạm'),resolutionPlaces:[]}))};
}

async function attempt(url, plate, type){
  const b=await browser(); const p=await b.newPage();
  try{
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36');
    await p.setViewport({width:1366,height:900});
    p.setDefaultTimeout(30000);
    // Do not abandon the attempt merely because full page navigation is slow.
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:120000}).catch(e=>console.warn('CSGT navigation warning:',e.message));
    await sleep(3000);
    const input=await p.$('input[placeholder*="biển" i],input[name*="bien" i],input[id*="bien" i],input[type="text"]');
    if(!input) throw new Error('chưa tải được ô biển số');
    await input.click({clickCount:3}); await input.type(plate,{delay:20});
    const selects=await p.$$('select');
    for(const s of selects){const opts=await s.$$eval('option',o=>o.map(x=>({v:x.value,t:(x.textContent||'').toLowerCase()})));const q=String(type)==='2'?opts.find(x=>/mô tô|xe máy/.test(x.t)):opts.find(x=>/ô tô|oto/.test(x.t));if(q){await s.select(q.v);break}}
    const clicked=await p.evaluate(()=>{const a=[...document.querySelectorAll('button,input[type=submit],input[type=button],a')].find(x=>/tra cứu|tìm kiếm|kiểm tra/i.test((x.innerText||x.value||'').trim()));if(!a)return false;a.click();return true});
    if(!clicked) throw new Error('chưa tải được nút Tra cứu');
    // User prefers a result over a short timeout: allow up to 3 minutes for CSGT.
    for(let i=0;i<90;i++){await sleep(2000);const t=await p.evaluate(()=>document.body.innerText||'');try{return parse(t,plate)}catch{} }
    throw new Error('CSGT chưa trả kết quả sau 180 giây');
  }finally{await p.close().catch(()=>{})}
}

export async function lookupMultiSource(plate,type='1'){
  const errors=[];
  for(const url of URLS){
    for(let retry=1;retry<=2;retry++){
      try{return await attempt(url,plate,type)}catch(e){errors.push(`${url} lần ${retry}: ${e.message}`);await sleep(3000)}
    }
  }
  throw new Error(errors.join(' | ').slice(0,1200));
}