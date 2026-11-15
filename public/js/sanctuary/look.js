// Smooth looking round, for the Sanctuary's camera. Mouse, touch and gamepad turns are added to a
// pending amount, which reaches the camera through two low-pass stages in a row, so the view glides
// instead of jumping with each mouse event (the idea from the MIT-licensed Abyssal Garden, written
// here for our camera). Everything eases with 1 − e^(−rate·dt), so it feels the same at any frame rate.

/** How much of the way to go this frame, whatever the frame rate. */
export const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

export function createLook({ yaw = 0, pitch = 0.32, min = -0.1, max = 1.2 } = {}) {
  return { yaw, pitch, min, max, pending: [0, 0], stage: [0, 0] };
}

/** A turn to make (radians): `dx` round, `dy` up and down. */
export function addLook(look, dx, dy) {
  look.pending[0] += dx;
  look.pending[1] += dy;
}

/** Move the view on by `dt` seconds through the two stages. */
export function stepLook(look, dt, rate = 30) {
  const k = ease(dt, rate);
  for (let i = 0; i < 2; i++) {
    const a = look.pending[i] * k;
    look.pending[i] -= a;
    look.stage[i] += a;
  }
  const dyaw = look.stage[0] * k;
  const dpitch = look.stage[1] * k;
  look.stage[0] -= dyaw;
  look.stage[1] -= dpitch;
  look.yaw += dyaw;
  look.pitch = Math.min(look.max, Math.max(look.min, look.pitch + dpitch));
  return look;
}
