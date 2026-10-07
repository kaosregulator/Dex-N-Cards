declare module "sharp" {
  function sharp(input?: Buffer | ArrayBuffer | Uint8Array | string | sharp.InputOptions, options?: sharp.InputOptions): sharp.Sharp;
  namespace sharp {
    function cache(options: boolean | { memory?: number; files?: number; items?: number }): void;
    function concurrency(concurrency?: number): number;
    interface RGBA { r: number; g: number; b: number; alpha: number }
    interface InputOptions {
      raw?: { width: number; height: number; channels: 1 | 2 | 3 | 4 };
      animated?: boolean;
      limitInputPixels?: number | boolean;
      pageHeight?: number;
      page?: number;
      pages?: number;
      create?: { width: number; height: number; channels: 1 | 2 | 3 | 4; background: RGBA };
    }
    interface RawInfo { width: number; height: number; channels: number; size: number }
    interface GifOptions {
      delay?: number | number[];
      loop?: number;
      colours?: number;
      dither?: number;
    }
    interface ResizeOptions {
      withoutEnlargement?: boolean;
      fit?: "cover" | "contain" | "fill" | "inside" | "outside";
      position?: string | number;
      background?: RGBA;
      kernel?: "nearest" | "cubic" | "mitchell" | "lanczos2" | "lanczos3" | string;
    }
    interface WebpOptions {
      quality?: number;
      lossless?: boolean;
    }
    interface Sharp {
       extract(region: { left: number; top: number; width: number; height: number }): Sharp;
      resize(width: number | null, height?: number | null, options?: ResizeOptions): Sharp;
      resize(options: { width?: number; height?: number } & ResizeOptions): Sharp;
      webp(options?: WebpOptions): Sharp;
      png(options?: { quality?: number; compressionLevel?: number }): Sharp;
      gif(options?: GifOptions): Sharp;
      ensureAlpha(alpha?: number): Sharp;
      raw(): Sharp;
      metadata(): Promise<{ width?: number; height?: number; pages?: number; pageHeight?: number; delay?: number[] }>;
      rotate(): Sharp;
      removeAlpha(): Sharp;
      toBuffer(): Promise<Buffer>;
      toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: RawInfo }>;
    }
  }
  export default sharp;
}
