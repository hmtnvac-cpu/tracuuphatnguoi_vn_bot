import puppeteer from 'puppeteer';

const SITE = 'https://csgt.bocongan.gov.vn/tra-cuu-vi-pham-qua-hinh-anh';
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,900']
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

const clean = (text = '') => String(text).replace(/\s+/g, ' ').trim();

function valueAfter(text, label) {
  const re = new RegExp(`${label}\\s*[:：]?\\s*([^|\\n]+)`, 'i');
  return clean(text.match(re)?.[1] || '');
}

function parseResultText(text, plate) {
  const normalized = String(text || '').replace(/\r/g, '');
  if (/không (có|tìm thấy).*vi phạm|không có kết quả|không tìm thấy kết quả/i.test(normalized)) {
    return { source: 'CSGT Bộ Công An', violations: [], message: clean(normalized).slice(0, 600) };
  }

  const starts = [];
  for (const m of normalized.matchAll(/Biển kiểm soát\s*[:：]?/gi)) starts.push(m.index);
  if (!starts.length) {
    if (normalized.toUpperCase().includes(plate) && /vi phạm|xử phạt|thời gian|địa điểm/i.test(normalized)) starts.push(0);
    else throw new Error('CSGT chưa trả kết quả nhận diện được');
  }
  starts.push(normalized.length);

  const violations = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const block = normalized.slice(starts[i], starts[i + 1]);
    if (!/vi phạm|xử phạt|thời gian|địa điểm/i.test(block)) continue;
    const resolutionPlaces = [];
    const res = block.match(/Nơi giải quyết vụ việc\s*[:：]?([\s\S]*?)(?=Biển kiểm soát|$)/i)?.[1];
    if (res) resolutionPlaces.push({ name: clean(res).slice(0, 700) });
    violations.push({
      licensePlate: valueAfter(block, 'Biển kiểm soát') || plate,
      plateColor: valueAfter(block, 'Màu biển'),
      vehicleType: valueAfter(block, 'Loại phương tiện'),
      violationTime: valueAfter(block, 'Thời gian vi phạm'),
      violationLocation: valueAfter(block, 'Địa điểm vi phạm'),
      violationBehavior: valueAfter(block, 'Hành vi vi phạm'),
      status: valueAfter(block, 'Trạng thái'),
      detectionUnit: valueAfter(block, 'Đơn vị phát hiện vi phạm'),
      resolutionPlaces
    });
  }

  if (!violations.length) throw new Error('CSGT có phản hồi nhưng chưa bóc tách được dữ liệu');
  return { source: 'CSGT Bộ Công An', violations };
}

async function fillVehicle(page, vehicleType) {
  const options = await page.$$('select');
  for (const select of options) {
    const vals = await select.$$eval('option', opts => opts.map(o => ({ value: o.value, text: (o.textContent || '').trim().toLowerCase() })));
    if (!vals.length) continue;
    const target = String(vehicleType) === '2'
      ? vals.find(x => /mô tô|xe máy|motor/.test(x.text))
      : vals.find(x => /ô tô|oto|car/.test(x.text));
    if (target) { await select.select(target.value); return; }
  }

  const radios = await page.$$('input[type="radio"]');
  if (radios.length) {
    const idx = String(vehicleType) === '2' ? Math.min(1, radios.length - 1) : 0;
    await radios[idx].click().catch(() => {});
  }
}

export async function lookupMultiSource(plate, vehicleType = '1') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const network = [];
  try {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });

    page.on('response', res => {
      const req = res.request();
      if (['xhr','fetch'].includes(req.resourceType())) {
        network.push(`${req.method()} ${res.status()} ${res.url()}`);
      }
    });

    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const input = await page.$('input[placeholder*="biển" i], input[name*="bien" i], input[id*="bien" i], input[type="text"]');
    if (!input) throw new Error('Không tìm thấy ô nhập biển số trên CSGT mới');
    await input.click({ clickCount: 3 });
    await input.type(plate, { delay: 20 });

    await fillVehicle(page, vehicleType);

    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')];
      const el = els.find(x => /tra cứu|tìm kiếm|kiểm tra/i.test((x.innerText || x.value || '').trim()));
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) throw new Error('Không tìm thấy nút Tra cứu trên CSGT mới');

    await Promise.race([
      page.waitForFunction(() => {
        const t = document.body.innerText || '';
        return /Biển kiểm soát|không (có|tìm thấy).*vi phạm|không có kết quả|trạng thái|hành vi vi phạm/i.test(t);
      }, { timeout: 25000 }).catch(() => null),
      new Promise(resolve => setTimeout(resolve, 15000))
    ]);

    await new Promise(resolve => setTimeout(resolve, 1200));
    const text = await page.evaluate(() => document.body.innerText || '');
    console.log('CSGT new site XHR/fetch:', network.slice(-15));
    return parseResultText(text, plate);
  } finally {
    await page.close().catch(() => {});
  }
}
