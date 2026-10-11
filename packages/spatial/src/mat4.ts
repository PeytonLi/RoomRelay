import type { Mat4, Placement, Vec3 } from "./types";

export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major multiply: result = a * b (apply b first). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Right-handed rotation about +Y (radians). +yaw moves +Z toward +X. */
export function mat4RotationY(yawRad: number): Mat4 {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function mat4Scale(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function mat4FromQuaternion(qx: number, qy: number, qz: number, qw: number): Mat4 {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

export function mat4TransformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Placement transform: rotate about +Y then translate to (xM, 0, zM).
 * Column-major, right-handed. +yaw about +Y maps +Z front toward +X. */
export function placementMatrix({ xM, zM, yawRad }: Placement): Mat4 {
  if (![xM, zM, yawRad].every(Number.isFinite)) {
    throw new RangeError(`placementMatrix: non-finite placement (xM=${xM}, zM=${zM}, yawRad=${yawRad})`);
  }
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, xM, 0, zM, 1];
}
