import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";

// ─── Domain types ─────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  relPath: string;
  absPath: string;
  isDir: boolean;
  size: number;          // 0 for dirs
  ext: string;           // lower-case, includes dot e.g. ".ts"
  children: TreeNode[];
}

interface Config {
  excludePatterns: string[];
  maxFileSizeKb: number;
  maxTreeDepth: number;
  includeFileStats: boolean;
  outputFormat: "markdown" | "xml" | "plain";
  includeGitInfo: boolean;
  respectGitignore: boolean;
  showTokenEstimate: boolean;
}

type CopyMode =
  | "file+structure"
  | "structure-only"
  | "file-only"
  | "open-editors";

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const register = (id: string, mode: CopyMode) =>
    vscode.commands.registerCommand(id, (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      runCommand(mode, uri, uris)
    );

  context.subscriptions.push(
    register("llmContextCopy.copyFileWithStructure", "file+structure"),
    register("llmContextCopy.copyStructureOnly",     "structure-only"),
    register("llmContextCopy.copyFileOnly",          "file-only"),
    register("llmContextCopy.copyOpenEditors",       "open-editors")
  );
}

export function deactivate(): void { /* nothing to clean up */ }

// ─── Command orchestrator ─────────────────────────────────────────────────────

async function runCommand(
  mode: CopyMode,
  uri?: vscode.Uri,
  _uris?: vscode.Uri[]
): Promise<void> {
  // Resolve the target file path (from right-click or active editor)
  const targetPath = resolveTargetPath(uri);

  if ((mode === "file+structure" || mode === "file-only") && targetPath === undefined) {
    void vscode.window.showWarningMessage(
      "LLM Context Copy: Open or right-click a file first."
    );
    return;
  }

  const root = getWorkspaceRoot(targetPath);
  if (root === undefined) {
    void vscode.window.showWarningMessage(
      "LLM Context Copy: No workspace folder is open."
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLM Context Copy: building context…",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ increment: 10, message: "scanning project…" });
        const cfg = readConfig();

        progress.report({ increment: 30, message: "building file tree…" });
        const gitignore = cfg.respectGitignore ? parseGitignore(root) : [];
        const tree = buildTree(root, root, cfg, gitignore, 0);

        progress.report({ increment: 40, message: "reading file content…" });
        let filePaths: string[] = [];
        if (mode === "file+structure" && targetPath !== undefined) {
          filePaths = [targetPath];
        } else if (mode === "file-only" && targetPath !== undefined) {
          filePaths = [targetPath];
        } else if (mode === "open-editors") {
          filePaths = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.fsPath : ""))
            .filter(Boolean);
        }

        progress.report({ increment: 10, message: "formatting output…" });
        const output = buildOutput(
          root,
          tree,
          filePaths,
          mode,
          targetPath,
          cfg
        );

        await vscode.env.clipboard.writeText(output);
        progress.report({ increment: 10, message: "done!" });

        if (cfg.showTokenEstimate) {
          const tokens = estimateTokens(output);
          const kb = (output.length / 1024).toFixed(1);
          const lines = output.split("\n").length.toLocaleString();
          void vscode.window.showInformationMessage(
            `✅ Copied! ~${tokens.toLocaleString()} tokens · ${lines} lines · ${kb} KB`
          );
        } else {
          void vscode.window.showInformationMessage("✅ Copied to clipboard!");
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `LLM Context Copy error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );
}

// ─── Output assembler ─────────────────────────────────────────────────────────

function buildOutput(
  root: string,
  tree: TreeNode[],
  filePaths: string[],
  mode: CopyMode,
  focusPath: string | undefined,
  cfg: Config
): string {
  const parts: string[] = [];
  const fmt = cfg.outputFormat;

  parts.push(renderHeader(root, focusPath, filePaths, cfg, fmt));

  if (mode !== "file-only") {
    parts.push(renderTree(root, tree, focusPath, fmt));
  }

  for (const fp of filePaths) {
    parts.push(renderFile(fp, root, cfg, fmt));
  }

  parts.push(renderFooter(fmt));

  return parts.join("\n\n");
}

// ─── Header ───────────────────────────────────────────────────────────────────

function renderHeader(
  root: string,
  focusPath: string | undefined,
  extraPaths: string[],
  cfg: Config,
  fmt: string
): string {
  const project = path.basename(root);
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19).concat(" UTC");
  const branch = cfg.includeGitInfo ? gitBranch(root) : null;
  const focus = focusPath ? path.relative(root, focusPath) : null;
  const count = extraPaths.length;

  if (fmt === "xml") {
    return [
      "<llm-context>",
      "<meta>",
      `  <project>${esc(project)}</project>`,
      `  <generated>${ts}</generated>`,
      branch ? `  <git-branch>${esc(branch)}</git-branch>` : "",
      focus  ? `  <focus-file>${esc(focus)}</focus-file>` : "",
      count > 1 ? `  <file-count>${count}</file-count>` : "",
      "</meta>",
    ].filter(Boolean).join("\n");
  }

  if (fmt === "plain") {
    return [
      `PROJECT : ${project}`,
      `GENERATED: ${ts}`,
      branch ? `BRANCH  : ${branch}` : "",
      focus  ? `FOCUS   : ${focus}` : "",
      count > 1 ? `FILES   : ${count}` : "",
      "=".repeat(70),
    ].filter(Boolean).join("\n");
  }

  // Markdown
  const rows = [
    `| **Project** | \`${project}\` |`,
    `| **Generated** | ${ts} |`,
    branch ? `| **Branch** | \`${branch}\` |` : "",
    focus  ? `| **Focus file** | \`${focus}\` |` : "",
    count > 1 ? `| **Files included** | ${count} |` : "",
  ].filter(Boolean).join("\n");

  return `# 🤖 LLM Context — \`${project}\`\n\n| | |\n|---|---|\n${rows}\n\n---`;
}

// ─── Tree renderer ────────────────────────────────────────────────────────────

function renderTree(
  root: string,
  tree: TreeNode[],
  focusPath: string | undefined,
  fmt: string
): string {
  const project = path.basename(root);
  const lines: string[] = [`${project}/`];

  function walk(nodes: TreeNode[], prefix: string): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const last = i === nodes.length - 1;
      const branch = last ? "└── " : "├── ";
      const childPfx = prefix + (last ? "    " : "│   ");

      const isFocus = focusPath !== undefined && node.absPath === focusPath;
      const sizeLabel = !node.isDir && node.size > 0 ? ` (${fmtSize(node.size)})` : "";
      const focusLabel = isFocus ? "  ◄ FOCUS" : "";
      const icon = nodeIcon(node);

      lines.push(`${prefix}${branch}${icon}${node.name}${sizeLabel}${focusLabel}`);

      if (node.children.length > 0) {
        walk(node.children, childPfx);
      }
    }
  }

  walk(tree, "");

  const body = lines.join("\n");

  if (fmt === "xml") {
    return `<project-structure>\n<![CDATA[\n${body}\n]]>\n</project-structure>`;
  }
  if (fmt === "plain") {
    return `PROJECT STRUCTURE\n${"─".repeat(40)}\n${body}`;
  }
  return `## 📁 Project Structure\n\n\`\`\`\n${body}\n\`\`\``;
}

// ─── File content renderer ────────────────────────────────────────────────────

function renderFile(filePath: string, root: string, cfg: Config, fmt: string): string {
  const rel = path.relative(root, filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const lang = extLang(ext);

  let content: string;
  let lines = 0;
  let size = 0;

  try {
    const stat = fs.statSync(filePath);
    size = stat.size;

    if (isBinary(ext)) {
      content = "[Binary file — content omitted]";
    } else if (size > cfg.maxFileSizeKb * 1024) {
      content = `[File too large (${fmtSize(size)}) — increase llmContextCopy.maxFileSizeKb to include]`;
    } else {
      content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
      lines = content.split("\n").length;
    }
  } catch (e) {
    content = `[Cannot read file: ${e instanceof Error ? e.message : String(e)}]`;
  }

  const stats = cfg.includeFileStats && lines > 0
    ? ` · ${lines.toLocaleString()} lines · ${fmtSize(size)}`
    : "";

  if (fmt === "xml") {
    const attrs = cfg.includeFileStats && lines > 0
      ? ` lines="${lines}" size="${fmtSize(size)}" lang="${lang}"`
      : ` lang="${lang}"`;
    return `<file path="${esc(rel)}"${attrs}>\n<![CDATA[\n${content}\n]]>\n</file>`;
  }

  if (fmt === "plain") {
    const sep = "─".repeat(70);
    return [`FILE: ${rel}${stats}`, sep, content, sep].join("\n");
  }

  return [`## 📄 \`${rel}\`${stats}`, "", `\`\`\`${lang}`, content, "```"].join("\n");
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function renderFooter(fmt: string): string {
  const note = "Context built by LLM Context Copy (VS Code extension)";
  if (fmt === "xml")   { return `<note>${note}</note>\n</llm-context>`; }
  if (fmt === "plain") { return `${"=".repeat(70)}\n${note}`; }
  return `---\n\n> *${note}*`;
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

function buildTree(
  root: string,
  dir: string,
  cfg: Config,
  gitignore: string[],
  depth: number
): TreeNode[] {
  if (depth > cfg.maxTreeDepth) { return []; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);

    if (isExcluded(entry.name, rel, cfg.excludePatterns, gitignore)) { continue; }

    const isDir = entry.isDirectory();
    let size = 0;
    if (!isDir) {
      try { size = fs.statSync(abs).size; } catch { /* ignore */ }
    }

    const ext = isDir ? "" : path.extname(entry.name).toLowerCase();

    const node: TreeNode = {
      name: entry.name,
      relPath: rel,
      absPath: abs,
      isDir,
      size,
      ext,
      children: [],
    };

    if (isDir) {
      node.children = buildTree(root, abs, cfg, gitignore, depth + 1);
    }

    nodes.push(node);
  }

  // Directories first, then files — each group sorted alphabetically
  return nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
    return a.name.localeCompare(b.name);
  });
}

// ─── Helpers: config ──────────────────────────────────────────────────────────

function readConfig(): Config {
  const s = vscode.workspace.getConfiguration("llmContextCopy");
  return {
    excludePatterns: s.get<string[]>("excludePatterns") ?? [],
    maxFileSizeKb:   s.get<number>("maxFileSizeKb") ?? 150,
    maxTreeDepth:    s.get<number>("maxTreeDepth") ?? 10,
    includeFileStats: s.get<boolean>("includeFileStats") ?? true,
    outputFormat:    s.get<"markdown" | "xml" | "plain">("outputFormat") ?? "markdown",
    includeGitInfo:  s.get<boolean>("includeGitInfo") ?? true,
    respectGitignore: s.get<boolean>("respectGitignore") ?? true,
    showTokenEstimate: s.get<boolean>("showTokenEstimate") ?? true,
  };
}

// ─── Helpers: workspace ───────────────────────────────────────────────────────

function resolveTargetPath(uri?: vscode.Uri): string | undefined {
  if (uri?.fsPath) { return uri.fsPath; }
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function getWorkspaceRoot(filePath?: string): string | undefined {
  if (filePath !== undefined) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (folder) { return folder.uri.fsPath; }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ─── Helpers: git ─────────────────────────────────────────────────────────────

function gitBranch(cwd: string): string | null {
  try {
    return cp
      .execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        timeout: 2_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ─── Helpers: gitignore ───────────────────────────────────────────────────────

function parseGitignore(root: string): string[] {
  try {
    const src = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    return src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// ─── Helpers: exclusion ───────────────────────────────────────────────────────

function isExcluded(
  name: string,
  rel: string,
  patterns: string[],
  gitignore: string[]
): boolean {
  for (const p of [...patterns, ...gitignore]) {
    if (globMatch(name, p) || globMatch(rel, p)) { return true; }
    // strip trailing slash from dir patterns
    if (p.endsWith("/") && globMatch(name, p.slice(0, -1))) { return true; }
  }
  return false;
}

function globMatch(str: string, pattern: string): boolean {
  if (pattern === str) { return true; }
  // *.ext pattern
  if (pattern.startsWith("*.")) { return str.endsWith(pattern.slice(1)); }
  // simple wildcard
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return re.test(str);
  }
  return str === pattern || str.startsWith(pattern + "/");
}

// ─── Helpers: display ─────────────────────────────────────────────────────────

function nodeIcon(n: TreeNode): string {
  if (n.isDir) { return "📁 "; }
  const icons: Record<string, string> = {
    ".ts": "🔷", ".tsx": "🔷", ".js": "🟨", ".jsx": "🟨",
    ".py": "🐍", ".java": "☕", ".kt": "🎯", ".go": "🐹",
    ".rs": "🦀", ".cpp": "⚙️", ".c": "⚙️", ".cs": "🔵",
    ".rb": "💎", ".php": "🐘", ".swift": "🍎", ".dart": "🎯",
    ".vue": "💚", ".svelte": "🟠",
    ".json": "📋", ".yaml": "📋", ".yml": "📋", ".toml": "📋",
    ".md": "📝", ".mdx": "📝", ".txt": "📄",
    ".html": "🌐", ".css": "🎨", ".scss": "🎨", ".sass": "🎨",
    ".sql": "🗄️", ".prisma": "🗄️",
    ".sh": "💻", ".bash": "💻", ".zsh": "💻",
    ".env": "🔑", ".gitignore": "🔒",
    ".dockerfile": "🐳",
    ".png": "🖼️", ".jpg": "🖼️", ".jpeg": "🖼️",
    ".svg": "🖼️", ".gif": "🖼️",
    ".pdf": "📕", ".lock": "🔒",
    ".graphql": "🔗", ".proto": "🔗",
    ".tf": "☁️", ".bicep": "☁️",
  };
  return (icons[n.ext] ?? "📄") + " ";
}

function extLang(ext: string): string {
  const m: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", java: "java", kt: "kotlin", go: "go",
    rs: "rust", cpp: "cpp", c: "c", cs: "csharp",
    rb: "ruby", php: "php", swift: "swift", dart: "dart",
    vue: "vue", svelte: "svelte",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", mdx: "mdx", txt: "text",
    html: "html", css: "css", scss: "scss", sass: "sass",
    sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
    env: "bash", dockerfile: "dockerfile",
    graphql: "graphql", gql: "graphql", proto: "protobuf",
    tf: "hcl", bicep: "bicep",
    r: "r", lua: "lua", ex: "elixir", exs: "elixir",
    hs: "haskell", ml: "ocaml", scala: "scala",
    nim: "nim", zig: "zig", v: "v",
    gradle: "groovy", groovy: "groovy",
    xml: "xml", xaml: "xml", plist: "xml",
    clj: "clojure", erl: "erlang", elm: "elm",
    ps1: "powershell", bat: "batch",
  };
  return m[ext] ?? ext ?? "text";
}

function isBinary(ext: string): boolean {
  return new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "tar", "gz", "bz2", "xz", "rar", "7z",
    "exe", "dll", "so", "dylib", "a", "lib",
    "ttf", "woff", "woff2", "eot", "otf",
    "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac",
    "db", "sqlite", "sqlite3",
    "bin", "dat", "pkl", "npy", "npz", "pt", "pth",
    "class", "jar", "war", "ear",
    "node", "wasm",
    "vsix",
  ]).has(ext);
}

function fmtSize(bytes: number): string {
  if (bytes < 1_024)           { return `${bytes} B`; }
  if (bytes < 1_024 * 1_024)  { return `${(bytes / 1_024).toFixed(1)} KB`; }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function estimateTokens(text: string): number {
  // ~4 chars per token is a well-known approximation
  return Math.round(text.length / 4);
}

/** Escape XML special chars */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
