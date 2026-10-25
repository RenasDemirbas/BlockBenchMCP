// SVG files are bundled as data URLs (esbuild "dataurl" loader in scripts/build.mjs).
declare module '*.svg' {
  const dataUrl: string;
  export default dataUrl;
}
