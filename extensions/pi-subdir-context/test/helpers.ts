import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function tempProject(): Promise<{
  root: string;
  write(relative: string, content?: string): Promise<string>;
  directory(relative: string): Promise<string>;
  symlink(target: string, relative: string): Promise<string>;
  cleanup(): Promise<void>;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-subdir-context-")));
  return {
    root,
    async write(relative, content = "target") {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return target;
    },
    async directory(relative) {
      const target = path.join(root, relative);
      await mkdir(target, { recursive: true });
      return target;
    },
    async symlink(target, relative) {
      const link = path.join(root, relative);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(target, link);
      return link;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export const neverIgnored = async (): Promise<boolean> => false;
