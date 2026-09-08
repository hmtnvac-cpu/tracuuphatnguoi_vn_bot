import puppeteer from 'puppeteer';
import Tesseract from 'tesseract.js';
import * as cheerio from 'cheerio';

const URL = 'https://www.csgt.vn/tra-cuu-phuong-tien-vi-pham.html';
const MAX_RETRIES = 5;

async function readCaptcha(page) {
  const el = await page.waitForSelector('#imgCaptcha', { timeout: 20000 });
  const png = await el.screenshot({ type: 'png' });
  const result = await Tesseract.recognize(png, 'eng');
  return result.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
}

function parseViolations(html) {
  const $ = cheerio.load(html);
  const violations = [];
  let current = {};
  let resolutionPlaces = [];

  const push = () => {
    if (!Object.keys(current).length) return;
    current.resolutionPlaces = resolutionPlaces;
    violations.push(current);
    current = {};
    resolutionPlaces = [];
  };

  $('#bodyPrint123 .form-group, .form-group').each((_i, el) => {
    if ($(el).prev().is('hr') && Object.keys(current).length) push();

    const label = $(el).find('label span').text().replace(/\s+/g, ' ').trim();
    const value = $(el).find('.col-md-9').text().replace(/\s+/g, ' ').trim();

    if (label && value) {
      if (label === 'Biển kiểm soát:') current.licensePlate = value;
      else if (label === 'Màu biển:') current.plateColor = value;
      else if (label === 'Loại phương tiện:') current.vehicleType = value;
      else if (label === 'Thời gian vi phạm:') current.violationTime = value;
      else if (label === 'Địa điểm vi phạm:') current.violationLocation = value;
      else if (label === 'Hành vi vi phạm:') current.violationBehavior = value;
      else if (label === 'Trạng thái:') current.status = value;
      else if (label === 'Đơn vị phát hiện vi phạm:') current.detectionUnit = value;
    }

    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (/^\d+\./.test(text)) resolutionPlaces.push({ name: text });
    else if (text.startsWith('Địa chỉ:') && resolutionPlaces.length) {
      resolutionPlaces[resolutionPlaces.length - 1].address = text.replace(/^Địa chỉ:/, '').trim();
    }

    if ($(el).next().is('hr')) push();
  });

  push();
  return violations.filter(v => v.licensePlate || v.violationTime || v.violationBehavior);
}

async function detectState(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  if (bodyText.includes('Mã xác nhận sai!')) return 'wrong-captcha';
  if (bodyText.includes('Chưa xử phạt') || bodyText.includes('Đã xử phạt')) return 'result';
  if (bodyText.includes('Không tìm thấy kết quả') || bodyText.includes('Không có kết quả')) return 'empty';
  return 'unknown';
}

export async function lookupCSGT(plate, vehicleType = '1') {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  let lastError;
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`Browser CSGT attempt ${attempt}/${MAX_RETRIES}`);
        await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });

        await page.waitForSelector('input[name="BienKiemSoat"]', { timeout: 20000 });
        await page.waitForSelector('select[name="LoaiXe"]', { timeout: 20000 });
        await page.waitForSelector('input[name="txt_captcha"]', { timeout: 20000 });
        await page.waitForSelector('.btnTraCuu', { timeout: 20000 });

        const captcha = await readCaptcha(page);
        if (!captcha || captcha.length < 3) throw new Error(`OCR captcha không hợp lệ: ${captcha || '(rỗng)'}`);
        console.log(`Browser OCR captcha=${captcha}`);

        await page.click('input[name="BienKiemSoat"]', { clickCount: 3 });
        await page.type('input[name="BienKiemSoat"]', plate, { delay: 20 });
        await page.select('select[name="LoaiXe"]', String(vehicleType));
        await page.click('input[name="txt_captcha"]', { clickCount: 3 });
        await page.type('input[name="txt_captcha"]', captcha, { delay: 20 });

        await page.click('.btnTraCuu');

        await Promise.race([
          page.waitForSelector('#bodyPrint123', { timeout: 15000 }).catch(() => null),
          page.waitForFunction(() => (document.body.innerText || '').includes('Mã xác nhận sai!'), { timeout: 15000 }).catch(() => null),
          page.waitForTimeout?.(3000) || new Promise(r => setTimeout(r, 3000))
        ]);

        await new Promise(r => setTimeout(r, 1500));
        const state = await detectState(page);
        console.log(`Browser CSGT state=${state}`);

        if (state === 'wrong-captcha') {
          lastError = new Error('Captcha rejected by CSGT');
          continue;
        }

        const html = await page.content();
        const violations = parseViolations(html);

        if (violations.length) return { source: 'CSGT-browser', violations };
        if (state === 'empty') return { source: 'CSGT-browser', violations: [] };

        const printText = await page.$eval('#bodyPrint123', el => el.innerText).catch(() => '');
        if (printText && !violations.length) {
          return { source: 'CSGT-browser', violations: [] };
        }

        throw new Error('CSGT browser không nhận diện được trạng thái kết quả');
      } catch (error) {
        lastError = error;
        console.error(`Browser CSGT attempt ${attempt} failed:`, error.message);
      }
    }
  } finally {
    await browser.close();
  }

  throw lastError || new Error('Không thể tra cứu CSGT qua browser');
}
