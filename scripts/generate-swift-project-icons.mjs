// Regenerate the native vector catalogue from the same pinned Lucide package as web.
// Requires Python fonttools 4.59.1; pass its interpreter with --python <path>.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const packageRoot = NodePath.resolve(root, "apps/web/node_modules/lucide-react");
const folder = NodePath.resolve(packageRoot, "dist/esm/icons");
const icons = {};
for (const file of NodeFS.readdirSync(folder).sort()) {
  if (!file.endsWith(".js") || file === "index.js") continue;
  let target = NodePath.resolve(folder, file);
  let nodes;
  const visited = new Set();
  while (!visited.has(target)) {
    visited.add(target);
    ({ __iconNode: nodes } = await import(NodeURL.pathToFileURL(target).href));
    if (nodes) break;
    const alias = NodeFS.readFileSync(target, "utf8").match(
      /export \{ default \} from ['"](.+?)['"]/,
    );
    if (!alias) break;
    target = NodePath.resolve(NodePath.dirname(target), alias[1]);
  }
  if (!nodes) throw new Error(`No vector data for ${file}`);
  icons[file.slice(0, -3)] = nodes;
}
const pythonIndex = process.argv.indexOf("--python");
const python = pythonIndex < 0 ? "python3" : process.argv[pythonIndex + 1];
const converted = NodeChildProcess.spawnSync(
  python,
  [NodePath.resolve(root, "scripts/swift-project-icons.py")],
  {
    input: JSON.stringify(icons),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (converted.status !== 0) throw new Error(converted.stderr);
const destination = NodePath.resolve(root, "apps/swift-ios/Resources");
NodeFS.writeFileSync(NodePath.resolve(destination, "ProjectIconPaths.json"), converted.stdout);
NodeFS.writeFileSync(
  NodePath.resolve(destination, "Lucide-LICENSE.txt"),
  NodeFS.readFileSync(NodePath.resolve(packageRoot, "LICENSE")),
);
console.log(`Generated ${Object.keys(icons).length} native project icons.`);
