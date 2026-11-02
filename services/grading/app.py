"""Local-only Viridian CV screening microservice for My Pokédex.

No card-index download, no pretrained-model claim, no automatic external upload.
Uses upstream MIT-licensed src.grading, src.backgrade, src.refgrade unchanged
(pinned commit: see docs/SOURCES.md). From the Viridian Pre-Grading Integration Kit v0.1.

Run:  python -m uvicorn services.grading.app:app --host 127.0.0.1 --port 8765
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError

ROOT = Path(__file__).resolve().parents[2]
VIRIDIAN = Path(os.environ.get('VIRIDIAN_PATH', str(ROOT / 'third_party' / 'viridian'))).resolve()
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 22_000_000
MAX_LONG_EDGE = 2400
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

# Import the original Viridian grading algorithms, never a network-facing copy.
def engine_modules():
    if not (VIRIDIAN / 'src' / 'grading.py').is_file() or not (VIRIDIAN / 'LICENSE').is_file():
        raise RuntimeError('Viridian source is missing. Run scripts/grading-setup.ps1.')
    if str(VIRIDIAN) not in sys.path:
        sys.path.insert(0, str(VIRIDIAN))
    try:
        import cv2
        import numpy as np
        from src import grading, backgrade, refgrade
        return cv2, np, grading, backgrade, refgrade
    except ImportError as exc:
        raise RuntimeError('Viridian dependencies are missing. Run scripts/grading-setup.ps1.') from exc

app = FastAPI(title='My Pokédex Viridian CV Adapter', docs_url=None, redoc_url=None)
lock = asyncio.Lock()

@app.get('/health')
def health():
    try:
        engine_modules()
    except Exception as exc:
        return {'ready': False, 'engine': 'viridian-cv', 'detail': str(exc)}
    return {'ready': True, 'engine': 'viridian-cv'}

async def read_photo(file: UploadFile) -> bytes:
    if file.content_type not in ('image/jpeg', 'image/png', 'image/webp'):
        raise HTTPException(415, 'Use JPEG, PNG, or WebP photographs.')
    data = await file.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, 'Each photo must be under 8 MB.')
    # Pillow reads dimensions before OpenCV allocates decompressed pixel buffers.
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ('JPEG', 'PNG', 'WEBP'):
                raise HTTPException(415, 'Unsupported image format.')
            w, h = im.size
            if min(w, h) < 200 or w * h > MAX_PIXELS:
                raise HTTPException(422, 'Photo dimensions are too small or too large (22 MP maximum).')
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(415, 'Unreadable photograph.') from exc
    return data

async def optional_reference(file: UploadFile | None) -> bytes | None:
    """The official picture is only a bonus for alignment: a small or odd one is skipped, never fatal."""
    if file is None:
        return None
    try:
        return await read_photo(file)
    except HTTPException:
        return None

def image_from_bytes(data: bytes, cv2, np):
    im = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        raise ValueError('Could not decode photograph.')
    height, width = im.shape[:2]
    if max(height, width) > MAX_LONG_EDGE:
        factor = MAX_LONG_EDGE / max(height, width)
        im = cv2.resize(im, (round(width * factor), round(height * factor)), interpolation=cv2.INTER_AREA)
    return im

def plain(obj):
    """Ensure numpy scalar and numeric data never break JSON encoding."""
    def converter(value):
        if hasattr(value, 'item'):
            return value.item()
        raise TypeError(f'Not serializable: {type(value).__name__}')
    return json.loads(json.dumps(obj, default=converter, allow_nan=False))

def data_uri(cv2, image):
    ok, encoded = cv2.imencode('.png', image)
    return 'data:image/png;base64,' + base64.b64encode(encoded.tobytes()).decode() if ok else None

def score_side(side):
    return {
        'centering': side['centering'], 'corners': side['corners'],
        'edges': side['edges'], 'surface': side['surface'],
        'experimental_overall': side['experimental_overall'],
    }

def looks_like_back(grading, image) -> bool:
    """Viridian's blue card-back finder; never blocks grading (Japanese/older backs may differ)."""
    try:
        return grading._blue_back_quad(image) is not None
    except Exception:
        return True


def compute(front_data: bytes, back_data: bytes, reference_data: bytes | None):
    cv2, np, grading, backgrade, refgrade = engine_modules()
    front = image_from_bytes(front_data, cv2, np)
    back = image_from_bytes(back_data, cv2, np)
    f = grading.grade_card(front)
    b = grading.grade_card(back)
    if not f.detected or not b.detected:
        raise ValueError('Could not find the full card in both photographs. Use a contrasting background.')
    if f.detect_info.get('method') == 'fullframe' or b.detect_info.get('method') == 'fullframe':
        raise ValueError('Could not confidently find the card boundary. Include the full card on a contrasting surface.')
    front_metrics = {'centering': f.centering, 'corners': f.corners, 'edges': f.edges,
                     'surface': f.surface, 'experimental_overall': f.overall}
    reference_used = False
    if reference_data:
        try:
            ref = image_from_bytes(reference_data, cv2, np)
            ref = cv2.resize(ref, (f.warped.shape[1], f.warped.shape[0]))
            measured = refgrade.measure_centering(f.warped, ref)
            if measured and measured.get('ok'):
                front_metrics['centering'] = measured
                reference_used = True
            defects = refgrade.assess_defects(f.warped, ref)
            if defects and defects.get('inliers', 0) >= 30:
                front_metrics['corners'] = defects['corners']
                front_metrics['edges'] = defects['edges']
                # Surface detector is not independently validated for every foil pattern:
                # keep it as screening only, don't automatically override surface metric.
                reference_used = True
            if reference_used:
                front_metrics['experimental_overall'] = grading._combine(
                    front_metrics['centering'], front_metrics['corners'],
                    front_metrics['edges'], front_metrics['surface'])
        except Exception:
            # Reference alignment is a bonus; never pretend an unaligned reference worked.
            reference_used = False
    back_metrics = backgrade.grade_back(b.warped)
    back_metrics.pop('overlay_img', None)
    back_reference = (VIRIDIAN / 'data' / 'refs' / 'card_back.jpg').is_file()
    back_metrics['experimental_overall'] = grading._combine(
        back_metrics['centering'], back_metrics['corners'],
        back_metrics['edges'], back_metrics['surface'])
    captures = {'front': f.capture, 'back': b.capture}
    warnings = []
    for label, capture in captures.items():
        warnings.extend(f'{label.title()}: {w}' for w in capture.get('warnings', []))
    status = 'retake' if warnings else 'complete'
    if not reference_used:
        warnings.append('Reference alignment unavailable. Front defect and centering readings are provisional.')
    if not back_reference:
        warnings.append('Back centering needs a reference picture of a clean card back (third_party/viridian/data/refs/card_back.jpg); none is installed.')
    if not looks_like_back(grading, back):
        warnings.append('The back photo doesn’t look like the usual blue Pokémon card back. Check that you uploaded the back of the same card.')
    warnings.append('Corners, edges, and surface are unvalidated visual heuristics; no trained AI model or calibrated PSA-grade probability is used.')
    overall = None
    if status == 'complete':
        fs = front_metrics['experimental_overall']
        bs = back_metrics['experimental_overall']
        overall = min(fs, bs) if fs is not None and bs is not None else None
    result = {
        'ok': True,
        'engine': 'viridian-cv',
        'status': status,
        'experimental_overall': overall,
        'front': score_side(front_metrics),
        'back': score_side(back_metrics),
        'capture': captures,
        'reference_used': reference_used,
        'warnings': warnings,
        'front_overlay': data_uri(cv2, grading.annotate_detection(
            f.warped, front_metrics['centering'], front_metrics['corners'], front_metrics['edges'])),
        'back_overlay': data_uri(cv2, grading.annotate_detection(
            b.warped, back_metrics['centering'], back_metrics['corners'], back_metrics['edges'])),
    }
    return plain(result)

@app.post('/analyze')
async def analyze(front: UploadFile = File(...), back: UploadFile = File(...),
                  reference: UploadFile | None = File(default=None)):
    if lock.locked():
        raise HTTPException(429, 'Another card is being graded.')
    async with lock:
        front_data = await read_photo(front)
        back_data = await read_photo(back)
        reference_data = await optional_reference(reference)
        try:
            return await run_in_threadpool(compute, front_data, back_data, reference_data)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
