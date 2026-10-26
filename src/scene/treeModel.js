// Builds one binary glTF (GLB) that draws thousands of trees with GPU instancing
// (EXT_mesh_gpu_instancing). Each unit shape (sphere, cone, trunk) is stored once; every
// colour group is one node that instances that shape at many positions. This is a few dozen
// draw calls instead of tens of thousands of separate geometries.
//
// Coordinates are local east-north-up metres (the model is loaded with upAxis Z).

/** Low-poly unit sphere (radius 1) with smooth normals. */
function sphere(stacks = 5, slices = 8) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= stacks; i++) {
    const phi = (i / stacks) * Math.PI;
    for (let j = 0; j <= slices; j++) {
      const th = (j / slices) * Math.PI * 2;
      pos.push(Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi));
    }
  }
  const row = slices + 1;
  for (let i = 0; i < stacks; i++)
    for (let j = 0; j < slices; j++) {
      const a = i * row + j;
      const b = a + row;
      // counter-clockwise seen from outside
      if (i > 0) idx.push(a, b, a + 1);
      if (i < stacks - 1) idx.push(a + 1, b, b + 1);
    }
  return { pos, nrm: pos.slice(), idx };
}

/** Unit cone: base radius 1 at z = 0, apex at z = 1, with a base disc. */
function cone(slices = 9) {
  const pos = [];
  const nrm = [];
  const idx = [];
  const k = 1 / Math.SQRT2;
  for (let j = 0; j < slices; j++) {
    const a0 = (j / slices) * Math.PI * 2;
    const a1 = ((j + 1) / slices) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const base = pos.length / 3;
    pos.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0, 0, 0, 1);
    nrm.push(Math.cos(a0) * k, Math.sin(a0) * k, k, Math.cos(a1) * k, Math.sin(a1) * k, k, Math.cos(am) * k, Math.sin(am) * k, k);
    idx.push(base, base + 1, base + 2);
    const b2 = pos.length / 3;
    pos.push(0, 0, 0, Math.cos(a1), Math.sin(a1), 0, Math.cos(a0), Math.sin(a0), 0);
    nrm.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
    idx.push(b2, b2 + 1, b2 + 2);
  }
  return { pos, nrm, idx };
}

/** Unit trunk: radius 1 at z = 0 tapering to 0.7 at z = 1 (open ends). */
function trunk(slices = 6) {
  const pos = [];
  const nrm = [];
  const idx = [];
  for (let j = 0; j <= slices; j++) {
    const a = (j / slices) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c, s, 0, c * 0.7, s * 0.7, 1);
    nrm.push(c, s, 0.1, c, s, 0.1);
  }
  for (let j = 0; j < slices; j++) {
    const a = j * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return { pos, nrm, idx };
}

const SHAPES = { sphere: sphere(), sphereFar: sphere(4, 6), cone: cone(), trunk: trunk() };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * @param groups Map key → { shape: 'sphere'|'sphereFar'|'cone'|'trunk', color: [r,g,b] (0..1 sRGB),
 *                instances: Float32 arrays t (xyz), r (xyzw), s (xyz) as plain number arrays }
 * @returns Uint8Array GLB
 */
export function buildInstancedGlb(groups) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];

  const addView = (typed, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const addAccessor = (typed, type, componentType, target, withBounds) => {
    const view = addView(typed, target);
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: view, componentType, count: typed.length / n, type };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < typed.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], typed[i + k]);
          max[k] = Math.max(max[k], typed[i + k]);
        }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // Shared shape geometry
  const shapeAcc = {};
  const usedShapes = new Set([...groups.values()].map((g) => g.shape));
  for (const name of usedShapes) {
    const s = SHAPES[name];
    shapeAcc[name] = {
      POSITION: addAccessor(new Float32Array(s.pos), 'VEC3', 5126, 34962, true),
      NORMAL: addAccessor(new Float32Array(s.nrm), 'VEC3', 5126, 34962, false),
      indices: addAccessor(new Uint16Array(s.idx), 'SCALAR', 5123, 34963, false),
    };
  }

  const materials = [];
  const meshes = [];
  const nodes = [];
  for (const g of groups.values()) {
    const count = g.t.length / 3;
    if (!count) continue;
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [srgbToLinear(g.color[0]), srgbToLinear(g.color[1]), srgbToLinear(g.color[2]), 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: g.shape === 'trunk',
    });
    const a = shapeAcc[g.shape];
    meshes.push({ primitives: [{ attributes: { POSITION: a.POSITION, NORMAL: a.NORMAL }, indices: a.indices, material: materials.length - 1 }] });
    nodes.push({
      mesh: meshes.length - 1,
      extensions: {
        EXT_mesh_gpu_instancing: {
          attributes: {
            TRANSLATION: addAccessor(new Float32Array(g.t), 'VEC3', 5126, undefined, false),
            ROTATION: addAccessor(new Float32Array(g.r), 'VEC4', 5126, undefined, false),
            SCALE: addAccessor(new Float32Array(g.s), 'VEC3', 5126, undefined, false),
          },
        },
      },
    });
  }

  const json = {
    asset: { version: '2.0', generator: 'virtual-land' },
    extensionsUsed: ['EXT_mesh_gpu_instancing'],
    extensionsRequired: ['EXT_mesh_gpu_instancing'],
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  // Assemble GLB
  const binPad = (4 - (byteLength % 4)) % 4;
  const bin = new Uint8Array(byteLength + binPad);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.byteLength;
  }
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  glb.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.byteLength;
  dv.setUint32(binStart, bin.byteLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN
  glb.set(bin, binStart + 8);
  return glb;
}

/**
 * Collects tree instances into colour groups.
 * add(shape, color[0..1], [x,y,z], yaw, [sx,sy,sz])
 */
export class TreeBatch {
  constructor() {
    this.groups = new Map();
    this.count = 0;
  }

  add(shape, color, t, yaw, s) {
    // Quantize colours so similar trees share a draw call.
    const q = color.map((c) => Math.round(c * 20) / 20);
    const key = `${shape}|${q.join(',')}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { shape, color: q, t: [], r: [], s: [] };
      this.groups.set(key, g);
    }
    g.t.push(t[0], t[1], t[2]);
    g.r.push(0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2));
    g.s.push(s[0], s[1], s[2]);
    this.count++;
  }

  toGlb() {
    return buildInstancedGlb(this.groups);
  }
}
