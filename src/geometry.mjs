// 测绘图斑几何计算：坐标单位为米，面积单位为平方米。
// 约定图斑环为凸多边形（控制点按任意顺序传入，内部统一为逆时针）。

const EPS = 1e-9;

export function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function ringArea(ring) {
  return Math.abs(signedArea(ring));
}

// 统一为逆时针环，供裁剪算法使用。
function counterClockwise(ring) {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

function cross([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  return (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
}

// 线段 P->Q 与直线 A->B 的交点。
function segmentLineIntersection(P, Q, A, B) {
  const denominator = cross(P, Q, A, B);
  if (Math.abs(denominator) < EPS) return P; // 平行，调用方已保证不走到这里
  // P + t(Q-P) 落在直线 AB 上：t = -cross(P-A, B-A) / cross(Q-P, B-A)
  const t = -cross(A, P, A, B) / denominator;
  return [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
}

// Sutherland-Hodgman：用裁剪多边形（凸）裁切主体多边形，返回相交区域。
function clip(subject, clipRing) {
  const clip = counterClockwise(clipRing);
  let output = subject.map((point) => [...point]);
  for (let i = 0; i < clip.length; i += 1) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    const inside = (P) => cross(A, B, A, P) >= -EPS;
    for (let j = 0; j < input.length; j += 1) {
      const P = input[j];
      const Q = input[(j + 1) % input.length];
      const inP = inside(P);
      const inQ = inside(Q);
      if (inP && inQ) {
        output.push(Q);
      } else if (inP && !inQ) {
        output.push(segmentLineIntersection(P, Q, A, B));
      } else if (!inP && inQ) {
        output.push(segmentLineIntersection(P, Q, A, B));
        output.push(Q);
      }
    }
  }
  return output;
}

// 两个图斑的重叠面积；不相交返回 0。
export function intersectionArea(a, b) {
  if (!Array.isArray(a) || a.length < 3 || !Array.isArray(b) || b.length < 3) {
    throw new DomainError('invalid_ring', '图斑环至少需要 3 个控制点');
  }
  const overlap = clip(counterClockwise(a), counterClockwise(b));
  if (overlap.length < 3) return 0;
  return Math.max(0, ringArea(overlap));
}

// 实测图斑落在批准图斑之外的面积（越界占用）。
export function outsideArea(inner, outer) {
  const overlap = clip(counterClockwise(inner), counterClockwise(outer));
  const inside = overlap.length >= 3 ? ringArea(overlap) : 0;
  return Math.max(0, ringArea(inner) - inside);
}

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export { EPS };
