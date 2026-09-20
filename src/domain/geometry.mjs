// 图斑统一按轴对齐矩形表达（单位：米），面积单位：平方米，保留两位小数。
// 边界相接（内切）不视为重叠，只有内相交才阻断审批。

export function roundArea(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function rectangleArea(geometry) {
  return roundArea(geometry.width * geometry.height);
}

export function rectanglesOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}
