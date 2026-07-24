/**
 * WhatsApp unpaired alerts.
 *
 * Discovery is event-driven: `disconnected` / `auth_failure` / post-ready `qr`
 * call {@link notifyWhatsAppUnpairedNow} immediately. The hourly loop only
 * re-alerts while still unpaired (at most once per 24h) — it does not probe
 * WhatsApp independently (getState shares Socket.state with those events).
 *
 * Cadence: `lastAlertSentAtMs` in whatsapp-runtime-state.json. `0` means
 * "never sent / reset after re-pair" (epoch), so the next unpair is due
 * immediately. Reset happens on WhatsApp `ready` (not only on the hourly tick).
 *
 * Mute per tenant server-side: set customer.whatsapp_unpaired_alert_recipients
 * to null/[] (Sabai skips the email; BYOS still POSTs).
 */
import { notifyWhatsAppUnpaired } from "./notify";
import type { WhatsAppService } from "./whatsapp";
import {
  loadWhatsAppRuntimeState,
  updateWhatsAppRuntimeState,
} from "./whatsappRuntimeState";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly reminder check
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // daily

export interface UnpairedAlertContext {
  status: string;
  lastError: string | null;
}

function isDue(lastAlertSentAtMs: number): boolean {
  return Date.now() - lastAlertSentAtMs >= ALERT_COOLDOWN_MS;
}

/**
 * Event-path entry: fire (or no-op under cooldown / no recipients).
 * Shares cadence with the daily reminder loop.
 */
export async function notifyWhatsAppUnpairedNow(ctx: UnpairedAlertContext): Promise<void> {
  try {
    const state = await loadWhatsAppRuntimeState();
    if (!isDue(state.lastAlertSentAtMs)) {
      console.log(
        `[byos:whatsapp-unpaired-alert] skip immediate notify (cooldown; status=${ctx.status})`,
      );
      return;
    }

    const sent = await notifyWhatsAppUnpaired({
      status: ctx.status,
      lastError: ctx.lastError,
    });
    if (sent) {
      const sentAtMs = Date.now();
      await updateWhatsAppRuntimeState({ lastAlertSentAtMs: sentAtMs });
      console.log(
        `[byos:whatsapp-unpaired-alert] notified Sabai (status=${ctx.status}) at ${new Date(sentAtMs).toISOString()}`,
      );
    }
  } catch (error) {
    console.warn("[byos:whatsapp-unpaired-alert] immediate notify failed:", error);
  }
}

export function startWhatsAppUnpairedAlertLoop(service: WhatsAppService): { stop: () => void } {
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // Cadence reset on re-pair is handled in whatsapp.ts `ready` (immediate).
      // This loop only reminds while still unpaired.
      if (!service.isUnpaired()) return;

      const state = await loadWhatsAppRuntimeState();
      if (!isDue(state.lastAlertSentAtMs)) return;

      const link = service.getLinkState();
      const sent = await notifyWhatsAppUnpaired({
        status: link.status,
        lastError: link.lastError,
      });
      if (sent) {
        const sentAtMs = Date.now();
        await updateWhatsAppRuntimeState({ lastAlertSentAtMs: sentAtMs });
        console.log(
          `[byos:whatsapp-unpaired-alert] daily reminder notified Sabai (status=${link.status}) at ${new Date(sentAtMs).toISOString()}`,
        );
      }
    } catch (error) {
      console.warn("[byos:whatsapp-unpaired-alert] tick failed:", error);
    } finally {
      inFlight = false;
    }
  };

  // Reminder only — discovery is via lifecycle events. Short delay after boot
  // covers unpaired-at-startup when no event re-fires after restore settles.
  const initialTimer = setTimeout(() => void tick(), 60_000);
  const intervalTimer = setInterval(() => void tick(), CHECK_INTERVAL_MS);

  console.log(
    "[byos:whatsapp-unpaired-alert] started (immediate on disconnect/auth_failure/qr; daily reminder while unpaired)",
  );

  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}
