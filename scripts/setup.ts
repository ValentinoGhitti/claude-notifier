import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Rutas ────────────────────────────────────────────────────────────────────
// El notifier compilado vive en dist/notifier.js dentro de este proyecto.
// Usamos una ruta absoluta porque los hooks corren como procesos hijos que
// heredan el entorno de quien lanzó Claude Code (VS Code o la terminal), y no
// podemos asumir que "node" resuelva un PATH relativo consistente.
const PROJECT_ROOT = path.resolve(__dirname, "..");
const NOTIFIER_PATH = path.join(PROJECT_ROOT, "dist", "notifier.js");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// node.exe del propio proceso que corre este script; es más confiable que
// depender de que "node" esté en el PATH de VS Code.
const NODE_BIN = process.execPath;

function buildHookCommand(eventName: string): string {
  // Comillas dobles porque el JSON de settings.json es interpretado por
  // Claude Code y luego pasado a una shell; evitamos problemas de espacios
  // en rutas de Windows citando ambos argumentos.
  return `"${NODE_BIN}" "${NOTIFIER_PATH}" ${eventName}`;
}

interface HookEntry {
  type: "command";
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksConfig = Record<string, HookMatcher[]>;

interface ClaudeSettings {
  hooks?: HooksConfig;
  [key: string]: unknown;
}

function loadSettings(): ClaudeSettings {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    console.error(`No se pudo leer ${CLAUDE_SETTINGS_PATH}: ${(err as Error).message}`);
    console.error("Revisá que el archivo tenga JSON válido antes de reintentar.");
    process.exit(1);
  }
}

/**
 * Agrega un hook de claude-notifier a una lista de matchers existente,
 * sin duplicar si ya está instalado y sin tocar otros hooks del usuario.
 */
function upsertHook(matchers: HookMatcher[], matcherPattern: string | undefined, command: string): HookMatcher[] {
  const alreadyInstalled = matchers.some((m) => m.hooks.some((h) => h.command === command));
  if (alreadyInstalled) {
    return matchers;
  }

  const targetIndex = matchers.findIndex((m) => m.matcher === matcherPattern);
  if (targetIndex >= 0) {
    matchers[targetIndex].hooks.push({ type: "command", command });
    return matchers;
  }

  const newMatcher: HookMatcher = matcherPattern !== undefined ? { matcher: matcherPattern, hooks: [{ type: "command", command }] } : { hooks: [{ type: "command", command }] };
  return [...matchers, newMatcher];
}

function installHooks(settings: ClaudeSettings): { settings: ClaudeSettings; installed: string[] } {
  const installed: string[] = [];
  const hooks: HooksConfig = settings.hooks ? { ...settings.hooks } : {};

  // Notification → waiting_input. Sólo dispara de forma confiable en
  // terminal (bug conocido: no dispara con matcher idle_prompt en el
  // plugin de VS Code), pero lo dejamos igual porque no molesta ahí.
  hooks["Notification"] = upsertHook(hooks["Notification"] ?? [], "idle_prompt", buildHookCommand("waiting_input"));
  installed.push("Notification (idle_prompt) → waiting_input");

  // PreToolUse con matcher de bash/shell → waiting_permission.
  hooks["PreToolUse"] = upsertHook(hooks["PreToolUse"] ?? [], "Bash", buildHookCommand("waiting_permission"));
  installed.push("PreToolUse (Bash) → waiting_permission");

  // Stop → task_done. Es la señal principal en ambos contextos (VS Code
  // y terminal) porque Notification/idle_prompt no es confiable en VS Code.
  hooks["Stop"] = upsertHook(hooks["Stop"] ?? [], undefined, buildHookCommand("task_done"));
  installed.push("Stop → task_done");

  return { settings: { ...settings, hooks }, installed };
}

function main(): void {
  if (!fs.existsSync(NOTIFIER_PATH)) {
    console.error(`No se encontró ${NOTIFIER_PATH}.`);
    console.error("Corré \"npm run build\" antes de \"npm run setup\".");
    process.exit(1);
  }

  const settingsDir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  const existing = loadSettings();
  const { settings, installed } = installHooks(existing);

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  console.log(`Hooks instalados en ${CLAUDE_SETTINGS_PATH}:\n`);
  for (const line of installed) {
    console.log(`  • ${line}`);
  }

  console.log("\nProbá manualmente con:");
  console.log("  npm run test:sound");
  console.log("  npm run test:waiting");
  console.log("  npm run test:permission");
  console.log("\nSi cambiás la ubicación de esta carpeta, volvé a correr \"npm run setup\".");
}

main();
