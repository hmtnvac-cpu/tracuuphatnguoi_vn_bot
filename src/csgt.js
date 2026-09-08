import axios from 'axios';
import qs from 'qs';
import Tesseract from 'tesseract.js';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

const BASE_URL = 'https://www.csgt.vn';
const CAPTCHA_PATH = '/lib/captcha/captcha.class.php';
const FORM_ENDPOINT = '/?mod=contact&task=tracuu_post&ajax';
const RESULT_PATH = '/tra-cuu-phuong-tien-vi-pham.html';
const MAX_RETRIES = 7;

function client() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    baseURL: BASE_URL,
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
    }
  }));
}

async function readCaptcha(http) {
  const image = await http.get(CAPTCHA_PATH, { responseType: 'arraybuffer' });
  const result = await Tesseract.recognize(Buffer.from(image.data), 'eng', {
    logger: m => {
      if (m.status === 'recognizing text' && m.progress === 1) console.log('Captcha OCR complete');
    }
  });
  return result.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
}

function parseViolations(html) {
  const $ = cheerio.load(html);
  const violations = [];
  let current = {};
  let resolutionPlaces = [];

  const pushCurrent = () => {
    if (Object.keys(current).length === 0) return;
    current.resolutionPlaces = resolutionPlaces;
    violations.push(current);
    current = {};
    resolutionPlaces = [];
  };

  $('.form-group').each((_i, element) => {
    if ($(element).prev().is('hr') && Object.keys(current).length) pushCurrent();

    const label = $(element).find('label span').text().replace(/\s+/g, ' ').trim();
    const value = $(element).find('.col-md-9').text().replace(/\s+/g, ' ').trim();

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

    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (/^\d+\./.test(text)) {
      resolutionPlaces.push({ name: text });
    } else if (text.startsWith('Địa chỉ:') && resolutionPlaces.length) {
      resolutionPlaces[resolutionPlaces.length - 1].address = text.replace(/^Địa chỉ:/, '').trim();
    }

    if ($(element).next().is('hr')) pushCurrent();
  });

  pushCurrent();
  return violations.filter(v => v.licensePlate || v.violationTime || v.violationBehavior);
}

export async function lookupCSGT(plate, vehicleType = '1') {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const http = client();
      const captcha = await readCaptcha(http);
      if (!captcha || captcha.length < 3) throw new Error(`OCR captcha không hợp lệ: ${captcha || '(rỗng)'}`);

      console.log(`CSGT attempt ${attempt}/${MAX_RETRIES}, captcha=${captcha}`);

      const form = qs.stringify({
        BienKS: plate,
        Xe: vehicleType,
        captcha,
        ipClient: '9.9.9.91',
        cUrl: '1'
      });

      const submit = await http.post(FORM_ENDPOINT, form, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}${RESULT_PATH}`
        }
      });

      if (submit.data === 404 || String(submit.data).trim() === '404') {
        lastError = new Error('Captcha rejected by CSGT');
        continue;
      }

      const result = await http.get(`${RESULT_PATH}?&LoaiXe=${encodeURIComponent(vehicleType)}&BienKiemSoat=${encodeURIComponent(plate)}`, {
        headers: { Referer: `${BASE_URL}${RESULT_PATH}` }
      });

      return {
        source: 'CSGT',
        violations: parseViolations(result.data)
      };
    } catch (error) {
      lastError = error;
      console.error(`CSGT attempt ${attempt} failed:`, error.message);
    }
  }

  throw lastError || new Error('Không thể tra cứu CSGT');
}
