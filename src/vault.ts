import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".canvas", ".base"]);

export class VaultError extends Error {}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface NoteInfo {
  path: string;
  size: number;
  modified: string;
}

export class Vault {
  constructor(private readonly config: Config) {}

  /**
   * Resolve a vault-relative path and refuse anything that escapes the vault
   * root (`..`, absolute paths, symlink targets outside the vault).
   */
  private async resolveSafe(relPath: string, mustExist: boolean): Promise<string> {
    if (path.isAbsolute(relPath)) {
      throw new VaultError("Paths must be relative to the vault root");
    }
    const abs = path.resolve(this.config.vaultPath, relPath);
    const rootWithSep = this.config.vaultPath + path.sep;
    if (abs !== this.config.vaultPath && !abs.startsWith(rootWithSep)) {
      throw new VaultError(`Path escapes the vault: ${relPath}`);
    }
    for (const part of path.relative(this.config.vaultPath, abs).split(path.sep)) {
      if (this.config.excludeDirs.includes(part)) {
        throw new VaultError(`Path is in an excluded directory: ${relPath}`);
      }
    }
    // Resolve symlinks on the closest existing ancestor so a symlinked
    // directory inside the vault can't point outside it.
    let probe = abs;
    while (true) {
      try {
        const real = await fs.realpath(probe);
        const realRoot = await fs.realpath(this.config.vaultPath);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new VaultError(`Path escapes the vault via symlink: ${relPath}`);
        }
        break;
      } catch (err) {
        if (err instanceof VaultError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (mustExist) {
      try {
        await fs.access(abs);
      } catch {
        throw new VaultError(`Not found: ${relPath}`);
      }
    }
    return abs;
  }

  private isNote(filePath: string): boolean {
    return NOTE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || this.config.excludeDirs.includes(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else if (entry.isFile() && this.isNote(full)) {
        yield full;
      }
    }
  }

  async listNotes(folder?: string): Promise<NoteInfo[]> {
    const root = folder ? await this.resolveSafe(folder, true) : this.config.vaultPath;
    const notes: NoteInfo[] = [];
    for await (const file of this.walk(root)) {
      const stat = await fs.stat(file);
      notes.push({
        path: path.relative(this.config.vaultPath, file),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    notes.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return notes;
  }

  async listFolders(): Promise<string[]> {
    const folders: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || this.config.excludeDirs.includes(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        folders.push(path.relative(this.config.vaultPath, full));
        await visit(full);
      }
    };
    await visit(this.config.vaultPath);
    return folders.sort();
  }

  async readNote(relPath: string): Promise<string> {
    const abs = await this.resolveSafe(relPath, true);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new VaultError(`Not a file: ${relPath}`);
    }
    if (stat.size > this.config.maxReadBytes) {
      throw new VaultError(
        `File too large (${stat.size} bytes, limit ${this.config.maxReadBytes}): ${relPath}`
      );
    }
    return fs.readFile(abs, "utf-8");
  }

  async searchNotes(query: string, folder?: string): Promise<SearchMatch[]> {
    const root = folder ? await this.resolveSafe(folder, true) : this.config.vaultPath;
    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];
    for await (const file of this.walk(root)) {
      const rel = path.relative(this.config.vaultPath, file);
      if (rel.toLowerCase().includes(needle)) {
        matches.push({ path: rel, line: 0, text: "(filename match)" });
        if (matches.length >= this.config.maxSearchResults) return matches;
      }
      const stat = await fs.stat(file);
      if (stat.size > this.config.maxReadBytes) continue;
      const content = await fs.readFile(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
          if (matches.length >= this.config.maxSearchResults) return matches;
        }
      }
    }
    return matches;
  }

  private assertWritable(): void {
    if (this.config.readOnly) {
      throw new VaultError("Server is running in read-only mode (READ_ONLY=true)");
    }
  }

  private assertMarkdown(relPath: string): void {
    const ext = path.extname(relPath).toLowerCase();
    if (ext !== ".md" && ext !== ".markdown") {
      throw new VaultError(`Writes are limited to .md files, got: ${relPath}`);
    }
  }

  async writeNote(relPath: string, content: string, overwrite: boolean): Promise<string> {
    this.assertWritable();
    this.assertMarkdown(relPath);
    const abs = await this.resolveSafe(relPath, false);
    if (!overwrite) {
      try {
        await fs.access(abs);
        throw new VaultError(`Note already exists (pass overwrite=true to replace): ${relPath}`);
      } catch (err) {
        if (err instanceof VaultError) throw err;
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return path.relative(this.config.vaultPath, abs);
  }

  async appendNote(relPath: string, content: string): Promise<string> {
    this.assertWritable();
    this.assertMarkdown(relPath);
    const abs = await this.resolveSafe(relPath, false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(abs, "utf-8");
    } catch {
      // new file
    }
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(abs, separator + content, "utf-8");
    return path.relative(this.config.vaultPath, abs);
  }

  async deleteNote(relPath: string): Promise<void> {
    this.assertWritable();
    if (!this.config.allowDelete) {
      throw new VaultError("Deletion is disabled (set ALLOW_DELETE=true to enable)");
    }
    const abs = await this.resolveSafe(relPath, true);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new VaultError(`Not a file: ${relPath}`);
    }
    await fs.unlink(abs);
  }

  dailyNotePath(dateISO?: string): string {
    const date = dateISO ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new VaultError(`Date must be YYYY-MM-DD, got: ${date}`);
    }
    const folder = this.config.dailyNotesFolder;
    return folder ? path.join(folder, `${date}.md`) : `${date}.md`;
  }
}
