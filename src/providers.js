import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const http = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json,text/plain,text/html,*/*'
  }
});

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.violations)) return value.violations;
  if (Array.isArray(value?.data?.violations)) return value.data.violations;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

function get(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && String(obj[k]).trim()) return obj[k];
  }
  return undefined;
}

function normalizeOne(v) {
  return {
    licensePlate: get(v, 'plate', 'Biển kiểm soát', 'bienso', 'licensePlate', 'license_plate'),
    plateColor: get(v, 'color', 'Màu biển', 'maubien', 'plateColor'),
    vehicleType: get(v, 'vehicle', 'Loại phương tiện', 'loaiphuongtien', 'vehicleType', 'vehicle_type'),
    violationTime: get(v, 'time', 'Thời gian vi phạm', 'thoigian', 'violationTime', 'violation_time'),
    violationLocation: get(v, 'location', 'Địa điểm vi phạm', 'diadiem', 'violationLocation'),
    violationBehavior: get(v, 'behavior', 'Hành vi vi phạm', 'hanhvi', 'violationBehavior'),
    status: get(v, 'status', 'Trạng thái', 'trangthai'),
    detectionUnit: get(v, 'unit', 'Đơn vị phát hiện vi phạm', 'donvi', 'detectionUnit', 'detecting_unit'),
    resolutionPlaces: (() => {
      const p = get(v, 'resolutionPlaces', 'Nơi giải quyết vụ việc', 'noigiaiquyet', 'resolution_point');
      if (!p) return [];
      if (Array.isArray(p)) return p.map(x => typeof x === 'string' ? { name: x } : x);
      return [{ name: String(p) }];
    })()
  };
}

function normalize(items) {
  return items.map(normalizeOne);
}

function payloadResult(source, data) {
  if (data && typeof data === 'object' && data.violation === false) {
    return { source, violations: [], message: String(data.message || data.msg || '') };
  }

  if (data && typeof data === 'object' && data.violation === true) {
    const candidates = arr(data);
    if (candidates.length) return { source, violations: normalize(candidates) };
    return { source, violations: [normalizeOne(data)] };
  }

  const items = normalize(arr(data));
  const explicitEmpty = data?.status === 2 || data?.success === true || data?.data_info || data?.message || data?.msg;
  if (items.length) return { source, violations: items };
  if (explicitEmpty) return { source, violations: [], message: String(data?.message || data?.msg || '') };
  throw new Error(`${source}: response format unknown`);
}

async function phatnguoiVideoAPI(plate) {
  const { data } = await http.post('https://api.phatnguoi.vn/phatnguoi',
    { plate },
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://phatnguoi.vn',
        'Referer': 'https://phatnguoi.vn/'
      }
    }
  );
  return payloadResult('api.phatnguoi.vn/phatnguoi', data);
}

async function phatnguoiLegacy(plate, type) {
  const { data } = await http.get(`https://api.phatnguoi.vn/web/tra-cuu/${encodeURIComponent(plate)}/${encodeURIComponent(type)}`);
  return payloadResult('phatnguoi.vn legacy', data);
}

async function zmIO(plate, type) {
  const { data } = await http.get('https://api.zm.io.vn/v1/csgt/tracuu', { params: { licensePlate: plate, vehicleType: type } });
  return payloadResult('zm.io.vn', data);
}

async function traCuuPhatNguoiNet(plate, type) {
  const session = axios.create({ timeout: 12000, headers: { 'User-Agent': UA } });
  const home = await session.get('https://tracuuphatnguoi.net/');
  const html = String(home.data || '');
  const $ = cheerio.load(html);
  const token = $('input[name="token"]').attr('value') || html.match(/(?:token|csrf)["']?\s*[:=]\s*["']([^"']+)/i)?.[1];
  const setCookies = home.headers['set-cookie'] || [];
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!token || !cookie) throw new Error('tracuuphatnguoi.net: missing token/session');
  const { data } = await session.post(`https://tracuuphatnguoi.net/tracuu1.php?BienKS=${encodeURIComponent(plate)}&Xe=${encodeURIComponent(type)}&token=${encodeURIComponent(token)}`, null, {
    headers: { Cookie: cookie, Referer: 'https://tracuuphatnguoi.net/', 'User-Agent': UA }
  });
  if (typeof data === 'object') return payloadResult('tracuuphatnguoi.net', data);
  const text = String(data || '').trim();
  if (/không (tìm thấy|có)|chưa tìm thấy/i.test(text)) return { source: 'tracuuphatnguoi.net', violations: [], message: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  throw new Error('tracuuphatnguoi.net: unsupported response');
}

export async function lookupMultiSource(plate, type = '1') {
  const providers = [phatnguoiVideoAPI, phatnguoiLegacy, zmIO, traCuuPhatNguoiNet];
  const errors = [];
  for (const provider of providers) {
    try {
      const result = await provider(plate, type);
      console.log(`Provider success: ${result.source}`);
      return { ...result, errors };
    } catch (e) {
      console.warn(`Provider failed: ${provider.name}: ${e.message}`);
      errors.push(`${provider.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ').slice(0, 700) || 'Tất cả nguồn đều thất bại');
}
