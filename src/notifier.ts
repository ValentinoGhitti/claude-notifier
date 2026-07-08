import * as fs from "fs";
import * as path from "path";
import { exec, spawn } from "child_process";

// ── Tipos ────────────────────────────────────────────────────────────────────

type EventName = "waiting_input" | "waiting_permission" | "task_done";

interface EventConfig {
  description: string;
  sound: string | null;
  volume: number;
  popup: boolean;
  popup_title: string;
  popup_message: string;
}

interface SoundsConfig {
  _info: string;
  events: Record<EventName, EventConfig>;
  options: {
    suppress_if_focused: boolean;
    delay_ms: number;
    debounce_ms: number;
  };
}

// ── Debounce por archivo de lock ─────────────────────────────────────────────
// Usamos un archivo temporal en lugar de estado en memoria porque cada
// invocación del hook es un proceso nuevo (no hay estado compartido).

const LOCK_DIR = path.join(process.env["TEMP"] ?? "C:\\Windows\\Temp", "claude-notifier");
const KNOWN_EVENTS: EventName[] = ["waiting_input", "waiting_permission", "task_done"];

function isKnownEvent(value: string): value is EventName {
  return (KNOWN_EVENTS as string[]).includes(value);
}

function getLockPath(eventName: EventName): string {
  return path.join(LOCK_DIR, `${eventName}.lock`);
}

/**
 * Devuelve true si debemos suprimir la notificación por debounce.
 * Escribe/actualiza el archivo de lock con el timestamp actual.
 */
function shouldDebounce(eventName: EventName, debounceMs: number): boolean {
  if (debounceMs <= 0) return false;

  try {
    if (!fs.existsSync(LOCK_DIR)) {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
    }

    const lockPath = getLockPath(eventName);
    const now = Date.now();

    if (fs.existsSync(lockPath)) {
      const lastFired = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(lastFired) && now - lastFired < debounceMs) {
        return true; // demasiado pronto, suprimir
      }
    }

    fs.writeFileSync(lockPath, String(now), "utf-8");
    return false;
  } catch {
    // Si falla el debounce por cualquier razón, dejamos pasar la notificación
    return false;
  }
}

// ── Reproducción de sonido ───────────────────────────────────────────────────

function playSound(soundPath: string): void {
  if (!fs.existsSync(soundPath)) {
    process.stderr.write(`[claude-notifier] Sonido no encontrado: ${soundPath}\n`);
    return;
  }

  // Escapamos comillas simples en el path para PowerShell
  const safePath = soundPath.replace(/'/g, "''");
  const cmd =
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command ` +
    `"$p = New-Object System.Media.SoundPlayer '${safePath}'; $p.PlaySync()"`;

  exec(cmd, (error) => {
    if (error) {
      process.stderr.write(`[claude-notifier] Error al reproducir sonido: ${error.message}\n`);
    }
  });
}

// ── Notificación popup ───────────────────────────────────────────────────────

function showPopup(title: string, message: string): void {
  // Escapamos caracteres problemáticos para PowerShell
  const safeTitle = title.replace(/'/g, "''").replace(/"/g, '\\"');
  const safeMessage = message.replace(/'/g, "''").replace(/"/g, '\\"');

  // Usamos NotifyIcon (bandeja del sistema) porque es la API más confiable
  // para notificaciones balloon en Windows sin depender de WinRT/Toast.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$n = New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon = [System.Drawing.SystemIcons]::Information;",
    "$n.Visible = $true;",
    `$n.ShowBalloonTip(5000, '${safeTitle}', '${safeMessage}', [System.Windows.Forms.ToolTipIcon]::None);`,
    "Start-Sleep -Milliseconds 6000;",
    "$n.Dispose();",
  ].join(" ");

  // detached: true para que el popup no bloquee el proceso del hook
  const child = spawn("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-Command", script,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const eventArg = process.argv[2];

  if (!eventArg) {
    process.stderr.write("[claude-notifier] Uso: node notifier.js <evento>\n");
    process.exit(0);
  }

  if (!isKnownEvent(eventArg)) {
    process.stderr.write(`[claude-notifier] Evento desconocido: "${eventArg}". Eventos válidos: ${KNOWN_EVENTS.join(", ")}\n`);
    process.exit(0);
  }

  const eventName: EventName = eventArg;

  // sounds.json está junto al script (en src/ o en dist/ según el contexto)
  const configPath = path.join(__dirname, "..", "sounds.json");

  let config: SoundsConfig;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw) as SoundsConfig;
  } catch (err) {
    process.stderr.write(`[claude-notifier] No se pudo leer sounds.json: ${(err as Error).message}\n`);
    process.exit(0); // salir sin error para no romper el flujo de Claude
    return;
  }

  const eventConfig = config.events[eventName];
  if (!eventConfig) {
    process.stderr.write(`[claude-notifier] Sin configuración para el evento "${eventName}"\n`);
    process.exit(0);
    return;
  }

  const { debounce_ms, delay_ms } = config.options;

  if (shouldDebounce(eventName, debounce_ms)) {
    // Suprimir silenciosamente — es spam de herramientas seguidas
    process.exit(0);
    return;
  }

  const run = (): void => {
    if (eventConfig.sound) {
      playSound(eventConfig.sound);
    }

    if (eventConfig.popup) {
      showPopup(eventConfig.popup_title, eventConfig.popup_message);
    }
  };

  if (delay_ms > 0) {
    setTimeout(run, delay_ms);
    // Mantenemos el proceso vivo durante el delay
    setTimeout(() => process.exit(0), delay_ms + 500);
  } else {
    run();
    // Damos 200 ms para que exec() de playSound alcance a lanzarse
    setTimeout(() => process.exit(0), 200);
  }
}

main();
