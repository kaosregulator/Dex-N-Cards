// Tune native image libraries once, before the first decode.
//
// sharp/libvips defaults to one worker per CPU and a cache that keeps decoded
// tiles around. On a small Railway container that stacks with Skia canvas
// bitmaps and is a quiet way to climb past a gigabyte during a render burst.
// Two workers and a small operation cache keep peak native memory flat without
// changing what any command draws.

import sharp from "sharp";

let configured = false;

export function configureNativeMemory(): void {
  if (configured) return;
  configured = true;
  sharp.cache({ memory: 24, files: 0, items: 32 });
  sharp.concurrency(2);
}

configureNativeMemory();
