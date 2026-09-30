// Keep the packaged Python sources identical to the editable backend project.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["pyproject.toml", "worker.py", "mapping_adapter.py"];
const dest = path.join(root, "addon", "content", "backend");
fs.mkdirSync(dest, { recursive: true });
for (const name of files) {
  const source = path.join(root, "backend", name);
  const target = path.join(dest, name);
  const content = fs.readFileSync(source);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
    fs.writeFileSync(target, content);
  }
}
