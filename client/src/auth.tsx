import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@marquee/shared';
import { api } from './api';

export function useAuth() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthStatus>('/api/auth/status'),
    staleTime: 60_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="marquee-title text-2xl">MARQUEE</span>
      </div>
    );
  }
  if (!data?.user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
