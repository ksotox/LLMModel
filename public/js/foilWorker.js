// Runs the foil measurements off the main thread, so the page stays smooth while a batch of
// cards is analysed. Messages: { id, op: 'analyse', image } or { id, op: 'compare', images }.
import { analyseCard, compareAngles } from './foil.js';

self.onmessage = ({ data: { id, op, image, images } }) => {
  try {
    const result = op === 'compare' ? compareAngles(images) : analyseCard(image);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
