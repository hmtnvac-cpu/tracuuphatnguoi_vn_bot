import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_URL = 'https://api.phatnguoi.vn/phatnguoi';

function get(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && String(obj[k]).trim()) return obj[k];
  }
}

function normalizeOne(v) {
  return {
    licensePlate: get(v, 'plate', 'Biển kiểm soát', 'bienso'),
    plateColor: get(v, 'color', 'Màu biển', 'maubien'),
    vehicleType: get(v, 'vehicle', 'Loại phương tiện', 'loaiphuongtien'),
    violationTime: get(v, 'time', 'Thời gian vi phạm', 'thoigian'),
    violationLocation: get(v, 'location', 'Địa điểm vi phạm', 'diadiem'),
    violationBehavior: get(v, 'behavior', 'Hành vi vi phạm', 'hanhvi'),
    status: get(v, 'status', 'Trạng thái', 'trangthai'),
    detectionUnit: get(v, 'unit', 'Đơn vị phát hiện vi phạm', 'donvi'),
    resolutionPlaces: []
  };
}

function parseVideoResponse(data) {
  if (!data || typeof data !== 'object') throw new Error('API không trả JSON hợp lệ');

  if (data.violation === false) {
    return {
      source: 'api.phatnguoi.vn/phatnguoi',
      violations: [],
      message: String(data.message || data.msg || '')
    };
  }

  if (data.violation === true) {
    const rows = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.violations)
        ? data.violations
        : [data];
    return {
      source: 'api.phatnguoi.vn/phatnguoi',
      violations: rows.map(normalizeOne)
    };
  }

  throw new Error(`API trả cấu trúc không đúng workflow: ${JSON.stringify(data).slice(0, 300)}`);
}

export async function lookupMultiSource(plate) {
  try {
    const response = await axios.post(
      API_URL,
      { plate },
      {
        timeout: 15000,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Origin': 'https://phatnguoi.vn',
          'Referer': 'https://phatnguoi.vn/'
        },
        validateStatus: () => true
      }
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`POST ${API_URL} trả HTTP ${response.status}`);
    }

    return parseVideoResponse(response.data);
  } catch (error) {
    if (error.code === 'ECONNABORTED') throw new Error('API trong video quá thời gian phản hồi');
    throw error;
  }
}
