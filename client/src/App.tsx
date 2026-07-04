import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth';
import { Layout } from './components/Layout';
import { Admin } from './pages/Admin';
import { Collections } from './pages/Collections';
import { Home } from './pages/Home';
import { Lists } from './pages/Lists';
import { Login } from './pages/Login';
import { NewPoll } from './pages/NewPoll';
import { PollPage } from './pages/PollPage';
import { PosterMode } from './pages/PosterMode';
import { Randomizer } from './pages/Randomizer';
import { ReportIssue } from './pages/ReportIssue';
import { WatchWith } from './pages/WatchWith';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
        <Route path="/admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}
