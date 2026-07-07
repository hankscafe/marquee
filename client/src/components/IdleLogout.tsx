import { useEffect, useRef } from 'react';
import { api } from '../api';

// User interactions that count as activity and reset the idle clock.
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;
const CHECK_INTERVAL_MS = 30_000;
// Shared across tabs so activity in one tab keeps the others alive.
const ACTIVITY_KEY = 'marquee-last-activity';
const STORAGE_THROTTLE_MS = 5_000;

/**
 * Signs the user out after `timeoutMinutes` of no interaction. This is the
 * proactive UX half of idle auto-logout — the server enforces the same window
 * on its own, so a closed tab still gets revoked. Mounted inside the authed
 * Layout only, so the always-on Poster display (which has no Layout) is exempt.
 */
export function IdleLogout({ timeoutMinutes }: { timeoutMinutes: number }) {
  const lastActivity = useRef(Date.now());
  const lastStorageWrite = useRef(0);
  const firedRef = useRef(false);

  useEffect(() => {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const bump = () => {
      const now = Date.now();
      lastActivity.current = now;
      // Broadcast to other tabs, throttled to avoid a write per mousemove.
      if (now - lastStorageWrite.current > STORAGE_THROTTLE_MS) {
        lastStorageWrite.current = now;
        try {
          localStorage.setItem(ACTIVITY_KEY, String(now));
        } catch {
          /* storage unavailable — fall back to this tab's own activity */
        }
      }
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const check = window.setInterval(async () => {
      let last = lastActivity.current;
      try {
        last = Math.max(last, Number(localStorage.getItem(ACTIVITY_KEY)) || 0);
      } catch {
        /* ignore */
      }
      if (firedRef.current || Date.now() - last < timeoutMs) return;
      firedRef.current = true;
      // Revoke the session, then hard-redirect so all client state resets and
      // the login page reliably shows the inactivity notice.
      try {
        await api('/api/auth/logout', { method: 'POST', body: {} });
      } catch {
        // Even if the logout call fails, the session is already idle-expired
        // server-side; send the user to the login page regardless.
      }
      window.location.assign('/login?reason=idle');
    }, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
      window.clearInterval(check);
    };
  }, [timeoutMinutes]);

  return null;
}
