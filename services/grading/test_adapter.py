"""Basic upload safety checks; no Viridian clone needed for these tests."""
import asyncio
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
            cv2, np, grading, backgrade, SimpleNamespace())):
            result = compute(self.photo((500, 700)), self.photo((500, 700)), None)
        self.assertTrue(result['ok'])
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['experimental_overall'], 8)
        self.assertTrue(result['front_overlay'].startswith('data:image/png;base64,'))
        self.assertFalse(result['reference_used'])

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


if __name__ == '__main__':
    unittest.main()
