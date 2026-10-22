import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  constants,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Real Linux package producers for F05 fixtures. Debian packages come from
 * dpkg-deb, RPM packages from rpmbuild, SquashFS images from mksquashfs, and
 * Type 2 AppImages from the pinned AppImage type2-runtime (fetched by
 * `npm run fixtures:linux`) followed by a mksquashfs image, which is what
 * appimagetool writes. Nothing is installed, no scriptlet runs and no
 * AppImage is executed; nothing binary is committed.
 */
export interface LinuxTools {
  readonly dpkgDeb: string;
  readonly rpmbuild: string;
  readonly rpm: string;
  readonly mksquashfs: string;
  readonly unsquashfs: string;
  /** Directory holding runtime-x86_64 and runtime-aarch64 from the pinned release. */
  readonly runtimes: string;
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const findTool = async (name: string): Promise<string | null> => {
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])
    if (await executable(join(directory, name))) return join(directory, name);
  return null;
};

const findRuntimes = async (): Promise<string | null> => {
  const candidates = [
    process.env.REA_TEST_APPIMAGE_RUNTIMES,
    join(repository, "_reference/linux-packages"),
    // A worktree under .worktrees/<name> shares the main checkout's reference files.
    join(repository, "../../_reference/linux-packages"),
  ];
  for (const candidate of candidates)
    if (
      candidate !== undefined &&
      candidate !== "" &&
      (await readable(join(candidate, "runtime-x86_64"))) &&
      (await readable(join(candidate, "runtime-aarch64")))
    )
      return candidate;
  return null;
};

const findTools = async (): Promise<LinuxTools | null> => {
  const [dpkgDeb, rpmbuild, rpm, mksquashfs, unsquashfs, runtimes] =
    await Promise.all([
      findTool("dpkg-deb"),
      findTool("rpmbuild"),
      findTool("rpm"),
      findTool("mksquashfs"),
      findTool("unsquashfs"),
      findRuntimes(),
    ]);
  if (
    dpkgDeb === null ||
    rpmbuild === null ||
    rpm === null ||
    mksquashfs === null ||
    unsquashfs === null ||
    runtimes === null
  )
    return null;
  return { dpkgDeb, rpmbuild, rpm, mksquashfs, unsquashfs, runtimes };
};

export const LINUX_TOOLS = await findTools();

const tools = (): LinuxTools => {
  if (LINUX_TOOLS === null)
    throw new Error(
      "Linux package fixtures need dpkg-deb, rpmbuild, rpm, mksquashfs, unsquashfs and the pinned AppImage runtimes (npm run fixtures:linux).",
    );
  return LINUX_TOOLS;
};

const exec = async (
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> => {
  const { stdout } = await run(command, [...args], {
    cwd,
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LC_ALL: "C",
    },
    maxBuffer: 256 * 1024 ** 2,
  });
  return stdout;
};

export const PACKAGE = "oops-demo";
export const VERSION = "1.2.3";
export const SCRIPT_TEXT = '#!/bin/sh\nset -e\necho "configured $1"\n';
export const CONFIG_TEXT = "level=1\n";

/** One package tree: a script, a config file, a symlink, a setuid helper and a real ELF. */
const writePayload = async (root: string, elf: Uint8Array): Promise<void> => {
  const files: [string, string | Uint8Array, number][] = [
    ["usr/bin/oops", '#!/bin/sh\nexec /usr/lib/oops/helper "$@"\n', 0o755],
    ["usr/lib/oops/helper", elf, 0o4755],
    ["etc/oops/oops.conf", CONFIG_TEXT, 0o644],
    ["usr/share/doc/oops/README", "Oops demo package.\n", 0o644],
    ["usr/share/doc/oops/names/ünïcode file.txt", "name test\n", 0o644],
  ];
  for (const [path, content, mode] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, mode);
  }
  await symlink(
    "../../../bin/oops",
    join(root, "usr/share/doc/oops/oops-link"),
  );
  // A hard link exercises how each format stores linked bytes once.
  await link(
    join(root, "usr/share/doc/oops/README"),
    join(root, "usr/share/doc/oops/README.hardlink"),
  );
};

const DEB_CONTROL = `Package: ${PACKAGE}
Version: ${VERSION}-1
Architecture: amd64
Maintainer: Oops Fixture <fixture@example.invalid>
Depends: libc6 (>= 2.31), bash | dash, libssl3:amd64 (>> 3.0.0~)
Pre-Depends: dpkg (>= 1.19)
Recommends: curl
Suggests: less
Conflicts: oops-old (<< 1.0)
Breaks: oops-plugin (<= 0.9)
Replaces: oops-old
Provides: oops (= ${VERSION})
Section: utils
Priority: optional
Installed-Size: 1024
Homepage: https://example.invalid/oops
Description: Oops demo package
 A fixture for the package reader.
 .
 It has scripts, a conffile, a symlink and a setuid helper.
`;

/** Build a Debian package with dpkg-deb; `compression` picks the member compressor. */
const buildDeb = async (
  root: string,
  elf: Uint8Array,
  compression: "xz" | "gzip" | "zstd" | "none",
): Promise<string> => {
  const tree = join(root, `deb-${compression}`);
  await writePayload(tree, elf);
  const control = join(tree, "DEBIAN");
  await mkdir(control, { recursive: true });
  await writeFile(join(control, "control"), DEB_CONTROL);
  await writeFile(join(control, "conffiles"), "/etc/oops/oops.conf\n");
  for (const [name, text] of [
    ["preinst", '#!/bin/sh\necho "preinst $1"\n'],
    ["postinst", SCRIPT_TEXT],
    ["prerm", "#!/bin/sh\necho prerm\n"],
    ["postrm", '#!/bin/bash\necho "postrm $1"\n'],
  ] as const) {
    await writeFile(join(control, name), text);
    await chmod(join(control, name), 0o755);
  }
  await writeFile(
    join(control, "triggers"),
    "interest-noawait /usr/share/oops\n",
  );
  // md5sums as dh_md5sums writes it: every regular file outside DEBIAN, sorted, two spaces.
  const lines: string[] = [];
  for (const entry of await readdir(tree, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(tree, path);
    if (name.startsWith("DEBIAN") || !(await lstat(path)).isFile()) continue;
    lines.push(
      `${createHash("md5")
        .update(await readFile(path))
        .digest("hex")}  ${name}`,
    );
  }
  await writeFile(
    join(control, "md5sums"),
    `${lines.sort((left, right) => (left.slice(34) < right.slice(34) ? -1 : 1)).join("\n")}\n`,
  );
  const output = join(root, `${PACKAGE}_${VERSION}-1_amd64.${compression}.deb`);
  await exec(tools().dpkgDeb, [
    "--root-owner-group",
    `-Z${compression}`,
    "--build",
    tree,
    output,
  ]);
  return output;
};

const RPM_SPEC = `Name:           ${PACKAGE}
Version:        ${VERSION}
Release:        1
Summary:        Oops demo package
License:        MIT
URL:            https://example.invalid/oops
AutoReqProv:    no
Requires:       bash >= 4.0
Requires:       (curl or wget)
Requires(post): coreutils
Provides:       oops = ${VERSION}
Conflicts:      oops-old < 1.0
Obsoletes:      oops-ancient
Recommends:     less
Suggests:       vim
Supplements:    oops-desktop
Enhances:       oops-shell

%description
A fixture for the package reader.

%install
cp -a %{payload}/. %{buildroot}/

%pre
echo "pre $1"

%post -p /bin/bash
echo "post $1"

%preun
echo preun

%postun -p <lua>
print("postun")

%posttrans
echo posttrans

%triggerin -- bash
echo trigger

%files
%attr(0755,root,root) /usr/bin/oops
%attr(4755,root,root) /usr/lib/oops/helper
%config(noreplace) /etc/oops/oops.conf
%doc /usr/share/doc/oops/README
/usr/share/doc/oops/README.hardlink
"/usr/share/doc/oops/names/ünïcode file.txt"
/usr/share/doc/oops/oops-link
%ghost /var/log/oops.log
`;

/** Build an RPM with rpmbuild; `payload` picks the payload compressor. */
const buildRpm = async (
  root: string,
  elf: Uint8Array,
  payload: "zstd" | "xz" | "gzip",
): Promise<string> => {
  const top = join(root, `rpm-${payload}`);
  const tree = join(top, "payload");
  await writePayload(tree, elf);
  for (const directory of ["SPECS", "BUILD", "RPMS", "SRPMS", "SOURCES"])
    await mkdir(join(top, directory), { recursive: true });
  await writeFile(join(top, "SPECS", "oops.spec"), RPM_SPEC);
  const io = { zstd: "w19.zstdio", xz: "w6.xzdio", gzip: "w9.gzdio" }[payload];
  await exec(tools().rpmbuild, [
    "-bb",
    "--target",
    "x86_64-linux",
    "--define",
    `_topdir ${top}`,
    "--define",
    `payload ${tree}`,
    "--define",
    `_binary_payload ${io}`,
    "--define",
    "_build_id_links none",
    join(top, "SPECS", "oops.spec"),
  ]);
  const built = join(
    top,
    "RPMS",
    "x86_64",
    `${PACKAGE}-${VERSION}-1.x86_64.rpm`,
  );
  const output = join(root, `${PACKAGE}-${VERSION}-1.x86_64.${payload}.rpm`);
  await writeFile(output, await readFile(built));
  return output;
};

const DESKTOP = `[Desktop Entry]
Type=Application
Name=Oops Demo
Exec=oops %F
Icon=oops
Categories=Utility;
Terminal=true
X-AppImage-Version=${VERSION}
`;

/** A SquashFS image of an AppDir with mksquashfs; `compression` as mksquashfs names it. */
const buildSquashfs = async (
  root: string,
  elf: Uint8Array,
  compression: "gzip" | "zstd" | "lz4" | "xz",
): Promise<string> => {
  const appDir = join(root, `AppDir-${compression}`);
  await writePayload(appDir, elf);
  await writeFile(join(appDir, "oops.desktop"), DESKTOP);
  await writeFile(
    join(appDir, "AppRun"),
    '#!/bin/sh\nexec "$APPDIR/usr/bin/oops" "$@"\n',
  );
  await chmod(join(appDir, "AppRun"), 0o755);
  await writeFile(
    join(appDir, "oops.png"),
    Buffer.from("89504e470d0a1a0a", "hex"),
  );
  await symlink("oops.png", join(appDir, ".DirIcon"));
  const image = join(root, `oops.${compression}.squashfs`);
  await exec(tools().mksquashfs, [
    appDir,
    image,
    "-comp",
    compression,
    "-root-owned",
    "-noappend",
    "-no-progress",
    "-quiet",
    "-mkfs-time",
    "1767225600",
    "-all-time",
    "1767225600",
  ]);
  return image;
};

export interface LinuxFixtures {
  /** dpkg-deb packages, one per member compressor. */
  readonly deb: {
    readonly xz: string;
    readonly gzip: string;
    readonly zstd: string;
    readonly none: string;
  };
  /** rpmbuild packages, one per payload compressor. */
  readonly rpm: {
    readonly zstd: string;
    readonly xz: string;
    readonly gzip: string;
  };
  /** Bare SquashFS images, one per compressor. */
  readonly squashfs: {
    readonly gzip: string;
    readonly zstd: string;
    readonly lz4: string;
    readonly xz: string;
  };
  /** Type 2 AppImages: the pinned runtime followed by a SquashFS image. */
  readonly appimage: { readonly x86_64: string; readonly aarch64: string };
  /** The ELF placed at usr/lib/oops/helper (the pinned x86_64 runtime's bytes). */
  readonly elf: string;
}

/** Build every Linux package fixture under `root`. */
export const buildLinuxFixtures = async (
  root: string,
): Promise<LinuxFixtures> => {
  const elfPath = join(tools().runtimes, "runtime-x86_64");
  const elf = await readFile(elfPath);
  const deb = {
    xz: await buildDeb(root, elf, "xz"),
    gzip: await buildDeb(root, elf, "gzip"),
    zstd: await buildDeb(root, elf, "zstd"),
    none: await buildDeb(root, elf, "none"),
  };
  const rpm = {
    zstd: await buildRpm(root, elf, "zstd"),
    xz: await buildRpm(root, elf, "xz"),
    gzip: await buildRpm(root, elf, "gzip"),
  };
  const squashfs = {
    gzip: await buildSquashfs(root, elf, "gzip"),
    zstd: await buildSquashfs(root, elf, "zstd"),
    lz4: await buildSquashfs(root, elf, "lz4"),
    xz: await buildSquashfs(root, elf, "xz"),
  };
  const appimage = { x86_64: "", aarch64: "" };
  for (const arch of ["x86_64", "aarch64"] as const) {
    const runtime = await readFile(join(tools().runtimes, `runtime-${arch}`));
    const output = join(root, `Oops_Demo-${arch}.AppImage`);
    await writeFile(
      output,
      Buffer.concat([runtime, await readFile(squashfs.zstd)]),
    );
    await chmod(output, 0o755);
    appimage[arch] = output;
  }
  return { deb, rpm, squashfs, appimage, elf: elfPath };
};

/** The oracles' own views: dpkg-deb, rpm and unsquashfs output for a fixture. */
export const linuxOracle = async (
  tool: "dpkg-deb" | "rpm" | "unsquashfs",
  args: readonly string[],
): Promise<string> =>
  exec(
    tool === "dpkg-deb"
      ? tools().dpkgDeb
      : tool === "rpm"
        ? tools().rpm
        : tools().unsquashfs,
    args,
  );
