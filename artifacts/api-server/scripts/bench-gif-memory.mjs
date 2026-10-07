#!/usr/bin/env node
/**
 * Rough RSS check for streaming GIF encode (post-optimization path).
 * Run: node artifacts/api-server/scripts/bench-gif-memory.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createCanvas } = require("@napi-rs/canvas");
const GIFEncoder = require("gifencoder");

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function encodeHoldAll(physW, physH, frameCount, quality) {
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const canvas = createCanvas(physW, physH);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${(i * 17) % 255},${(i * 41) % 255},80)`;
    ctx.fillRect(0, 0, physW, physH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(20 + i * 3, 20, 80, 80);
    frames.push(ctx);
  }
  const encoder = new GIFEncoder(physW, physH);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(quality);
  encoder.setDelay(80);
  for (const ctx of frames) encoder.addFrame(ctx);
  encoder.finish();
  return encoder.out.getData().length;
}

function encodeStream(physW, physH, frameCount, quality) {
  const canvas = createCanvas(physW, physH);
  const ctx = canvas.getContext("2d");
  const encoder = new GIFEncoder(physW, physH);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(quality);
  encoder.setDelay(80);
  for (let i = 0; i < frameCount; i++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, physW, physH);
    ctx.fillStyle = `rgb(${(i * 17) % 255},${(i * 41) % 255},80)`;
    ctx.fillRect(0, 0, physW, physH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(20 + i * 3, 20, 80, 80);
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return encoder.out.getData().length;
}

const W = 660, H = 440, N = 20, Q = 22;
global.gc?.();
const base = rssMb();

const holdBytes = encodeHoldAll(W, H, N, Q);
const afterHold = rssMb();
global.gc?.();

const streamBytes = encodeStream(W, H, N, Q);
const afterStream = rssMb();

console.log(JSON.stringify({
  canvas: `${W}x${H}`,
  frames: N,
  quality: Q,
  baseRssMb: base,
  holdAllPeakRssMb: afterHold,
  streamPeakRssMb: afterStream,
  holdGifBytes: holdBytes,
  streamGifBytes: streamBytes,
  note: "Hold-all retains N canvases until encode ends; stream reuses one.",
}, null, 2));
