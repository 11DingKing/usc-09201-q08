import assert from 'node:assert/strict';
import test from 'node:test';
import { intersectionArea, outsideArea, ringArea } from '../src/geometry.mjs';

// 轴对齐矩形（米）：左下角 (x,y)，宽 w、高 h。
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

test('图斑面积按坐标精确计算', () => {
  assert.equal(ringArea(rect(0, 0, 10, 10)), 100);
  assert.equal(ringArea(rect(0, 0, 20, 5)), 100);
  // 反向环同样取绝对值。
  assert.equal(ringArea([...rect(0, 0, 3, 4)].reverse()), 12);
});

test('相交面积等于几何重叠部分', () => {
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), 25);
  // 仅相接不重叠。
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), 0);
  // 完全分离。
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(20, 20, 10, 10)), 0);
  // 包含关系取较小者。
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(2, 2, 3, 3)), 9);
});

test('越界面积为实测图斑落在批准图斑之外的部分', () => {
  assert.equal(outsideArea(rect(0, 0, 10, 10), rect(0, 0, 10, 10)), 0);
  // 实测向东超出 1 米：10×1 的带状区域越界。
  assert.equal(outsideArea(rect(0, 0, 11, 10), rect(0, 0, 10, 10)), 10);
});
