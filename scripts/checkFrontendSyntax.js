import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "../../frontend");
const htmlFiles = fs.readdirSync(frontendDir).filter((name) => name.endsWith(".html"));
const failures = [];

for (const fileName of htmlFiles) {
  const source = fs.readFileSync(path.join(frontendDir, fileName), "utf8");
  const scriptPattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptIndex = 0;

  while ((match = scriptPattern.exec(source))) {
    scriptIndex += 1;
    if (!match[1].trim()) continue;
    try {
      // Parse only. The browser code is never executed by this check.
      new Function(match[1]);
    } catch (error) {
      failures.push(`${fileName} inline script ${scriptIndex}: ${error.message}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Frontend syntax OK (${htmlFiles.length} HTML files)`);
}
