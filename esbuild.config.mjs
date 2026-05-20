// @ts-check
import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],   // vscode API is provided by the host; never bundle it
  format: "cjs",          // VS Code extensions must be CommonJS
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !isWatch,
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("esbuild watching for changes…");
} else {
  await esbuild.build(buildOptions);
}
