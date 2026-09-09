import puppeteer from 'puppeteer';

const SITE = 'https://phatnguoi.vn/';
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,900']
    }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function clean(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function valueAfter(text, label) {
  const re = new RegExp(`${label}\\s*[:：]?\\s*([^|\\n]+)`, 'i');
  return clean(text.match(re)?.[1] || '');
}

function parseBlocks(text, plate) {
  const normalized = text.replace(/\r/g, '');
  const lower = normalized.toLowerCase();
  if (/không (có|tìm thấy).*phạt nguội|không tìm thấy.*vi phạm|không có kết quả/i.test(normalized)) {
    return { source: 'phatnguoi.vn live website', violations: [], message: clean(normalized).slice(0, 500) };
  }

  const starts = [];
  for (const m of normalized.matchAll(/Biển kiểm soát\s*[:：]?/gi)) starts.push(m.index);
  if (!starts.length) {
    if (lower.includes(plate.toLowerCase()) && /vi phạm|chưa xử phạt|đã xử phạt/i.test(normalized)) starts.push(0);
    else throw new Error('Trang phatnguoi.vn chưa trả kết quả nhận diện được');
  }
  starts.push(normalized.length);

  const violations = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const block = normalized.slice(starts[i], starts[i + 1]);
    if (!/vi phạm|xử phạt|thời gian|địa điểm/i.test(block)) continue;
    const resolution = [];
    const resMatch = block.match(/Nơi giải quyết vụ việc\s*[:：]?([\s\S]*?)(?=Biển kiểm soát|$)/i)?.[1];
    if (resMatch) resolution.push({ name: clean(resMatch).slice(0, 700) });
    violations.push({
      licensePlate: valueAfter(block, 'Biển kiểm soát') || plate,
      plateColor: valueAfter(block, 'Màu biển'),
      vehicleType: valueAfter(block, 'Loại phương tiện'),
      violationTime: valueAfter(block, 'Thời gian vi phạm'),
      violationLocation: valueAfter(block, 'Địa điểm vi phạm'),
      violationBehavior: valueAfter(block, 'Hành vi vi phạm'),
      status: valueAfter(block, 'Trạng thái'),
      detectionUnit: valueAfter(block, 'Đơn vị phát hiện vi phạm'),
      resolutionPlaces: resolution
    });
  }

  if (!violations.length) throw new Error('Có phản hồi từ website nhưng chưa bóc tách được dữ liệu vi phạm');
  return { source: 'phatnguoi.vn live website', violations };
}

export async function lookupMultiSource(plate, vehicleType = '1') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(25000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });

    const network = [];
    page.on('response', async res => {
      const req = res.request();
      const type = req.resourceType();
      if (type === 'xhr' || type === 'fetch') {
        network.push(`${req.method()} ${res.status()} ${res.url()}`);
      }
    });

    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const input = await page.$('input[placeholder*="Nhập Biển Số Xe"]');
    if (!input) throw new Error('Không tìm thấy ô nhập biển số trên phatnguoi.vn');

    await input.click({ clickCount: 3 });
    await input.type(plate, { delay: 25 });

    // Best-effort vehicle selection: first vehicle option is car, second is motorbike.
    const vehicleInputs = await page.$$('input[type="radio"], input[type="checkbox"]');
    if (vehicleInputs.length) {
      const idx = String(vehicleType) === '2' ? Math.min(1, vehicleInputs.length - 1) : 0;
      await vehicleInputs[idx].click().catch(() => {});
    }

    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')];
      const el = els.find(x => ((x.innerText || x.value || '').trim().toLowerCase()).includes('tra cứu'));
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) throw new Error('Không tìm thấy nút Tra Cứu trên phatnguoi.vn');

    await Promise.race([
      page.waitForFunction(() => {
        const t = document.body.innerText || '';
        return /Biển kiểm soát|không (có|tìm thấy).*phạt nguội|không tìm thấy.*vi phạm|không có kết quả/i.test(t);
      }, { timeout: 22000 }).catch(() => null),
      new Promise(resolve => setTimeout(resolve, 12000))
    ]);

    await new Promise(resolve => setTimeout(resolve, 1500));
    const text = await page.evaluate(() => document.body.innerText || '');
    console.log('phatnguoi.vn XHR/fetch:', network.slice(-10));
    return parseBlocks(text, plate);
  } finally {
    await page.close().catch(() => {});
  }
}
