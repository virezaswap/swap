import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths support GitHub Pages repository subfolders.
  base: "./",

  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true
  }
});
