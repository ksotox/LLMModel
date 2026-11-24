// "Realism on High": the extra passes the High graphics level draws.
//   • soft ambient occlusion, worked out from the depth buffer (corners, roots and the ground
//     under things go a little darker);
//   • bloom: the brightest things (the sun, its glint on water, lamps, reef sparkles) glow softly;
//   • mirror water: lakes and the sea reflect what really stands round them (planarMirror).
//
// The scene is first drawn into a texture that three.js treats exactly like the screen
// (`screenLike`: same tone mapping and colour encoding, so every material looks as it does
// without these passes), then the passes are added on top and the result goes to the screen.
// Standard and Basic draw straight to the screen as before. perf.js turns the passes off when
// frames are slow (before it lowers the resolution).

import * as THREE from 'three';

/** A render target three.js draws into as it draws to the screen (tone mapped, sRGB encoded). */
function screenLike(rt) {
  rt.isXRRenderTarget = true; // three.js: "tone map and encode as for the screen" (see #27868)
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  return rt;
}

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Ambient occlusion from depth alone: points round each pixel (a turning spiral) that rise above
// its surface darken it, the nearer the more; fades out with distance.
const AO_FRAGMENT = `
  uniform sampler2D tDepth; uniform mat4 uProjInv; uniform vec2 uTexel, uFade; uniform float uRadius, uScale;
  varying vec2 vUv;
  vec3 viewAt(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewAt(vUv);
    // The surface's normal from the nearer neighbour on each side (no halos at edges).
    vec3 l = P - viewAt(vUv - vec2(uTexel.x, 0.0)), r = viewAt(vUv + vec2(uTexel.x, 0.0)) - P;
    vec3 b = P - viewAt(vUv - vec2(0.0, uTexel.y)), t = viewAt(vUv + vec2(0.0, uTexel.y)) - P;
    vec3 N = normalize(cross(abs(l.z) < abs(r.z) ? l : r, abs(b.z) < abs(t.z) ? b : t));
    float reach = uRadius * uScale / max(-P.z, 0.1); // the radius on screen
    float spin = hash(gl_FragCoord.xy) * 6.2831853;
    float occ = 0.0;
    for (int i = 0; i < 12; i++) {
      float k = (float(i) + 0.5) / 12.0;
      float a = spin + float(i) * 2.3999632;
      vec3 v = viewAt(vUv + vec2(cos(a), sin(a)) * reach * k) - P;
      float dd = dot(v, v);
      occ += max(dot(N, v) * inversesqrt(dd + 1e-4) - 0.2, 0.0) * clamp(1.0 - dd / (uRadius * uRadius * 4.0), 0.0, 1.0);
    }
    float ao = 1.0 - occ / 12.0 * 1.6;
    gl_FragColor = vec4(vec3(mix(clamp(ao, 0.0, 1.0), 1.0, smoothstep(uFade.x, uFade.y, -P.z))), 1.0);
  }`;

const BRIGHT_FRAGMENT = `
  uniform sampler2D tScene; uniform float uThreshold; varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.22, l), 1.0);
  }`;

// A 9-tap Gaussian blur along uDir (one texel steps, linear filtering does the in-betweens).
const BLUR_FRAGMENT = `
  uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
    c += (texture2D(tSrc, vUv + uDir * 1.3846154).rgb + texture2D(tSrc, vUv - uDir * 1.3846154).rgb) * 0.3162162;
    c += (texture2D(tSrc, vUv + uDir * 3.2307692).rgb + texture2D(tSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
    gl_FragColor = vec4(c, 1.0);
  }`;

const COMBINE_FRAGMENT = `
  uniform sampler2D tScene, tAO, tBloom1, tBloom2; uniform vec2 uAOTexel; uniform float uAO, uBloom;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float ao = 0.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) ao += texture2D(tAO, vUv + vec2(x, y) * uAOTexel).r;
    c *= mix(1.0, ao / 9.0, uAO);
    c += (texture2D(tBloom1, vUv).rgb + texture2D(tBloom2, vUv).rgb * 0.9) * uBloom;
    // A light grade: vibrance (dull colours gain the most saturation, vivid ones little) and a touch of
    // contrast, for more colour depth.
    float grey = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(grey), c, 1.0 + 0.28 * (1.0 - clamp(sat * 2.0, 0.0, 1.0)));
    c = clamp((c - 0.5) * 1.05 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(c, 1.0);
  }`;

/**
 * The High level's passes. render(scene, camera) draws the frame with them.
 * Options: ao (0–1, how dark the occlusion), bloom (glow strength), threshold (how bright a thing
 * must be to glow, in screen terms: only the sun, glints, lamps and sparkles get there), radius
 * (occlusion reach in world units), fade ([from, to]: the occlusion fades out over these distances).
 */
export function createPostFx(renderer, { ao = 0.6, bloom = 0.35, threshold = 0.96, radius = 0.7, fade = [40, 100] } = {}) {
  const depth = new THREE.DepthTexture(1, 1);
  depth.type = THREE.UnsignedIntType;
  const sceneRT = screenLike(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth }));
  const target = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const aoRT = target();
  const half = [target(), target()];
  const quarter = [target(), target()];
  const pass = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const aoMat = pass(AO_FRAGMENT, { tDepth: { value: depth }, uProjInv: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: radius }, uScale: { value: 1 }, uFade: { value: new THREE.Vector2(...fade) } });
  const brightMat = pass(BRIGHT_FRAGMENT, { tScene: { value: sceneRT.texture }, uThreshold: { value: threshold } });
  const blurMat = pass(BLUR_FRAGMENT, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const combineMat = pass(COMBINE_FRAGMENT, {
    tScene: { value: sceneRT.texture }, tAO: { value: aoRT.texture }, tBloom1: { value: half[1].texture }, tBloom2: { value: quarter[1].texture },
    uAOTexel: { value: new THREE.Vector2() }, uAO: { value: ao }, uBloom: { value: bloom },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMat);
  quad.frustumCulled = false;
  const flat = new THREE.Scene();
  flat.add(quad);
  const flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();
  let w = 0;
  let h = 0;
  const draw = (material, to) => {
    quad.material = material;
    renderer.setRenderTarget(to);
    renderer.render(flat, flatCam);
  };
  const blur = ([a, b], from) => {
    blurMat.uniforms.tSrc.value = from;
    blurMat.uniforms.uDir.value.set(1 / a.width, 0);
    draw(blurMat, a);
    blurMat.uniforms.tSrc.value = a.texture;
    blurMat.uniforms.uDir.value.set(0, 1 / a.height);
    draw(blurMat, b);
  };
  return {
    render(scene, camera) {
      renderer.getDrawingBufferSize(size);
      if (size.x !== w || size.y !== h) {
        w = size.x;
        h = size.y;
        sceneRT.setSize(w, h);
        const hw = Math.max(1, w >> 1);
        const hh = Math.max(1, h >> 1);
        aoRT.setSize(hw, hh);
        for (const t of half) t.setSize(hw, hh);
        for (const t of quarter) t.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
        aoMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
        combineMat.uniforms.uAOTexel.value.set(1 / hw, 1 / hh);
      }
      const before = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      aoMat.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
      aoMat.uniforms.uScale.value = camera.projectionMatrix.elements[5] * 0.5; // the radius on screen at 1 unit away
      draw(aoMat, aoRT);
      draw(brightMat, half[1]);
      blur(half, half[1].texture); // (into half[0] and back to half[1])
      blur(quarter, half[1].texture);
      draw(combineMat, null);
      renderer.setRenderTarget(before);
    },
    dispose() {
      for (const t of [sceneRT, aoRT, ...half, ...quarter]) t.dispose();
      depth.dispose();
      for (const m of [aoMat, brightMat, blurMat, combineMat]) m.dispose();
      quad.geometry.dispose();
    },
  };
}

/**
 * Whether the High passes are drawn, made when first needed and freed when not: setLevel(q) on
 * each graphics change; drop() for good when frames are too slow (perf.js); render(scene, camera)
 * draws with or without them.
 */
export function createEffects(renderer, options) {
  let level = 'standard';
  let dropped = false;
  let fx = null;
  const free = () => { fx?.dispose(); fx = null; };
  return {
    get on() { return level === 'high' && !dropped; },
    setLevel(q) { level = q; if (!this.on) free(); },
    drop() { dropped = true; free(); },
    render(scene, camera) {
      if (!this.on) { renderer.render(scene, camera); return; }
      (fx ??= createPostFx(renderer, options)).render(scene, camera);
    },
    dispose: free,
  };
}

/**
 * A planar mirror for a flat water surface (after three.js's Reflector, MIT): the scene drawn from
 * below the plane into a texture at half resolution. The water's shader takes `uniforms`
 * (uMirror, uMirrorMat, uMirrorOn) and samples uMirror at uMirrorMat × its local position.
 * render(scene, camera, water, hide) before the frame; `hide`: things to leave out of it (grass).
 */
export function planarMirror(renderer, { scale = 0.5 } = {}) {
  const rt = screenLike(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const virtual = new THREE.PerspectiveCamera();
  virtual.matrixAutoUpdate = true;
  const textureMatrix = new THREE.Matrix4();
  const uniforms = { uMirror: { value: rt.texture }, uMirrorMat: { value: textureMatrix }, uMirrorOn: { value: 0 } };
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const at = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const view = new THREE.Vector3();
  const look = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const clip = new THREE.Vector4();
  const q = new THREE.Vector4();
  const size = new THREE.Vector2();
  return {
    uniforms,
    set on(v) { uniforms.uMirrorOn.value = v ? 1 : 0; },
    render(scene, camera, water, hide = []) {
      if (!uniforms.uMirrorOn.value) return;
      water.updateMatrixWorld();
      at.setFromMatrixPosition(water.matrixWorld);
      eye.setFromMatrixPosition(camera.matrixWorld);
      rot.extractRotation(water.matrixWorld);
      normal.set(0, 0, 1).applyMatrix4(rot);
      view.subVectors(at, eye);
      if (view.dot(normal) > 0) return; // seen from below: nothing to mirror
      view.reflect(normal).negate().add(at);
      rot.extractRotation(camera.matrixWorld);
      look.set(0, 0, -1).applyMatrix4(rot).add(eye);
      aim.subVectors(at, look).reflect(normal).negate().add(at);
      virtual.position.copy(view);
      virtual.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
      virtual.lookAt(aim);
      virtual.far = camera.far;
      virtual.updateMatrixWorld();
      virtual.projectionMatrix.copy(camera.projectionMatrix);
      textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
        .multiply(virtual.projectionMatrix).multiply(virtual.matrixWorldInverse).multiply(water.matrixWorld);
      // Clip everything below the water (an oblique near plane, after Lengyel).
      plane.setFromNormalAndCoplanarPoint(normal, at).applyMatrix4(virtual.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const p = virtual.projectionMatrix.elements;
      q.set((Math.sign(clip.x) + p[8]) / p[0], (Math.sign(clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      p[2] = clip.x; p[6] = clip.y; p[10] = clip.z + 1; p[14] = clip.w;
      renderer.getDrawingBufferSize(size);
      const w = Math.max(1, Math.round(size.x * scale));
      const h = Math.max(1, Math.round(size.y * scale));
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
      const shown = hide.map((o) => o.visible);
      for (const o of hide) o.visible = false;
      water.visible = false;
      const before = renderer.getRenderTarget();
      const shadows = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.render(scene, virtual);
      renderer.setRenderTarget(before);
      renderer.shadowMap.autoUpdate = shadows;
      water.visible = true;
      hide.forEach((o, i) => { o.visible = shown[i]; });
    },
    dispose() { rt.dispose(); },
  };
}

/** GLSL for a water shader: declarations, and the reflected colour at a (normal-tilted) point. */
export const MIRROR_GLSL = {
  vertexDecl: 'uniform mat4 uMirrorMat; varying vec4 vMirror;',
  vertex: 'vMirror = uMirrorMat * vec4(position, 1.0);',
  fragmentDecl: 'uniform sampler2D uMirror; uniform float uMirrorOn; varying vec4 vMirror;',
  /** `sky` is replaced by the mirror where it has drawn something; `tilt`: a vec2 ripple offset. */
  mix: (sky, tilt) => `if (uMirrorOn > 0.5) { vec4 mr = texture2D(uMirror, vMirror.xy / vMirror.w + ${tilt}); ${sky} = mix(${sky}, mr.rgb, 0.85); }`,
};
