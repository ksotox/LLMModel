import { api } from './api.js';
import { h, clear, toast, VARIANT_LABELS, confirmDialog } from './ui.js';
import { findCards } from './vision.js';
import { loadImage, cutCard, canvasToBlob } from './images.js';
import { recognizeCut } from './scan/recognize.js';
import { printingFields, PRINTING_DEFAULTS } from './printing.js';
import { artworkHash, compareArtwork } from './scan/matching.js';
import { repeatOf, recognitionStatus, validationReport } from './scan/core.js';
import { sessionStore } from './scan/storage.js';

const pendingSaves = new Map();
// Photo upload also works on ordinary HTTP, where randomUUID may be unavailable.
const scanId = () => globalThis.crypto.randomUUID?.() ?? [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');

export async function renderScanner(root, meta, navigate) {
  const userKey = String(window.currentUser?.id ?? 'local');
  if (pendingSaves.has(userKey)) {
    clear(root, h('p', 'Finishing your previous scan save…'));
    await pendingSaves.get(userKey);
    if (!root.isConnected) return;
  }
  let entries = [], stream = null, active = false, busy = false, disposed = false, timer, generation = 0, saving = false;
  let previous = [], stableSince = 0, repeatCount = 0;
  const urls = new Set();
  const video = h('video', { autoplay: true, muted: true, playsInline: true, 'aria-label': 'Live card camera' });
  const overlay = h('canvas.scan-overlay', { 'aria-hidden': 'true' });
  const idle = h('div.scan-idle', 'Camera paused · Start camera or upload photos');
  const camera = h('div.scan-camera', video, overlay, idle);
  const message = h('p.muted', { role: 'status' }, 'Lay cards flat with space between them. Start with 5–10 visible cards and move slowly.');
  const counter = h('strong');
  const tray = h('div.scan-tray');
  const target = h('input', { type: 'number', min: 1, max: 1000, value: 60, 'aria-label': 'Deck size' });
  const start = h('button.btn.primary', { onclick: startCamera }, 'Start camera');
  const pause = h('button.btn', { disabled: true, onclick: stopCamera }, 'Pause camera');
  const save = h('button.btn.primary', { onclick: saveReviewed }, 'Save reviewed cards');
  const upload = h('input', { type: 'file', accept: 'image/*', multiple: true, 'aria-label': 'Upload deck photos', onchange: async () => {
    if (busy || saving) return;
    stopCamera(); busy = true; controls();
    const version = generation;
    try {
      for (const file of upload.files) {
        const img = await loadImage(file);
        try { await scanImage(img, version, false); } finally { URL.revokeObjectURL(img.objectUrl); }
        if (disposed || version !== generation) break;
      }
    } catch (err) { message.textContent = err.message; }
    finally { busy = false; upload.value = ''; controls(); }
  } });
  const torch = h('button.btn', { hidden: true, onclick: async () => {
    const track = stream?.getVideoTracks()[0]; if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !track.getSettings().torch }] }); }
    catch { toast('This camera cannot switch its light.', 'error'); }
  } }, 'Camera light');
  let persistVersion = 0;
  const persist = async () => {
    const version = ++persistVersion; root.dataset.sessionSaved = 'false';
    try { await sessionStore(userKey, { entries, target: target.value }); if (version === persistVersion) root.dataset.sessionSaved = 'true'; }
    catch { message.textContent = 'Browser storage is unavailable or full. Keep this page open until you save or export your scan.'; }
  };
  function controls() {
    start.disabled = busy || saving || active; pause.disabled = !active; upload.disabled = busy || saving || active;
    if (clearSession) clearSession.disabled = busy || saving;
    save.disabled = busy || saving || !entries.some((e) => e.reviewed && !e.saved);
  }
  function stopCamera() {
    active = false; camera.classList.remove('active'); idle.hidden = false; generation++; clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null;
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    torch.hidden = true; previous = []; stableSince = 0; controls();
  }
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      message.textContent = 'Live camera needs HTTPS on your phone, or localhost on this computer. You can upload photos below.'; return;
    }
    start.disabled = true;
    const version = ++generation;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
      if (disposed || version !== generation) { acquired.getTracks().forEach((t) => t.stop()); return; }
      stream = acquired; video.srcObject = stream; await video.play();
      active = true; camera.classList.add('active'); idle.hidden = true;
      torch.hidden = !stream.getVideoTracks()[0].getCapabilities?.().torch;
      message.textContent = 'Hold steady. Amber outlines need review; green outlines have a reviewed match. Repeated sightings do not add copies.';
      controls(); tick();
    } catch (err) { stopCamera(); message.textContent = `Camera unavailable: ${err.message}. Use Upload deck photos below.`; }
  }
  function draw(quads, states, img) {
    overlay.width = img.naturalWidth; overlay.height = img.naturalHeight;
    const ctx = overlay.getContext('2d'); ctx.lineWidth = Math.max(3, overlay.width / 250);
    quads.forEach((q, i) => { ctx.strokeStyle = states[i] ? '#16a34a' : '#f59e0b'; ctx.beginPath(); q.forEach((p, j) => j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke(); });
  }
  async function tick() {
    if (!active || disposed) return;
    if (busy) { timer = setTimeout(tick, 400); return; }
    busy = true; controls(); const version = generation;
    let img;
    try {
      if (!video.videoWidth) return;
      const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight;
      frame.getContext('2d').drawImage(video, 0, 0);
      img = await loadImage(await canvasToBlob(frame, 'frame.jpg'));
      await scanImage(img, version, true);
    } catch (err) { if (!disposed && version === generation) message.textContent = `Scan paused: ${err.message}`; }
    finally {
      if (img) URL.revokeObjectURL(img.objectUrl);
      busy = false; controls();
      if (active && version === generation) timer = setTimeout(tick, 500);
    }
  }
  async function scanImage(img, version, live) {
    const quads = await findCards(img);
    if (disposed || version !== generation) return;
    if (!quads.length) { message.textContent = 'No card outlines found. Move closer, leave space, or use Add cards to adjust a photo manually.'; previous = []; stableSince = 0; return; }
    // Require two nearby observations and at least half a second at rest before OCR.
    const centers = quads.map((q) => ({ x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 }));
    if (live) {
      const steady = centers.length === previous.length && centers.every((p, i) => Math.hypot(p.x - previous[i].x, p.y - previous[i].y) < img.naturalWidth * .012);
      previous = centers;
      if (!steady) stableSince = Date.now();
      draw(quads, [], img);
      if (!steady || Date.now() - stableSince < 500) return;
    }
    const states = [];
    for (const [i, quad] of quads.entries()) {
      if (disposed || version !== generation || entries.length >= 300) break;
      const started = performance.now();
      const cut = await cutCard(img, quad, 'scan-card');
      if (disposed || version !== generation) return;
      if (live && cut.quality.problems.length) { message.textContent = `Move closer or adjust the light: ${cut.quality.problems.join(', ')}.`; continue; }
      let hash = artworkHash(cut.canvas);
      const seen = repeatOf(entries, hash);
      if (seen) { states[i] = seen.reviewed; repeatCount++; continue; }
      message.textContent = `Reading card ${i + 1} of ${quads.length}…`;
      let readings, result, image, attempts, capturedBlob = cut.blob;
      try {
        const recognized = await recognizeCut(cut, img, quad, () => disposed || version !== generation);
        ({ readings, result, attempts } = recognized);
        capturedBlob = recognized.blob; hash = artworkHash(recognized.canvas);
        image = await compareArtwork(hash, result.candidates);
      } catch (err) {
        result = { confidence: 'low', candidates: [], match: null }; image = { evidence: 'unavailable', error: err.message };
      }
      if (disposed || version !== generation) return;
      const repeated = repeatOf(entries, hash, result.match);
      if (repeated) { states[i] = repeated.reviewed; repeatCount++; continue; }
      entries.push({ id: scanId(), hash, blob: capturedBlob, quality: cut.quality, readings, attempts, match: result.match, candidates: result.candidates,
        predictedId: result.match?.tcgId ?? null, expectedId: '', confidence: result.confidence, image, status: recognitionStatus(result, image),
        elapsedMs: Math.round(performance.now() - started), variant: 'normal', ...PRINTING_DEFAULTS, quantity: 1, reviewed: false, saved: false });
      await persist(); renderTray();
    }
    if (live) draw(quads, states, img);
    message.textContent = entries.length >= 300 ? 'Session limit reached (300 distinct scans). Save or clear this session to continue.' : `Scan retained. ${repeatCount} repeated sightings ignored. Verify the card and finish before saving; add physical copies explicitly.`;
  }
  function changed(entry) { entry.reviewed = false; persist(); controls(); }
  function renderTray() {
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
    counter.textContent = `${entries.reduce((n, e) => n + e.quantity, 0)} / ${target.value} cards · ${entries.filter((e) => e.reviewed).length} reviewed`;
    clear(tray, entries.map((entry) => {
      const url = URL.createObjectURL(entry.blob); urls.add(url);
      const choose = h('select', { 'aria-label': 'Matched card', disabled: entry.saved || entry.attempted || saving, onchange: () => { entry.match = entry.candidates.find((c) => c.tcgId === choose.value) ?? null; changed(entry); renderTray(); } },
        h('option', { value: '' }, 'Choose a match'), entry.candidates.map((c) => h('option', { value: c.tcgId }, `${c.name} · ${c.setCode ?? c.setName ?? ''} ${c.number ?? ''}`)));
      choose.value = entry.match?.tcgId ?? '';
      const variant = h('select', { 'aria-label': 'Finish type', disabled: entry.saved || entry.attempted || saving, onchange: () => { entry.variant = variant.value; changed(entry); reviewed.checked = false; } }, meta.variants.map((v) => h('option', { value: v }, VARIANT_LABELS[v] ?? v)));
      variant.value = entry.variant;
      const reviewed = h('input', { type: 'checkbox', checked: entry.reviewed, disabled: entry.saved || entry.attempted || saving || !entry.match, onchange: () => { entry.reviewed = reviewed.checked; persist(); controls(); counter.textContent = `${entries.reduce((n, e) => n + e.quantity, 0)} / ${target.value} cards · ${entries.filter((e) => e.reviewed).length} reviewed`; } });
      const fieldset = h('fieldset', { disabled: entry.saved || entry.attempted || saving }, printingFields(entry, h, () => { changed(entry); reviewed.checked = false; }));
      const label = h('input', { type: 'text', value: entry.expectedId ?? '', placeholder: 'e.g. sv02-066', 'aria-label': 'Verified catalog ID for accuracy validation', onchange: () => { entry.expectedId = label.value.trim(); persist(); } });
      return h('article.scan-card', h('img', { src: url, alt: 'Captured card', loading: 'lazy' }), h('div.scan-review',
        h('strong', entry.saved ? 'Saved to collection' : entry.status), h('p.muted', `${entry.attempted && !entry.saved ? 'Save awaiting confirmation; retry to finish. ' : ''}${entry.confidence} OCR confidence · image evidence: ${entry.image?.evidence ?? 'unavailable'}`),
        entry.quality?.problems.length ? h('p', `Retake suggested: ${entry.quality.problems.join(', ')}`) : null,
        h('label.field', h('span', 'Matched card'), choose),
        h('button.btn.small', { disabled: entry.saved || entry.attempted || saving, onclick: async () => {
          const name = prompt('Card name, set code or collector number to search for:'); if (!name) return;
          try { const found = await api.lookup({ name }); if (disposed) return; entry.candidates = found.results; changed(entry); renderTray(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Find another match'),
        h('label.field', h('span', 'Finish type'), variant), fieldset,
        h('p.muted', 'Pattern, texture, stamps and edition need visual verification. Options do not prove a printing exists. Special printing prices are left blank.'),
        h('label', reviewed, ' I checked the card, finish and physical copy count'),
        h('div.actions', h('button.btn.small', { disabled: entry.saved || entry.attempted || saving, onclick: () => { entries.push({ ...structuredClone(entry), id: scanId(), quantity: 1, reviewed: false, saved: false }); persist(); renderTray(); } }, 'Separate printing'), h('span', `${entry.quantity} physical ${entry.quantity === 1 ? 'copy' : 'copies'}`),
          h('button.btn.small', { disabled: entry.saved || entry.attempted || saving || entry.quantity >= 60, onclick: () => { entry.quantity++; changed(entry); renderTray(); } }, '+ Copy'),
          h('button.btn.small', { disabled: entry.saved || entry.attempted || saving || entry.quantity <= 1, onclick: () => { entry.quantity--; changed(entry); renderTray(); } }, '− Copy'),
          h('button.btn.small', { disabled: entry.saved || entry.attempted || saving, onclick: () => { entries = entries.filter((e) => e !== entry); persist(); renderTray(); } }, 'Remove')),
        h('details', h('summary', 'Accuracy validation'), h('label.field', h('span', 'Manually verified catalog ID'), label))));
    })); controls();
  }
  async function saveReviewed() {
    stopCamera();
    const selected = entries.filter((e) => e.reviewed && e.match && !e.saved);
    if (!selected.length || saving || busy) return;
    let releaseSave;
    pendingSaves.set(userKey, new Promise((resolve) => { releaseSave = resolve; }));
    saving = true; controls(); renderTray();
    try {
      const payload = selected.flatMap((e) => Array.from({ length: e.quantity }, (_, i) => ({ photo: e.blob, scan_token: `${e.id}-${i}`, name: e.match.name, tcg_id: e.match.tcgId,
        set_code: e.match.setCode, number: e.match.number, variant: e.variant, ...Object.fromEntries(Object.keys(PRINTING_DEFAULTS).map((k) => [k, e[k]])) })));
      const owned = await api.duplicates(payload.filter((p) => p.scan_token.endsWith('-0')));
      if (owned.owned?.some((n) => n > 0) && !await confirmDialog('Some cards are already in your collection. Add these reviewed physical copies?', { okLabel: 'Add copies', danger: false })) return;
      // Save bounded batches; per-copy tokens make retrying a lost response safe.
      for (const e of selected) {
        e.attempted = true; await persist();
        await api.createCards(payload.filter((p) => p.scan_token.startsWith(e.id)));
        e.saved = true; await persist();
      }
      toast('Reviewed cards saved to your collection', 'success');
    } catch (err) { toast(`Save interrupted: ${err.message}. Retry safely from this session.`, 'error'); }
    finally { saving = false; pendingSaves.delete(userKey); releaseSave(); if (!disposed) renderTray(); }
  }
  const clearSession = h('button.btn', { onclick: async () => {
    if (busy || saving || !await confirmDialog('Clear this scan session? Saved collection cards will stay.', { okLabel: 'Clear session' })) return;
    stopCamera(); entries = []; repeatCount = 0; await persist(); renderTray();
  } }, 'Clear session');
  clear(root, h('div.page-head', h('h1', 'Scan a deck'), h('p.muted', 'Scan visible cards as you move across the table. Cards hidden in a stack cannot be read.')),
    h('section.panel', h('div.actions', h('label', 'Deck size ', target), counter),
      camera, h('div.actions', start, pause, torch), message,
      h('label.field', h('span', 'Upload deck photos'), upload)),
    h('section.panel', h('h2', 'Review your scan'), h('p.muted', 'Similar cards are held as one scan. Use + Copy for identical copies, or Separate printing for a copy with a different finish.'),
      h('div.actions', save, h('a.btn', { href: '#/' }, 'Collection'),
        h('button.btn', { onclick: () => {
          const blob = new Blob([JSON.stringify(validationReport(entries), null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: 'scan-validation.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } }, 'Export accuracy results'),
        clearSession), tray));
  target.addEventListener('change', () => { target.value = Math.max(1, Math.min(1000, Number(target.value) || 60)); persist(); renderTray(); });
  try { const stored = await sessionStore(userKey); entries = stored?.entries ?? []; target.value = stored?.target ?? 60; } catch { message.textContent = 'Session recovery unavailable in this browser. Keep the page open until saving.'; }
  renderTray();
  const dispose = () => { if (disposed) return; disposed = true; stopCamera(); for (const url of urls) URL.revokeObjectURL(url); observer.disconnect(); window.removeEventListener('pagehide', dispose); document.removeEventListener('visibilitychange', hidden); };
  const hidden = () => { if (document.hidden) stopCamera(); };
  const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); });
  observer.observe(document.getElementById('view'), { childList: true });
  window.addEventListener('pagehide', dispose); document.addEventListener('visibilitychange', hidden);
}
