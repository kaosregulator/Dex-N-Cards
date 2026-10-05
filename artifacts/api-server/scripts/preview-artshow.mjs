/**
 * Render Art Show visual previews to /opt/cursor/artifacts/artshow-preview
 * so we can show the hall / museum / emblem path / badges.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const outDir = "/opt/cursor/artifacts/artshow-preview";
await mkdir(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const { createCanvas } = require("@napi-rs/canvas");

/** Make a sample "user art" photo — landscape watercolor-ish scene. */
function makeSampleArt(kind) {
  const specs = {
    landscape: { w: 960, h: 540 },
    portrait: { w: 540, h: 840 },
    square: { w: 720, h: 720 },
  };
  const { w, h } = specs[kind];
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");

  if (kind === "landscape") {
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, "#7ec8e3");
    sky.addColorStop(1, "#f7d9a8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // hills
    ctx.fillStyle = "#5a9e6f";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 40) {
      ctx.lineTo(x, h * 0.55 + Math.sin(x / 90) * 28 + Math.cos(x / 40) * 12);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
    ctx.fillStyle = "#3d7a52";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.72);
    for (let x = 0; x <= w; x += 30) {
      ctx.lineTo(x, h * 0.68 + Math.sin(x / 55) * 18);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
    // sun
    ctx.fillStyle = "#ffe08a";
    ctx.beginPath();
    ctx.arc(w * 0.78, h * 0.22, 48, 0, Math.PI * 2);
    ctx.fill();
    // flowers
    for (let i = 0; i < 40; i++) {
      const x = 40 + (i * 97) % (w - 80);
      const y = h * 0.78 + (i * 37) % 80;
      ctx.fillStyle = ["#ff6b6b", "#ffd166", "#f72585", "#4cc9f0"][i % 4];
      ctx.beginPath();
      ctx.arc(x, y, 5 + (i % 4), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "portrait") {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#2b1e3e");
    g.addColorStop(0.5, "#5c3d6e");
    g.addColorStop(1, "#1a1024");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // abstract figure
    ctx.fillStyle = "#e8c872";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.28, 70, 85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c77dff";
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.38);
    ctx.quadraticCurveTo(w * 0.2, h * 0.7, w * 0.25, h * 0.95);
    ctx.lineTo(w * 0.75, h * 0.95);
    ctx.quadraticCurveTo(w * 0.8, h * 0.7, w / 2, h * 0.38);
    ctx.fill();
    // stars
    ctx.fillStyle = "#fff8e7";
    for (let i = 0; i < 60; i++) {
      ctx.globalAlpha = 0.4 + (i % 5) * 0.1;
      ctx.beginPath();
      ctx.arc((i * 73) % w, (i * 41) % (h * 0.45), 1.5 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    const g = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.7);
    g.addColorStop(0, "#ff9f1c");
    g.addColorStop(0.45, "#e71d36");
    g.addColorStop(1, "#2ec4b6");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 8;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 40 + i * 36, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return c.toBuffer("image/png");
}

const sampleLandscape = join(outDir, "sample-art-landscape.png");
const samplePortrait = join(outDir, "sample-art-portrait.png");
const sampleSquare = join(outDir, "sample-art-square.png");
const bufL = makeSampleArt("landscape");
const bufP = makeSampleArt("portrait");
const bufS = makeSampleArt("square");
await writeFile(sampleLandscape, bufL);
await writeFile(samplePortrait, bufP);
await writeFile(sampleSquare, bufS);
console.log("Wrote sample art");

// data: URLs so loadArt/fetch can decode without HTTP
const dataUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const artLandscape = dataUrl(bufL);
const artPortrait = dataUrl(bufP);
const artSquare = dataUrl(bufS);

// Dynamic import compiled TS via tsx
const hall = await import("../src/bot/artshow/render-hall.ts");
const museum = await import("../src/bot/artshow/render-museum.ts");
const guide = await import("../src/bot/artshow/render-guide.ts");
const emblem = await import("../src/bot/badges/emblem-canvas.ts");

async function save(name, buf) {
  if (!buf) {
    console.warn("SKIP", name, "(null buffer)");
    return;
  }
  const path = join(outDir, name);
  await writeFile(path, buf);
  console.log("OK", name, buf.length);
}

// Landscape hall (animated GIF + still PNG)
await save("hall-landscape.gif", await hall.renderArtHallGif({
  title: "Sunset Meadow",
  artistName: "Maya",
  description: "Watercolor hills after rain",
  imageUrl: artLandscape,
  orientation: "landscape",
  votes: 18,
  weekLabel: "2026-W14",
  animated: true,
}));
await save("hall-landscape.png", await hall.renderArtHallPng({
  title: "Sunset Meadow",
  artistName: "Maya",
  description: "Watercolor hills after rain",
  imageUrl: artLandscape,
  orientation: "landscape",
  votes: 18,
  weekLabel: "2026-W14",
}));

// Portrait hall
await save("hall-portrait.gif", await hall.renderArtHallGif({
  title: "Night Muse",
  artistName: "Kai",
  imageUrl: artPortrait,
  orientation: "portrait",
  votes: 42,
  weekLabel: "2026-W14",
}));

// Square hall
await save("hall-square.png", await hall.renderArtHallPng({
  title: "Orbit Study",
  artistName: "Ren",
  imageUrl: artSquare,
  orientation: "square",
  votes: 9,
  weekLabel: "2026-W14",
}));

// Museum — stamped hall + PD wings + statues + bold center stage
await save("museum-hall-of-fame.gif", await museum.renderMuseumGif({
  championTitle: "Sunset Meadow",
  championArtist: "Maya",
  championImageUrl: artLandscape,
  votes: 42,
  weekLabel: "Week 2026-W14 · CROWNED",
  seed: `preview-${Date.now()}`,
}));
await save("museum-hall-of-fame-b.gif", await museum.renderMuseumGif({
  championTitle: "Night Muse",
  championArtist: "Kai",
  championImageUrl: artPortrait,
  votes: 31,
  weekLabel: "Week 2026-W14 · CURRENT LEAD",
  seed: "preview-shuffle-b",
}));

// Emblem evolution guide
await save("emblem-path.gif", await guide.renderArtBadgeGuideGif());

// Individual artshow badges at different levels
const badges = [
  { name: "Exhibitor", emoji: "🖼️", level: 1, file: "badge-exhibitor-lv1.gif" },
  { name: "Rising Artist", emoji: "✨", level: 12, file: "badge-rising-lv12.gif" },
  { name: "Crowd Favorite", emoji: "🌟", level: 28, file: "badge-crowd-lv28.gif" },
  { name: "Hall Champion", emoji: "🏆", level: 55, file: "badge-champion-lv55.gif" },
  { name: "Museum Legend", emoji: "👑", level: 100, file: "badge-legend-lv100.gif" },
];
for (const b of badges) {
  await save(b.file, await emblem.renderBadgeEmblemGif({
    name: b.name,
    emoji: b.emoji,
    level: b.level,
    subtitle: `Lv. ${b.level}`,
    seed: `artshow-${b.name}-${b.level}`,
  }));
}

console.log("\nAll previews in", outDir);
