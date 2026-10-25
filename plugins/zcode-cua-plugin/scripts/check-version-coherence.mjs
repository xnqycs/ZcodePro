#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRootArgIndex = process.argv.indexOf("--repo-root");
const repoRoot =
  repoRootArgIndex >= 0 && process.argv[repoRootArgIndex + 1]
    ? resolve(process.argv[repoRootArgIndex + 1])
    : resolve(packageRoot, "../../../..");
const checkOnly = process.argv.includes("--check");

const producerPackageJsonPath = resolve(repoRoot, "packages/zcode-cua/package.json");
const producerManifestPath = resolve(repoRoot, "packages/zcode-cua/plugin/.zcode-plugin/plugin.json");
const wrapperPackageJsonPath = resolve(
  repoRoot,
  "apps/zcode-cli/packages/zcode-cua-plugin/package.json",
);
const wrapperManifestPath = resolve(
  repoRoot,
  "apps/zcode-cli/packages/zcode-cua-plugin/.zcode-plugin/plugin.json",
);
const officialPluginDefinitionsPath = resolve(
  repoRoot,
  "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
);
const consumerPackageJsonPaths = [
  "packages/desktop/package.json",
  "packages/services/package.json",
  "apps/zcode-cli/packages/node-repl-host/package.json",
  "apps/zcode-cli/packages/core/package.json",
  "apps/zcode-cli/packages/adapters/package.json",
  "apps/zcode-cli/packages/zcode-cua-plugin/package.json",
].map((path) => resolve(repoRoot, path));
const workspaceProtocol = "workspace:*";
const officialVersionPattern =
  /(name:\s*"computer-use"[\s\S]*?version:\s*")([^"]+)("[\s\S]*?\n\s*\},)/u;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isCanonicalRuntimeArtifactPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-z]:/iu.test(value) &&
    !value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  );
}

function assertWindowsHelperRuntimeContract(packageJson) {
  const contract = packageJson?.zcodeCuaRuntime;
  const windows = contract?.windows;
  if (
    packageJson?.name !== "@zcode/zcode-cua" ||
    !hasExactKeys(contract, ["schema", "windows"]) ||
    contract.schema !== 1 ||
    !hasExactKeys(windows, ["entry", "nativeAddon"]) ||
    !isCanonicalRuntimeArtifactPath(windows.entry) ||
    !isCanonicalRuntimeArtifactPath(windows.nativeAddon) ||
    windows.entry === windows.nativeAddon
  ) {
    // Bug 根因：同一 semver 下的旧评审 SHA 没有 Windows Helper 发布契约，
    // 仅校验版本号会在 macOS build-app 阶段假绿，直到 Windows 准备 runtime 才失败。
    console.error(
      "[cua-version] workspace producer is missing the Windows Helper runtime contract",
    );
    process.exit(1);
  }
}

function assertFinalRasterFrameContract(packageJson) {
  const frameContract = packageJson?.exports?.["./frame-contract"];
  if (
    !hasExactKeys(frameContract, ["types", "import"]) ||
    frameContract.types !== "./dist/frame-contract/index.d.ts" ||
    frameContract.import !== "./dist/frame-contract/index.js"
  ) {
    // Bug 根因：v0.5.3 曾从未包含 frame-pixel 合约的旧主线创建，但 semver 更高，
    // 版本同步脚本仍把它当成新 producer 接受，最终让产品安装包静默丢失最终栅格契约。
    // 必须同时验证不可伪装的公开子路径，不能再用版本号替代实现存在性证明。
    console.error("[cua-version] workspace producer is missing the final-raster frame contract");
    process.exit(1);
  }
}

const producerPackageJson = await readJson(producerPackageJsonPath);
assertWindowsHelperRuntimeContract(producerPackageJson);
assertFinalRasterFrameContract(producerPackageJson);
const expected = producerPackageJson.version;

const nonWorkspaceConsumers = [];
for (const path of consumerPackageJsonPaths) {
  const spec = (await readJson(path)).dependencies?.["@zcode/zcode-cua"];
  if (spec !== workspaceProtocol) {
    nonWorkspaceConsumers.push(
      `${relative(repoRoot, path)} @zcode/zcode-cua: ${spec ?? "<未声明>"} (expected ${workspaceProtocol})`,
    );
  }
}
if (nonWorkspaceConsumers.length > 0) {
  console.error("[cua-version] 消费方必须引用 workspace 内的 producer：");
  for (const line of nonWorkspaceConsumers) console.error(`  ${line}`);
  process.exit(1);
}

const officialPluginDefinitions = await readFile(officialPluginDefinitionsPath, "utf8");
const records = {
  "wrapper package.json.version": (await readJson(wrapperPackageJsonPath)).version,
  "wrapper .zcode-plugin/plugin.json.version": (await readJson(wrapperManifestPath)).version,
  "producer plugin/.zcode-plugin/plugin.json.version": (await readJson(producerManifestPath)).version,
  "official-plugin-definitions computer-use.version":
    officialPluginDefinitions.match(officialVersionPattern)?.[2] ?? null,
};
const drifted = Object.entries(records).filter(([, version]) => version !== expected);

if (drifted.length === 0) {
  console.log(`[cua-version] 一致：全部记录 = ${expected}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `[cua-version] 版本漂移（基准 = packages/zcode-cua/package.json ${expected}）：`,
  );
  for (const [where, version] of drifted) console.error(`  ${where}: ${version}`);
  console.error(
    "修复：node apps/zcode-cli/packages/zcode-cua-plugin/scripts/check-version-coherence.mjs",
  );
  process.exit(1);
}

async function writeVersionField(path, version) {
  const parsed = await readJson(path);
  if (parsed.version === version) return false;
  parsed.version = version;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

const wrote = [];
for (const path of [wrapperPackageJsonPath, wrapperManifestPath, producerManifestPath]) {
  if (await writeVersionField(path, expected)) wrote.push(relative(repoRoot, path));
}
if (!officialVersionPattern.test(officialPluginDefinitions)) {
  throw new Error("[cua-version] 未找到 official-plugin-definitions 中的 computer-use version");
}
const updatedOfficialPluginDefinitions = officialPluginDefinitions.replace(
  officialVersionPattern,
  `$1${expected}$3`,
);
if (updatedOfficialPluginDefinitions !== officialPluginDefinitions) {
  await writeFile(officialPluginDefinitionsPath, updatedOfficialPluginDefinitions);
  wrote.push(relative(repoRoot, officialPluginDefinitionsPath));
}
console.log(
  `[cua-version] 已把版本记录对齐到 ${expected}（写回：${wrote.join(", ") || "无变更"}）`,
);
