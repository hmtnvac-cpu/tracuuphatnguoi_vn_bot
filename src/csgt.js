import puppeteer from 'puppeteer';
import Tesseract from 'tesseract.js';
import * as cheerio from 'cheerio';

const URL = 'https://www.csgt.vn/tra-cuu-phuong-tien-vi-pham.html';
const MAX_RETRIES = 2;
const TOTAL_TIMEOUT_MS = 60000;

function timeoutPromise(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Hết thời gian tra cứu sau ${Math.round(ms / 1000)} giây`)), ms));
}

async function readCaptcha(page) {
  const el = await page.waitForSelector('#imgCaptcha', { timeout: 12000 });
  const png = await el.screenshot({ type: 'png' });
  const result = await Promise.race([
    Tesseract.recognize(png, 'eng'),
    timeoutPromise(15000)
  ]);
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
    else if (text.startsWith('Địa chỉ:') && resolutionPlaces.length) resolutionPlaces[resolutionPlaces.length - 1].address = text.replace(/^Địa chỉ:/, '').trim();
    if ($(el).next().is('hr')) push();
  });
  push();
  return violations.filter(v => v.licensePlate || v.violationTime || v.violationBehavior);
}

async function lookupInternal(plate, vehicleType) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,768']
  });
  let lastError;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(35000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      const url = req.url();
      if (type === 'font' || type === 'media' || type === 'stylesheet') return req.abort();
      if (type === 'image' && !url.includes('captcha')) return req.abort();
      req.continue();
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`Browser CSGT attempt ${attempt}/${MAX_RETRIES}`);
        try {
          await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch (navError) {
          const formExists = await page.$('input[name="BienKiemSoat"]');
          if (!formExists) throw navError;
          console.warn('CSGT navigation timed out but form is already usable; continuing.');
        }

        await page.waitForSelector('input[name="BienKiemSoat"]');
        await page.waitForSelector('select[name="LoaiXe"]');
        await page.waitForSelector('input[name="txt_captcha"]');
        await page.waitForSelector('.btnTraCuu');

        const captcha = await readCaptcha(page);
        if (!captcha || captcha.length < 3) throw new Error(`OCR captcha không hợp lệ: ${captcha || '(rỗng)'}`);
        console.log(`Browser OCR captcha=${captcha}`);

        await page.$eval('input[name="BienKiemSoat"]', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, plate);
        await page.select('select[name="LoaiXe"]', String(vehicleType));
        await page.$eval('input[name="txt_captcha"]', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, captcha);
        await page.click('.btnTraCuu');
        await new Promise(r => setTimeout(r, 5000));

        const bodyText = await page.evaluate(() => document.body.innerText || '');
        if (bodyText.includes('Mã xác nhận sai!')) {
          lastError = new Error('Captcha rejected by CSGT');
          continue;
        }

        const html = await page.content();
        const violations = parseViolations(html);
        if (violations.length) return { source: 'CSGT-browser', violations };
        if (bodyText.includes('Không tìm thấy kết quả') || bodyText.includes('Không có kết quả')) return { source: 'CSGT-browser', violations: [] };
        throw new Error('CSGT không trả trạng thái kết quả hợp lệ');
      } catch (error) {
        lastError = error;
        console.error(`Browser CSGT attempt ${attempt} failed:`, error.message);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  throw lastError || new Error('Không thể tra cứu CSGT qua browser');
}

export async function lookupCSGT(plate, vehicleType = '1') {
  return Promise.race([
    lookupInternal(plate, vehicleType),
    timeoutPromise(TOTAL_TIMEOUT_MS)
  ]);
}
