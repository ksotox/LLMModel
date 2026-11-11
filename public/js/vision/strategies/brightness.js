// Card borders are lighter than most tables: threshold the brightness (Otsu), close small gaps,
// then take the outer shapes.

export function brightness({ cv, blurred, kernel, collect }) {
  const bin = new cv.Mat();
  cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);
  collect(bin, 'bright');
  bin.delete();
}
