import { expect, it } from "vitest";
import { clampPan, rezoom, scaleOf, sourceRect } from "./icon-crop.ts";

const V = 100;

it("scale covers the square along the short side, times the zoom", () => {
  expect(scaleOf(400, 200, V, 1)).toBe(0.5);
  expect(scaleOf(200, 400, V, 2)).toBe(1);
  expect(scaleOf(100, 100, V, 1)).toBe(1);
});

it("clampPan keeps the image covering the square (wide, tall, square)", () => {
  // wide 400x200 at zoom 1: scale .5 -> drawn 200x100, may pan x in [-100, 0], y fixed 0
  expect(clampPan(400, 200, V, 1, 50, 30)).toEqual({ ox: 0, oy: 0 });
  expect(clampPan(400, 200, V, 1, -500, -9)).toEqual({ ox: -100, oy: 0 });
  // tall
  expect(clampPan(200, 400, V, 1, -9, -500)).toEqual({ ox: 0, oy: -100 });
  // square zoomed 2x: drawn 200x200
  expect(clampPan(100, 100, V, 2, -40, -60)).toEqual({ ox: -40, oy: -60 });
  expect(clampPan(100, 100, V, 2, 10, -300)).toEqual({ ox: 0, oy: -100 });
});

it("sourceRect is the visible part in image pixels", () => {
  expect(sourceRect(400, 200, V, 1, 0, 0)).toEqual({ sx: 0, sy: 0, size: 200 });
  expect(sourceRect(400, 200, V, 1, -100, 0)).toEqual({ sx: 200, sy: 0, size: 200 });
  expect(sourceRect(100, 100, V, 2, -50, -50)).toEqual({ sx: 25, sy: 25, size: 50 });
});

it("rezoom keeps the centre of the view on the same image point", () => {
  const z = rezoom(100, 100, V, 1, 0, 0, 2);
  expect(z).toEqual({ ox: -50, oy: -50 });
  expect(rezoom(100, 100, V, 2, -50, -50, 1)).toEqual({ ox: 0, oy: 0 });
});
