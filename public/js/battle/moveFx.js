// Movement effects for real-time battles, made for this app: dust kicked up by running feet (sand on
// the beach, bubbles in the Reef), a ring of dust where a fighter lands, afterimages and a streak
// when it dodges, and speed lines when it lunges. All short-lived sprites and ghost copies; fewer on
// Standard, none on Basic.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const DUST = { meadow: 0xb39a76, beach: 0xe9dcc0, reef: 0xcdefff, league: 0xb8b2a6, night: 0x9aa39a, floating: 0xc7c7d2 };

export function createMoveFx({ scene, dot, environment = 'meadow', quality = () => 'high' }) {
  const dustColor = new THREE.Color(DUST[environment] ?? DUST.meadow);
  const underwater = environment === 'reef';
  const live = []; // { object, life, max, update(k, dt) }
  const tracks = new Map(); // slot → { x, y, z, facing, history[], dustAt, air }
  const density = () => ({ high: 1, standard: 0.5 })[quality()] ?? 0;
  const add = (object, max, update) => { scene.add(object); live.push({ object, life: max, max, update }); };

  const puff = (x, y, z, { size = 0.35, rise = 0.4, drift = [0, 0], life = 0.6, color = dustColor, opacity = 0.55 } = {}) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color, transparent: true, depthWrite: false, opacity }));
    s.position.set(x, y, z);
    s.scale.setScalar(size * 0.5);
    add(s, life, (k, dt) => {
      s.position.x += drift[0] * dt;
      s.position.z += drift[1] * dt;
      s.position.y += (underwater ? rise * 1.6 : rise * k) * dt;
      s.scale.setScalar(size * (0.5 + (1 - k) * 1.3));
      s.material.opacity = opacity * k;
    });
  };

  /** A ring of dust spreading on the ground (a landing). */
  const ring = (x, z, color = dustColor) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.32, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.03, z);
    add(m, 0.45, (k) => { m.scale.setScalar(1 + (1 - k) * 4); m.material.opacity = 0.6 * k; });
    const n = Math.round(10 * density());
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      puff(x + Math.cos(a) * 0.3, 0.1, z + Math.sin(a) * 0.3, { size: 0.3, rise: 0.25, drift: [Math.cos(a) * 1.6, Math.sin(a) * 1.6], life: 0.5 });
    }
  };

  return {
    /** Each frame for each fighter: where it is (dust while running, a ring on landing). */
    track(slot, x, y, z, facing) {
      const now = performance.now() / 1000;
      const d = density();
      let t = tracks.get(slot);
      if (!t) { t = { x, y, z, facing, history: [], dustAt: 0, air: y > 0.15, time: now }; tracks.set(slot, t); }
      const dt = Math.max(1e-3, now - t.time);
      const speed = Math.hypot(x - t.x, z - t.z) / dt;
      t.history.unshift({ x, y, z, facing, time: now });
      if (t.history.length > 30) t.history.length = 30;
      if (d > 0) {
        const air = y > 0.15;
        if (t.air && !air) ring(x, z);
        if (!air && speed > 1.6 && now > t.dustAt) {
          // Behind the feet, thrown back the way it came.
          const bx = -(x - t.x) / (dt * speed);
          const bz = -(z - t.z) / (dt * speed);
          puff(x + bx * 0.25 + (Math.random() - 0.5) * 0.2, 0.08, z + bz * 0.25 + (Math.random() - 0.5) * 0.2, { size: 0.28 + speed * 0.04, drift: [bx * 0.8, bz * 0.8], life: 0.55 });
          t.dustAt = now + 0.09 / d;
        }
        t.air = air;
      }
      Object.assign(t, { x, y, z, facing, time: now });
    },

    /** A dodge: fading afterimages along the path it came by, and a streak. */
    dash(slot, body, color) {
      const d = density();
      const t = tracks.get(slot);
      if (!d || !t || !body) return;
      const tint = new THREE.Color(color ?? 0xffffff);
      const ghosts = d >= 1 ? 3 : 2;
      for (let i = 1; i <= ghosts; i++) {
        const h = t.history[Math.min(t.history.length - 1, i * 3)];
        if (!h) break;
        const ghost = cloneSkinned(body);
        const mat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
        ghost.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; } else if (o.isSprite || o.isPoints) o.visible = false; });
        ghost.position.set(h.x, body.position.y, h.z);
        add(ghost, 0.3 + i * 0.06, (k) => { mat.opacity = 0.4 * k * (1 - i * 0.18); });
      }
      const from = t.history[Math.min(t.history.length - 1, 10)] ?? t;
      const len = Math.hypot(t.x - from.x, t.z - from.z);
      if (len > 0.2) {
        const streak = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.5), new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        streak.position.set((t.x + from.x) / 2, 0.6, (t.z + from.z) / 2);
        streak.rotation.y = -Math.atan2(t.z - from.z, t.x - from.x);
        add(streak, 0.25, (k) => { streak.material.opacity = 0.35 * k; streak.scale.y = k; });
      }
    },

    /** A lunge: speed lines streaming back from the fighter. */
    speedLines(x, z, facing, color) {
      const n = Math.round(8 * density());
      const fx = Math.sin(facing);
      const fz = Math.cos(facing);
      for (let i = 0; i < n; i++) {
        const side = (Math.random() - 0.5) * 1.1;
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.9 + Math.random() * 0.6, 0.025), new THREE.MeshBasicMaterial({ color: color ?? 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        line.position.set(x - fx * 0.6 + fz * side, 0.4 + Math.random() * 0.9, z - fz * 0.6 - fx * side);
        line.rotation.y = Math.atan2(fx, fz) + Math.PI / 2;
        add(line, 0.22, (k, dt) => { line.position.x -= fx * 6 * dt; line.position.z -= fz * 6 * dt; line.material.opacity = 0.7 * k; });
      }
    },

    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.life -= dt;
        if (p.life <= 0) {
          scene.remove(p.object);
          p.object.traverse((o) => { if (o.geometry && !o.isSkinnedMesh) o.geometry.dispose(); if (o.material && o.material.map !== dot) o.material.dispose?.(); });
          live.splice(i, 1);
          continue;
        }
        p.update(p.life / p.max, dt);
      }
    },

    dispose() {
      for (const p of live) scene.remove(p.object);
      live.length = 0;
    },
  };
}
