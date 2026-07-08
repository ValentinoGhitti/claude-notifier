import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import notifier from "node-notifier";
import playSoundLib from "play-sound";

// ── Tipos ────────────────────────────────────────────────────────────────────

type EventName = "waiting_input" | "waiting_permission" | "task_done";

interface EventConfig {
  description: string;
  sound: string | null;
  popup: boolean;
  popup_title: string;
  popup_message: string;
}

interface SoundsConfig {
  _info: string;
  events: Record<EventName, EventConfig>;
  options: {
    delay_ms: number;
    debounce_ms: number;
  };
}

// ── Debounce por archivo de lock ─────────────────────────────────────────────
// Usamos un archivo temporal en lugar de estado en memoria porque cada
// invocación del hook es un proceso nuevo (no hay estado compartido).

const LOCK_DIR = path.join(process.env["TEMP"] ?? process.env["TMPDIR"] ?? "/tmp", "claude-notifier");
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
// En Windows usamos un script de PowerShell propio (scripts/play-audio.ps1)
// basado en System.Windows.Media.MediaPlayer, que a diferencia de
// System.Media.SoundPlayer soporta mp3 además de wav. En Linux/macOS delegamos
// en play-sound, que detecta el reproductor de línea de comandos disponible
// en el sistema (mpg123, aplay, paplay, afplay, etc).

const PLAY_AUDIO_SCRIPT = path.join(__dirname, "..", "scripts", "play-audio.ps1");
const player = playSoundLib();

function playSoundWindows(soundPath: string): void {
  // detached + unref: el proceso de PowerShell sigue vivo aunque este script
  // de Node termine antes de que termine de sonar el audio.
  const child = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", PLAY_AUDIO_SCRIPT, soundPath],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

function playSoundUnix(soundPath: string): void {
  player.play(soundPath, (err) => {
    if (err) {
      process.stderr.write(
        `[claude-notifier] No se pudo reproducir el sonido (¿falta instalar mpg123/aplay/afplay?): ${err}\n`,
      );
    }
  });
}

function playSound(soundPath: string): void {
  if (!fs.existsSync(soundPath)) {
    process.stderr.write(`[claude-notifier] Sonido no encontrado: ${soundPath}\n`);
    return;
  }

  if (process.platform === "win32") {
    playSoundWindows(soundPath);
  } else {
    playSoundUnix(soundPath);
  }
}

// ── Notificación popup ───────────────────────────────────────────────────────
// node-notifier abstrae la API nativa de cada SO: toasts de Windows,
// notify-send en Linux, y Notification Center en macOS.

function showPopup(title: string, message: string): void {
  notifier.notify({ title, message, sound: false }, (err) => {
    if (err) {
      process.stderr.write(`[claude-notifier] No se pudo mostrar el popup: ${err}\n`);
    }
  });
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
    // Damos 300 ms para que el proceso detached de Windows arranque y para
    // que node-notifier/play-sound lancen sus propios procesos hijos antes
    // de salir (no hace falta esperar a que terminen de sonar/mostrarse).
    setTimeout(() => process.exit(0), 300);
  }
}

main();
