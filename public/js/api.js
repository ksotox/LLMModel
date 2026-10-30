async function request(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return s ? `?${s}` : '';
};

/** Items carry a `photo` Blob; it is sent as a file field and referenced by `photoField`. */
function multipart(key, items) {
  const form = new FormData();
  const meta = items.map(({ photo, ...rest }, i) => {
    if (!photo) return rest;
    const field = `photo_${i}`;
    form.append(field, photo, photo.name || `${field}.jpg`);
    return { ...rest, photoField: field };
  });
  form.append(key, JSON.stringify(meta));
  return form;
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  desktop: () => request('GET', '/api/desktop'),
  desktopRestart: () => request('POST', '/api/desktop/restart'),
  lookup: (params) => request('GET', `/api/lookup${qs(params)}`),
  identify: (texts) => request('POST', '/api/identify', texts),

  cards: (params = {}) => request('GET', `/api/cards${qs(params)}`).then((r) => r.cards),
  card: (id) => request('GET', `/api/cards/${id}`),
  createCards: (cards) => request('POST', '/api/cards', multipart('cards', cards)).then((r) => r.cards),
  updateCard: (id, data) => request('PATCH', `/api/cards/${id}`, data),
  refreshOfficial: (id) => request('POST', `/api/cards/${id}/refresh-official`),
  replaceCardPhoto: (id, blob) => {
    const form = new FormData();
    form.append('photo', blob, blob.name || 'photo.jpg');
    return request('POST', `/api/cards/${id}/photo`, form);
  },
  deleteCard: (id) => request('DELETE', `/api/cards/${id}`),
  refreshMarket: (id) => request('POST', `/api/cards/${id}/refresh-market`),
  refreshAllMarket: () => request('POST', '/api/cards/refresh-market'),
  ebay: (id, condition) => request('GET', `/api/cards/${id}/ebay${qs({ condition })}`),
  ebayRefresh: (id, condition) => request('POST', `/api/cards/${id}/ebay/refresh${qs({ condition })}`),
  ebayImport: (id, listings, condition) => request('POST', `/api/cards/${id}/ebay/import${qs({ condition })}`, { listings }),
  ebayDelete: (id, saleId, condition) => request('DELETE', `/api/cards/${id}/ebay/${saleId}${qs({ condition })}`),
  priceHistory: (id, days) => request('GET', `/api/cards/${id}/price-history${qs({ days })}`),
  tracker: (id) => request('GET', `/api/cards/${id}/pricetracker`),
  trackerRefresh: (id, force) => request('POST', `/api/cards/${id}/pricetracker/refresh${force ? '?force=1' : ''}`),
  catalogCard: (id, variant) => request('GET', `/api/catalog/cards/${encodeURIComponent(id)}${qs({ variant })}`),

  packs: (params = {}) => request('GET', `/api/packs${qs(params)}`).then((r) => r.packs),
  pack: (id) => request('GET', `/api/packs/${id}`),
  createPacks: (packs) => request('POST', '/api/packs', multipart('packs', packs)).then((r) => r.packs),
  updatePack: (id, data) => request('PATCH', `/api/packs/${id}`, data),
  replacePackPhoto: (id, blob) => {
    const form = new FormData();
    form.append('photo', blob, blob.name || 'photo.jpg');
    return request('POST', `/api/packs/${id}/photo`, form);
  },
  deletePack: (id, withCards = false) => request('DELETE', `/api/packs/${id}${withCards ? '?withCards=1' : ''}`),
};
