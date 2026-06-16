"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_path = require("node:path");
const promises = require("node:fs/promises");
const node_fs = require("node:fs");
const node_os = require("node:os");
const node_child_process = require("node:child_process");
const node_net = require("node:net");
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = node_net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to allocate port"));
      }
    });
  });
}
function getLoginShellEnv() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/zsh";
    node_child_process.execFile(shell, ["-l", "-c", "echo $PATH"], { timeout: 3e3 }, (err, stdout) => {
      if (err) {
        resolve({ shell, path: null });
        return;
      }
      const p = stdout.trim();
      resolve({ shell, path: p.length > 0 ? p : null });
    });
  });
}
async function startBackend() {
  const port = await findFreePort();
  const host = "127.0.0.1";
  const env = { ...process.env };
  let userShell = process.env.SHELL ?? "/bin/zsh";
  if (process.platform === "darwin") {
    const { shell, path: loginPath } = await getLoginShellEnv();
    userShell = shell;
    if (loginPath) {
      const existing = (env.PATH ?? "").split(":").filter(Boolean);
      const merged = [.../* @__PURE__ */ new Set([...loginPath.split(":"), ...existing])];
      env.PATH = merged.join(":");
    } else {
      const common = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin"];
      const existing = (env.PATH ?? "").split(":").filter(Boolean);
      env.PATH = [.../* @__PURE__ */ new Set([...common, ...existing])].join(":");
    }
  }
  let proc;
  if (electron.app.isPackaged) {
    const binaryPath = node_path.join(process.resourcesPath, "bin", "agent_team_backend");
    proc = node_child_process.spawn(binaryPath, ["--port", String(port), "--log-level", "info"], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } else {
    if (!env.AGENT_TEAM_DATA_DIR) {
      env.AGENT_TEAM_DATA_DIR = node_path.join(electron.app.getPath("appData"), "Agent-Team-dev");
    }
    const projectRoot = electron.app.getAppPath();
    proc = node_child_process.spawn(
      "uv",
      ["--project", "backend", "run", "python", "-m", "agent_team_backend", "--port", String(port), "--log-level", "debug"],
      {
        cwd: projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  }
  proc.stdout?.on("data", (chunk) => {
    process.stdout.write(`[backend] ${chunk.toString()}`);
  });
  proc.stderr?.on("data", (chunk) => {
    process.stderr.write(`[backend] ${chunk.toString()}`);
  });
  const handle = {
    host,
    port,
    shell: userShell,
    proc,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, 2e3);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    })
  };
  try {
    await waitForHealth(host, port, 15e3);
  } catch (err) {
    try {
      proc.kill("SIGKILL");
    } catch {
    }
    throw err;
  }
  return handle;
}
async function waitForHealth(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/health`);
      if (res.ok) return;
      lastErr = new Error(`/health responded ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`);
}
process.title = "agent-team-electron";
if (process.platform === "darwin") {
  electron.app.dock.setIcon(electron.nativeImage.createFromPath(node_path.join(__dirname, "../../resources/icon.png")));
}
let backend = null;
let mainWindow = null;
const mainWindows = /* @__PURE__ */ new Set();
let rolesWindow = null;
let stagesWindow = null;
let editorWindow = null;
function loadWindow(win, params) {
  const qs = new URLSearchParams(params).toString();
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}${qs ? "?" + qs : ""}`);
  } else {
    void win.loadFile(node_path.join(__dirname, "../renderer/index.html"), { search: qs ? "?" + qs : "" });
  }
}
async function createWindow(params = {}) {
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    title: "Agent-Team",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindows.add(win);
  mainWindow = win;
  win.on("focus", () => {
    mainWindow = win;
  });
  win.on("closed", () => {
    mainWindows.delete(win);
    if (mainWindow === win) {
      const remaining = [...mainWindows];
      mainWindow = remaining.length ? remaining[remaining.length - 1] : null;
    }
  });
  loadWindow(win, { window: "main", ...params });
}
function openRolesWindow() {
  if (rolesWindow && !rolesWindow.isDestroyed()) {
    rolesWindow.focus();
    return;
  }
  const win = new electron.BrowserWindow({
    width: 900,
    height: 720,
    title: "Agent-Team · Role Manager",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  rolesWindow = win;
  win.on("closed", () => {
    if (rolesWindow === win) rolesWindow = null;
  });
  loadWindow(win, { window: "roles" });
}
function backendInfoPayload() {
  if (!backend) return { status: "starting" };
  return {
    status: "ready",
    host: backend.host,
    port: backend.port,
    pid: backend.proc.pid,
    shell: backend.shell,
    httpUrl: `http://${backend.host}:${backend.port}`,
    wsUrl: `ws://${backend.host}:${backend.port}/ws`
  };
}
function broadcastBackendChanged() {
  const payload = backendInfoPayload();
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("backend:changed", payload);
  }
}
electron.ipcMain.handle("backend:info", () => backendInfoPayload());
let backendBusy = false;
electron.ipcMain.handle("backend:restart", async () => {
  if (backendBusy) return backendInfoPayload();
  backendBusy = true;
  try {
    if (backend) {
      const b = backend;
      backend = null;
      await b.stop();
    }
    try {
      backend = await startBackend();
      console.log(`[main] backend restarted at ${backend.host}:${backend.port}`);
    } catch (err) {
      console.error("[main] backend restart failed", err);
      backend = null;
    }
    broadcastBackendChanged();
    return backendInfoPayload();
  } finally {
    backendBusy = false;
  }
});
electron.ipcMain.handle("backend:stop", async () => {
  if (backendBusy) return { ok: false };
  backendBusy = true;
  try {
    if (backend) {
      const b = backend;
      backend = null;
      await b.stop();
    }
    broadcastBackendChanged();
    return { ok: true };
  } finally {
    backendBusy = false;
  }
});
electron.ipcMain.handle("workspace:pick", async (_event, defaultPath) => {
  const opts = {
    title: "Pick workspace folder",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder"
  };
  if (defaultPath && typeof defaultPath === "string") opts.defaultPath = defaultPath;
  const result = mainWindow ? await electron.dialog.showOpenDialog(mainWindow, opts) : await electron.dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
function openStagesWindow() {
  if (stagesWindow && !stagesWindow.isDestroyed()) {
    stagesWindow.focus();
    return;
  }
  const win = new electron.BrowserWindow({
    width: 1e3,
    height: 700,
    title: "Agent-Team · Stage Manager",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  stagesWindow = win;
  win.on("closed", () => {
    if (stagesWindow === win) stagesWindow = null;
  });
  loadWindow(win, { window: "stages" });
}
function openDiffWindow(params) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send("editor:openDiff", params);
    editorWindow.webContents.send("editor:switchSidebar", "git");
    editorWindow.focus();
    return;
  }
  openEditorWindow({
    workspace_path: params.workspace_path,
    diff_filepath: params.filepath,
    diff_staged: params.staged,
    diff_name: params.name ?? params.filepath,
    sidebar: "git"
  });
}
electron.ipcMain.handle("window:openMain", (_event, args) => {
  const params = {};
  const ws = (args?.workspace_path ?? "").trim();
  if (ws) params.workspace_path = ws;
  void createWindow(params);
  return { ok: true };
});
electron.ipcMain.handle("window:openRoles", () => {
  openRolesWindow();
  return { ok: true };
});
electron.ipcMain.handle("window:openStages", () => {
  openStagesWindow();
  return { ok: true };
});
electron.ipcMain.handle("window:openDiff", (_event, args) => {
  openDiffWindow(args ?? {});
  return { ok: true };
});
function openBranchDiffWindow(params) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send("editor:openBranchDiff", params);
    editorWindow.focus();
    return;
  }
  openEditorWindow({
    workspace_path: params.workspace_path,
    branch_diff_base: params.branch_diff_base ?? "main",
    branch_diff_compare: params.branch_diff_compare ?? ""
  });
}
electron.ipcMain.handle("window:openBranchDiff", (_event, args) => {
  openBranchDiffWindow(args ?? {});
  return { ok: true };
});
const GIT_REF_RE = /^[A-Za-z0-9._/\-]+$/;
function validateRef(value, label) {
  if (!value) return null;
  if (value.startsWith("-")) return `invalid ${label}: must not start with '-'`;
  if (!GIT_REF_RE.test(value)) return `invalid ${label}: contains disallowed characters`;
  return null;
}
electron.ipcMain.handle("git:diff-head", async (_event, args) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const cwd = (args.workspace_path ?? "").trim();
  if (!cwd) return { ok: false, diff: "", error: "workspace_path required" };
  const compare = (args.compare ?? "").trim();
  const base = (args.base ?? "").trim();
  const refErr = validateRef(base, "base") ?? validateRef(compare, "compare");
  if (refErr) return { ok: false, diff: "", error: refErr };
  try {
    const gitArgs = ["-c", "core.quotePath=false", "diff"];
    if (compare && base) {
      gitArgs.push(`${base}...${compare}`);
    } else {
      gitArgs.push("HEAD");
    }
    const { stdout } = await execFileAsync("git", gitArgs, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, diff: stdout.slice(0, 1e5) };
  } catch (err) {
    const e = err;
    return { ok: false, diff: "", error: e.stderr?.trim() || e.message || "git error" };
  }
});
function openEditorWindow(params) {
  const search = { window: "editor", ...params };
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (!params.filepath && params.sidebar) {
      editorWindow.webContents.send("editor:switchSidebar", params.sidebar);
      editorWindow.focus();
      return;
    }
    loadWindow(editorWindow, search);
    editorWindow.focus();
    return;
  }
  const win = new electron.BrowserWindow({
    width: 1100,
    height: 760,
    title: "Agent-Team · Editor",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  editorWindow = win;
  win.on("closed", () => {
    if (editorWindow === win) editorWindow = null;
  });
  loadWindow(win, search);
}
electron.ipcMain.handle("window:openEditor", (_event, args) => {
  openEditorWindow(args ?? {});
  return { ok: true };
});
electron.ipcMain.handle(
  "window:notify",
  (_event, args) => {
    if (!electron.Notification.isSupported()) return { ok: false };
    const title = String(args?.title ?? "").trim();
    if (!title) return { ok: false };
    const notification = new electron.Notification({
      title,
      body: String(args?.body ?? ""),
      silent: false
    });
    const paneId = String(args?.paneId ?? "");
    notification.on("click", () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (paneId) win.webContents.send("notify:focusPane", paneId);
    });
    notification.show();
    return { ok: true };
  }
);
electron.ipcMain.handle(
  "dialog:saveJson",
  async (_event, args) => {
    const defaultName = args?.defaultName ?? "export.json";
    const ext = defaultName.includes(".") ? defaultName.slice(defaultName.lastIndexOf(".") + 1) : "json";
    const extFilters = {
      md: { name: "Markdown", extensions: ["md"] },
      json: { name: "JSON", extensions: ["json"] },
      txt: { name: "Text", extensions: ["txt"] }
    };
    const primaryFilter = extFilters[ext] ?? { name: ext.toUpperCase(), extensions: [ext] };
    const opts = {
      title: args?.title ?? "Export",
      defaultPath: defaultName,
      filters: [
        primaryFilter,
        { name: "All Files", extensions: ["*"] }
      ]
    };
    const win = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win ? await electron.dialog.showSaveDialog(win, opts) : await electron.dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(result.filePath, args.content, "utf-8");
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  }
);
electron.ipcMain.handle(
  "dialog:openJson",
  async (_event, args) => {
    const opts = {
      title: args?.title ?? "Import JSON",
      properties: ["openFile"],
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] }
      ]
    };
    const win = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    try {
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(result.filePaths[0], "utf-8");
      return { ok: true, path: result.filePaths[0], content };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  }
);
electron.ipcMain.handle(
  "dialog:pickFile",
  async (_event, args) => {
    const opts = {
      title: args?.title ?? "Select File",
      properties: ["openFile"],
      filters: args?.filters ?? [{ name: "All Files", extensions: ["*"] }]
    };
    if (args?.defaultPath) opts.defaultPath = args.defaultPath;
    const win = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  }
);
electron.ipcMain.handle(
  "dialog:pickFiles",
  async (_event, args) => {
    const opts = {
      title: args?.title ?? "Select Files",
      properties: ["openFile", "multiSelections"],
      filters: args?.filters ?? [{ name: "All Files", extensions: ["*"] }]
    };
    if (args?.defaultPath) opts.defaultPath = args.defaultPath;
    const win = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, paths: result.filePaths };
  }
);
electron.ipcMain.handle("shell:openTerminal", async (_event, command) => {
  if (!command || typeof command !== "string") return { ok: false, error: "invalid command" };
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Terminal" to do script "${escaped}"
tell application "Terminal" to activate`;
  return await new Promise((resolve) => {
    const proc = node_child_process.spawn("osascript", ["-e", script]);
    proc.on("error", (err) => resolve({ ok: false, error: String(err) }));
    proc.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `osascript exited ${code}` }));
  });
});
electron.ipcMain.handle("shell:openPath", async (_event, target) => {
  if (!target || typeof target !== "string") return { ok: false, error: "invalid path" };
  const err = await electron.shell.openPath(target);
  if (err) {
    try {
      electron.shell.showItemInFolder(target);
      return { ok: true, revealed: true };
    } catch {
      return { ok: false, error: err };
    }
  }
  return { ok: true };
});
electron.ipcMain.handle("shell:revealPath", async (_event, target) => {
  if (!target || typeof target !== "string") return { ok: false, error: "invalid path" };
  try {
    electron.shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
electron.ipcMain.handle("shell:openExternal", async (_event, url) => {
  if (!url || typeof url !== "string") return { ok: false, error: "invalid url" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "only http/https allowed" };
  try {
    await electron.shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
electron.ipcMain.handle("shell:openTempFile", async (_event, filename, content) => {
  if (!filename || typeof filename !== "string") return { ok: false, error: "invalid filename" };
  try {
    const dir = node_path.join(node_os.tmpdir(), "agent-team-head");
    await promises.mkdir(dir, { recursive: true });
    const safe = filename.replace(/[/\\]/g, "_");
    const file = node_path.join(dir, safe);
    await promises.writeFile(file, content ?? "", "utf8");
    const err = await electron.shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
electron.ipcMain.handle("keybindings:read", async () => {
  const filePath = node_path.join(electron.app.getPath("userData"), "keybindings.json");
  try {
    const content = await promises.readFile(filePath, "utf-8");
    return { ok: true, content };
  } catch {
    return { ok: true, content: "[]" };
  }
});
electron.ipcMain.handle("keybindings:write", async (_event, content) => {
  if (typeof content !== "string") return { ok: false, error: "invalid content" };
  const filePath = node_path.join(electron.app.getPath("userData"), "keybindings.json");
  try {
    await promises.writeFile(filePath, content, "utf-8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
electron.ipcMain.handle("fs:readFrom", async (_event, filePath, fromByte) => {
  if (!filePath || typeof filePath !== "string") return { ok: false, content: "" };
  try {
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(filePath);
    if (stat.size <= fromByte) return { ok: true, content: "", newOffset: fromByte };
    const fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(stat.size - fromByte);
    await fh.read(buf, 0, buf.length, fromByte);
    await fh.close();
    return { ok: true, content: buf.toString("utf-8"), newOffset: stat.size };
  } catch {
    return { ok: false, content: "", newOffset: fromByte };
  }
});
electron.ipcMain.on("settings:language-changed", (_event, locale) => {
  for (const win of [mainWindow, rolesWindow, stagesWindow, editorWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("settings:language-changed", locale);
    }
  }
});
electron.app.disableHardwareAcceleration();
electron.app.commandLine.appendSwitch("disable-gpu");
if (!electron.app.isPackaged) {
  electron.app.setPath("userData", `${electron.app.getPath("userData")}-dev`);
}
const pendingOpenPaths = [];
function openWorkspaceFromPath(p) {
  const target = (p ?? "").trim();
  if (!target) return false;
  let dir;
  try {
    dir = node_fs.statSync(target).isDirectory() ? target : node_path.dirname(target);
  } catch {
    return false;
  }
  if (electron.app.isReady()) {
    console.log("[main] open workspace from external path:", dir);
    void createWindow({ workspace_path: dir });
  } else {
    console.log("[main] queue workspace from external path (pre-ready):", dir);
    pendingOpenPaths.push(dir);
  }
  return true;
}
function workspacePathsFromArgv(argv) {
  return argv.slice(1).filter((a) => a && !a.startsWith("-") && node_fs.existsSync(a));
}
electron.app.on("open-file", (event, p) => {
  event.preventDefault();
  openWorkspaceFromPath(p);
});
const gotSingleInstanceLock = !electron.app.isPackaged || electron.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", (_event, argv) => {
    const paths = workspacePathsFromArgv(argv);
    if (paths.length) {
      for (const dir of paths) openWorkspaceFromPath(dir);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      void createWindow();
    }
  });
}
const DEV_ORIGIN = process.env["ELECTRON_RENDERER_URL"] ? new URL(process.env["ELECTRON_RENDERER_URL"]).origin : null;
function isAppNavigation(url) {
  try {
    const u = new URL(url);
    if (DEV_ORIGIN && u.origin === DEV_ORIGIN) return true;
    if (u.protocol === "file:") return u.pathname.endsWith("/renderer/index.html");
  } catch {
  }
  return false;
}
electron.app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (e, url) => {
    if (!isAppNavigation(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
});
electron.app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) {
    try {
      const devToken = node_fs.readFileSync(node_path.join(node_os.tmpdir(), "agent-team-dev-token"), "utf-8").trim();
      const origin = new URL(rendererUrl).origin;
      electron.session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${origin}/*`] },
        (details, callback) => {
          callback({ requestHeaders: { ...details.requestHeaders, "x-electron-token": devToken } });
        }
      );
    } catch {
    }
  }
  try {
    backend = await startBackend();
    console.log(`[main] backend ready at ${backend.host}:${backend.port}`);
  } catch (err) {
    console.error("[main] backend failed to start", err);
  }
  const queued = [...pendingOpenPaths];
  pendingOpenPaths.length = 0;
  const cli = electron.app.isPackaged ? workspacePathsFromArgv(process.argv) : [];
  const launchPaths = [.../* @__PURE__ */ new Set([...queued, ...cli])];
  let openedAny = false;
  for (const p of launchPaths) {
    if (openWorkspaceFromPath(p)) openedAny = true;
  }
  if (!openedAny) await createWindow();
  electron.app.on("activate", async () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", async (e) => {
  if (backend) {
    e.preventDefault();
    const b = backend;
    backend = null;
    const forced = new Promise((r) => setTimeout(r, 3e3));
    await Promise.race([b.stop(), forced]);
    electron.app.quit();
  }
});
