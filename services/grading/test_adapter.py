"""Basic upload safety checks; no Viridian clone needed for these tests."""
import asyncio
import base64
import sys
from pathlib import Path
from io import BytesIO
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import cv2
import numpy as np

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers
from PIL import Image

from services.grading.app import MAX_BYTES, compute, health, optional_reference, read_photo


class GradingAdapterSafetyTests(unittest.TestCase):
    def upload(self, data, content_type='image/png'):
        return UploadFile(filename='test.png', file=BytesIO(data), headers=Headers({'content-type': content_type}))

    @staticmethod
    def photo(size):
        data = BytesIO()
        Image.new('RGB', size, (30, 80, 140)).save(data, format='PNG')
        return data.getvalue()

    def test_healthy_response_is_well_formed(self):
        self.assertIsInstance(health()['ready'], bool)

    def test_valid_image_accepted(self):
        data = self.photo((500, 700))
        self.assertEqual(asyncio.run(read_photo(self.upload(data))), data)

    def test_invalid_image_rejected(self):
        with self.assertRaises(HTTPException) as err:
            asyncio.run(read_photo(self.upload(b'not an image')))
        self.assertEqual(err.exception.status_code, 415)

    def test_undersized_photo_rejected(self):
        with self.assertRaises(HTTPException) as err:
            asyncio.run(read_photo(self.upload(self.photo((100, 100)))))
        self.assertEqual(err.exception.status_code, 422)

    def test_analysis_contract_with_mocked_engine(self):
        # Confirms the integration response format without pretending to validate
        # the accuracy of Viridian's actual computer-vision algorithms.
        center = {'ok': True, 'grade': 9, 'confidence': 'medium',
                  'left_right': '53/47', 'top_bottom': '51/49'}
        metric = {'grade': 8, 'confidence': 'low'}
        warped = np.zeros((700, 500, 3), dtype=np.uint8)
        def grade_photo(_img):
            return SimpleNamespace(detected=True, detect_info={'method': 'edge'},
                warped=warped, centering=center, corners=metric, edges=metric,
                surface=metric, overall=8,
                capture={'ok': True, 'warnings': [], 'blur': 500})
        grading = SimpleNamespace(grade_card=grade_photo,
            _combine=lambda *_: 8,
            annotate_detection=lambda *_: warped)
        backgrade = SimpleNamespace(grade_back=lambda _: {
            'centering': center, 'corners': metric, 'edges': metric,
            'surface': metric,
        })
        with patch('services.grading.app.engine_modules', return_value=(
            cv2, np, grading, backgrade, SimpleNamespace())), \
             patch('services.grading.app.precision.scan_side', return_value={'corners': [], 'edges': []}), \
             patch('services.grading.app.precision.findings', return_value=[]):
            result = compute(self.photo((500, 700)), self.photo((500, 700)), None)
        self.assertTrue(result['ok'])
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['experimental_overall'], 8)
        self.assertTrue(result['front_overlay'].startswith('data:image/png;base64,'))
        self.assertFalse(result['reference_used'])
        self.assertEqual(result['findings'], [])
        self.assertIn('front', result['precision'])

    def test_unusable_reference_is_skipped_not_fatal(self):
        # The card's official picture can be small (e.g. a 200 px fallback image).
        self.assertIsNone(asyncio.run(optional_reference(self.upload(self.photo((100, 140))))))
        self.assertIsNone(asyncio.run(optional_reference(self.upload(b'junk'))))
        self.assertIsNone(asyncio.run(optional_reference(None)))
        good = self.photo((600, 825))
        self.assertEqual(asyncio.run(optional_reference(self.upload(good))), good)

    def test_oversize_file_rejected(self):
        with self.assertRaises(HTTPException) as err:
            asyncio.run(read_photo(self.upload(b'a' * (MAX_BYTES + 1))))
        self.assertEqual(err.exception.status_code, 413)


VIRIDIAN = Path(__file__).resolve().parents[2] / 'third_party' / 'viridian'


@unittest.skipUnless((VIRIDIAN / 'src' / 'grading.py').is_file(), 'Viridian not installed (scripts/grading-setup)')
class PrecisionScanTests(unittest.TestCase):
    """The precision scan must show exactly what upstream measured: same regions, same numbers."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(VIRIDIAN))
        from src import backgrade, grading, refgrade
        from services.grading import precision
        cls.grading, cls.backgrade, cls.refgrade, cls.precision = grading, backgrade, refgrade, precision

    @staticmethod
    def card():
        # A yellow-bordered card with a darker art box, and a white chip at the top-right corner.
        card = np.full((700, 500, 3), 30, np.uint8)            # dark table around the card (a loose crop)
        border = (20, 150, 185)                                  # BGR yellow, like a real photo's border
        x0, y0, x1, y1, r = 14, 14, 485, 685, 22
        cv2.rectangle(card, (x0 + r, y0), (x1 - r, y1), border, -1)
        cv2.rectangle(card, (x0, y0 + r), (x1, y1 - r), border, -1)
        for cx, cy in [(x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)]:
            cv2.circle(card, (cx, cy), r, border, -1)
        card[60:400, 50:450] = (90, 120, 60)
        card[20:30, 462:472] = (250, 250, 250)                   # a small white chip, top-right
        return card

    def test_masks_match_upstream_corner_and_edge_numbers(self):
        g, p = self.grading, self.precision
        card = self.card()
        corners, edges = g.assess_corners(card), g.assess_edges(card)
        metrics = {'corners': corners, 'edges': edges, 'surface': g.assess_surface(card), 'centering': {}}
        flat = cv2.resize(card, (p.HI_W, p.HI_H))
        scan = p.scan_side('front', card, flat, metrics, g, self.backgrade, self.refgrade)
        for region, frac in zip(scan['corners'], corners['per_corner']):
            self.assertAlmostEqual(region['white'] + region['dark'], frac, places=2, msg=region['key'])
        for region, frac in zip(scan['edges'], edges['per_edge']):
            self.assertAlmostEqual(region['white'] + region['dark'], frac, places=2, msg=region['key'])
        tr = next(r for r in scan['corners'] if r['key'] == 'tr')
        self.assertGreater(tr['white'], 0.05, 'the white chip is counted')
        self.assertEqual(tr['grade'], g._whitening_to_grade(corners['per_corner'][1]))
        self.assertEqual([r['key'] for r in scan['corners']], ['tl', 'tr', 'bl', 'br'])
        self.assertEqual([r['key'] for r in scan['edges']], ['top', 'bottom', 'left', 'right'])
        for uri in [scan['flat'], scan['surface_map']] + [r[k] for r in scan['corners'] + scan['edges'] for k in ('image', 'mask')]:
            self.assertTrue(uri.startswith(('data:image/jpeg;base64,', 'data:image/png;base64,')))
        top = scan['edges'][0]
        img = cv2.imdecode(np.frombuffer(base64.b64decode(top['image'].split(',', 1)[1]), np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[1], p.HI_W, 'edges are shown as long horizontal strips')

    def test_findings_only_report_what_was_measured(self):
        g, p = self.grading, self.precision
        card = self.card()
        metrics = {'corners': g.assess_corners(card), 'edges': g.assess_edges(card), 'surface': {'grade': 10, 'scuff': 0.01},
                   'centering': {'grade': 8, 'left_right': '62/38', 'top_bottom': '50/50'}}
        scan = p.scan_side('front', card, cv2.resize(card, (p.HI_W, p.HI_H)), metrics, g, self.backgrade, self.refgrade)
        clean = {'corners': {'grade': 10, 'per_corner': [0, 0, 0, 0]}, 'edges': {'grade': 10, 'per_edge': [0, 0, 0, 0]},
                 'surface': {'grade': 10, 'scuff': 0.0}, 'centering': {'grade': 10, 'left_right': '60/40'}}
        back = p.scan_side('back', card, cv2.resize(card, (p.HI_W, p.HI_H)), clean, g, self.backgrade, self.refgrade)
        items = p.findings(scan, back, metrics, clean)
        self.assertTrue(any(f['area'] == 'Top-right corner' and f['kind'] == 'possible whitening' for f in items))
        self.assertTrue(any(f['area'] == 'Centering' and f['side'] == 'front' for f in items), '62/38 is past 55/45')
        self.assertFalse(any(f['side'] == 'back' and f['area'] == 'Centering' for f in items), '60/40 is fine on the back')
        self.assertFalse(any(f['area'] == 'Surface' for f in items))
        order = [f['severity'] for f in items]
        self.assertEqual(order, sorted(order, key=['heavy', 'moderate', 'minor'].index), 'worst first')


if __name__ == '__main__':
    unittest.main()
