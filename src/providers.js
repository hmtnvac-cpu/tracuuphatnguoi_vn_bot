import axios from 'axios';
import * as cheerio from 'cheerio';

const http = axios.create({
  timeout: 9000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    'Accept': 'application/json,text/plain,text/html,*/*'
  }
});

function arr(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.violations)) return value.violations;
  if (Array.isArray(value?.data?.violations)) return value.data.violations;
  return [];
}

function get(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && String(obj[k]).trim()) return obj[k];
  }
  return undefined;
}

function normalize(items) {
  return items.map(v => ({
    licensePlate: get(v, 'Biển kiểm soát', 'bienso', 'licensePlate', 'license_plate'),
    plateColor: get(v, 'Màu biển', 'maubien', 'plateColor'),
    vehicleType: get(v, 'Loại phương tiện', 'loaiphuongtien', 'vehicleType', 'vehicle_type'),
    violationTime: get(v, 'Thời gian vi phạm', 'thoigian', 'violationTime', 'violation_time'),
    violationLocation: get(v, 'Địa điểm vi phạm', 'diadiem', 'violationLocation', 'location'),
    violationBehavior: get(v, 'Hành vi vi phạm', 'hanhvi', 'violationBehavior', 'behavior'),
    status: get(v, 'Trạng thái', 'trangthai', 'status'),
    detectionUnit: get(v, 'Đơn vị phát hiện vi phạm', 'donvi', 'detectionUnit', 'detecting_unit'),
    resolutionPlaces: (() => {
      const p = get(v, 'Nơi giải quyết vụ việc', 'noigiaiquyet', 'resolutionPlaces', 'resolution_point');
      if (!p) return [];
      if (Array.isArray(p)) return p.map(x => typeof x === 'string' ? { name: x } : x);
      return [{ name: String(p) }];
    })()
  }));
}

function payloadResult(source, data) {
  const items = normalize(arr(data));
  const explicitEmpty = data?.status === 2 || data?.success === true || data?.data_info || data?.message || data?.msg;
  if (items.length) return { source, violations: items };
  if (explicitEmpty) return { source, violations: [], message: String(data?.message || data?.msg || '') };
  throw new Error(`${source}: response format unknown`);
}

async function phatnguoiVN(plate, type) {
  const { data } = await http.get(`https://api.phatnguoi.vn/web/tra-cuu/${encodeURIComponent(plate)}/${encodeURIComponent(type)}`);
  return payloadResult('phatnguoi.vn', data);
}

async function zmIO(plate, type) {
  const { data } = await http.get('https://api.zm.io.vn/v1/csgt/tracuu', { params: { licensePlate: plate, vehicleType: type } });
  return payloadResult('zm.io.vn', data);
}

async function traCuuPhatNguoiNet(plate, type) {
  const session = axios.create({ timeout: 9000, headers: http.defaults.headers });
  const home = await session.get('https://tracuuphatnguoi.net/');
  const html = String(home.data || '');
  const $ = cheerio.load(html);
  const token = $('input[name="token"]').attr('value') || html.match(/(?:token|csrf)["']?\s*[:=]\s*["']([^"']+)/i)?.[1];
  const setCookies = home.headers['set-cookie'] || [];
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!token || !cookie) throw new Error('tracuuphatnguoi.net: missing token/session');
  const { data } = await session.post(`https://tracuuphatnguoi.net/tracuu1.php?BienKS=${encodeURIComponent(plate)}&Xe=${encodeURIComponent(type)}&token=${encodeURIComponent(token)}`, null, {
    headers: { Cookie: cookie, Referer: 'https://tracuuphatnguoi.net/' }
  });
  if (typeof data === 'object') return payloadResult('tracuuphatnguoi.net', data);
  const text = String(data || '').trim();
  if (/không (tìm thấy|có)|chưa tìm thấy/i.test(text)) return { source: 'tracuuphatnguoi.net', violations: [], message: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  throw new Error('tracuuphatnguoi.net: unsupported response');
}

export async function lookupMultiSource(plate, type = '1') {
  const providers = [phatnguoiVN, zmIO, traCuuPhatNguoiNet];
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
