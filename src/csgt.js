import axios from 'axios';
import qs from 'qs';
import Tesseract from 'tesseract.js';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

const CSGT_URL = 'https://www.csgt.vn/';
const CAPTCHA_URL = `${CSGT_URL}lib/captcha/captcha.class.php`;
const SUBMIT_URL = `${CSGT_URL}?mod=contact&task=tracuu_post&ajax`;
const FORM_URL = `${CSGT_URL}tra-cuu-phuong-tien-vi-pham.html`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const MAX_ATTEMPTS = 4;
const TOTAL_TIMEOUT_MS = 55000;

function hardTimeout(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function newClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 18000,
    maxRedirects: 5,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
    }
  }));
}

async function solveCaptcha(client) {
  const response = await client.get(CAPTCHA_URL, { responseType: 'arraybuffer' });
  const image = Buffer.from(response.data);
  const result = await Promise.race([
    Tesseract.recognize(image, 'eng', {
      config: {
        tessedit_pageseg_mode: '7',
        tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
      }
    }),
    hardTimeout(12000, 'OCR CAPTCHA quá thời gian')
  ]);
  return result.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
}

function normalizeText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
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
    const label = normalizeText($(el).find('label span').text());
    const value = normalizeText($(el).find('.col-md-9').text());

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

    const text = normalizeText($(el).text());
    if (/^\d+\./.test(text)) resolutionPlaces.push({ name: text });
    else if (text.startsWith('Địa chỉ:') && resolutionPlaces.length) {
      resolutionPlaces[resolutionPlaces.length - 1].address = text.replace(/^Địa chỉ:/, '').trim();
    }

    if ($(el).next().is('hr')) push();
  });

  push();
  return violations.filter(v => v.licensePlate || v.violationTime || v.violationBehavior);
}

async function fetchDetails(client, href) {
  const url = href.startsWith('http') ? href : new URL(href, CSGT_URL).href;
  const response = await client.get(url, {
    headers: { Referer: FORM_URL, 'User-Agent': USER_AGENT },
    timeout: 18000
  });
  const html = String(response.data || '');
  const violations = parseViolations(html);
  const $ = cheerio.load(html);
  const message = normalizeText($('#bodyPrint123').text()) || normalizeText($('.xe_texterror').text());
  return { violations, message };
}

async function singleAttempt(plate, vehicleType) {
  const client = newClient();
  const captcha = await solveCaptcha(client);
  if (!captcha || captcha.length < 3) throw new Error(`OCR CAPTCHA không hợp lệ: ${captcha || '(rỗng)'}`);

  console.log(`HTTP CSGT captcha=${captcha}`);

  const form = qs.stringify({
    BienKS: plate,
    Xe: String(vehicleType),
    captcha,
    ipClient: '9.9.9.91',
    cUrl: FORM_URL
  });

  const response = await client.post(SUBMIT_URL, form, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': USER_AGENT,
      'Referer': FORM_URL,
      'Origin': CSGT_URL.replace(/\/$/, ''),
      'X-Requested-With': 'XMLHttpRequest'
    },
    timeout: 18000
  });

  const raw = typeof response.data === 'string' ? response.data.trim().replace(/^\uFEFF/, '') : response.data;
  if (raw === 404 || raw === '404') throw new Error('CAPTCHA_MISMATCH');

  let submit = raw;
  if (typeof raw === 'string') {
    try { submit = JSON.parse(raw); }
    catch { throw new Error(`CSGT trả phản hồi không hợp lệ: ${raw.slice(0, 120)}`); }
  }

  if (!submit || typeof submit !== 'object') throw new Error('CSGT không trả JSON hợp lệ');

  const href = submit.Href || submit.href;
  if (!href) {
    const direct = `${FORM_URL}?LoaiXe=${encodeURIComponent(vehicleType)}&BienKiemSoat=${encodeURIComponent(plate)}`;
    const details = await fetchDetails(client, direct);
    return { source: 'CSGT-http', ...details };
  }

  const details = await fetchDetails(client, href);
  return { source: 'CSGT-http', ...details };
}

async function lookupInternal(plate, vehicleType) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`HTTP CSGT attempt ${attempt}/${MAX_ATTEMPTS}`);
      const result = await singleAttempt(plate, vehicleType);
      if (result.violations?.length) return result;
      if (result.message) return result;
      lastError = new Error('CSGT không trả dữ liệu kết quả');
    } catch (error) {
      lastError = error;
      console.error(`HTTP CSGT attempt ${attempt} failed:`, error.message);
      if (error.message !== 'CAPTCHA_MISMATCH') {
        if (attempt >= 2) break;
      }
    }
  }
  throw lastError || new Error('Không thể tra cứu CSGT');
}

export async function lookupCSGT(plate, vehicleType = '1') {
  return Promise.race([
    lookupInternal(plate, vehicleType),
    hardTimeout(TOTAL_TIMEOUT_MS, 'Hết thời gian tra cứu CSGT sau 55 giây')
  ]);
}
