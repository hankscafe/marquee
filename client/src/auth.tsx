import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@marquee/shared';
import { api } from './api';
import { MarqueeLogo } from './components/MarqueeLogo';
import { clearReturnTo, peekReturnTo, rememberReturnTo } from './returnTo';

export function useAuth() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthStatus>('/api/auth/status'),
    staleTime: 60_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST', body: {} }),
    onSuccess: () => {
      // Leave first, so the page being left isn't remembered as a place to return to.
      navigate('/login', { replace: true });
      clearReturnTo();
      // On a shared device, none of the previous person's polls, lists or votes stay cached.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      return queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

// Full-screen logo while the app works out who's signed in or loads a page.
export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <span className="text-xl">
        <MarqueeLogo />
      </span>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const signedIn = !!data?.user;

  // Back from an SSO sign-in (which always returns to "/"): continue to the page
  // that sent them to /login.
  useEffect(() => {
    if (!signedIn) return;
    const target = peekReturnTo();
    clearReturnTo();
    if (target && target !== location.pathname + location.search) navigate(target, { replace: true });
  }, [signedIn]); // once per sign-in, not on every navigation

  if (isLoading) return <SplashScreen />;
  if (!signedIn) {
    const from = location.pathname + location.search;
    rememberReturnTo(from);
    return <Navigate to="/login" state={{ from }} replace />;
  }
  return <>{children}</>;
}
