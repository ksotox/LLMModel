// The Sanctuary's trainer: an original little low-poly figure (no game character), in the colours
// of the chosen preset, with a glider for long falls. Shared by the meadow and the Reef.

/** Build it with `THREE`. Returns { avatar, legs, arms, glider, dress(preset) }. */
export function buildTrainer(THREE) {
  const avatar = new THREE.Group();
  const mats = {
    hat: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    shirt: new THREE.MeshStandardMaterial({ roughness: 0.85 }),
    skin: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.9 }),
    pack: new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 }),
    glider: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7, side: THREE.DoubleSide }),
  };
  const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; avatar.add(m); return m; };
  const legs = [part(new THREE.CapsuleGeometry(0.11, 0.42, 4, 8), mats.dark, -0.13, 0.36, 0), part(new THREE.CapsuleGeometry(0.11, 0.42, 4, 8), mats.dark, 0.13, 0.36, 0)];
  part(new THREE.CapsuleGeometry(0.26, 0.42, 4, 10), mats.shirt, 0, 1.02, 0);
  const arms = [part(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), mats.shirt, -0.36, 1.05, 0), part(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), mats.shirt, 0.36, 1.05, 0)];
  part(new THREE.SphereGeometry(0.22, 16, 12), mats.skin, 0, 1.58, 0);
  part(new THREE.CylinderGeometry(0.235, 0.235, 0.14, 16), mats.hat, 0, 1.74, 0);
  part(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 12), mats.hat, 0, 1.68, 0.24).scale.set(1.2, 1, 1);
  part(new THREE.BoxGeometry(0.36, 0.44, 0.18), mats.pack, 0, 1.05, -0.3);
  const gliderGeo = new THREE.BufferGeometry();
  gliderGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1.5, 0, -0.5, 1.5, 0, -0.5, 0, 0.15, 0.9], 3));
  gliderGeo.computeVertexNormals();
  const glider = new THREE.Mesh(gliderGeo, mats.glider);
  glider.position.y = 2.25;
  glider.castShadow = true;
  glider.visible = false;
  avatar.add(glider);
  const dress = (t) => { mats.hat.color.setHex(t.hat); mats.shirt.color.setHex(t.shirt); mats.skin.color.setHex(t.skin); };
  return { avatar, legs, arms, glider, dress };
}
