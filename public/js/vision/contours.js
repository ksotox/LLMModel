// Turning OpenCV shapes into candidate card outlines. Needs the OpenCV module (`cv`) passed in, so
// the same code runs in the page, in a worker, and in Node.

import { orderCorners } from './geometry.js';
import { cardScore } from './score.js';

/** Reduce a contour to 4 corners: approxPolyDP with growing tolerance, else its rotated bounding box. */
export function contourToQuad(cv, contour) {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
  const peri = cv.arcLength(hull, true);
  let quad = null;
  for (const eps of [0.01, 0.02, 0.03, 0.04, 0.06, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, eps * peri, true);
    const corners = approx.rows;
    if (corners === 4) {
      quad = [];
      for (let i = 0; i < 4; i++) quad.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
    }
    approx.delete();
    if (quad || corners < 4) break;
  }
  if (!quad) {
    const rect = cv.minAreaRect(hull);
    quad = cv.RotatedRect.points(rect).map((p) => ({ x: p.x, y: p.y }));
  }
  hull.delete();
  return orderCorners(quad);
}

/**
 * The card-shaped outer shapes of a binary image, as candidates { quad, score, area, label }.
 * `offset` is the padding added around the photo (removed from the corners).
 */
export function collectCandidates(cv, binary, { offset = 0, minArea, maxArea, label, minScore = 0.45 }, out = []) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minArea && area <= maxArea) {
      const quad = contourToQuad(cv, c).map((p) => ({ x: p.x - offset, y: p.y - offset }));
      const score = cardScore(quad, area);
      if (score > minScore) out.push({ quad, score, area, label });
    }
    c.delete();
  }
  contours.delete();
  hierarchy.delete();
  return out;
}
