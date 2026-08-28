import { dirname } from "@std/path";

const repository = new URL("../", import.meta.url);
const xdotoolArchive =
  "https://archive.archlinux.org/packages/x/xdotool/xdotool-3.20211022.1-1-x86_64.pkg.tar.zst";
const xdotoolArchiveSha256 =
  "195ab3d7bb613dbef6c8a3eef09dbac1f724bacdd2ee4a547d92591a074a6223";
const libxdoSha256 =
  "0ce1a57ce7056d3d9d4cfe4dd890679453977488e0b64a1d3f6ec6a945b6a081";

const environment: Record<string, string> = {};
if (Deno.build.os === "linux" && !(await systemProvidesLibxdo3())) {
  const compatibilityLibrary = await provideArchLibxdo3();
  let libraryPath = dirname(compatibilityLibrary);
  const inheritedLibraryPath = Deno.env.get("LD_LIBRARY_PATH");
  if (inheritedLibraryPath !== undefined && inheritedLibraryPath.length > 0) {
    libraryPath = `${libraryPath}:${inheritedLibraryPath}`;
  }
  environment.LD_LIBRARY_PATH = libraryPath;
}

const desktop = new Deno.Command(Deno.execPath(), {
  args: [
    "desktop",
    "--hmr",
    "--allow-read",
    "--include",
    "generated/compiler",
    "--include",
    "generated/wasm",
    "--include",
    "case-studies/engine/worker.js",
    "case-studies/engine/desktop.ts",
  ],
  cwd: repository,
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const desktopStatus = await desktop.status;
Deno.exit(desktopStatus.code);

async function systemProvidesLibxdo3(): Promise<boolean> {
  const linkerCache = await new Deno.Command("ldconfig", {
    args: ["-p"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!linkerCache.success) {
    const error = new TextDecoder().decode(linkerCache.stderr).trim();
    throw new Error(
      `ldconfig -p failed with code ${linkerCache.code}: ${error}`,
    );
  }
  return new TextDecoder().decode(linkerCache.stdout).includes("libxdo.so.3");
}

async function provideArchLibxdo3(): Promise<string> {
  if (Deno.build.arch !== "x86_64" || !(await isArchLinux())) {
    throw new Error(
      `Deno Desktop requires libxdo.so.3 on ${Deno.build.os}/${Deno.build.arch}; install a compatibility package for this distribution`,
    );
  }

  let cacheRoot = Deno.env.get("XDG_CACHE_HOME");
  if (cacheRoot === undefined || cacheRoot.length === 0) {
    const home = Deno.env.get("HOME");
    if (home === undefined || home.length === 0) {
      throw new Error(
        "libxdo.so.3 provisioning requires XDG_CACHE_HOME or HOME",
      );
    }
    cacheRoot = `${home}/.cache`;
  }

  const compatibilityDirectory = `${cacheRoot}/blot/desktop/libxdo3`;
  const compatibilityLibrary = `${compatibilityDirectory}/libxdo.so.3`;
  try {
    const installed = await Deno.readFile(compatibilityLibrary);
    if (await sha256(installed) === libxdoSha256) {
      return compatibilityLibrary;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const response = await fetch(xdotoolArchive);
  if (!response.ok) {
    throw new Error(
      `downloading ${xdotoolArchive} failed with HTTP ${response.status}`,
    );
  }
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const archiveDigest = await sha256(archiveBytes);
  if (archiveDigest !== xdotoolArchiveSha256) {
    throw new Error(
      `downloaded xdotool archive has SHA-256 ${archiveDigest}; expected ${xdotoolArchiveSha256}`,
    );
  }

  await Deno.mkdir(compatibilityDirectory, { recursive: true });
  const temporaryArchive = await Deno.makeTempFile({
    prefix: "blot-xdotool-",
    suffix: ".pkg.tar.zst",
  });
  let temporaryLibrary: string | undefined;
  try {
    await Deno.writeFile(temporaryArchive, archiveBytes);
    const extraction = await new Deno.Command("bsdtar", {
      args: [
        "-xOf",
        temporaryArchive,
        "usr/lib/libxdo.so.3",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!extraction.success) {
      const error = new TextDecoder().decode(extraction.stderr).trim();
      throw new Error(
        `bsdtar extraction failed with code ${extraction.code}: ${error}`,
      );
    }
    const libraryDigest = await sha256(extraction.stdout);
    if (libraryDigest !== libxdoSha256) {
      throw new Error(
        `extracted libxdo.so.3 has SHA-256 ${libraryDigest}; expected ${libxdoSha256}`,
      );
    }

    temporaryLibrary = await Deno.makeTempFile({
      dir: compatibilityDirectory,
      prefix: "libxdo-",
      suffix: ".so.3",
    });
    await Deno.writeFile(temporaryLibrary, extraction.stdout);
    await Deno.rename(temporaryLibrary, compatibilityLibrary);
    temporaryLibrary = undefined;
  } finally {
    await Deno.remove(temporaryArchive);
    if (temporaryLibrary !== undefined) await Deno.remove(temporaryLibrary);
  }
  console.log(
    `installed private compatibility library at ${compatibilityLibrary}`,
  );
  return compatibilityLibrary;
}

async function isArchLinux(): Promise<boolean> {
  const release = await Deno.readTextFile("/etc/os-release");
  return release.split("\n").some((line) => {
    if (!line.startsWith("ID=") && !line.startsWith("ID_LIKE=")) return false;
    const identifiers = line.slice(line.indexOf("=") + 1).replaceAll('"', "")
      .split(" ");
    return identifiers.includes("arch");
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
