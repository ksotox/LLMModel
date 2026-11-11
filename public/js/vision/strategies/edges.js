// The card's outline as edges (Canny), for cards on light backgrounds.

export function edges({ cv, blurred, kernel, collect }) {
  const out = new cv.Mat();
  cv.Canny(blurred, out, 40, 120);
  cv.dilate(out, out, kernel);
  collect(out, 'edges');
  out.delete();
}
