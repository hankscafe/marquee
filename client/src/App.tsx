import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { RequireAuth, SplashScreen } from './auth';
import { Layout } from './components/Layout';
import { Account } from './pages/Account';
import { Home } from './pages/Home';
import { Lists } from './pages/Lists';
import { NewPoll } from './pages/NewPoll';
import { PollPage } from './pages/PollPage';
import { PublicPoll } from './pages/PublicPoll';
import { Randomizer } from './pages/Randomizer';
import { ReportIssue } from './pages/ReportIssue';
import { WatchWith } from './pages/WatchWith';

// The biggest pages, and ones most visits never open, load on first use:
// Admin for admins only, Login once per sign-in, Poster Mode on wall displays.
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const Collections = lazy(() => import('./pages/Collections').then((m) => ({ default: m.Collections })));
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const PosterMode = lazy(() => import('./pages/PosterMode').then((m) => ({ default: m.PosterMode })));

export default function App() {
  return (
    // Pages inside the layout have their own fallback there, under the header.
    <Suspense fallback={<SplashScreen />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Public poll link: no login needed to vote */}
        <Route path="/vote/:publicToken" element={<PublicPoll />} />
        <Route
          path="/poster"
          element={
            <RequireAuth>
              <PosterMode />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route path="/polls/new" element={<NewPoll />} />
          <Route path="/p/:token" element={<PollPage />} />
          <Route path="/randomizer" element={<Randomizer />} />
          <Route path="/watch-with" element={<WatchWith />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/lists" element={<Lists />} />
          <Route path="/report" element={<ReportIssue />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
