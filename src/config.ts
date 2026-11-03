/** Public repository; change this in a fork. */
export const REPO_URL = "https://github.com/yuanzhevc-stack/musk-atlas";
/** Upstream project this app is based on. */
export const UPSTREAM_URL = "https://github.com/designfuchen/word-atlas";
/** Where clip mp4s live (Cloudflare R2 public bucket); override with VITE_CLIP_BASE at build time. */
export const CLIP_BASE: string = (import.meta.env.VITE_CLIP_BASE as string | undefined) ?? "https://pub-ad0e50befa7b4387a7d73a8c8a796eb3.r2.dev";
