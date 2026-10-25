import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSkill = resolve(packageRoot, "../../../../packages/zcode-cua/plugin/skills/computer-use/SKILL.md");
const targetSkill = resolve(packageRoot, "skills/computer-use/SKILL.md");

await mkdir(dirname(targetSkill), { recursive: true });
await copyFile(sourceSkill, targetSkill);
console.log("Synced computer-use skill from packages/zcode-cua");
