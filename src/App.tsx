import React, { useEffect, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { DropdownProvider } from './context/DropdownContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import LoginPage from './components/LoginPage.tsx';
import LiveWebPage, { PortalEntryMode } from './components/LiveWebPage.tsx';
import Layout, { NavSection } from './components/Layout.tsx';
import AdminDashboard, { DashboardDrilldownTarget } from './components/dashboards/AdminDashboard.tsx';
import ModeratorDashboard from './components/dashboards/ModeratorDashboard.tsx';
import EmployeeDashboard from './components/dashboards/EmployeeDashboard.tsx';
import TicketsView, { TicketQueuePreset } from './components/tickets/TicketsView.tsx';
import TicketFormModal from './components/tickets/TicketFormModal.tsx';
import TicketDetailDrawer from './components/tickets/TicketDetailDrawer.tsx';
import DirectChatView from './components/chat/DirectChatView.tsx';
import DropdownManagerView from './components/settings/DropdownManagerView.tsx';
import ModeratorsView from './components/moderators/ModeratorsView.tsx';
import UsersDirectoryView from './components/users/UsersDirectoryView.tsx';
import AssetsView from './components/assets/AssetsView.tsx';
import BudgetExpensesView from './components/budget/BudgetExpensesView.tsx';
import ReportsView from './components/reports/ReportsView.tsx';
import BroadcastNotificationsView from './components/broadcasts/BroadcastNotificationsView.tsx';
import WebsiteTrafficView from './components/analytics/WebsiteTrafficView.tsx';
import IntegrationsView from './components/integrations/IntegrationsView.tsx';
import AuditSessionsView from './components/audit/AuditSessionsView.tsx';

function WorkspaceApp() {
  const { user, loading, refreshNotifications, refreshUser } = useAuth();
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [chatPeerUserId, setChatPeerUserId] = useState<number | null>(null);
  const [chatTaskId, setChatTaskId] = useState<number | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [createdBanner, setCreatedBanner] = useState('');
  const [ticketPreset, setTicketPreset] = useState<{ key: number; queueFilter?: TicketQueuePreset } | null>(null);
  const [modStatusPreset, setModStatusPreset] = useState<{ key: number; status: 'All' | 'Active' | 'Inactive' } | null>(null);
  const [reportPreset, setReportPreset] = useState<{ key: number; reportType: string } | null>(null);

  const [showLivePage, setShowLivePage] = useState<boolean>(() => {
    const pathname = window.location.pathname.replace(/\/+$/, '');
    if (pathname === '/live') return true;
    const params = new URLSearchParams(window.location.search);
    const hasDirectLoginParam =
      params.has('panel') || params.has('invite') || params.has('mod_access');
    return !hasDirectLoginParam;
  });
  const [portalMode, setPortalMode] = useState<PortalEntryMode>('staff_email');

  useEffect(() => {
    setActiveSection('dashboard');
    setSelectedTicketId(null);
    setNewTicketOpen(false);
    setChatPeerUserId(null);
    setChatTaskId(null);
    if (user && window.location.pathname.replace(/\/+$/, '') !== '/live') {
      setShowLivePage(false);
    }
  }, [user?.id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Initializing SD Global IT Service Desk...
      </div>
    );
  }

  const handleOpenPortal = (mode: PortalEntryMode) => {
    setPortalMode(mode);
    setShowLivePage(false);
    if (window.location.pathname.replace(/\/+$/, '') === '/live') {
      window.history.replaceState({}, '', '/');
    }
  };

  const handleEnterWorkspace = () => {
    setShowLivePage(false);
    if (window.location.pathname.replace(/\/+$/, '') === '/live') {
      window.history.replaceState({}, '', '/');
    }
  };

  if (showLivePage && (!user || window.location.pathname.replace(/\/+$/, '') === '/live')) {
    return (
      <LiveWebPage
        isAuthenticated={Boolean(user)}
        onEnterWorkspace={handleEnterWorkspace}
        onOpenPortal={handleOpenPortal}
      />
    );
  }

  if (!user) {
    return (
      <LoginPage
        initialAuthTab={portalMode === 'employee_otp' ? 'employee_otp' : 'staff_email'}
        initialModeratorPortal={portalMode === 'moderator_common'}
        onBackToLive={() => setShowLivePage(true)}
      />
    );
  }

  const bumpRefresh = () => {
    setRefreshTrigger((n) => n + 1);
    refreshNotifications();
  };

  const handleOpenNewTicket = () => {
    if (user.role === 'moderator' || user.role === 'management') return;
    setNewTicketOpen(true);
  };

  const handleOpenDirectChat = (ticketId?: number, peerUserId?: number) => {
    if (user.role === 'management' && user.permissions?.can_view_chats === false) return;
    setChatTaskId(ticketId ?? null);
    setChatPeerUserId(peerUserId ?? null);
    setSelectedTicketId(null);
    setActiveSection('chat');
  };

  const handleTicketCreated = (ticketNumber: string) => {
    setCreatedBanner(`Ticket ${ticketNumber} submitted successfully and routed to IT Support.`);
    bumpRefresh();
    refreshUser();
  };

  const handleNavigateDrilldown = (target: DashboardDrilldownTarget) => {
    const key = Date.now();
    if (target.section === 'tickets') {
      setTicketPreset({ key, queueFilter: target.queueFilter });
      setActiveSection('tickets');
    } else if (target.section === 'moderators') {
      setModStatusPreset({ key, status: target.moderatorStatus });
      setActiveSection('moderators');
    } else if (target.section === 'reports') {
      setReportPreset({ key, reportType: target.reportType });
      setActiveSection('reports');
    } else if (target.section === 'employees') {
      setActiveSection('employees');
    } else if (target.section === 'broadcasts') {
      setActiveSection('broadcasts');
    } else if (target.section === 'traffic') {
      setActiveSection('traffic');
    }
  };

  const renderMainContent = () => {
    if (activeSection === 'dashboard') {
      if (user.role === 'employee') {
        return (
          <EmployeeDashboard
            onSelectTicket={setSelectedTicketId}
            onOpenNewTicket={handleOpenNewTicket}
            refreshTrigger={refreshTrigger}
          />
        );
      }
      if (user.role === 'moderator') {
        return (
          <ModeratorDashboard
            onSelectTicket={setSelectedTicketId}
            onOpenDirectChat={(tid) => handleOpenDirectChat(tid)}
            refreshTrigger={refreshTrigger}
          />
        );
      }
      return (
        <AdminDashboard
          onSelectTicket={setSelectedTicketId}
          onOpenDirectChat={user.role === 'super_admin' ? handleOpenDirectChat : undefined}
          onOpenIntegrations={user.role === 'super_admin' ? () => setActiveSection('integrations') : undefined}
          onNavigateDrilldown={handleNavigateDrilldown}
          refreshTrigger={refreshTrigger}
          readOnlyExecutive={user.role === 'management'}
        />
      );
    }

    const backToDash = () => setActiveSection('dashboard');

    switch (activeSection) {
      case 'tickets':
        return (
          <TicketsView
            onSelectTicket={setSelectedTicketId}
            onOpenNewTicket={handleOpenNewTicket}
            refreshTrigger={refreshTrigger}
            initialPreset={ticketPreset}
            onBackToDashboard={backToDash}
          />
        );
      case 'chat':
        return user.role !== 'management' || user.permissions?.can_view_chats !== false ? (
          <DirectChatView
            initialPeerUserId={chatPeerUserId}
            initialTaskId={chatTaskId}
            onOpenTask={(id) => setSelectedTicketId(id)}
          />
        ) : null;
      case 'moderators':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <ModeratorsView initialStatusFilter={modStatusPreset} onBackToDashboard={backToDash} />
        ) : null;
      case 'employees':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <UsersDirectoryView onSelectTicket={setSelectedTicketId} onBackToDashboard={backToDash} />
        ) : null;
      case 'assets':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <AssetsView onSelectTicket={setSelectedTicketId} />
        ) : null;
      case 'budgets':
        return user.role === 'super_admin' || (user.role === 'management' && user.permissions?.can_view_budgets !== false) ? (
          <BudgetExpensesView />
        ) : null;
      case 'reports':
        return user.role === 'super_admin' || (user.role === 'management' && user.permissions?.can_view_reports !== false) ? (
          <ReportsView initialReportType={reportPreset} onBackToDashboard={backToDash} />
        ) : null;
      case 'broadcasts':
        return user.role === 'super_admin' ? (
          <BroadcastNotificationsView onBackToDashboard={backToDash} />
        ) : null;
      case 'traffic':
        return user.role === 'super_admin' ? <WebsiteTrafficView onBackToDashboard={backToDash} /> : null;
      case 'dropdowns':
        return user.role === 'super_admin' ? <DropdownManagerView /> : null;
      case 'integrations':
        return user.role === 'super_admin' ? <IntegrationsView /> : null;
      case 'audit':
        return user.role === 'super_admin' ? <AuditSessionsView /> : null;
      default:
        return null;
    }
  };

  return (
    <Layout
      activeSection={activeSection}
      onSelectSection={(sec) => {
        if (sec !== 'chat') {
          setChatPeerUserId(null);
          setChatTaskId(null);
        }
        setTicketPreset(null);
        setModStatusPreset(null);
        setReportPreset(null);
        setActiveSection(sec);
      }}
      onOpenNewTicket={handleOpenNewTicket}
      onSelectNotificationTicket={(id) => setSelectedTicketId(id)}
    >
      {createdBanner && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 text-xs flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {createdBanner}
          </span>
          <button type="button" onClick={() => setCreatedBanner('')} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {renderMainContent()}

      {user.role !== 'moderator' && user.role !== 'management' && (
        <TicketFormModal
          open={newTicketOpen}
          onClose={() => setNewTicketOpen(false)}
          onCreated={handleTicketCreated}
        />
      )}

      <TicketDetailDrawer
        ticketId={selectedTicketId}
        onClose={() => setSelectedTicketId(null)}
        onUpdated={bumpRefresh}
        onOpenDirectChat={
          user.role !== 'management' || user.permissions?.can_view_chats !== false ? handleOpenDirectChat : undefined
        }
      />
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DropdownProvider>
          <WorkspaceApp />
        </DropdownProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
