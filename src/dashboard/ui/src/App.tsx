import { HashRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './app/ThemeProvider';
import { ToastProvider } from './components/ui/Toast';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import { AuthProvider, useAuth } from './app/AuthProvider';
import { RealtimeProvider } from './app/RealtimeProvider';
import { ServiceProvider } from './app/ServiceProvider';
import { AppShell } from './components/layout/AppShell';
import { BootErrorScreen } from './components/layout/BootErrorScreen';
import { BootScreen } from './components/ui/States';
import { AuthPage } from './pages/AuthPage';
import { OverviewPage } from './pages/OverviewPage';
import { DomainsPage } from './pages/DomainsPage';
import { SslPage } from './pages/SslPage';
import { NginxPage } from './pages/NginxPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProcessesPage } from './pages/ProcessesPage';
import { DeploymentsPage } from './pages/DeploymentsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

function Root() {
  const { phase } = useAuth();

  if (phase === 'loading') return <BootScreen />;
  if (phase === 'error') return <BootErrorScreen />;
  if (phase === 'unauthenticated') return <AuthPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="ssl" element={<SslPage />} />
        <Route path="nginx" element={<NginxPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="deployments" element={<DeploymentsPage />} />
        <Route path="processes" element={<ProcessesPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <RealtimeProvider>
              <ServiceProvider>
                <HashRouter>
                  <Root />
                </HashRouter>
              </ServiceProvider>
            </RealtimeProvider>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
