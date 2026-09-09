import axios from 'axios';

const HOME_URL = 'https://phatnguoi.app/';
const AJAX_URL = 'https://phatnguoi.app/wp-admin/admin-ajax.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

function clean(v = '') {
  return String(v ?? '').trim();
}

function mapViolation(v = {}) {
  return {
    licensePlate: v.license_plate || v.plate || v['Biển kiểm soát'] || '',
    plateColor: v.plate_color || v.color || v['Màu biển'] || '',
    vehicleType: v.vehicle_type || v.vehicle || v['Loại phương tiện'] || '',
    violationTime: v.violation_time || v.time || v['Thời gian vi phạm'] || '',
    violationLocation: v.violation_location || v.location || v['Địa điểm vi phạm'] || '',
    violationBehavior: v.violation_behavior || v.behavior || v['Hành vi vi phạm'] || '',
    status: v.status || v['Trạng thái'] || '',
    detectionUnit: v.detecting_unit || v.unit || v['Đơn vị phát hiện vi phạm'] || '',
    resolutionPlaces: Array.isArray(v.resolution_places)
      ? v.resolution_places.map(x => typeof x === 'string' ? { name: x } : x)
      : []
  };
}

function vehicleTypeForProvider(type) {
  return String(type) === '2' ? 'motorbike' : 'car';
}

function makeSession() {
  return axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Referer': HOME_URL,
      'X-Requested-With': 'XMLHttpRequest'
    },
    validateStatus: () => true
  });
}

async function fetchNonce(session) {
  const first = await session.post(
    AJAX_URL,
    new URLSearchParams({ action: 'phatnguoi_get_nonce' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } }
  );

  if (first.status >= 200 && first.status < 300) {
    const data = typeof first.data === 'string' ? (() => { try { return JSON.parse(first.data); } catch { return null; } })() : first.data;
    const nonce = data?.data?.nonce;
    if (nonce) return clean(nonce);
  }

  const home = await session.get(HOME_URL, { headers: { 'Accept': 'text/html,*/*' } });
  if (home.status < 200 || home.status >= 300) throw new Error(`phatnguoi.app home HTTP ${home.status}`);
  const html = String(home.data || '');
  const match = html.match(/nonce\s*:\s*['\"]([a-zA-Z0-9]+)['\"]/i) || html.match(/"nonce"\s*:\s*"([a-zA-Z0-9]+)"/i);
  if (!match) throw new Error('Không lấy được nonce từ phatnguoi.app');
  return match[1];
}

async function doLookup(session, nonce, plate, type) {
  const body = new URLSearchParams({
    action: 'phatnguoi_search',
    nonce,
    license_plate: plate,
    vehicle_type: vehicleTypeForProvider(type)
  }).toString();

  return session.post(AJAX_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
  });
}

function parsePayload(response, plate) {
  if (response.status < 200 || response.status >= 300) throw new Error(`phatnguoi.app HTTP ${response.status}`);
  const raw = typeof response.data === 'string' ? response.data.trim() : response.data;
  if (raw === '-1') throw new Error('NONCE_EXPIRED');

  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); }
    catch { throw new Error('phatnguoi.app trả dữ liệu không phải JSON'); }
  }

  if (!payload || typeof payload !== 'object') throw new Error('phatnguoi.app trả dữ liệu không hợp lệ');
  if (!payload.success) {
    const message = payload?.data?.message || payload?.message || 'Tra cứu phatnguoi.app thất bại';
    throw new Error(clean(message));
  }

  const result = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const rows = Array.isArray(result.violations) ? result.violations : [];
  return {
    source: 'phatnguoi.app',
    violations: rows.map(mapViolation),
    message: rows.length ? 'Tra cứu thành công' : `Không tìm thấy vi phạm cho ${plate}`
  };
}

export async function lookupMultiSource(plate, type = '1') {
  const session = makeSession();
  let nonce = await fetchNonce(session);
  let response = await doLookup(session, nonce, plate, type);

  if (String(response.data || '').trim() === '-1') {
    nonce = await fetchNonce(session);
    response = await doLookup(session, nonce, plate, type);
  }

  return parsePayload(response, plate);
}
