import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "desktop", "renderer");
const target = path.join(root, "desktop", "dist", "renderer");
await fs.mkdir(target, { recursive: true });
await Promise.all(["index.html", "styles.css"].map((name) => fs.copyFile(path.join(source, name), path.join(target, name))));
await fs.copyFile(path.join(root, "scripts", "agent-hook.cjs"), path.join(root, "desktop", "dist", "agent-hook.cjs"));
const assets = path.join(root, "desktop", "dist", "assets");
await fs.mkdir(assets, { recursive: true });
await fs.copyFile(path.join(root, "desktop", "build", "icon.png"), path.join(assets, "icon.png"));
