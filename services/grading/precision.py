"""Precision scan for the pre-grading report.

Shows *where* Viridian's measurements come from, without adding any grading rules of our own:
  * a high-resolution flattened picture of each side (for the virtual slab and close-ups),
  * a close-up of each corner and edge, with a transparent "screening map" marking the pixels
    Viridian's whitening / dark-mark test counted in exactly the region it measures,
  * a surface map marking the small scuff-like features its surface test counts,
  * per-corner / per-edge sub-grades from Viridian's own fraction-to-grade tables,
  * a list of findings built only from those measurements.

The masks reproduce upstream's logic (src.grading._wear_frac / assess_corners / assess_edges /
assess_surface for the front, src.backgrade._white_mask / _assess_corners / _assess_edges for
the back) on the same 500x700 warp, so the marked pixels are the ones behind the numbers.
"""
from __future__ import annotations

import base64

import cv2
import numpy as np

HI_W, HI_H = 800, 1120          # flattened picture size (5:7, like the card)
CORNER_CROP = 0.20              # close-up box, as a fraction of the card width
EDGE_CROP = 0.075               # edge strip thickness, as a fraction of the card width
CORNERS = [('tl', 'Top-left corner'), ('tr', 'Top-right corner'), ('bl', 'Bottom-left corner'), ('br', 'Bottom-right corner')]
EDGES = [('top', 'Top edge'), ('bottom', 'Bottom edge'), ('left', 'Left edge'), ('right', 'Right edge')]
WHITE_BGRA = (180, 40, 255, 220)     # pink: bright, colourless pixels (possible whitening)
DARK_BGRA = (255, 200, 0, 220)       # cyan: dark outliers (possible dirt / dark damage)
SCUFF_BGRA = (0, 210, 255, 200)      # amber: small scuff-like features on the surface
OUTLINE_BGRA = (255, 255, 255, 170)  # the measured region


def _uri(kind: str, image) -> str | None:
    ok, buf = cv2.imencode('.png' if kind == 'png' else '.jpg', image, [] if kind == 'png' else [cv2.IMWRITE_JPEG_QUALITY, 88])
    return f"data:image/{'png' if kind == 'png' else 'jpeg'};base64,{base64.b64encode(buf.tobytes()).decode()}" if ok else None


def severity(grade) -> str:
    if grade is None:
        return 'unknown'
    return 'none' if grade >= 9 else 'minor' if grade >= 8 else 'moderate' if grade >= 6 else 'heavy'


def flatten(image, quad, grading):
    """The card cut out and straightened at high resolution from the detected outline."""
    rect = grading._order_points(np.array(quad, dtype='float32'))
    dst = np.array([[0, 0], [HI_W - 1, 0], [HI_W - 1, HI_H - 1], [0, HI_H - 1]], dtype='float32')
    return cv2.warpPerspective(image, cv2.getPerspectiveTransform(rect, dst), (HI_W, HI_H), flags=cv2.INTER_CUBIC)


def _front_regions(card, grading):
    """Front: upstream's corner boxes (9 %, rounded) and edge strips (2 % in, 3 % wide), with
    the white / dark masks of _wear_frac (relative to each region's own median brightness)."""
    h, w = card.shape[:2]
    hsv = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1], hsv[:, :, 2]
    bg, present = grading._estimate_bg(card)
    bg = bg if present else None

    def masks(ys, xs, region=None):
        vp, sp, bp = v[ys, xs], s[ys, xs], card[ys, xs]
        valid = np.ones(vp.shape, bool) if region is None else region.copy()
        if bg is not None:
            valid &= np.linalg.norm(bp.astype(np.int16) - bg, axis=2) >= 40
        if int(valid.sum()) < 10:
            empty = np.zeros(vp.shape, bool)
            return empty, empty, valid
        med = float(np.median(vp[valid]))
        white = (vp > max(med + 35, 180)) & (sp < 45) & valid
        dark = (vp < min(med - 60, 55)) & valid
        return white, dark, valid

    size, r = int(min(h, w) * 0.09), int(min(h, w) * 0.055)
    base = grading._rounded_corner_mask(size, r)
    shapes = [base, base[:, ::-1], base[::-1, :], base[::-1, ::-1]]
    spots = [(0, 0), (w - size, 0), (0, h - size), (w - size, h - size)]
    corners = []
    for (rx, ry), mk in zip(spots, shapes):
        ys, xs = slice(ry, ry + size), slice(rx, rx + size)
        corners.append((ys, xs, *masks(ys, xs, mk)))
    o, t = int(min(h, w) * 0.02), int(min(h, w) * 0.03)
    edges = []
    for ys, xs in [(slice(o, o + t), slice(0, w)), (slice(h - o - t, h - o), slice(0, w)),
                   (slice(0, h), slice(o, o + t)), (slice(0, h), slice(w - o - t, w - o))]:
        edges.append((ys, xs, *masks(ys, xs)))
    return corners, edges


def _back_regions(card, grading, backgrade):
    """Back: upstream's white mask (colourless relative to the blue field), corner boxes 10 %
    (rounded), edge strips 1.5 % in, 3 % wide. The back test has no dark-mark part."""
    h, w = card.shape[:2]
    white = backgrade._white_mask(card)
    sz, r = int(min(h, w) * 0.10), int(min(h, w) * 0.06)
    base = grading._rounded_corner_mask(sz, r)
    shapes = [base, base[:, ::-1], base[::-1, :], base[::-1, ::-1]]
    spots = [(0, 0), (w - sz, 0), (0, h - sz), (w - sz, h - sz)]
    corners = []
    for (rx, ry), mk in zip(spots, shapes):
        ys, xs = slice(ry, ry + sz), slice(rx, rx + sz)
        corners.append((ys, xs, white[ys, xs] & mk, np.zeros(mk.shape, bool), mk))
    o, t = int(min(h, w) * 0.015), int(min(h, w) * 0.03)
    edges = []
    for ys, xs in [(slice(o, o + t), slice(0, w)), (slice(h - o - t, h - o), slice(0, w)),
                   (slice(0, h), slice(o, o + t)), (slice(0, h), slice(w - o - t, w - o))]:
        m = white[ys, xs]
        edges.append((ys, xs, m, np.zeros(m.shape, bool), np.ones(m.shape, bool)))
    return corners, edges


def _surface_mask(card):
    """Upstream assess_surface: top-hat / black-hat features (> 28) inside the inner 80 %."""
    h, w = card.shape[:2]
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    y0, y1, x0, x1 = int(h * 0.12), int(h * 0.88), int(w * 0.10), int(w * 0.90)
    inner = gray[y0:y1, x0:x1]
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    hits = (cv2.morphologyEx(inner, cv2.MORPH_TOPHAT, k) > 28) | (cv2.morphologyEx(inner, cv2.MORPH_BLACKHAT, k) > 28)
    full = np.zeros((h, w), bool)
    full[y0:y1, x0:x1] = hits
    return full


def _layer(shape, regions, surface=None):
    """A transparent BGRA layer (at 500x700) with the counted pixels coloured in."""
    layer = np.zeros((*shape, 4), np.uint8)
    if surface is not None:
        layer[surface] = SCUFF_BGRA
    for ys, xs, white, dark, _valid in regions:
        sub = layer[ys, xs]
        sub[dark] = DARK_BGRA
        sub[white] = WHITE_BGRA
    return layer


def _sub_grade(frac, method, kind, grading, refgrade):
    if frac is None:
        return None
    if str(method or '').startswith('reference'):
        table = refgrade._REF_CORNER_THR if kind == 'corner' else refgrade._REF_EDGE_THR
        return int(refgrade._ref_frac_to_grade(frac, table))
    return int(grading._whitening_to_grade(frac))


def scan_side(side: str, warped, flat, metrics, grading, backgrade, refgrade):
    """Everything the report shows for one side. `warped` is upstream's 500x700 warp (what was
    measured), `flat` the high-resolution picture of the same card (what is shown)."""
    h, w = warped.shape[:2]
    if side == 'front':
        corners, edges = _front_regions(warped, grading)
        surface = _surface_mask(warped)
    else:
        corners, edges = _back_regions(warped, grading, backgrade)
        surface = _surface_mask(warped)   # backgrade uses grading.assess_surface on the back too
    layer = _layer((h, w), corners + edges)
    layer_hi = cv2.resize(layer, (HI_W, HI_H), interpolation=cv2.INTER_NEAREST)
    sx, sy = HI_W / w, HI_H / h

    out = {'flat': _uri('jpg', flat), 'corners': [], 'edges': []}
    cm, em = metrics.get('corners') or {}, metrics.get('edges') or {}
    per_corner, per_edge = cm.get('per_corner') or [], em.get('per_edge') or []

    c = int(HI_W * CORNER_CROP)
    boxes = {'tl': (0, 0), 'tr': (HI_W - c, 0), 'bl': (0, HI_H - c), 'br': (HI_W - c, HI_H - c)}
    for i, ((key, label), (ys, xs, white, dark, valid)) in enumerate(zip(CORNERS, corners)):
        x, y = boxes[key]
        img = flat[y:y + c, x:x + c].copy()
        mask = layer_hi[y:y + c, x:x + c].copy()
        # outline of the region that was measured
        rx0, ry0 = int(xs.start * sx) - x, int(ys.start * sy) - y
        rx1, ry1 = int(xs.stop * sx) - x - 1, int(ys.stop * sy) - y - 1
        cv2.rectangle(mask, (max(rx0, 0), max(ry0, 0)), (min(rx1, c - 1), min(ry1, c - 1)), OUTLINE_BGRA, 1)
        n = max(int(valid.sum()), 1)
        frac = per_corner[i] if i < len(per_corner) else None
        grade = _sub_grade(frac, cm.get('method'), 'corner', grading, refgrade)
        out['corners'].append({
            'key': key, 'label': label, 'fraction': frac, 'grade': grade, 'severity': severity(grade),
            'white': round(float(white.sum()) / n, 4), 'dark': round(float(dark.sum()) / n, 4),
            'image': _uri('jpg', img), 'mask': _uri('png', mask),
        })

    t = int(HI_W * EDGE_CROP)
    for i, ((key, label), (ys, xs, white, dark, valid)) in enumerate(zip(EDGES, edges)):
        if key in ('top', 'bottom'):
            y = 0 if key == 'top' else HI_H - t
            img, mask = flat[y:y + t].copy(), layer_hi[y:y + t].copy()
        else:
            x = 0 if key == 'left' else HI_W - t
            img, mask = flat[:, x:x + t].copy(), layer_hi[:, x:x + t].copy()
        # Shown as horizontal strips with the card's outer edge at the top.
        turn = {'top': None, 'bottom': cv2.ROTATE_180, 'left': cv2.ROTATE_90_CLOCKWISE, 'right': cv2.ROTATE_90_COUNTERCLOCKWISE}[key]
        if turn is not None:
            img, mask = cv2.rotate(img, turn), cv2.rotate(mask, turn)
        n = max(int(valid.sum()), 1)
        frac = per_edge[i] if i < len(per_edge) else None
        grade = _sub_grade(frac, em.get('method'), 'edge', grading, refgrade)
        out['edges'].append({
            'key': key, 'label': label, 'fraction': frac, 'grade': grade, 'severity': severity(grade),
            'white': round(float(white.sum()) / n, 4), 'dark': round(float(dark.sum()) / n, 4),
            'image': _uri('jpg', img), 'mask': _uri('png', mask),
        })

    surf_layer = np.zeros((h, w, 4), np.uint8)
    surf_layer[surface] = SCUFF_BGRA
    out['surface_map'] = _uri('png', cv2.resize(surf_layer, (HI_W, HI_H), interpolation=cv2.INTER_NEAREST))
    return out


def _ratio(text):
    try:
        a, b = (float(x) for x in str(text).split('/'))
        return max(a, b)
    except (TypeError, ValueError):
        return None


def findings(front_scan, back_scan, front_metrics, back_metrics) -> list[dict]:
    """A plain list of what the measurements flagged, worst first. Nothing is added that the
    numbers don't show; every item says which measurement it comes from."""
    items = []
    for side, scan, metrics in (('front', front_scan, front_metrics), ('back', back_scan, back_metrics)):
        for group, kind in (('corners', 'corner'), ('edges', 'edge')):
            method = (metrics.get(group) or {}).get('method') or 'screening'
            for region in scan[group]:
                sev = region['severity']
                if sev in ('none', 'unknown'):
                    continue
                if str(method).startswith('reference'):
                    what, detail = 'difference from the official picture', f"{region['fraction'] * 100:.1f}% of the {kind} differs from the aligned official picture"
                elif region['dark'] > region['white']:
                    what, detail = 'dark marks', f"{region['dark'] * 100:.1f}% of the measured {kind} area is darker than its surroundings (dirt, ink or damage)"
                else:
                    what, detail = 'possible whitening', f"{region['white'] * 100:.1f}% of the measured {kind} area is bright and colourless"
                items.append({'side': side, 'area': region['label'], 'kind': what, 'severity': sev, 'grade': region['grade'], 'detail': detail})
        surf = metrics.get('surface') or {}
        sev = severity(surf.get('grade'))
        if sev not in ('none', 'unknown') and surf.get('scuff') is not None:
            items.append({'side': side, 'area': 'Surface', 'kind': 'scuff-like marks', 'severity': sev, 'grade': surf.get('grade'),
                          'detail': f"{surf['scuff'] * 100:.1f}% of the inner card area shows small scratch- or scuff-like features (holo patterns can add to this)"})
        cen = metrics.get('centering') or {}
        worst = max(filter(None, [_ratio(cen.get('left_right')), _ratio(cen.get('top_bottom'))]), default=None)
        limit = 55 if side == 'front' else 75
        if worst is not None and worst > limit:
            sev = 'minor' if worst <= limit + 5 else 'moderate' if worst <= limit + 10 else 'heavy'
            items.append({'side': side, 'area': 'Centering', 'kind': 'off-centre', 'severity': sev, 'grade': cen.get('grade'),
                          'detail': f"L/R {cen.get('left_right', '?')}, T/B {cen.get('top_bottom', '?')}: beyond the {limit}/{100 - limit} usually allowed for a top grade on the {side}"})
    order = {'heavy': 0, 'moderate': 1, 'minor': 2}
    return sorted(items, key=lambda f: (order.get(f['severity'], 3), f['side'] != 'front'))
