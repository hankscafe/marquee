import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { VersionInfo } from '@marquee/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { IdleLogout } from './IdleLogout';
import { MarqueeLogo } from './MarqueeLogo';

const DISMISSED_UPDATE_KEY = 'marquee-dismissed-update';

// Shown to admins when the server found a newer GitHub release.
function UpdateBanner({ version }: { version: VersionInfo }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_UPDATE_KEY) === version.latest);
  if (!version.updateAvailable || !version.latest || dismissed) return null;

  return (
    <div className="border-b border-neon-500/20 bg-neon-500/10">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span className="text-neon-300">
          ✦ Marquee v{version.latest} is available — you're running v{version.current}
        </span>
        {version.releaseUrl && (
          <a href={version.releaseUrl} target="_blank" rel="noreferrer" className="text-neon-300 underline hover:text-neon-400">
            Release notes
          </a>
        )}
        <button
          className="ml-auto text-stone-400 hover:text-stone-200"
          onClick={() => {
            // Remember per-version, so the banner returns for the next release.
            localStorage.setItem(DISMISSED_UPDATE_KEY, version.latest!);
            setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-neon-500/15 text-neon-300' : 'text-stone-400 hover:text-neon-300'
  }`;

export function Layout() {
  const { data } = useAuth();
  const { data: version } = useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionInfo>('/api/version'),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000, // long-lived tabs still learn about new releases
  });

  return (
    <div className="min-h-screen">
      {data?.idleTimeoutMinutes != null && <IdleLogout timeoutMinutes={data.idleTimeoutMinutes} />}
      <header className="sticky top-0 z-10 border-b border-neon-500/15 bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <Link to="/" className="text-sm sm:text-base">
            <MarqueeLogo />
          </Link>
          <nav className="ml-auto flex flex-wrap items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Polls
            </NavLink>
            <NavLink to="/randomizer" className={navLinkClass}>
              Randomizer
            </NavLink>
            <NavLink to="/watch-with" className={navLinkClass}>
              Watch With
            </NavLink>
            <NavLink to="/collections" className={navLinkClass}>
              Collections
            </NavLink>
            <NavLink to="/lists" className={navLinkClass}>
              Lists
            </NavLink>
            <NavLink to="/poster" className={navLinkClass} title="Cinema poster display">
              Poster
            </NavLink>
            <NavLink to="/report" className={navLinkClass}>
              Report
            </NavLink>
            {data?.user?.isAdmin && (
              <NavLink to="/admin" className={navLinkClass}>
                Admin
              </NavLink>
            )}
            <NavLink to="/account" className={navLinkClass} title="Account & sign out">
              {data?.user?.username ?? 'Account'}
            </NavLink>
          </nav>
        </div>
      </header>
      {version && <UpdateBanner key={version.latest ?? 'none'} version={version} />}
      <main className="mx-auto max-w-5xl px-4 py-6 pb-16">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-6 text-center text-xs text-stone-600">
        {version && (
          <p>
            Marquee v{version.current} ·{' '}
            <a href={version.repoUrl} target="_blank" rel="noreferrer" className="hover:text-neon-300">
              GitHub
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
