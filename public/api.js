async function call(method, path, body, isForm = false) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) init.body = body;
    else { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(path, init); }
  catch { const e = new Error('Network error. Are you offline?'); e.status = 0; throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

export const getConfig = () => call('GET', '/api/config');
export const createTrip = (body) => call('POST', '/api/trips', body);
export const getTrip = (code) => call('GET', `/api/trips/${code}`);
export const saveTrip = (trip) => call('PUT', `/api/trips/${trip.code}`, trip);
export const parseReceipt = (code, formData) => call('POST', `/api/trips/${code}/parse`, formData, true);
export const assign = (code, items, instruction) => call('POST', `/api/trips/${code}/assign`, { items, instruction });
export const deleteImage = (code, billId) => call('DELETE', `/api/trips/${code}/images/${billId}`);
export const imageUrl = (code, billId) => `/api/trips/${code}/images/${billId}`;

export function resizeImage(file, maxEdge = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the image'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}
