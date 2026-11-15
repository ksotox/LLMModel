// HD scenery on High and Standard: Poly Haven's CC0 photo textures, sky light and rock scans
// (assets.js) laid over the procedural world. Nothing changes until they have loaded, and Basic (or a
// missing set) keeps the procedural look. The ground blends grass, forest soil, sand, rock and snow by
// height, slope and the lake shore (the `aLayers` attribute, see groundWeights), samples each texture
// at two scales (no visible tiling) and fades to the painted colours far away.

import * as THREE from 'three';
import { groundWeights, modelSet, skyLight, SURFACES, surface } from './assets.js';

/** Per-vertex ground layers (soil, sand, rock, snow) as the `aLayers` attribute. */
export function addGroundLayers(geo, { inLake, noise }) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const out = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const w = groundWeights({ y: pos.getY(i), ny: nor.getY(i), lake: inLake(x, z), n1: noise(x * 0.02 + 40, z * 0.02), n2: noise(x * 0.03, z * 0.03) });
    out.set([w.soil, w.sand, w.rock, w.snow], i * 4);
  }
  geo.setAttribute('aLayers', new THREE.BufferAttribute(out, 4));
}

const f = (v) => v.toFixed(2);

/** The ground shader patch (needs the material to have a normal map, so the tangent frame exists). */
function groundPatch(shader, maps, tint) {
  const T = SURFACES;
  Object.assign(shader.uniforms, {
    tGC: { value: maps.grass.color }, tGN: { value: maps.grass.normal },
    tSC: { value: maps.soil.color },
    tAC: { value: maps.sand.color }, tAN: { value: maps.sand.normal },
    tRC: { value: maps.rock.color }, tRN: { value: maps.rock.normal },
    tNC: { value: maps.snow.color }, tNN: { value: maps.snow.normal },
    uHdTint: { value: tint },
  });
  shader.vertexShader = `attribute vec4 aLayers;\nvarying vec4 vLayers;\nvarying vec3 vHdPos;\nvarying vec3 vHdNor;\n${shader.vertexShader}`
    .replace('#include <project_vertex>', `#include <project_vertex>
      vLayers = aLayers;
      vHdPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vHdNor = normalize(mat3(modelMatrix) * objectNormal);`);
  shader.fragmentShader = `uniform sampler2D tGC, tGN, tSC, tAC, tAN, tRC, tRN, tNC, tNN;
    uniform vec3 uHdTint;
    varying vec4 vLayers;
    varying vec3 vHdPos;
    varying vec3 vHdNor;
    vec3 hdTwo(sampler2D t, vec2 p, float tile, float far) {
      return mix(texture2D(t, p / tile).rgb, texture2D(t, p / (tile * 6.0)).rgb, far);
    }
    vec3 hdRock(vec2 xz, vec3 n, float far) { // triplanar, so cliffs aren't stretched
      vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
      return hdTwo(tRC, vec2(vHdPos.z, vHdPos.y), ${f(T.rock)}, far) * w.x + hdTwo(tRC, xz, ${f(T.rock)}, far) * w.y + hdTwo(tRC, vec2(vHdPos.x, vHdPos.y), ${f(T.rock)}, far) * w.z;
    }
    ${shader.fragmentShader}`
    .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float hdDist = length(vHdPos - cameraPosition);
        float far = smoothstep(18.0, 90.0, hdDist);
        vec2 gp = vHdPos.xz;
        vec3 col = hdTwo(tGC, gp, ${f(T.grass)}, far);
        col = mix(col, diffuseColor.rgb * 1.7, 0.45); // the meadow's own green through the photo's soil
        col = mix(col, hdTwo(tSC, gp, ${f(T.soil)}, far), vLayers.x);
        col = mix(col, hdTwo(tAC, gp, ${f(T.sand)}, far), vLayers.y);
        col = mix(col, hdRock(gp, normalize(vHdNor), far), vLayers.z);
        col = mix(col, hdTwo(tNC, gp, ${f(T.snow)}, far), vLayers.w);
        col *= uHdTint;
        diffuseColor.rgb = mix(col, diffuseColor.rgb, smoothstep(160.0, 340.0, hdDist)); // the painted colours far out
      }`)
    .replace('#include <normal_fragment_maps>', `{
        vec2 gp = vHdPos.xz;
        float far = smoothstep(18.0, 90.0, length(vHdPos - cameraPosition));
        vec3 nn = texture2D(tGN, gp / ${f(T.grass)}).xyz;
        nn = mix(nn, texture2D(tAN, gp / ${f(T.sand)}).xyz, vLayers.y);
        nn = mix(nn, texture2D(tRN, gp / ${f(T.rock)}).xyz, vLayers.z);
        nn = mix(nn, texture2D(tNN, gp / ${f(T.snow)}).xyz, vLayers.w);
        vec3 mapN = nn * 2.0 - 1.0;
        mapN.xy *= mix(1.0, 0.3, far);
        mat3 hdTbn = getTangentFrame(-vViewPosition, normal, gp);
        normal = normalize(hdTbn * mapN);
      }`);
}

/**
 * The HD layer for one world. `set(on)` (from setQuality): loads the set the first time it's on,
 * then swaps the maps in, or back out. Returns { set(on), dispose() }.
 */
export function hdScenery({ renderer, scene, ground, stoneMat, boulders = [], trees = null, sand = null, dark = false, envSlot = 'sky-day', procEnv = null }) {
  let on = false;
  let loaded = null;
  const swapped = []; // [material, original values]
  const extraRocks = [];
  const tint = new THREE.Color(dark ? 0x9a9ab8 : 0xffffff);

  const wear = (mat, maps, { repeat = null } = {}) => {
    if (!mat || !maps) return;
    if (!mat.userData.hdOriginal) {
      mat.userData.hdOriginal = { map: mat.map, normalMap: mat.normalMap, roughnessMap: mat.roughnessMap, color: mat.color.clone(), roughness: mat.roughness };
      swapped.push(mat);
    }
    if (repeat) for (const t of [maps.color, maps.normal, maps.rough]) t.repeat.set(...repeat);
    mat.userData.hdMaps = maps;
  };
  const apply = () => {
    for (const mat of swapped) {
      const o = mat.userData.hdOriginal;
      const m = mat.userData.hdMaps;
      mat.map = on ? m.color : o.map;
      mat.normalMap = on ? m.normal : o.normalMap;
      mat.roughnessMap = on ? m.rough : o.roughnessMap;
      mat.roughness = on ? 1 : o.roughness;
      mat.color.copy(on ? (mat.userData.hdTint ?? tint) : o.color);
      mat.needsUpdate = true;
    }
    if (ground) {
      ground.userData.hdOn = on && Boolean(loaded?.ground);
      ground.needsUpdate = true;
    }
    for (const r of extraRocks) r.alt.visible = on;
    for (const r of extraRocks) r.base.visible = !on;
    scene.environment = on && loaded?.env ? loaded.env.texture : procEnv;
  };

  const load = async () => {
    const [grass, soil, sandS, rock, snow, bark, cliff, env, rocks] = await Promise.all([
      surface('grass'), surface('soil'), surface('sand'), surface('rock'), surface('snow'), surface('bark'), surface('cliff'),
      envSlot ? skyLight(renderer, envSlot) : null, boulders.length ? modelSet('rocks') : null,
    ]);
    const all = grass && soil && sandS && rock && snow;
    const result = { env, ground: false };
    if (ground && all && ground.normalMap) {
      const maps = { grass, soil, sand: sandS, rock, snow };
      const before = ground.onBeforeCompile;
      const key = ground.customProgramCacheKey?.bind(ground);
      ground.onBeforeCompile = function hd(shader, r) {
        before?.call(this, shader, r);
        if (this.isMeshStandardMaterial && this.userData.hdOn) groundPatch(shader, maps, tint);
      };
      ground.customProgramCacheKey = () => `${key ? key() : ''}${ground.userData.hdOn ? '-hd' : ''}`;
      result.ground = true;
    }
    if (cliff ?? rock) wear(stoneMat, cliff ?? rock); // grey worked stone for the ring and ruins
    if (sandS && sand) wear(sand, sandS);
    if (bark && trees) {
      bark.color.repeat.set(1, 3);
      bark.normal.repeat.set(1, 3);
      bark.rough.repeat.set(1, 3);
      trees.traverse((o) => { if (o.isMesh && o.material?.userData?.bark) wear(o.material, bark); });
    }
    if (rocks) {
      // Scanned mossy rocks stand in for the boulders (each sized to the one it replaces).
      boulders.forEach((b, i) => {
        const pick = rocks[i % rocks.length];
        const alt = new THREE.Mesh(pick.geometry, pick.material);
        const r = b.geometry.boundingSphere?.radius ?? 1;
        alt.scale.setScalar((r * 1.6) / Math.max(1e-3, pick.geometry.boundingSphere.radius * 2));
        alt.position.copy(b.position).y -= 0.25 * r;
        alt.rotation.y = b.rotation.y;
        alt.castShadow = alt.receiveShadow = true;
        alt.visible = false;
        b.parent.add(alt);
        extraRocks.push({ base: b, alt });
      });
    }
    return result;
  };

  return {
    set(next) {
      on = next;
      if (on && !loaded) {
        load().then((res) => { loaded = res; apply(); }).catch((err) => { console.warn('HD scenery unavailable:', err?.message ?? err); loaded = { env: null, ground: false }; });
        return;
      }
      if (loaded) apply();
    },
    dispose() { for (const r of extraRocks) r.alt.removeFromParent(); },
  };
}
