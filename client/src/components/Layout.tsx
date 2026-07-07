import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
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

// Full-width rows with bigger touch targets for the mobile dropdown.
const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2.5 text-sm transition-colors ${
    isActive ? 'bg-neon-500/15 text-neon-300' : 'text-stone-300 hover:bg-neon-500/10 hover:text-neon-300'
  }`;

const NAV_LINKS: { to: string; label: string; end?: boolean; title?: string }[] = [
  { to: '/', label: 'Polls', end: true },
  { to: '/randomizer', label: 'Randomizer' },
  { to: '/watch-with', label: 'Watch With' },
  { to: '/collections', label: 'Collections' },
  { to: '/lists', label: 'Lists' },
  { to: '/poster', label: 'Poster', title: 'Cinema poster display' },
  { to: '/report', label: 'Report' },
];

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-6 w-6" aria-hidden="true">
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
    </svg>
  );
}

export function Layout() {
  const { data } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // One source of truth for both the desktop bar and the mobile dropdown.
  const links = [
    ...NAV_LINKS,
    ...(data?.user?.isAdmin ? [{ to: '/admin', label: 'Admin' }] : []),
    { to: '/account', label: data?.user?.username ?? 'Account', title: 'Account & sign out' },
  ];
  const { data: version } = useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionInfo>('/api/version'),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000, // long-lived tabs still learn about new releases
  });

  return (
    <div className="min-h-screen">
      {data?.idleTimeoutMinutes != null && <IdleLogout timeoutMinutes={data.idleTimeoutMinutes} />}
      <header className="sticky top-0 z-20 border-b border-neon-500/15 bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-x-4 px-4 py-3">
          <Link to="/" className="text-sm sm:text-base">
            <MarqueeLogo />
          </Link>
          {/* Desktop: full nav bar */}
          <nav className="ml-auto hidden flex-wrap items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} title={l.title} className={navLinkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          {/* Mobile: hamburger toggle */}
          <button
            className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg text-stone-300 hover:bg-neon-500/10 hover:text-neon-300 md:hidden"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            <MenuIcon open={menuOpen} />
          </button>
        </div>
        {/* Mobile: dropdown menu */}
        {menuOpen && (
          <nav className="border-t border-neon-500/15 md:hidden">
            <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-2">
              {links.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.end} title={l.title} className={mobileNavLinkClass}>
                  {l.label}
                </NavLink>
              ))}
            </div>
          </nav>
        )}
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
