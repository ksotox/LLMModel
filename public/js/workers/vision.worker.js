// The card finder in a background worker, so the page stays smooth while a photo is searched
// (about half a second each). The page's side is findCards() in ../vision.js.

import { serve } from './rpc.js';
import { loadOpenCV } from '../vision/opencv.js';
import { detectQuads } from '../vision/detect.js';

serve({
  /** Load OpenCV ahead of the first photo. */
  async warm() {
    await loadOpenCV();
    return true;
  },
  /** { image: ImageData-like { data, width, height }, options } → quads in the image's pixels. */
  async detect({ image, options = {} }) {
    const { cv } = await loadOpenCV();
    return detectQuads(cv, image, options);
  },
});
