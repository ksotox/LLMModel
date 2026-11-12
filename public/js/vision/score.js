// How card-like an outline is. Pure maths (no OpenCV), shared by every way of finding outlines.

import { CARD_ASPECT, dist, polygonArea } from './geometry.js';

/** How card-like a quadrilateral is: 1 = perfect 63:88 rectangle filled by its contour. */
export function cardScore(quad, contourArea) {
  const [tl, tr, br, bl] = quad;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const hgt = (dist(tl, bl) + dist(tr, br)) / 2;
  const aspect = Math.min(w, hgt) / Math.max(w, hgt);
  const aspectScore = Math.max(0, 1 - Math.abs(aspect - CARD_ASPECT) / 0.25);
  const fill = Math.min(1, contourArea / polygonArea(quad));
  // opposite sides should be similar in length (small perspective only)
  const parallel = Math.min(dist(tl, tr), dist(bl, br)) / Math.max(dist(tl, tr), dist(bl, br))
    * Math.min(dist(tl, bl), dist(tr, br)) / Math.max(dist(tl, bl), dist(tr, br));
  return aspectScore * fill * parallel;
}
