// The Sanctuary's own trainer models (server/trainers.js) and the procedural skeleton animation
// (public/js/sanctuary/rig.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { readGlbInfo } from '../server/trainers.js';

/** A tiny glTF binary with the given JSON (no buffers). */
function glb(json) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const out = Buffer.alloc(20 + text.length);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(text.length, 12);
  out.write('JSON', 16, 'ascii');
  out.write(text, 20, 'utf8');
  return out;
}

describe('trainer models: reading a .glb', () => {
  test('its credit, skeleton and clips', () => {
    const info = readGlbInfo(glb({
      asset: { version: '2.0', extras: { title: 'Explorer', author: 'someone (https://sketchfab.com/someone)', license: 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)', source: 'https://sketchfab.com/3d-models/explorer' } },
      skins: [{ joints: [0] }], animations: [{ name: 'Walk' }],
    }));
    assert.equal(info.title, 'Explorer');
    assert.match(info.licence, /CC-BY-4\.0/);
    assert.equal(info.source, 'https://sketchfab.com/3d-models/explorer');
    assert.equal(info.rigged, true);
    assert.equal(info.clips, 1);
  });

  test('anything else is refused', () => {
    assert.equal(readGlbInfo(Buffer.from('not a model at all')), null);
    assert.equal(readGlbInfo(Buffer.from('glTF')), null);
    const bad = glb({ asset: { version: '2.0' } });
    bad.writeUInt32LE(1, 4); // glTF 1
    assert.equal(readGlbInfo(bad), null);
    assert.equal(readGlbInfo(glb({ asset: { version: '2.0', extras: { source: 'javascript:alert(1)' } } })).source, '', 'only web links as a source');
  });
});

describe('trainer models: the API', () => {
  let dataDir;
  let server;
  let base;
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-trainers-'));
    const app = createApp({ requireLogin: false, dataDir });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const send = (bytes, name = 'model.glb') => {
    const form = new FormData();
    form.append('model', new Blob([bytes]), name);
    return fetch(`${base}/api/trainers`, { method: 'POST', body: form });
  };

  test('upload, list, fetch and delete a model', async () => {
    const res = await send(glb({ asset: { version: '2.0', extras: { title: 'Hiker' } }, skins: [{ joints: [0] }] }), 'hiker.glb');
    assert.equal(res.status, 201);
    const entry = await res.json();
    assert.equal(entry.name, 'Hiker');
    assert.equal(entry.rigged, true);
    const { trainers } = await (await fetch(`${base}/api/trainers`)).json();
    assert.deepEqual(trainers.map((t) => t.id), [entry.id]);
    const file = await fetch(`${base}/api/trainers/${entry.id}.glb`);
    assert.equal(file.status, 200);
    assert.equal(Buffer.from(await file.arrayBuffer()).toString('ascii', 0, 4), 'glTF');
    assert.ok(fs.existsSync(path.join(dataDir, 'trainers')), 'kept in the data folder');
    assert.equal((await fetch(`${base}/api/trainers/${entry.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual((await (await fetch(`${base}/api/trainers`)).json()).trainers, []);
  });

  test('refuses what is not a .glb, and unknown ids', async () => {
    const res = await send(Buffer.from('hello'), 'notes.txt');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /glTF/);
    assert.equal((await fetch(`${base}/api/trainers/../../collection.db`)).status, 404);
    assert.equal((await fetch(`${base}/api/trainers/zzzzzzzz.glb`)).status, 404);
  });
});

describe('skeleton animation made in code (rig.js)', () => {
  test('finds the parts of game, Mixamo and Blender rigs by bone name', async () => {
    const { findRig, isHumanRig } = await import('../public/js/sanctuary/rig.js');
    const game = findRig(['Hips_90', 'LThigh_6', 'LLeg_5', 'LFoot_4', 'RThigh_10', 'RLeg_9', 'Spine0_76', 'Spine1_75', 'Neck_32', 'Head_31', 'LShoulder_53', 'LArm_52', 'LForeArm_51', 'RShoulder_74', 'RArm_73', 'RForeArm_72']);
    assert.equal(game.thighL, 'LThigh_6');
    assert.equal(game.kneeL, 'LLeg_5');
    assert.equal(game.armR, 'RArm_73');
    assert.equal(game.forearmL, 'LForeArm_51');
    assert.equal(game.head, 'Head_31');
    assert.ok(isHumanRig(game));
    const may = findRig(['Hips_10', 'LThigh_5', 'RThigh_9', 'LArmA_31', 'RArmA_71', 'LForeArm_29']);
    assert.equal(may.armL, 'LArmA_31');
    const mixamo = findRig(['mixamorig:Hips', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:RightUpLeg', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftForeArm']);
    assert.equal(mixamo.thighL, 'mixamorig:LeftUpLeg');
    assert.equal(mixamo.kneeL, 'mixamorig:LeftLeg', 'the lower leg, not the upper one');
    assert.equal(mixamo.forearmL, 'mixamorig:LeftForeArm');
    assert.ok(isHumanRig(mixamo));
    const blender = findRig(['thigh.L', 'thigh.R', 'upper_arm.L', 'upperarm.R']);
    assert.equal(blender.thighL, 'thigh.L');
    assert.equal(isHumanRig(findRig(['Bone', 'Tail', 'Head'])), false, 'a creature is not a human rig');
  });

  test('the animation state follows the movement', async () => {
    const { trainerState } = await import('../public/js/sanctuary/rig.js');
    assert.equal(trainerState({ mode: 'walk', moving: 0 }), 'idle');
    assert.equal(trainerState({ mode: 'walk', moving: 3 }), 'walk');
    assert.equal(trainerState({ mode: 'walk', moving: 7.6 }), 'run');
    assert.equal(trainerState({ mode: 'fall', vy: 4 }), 'jump');
    assert.equal(trainerState({ mode: 'fall', vy: -3 }), 'fall');
    assert.equal(trainerState({ mode: 'glide' }), 'glide');
    assert.equal(trainerState({ mode: 'swim' }), 'swim');
  });

  test('a stride swings the legs and arms in opposition and bends the knees backwards', async () => {
    const { gait } = await import('../public/js/sanctuary/rig.js');
    const p = gait('walk', Math.PI / 2, 1);
    assert.ok(p.thighL > 0 && p.thighR < 0, 'one leg forward, the other back');
    assert.ok(Math.sign(p.armL) === -Math.sign(p.thighL), 'the arm on the same side swings the other way');
    for (let ph = 0; ph < 6.3; ph += 0.3) {
      const q = gait('run', ph, 1);
      assert.ok(q.kneeL >= 0 && q.kneeR >= 0, 'knees never bend forwards');
    }
    assert.ok(gait('run', 1).lean > gait('walk', 1).lean, 'leans further when running');
    assert.ok(gait('glide', 0).armOutL > 2, 'arms up to the glider');
    const idle = gait('idle', 0, 0, 1);
    assert.ok(Math.abs(idle.thighL) < 1e-9 && Math.abs(idle.lean) < 0.05);
  });
});
