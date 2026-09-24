import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../bin/hmh-codexhost.mjs", import.meta.url));

function run(arguments_, options = {}) {
  return spawnSync(process.execPath, [bridge, ...arguments_], {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

test("bridge reports a machine-readable version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(typeof parsed.version === "string" && parsed.version.match(/^\d+\.\d+\.\d+$/), "version is semver: " + parsed.version);
});

test("bridge reports providers without credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hmh-bridge-"));
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      provider: { baseUrl: "http://default", apiKey: "secret", model: "default-model" },
      providers: {
        alt: { baseUrl: "http://alt", apiKey: "alt-secret", model: "alt-model" },
      },
    }),
    "utf8",
  );
  const result = run(["providers", "--json"], {
    env: { ...process.env, HMH_HOME: home, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).providers[0].model, "alt-model");
  assert.equal(result.stdout.includes("secret"), false);
});
