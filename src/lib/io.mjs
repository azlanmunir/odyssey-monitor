import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function appendJsonLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function loadEnv(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equal = line.indexOf("=");
    if (equal < 1) continue;
    const key = line.slice(0, equal).trim();
    let value = line.slice(equal + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function withFileLock(file, operation) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(file);
    const originalOwner = (await fs.readFile(file, "utf8")).trim();
    const ownerPid = Number(originalOwner);
    let ownerAlive = false;
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (ownerError) {
        ownerAlive = ownerError.code === "EPERM";
      }
    }
    if (ownerAlive) {
      return { lockSkipped: true, reason: "another monitor process is active" };
    }
    const confirmedOwner = (await fs.readFile(file, "utf8")).trim();
    if (confirmedOwner !== originalOwner) {
      return { lockSkipped: true, reason: "another monitor process acquired the lock" };
    }
    await fs.unlink(file);
    handle = await fs.open(file, "wx", 0o600);
  }

  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close();
    try {
      const owner = (await fs.readFile(file, "utf8")).trim();
      if (owner === String(process.pid)) await fs.unlink(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function readFileLockStatus(file) {
  try {
    const stat = await fs.stat(file);
    const owner = (await fs.readFile(file, "utf8")).trim();
    const ownerPid = Number(owner);
    let ownerAlive = false;
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (error) {
        ownerAlive = error.code === "EPERM";
      }
    }
    return {
      exists: true,
      ownerPid: Number.isInteger(ownerPid) ? ownerPid : null,
      ownerAlive,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, ownerPid: null, ownerAlive: false, ageMs: 0 };
    }
    throw error;
  }
}
