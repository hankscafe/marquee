import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { MarqueeLogo } from './MarqueeLogo';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-neon-500/15 text-neon-300' : 'text-stone-400 hover:text-neon-300'
  }`;

export function Layout() {
  const { data } = useAuth();

  return (
    <div className="min-h-screen">
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
      <main className="mx-auto max-w-5xl px-4 py-6 pb-16">
        <Outlet />
      </main>
    </div>
  );
}
